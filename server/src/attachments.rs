use crate::{App, BAD, Error, Result, lock};
use axum::{
    Extension, Json,
    body::{Body, Bytes},
    extract::{Path, State},
    http::{HeaderMap, StatusCode as S, header},
    response::{IntoResponse, Response},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::sync::Arc;
use std::{
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path as FsPath,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use uuid::Uuid;

pub const FILE_LIMIT: usize = 25 * 1024 * 1024;
pub const AVATAR_LIMIT: usize = 5 * 1024 * 1024;
const UNAVAILABLE: Error = Error(S::INTERNAL_SERVER_ERROR, "Attachment storage unavailable");
const MISSING: Error = Error(S::NOT_FOUND, "Attachment not found");

const BUSY: Error = Error(
    S::SERVICE_UNAVAILABLE,
    "Attachment transfers busy. Try again.",
);
const UPLOAD_SLOTS: usize = 2;
const DOWNLOAD_SLOTS: usize = 8;

pub struct TransferSlots {
    uploads: Arc<Semaphore>,
    downloads: Arc<Semaphore>,
}
impl Default for TransferSlots {
    fn default() -> Self {
        Self {
            uploads: Arc::new(Semaphore::new(UPLOAD_SLOTS)),
            downloads: Arc::new(Semaphore::new(DOWNLOAD_SLOTS)),
        }
    }
}
impl TransferSlots {
    pub fn upload(&self) -> Result<OwnedSemaphorePermit> {
        self.uploads.clone().try_acquire_owned().map_err(|_| BUSY)
    }
    fn download(&self) -> Result<OwnedSemaphorePermit> {
        self.downloads.clone().try_acquire_owned().map_err(|_| BUSY)
    }
}

// Keep the slot until the last Bytes slice leaves disk I/O or the HTTP response.
pub fn transfer_bytes(data: Bytes, permit: OwnedSemaphorePermit) -> Bytes {
    struct Transfer {
        data: Bytes,
        _permit: OwnedSemaphorePermit,
    }
    impl AsRef<[u8]> for Transfer {
        fn as_ref(&self) -> &[u8] {
            self.data.as_ref()
        }
    }
    Bytes::from_owner(Transfer {
        data,
        _permit: permit,
    })
}

#[derive(Serialize)]
pub struct Attachment {
    id: String,
    filename: String,
    mime: String,
    kind: String,
    size: u64,
}

pub fn init_dir(dir: &FsPath) -> std::io::Result<()> {
    match fs::create_dir(dir) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(e) => return Err(e),
    }
    if !fs::symlink_metadata(dir)?.is_dir() {
        return Err(std::io::Error::other(
            "Expected a private attachments directory",
        ));
    }
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
}

pub fn purpose(headers: &HeaderMap, adapter: bool) -> Result<&'static str> {
    let mut values = headers.get_all("x-rothcold-purpose").iter();
    let purpose = match (adapter, values.next().map(|v| v.as_bytes())) {
        (true, None) => "backend_avatar",
        (false, None | Some(b"turn")) => "turn",
        (false, Some(b"avatar")) => "avatar",
        _ => return Err(BAD),
    };
    if values.next().is_some() {
        return Err(BAD);
    }
    Ok(purpose)
}

fn filename(headers: &HeaderMap) -> Result<String> {
    let mut values = headers.get_all("x-rothcold-filename").iter();
    let mut raw = values.next().ok_or(BAD)?.as_bytes().iter().copied();
    if values.next().is_some() {
        return Err(BAD);
    }
    let mut decoded = Vec::new();
    while let Some(c) = raw.next() {
        let c = if c == b'%' {
            let mut nibble = || raw.next().and_then(|x| char::from(x).to_digit(16));
            ((nibble().ok_or(BAD)? << 4) | nibble().ok_or(BAD)?) as u8
        } else if c.is_ascii() {
            c
        } else {
            return Err(BAD);
        };
        decoded.push(c);
    }
    let decoded = String::from_utf8(decoded).map_err(|_| BAD)?;
    let name: String = decoded
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .take(255)
        .collect();
    let name = name.trim();
    if matches!(name, "" | "." | "..") {
        return Err(BAD);
    }
    Ok(name.into())
}

// Use signatures to decide if bytes can be served inline. Hints only resolve container variants.
fn classify(b: &[u8], declared: &str, name: &str) -> (&'static str, &'static str) {
    let mime = declared
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let ext = name
        .rsplit_once('.')
        .map_or(String::new(), |(_, ext)| ext.to_ascii_lowercase());
    if b.starts_with(b"\x89PNG\r\n\x1a\n") {
        ("image", "image/png")
    } else if b.starts_with(b"\xff\xd8\xff") {
        ("image", "image/jpeg")
    } else if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        ("image", "image/gif")
    } else if b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WEBP") {
        ("image", "image/webp")
    } else if b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WAVE") {
        ("audio", "audio/wav")
    } else if b.starts_with(b"fLaC") {
        ("audio", "audio/flac")
    } else if b.starts_with(b"OggS\0") && b.get(5).is_some_and(|v| v & 2 != 0) {
        let packet = b
            .get(26)
            .and_then(|n| b.get(27 + usize::from(*n)..))
            .unwrap_or_default();
        if packet.starts_with(b"\x80theora") {
            ("video", "video/ogg")
        } else if [
            b"OpusHead".as_slice(),
            b"\x01vorbis",
            b"Speex   ",
            b"\x7fFLAC",
        ]
        .iter()
        .any(|p| packet.starts_with(p))
        {
            ("audio", "audio/ogg")
        } else {
            ("file", "application/octet-stream")
        }
    } else if b.starts_with(b"\x1a\x45\xdf\xa3")
        && b[..b.len().min(256)]
            .windows(7)
            .any(|p| p == b"\x42\x82\x84webm")
    {
        if mime == "audio/webm" || ext == "weba" {
            ("audio", "audio/webm")
        } else {
            ("video", "video/webm")
        }
    } else if b.get(4..8) == Some(b"ftyp") && b.len() >= 16 && {
        let size = u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize;
        (16..=b.len()).contains(&size) && size.is_multiple_of(4)
    } {
        let brand = &b[8..12];
        if brand == b"qt  " {
            ("video", "video/quicktime")
        } else if brand == b"M4A "
            || (matches!(brand, b"isom" | b"iso2" | b"mp41" | b"mp42")
                && (mime == "audio/mp4" || ext == "m4a"))
        {
            ("audio", "audio/mp4")
        } else if matches!(
            brand,
            b"isom"
                | b"iso2"
                | b"iso4"
                | b"iso5"
                | b"iso6"
                | b"mp41"
                | b"mp42"
                | b"avc1"
                | b"M4V "
                | b"MSNV"
                | b"dash"
        ) {
            ("video", "video/mp4")
        } else {
            ("file", "application/octet-stream")
        }
    } else if b.len() >= 7 && b[0] == 0xff && b[1] & 0xf6 == 0xf0 && (b[2] >> 2) & 15 < 13 {
        ("audio", "audio/aac")
    } else if (b.starts_with(b"ID3")
        && b.len() >= 10
        && (2..=4).contains(&b[3])
        && b[6..10].iter().all(|v| v < &128))
        || (b.len() >= 4
            && b[0] == 0xff
            && b[1] & 0xe6 == 0xe2
            && b[1] & 0x18 != 8
            && !matches!(b[2] >> 4, 0 | 15)
            && b[2] & 12 != 12)
    {
        ("audio", "audio/mpeg")
    } else {
        ("file", "application/octet-stream")
    }
}

pub async fn upload(
    State(app): State<App>,
    headers: HeaderMap,
    Extension(body): Extension<Bytes>,
) -> Result<(S, Json<Attachment>)> {
    save(app, headers, body, false).await
}
pub async fn upload_backend(
    State(app): State<App>,
    headers: HeaderMap,
    Extension(body): Extension<Bytes>,
) -> Result<(S, Json<Attachment>)> {
    save(app, headers, body, true).await
}
async fn save(
    app: App,
    headers: HeaderMap,
    body: Bytes,
    adapter: bool,
) -> Result<(S, Json<Attachment>)> {
    let purpose = purpose(&headers, adapter)?;
    let filename = filename(&headers)?;
    let declared = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let (kind, mime) = classify(&body, declared, &filename);
    if purpose != "turn" && kind != "image" {
        return Err(Error(
            S::BAD_REQUEST,
            "Avatars must be PNG, JPEG, GIF or WebP images",
        ));
    }
    let item = tokio::task::spawn_blocking(move || -> Result<Attachment> {
        let id = Uuid::new_v4().to_string();
        let path = app.attachments.join(&id);
        let mut file = OpenOptions::new()
            .mode(0o600)
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(|_| UNAVAILABLE)?;
        let result = (|| {
            file.write_all(&body).map_err(|_| UNAVAILABLE)?;
            file.sync_all().map_err(|_| UNAVAILABLE)?;
            lock(&app.db).execute(
                "INSERT INTO attachments(id,purpose,filename,mime,kind,size) VALUES(?,?,?,?,?,?)",
                params![id, purpose, filename, mime, kind, body.len()],
            )?;
            Ok(Attachment {
                id,
                filename,
                mime: mime.into(),
                kind: kind.into(),
                size: body.len() as u64,
            })
        })();
        if result.is_err() {
            let _ = fs::remove_file(path);
        }
        result
    })
    .await
    .map_err(|_| UNAVAILABLE)??;
    Ok((S::CREATED, Json(item)))
}

pub fn avatar_exists(db: &Connection, id: &str, backend_only: bool) -> rusqlite::Result<bool> {
    db.query_row(
        "SELECT EXISTS (SELECT 1 FROM attachments WHERE id=? AND kind='image' AND (purpose='backend_avatar' OR (purpose='avatar' AND NOT ?)))",
        params![id, backend_only], |r| r.get(0),
    )
}

fn byte_range(value: &str, size: u64) -> Option<(u64, u64)> {
    let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
    if size == 0 || !start.bytes().chain(end.bytes()).all(|b| b.is_ascii_digit()) {
        return None;
    }
    if start.is_empty() {
        let suffix: u64 = end.parse().ok()?;
        return (suffix > 0).then(|| (size.saturating_sub(suffix), size - 1));
    }
    let start: u64 = start.parse().ok()?;
    let end = if end.is_empty() {
        size - 1
    } else {
        end.parse::<u64>().ok()?.min(size - 1)
    };
    (start <= end).then_some((start, end))
}

fn disposition(download: bool, filename: &str) -> String {
    let encoded = filename
        .bytes()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.') {
                char::from(c).to_string()
            } else {
                format!("%{c:02X}")
            }
        })
        .collect::<String>();
    format!(
        "{}; filename*=UTF-8''{encoded}",
        if download { "attachment" } else { "inline" }
    )
}

pub async fn view(
    State(app): State<App>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    serve(app, id, headers, false, false).await
}
pub async fn download(
    State(app): State<App>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    serve(app, id, headers, true, false).await
}
pub async fn adapter_view(
    State(app): State<App>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    serve(app, id, headers, false, true).await
}
async fn serve(
    app: App,
    id: String,
    headers: HeaderMap,
    download: bool,
    adapter: bool,
) -> Result<Response> {
    if crate::request_id(&id).is_err() {
        return Err(MISSING);
    }
    let item = lock(&app.db).query_row(
        "SELECT filename,mime,kind,size FROM attachments WHERE id=? AND (NOT ? OR purpose='turn' AND turn IS NOT NULL)",
        params![id, adapter],
        |r| Ok(Attachment { id: id.clone(), filename:r.get(0)?, mime:r.get(1)?, kind:r.get(2)?, size:r.get(3)? }),
    ).optional()?.ok_or(MISSING)?;
    let media = item.kind != "file";
    let mut range = headers.get_all(header::RANGE).iter();
    let requested = if media {
        match range.next() {
            None => None,
            Some(value) => match value.to_str().ok().and_then(|v| byte_range(v, item.size)) {
                Some(range_value) if range.next().is_none() => Some(range_value),
                _ => {
                    return Ok((
                        S::RANGE_NOT_SATISFIABLE,
                        [(header::CONTENT_RANGE, format!("bytes */{}", item.size))],
                    )
                        .into_response());
                }
            },
        }
    } else {
        None
    };
    let permit = app.attachment_slots.download()?;
    let (start, len) = requested.map_or((0, item.size), |(a, b)| (a, b - a + 1));
    let bytes = tokio::task::spawn_blocking(move || -> std::io::Result<Bytes> {
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(app.attachments.join(id))?;
        file.seek(SeekFrom::Start(start))?;
        let mut bytes = vec![0; len as usize];
        file.read_exact(&mut bytes)?;
        Ok(transfer_bytes(Bytes::from(bytes), permit))
    })
    .await
    .map_err(|_| UNAVAILABLE)?
    .map_err(|_| UNAVAILABLE)?;
    let mut response = Response::builder()
        .status(if requested.is_some() {
            S::PARTIAL_CONTENT
        } else {
            S::OK
        })
        .header(header::CONTENT_TYPE, item.mime)
        .header(
            header::CONTENT_DISPOSITION,
            disposition(download || !media, &item.filename),
        )
        .header(header::CONTENT_LENGTH, len);
    if media {
        response = response.header(header::ACCEPT_RANGES, "bytes");
    }
    if let Some((start, end)) = requested {
        response = response.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{}", item.size),
        );
    }
    response.body(Body::from(bytes)).map_err(|_| UNAVAILABLE)
}

#[cfg(test)]
mod tests;
