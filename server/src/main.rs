mod store;

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
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use uuid::Uuid;

const HOST: &str = "127.0.0.1:8766";
const ORIGIN: &str = "http://127.0.0.1:8766";
struct Platform {
    db: Mutex<Connection>,
    auth: Mutex<Auth>,
    owner: String,
    bridge: String,
}
struct Auth {
    session: Option<(String, Instant)>,
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
const BAD: Error = Error(S::BAD_REQUEST, "Bad Request");
fn field<'a>(v: &'a Value, key: &str, max: usize) -> Result<&'a str> {
    v[key]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.chars().count() <= max)
        .ok_or(BAD)
}
fn message(v: &Value) -> Result<(&str, &str)> {
    let id = field(v, "id", 36)?;
    let uuid = Uuid::parse_str(id).map_err(|_| BAD)?;
    if uuid.get_version_num() != 4
        || uuid.get_variant() != uuid::Variant::RFC4122
        || uuid.to_string() != id
    {
        return Err(BAD);
    }
    Ok((id, field(v, "text", 8000)?))
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
    if !only(h, header::HOST, HOST)
        || req.uri().query().is_some()
        || ((req.method() != Method::GET || h.contains_key(header::ORIGIN))
            && !only(h, header::ORIGIN, ORIGIN))
    {
        return Err(Error(S::FORBIDDEN, "Forbidden"));
    }
    let bearer = h
        .get(header::AUTHORIZATION)
        .and_then(|v| v.as_bytes().strip_prefix(b"Bearer "))
        .unwrap_or_default();
    let valid = if path.starts_with("/adapter/") {
        same(bearer, app.bridge.as_bytes())
    } else if path.starts_with("/api/") && path != "/api/login" {
        app.auth
            .lock()
            .unwrap()
            .session
            .as_ref()
            .is_some_and(|(k, end)| Instant::now() < *end && same(k.as_bytes(), bearer))
    } else {
        true
    };
    if !valid {
        return Err(Error(S::UNAUTHORIZED, "Unauthorized"));
    }
    if req.method() == Method::HEAD {
        return Err(Error(S::METHOD_NOT_ALLOWED, "Method Not Allowed"));
    }
    if req.method() == Method::POST {
        let mime = h
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim();
        if !mime.eq_ignore_ascii_case("application/json")
            || h.contains_key(header::CONTENT_ENCODING)
        {
            return Err(Error(S::UNSUPPORTED_MEDIA_TYPE, "Unsupported Media Type"));
        }
        let limit = if matches!(path, "/adapter/final" | "/adapter/update" | "/adapter/push") {
            800 * 1024
        } else {
            64 * 1024
        };
        let (parts, body) = req.into_parts();
        let bytes = to_bytes(body, limit - 1)
            .await
            .map_err(|_| Error(S::PAYLOAD_TOO_LARGE, "Request Entity Too Large"))?;
        let data: Value = serde_json::from_slice(&bytes).map_err(|_| BAD)?;
        if !data.is_object() {
            return Err(BAD);
        }
        req = Request::from_parts(parts, axum::body::Body::empty());
        req.extensions_mut().insert(data);
    }
    Ok(next.run(req).await)
}
async fn login(State(app): State<App>, Extension(data): Input) -> Result<Json<Value>> {
    let mut auth = app.auth.lock().unwrap();
    let now = Instant::now();
    if now >= auth.window {
        auth.failures = 0;
        auth.window = now + Duration::from_secs(60);
    }
    if auth.failures >= 8 {
        return Err(Error(S::TOO_MANY_REQUESTS, "Too Many Requests"));
    }
    if !same(field(&data, "token", 512)?.as_bytes(), app.owner.as_bytes()) {
        auth.failures += 1;
        return Err(Error(S::UNAUTHORIZED, "Unauthorized"));
    }
    let key = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    auth.failures = 0;
    auth.session = Some((key.clone(), now + Duration::from_secs(8 * 3600)));
    Ok(Json(json!({"session":key})))
}
async fn channels(State(a): State<App>) -> Result<Json<Value>> {
    Ok(Json(store::channels(&a.db.lock().unwrap())?))
}
async fn category(State(a): State<App>, Extension(v): Input) -> Result<(S, Json<Value>)> {
    Ok((
        S::CREATED,
        Json(store::category(
            &mut a.db.lock().unwrap(),
            field(&v, "name", 80)?.trim(),
        )?),
    ))
}
async fn chats(State(a): State<App>) -> Result<Json<Value>> {
    Ok(Json(store::chats(&a.db.lock().unwrap())?))
}
async fn notifications(State(a): State<App>) -> Result<Json<Value>> {
    Ok(Json(store::notifications(&a.db.lock().unwrap())?))
}
async fn history(State(a): State<App>, Path(chat): Path<String>) -> Result<Json<Value>> {
    Ok(Json(store::history(&a.db.lock().unwrap(), &chat)?))
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
    store::rename(&a.db.lock().unwrap(), &chat, title)?;
    Ok(Json(json!({"title": title})))
}
async fn read(State(a): State<App>, Path(chat): Path<String>) -> Result<Json<Value>> {
    store::mark_read(&a.db.lock().unwrap(), &chat)?;
    Ok(Json(json!({})))
}
fn receipt((fresh, obj): (bool, Value)) -> (S, Json<Value>) {
    (if fresh { S::ACCEPTED } else { S::OK }, Json(obj))
}
async fn start(State(a): State<App>, Extension(v): Input) -> Result<(S, Json<Value>)> {
    let (id, text) = message(&v)?;
    let cat = if v.get("channel").is_none() {
        "general"
    } else {
        field(&v, "channel", 36)?
    };
    Ok(receipt(store::enqueue(
        &mut a.db.lock().unwrap(),
        id,
        id,
        text,
        Some(cat),
    )?))
}
async fn send_turn(
    State(a): State<App>,
    Path(chat): Path<String>,
    Extension(v): Input,
) -> Result<(S, Json<Value>)> {
    let (id, text) = message(&v)?;
    Ok(receipt(store::enqueue(
        &mut a.db.lock().unwrap(),
        &chat,
        id,
        text,
        None,
    )?))
}
async fn connect(State(a): State<App>) -> Result<Json<Value>> {
    store::interrupt(&a.db.lock().unwrap())?;
    Ok(Json(json!({})))
}
async fn claim(State(a): State<App>) -> Result<Json<Value>> {
    Ok(Json(store::claim(&mut a.db.lock().unwrap())?))
}
async fn admission(State(a): State<App>, Extension(v): Input) -> Result<Json<Value>> {
    store::admission(
        &a.db.lock().unwrap(),
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
        &mut a.db.lock().unwrap(),
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
    let uuid = Uuid::parse_str(id).map_err(|_| BAD)?;
    if uuid.get_version_num() != 4
        || uuid.get_variant() != uuid::Variant::RFC4122
        || uuid.to_string() != id
    {
        return Err(BAD);
    }
    store::push(
        &mut a.db.lock().unwrap(),
        field(&v, "chat", 36)?,
        id,
        field(&v, "text", 65536)?,
    )?;
    Ok(Json(json!({})))
}
async fn finish(State(a): State<App>, Extension(v): Input) -> Result<Json<Value>> {
    store::finish(
        &mut a.db.lock().unwrap(),
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
    unsafe {
        libc::umask(0o077);
    }
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
    let app = Arc::new(Platform {
        db: Mutex::new(db),
        auth: Mutex::new(Auth {
            session: None,
            window: Instant::now(),
            failures: 0,
        }),
        owner,
        bridge,
    });
    let mut routes = Router::new()
        .route("/api/login", post(login))
        .route("/api/channels", get(channels).post(category))
        .route("/api/chats", get(chats).post(start))
        .route("/api/notifications", get(notifications))
        .route("/api/chats/{chat}/read", post(read))
        .route("/api/chats/{chat}/rename", post(rename))
        .route("/api/chats/{chat}/turns", get(history).post(send_turn))
        .route("/adapter/connect", post(connect))
        .route("/adapter/claim", post(claim))
        .route("/adapter/admission", post(admission))
        .route("/adapter/update", post(update))
        .route("/adapter/push", post(push))
        .route("/adapter/final", post(finish));
    for (url, mime, body) in [
        (
            "/",
            "text/html",
            include_bytes!("../static/index.html").as_slice(),
        ),
        (
            "/app.js",
            "text/javascript",
            include_bytes!("../static/app.js").as_slice(),
        ),
        (
            "/app.css",
            "text/css",
            include_bytes!("../static/app.css").as_slice(),
        ),
    ] {
        routes = routes.route(
            url,
            get(move || async move { ([(header::CONTENT_TYPE, mime)], body) }),
        );
    }
    println!("Rothcold Agent listening on {ORIGIN}");
    axum::serve(
        listener,
        routes
            .layer(middleware::from_fn_with_state(app.clone(), guard))
            .with_state(app),
    )
    .await
}
