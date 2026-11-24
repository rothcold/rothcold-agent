use rusqlite::{
    Connection, OptionalExtension, Params, Result as SqlResult, TransactionBehavior, params,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use uuid::Uuid;

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
fn rows(db: &Connection, sql: &str, args: impl Params) -> SqlResult<Vec<Value>> {
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
        2 | 3 => (),
        _ => return Err(Error::Conflict("Unsupported history database version")),
    }
    if version < 3 {
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS turn_updates(id TEXT PRIMARY KEY,turn TEXT NOT NULL REFERENCES turns(id),kind TEXT NOT NULL CHECK(kind IN ('progress','commentary')),text TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS turn_updates_turn ON turn_updates(turn);
            PRAGMA user_version=3;",
        )?;
    }
    tx.commit()?;
    Ok(())
}
pub fn interrupt(db: &Connection) -> Result<()> {
    db.execute(INTERRUPT, [])?;
    Ok(())
}
pub fn claim(db: &mut Connection) -> Result<Value> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let turn=rows(&tx,"SELECT t.id,t.chat,t.text,chats.title FROM turns t JOIN chats ON chats.id=t.chat WHERE t.state='queued' AND NOT EXISTS (SELECT 1 FROM turns p WHERE p.chat=t.chat AND p.rowid<t.rowid AND p.state!='answered') ORDER BY t.rowid LIMIT 1",[])?.pop();
    if let Some(row) = &turn {
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
    tx.execute("INSERT INTO notifications(request) VALUES (?)", [id])?;
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
                "UPDATE turns SET answer=?,state='answered' WHERE id=?",
                [text, id],
            )?;
            tx.execute("INSERT INTO notifications(request) VALUES (?)", [id])?;
        }
        Some(Some(old)) if old == text => (),
        _ => return Err(Error::Conflict("Unmatched final")),
    }
    tx.commit()?;
    Ok(())
}
pub fn chats(db: &Connection) -> Result<Value> {
    Ok(rows(db,"SELECT id,title,channel FROM chats JOIN placement ON placement.chat=chats.id ORDER BY chats.rowid DESC",[])?.into())
}
pub fn rename(db: &Connection, chat: &str, title: &str) -> Result<()> {
    if db.execute("UPDATE chats SET title=? WHERE id=?", [title, chat])? == 0 {
        return Err(Error::Missing);
    }
    Ok(())
}
pub fn channels(db: &Connection) -> Result<Value> {
    Ok(rows(db, "SELECT id,name FROM channels ORDER BY rowid", [])?.into())
}
pub fn category(db: &mut Connection, name: &str) -> Result<Value> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if count(&tx, "SELECT count(*) FROM channels", [])? >= 128 {
        return Err(Error::Conflict("Category limit reached"));
    }
    let id = Uuid::new_v4().to_string();
    if tx.execute(
        "INSERT INTO channels VALUES(?,?) ON CONFLICT(name) DO NOTHING",
        [&id, name],
    )? == 0
    {
        return Err(Error::Conflict("Category name already exists"));
    }
    tx.commit()?;
    Ok(json!({"id":id}))
}
pub fn notifications(db: &Connection) -> Result<Value> {
    Ok(rows(db,"SELECT request,turns.chat,placement.channel,unread FROM notifications JOIN turns ON turns.id=request JOIN placement ON placement.chat=turns.chat ORDER BY notifications.rowid DESC",[])?.into())
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
        if let Some(obj) = turn.as_object_mut() {
            let tid = obj.get("id").and_then(Value::as_str).unwrap_or_default();
            let updates = grouped.remove(tid).unwrap_or_default();
            obj.insert("updates".into(), Value::Array(updates));
        }
    }
    Ok(turns.into())
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
) -> Result<(bool, Value)> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if category.is_none() {
        title(&tx, chat)?;
    }
    let old=tx.query_row("SELECT turns.chat,text,channel FROM turns JOIN placement ON placement.chat=turns.chat WHERE id=?",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).optional()?;
    let fresh = old.is_none();
    if let Some((old_chat, old_text, old_cat)) = old {
        if old_chat != chat || old_text != text || category.is_some_and(|c| c != old_cat) {
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
            if count(&tx, "SELECT count(*) FROM channels WHERE id=?", [cat])? == 0 {
                return Err(Error::Missing);
            }
            let label: String = text
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(80)
                .collect();
            tx.execute("INSERT INTO chats VALUES(?,?)", [chat, label.trim_end()])?;
            tx.execute("INSERT INTO placement VALUES(?,?)", [chat, cat])?;
        } else if count(&tx, "SELECT count(*) FROM turns WHERE chat=?", [chat])? >= 128 {
            return Err(Error::Conflict("Chat is full. Start a new chat."));
        }
        tx.execute(
            "INSERT INTO turns VALUES(?,?,?,'queued',NULL)",
            params![id, chat, text],
        )?;
    }
    let receipt = match category {
        Some(cat) => json!({"id":chat,"title":title(&tx,chat)?,"channel":cat}),
        None => json!({"id":id}),
    };
    tx.commit()?;
    Ok((fresh, receipt))
}
