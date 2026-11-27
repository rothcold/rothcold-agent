use crate::{App, Input, Result, field, lock, same};
use axum::{
    Extension, Json,
    extract::{Path, State},
    http::StatusCode as S,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const LIFETIME: i64 = 30 * 24 * 60 * 60;

pub fn migrate(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "CREATE TABLE device_sessions(
            id TEXT PRIMARY KEY, hash BLOB NOT NULL UNIQUE, name TEXT NOT NULL,
            created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
        );
        PRAGMA user_version=4;",
    )
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[derive(Clone, Serialize)]
pub struct Device {
    id: String,
    name: String,
    created_at: i64,
    expires_at: i64,
}
fn device(row: &rusqlite::Row<'_>) -> rusqlite::Result<Device> {
    Ok(Device {
        id: row.get(0)?,
        name: row.get(1)?,
        created_at: row.get(2)?,
        expires_at: row.get(3)?,
    })
}

pub fn authenticate(db: &Connection, bearer: &[u8]) -> rusqlite::Result<Option<Device>> {
    if bearer.len() != 64 || !bearer.iter().all(u8::is_ascii_hexdigit) {
        return Ok(None);
    }
    db.query_row(
        "SELECT id,name,created_at,expires_at FROM device_sessions WHERE hash=? AND expires_at>?",
        params![Sha256::digest(bearer).as_slice(), now()],
        device,
    )
    .optional()
}

pub async fn status() -> Json<Value> {
    Json(json!({"service":"rothcold-agent","apiVersion":1}))
}

pub async fn login(State(app): State<App>, Extension(data): Input) -> Result<Json<Value>> {
    let name = if data.get("name").is_some() {
        let name = field(&data, "name", 80)?.trim();
        if name.chars().any(char::is_control) {
            return Err(crate::BAD);
        }
        name
    } else {
        "Native device"
    };
    let mut auth = lock(&app.auth);
    let clock = Instant::now();
    if clock >= auth.window {
        auth.failures = 0;
        auth.window = clock + Duration::from_secs(60);
    }
    if auth.failures >= 8 {
        return Err(crate::Error(S::TOO_MANY_REQUESTS, "Too Many Requests"));
    }
    if !same(field(&data, "token", 512)?.as_bytes(), app.owner.as_bytes()) {
        auth.failures += 1;
        return Err(crate::UNAUTHORIZED);
    }
    let key = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let created_at = now();
    let device = Device {
        id: Uuid::new_v4().to_string(),
        name: name.to_string(),
        created_at,
        expires_at: created_at + LIFETIME,
    };
    let db = lock(&app.db);
    db.execute(
        "DELETE FROM device_sessions WHERE expires_at<=?",
        [created_at],
    )?;
    db.execute(
        "INSERT INTO device_sessions(id,hash,name,created_at,expires_at) VALUES(?,?,?,?,?)",
        params![
            device.id,
            Sha256::digest(key.as_bytes()).as_slice(),
            device.name,
            device.created_at,
            device.expires_at
        ],
    )?;
    auth.failures = 0;
    Ok(Json(json!({"session":key,"device":device})))
}

pub async fn me(Extension(current): Extension<Device>) -> Json<Device> {
    Json(current)
}

pub async fn list(
    State(app): State<App>,
    Extension(current): Extension<Device>,
) -> Result<Json<Value>> {
    let db = lock(&app.db);
    let mut stmt = db.prepare("SELECT id,name,created_at,expires_at FROM device_sessions WHERE expires_at>? ORDER BY created_at DESC,id")?;
    let devices = stmt
        .query_map([now()], device)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Json(json!({"current":current.id,"devices":devices})))
}

fn delete(app: &App, id: &str) -> rusqlite::Result<()> {
    lock(&app.db).execute("DELETE FROM device_sessions WHERE id=?", [id])?;
    Ok(())
}

pub async fn logout(
    State(app): State<App>,
    Extension(current): Extension<Device>,
) -> Result<Json<Value>> {
    delete(&app, &current.id)?;
    Ok(Json(json!({})))
}

pub async fn revoke(
    State(app): State<App>,
    Path(id): Path<String>,
    Extension(current): Extension<Device>,
) -> Result<Json<Value>> {
    if Uuid::parse_str(&id).is_err() {
        return Err(crate::BAD);
    }
    delete(&app, &id)?;
    Ok(Json(json!({"current":current.id == id})))
}
