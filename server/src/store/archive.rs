use super::{Error, Result, inbox, rows};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

pub(super) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch("ALTER TABLE channels ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1));
        ALTER TABLE chats ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1));
        ALTER TABLE notifications ADD COLUMN preview TEXT NOT NULL DEFAULT '';")?;
    inbox::backfill_previews(db)?;
    db.execute_batch("PRAGMA user_version=6;")?;
    Ok(())
}

const CHAT_DIRECTORY: &str = "FROM chats JOIN placement ON placement.chat=chats.id JOIN channels ON channels.id=placement.channel";

pub(crate) fn active_chats(db: &Connection) -> Result<Value> {
    Ok(rows(db, &format!("SELECT chats.id,title,channel {CHAT_DIRECTORY} WHERE chats.archived=0 AND channels.archived=0 ORDER BY chats.rowid DESC"), [])?.into())
}

pub(crate) fn active_channels(db: &Connection) -> Result<Value> {
    Ok(rows(
        db,
        "SELECT id,name FROM channels WHERE archived=0 ORDER BY rowid",
        [],
    )?
    .into())
}

pub(crate) fn directory(db: &Connection) -> Result<Value> {
    Ok(json!({
        "channels": rows(db, "SELECT id,name,archived FROM channels ORDER BY rowid", [])?,
        "chats": rows(db, &format!("SELECT chats.id,title,channel,chats.archived {CHAT_DIRECTORY} ORDER BY chats.rowid DESC"), [])?,
    }))
}

pub(crate) fn rename_category(db: &Connection, id: &str, name: &str) -> Result<()> {
    let updated = db.execute("UPDATE channels SET name=? WHERE id=? AND NOT EXISTS (SELECT 1 FROM channels WHERE id!=? AND name=?)", params![name, id, id, name])?;
    if updated == 0 {
        category_archived(db, id)?;
        return Err(Error::Conflict("Category name already exists"));
    }
    Ok(())
}

pub(crate) fn set_category_archived(db: &Connection, id: &str, archived: bool) -> Result<()> {
    if id == "general" && archived {
        return Err(Error::Conflict("General cannot be archived"));
    }
    if db.execute(
        "UPDATE channels SET archived=? WHERE id=?",
        params![archived, id],
    )? == 0
    {
        return Err(Error::Missing);
    }
    Ok(())
}

pub(crate) fn set_thread_archived(db: &Connection, id: &str, archived: bool) -> Result<()> {
    if db.execute(
        "UPDATE chats SET archived=? WHERE id=?",
        params![archived, id],
    )? == 0
    {
        return Err(Error::Missing);
    }
    Ok(())
}

fn category_archived(db: &Connection, id: &str) -> Result<bool> {
    db.query_row("SELECT archived FROM channels WHERE id=?", [id], |r| {
        r.get(0)
    })
    .optional()?
    .ok_or(Error::Missing)
}

pub(super) fn require_active_category(db: &Connection, id: &str) -> Result<()> {
    if category_archived(db, id)? {
        return Err(Error::Conflict(
            "Restore the category before adding messages.",
        ));
    }
    Ok(())
}

pub(super) fn require_active_thread(db: &Connection, id: &str) -> Result<()> {
    let archived: Option<(bool, bool)> = db
        .query_row(
            &format!("SELECT chats.archived,channels.archived {CHAT_DIRECTORY} WHERE chats.id=?"),
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match archived {
        Some((false, false)) => Ok(()),
        Some((_, true)) => Err(Error::Conflict(
            "Restore the category before adding messages.",
        )),
        Some((true, false)) => Err(Error::Conflict(
            "Restore the thread before adding messages.",
        )),
        None => Err(Error::Missing),
    }
}
