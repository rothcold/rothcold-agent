use rusqlite::{
    Connection, OptionalExtension, Params, Result as SqlResult, TransactionBehavior, params,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use uuid::Uuid;

pub(crate) mod archive;
pub(crate) mod inbox;
#[cfg(test)]
mod tests;

#[derive(Debug)]
pub enum Error {
    Missing,
    Conflict(&'static str),
    Sql(rusqlite::Error),
}
impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sql(e)
    }
}
pub type Result<T> = std::result::Result<T, Error>;

// Only TEXT, INTEGER and NULL columns are exposed by the fixed read queries.
pub(crate) fn rows(db: &Connection, sql: &str, args: impl Params) -> SqlResult<Vec<Value>> {
    use rusqlite::types::ValueRef;
    let mut stmt = db.prepare(sql)?;
    stmt.query_map(args, |r| {
        let mut obj = serde_json::Map::new();
        for (i, name) in r.as_ref().column_names().into_iter().enumerate() {
            let v = match r.get_ref(i)? {
                ValueRef::Integer(x) => json!(x),
                ValueRef::Null => Value::Null,
                _ => json!(r.get::<_, String>(i)?),
            };
            obj.insert(name.into(), v);
        }
        Ok(Value::Object(obj))
    })?
    .collect()
}

const INTERRUPT: &str = "UPDATE turns SET state='unknown' WHERE state IN ('reserved','accepted')";
pub fn init(db: &mut Connection) -> Result<()> {
    db.execute_batch("PRAGMA foreign_keys=ON")?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let version: i64 = tx.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version == 0 {
        tx.execute_batch("CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY,title TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY,chat TEXT NOT NULL REFERENCES chats(id),text TEXT NOT NULL,state TEXT NOT NULL,answer TEXT);
        CREATE INDEX IF NOT EXISTS turns_chat ON turns(chat);
        CREATE TABLE channels(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE COLLATE NOCASE);
        INSERT INTO channels VALUES('general','General');
        CREATE TABLE placement(chat TEXT PRIMARY KEY REFERENCES chats(id),channel TEXT NOT NULL REFERENCES channels(id));
        INSERT INTO placement SELECT id,'general' FROM chats;
        CREATE TABLE notifications(request TEXT PRIMARY KEY REFERENCES turns(id),unread INTEGER NOT NULL DEFAULT 1 CHECK(unread IN (0,1)));")?;
    }
    match version {
        0 | 1 => {
            tx.execute(INTERRUPT, [])?;
        }
        2..=7 => (),
        _ => return Err(Error::Conflict("Unsupported history database version")),
    }
    if version < 3 {
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS turn_updates(id TEXT PRIMARY KEY,turn TEXT NOT NULL REFERENCES turns(id),kind TEXT NOT NULL CHECK(kind IN ('progress','commentary')),text TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS turn_updates_turn ON turn_updates(turn);
            PRAGMA user_version=3;",
        )?;
    }
    if version < 4 {
        super::sessions::migrate(&tx)?;
    }
    if version < 5 {
        tx.execute_batch("CREATE TABLE attachments(id TEXT PRIMARY KEY,turn TEXT REFERENCES turns(id),purpose TEXT NOT NULL CHECK(purpose IN ('turn','avatar','backend_avatar')),filename TEXT NOT NULL,mime TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('image','video','audio','file')),size INTEGER NOT NULL,position INTEGER CHECK(position BETWEEN 0 AND 7));
            CREATE INDEX attachments_turn ON attachments(turn,position);
            CREATE TABLE identities(role TEXT PRIMARY KEY CHECK(role IN ('owner','agent')),name TEXT NOT NULL DEFAULT '',avatar TEXT REFERENCES attachments(id));
            CREATE TABLE backend_profiles(backend TEXT PRIMARY KEY,kind TEXT NOT NULL,name TEXT NOT NULL DEFAULT '',avatar TEXT REFERENCES attachments(id),updated_at INTEGER NOT NULL);
            ALTER TABLE placement ADD COLUMN original_channel TEXT REFERENCES channels(id);
            UPDATE placement SET original_channel=channel;
            PRAGMA user_version=5;")?;
    }
    if version < 6 {
        super::thread_titles::migrate(&tx)?;
        tx.pragma_update(None, "user_version", 6)?;
    }
    if version < 7 {
        archive::migrate(&tx)?;
        tx.pragma_update(None, "user_version", 7)?;
    }
    // Old clients queued slash replies without the prompt ID. Never deliver those after an upgrade.
    for row in rows(&tx, "SELECT id,text FROM turns WHERE state='queued'", [])? {
        if super::approvals::is_control(row["text"].as_str().ok_or(rusqlite::Error::InvalidQuery)?)
        {
            tx.execute("UPDATE turns SET state='answered',answer='Expired approval reply. Not sent to Hermes.' WHERE id=?", [row["id"].as_str()])?;
        }
    }
    tx.commit()?;
    Ok(())
}
pub fn interrupt(db: &Connection) -> Result<()> {
    db.execute(INTERRUPT, [])?;
    Ok(())
}
pub fn stop_waiting(db: &Connection, chat: &str, id: &str) -> Result<()> {
    if db.execute("UPDATE turns SET state='released' WHERE chat=? AND id=? AND state IN ('unknown','released')", [chat,id])? == 0 {
        return Err(Error::Conflict("This turn is not waiting for recovery. Refresh its status."));
    }
    Ok(())
}
pub fn claim(db: &mut Connection) -> Result<Value> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut turn=rows(&tx,"SELECT t.id,t.chat,t.text,chats.title FROM turns t JOIN chats ON chats.id=t.chat WHERE t.state='queued' AND NOT EXISTS (SELECT 1 FROM turns p WHERE p.chat=t.chat AND p.rowid<t.rowid AND p.state NOT IN ('answered','released')) ORDER BY t.rowid LIMIT 1",[])?.pop();
    if let Some(row) = &mut turn {
        add_attachments(&tx, row)?;
        tx.execute(
            "UPDATE turns SET state='reserved' WHERE id=?",
            [row["id"].as_str()],
        )?;
    }
    tx.commit()?;
    Ok(turn.unwrap_or(Value::Null))
}
pub fn admission(db: &Connection, id: &str, accepted: bool) -> Result<()> {
    db.execute(
        "UPDATE turns SET state=? WHERE id=? AND state='reserved'",
        [if accepted { "accepted" } else { "unknown" }, id],
    )?;
    Ok(())
}
pub fn record_update(
    db: &mut Connection,
    chat: &str,
    turn: Option<&str>,
    id: &str,
    kind: &str,
    text: &str,
) -> Result<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let turn_id: String = match turn {
        Some(tid) => {
            let state: Option<String> = tx
                .query_row(
                    "SELECT state FROM turns WHERE id=? AND chat=?",
                    [tid, chat],
                    |r| r.get(0),
                )
                .optional()?;
            if !matches!(state.as_deref(), Some("reserved" | "accepted")) {
                return Err(Error::Conflict("Turn is not active"));
            }
            tid.to_string()
        }
        None => tx
            .query_row(
                "SELECT id FROM turns WHERE chat=? AND state IN ('reserved','accepted') ORDER BY rowid DESC LIMIT 1",
                [chat],
                |r| r.get(0),
            )
            .optional()?
            .ok_or(Error::Conflict("Turn is not active"))?,
    };
    let existing: Option<(String, String)> = tx
        .query_row(
            "SELECT turn, kind FROM turn_updates WHERE id=?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((old_turn, old_kind)) = existing {
        if old_turn != turn_id || old_kind != kind {
            return Err(Error::Conflict("Update ID already used"));
        }
        tx.execute("UPDATE turn_updates SET text=? WHERE id=?", [text, id])?;
    } else {
        if count(
            &tx,
            "SELECT count(*) FROM turn_updates WHERE turn=?",
            [turn_id.as_str()],
        )? >= 256
        {
            return Err(Error::Conflict("Update limit reached"));
        }
        tx.execute(
            "INSERT INTO turn_updates(id,turn,kind,text) VALUES (?,?,?,?)",
            [id, turn_id.as_str(), kind, text],
        )?;
    }
    tx.commit()?;
    Ok(())
}
pub fn push(db: &mut Connection, chat: &str, id: &str, text: &str) -> Result<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    title(&tx, chat)?;
    let existing: Option<(String, String, String, Option<String>)> = tx
        .query_row(
            "SELECT chat,text,state,answer FROM turns WHERE id=?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    if let Some((old_chat, old_text, old_state, old_answer)) = existing {
        if old_chat != chat
            || !old_text.is_empty()
            || old_state != "answered"
            || old_answer.as_deref() != Some(text)
        {
            return Err(Error::Conflict("Push ID already used"));
        }
        tx.commit()?;
        return Ok(());
    }
    if count(
        &tx,
        "SELECT count(*) FROM turns WHERE chat=? AND state='unknown'",
        [chat],
    )? > 0
    {
        return Err(Error::Conflict("Thread has an unsettled turn"));
    }
    if count(&tx, "SELECT count(*) FROM turns WHERE chat=?", [chat])? >= 128 {
        return Err(Error::Conflict("Chat is full. Start a new chat."));
    }
    tx.execute(
        "INSERT INTO turns VALUES(?,?,'','answered',?)",
        params![id, chat, text],
    )?;
    inbox::record(&tx, id, text)?;
    tx.commit()?;
    Ok(())
}
pub fn finish(db: &mut Connection, chat: &str, id: &str, text: &str) -> Result<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let answer: Option<Option<String>> = tx
        .query_row(
            "SELECT answer FROM turns WHERE id=? AND chat=? AND state!='queued'",
            [id, chat],
            |r| r.get(0),
        )
        .optional()?;
    match answer {
        Some(None) => {
            tx.execute(
                "UPDATE turns SET answer=?,state=CASE WHEN state='released' THEN 'released' ELSE 'answered' END WHERE id=?",
                [text, id],
            )?;
            inbox::record(&tx, id, text)?;
        }
        Some(Some(old)) if old == text => (),
        _ => return Err(Error::Conflict("Unmatched final")),
    }
    tx.commit()?;
    Ok(())
}
pub fn rename(db: &mut Connection, chat: &str, title: &str) -> Result<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if tx.execute("UPDATE chats SET title=? WHERE id=?", [title, chat])? == 0 {
        return Err(Error::Missing);
    }
    super::thread_titles::cancel(&tx, chat)?;
    tx.commit()?;
    Ok(())
}
pub fn move_thread(db: &Connection, chat: &str, channel: &str) -> Result<()> {
    if db.execute("UPDATE placement SET channel=? WHERE chat=? AND EXISTS (SELECT 1 FROM chats WHERE id=chat AND archived=0) AND EXISTS (SELECT 1 FROM channels WHERE id=placement.channel AND archived=0) AND EXISTS (SELECT 1 FROM channels WHERE id=? AND archived=0)", [channel, chat, channel])? == 0 {
        archive::require_active_thread(db, chat)?;
        archive::require_active_category(db, channel)?;
        return Err(Error::Missing);
    }
    Ok(())
}
pub fn category(db: &mut Connection, name: &str) -> Result<Value> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if count(&tx, "SELECT count(*) FROM channels", [])? >= 128 {
        return Err(Error::Conflict("Category limit reached"));
    }
    let id = Uuid::new_v4().to_string();
    if tx.execute(
        "INSERT INTO channels(id,name) VALUES(?,?) ON CONFLICT(name) DO NOTHING",
        [&id, name],
    )? == 0
    {
        return Err(Error::Conflict("Category name already exists"));
    }
    tx.commit()?;
    Ok(json!({"id":id}))
}
fn title(db: &Connection, chat: &str) -> Result<String> {
    db.query_row("SELECT title FROM chats WHERE id=?", [chat], |r| r.get(0))
        .optional()?
        .ok_or(Error::Missing)
}
pub fn history(db: &Connection, chat: &str) -> Result<Value> {
    title(db, chat)?;
    let mut grouped: HashMap<String, Vec<Value>> = HashMap::new();
    let mut stmt = db.prepare(
        "SELECT u.turn,u.id,u.kind,u.text FROM turn_updates u JOIN turns t ON t.id=u.turn WHERE t.chat=? ORDER BY u.rowid",
    )?;
    for row in stmt.query_map([chat], |r| {
        Ok((
            r.get::<_, String>(0)?,
            json!({
                "id": r.get::<_, String>(1)?,
                "kind": r.get::<_, String>(2)?,
                "text": r.get::<_, String>(3)?,
            }),
        ))
    })? {
        let (turn_id, entry) = row?;
        grouped.entry(turn_id).or_default().push(entry);
    }
    let mut turns = rows(
        db,
        "SELECT id,text,state,answer FROM turns WHERE chat=? ORDER BY rowid",
        [chat],
    )?;
    for turn in &mut turns {
        add_attachments(db, turn)?;
        if let Some(obj) = turn.as_object_mut() {
            let tid = obj.get("id").and_then(Value::as_str).unwrap_or_default();
            let updates = grouped.remove(tid).unwrap_or_default();
            obj.insert("updates".into(), Value::Array(updates));
        }
    }
    Ok(turns.into())
}
fn turn_attachments(db: &Connection, id: &str) -> SqlResult<Vec<Value>> {
    rows(
        db,
        "SELECT id,filename,mime,kind,size FROM attachments WHERE turn=? ORDER BY position",
        [id],
    )
}
fn add_attachments(db: &Connection, turn: &mut Value) -> Result<()> {
    let attachments = turn_attachments(db, turn["id"].as_str().unwrap_or_default())?;
    if !attachments.is_empty() {
        turn["attachments"] = attachments.into();
    }
    Ok(())
}
pub fn mark_reply_read(db: &Connection, chat: &str, id: &str) -> Result<()> {
    db.execute("UPDATE notifications SET unread=0 WHERE unread=1 AND request=? AND EXISTS (SELECT 1 FROM turns WHERE id=request AND chat=?)", [id,chat])?;
    Ok(())
}
pub fn mark_read(db: &Connection, chat: &str) -> Result<()> {
    title(db, chat)?;
    db.execute("UPDATE notifications SET unread=0 WHERE unread=1 AND request IN (SELECT id FROM turns WHERE chat=?)",[chat])?;
    Ok(())
}
fn count(db: &Connection, sql: &str, args: impl Params) -> SqlResult<i64> {
    db.query_row(sql, args, |r| r.get(0))
}

// For a new thread, its first request UUID is also its chat UUID.
pub fn enqueue(
    db: &mut Connection,
    chat: &str,
    id: &str,
    text: &str,
    category: Option<&str>,
    attachments: &[&str],
) -> Result<(bool, Value)> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if category.is_none() {
        title(&tx, chat)?;
    }
    let old=tx.query_row("SELECT turns.chat,text,original_channel FROM turns JOIN placement ON placement.chat=turns.chat WHERE id=?",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?))).optional()?;
    let fresh = old.is_none();
    if let Some((old_chat, old_text, old_cat)) = old {
        let linked = turn_attachments(&tx, id)?;
        if old_chat != chat
            || old_text != text
            || category.is_some_and(|c| Some(c) != old_cat.as_deref())
            || linked.len() != attachments.len()
            || linked
                .iter()
                .zip(attachments)
                .any(|(a, id)| a["id"].as_str() != Some(*id))
        {
            return Err(Error::Conflict(
                "Request ID already used for different input",
            ));
        }
    } else {
        if let Some(cat) = category {
            if count(&tx, "SELECT count(*) FROM chats WHERE id=?", [chat])? > 0 {
                return Err(Error::Conflict("Thread ID already exists"));
            }
            if count(&tx, "SELECT count(*) FROM chats", [])? >= 128 {
                return Err(Error::Conflict("Chat limit reached"));
            }
            archive::require_active_category(&tx, cat)?;
            let first_filename = if text.trim().is_empty() {
                tx.query_row("SELECT filename FROM attachments WHERE id=? AND purpose='turn' AND turn IS NULL",
                    [attachments.first().ok_or(Error::Conflict("Expected a message or attachment"))?], |r| r.get::<_, String>(0))
                    .optional()?.ok_or(Error::Conflict("Attachment is not available for this turn"))?
            } else {
                String::new()
            };
            let source = if first_filename.is_empty() {
                text
            } else {
                &first_filename
            };
            let label: String = source
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(80)
                .collect();
            tx.execute(
                "INSERT INTO chats(id,title) VALUES(?,?)",
                [chat, label.trim_end()],
            )?;
            tx.execute(
                "INSERT INTO placement(chat,channel,original_channel) VALUES(?,?,?)",
                [chat, cat, cat],
            )?;
        } else {
            // Existing request IDs were checked above, independently of archive state.
            archive::require_active_thread(&tx, chat)?;
            if count(&tx, "SELECT count(*) FROM turns WHERE chat=?", [chat])? >= 128 {
                return Err(Error::Conflict("Chat is full. Start a new chat."));
            }
        }
        tx.execute(
            "INSERT INTO turns VALUES(?,?,?,'queued',NULL)",
            params![id, chat, text],
        )?;
        if category.is_some() && !text.trim().is_empty() {
            super::thread_titles::schedule(&tx, chat, id)?;
        }
        for (position, attachment) in attachments.iter().enumerate() {
            if tx.execute(
                "UPDATE attachments SET turn=?,position=? WHERE id=? AND purpose='turn' AND turn IS NULL",
                params![id, position, attachment],
            )? != 1
            {
                return Err(Error::Conflict("Attachment is not available for this turn"));
            }
        }
    }
    let receipt = match category {
        Some(_) => {
            let channel: String =
                tx.query_row("SELECT channel FROM placement WHERE chat=?", [chat], |r| {
                    r.get(0)
                })?;
            json!({"id":chat,"title":title(&tx,chat)?,"channel":channel})
        }
        None => json!({"id":id}),
    };
    tx.commit()?;
    Ok((fresh, receipt))
}
