use crate::{App, BAD, Error, Input, Result, attachments, lock, store::rows};
use axum::{Extension, Json, extract::State, http::StatusCode as S};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::watch;
use uuid::Uuid;

const LIVE: Duration = Duration::from_secs(3);
const WAIT: Duration = Duration::from_secs(3);
const NO_PROFILE: Error = Error(S::CONFLICT, "No profile is available for this backend yet");

#[derive(Default)]
pub struct ProfilePolls {
    backends: HashMap<String, Poll>,
    agent_edit_revision: u64,
}
type BackendIdentity = (String, Option<String>);
#[derive(Default)]
struct Poll {
    last: Option<Instant>,
    refresh: Option<Refresh>,
}
struct Refresh {
    id: Uuid,
    deadline: Instant,
    sent: bool,
    done: watch::Sender<Option<BackendIdentity>>,
}
impl ProfilePolls {
    fn active(&self) -> Option<String> {
        self.backends
            .iter()
            .filter(|(_, p)| p.last.is_some_and(|t| t.elapsed() <= LIVE))
            .max_by_key(|(id, p)| (p.last, *id))
            .map(|(id, _)| id.clone())
    }
    fn request(&mut self, id: &str) -> Option<(Instant, watch::Receiver<Option<BackendIdentity>>)> {
        let state = self.backends.get_mut(id)?;
        if state.last?.elapsed() > LIVE {
            return None;
        }
        if state
            .refresh
            .as_ref()
            .is_none_or(|r| r.deadline <= Instant::now())
        {
            state.refresh = Some(Refresh {
                id: Uuid::new_v4(),
                deadline: Instant::now() + WAIT,
                sent: false,
                done: watch::Sender::new(None),
            });
        }
        state
            .refresh
            .as_ref()
            .map(|r| (r.deadline, r.done.subscribe()))
    }
    pub fn claim(&mut self, id: &str, can_refresh: bool) -> Option<Uuid> {
        // A workspace has one live adapter. Drop stale identifiers to keep the mailbox bounded.
        self.backends.retain(|_, p| {
            p.last.is_some_and(|t| t.elapsed() <= LIVE)
                || p.refresh
                    .as_ref()
                    .is_some_and(|r| r.deadline > Instant::now())
        });
        let state = self.backends.entry(id.into()).or_default();
        state.last = Some(Instant::now());
        if let Some(r) = &mut state.refresh
            && can_refresh
            && !r.sent
            && r.deadline > Instant::now()
        {
            r.sent = true;
            return Some(r.id);
        }
        None
    }
    fn matches(&self, backend: &str, sync_id: Uuid) -> bool {
        self.backends
            .get(backend)
            .and_then(|p| p.refresh.as_ref())
            .is_some_and(|r| r.sent && r.id == sync_id && r.deadline > Instant::now())
    }
    fn complete(&mut self, backend: &str, sync_id: Uuid, profile: BackendIdentity) {
        if self.matches(backend, sync_id)
            && let Some(r) = self
                .backends
                .get_mut(backend)
                .and_then(|p| p.refresh.take())
        {
            r.done.send_replace(Some(profile));
        }
    }
}

pub fn backend_id(id: &str) -> Result<&str> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
    {
        return Err(BAD);
    }
    Ok(id)
}
fn name(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|n| n.chars().count() <= 80 && !n.chars().any(char::is_control))
        .ok_or(BAD)
}
fn avatar<'a>(db: &Connection, value: &'a Value, backend_only: bool) -> Result<Option<&'a str>> {
    if value.is_null() {
        return Ok(None);
    }
    let id = value.as_str().ok_or(BAD)?;
    if attachments::avatar_exists(db, id, backend_only)? {
        Ok(Some(id))
    } else {
        Err(Error(
            S::BAD_REQUEST,
            "Expected an existing avatar attachment",
        ))
    }
}

pub fn read(db: &Connection) -> Result<Value> {
    let identity = |role| -> rusqlite::Result<Value> {
        Ok(rows(
            db,
            "SELECT name,avatar FROM identities WHERE role=?",
            [role],
        )?
        .pop()
        .unwrap_or_else(|| json!({"name":"","avatar":null})))
    };
    Ok(
        json!({"owner":identity("owner")?,"agent":identity("agent")?,"backends":rows(db,
        "SELECT backend AS id,kind,name,avatar,updated_at FROM backend_profiles ORDER BY backend", [])?}),
    )
}
fn edit(db: &mut Connection, input: &Value) -> Result<Value> {
    let tx = db.transaction()?;
    for role in ["owner", "agent"] {
        let Some(value) = input.get(role) else {
            continue;
        };
        if !value.is_object() {
            return Err(BAD);
        }
        if let Some(value) = value.get("name") {
            tx.execute("INSERT INTO identities(role,name) VALUES(?,?) ON CONFLICT(role) DO UPDATE SET name=excluded.name", params![role, name(value)?])?;
        }
        if let Some(value) = value.get("avatar") {
            tx.execute("INSERT INTO identities(role,avatar) VALUES(?,?) ON CONFLICT(role) DO UPDATE SET avatar=excluded.avatar", params![role, avatar(&tx, value, false)?])?;
        }
    }
    let profile = read(&tx)?;
    tx.commit()?;
    Ok(profile)
}
fn publish(
    db: &mut Connection,
    backend: &str,
    kind: &str,
    name: &str,
    avatar_value: &Value,
    passive: bool,
) -> Result<BackendIdentity> {
    let tx = db.transaction()?;
    let avatar = avatar(&tx, avatar_value, true)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    tx.execute("INSERT INTO backend_profiles VALUES(?,?,?,?,?) ON CONFLICT(backend) DO UPDATE SET kind=excluded.kind,name=excluded.name,avatar=excluded.avatar,updated_at=excluded.updated_at", params![backend, kind, name, avatar, stamp])?;
    if passive {
        apply(&tx, name, avatar, false)?;
    }
    tx.commit()?;
    Ok((name.into(), avatar.map(str::to_owned)))
}
fn apply(db: &Connection, name: &str, avatar: Option<&str>, overwrite: bool) -> Result<()> {
    db.execute("INSERT INTO identities(role,name,avatar) VALUES('agent',?,?) ON CONFLICT(role) DO UPDATE SET
        name=CASE WHEN excluded.name!='' AND (? OR identities.name='') THEN excluded.name ELSE identities.name END,
        avatar=CASE WHEN excluded.avatar IS NOT NULL AND (? OR identities.avatar IS NULL) THEN excluded.avatar ELSE identities.avatar END",
        params![name, avatar, overwrite, overwrite])?;
    Ok(())
}
fn sync_profile(
    db: &mut Connection,
    backend: &str,
    refresh: &str,
    snapshot: Option<BackendIdentity>,
) -> Result<Value> {
    let tx = db.transaction()?;
    let (name, avatar) = match snapshot {
        Some(profile) => profile,
        None => tx
            .query_row(
                "SELECT name,avatar FROM backend_profiles WHERE backend=?",
                [backend],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or(NO_PROFILE)?,
    };
    apply(&tx, &name, avatar.as_deref(), true)?;
    let mut profile = read(&tx)?;
    profile["sync"] = json!({"backend":backend,"refresh":refresh,"name":!name.is_empty(),"avatar":avatar.is_some()});
    tx.commit()?;
    Ok(profile)
}

pub async fn get(State(app): State<App>) -> Result<Json<Value>> {
    Ok(Json(read(&lock(&app.db))?))
}
pub async fn update(State(app): State<App>, Extension(data): Input) -> Result<Json<Value>> {
    // Serialize manual writes and the revision check at sync apply time.
    let mut polls = lock(&app.profiles);
    let profile = edit(&mut lock(&app.db), &data)?;
    if data["agent"].get("name").is_some() || data["agent"].get("avatar").is_some() {
        polls.agent_edit_revision += 1;
    }
    Ok(Json(profile))
}
pub async fn report(State(app): State<App>, Extension(data): Input) -> Result<Json<Value>> {
    let backend = backend_id(data["backend"].as_str().ok_or(BAD)?)?;
    let kind = backend_id(data["kind"].as_str().ok_or(BAD)?)?;
    let sync_id = data
        .get("sync_id")
        .map(|value| {
            let id = value.as_str().ok_or(BAD)?;
            crate::request_id(id)?;
            Uuid::parse_str(id).map_err(|_| BAD)
        })
        .transpose()?;
    let mut polls = lock(&app.profiles);
    if sync_id.is_some_and(|id| !polls.matches(backend, id)) {
        return Err(Error(S::CONFLICT, "Profile refresh expired"));
    }
    let snapshot = publish(
        &mut lock(&app.db),
        backend,
        kind,
        name(&data["name"])?,
        &data["avatar"],
        sync_id.is_none(),
    )?;
    if let Some(id) = sync_id {
        polls.complete(backend, id, snapshot);
    }
    Ok(Json(json!({})))
}
pub async fn sync(State(app): State<App>, Extension(data): Input) -> Result<Json<Value>> {
    let (backend, request, revision) = {
        let mut mailbox = lock(&app.profiles);
        let backend = if let Some(id) = data.get("backend") {
            backend_id(id.as_str().ok_or(BAD)?)?.into()
        } else if let Some(id) = mailbox.active() {
            id
        } else {
            lock(&app.db)
                .query_row(
                    "SELECT backend FROM backend_profiles ORDER BY updated_at DESC,backend LIMIT 1",
                    [],
                    |r| r.get(0),
                )
                .optional()?
                .ok_or(NO_PROFILE)?
        };
        let request = mailbox.request(&backend);
        (backend, request, mailbox.agent_edit_revision)
    };
    let (refresh, snapshot) = match request {
        Some((deadline, mut done)) => {
            match tokio::time::timeout_at(deadline.into(), done.wait_for(Option::is_some)).await {
                Ok(Ok(snapshot)) => ("refreshed", snapshot.clone()),
                _ => ("timed_out", None),
            }
        }
        None => ("offline", None),
    };
    let polls = lock(&app.profiles);
    if polls.agent_edit_revision != revision {
        return Err(Error(
            S::CONFLICT,
            "Agent profile was edited during sync. The manual edit was kept.",
        ));
    }
    Ok(Json(sync_profile(
        &mut lock(&app.db),
        &backend,
        refresh,
        snapshot,
    )?))
}

#[cfg(test)]
mod tests;
