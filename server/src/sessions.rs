use crate::{App, Result, S, lock};
pub use rothcold_noise_protocol::v1::Device;
use rusqlite::{Connection, OptionalExtension, params};
#[cfg(all(test, feature = "noise-dev"))]
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
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

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

pub fn device(row: &rusqlite::Row<'_>) -> rusqlite::Result<Device> {
    Ok(Device {
        id: row.get(0)?,
        name: row.get(1)?,
        created_at: row.get(2)?,
        expires_at: row.get(3)?,
    })
}

#[cfg(all(test, feature = "noise-dev"))]
pub fn authenticate(db: &Connection, bearer: &[u8]) -> rusqlite::Result<Option<Device>> {
    if bearer.len() != 64 || !bearer.iter().all(u8::is_ascii_hexdigit) {
        return Ok(None);
    }
    authenticate_hash(db, &Sha256::digest(bearer))
}

pub fn authenticate_hash(db: &Connection, hash: &[u8]) -> rusqlite::Result<Option<Device>> {
    db.query_row(
        "SELECT id,name,created_at,expires_at FROM device_sessions WHERE hash=? AND expires_at>?",
        params![hash, now()],
        device,
    )
    .optional()
}

#[cfg(all(test, feature = "noise-dev"))]
pub fn authenticate_noise_dev(
    db: &Connection,
    pin: &rothcold_noise_protocol::Key,
    credential: &rothcold_noise_protocol::Key,
) -> rusqlite::Result<Option<Device>> {
    authenticate_hash(db, &noise_dev_hash(pin, credential))
}

#[cfg(all(test, feature = "noise-dev"))]
pub fn provision_noise_dev(
    db: &Connection,
    pin: &rothcold_noise_protocol::Key,
    credential: &rothcold_noise_protocol::Key,
) -> rusqlite::Result<String> {
    let id = Uuid::new_v4().to_string();
    let created = now();
    db.execute(
        "INSERT INTO device_sessions(id,hash,name,created_at,expires_at) VALUES(?,?,?,?,?)",
        params![
            id,
            noise_dev_hash(pin, credential),
            "Noise dev fixture",
            created,
            created + LIFETIME
        ],
    )?;
    Ok(id)
}

#[cfg(all(test, feature = "noise-dev"))]
fn noise_dev_hash(
    pin: &rothcold_noise_protocol::Key,
    credential: &rothcold_noise_protocol::Key,
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"rothcold-agent/noise-dev/1/device\0");
    hasher.update(pin);
    hasher.update(credential);
    hasher.finalize().into()
}

pub fn issue(db: &mut Connection, hash: &[u8], name: &str) -> Result<Device> {
    let created_at = now();
    let device = Device {
        id: Uuid::new_v4().to_string(),
        name: name.to_string(),
        created_at,
        expires_at: created_at + LIFETIME,
    };
    let tx = db.transaction()?;
    tx.execute(
        "DELETE FROM device_sessions WHERE expires_at<=?",
        [created_at],
    )?;
    let inserted = tx.execute(
        "INSERT INTO device_sessions(id,hash,name,created_at,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(hash) DO NOTHING",
        params![device.id, hash, device.name, device.created_at, device.expires_at],
    )?;
    if inserted == 0 {
        return Err(crate::Error(
            S::CONFLICT,
            "This device credential is already registered",
        ));
    }
    tx.commit()?;
    Ok(device)
}

pub fn delete(app: &App, id: &str) -> rusqlite::Result<()> {
    lock(&app.db).execute("DELETE FROM device_sessions WHERE id=?", [id])?;
    Ok(())
}
