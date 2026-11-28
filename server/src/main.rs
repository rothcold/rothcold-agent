mod approvals;
mod attachments;
mod noise;
#[cfg(all(test, feature = "noise-dev"))]
mod noise_dev;
mod profiles;
mod sessions;
mod slash_catalog;
mod store;
mod thread_titles;

use axum::{
    Extension, Json, Router,
    body::to_bytes,
    extract::{Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode as S, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    env,
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
    slash_catalog: Mutex<slash_catalog::SlashCatalog>,
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
    if !path.starts_with("/adapter/") {
        return Err(Error(S::NOT_FOUND, "Not Found"));
    }
    if !only(h, header::HOST, HOST)
        || req.uri().scheme().is_some()
        || req.uri().authority().is_some()
        || req.uri().query().is_some()
        || path
            .bytes()
            .any(|c| !c.is_ascii_alphanumeric() && !matches!(c, b'/' | b'-' | b'_'))
    {
        return Err(Error(S::FORBIDDEN, "Forbidden"));
    }
    let mut authorizations = h.get_all(header::AUTHORIZATION).iter();
    let bearer = authorizations
        .next()
        .and_then(|v| v.as_bytes().strip_prefix(b"Bearer "))
        .unwrap_or_default();
    if authorizations.next().is_some() || !same(bearer, app.bridge.as_bytes()) {
        return Err(UNAUTHORIZED);
    }
    if !only(h, header::ORIGIN, ORIGIN) {
        return Err(Error(S::FORBIDDEN, "Forbidden"));
    }
    if !matches!(*req.method(), Method::GET | Method::POST) {
        return Err(Error(S::METHOD_NOT_ALLOWED, "Method Not Allowed"));
    }
    if req.method() == Method::POST {
        let binary = path == "/adapter/avatar";
        let mut content_types = h.get_all(header::CONTENT_TYPE).iter();
        let mime = content_types
            .next()
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let limit = if binary {
            attachments::purpose(h, true)?;
            attachments::AVATAR_LIMIT
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
    Ok(next.run(req).await)
}
async fn connect(State(a): State<App>) -> Result<Json<Value>> {
    *lock(&a.approvals) = approvals::Mailbox::default();
    *lock(&a.slash_catalog) = slash_catalog::SlashCatalog::default();
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
    let dir = env::var_os("ROTHCOLD_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share/rothcold-agent"))
        })
        .ok_or_else(|| std::io::Error::other("Set ROTHCOLD_DATA_DIR or HOME"))?;
    let mut args = env::args_os().skip(1);
    match (args.next(), args.next()) {
        (Some(command), None) if command == "noise-pin" => {
            noise::identity::check_dir(&dir)?;
            let identity = noise::identity::load_or_create(&dir)?;
            for byte in identity.pin {
                print!("{byte:02x}");
            }
            println!();
            return Ok(());
        }
        (None, None) => (),
        _ => return Err(std::io::Error::other("Usage: rothcold-agent [noise-pin]")),
    }
    let owner = secret("ROTHCOLD_AGENT_OWNER_TOKEN")?;
    let bridge = secret("ROTHCOLD_AGENT_ADAPTER_TOKEN")?;
    if owner == bridge {
        return Err(std::io::Error::other(
            "Owner and adapter tokens must differ",
        ));
    }
    let config = noise::Config::load()?;
    noise::identity::check_dir(&dir)?;
    let _workspace = noise::identity::workspace_lock(&dir)?;
    let identity = noise::identity::load(&dir).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            std::io::Error::other("Missing Noise identity: restore it or run the local noise-pin command for a new workspace")
        } else { error }
    })?;
    let listener = tokio::net::TcpListener::bind(HOST).await?;
    let native = tokio::net::TcpListener::bind(config.native).await?;
    let ws = if let Some(config) = config.browser {
        Some((tokio::net::TcpListener::bind(config.addr).await?, config))
    } else {
        None
    };
    let mut db = Connection::open(dir.join("history.sqlite3")).map_err(std::io::Error::other)?;
    store::init(&mut db)
        .map_err(|e| std::io::Error::other(format!("Database setup failed: {e:?}")))?;
    store::interrupt(&db).map_err(|e| {
        std::io::Error::other(format!("Could not recover outstanding turns: {e:?}"))
    })?;
    let attachments = dir.join("attachments");
    attachments::init_dir(&attachments)?;
    attachments::noise::recover(&attachments, &db)?;
    let app = Arc::new(Platform {
        attachments,
        attachment_slots: Default::default(),
        profiles: Mutex::default(),
        slash_catalog: Mutex::default(),
        db: Mutex::new(db),
        approvals: Mutex::default(),
        auth: Mutex::new(Auth {
            window: Instant::now(),
            failures: 0,
        }),
        owner,
        bridge,
    });
    let service = noise::Service::new(app.clone(), identity);
    println!("Rothcold Agent adapter listening on {ORIGIN}");
    println!(
        "Rothcold Agent native Noise listening on {}",
        native.local_addr()?
    );
    if let Some((listener, _)) = &ws {
        println!(
            "Rothcold Agent browser Noise listening on {}",
            listener.local_addr()?
        );
    }
    let adapter = async { axum::serve(listener, adapter_routes(app)).await };
    let browser = async {
        if let Some((listener, config)) = ws {
            service.clone().browser(listener, config).await
        } else {
            std::future::pending().await
        }
    };
    tokio::try_join!(adapter, browser, service.clone().native(native))?;
    Ok(())
}

fn adapter_routes(app: App) -> Router {
    Router::new()
        .route("/adapter/connect", post(connect))
        .route("/adapter/slash-catalog", post(slash_catalog::report))
        .route("/adapter/profile", post(profiles::report))
        .route("/adapter/avatar", post(attachments::upload_backend))
        .route("/adapter/attachments/{id}", get(attachments::adapter_view))
        .route("/adapter/claim", post(claim))
        .route("/adapter/title-claim", post(thread_titles::claim))
        .route("/adapter/title-result", post(thread_titles::finish))
        .route("/adapter/admission", post(admission))
        .route("/adapter/update", post(update))
        .route("/adapter/push", post(push))
        .route("/adapter/final", post(finish))
        .layer(middleware::from_fn_with_state(app.clone(), guard))
        .with_state(app)
}
