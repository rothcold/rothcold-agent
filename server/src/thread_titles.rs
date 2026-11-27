use axum::{Extension, Json, extract::State};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{App, BAD, Input, Result, field, lock, request_id, store};

pub fn migrate(db: &Connection) -> store::Result<()> {
    db.execute_batch(
        "CREATE TABLE thread_title_jobs (
            chat TEXT PRIMARY KEY REFERENCES chats(id),
            opener TEXT NOT NULL REFERENCES turns(id),
            claim TEXT UNIQUE,
            expires INTEGER
        );",
    )?;
    Ok(())
}

pub fn schedule(db: &Connection, chat: &str, opener: &str) -> store::Result<()> {
    db.execute(
        "INSERT INTO thread_title_jobs(chat,opener) VALUES(?,?)",
        [chat, opener],
    )?;
    Ok(())
}

pub fn cancel(db: &Connection, chat: &str) -> store::Result<()> {
    db.execute("DELETE FROM thread_title_jobs WHERE chat=?", [chat])?;
    Ok(())
}

fn claim_job(db: &mut Connection) -> store::Result<Value> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    // A lost title attempt is harmless. Never retry an uncertain model request.
    tx.execute(
        "DELETE FROM thread_title_jobs WHERE expires <= CAST(strftime('%s','now') AS INTEGER)",
        [],
    )?;
    let opener: Option<(String, String)> = tx
        .query_row(
            "SELECT j.chat,t.text FROM thread_title_jobs j JOIN turns t ON t.id=j.opener
             WHERE j.claim IS NULL ORDER BY j.rowid LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let job = if let Some((chat, text)) = opener {
        let claim = Uuid::new_v4().to_string();
        tx.execute(
            "UPDATE thread_title_jobs SET claim=?,expires=CAST(strftime('%s','now') AS INTEGER)+20 WHERE chat=?",
            [&claim, &chat],
        )?;
        json!({"claim":claim,"text":text})
    } else {
        Value::Null
    };
    tx.commit()?;
    Ok(job)
}

fn finish_job(db: &mut Connection, claim: &str, title: Option<&str>) -> store::Result<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(title) = title {
        tx.execute(
            "UPDATE chats SET title=? WHERE id=(
                SELECT chat FROM thread_title_jobs WHERE claim=? AND expires > CAST(strftime('%s','now') AS INTEGER)
            )",
            params![title, claim],
        )?;
    }
    tx.execute("DELETE FROM thread_title_jobs WHERE claim=?", [claim])?;
    tx.commit()?;
    Ok(())
}

pub async fn claim(State(a): State<App>) -> Result<Json<Value>> {
    Ok(Json(claim_job(&mut lock(&a.db))?))
}

pub async fn finish(State(a): State<App>, Extension(v): Input) -> Result<Json<Value>> {
    let claim = field(&v, "claim", 36)?;
    request_id(claim)?;
    let title = match v.get("title") {
        Some(Value::Null) => None,
        Some(Value::String(_)) => {
            let title = field(&v, "title", 80)?;
            if title
                .chars()
                .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}'))
            {
                return Err(BAD);
            }
            Some(title.trim())
        }
        _ => return Err(BAD),
    };
    finish_job(&mut lock(&a.db), claim, title)?;
    Ok(Json(json!({})))
}

#[cfg(test)]
mod tests;
