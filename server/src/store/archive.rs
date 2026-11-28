#[cfg(test)]
use super::rows;
use super::{Error, Result, inbox};
use rusqlite::{Connection, OptionalExtension, params};
#[cfg(test)]
use serde_json::{Value, json};

pub(super) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch("ALTER TABLE channels ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1));
        ALTER TABLE chats ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1));
        ALTER TABLE notifications ADD COLUMN preview TEXT NOT NULL DEFAULT '';")?;
    inbox::backfill_previews(db)
}

pub(crate) const CHAT_DIRECTORY: &str = "FROM chats JOIN placement ON placement.chat=chats.id JOIN channels ON channels.id=placement.channel";
#[cfg(test)]
const DIRECTORY_CHANNELS: &str = "SELECT id,name,archived FROM channels ORDER BY rowid";
#[cfg(test)]
fn directory_chats_query() -> String {
    format!(
        "SELECT chats.id,title,channel,chats.archived {CHAT_DIRECTORY} ORDER BY chats.rowid DESC"
    )
}

#[cfg(test)]
pub(crate) fn active_chats(db: &Connection) -> Result<Value> {
    Ok(rows(db, &format!("SELECT chats.id,title,channel {CHAT_DIRECTORY} WHERE chats.archived=0 AND channels.archived=0 ORDER BY chats.rowid DESC"), [])?.into())
}

#[cfg(test)]
pub(crate) fn directory(db: &Connection) -> Result<Value> {
    Ok(json!({
        "channels": rows(db, DIRECTORY_CHANNELS, [])?,
        "chats": rows(db, &directory_chats_query(), [])?,
    }))
}

#[cfg(all(test, feature = "noise-dev"))]
pub(crate) fn bounded_directory(db: &Connection, limit: usize) -> Result<Option<Value>> {
    use rusqlite::types::ValueRef;
    use std::io::{self, Write};

    struct Budget {
        bytes: Vec<u8>,
        limit: usize,
    }
    impl Write for Budget {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if bytes.len() > self.limit - self.bytes.len() {
                return Err(io::Error::other("Directory exceeds record budget"));
            }
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    // Stop before materializing the full result or copying a legacy oversized field.
    fn list(db: &Connection, sql: &str, out: &mut Budget) -> Result<bool> {
        let mut statement = db.prepare(sql)?;
        let mut rows = statement.query([])?;
        let mut first = true;
        while let Some(row) = rows.next()? {
            for i in 0..row.as_ref().column_count() {
                if let ValueRef::Text(bytes) = row.get_ref(i)?
                    && bytes.len() > out.limit - out.bytes.len()
                {
                    return Ok(false);
                }
            }
            if (!first && out.write_all(b",").is_err())
                || serde_json::to_writer(&mut *out, &super::json_row(row)?).is_err()
            {
                return Ok(false);
            }
            first = false;
        }
        Ok(true)
    }

    let mut out = Budget {
        bytes: Vec::new(),
        limit,
    };
    if out.write_all(br#"{"channels":["#).is_err()
        || !list(db, DIRECTORY_CHANNELS, &mut out)?
        || out.write_all(br#"],"chats":["#).is_err()
        || !list(db, &directory_chats_query(), &mut out)?
        || out.write_all(b"]}").is_err()
    {
        return Ok(None);
    }
    Ok(Some(
        serde_json::from_slice(&out.bytes).expect("serialized directory"),
    ))
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
