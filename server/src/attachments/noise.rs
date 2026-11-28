use super::*;
use std::sync::atomic::{AtomicU8, Ordering};
use std::{io, os::unix::fs::MetadataExt, path::PathBuf};
use tokio::{fs::File, time::Instant};

pub const PENDING: &str = ".noise-upload-";
const DEV_PENDING: &str = ".noise-dev-upload-";

pub struct StagedUpload {
    purpose: &'static str,
    pub file: File,
    item: Attachment,
    marker: PathBuf,
    linked: Option<PathBuf>,
    _permit: OwnedSemaphorePermit,
}

impl StagedUpload {
    #[cfg(all(test, feature = "noise-dev"))]
    pub fn begin(app: &App, name: &str, size: u64) -> Result<Self> {
        Self::begin_upload(
            app,
            name,
            size,
            rothcold_noise_protocol::v1::UploadPurpose::Turn,
        )
    }

    pub fn begin_upload(
        app: &App,
        name: &str,
        size: u64,
        purpose: rothcold_noise_protocol::v1::UploadPurpose,
    ) -> Result<Self> {
        use rothcold_noise_protocol::v1::UploadPurpose;
        let purpose = match purpose {
            UploadPurpose::Turn => "turn",
            UploadPurpose::Avatar => "avatar",
        };
        let filename = sanitize_filename(name)?;
        let permit = app.attachment_slots.upload()?;
        let id = Uuid::new_v4().to_string();
        let marker = app.attachments.join(format!("{PENDING}{id}"));
        let file = OpenOptions::new()
            .mode(0o600)
            .create_new(true)
            .write(true)
            .open(&marker)
            .map_err(|_| UNAVAILABLE)?;
        Ok(Self {
            purpose,
            file: File::from_std(file),
            item: Attachment {
                id,
                filename,
                mime: String::new(),
                kind: String::new(),
                size,
            },
            marker,
            linked: None,
            _permit: permit,
        })
    }

    #[cfg(all(test, feature = "noise-dev"))]
    pub fn classify(&mut self, prefix: &[u8]) {
        self.classify_hint(prefix, "");
    }

    pub fn classify_hint(&mut self, prefix: &[u8], hint: &str) {
        let (kind, mime) = super::classify(prefix, hint, &self.item.filename);
        self.item.kind = kind.into();
        self.item.mime = mime.into();
    }

    // Keep the temporary name until SQLite commits. It identifies a possibly
    // uncommitted final name after an interrupted worker or process.
    pub fn prepare_final(&mut self, dir: &FsPath) -> Result<()> {
        if self.purpose == "avatar" && self.item.kind != "image" {
            return Err(Error(
                S::BAD_REQUEST,
                "Avatars must be PNG, JPEG, GIF or WebP images",
            ));
        }
        let file = OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&self.marker)
            .map_err(|_| UNAVAILABLE)?;
        if file.metadata().map_err(|_| UNAVAILABLE)?.len() != self.item.size {
            return Err(UNAVAILABLE);
        }
        file.sync_all().map_err(|_| UNAVAILABLE)?;
        let path = dir.join(&self.item.id);
        fs::hard_link(&self.marker, &path).map_err(|_| UNAVAILABLE)?;
        self.linked = Some(path);
        fs::File::open(dir)
            .and_then(|d| d.sync_all())
            .map_err(|_| UNAVAILABLE)
    }

    pub fn record(&self, tx: &rusqlite::Transaction<'_>) -> Result<()> {
        record_attachment(tx, self.purpose, &self.item)
    }

    pub fn committed(mut self) -> rothcold_noise_protocol::Attachment {
        self.linked = None;
        wire_item(&self.item)
    }
}

impl Drop for StagedUpload {
    fn drop(&mut self) {
        if let Some(path) = &self.linked
            && remove(path).is_err()
        {
            eprintln!("Could not clean a Noise upload; retained recovery marker");
            return;
        }
        if remove(&self.marker).is_err() {
            eprintln!("Could not clean a Noise upload");
        }
    }
}

fn remove(path: &FsPath) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

pub fn recover(dir: &FsPath, db: &Connection) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(id) = name.to_str().and_then(|s| {
            s.strip_prefix(PENDING)
                .or_else(|| s.strip_prefix(DEV_PENDING))
        }) else {
            continue;
        };
        if crate::request_id(id).is_err() || !entry.file_type()?.is_file() {
            continue;
        }
        let committed: bool = db
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM attachments WHERE id=?)",
                [id],
                |r| r.get(0),
            )
            .map_err(io::Error::other)?;
        let path = dir.join(id);
        if !committed {
            match fs::symlink_metadata(&path) {
                Ok(final_meta) => {
                    let pending = entry.metadata()?;
                    if final_meta.dev() == pending.dev() && final_meta.ino() == pending.ino() {
                        remove(&path)?;
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => (),
                Err(e) => return Err(e),
            }
        }
        remove(&entry.path())?;
    }
    Ok(())
}

#[cfg(all(test, feature = "noise-dev"))]
pub fn open_turn(
    app: &App,
    id: &str,
) -> Result<(
    rothcold_noise_protocol::Attachment,
    File,
    OwnedSemaphorePermit,
)> {
    open_download(app, id, true)
}

pub fn open_download(
    app: &App,
    id: &str,
    turn_only: bool,
) -> Result<(
    rothcold_noise_protocol::Attachment,
    File,
    OwnedSemaphorePermit,
)> {
    let item = lookup_attachment(&lock(&app.db), id, turn_only, false)?;
    let permit = app.attachment_slots.download()?;
    let file = open_attachment(&app.attachments, &item.id).map_err(|_| UNAVAILABLE)?;
    let meta = file.metadata().map_err(|_| UNAVAILABLE)?;
    if !meta.is_file() || meta.len() != item.size || item.size > FILE_LIMIT as u64 {
        return Err(UNAVAILABLE);
    }
    Ok((wire_item(&item), File::from_std(file), permit))
}

fn wire_item(item: &Attachment) -> rothcold_noise_protocol::Attachment {
    rothcold_noise_protocol::Attachment {
        id: item.id.clone(),
        filename: item.filename.clone(),
        mime: item.mime.clone(),
        kind: item.kind.clone(),
        size: item.size,
    }
}

const PENDING_COMMIT: u8 = 0;
const CANCELLED_COMMIT: u8 = 1;
const CLAIMED_COMMIT: u8 = 2;

pub struct CommitBoundary {
    state: AtomicU8,
    deadline: Instant,
}

impl CommitBoundary {
    pub fn claim(&self) -> bool {
        let claimed = self
            .state
            .compare_exchange(
                PENDING_COMMIT,
                CLAIMED_COMMIT,
                Ordering::Relaxed,
                Ordering::Relaxed,
            )
            .is_ok();
        // The timer may not have woken the connection yet. Check the clock
        // after winning the race so a late claim cannot publish the row.
        claimed && Instant::now() < self.deadline
    }
}

pub struct CancelCommit(pub Arc<CommitBoundary>);

impl CancelCommit {
    pub fn new(deadline: Instant) -> Self {
        Self(Arc::new(CommitBoundary {
            state: AtomicU8::new(PENDING_COMMIT),
            deadline,
        }))
    }
}

impl Drop for CancelCommit {
    fn drop(&mut self) {
        let _ = self.0.state.compare_exchange(
            PENDING_COMMIT,
            CANCELLED_COMMIT,
            Ordering::Relaxed,
            Ordering::Relaxed,
        );
    }
}
