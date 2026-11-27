mod approvals;
mod attachments;
mod profiles;
mod sessions;
mod store;
mod thread_titles;

use axum::{
    Extension, Json, Router,
    body::to_bytes,
    extract::{Path, Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode as S, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    env, fs,
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard},
    time::Instant,
};
use subtle::ConstantTimeEq;
use uuid::Uuid;

const HOST: &str = "127.0.0.1:8766";
const ORIGIN: &str = "http://127.0.0.1:8766";
pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

struct Platform {
    db: Mutex<Connection>,
    auth: Mutex<Auth>,
    approvals: Mutex<approvals::Mailbox>,
    attachments: PathBuf,
    attachment_slots: attachments::TransferSlots,
    profiles: Mutex<profiles::ProfilePolls>,
    owner: String,
    bridge: String,
}
struct Auth {
    window: Instant,
    failures: u8,
}
type App = Arc<Platform>;
type Input = Extension<Value>;
#[derive(Debug)]
struct Error(S, &'static str);
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (self.0, self.1).into_response()
    }
}
impl From<store::Error> for Error {
    fn from(e: store::Error) -> Self {
        match e {
            store::Error::Missing => Self(S::NOT_FOUND, "Category or thread not found"),
            store::Error::Conflict(reason) => Self(S::CONFLICT, reason),
            store::Error::Sql(e) => {
                eprintln!("Workspace database operation failed: {e}");
                Self(S::INTERNAL_SERVER_ERROR, "Database operation failed")
            }
        }
    }
}
type Result<T> = std::result::Result<T, Error>;
impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        store::Error::Sql(error).into()
    }
}
const UNAUTHORIZED: Error = Error(S::UNAUTHORIZED, "Unauthorized");
const BAD: Error = Error(S::BAD_REQUEST, "Bad Request");
fn field<'a>(v: &'a Value, key: &str, max: usize) -> Result<&'a str> {
    v[key]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.chars().count() <= max)
        .ok_or(BAD)
}
fn request_id(id: &str) -> Result<()> {
    let uuid = Uuid::parse_str(id).map_err(|_| BAD)?;
    if uuid.get_version_num() != 4
        || uuid.get_variant() != uuid::Variant::RFC4122
        || uuid.to_string() != id
    {
        return Err(BAD);
    }
    Ok(())
}
fn message(v: &Value) -> Result<(&str, &str, Vec<&str>)> {
    let id = field(v, "id", 36)?;
    request_id(id)?;
    let attachments = match v.get("attachments") {
        None => Vec::new(),
        Some(items) => {
            let items = items
                .as_array()
                .filter(|items| items.len() <= 8)
                .ok_or(BAD)?;
            let mut ids = Vec::with_capacity(items.len());
            for item in items {
                let id = item.as_str().ok_or(BAD)?;
                request_id(id)?;
                if ids.contains(&id) {
                    return Err(BAD);
                }
                ids.push(id);
            }
            ids
        }
    };
    let text = match v.get("text") {
        None if !attachments.is_empty() => "",
        Some(text) => text
            .as_str()
            .filter(|s| s.chars().count() <= 8000)
            .ok_or(BAD)?,
        _ => return Err(BAD),
    };
    if attachments.is_empty() && text.trim().is_empty() {
        return Err(BAD);
    }
    Ok((id, text, attachments))
}
fn only(headers: &HeaderMap, key: HeaderName, expected: &str) -> bool {
    let mut all = headers.get_all(key).iter();
    all.next()
        .is_some_and(|v| v.as_bytes() == expected.as_bytes())
        && all.next().is_none()
}
fn same(a: &[u8], b: &[u8]) -> bool {
    bool::from(a.ct_eq(b))
}
async fn guard(State(app): State<App>, req: Request, next: Next) -> Response {
    let mut response = match checked(app, req, next).await {
        Ok(r) => r,
        Err(e) => e.into_response(),
    };
    let headers = response.headers_mut();
    for (key, val) in [
        (
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        ),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (header::REFERRER_POLICY, "no-referrer"),
        (header::CACHE_CONTROL, "no-store"),
        (
            HeaderName::from_static("cross-origin-resource-policy"),
            "same-origin",
        ),
    ] {
        headers.insert(key, HeaderValue::from_static(val));
    }
    response
}
async fn checked(app: App, mut req: Request, next: Next) -> Result<Response> {
    let h = req.headers();
    let path = req.uri().path();
    let adapter = path.starts_with("/adapter/");
    let api = path.starts_with("/api/");
    if !only(h, header::HOST, HOST)
        || req.uri().scheme().is_some()
        || req.uri().authority().is_some()
        || req.uri().query().is_some()
        || ((api || adapter)
            && path
                .bytes()
                .any(|c| !c.is_ascii_alphanumeric() && !matches!(c, b'/' | b'-' | b'_')))
    {
        return Err(Error(S::FORBIDDEN, "Forbidden"));
    }
    let mut authorizations = h.get_all(header::AUTHORIZATION).iter();
    let bearer = authorizations
        .next()
        .and_then(|v| v.as_bytes().strip_prefix(b"Bearer "))
        .unwrap_or_default();
    if adapter {
        if authorizations.next().is_some() || !same(bearer, app.bridge.as_bytes()) {
            return Err(UNAUTHORIZED);
        }
        if !only(h, header::ORIGIN, ORIGIN) {
            return Err(Error(S::FORBIDDEN, "Forbidden"));
        }
    } else if h.contains_key(header::ORIGIN) || h.contains_key("sec-fetch-site") {
        return Err(Error(S::FORBIDDEN, "Forbidden"));
    }
    if !matches!(*req.method(), Method::GET | Method::POST) {
        return Err(Error(S::METHOD_NOT_ALLOWED, "Method Not Allowed"));
    }
    // Preserve the bearer while reading a bounded request body. Check it immediately before dispatch.
    let bearer = if api && !matches!(path, "/api/login" | "/api/status") {
        if bearer.is_empty() || authorizations.next().is_some() {
            return Err(UNAUTHORIZED);
        }
        Some(bearer.to_vec())
    } else {
        None
    };
    if req.method() == Method::POST {
        let binary = matches!(path, "/api/attachments" | "/adapter/avatar");
        let mut content_types = h.get_all(header::CONTENT_TYPE).iter();
        let mime = content_types
            .next()
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let limit = if binary {
            if let Some(key) = &bearer {
                sessions::authenticate(&lock(&app.db), key)?.ok_or(UNAUTHORIZED)?;
            }
            if attachments::purpose(h, adapter)? == "turn" {
                attachments::FILE_LIMIT
            } else {
                attachments::AVATAR_LIMIT
            }
        } else if matches!(path, "/adapter/final" | "/adapter/update" | "/adapter/push") {
            800 * 1024 - 1
        } else {
            64 * 1024 - 1
        };
        let mime = mime.split(';').next().unwrap_or("").trim();
        if (if binary {
            mime.is_empty()
        } else {
            !mime.eq_ignore_ascii_case("application/json")
        }) || content_types.next().is_some()
            || h.contains_key(header::CONTENT_ENCODING)
        {
            return Err(Error(S::UNSUPPORTED_MEDIA_TYPE, "Unsupported Media Type"));
        }
        let permit = if binary {
            Some(app.attachment_slots.upload()?)
        } else {
            None
        };
        let (parts, body) = req.into_parts();
        let read = to_bytes(body, limit);
        let bytes = if binary {
            tokio::time::timeout(std::time::Duration::from_secs(15), read)
                .await
                .map_err(|_| Error(S::REQUEST_TIMEOUT, "Attachment upload timed out"))?
        } else {
            read.await
        }
        .map_err(|_| Error(S::PAYLOAD_TOO_LARGE, "Request Entity Too Large"))?;
        req = Request::from_parts(parts, axum::body::Body::empty());
        if let Some(permit) = permit {
            req.extensions_mut()
                .insert(attachments::transfer_bytes(bytes, permit));
        } else {
            let data: Value = serde_json::from_slice(&bytes).map_err(|_| BAD)?;
            if !data.is_object() {
                return Err(BAD);
            }
            req.extensions_mut().insert(data);
        }
    }
    if let Some(bearer) = bearer {
        let device = sessions::authenticate(&lock(&app.db), &bearer)?.ok_or(UNAUTHORIZED)?;
        req.extensions_mut().insert(device);
    }
    Ok(next.run(req).await)
}
async fn channels(State(a): State<App>) -> Result<Json<Value>> {
    Ok(Json(store::archive::active_channels(&lock(&a.db))?))
}
fn category_name(v: &Value) -> Result<&str> {
    let name = field(v, "name", 80)?.trim();
    if name.chars().any(char::is_control) {
        return Err(BAD);
    }
    Ok(name)
}
async fn category(State(a): State<App>, Extension(v): Input) -> Result<(S, Json<Value>)> {
    Ok((
        S::CREATED,
        Json(store::category(&mut lock(&a.db), category_name(&v)?)?),
    ))
}
async fn rename_category(
    State(a): State<App>,
    Path(id): Path<String>,
    Extension(v): Input,
) -> Result<Json<Value>> {
    let name = category_name(&v)?;
    store::archive::rename_category(&lock(&a.db), &id, name)?;
    Ok(Json(json!({"name":name})))
}
async fn archive_category(
    State(a): State<App>,
    Path(id): Path<String>,
    Extension(v): Input,
) -> Result<Json<Value>> {
    let archived = v["archived"].as_bool().ok_or(BAD)?;
    store::archive::set_category_archived(&lock(&a.db), &id, archived)?;
    Ok(Json(json!({"archived":u8::from(archived)})))
}
async fn archive_thread(
    State(a): State<App>,
    Path(id): Path<String>,
    Extension(v): Input,
) -> Result<Json<Value>> {
    let archived = v["archived"].as_bool().ok_or(BAD)?;
    store::archive::set_thread_archived(&lock(&a.db), &id, archived)?;
    Ok(Json(json!({"archived":u8::from(archived)})))
}
async fn directory(State(a): State<App>) -> Result<Json<Value>> {
    Ok(Json(store::archive::directory(&lock(&a.db))?))
}
async fn chats(State(a): State<App>) -> Result<Json<Value>> {
    Ok(Json(store::archive::active_chats(&lock(&a.db))?))
}
async fn notifications(State(a): State<App>) -> Result<Json<Value>> {
    Ok(Json(store::inbox::notifications(&lock(&a.db))?))
}
async fn history(State(a): State<App>, Path(chat): Path<String>) -> Result<Json<Value>> {
    let mut rows = store::history(&lock(&a.db), &chat)?;
    lock(&a.approvals).annotate(&chat, &mut rows);
    Ok(Json(rows))
}
async fn rename(
    State(a): State<App>,
    Path(chat): Path<String>,
    Extension(v): Input,
) -> Result<Json<Value>> {
    let title = field(&v, "title", 80)?.trim();
    if title.chars().any(char::is_control) {
        return Err(BAD);
    }
    store::rename(&mut lock(&a.db), &chat, title)?;
    Ok(Json(json!({"title": title})))
}
async fn move_thread(
    State(a): State<App>,
    Path(chat): Path<String>,
    Extension(v): Input,
) -> Result<Json<Value>> {
    let channel = field(&v, "channel", 36)?;
    store::move_thread(&lock(&a.db), &chat, channel)?;
    Ok(Json(json!({"id":chat,"channel":channel})))
}
async fn read(State(a): State<App>, Path(chat): Path<String>) -> Result<Json<Value>> {
    store::mark_read(&lock(&a.db), &chat)?;
    Ok(Json(json!({})))
}
async fn read_reply(
    State(a): State<App>,
    Path((chat, id)): Path<(String, String)>,
) -> Result<Json<Value>> {
    store::mark_reply_read(&lock(&a.db), &chat, &id)?;
    Ok(Json(json!({})))
}
async fn stop_waiting(
    State(a): State<App>,
    Path((chat, id)): Path<(String, String)>,
) -> Result<Json<Value>> {
    store::stop_waiting(&lock(&a.db), &chat, &id)?;
    Ok(Json(json!({})))
}
fn receipt((fresh, obj): (bool, Value)) -> (S, Json<Value>) {
    (if fresh { S::ACCEPTED } else { S::OK }, Json(obj))
}
async fn start(State(a): State<App>, Extension(v): Input) -> Result<(S, Json<Value>)> {
    let (id, text, attachments) = message(&v)?;
    if approvals::is_control(text) {
        return Err(Error(
            S::CONFLICT,
            "Approvals require a live prompt in an existing thread.",
        ));
    }
    let cat = if v.get("channel").is_none() {
        "general"
    } else {
        field(&v, "channel", 36)?
    };
    Ok(receipt(store::enqueue(
        &mut lock(&a.db),
        id,
        id,
        text,
        Some(cat),
        &attachments,
    )?))
}
async fn send_turn(
    State(a): State<App>,
    Path(chat): Path<String>,
    Extension(v): Input,
) -> Result<(S, Json<Value>)> {
    let (id, text, attachments) = message(&v)?;
    if approvals::is_control(text) {
        if !attachments.is_empty() {
            return Err(BAD);
        }
        lock(&a.approvals).answer(&chat, v["approval"].as_str().unwrap_or(""), text)?;
        return Ok((S::ACCEPTED, Json(json!({"id":id,"decision":"submitted"}))));
    }
    Ok(receipt(store::enqueue(
        &mut lock(&a.db),
        &chat,
        id,
        text,
        None,
        &attachments,
    )?))
}
async fn connect(State(a): State<App>) -> Result<Json<Value>> {
    *lock(&a.approvals) = approvals::Mailbox::default();
    store::interrupt(&lock(&a.db))?;
    Ok(Json(json!({})))
}
async fn claim(State(a): State<App>, Extension(v): Input) -> Result<Json<Value>> {
    let backend = if let Some(id) = v.get("backend") {
        profiles::backend_id(id.as_str().ok_or(BAD)?)?
    } else {
        "hermes"
    };
    let control = lock(&a.approvals).poll(&v)?;
    let refresh = lock(&a.profiles).claim(backend, control.is_none());
    if let Some(control) = control {
        return Ok(Json(control));
    }
    if let Some(id) = refresh {
        return Ok(Json(json!({"sync_profile":true,"sync_id":id.to_string()})));
    }
    Ok(Json(store::claim(&mut lock(&a.db))?))
}
async fn admission(State(a): State<App>, Extension(v): Input) -> Result<Json<Value>> {
    store::admission(
        &lock(&a.db),
        field(&v, "id", 36)?,
        v["accepted"].as_bool().ok_or(BAD)?,
    )?;
    Ok(Json(json!({})))
}
async fn update(State(a): State<App>, Extension(v): Input) -> Result<Json<Value>> {
    let kind = field(&v, "kind", 16)?;
    if !matches!(kind, "progress" | "commentary") {
        return Err(BAD);
    }
    let turn = match v.get("turn") {
        None | Some(Value::Null) => None,
        Some(_) => Some(field(&v, "turn", 36)?),
    };
    store::record_update(
        &mut lock(&a.db),
        field(&v, "chat", 36)?,
        turn,
        field(&v, "id", 64)?,
        kind,
        field(&v, "text", 65536)?,
    )?;
    Ok(Json(json!({})))
}
async fn push(State(a): State<App>, Extension(v): Input) -> Result<Json<Value>> {
    let id = field(&v, "id", 36)?;
    request_id(id)?;
    store::push(
        &mut lock(&a.db),
        field(&v, "chat", 36)?,
        id,
        field(&v, "text", 65536)?,
    )?;
    Ok(Json(json!({})))
}
async fn finish(State(a): State<App>, Extension(v): Input) -> Result<Json<Value>> {
    store::finish(
        &mut lock(&a.db),
        field(&v, "chat", 36)?,
        field(&v, "id", 36)?,
        field(&v, "text", 65536)?,
    )?;
    Ok(Json(json!({})))
}
fn secret(name: &str) -> std::io::Result<String> {
    env::var(name)
        .ok()
        .filter(|s| (32..=512).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_graphic()))
        .ok_or_else(|| {
            std::io::Error::other(format!(
                "Set {name} to 32–512 printable ASCII characters without spaces"
            ))
        })
}
#[tokio::main(flavor = "current_thread")]
async fn main() -> std::io::Result<()> {
    // Restrict new DB, journal and directory modes, even outside systemd.
    rustix::process::umask(rustix::fs::Mode::from_raw_mode(0o077));
    let owner = secret("ROTHCOLD_AGENT_OWNER_TOKEN")?;
    let bridge = secret("ROTHCOLD_AGENT_ADAPTER_TOKEN")?;
    if owner == bridge {
        return Err(std::io::Error::other(
            "Owner and adapter tokens must differ",
        ));
    }
    let dir = env::var_os("ROTHCOLD_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share/rothcold-agent"))
        })
        .ok_or_else(|| std::io::Error::other("Set ROTHCOLD_DATA_DIR or HOME"))?;
    let listener = tokio::net::TcpListener::bind(HOST).await?;
    fs::create_dir_all(&dir)?;
    let mut db = Connection::open(dir.join("history.sqlite3")).map_err(std::io::Error::other)?;
    store::init(&mut db)
        .map_err(|e| std::io::Error::other(format!("Database setup failed: {e:?}")))?;
    let attachments = dir.join("attachments");
    attachments::init_dir(&attachments)?;
    let app = Arc::new(Platform {
        attachments,
        attachment_slots: Default::default(),
        profiles: Mutex::default(),
        db: Mutex::new(db),
        approvals: Mutex::default(),
        auth: Mutex::new(Auth {
            window: Instant::now(),
            failures: 0,
        }),
        owner,
        bridge,
    });
    let routes = Router::new()
        .route("/api/status", get(sessions::status))
        .route("/api/login", post(sessions::login))
        .route("/api/me", get(sessions::me))
        .route("/api/logout", post(sessions::logout))
        .route("/api/sessions", get(sessions::list))
        .route("/api/sessions/{id}/revoke", post(sessions::revoke))
        .route("/api/profile", get(profiles::get).post(profiles::update))
        .route("/api/profile/sync", post(profiles::sync))
        .route("/api/attachments", post(attachments::upload))
        .route("/api/attachments/{id}", get(attachments::view))
        .route("/api/attachments/{id}/download", get(attachments::download))
        .route("/api/directory", get(directory))
        .route("/api/channels", get(channels).post(category))
        .route("/api/channels/{id}/rename", post(rename_category))
        .route("/api/channels/{id}/archive", post(archive_category))
        .route("/api/chats", get(chats).post(start))
        .route("/api/chats/{id}/archive", post(archive_thread))
        .route("/api/notifications", get(notifications))
        .route("/api/chats/{chat}/read", post(read))
        .route("/api/chats/{chat}/read/{id}", post(read_reply))
        .route("/api/chats/{chat}/rename", post(rename))
        .route("/api/chats/{chat}/move", post(move_thread))
        .route("/api/chats/{chat}/turns", get(history).post(send_turn))
        .route(
            "/api/chats/{chat}/turns/{id}/stop-waiting",
            post(stop_waiting),
        )
        .route("/adapter/connect", post(connect))
        .route("/adapter/profile", post(profiles::report))
        .route("/adapter/avatar", post(attachments::upload_backend))
        .route("/adapter/attachments/{id}", get(attachments::adapter_view))
        .route("/adapter/claim", post(claim))
        .route("/adapter/title-claim", post(thread_titles::claim))
        .route("/adapter/title-result", post(thread_titles::finish))
        .route("/adapter/admission", post(admission))
        .route("/adapter/update", post(update))
        .route("/adapter/push", post(push))
        .route("/adapter/final", post(finish));
    println!("Rothcold Agent listening on {ORIGIN}");
    axum::serve(
        listener,
        routes
            .layer(middleware::from_fn_with_state(app.clone(), guard))
            .with_state(app),
    )
    .await
}
