use super::auth::{Authorization, authorize};
use crate::{App, BAD, Error, Result, S, approvals, lock, profiles, request_id, sessions, store};
use rothcold_noise_protocol::v1::{
    self, ApprovalChoice, AvatarPatch, IdentityPatch, Message, Outcome, Page, Request,
};
use rusqlite::{Connection, OptionalExtension, Params, Row, params};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn decode<T: DeserializeOwned>(data: Value) -> Result<T> {
    serde_json::from_value(data)
        .map_err(|_| Error(S::INTERNAL_SERVER_ERROR, "Invalid workspace record"))
}

fn page<T>(
    db: &Connection,
    sql: &str,
    args: impl Params,
    limit: usize,
    map: impl Fn(&Row<'_>) -> Result<T>,
) -> Result<Page<T>> {
    let mut stmt = db.prepare(sql)?;
    let mut rows = stmt.query(args)?;
    let mut items = Vec::with_capacity(limit);
    let mut cursor = None;
    while let Some(row) = rows.next()? {
        if limit == items.len() {
            return Ok(Page {
                items,
                next: cursor,
            });
        }
        let id = row.get(0)?;
        items.push(map(row)?);
        cursor = Some(v1::Cursor::from_rowid(id));
    }
    Ok(Page { items, next: None })
}

fn categories(db: &Connection, all: bool, after: Option<v1::Cursor>) -> Result<Page<v1::Category>> {
    page(
        db,
        "SELECT rowid,id,name,archived FROM channels WHERE (?1 IS NULL OR rowid>?1) AND (?2 OR archived=0) ORDER BY rowid LIMIT 17",
        params![after.map(v1::Cursor::rowid), all],
        16,
        |r| {
            Ok(v1::Category {
                id: r.get(1)?,
                name: r.get(2)?,
                archived: r.get(3)?,
            })
        },
    )
}

fn threads(db: &Connection, all: bool, after: Option<v1::Cursor>) -> Result<Page<v1::Thread>> {
    page(
        db,
        &format!(
            "SELECT chats.rowid,chats.id,title,channel,chats.archived {} WHERE (?1 IS NULL OR chats.rowid<?1) AND (?2 OR (chats.archived=0 AND channels.archived=0)) ORDER BY chats.rowid DESC LIMIT 17",
            store::archive::CHAT_DIRECTORY
        ),
        params![after.map(v1::Cursor::rowid), all],
        16,
        |r| {
            Ok(v1::Thread {
                id: r.get(1)?,
                title: r.get(2)?,
                channel: r.get(3)?,
                archived: r.get(4)?,
            })
        },
    )
}

fn history(db: &Connection, chat: &str, after: Option<v1::Cursor>) -> Result<Page<v1::Turn>> {
    store::title(db, chat)?;
    page(
        db,
        "SELECT rowid,id,text,state,answer FROM turns WHERE chat=?1 AND (?2 IS NULL OR rowid>?2) ORDER BY rowid LIMIT 2",
        params![chat, after.map(v1::Cursor::rowid)],
        1,
        |r| {
            let id: String = r.get(1)?;
            let state: String = r.get(3)?;
            Ok(v1::Turn {
                attachments: decode(Value::Array(store::turn_attachments(db, &id)?))?,
                id,
                text: r.get(2)?,
                state: decode(json!(state))?,
                answer: r.get(4)?,
            })
        },
    )
}

fn updates(
    db: &Connection,
    approvals: &approvals::Mailbox,
    chat: &str,
    turn: &str,
    after: Option<v1::Cursor>,
) -> Result<Page<v1::TurnUpdate>> {
    let active: bool = db
        .query_row(
            "SELECT state IN ('reserved','accepted') FROM turns WHERE chat=? AND id=?",
            [chat, turn],
            |r| r.get(0),
        )
        .optional()?
        .ok_or(store::Error::Missing)?;
    page(
        db,
        "SELECT rowid,id,kind,text FROM turn_updates WHERE turn=?1 AND (?2 IS NULL OR rowid>?2) ORDER BY rowid LIMIT 2",
        params![turn, after.map(v1::Cursor::rowid)],
        1,
        |r| {
            let id: String = r.get(1)?;
            let kind: String = r.get(2)?;
            let choices = if active {
                approvals
                    .card(chat, &id)
                    .into_iter()
                    .flat_map(|card| &card.choices)
                    .filter_map(|choice| match choice.as_str() {
                        "once" => Some(ApprovalChoice::Once),
                        "session" => Some(ApprovalChoice::Session),
                        "deny" => Some(ApprovalChoice::Deny),
                        _ => None,
                    })
                    .collect()
            } else {
                Vec::new()
            };
            Ok(v1::TurnUpdate {
                id,
                kind: decode(json!(kind))?,
                text: r.get(3)?,
                choices,
            })
        },
    )
}

fn inbox(db: &Connection, after: Option<v1::Cursor>) -> Result<Page<v1::Notification>> {
    page(
        db,
        "SELECT n.rowid,n.request,t.chat,p.channel,n.unread,c.title,n.preview FROM notifications n JOIN turns t ON t.id=n.request JOIN chats c ON c.id=t.chat JOIN placement p ON p.chat=t.chat WHERE (?1 IS NULL OR n.rowid<?1) ORDER BY n.rowid DESC LIMIT 17",
        [after.map(v1::Cursor::rowid)],
        16,
        |r| {
            Ok(v1::Notification {
                request: r.get(1)?,
                chat: r.get(2)?,
                channel: r.get(3)?,
                unread: r.get(4)?,
                title: r.get(5)?,
                preview: r.get(6)?,
            })
        },
    )
}

fn short_label(label: &str) -> Result<&str> {
    if label.chars().count() > 80 {
        return Err(BAD);
    }
    let label = label.trim();
    if label.is_empty() || label.chars().any(char::is_control) {
        return Err(BAD);
    }
    Ok(label)
}

fn workspace_id(id: &str) -> Result<&str> {
    // Upgraded workspaces can predate v4 UUID generation.
    if id.is_empty()
        || id.len() > 36
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
    {
        return Err(BAD);
    }
    Ok(id)
}

fn message(msg: &Message) -> Result<Vec<&str>> {
    request_id(&msg.id)?;
    if msg.attachments.len() > 8
        || msg.text.chars().count() > 8000
        || (msg.attachments.is_empty() && msg.text.trim().is_empty())
    {
        return Err(BAD);
    }
    if approvals::is_control(&msg.text) {
        return Err(Error(
            S::CONFLICT,
            "Approvals require a typed decision on a live prompt.",
        ));
    }
    let mut ids = Vec::with_capacity(msg.attachments.len());
    for id in &msg.attachments {
        request_id(id)?;
        if ids.contains(&id.as_str()) {
            return Err(BAD);
        }
        ids.push(id.as_str());
    }
    Ok(ids)
}

fn patch(profile: &mut Value, role: &str, patch: Option<IdentityPatch>) {
    if let Some(patch) = patch {
        let mut obj = json!({});
        if let Some(name) = patch.name {
            obj["name"] = json!(name);
        }
        if let Some(avatar) = patch.avatar {
            obj["avatar"] = match avatar {
                AvatarPatch::Clear => Value::Null,
                AvatarPatch::Set { id } => json!(id),
            };
        }
        profile[role] = obj;
    }
}

pub async fn execute(app: &App, hash: &Authorization, request: Request) -> Result<Outcome> {
    let device = authorize(&lock(&app.db), hash)?;
    Ok(match request {
        Request::Me => Outcome::Device { device },
        Request::Logout => {
            sessions::delete(app, &device.id)?;
            Outcome::Ok
        }
        Request::Devices { after } => Outcome::Devices {
            current: device.id,
            page: page(
                &lock(&app.db),
                "SELECT rowid,id,name,created_at,expires_at FROM device_sessions WHERE expires_at>?1 AND (?2 IS NULL OR rowid<?2) ORDER BY rowid DESC LIMIT 17",
                params![sessions::now(), after.map(v1::Cursor::rowid)],
                16,
                |r| {
                    Ok(v1::Device {
                        id: r.get(1)?,
                        name: r.get(2)?,
                        created_at: r.get(3)?,
                        expires_at: r.get(4)?,
                    })
                },
            )?,
        },
        Request::RevokeDevice { id } => {
            request_id(&id)?;
            sessions::delete(app, &id)?;
            Outcome::Revoked {
                current: device.id == id,
            }
        }
        Request::Profile => Outcome::Profile {
            profile: decode(profiles::snapshot(&lock(&app.db))?)?,
        },
        Request::ProfileBackends { after } => Outcome::ProfileBackends {
            page: page(
                &lock(&app.db),
                "SELECT rowid,backend,kind,name,avatar,updated_at FROM backend_profiles WHERE (?1 IS NULL OR rowid>?1) ORDER BY rowid LIMIT 17",
                [after.map(v1::Cursor::rowid)],
                16,
                |r| {
                    Ok(v1::BackendProfile {
                        id: r.get(1)?,
                        kind: r.get(2)?,
                        name: r.get(3)?,
                        avatar: r.get(4)?,
                        updated_at: r.get(5)?,
                    })
                },
            )?,
        },
        Request::UpdateProfile { owner, agent } => {
            let mut input = json!({});
            patch(&mut input, "owner", owner);
            patch(&mut input, "agent", agent);
            Outcome::Profile {
                profile: decode(profiles::update_profile(app, &input)?)?,
            }
        }
        Request::SyncProfile { backend } => Outcome::Profile {
            profile: decode(
                profiles::sync_selected(app, backend.as_deref(), |db| {
                    authorize(db, hash).map(|_| ())
                })
                .await?,
            )?,
        },
        Request::SlashCatalog => Outcome::SlashCatalog {
            catalog: decode(
                lock(&app.slash_catalog).response(std::time::Instant::now())["catalog"].clone(),
            )?,
        },
        Request::Categories {
            include_archived,
            after,
        } => Outcome::Categories {
            page: categories(&lock(&app.db), include_archived, after)?,
        },
        Request::Threads {
            include_archived,
            after,
        } => Outcome::Threads {
            page: threads(&lock(&app.db), include_archived, after)?,
        },
        Request::CreateCategory { name } => {
            let item = store::category(&mut lock(&app.db), short_label(&name)?)?;
            Outcome::CategoryCreated {
                id: decode(item["id"].clone())?,
            }
        }
        Request::RenameCategory { id, name } => {
            let name = short_label(&name)?;
            store::archive::rename_category(&lock(&app.db), workspace_id(&id)?, name)?;
            Outcome::CategoryRenamed { name: name.into() }
        }
        Request::ArchiveCategory { id, archived } => {
            store::archive::set_category_archived(&lock(&app.db), workspace_id(&id)?, archived)?;
            Outcome::Archived { archived }
        }
        Request::StartThread {
            channel: cat,
            message: msg,
        } => {
            let attachments = message(&msg)?;
            let (fresh, item) = store::enqueue(
                &mut lock(&app.db),
                &msg.id,
                &msg.id,
                &msg.text,
                Some(workspace_id(&cat)?),
                &attachments,
            )?;
            Outcome::ThreadStarted {
                id: decode(item["id"].clone())?,
                channel: decode(item["channel"].clone())?,
                title: decode(item["title"].clone())?,
                fresh,
            }
        }
        Request::RenameThread { id, title } => {
            let title = short_label(&title)?;
            store::rename(&mut lock(&app.db), workspace_id(&id)?, title)?;
            Outcome::ThreadRenamed {
                title: title.into(),
            }
        }
        Request::MoveThread { id, channel: cat } => {
            store::move_thread(&lock(&app.db), workspace_id(&id)?, workspace_id(&cat)?)?;
            Outcome::ThreadMoved { id, channel: cat }
        }
        Request::ArchiveThread { id, archived } => {
            store::archive::set_thread_archived(&lock(&app.db), workspace_id(&id)?, archived)?;
            Outcome::Archived { archived }
        }
        Request::History { chat, after } => Outcome::History {
            page: history(&lock(&app.db), workspace_id(&chat)?, after)?,
        },
        Request::TurnUpdates { chat, turn, after } => Outcome::TurnUpdates {
            page: updates(
                &lock(&app.db),
                &lock(&app.approvals),
                workspace_id(&chat)?,
                workspace_id(&turn)?,
                after,
            )?,
        },
        Request::SendTurn { chat, message: msg } => {
            let attachments = message(&msg)?;
            let (fresh, _) = store::enqueue(
                &mut lock(&app.db),
                workspace_id(&chat)?,
                &msg.id,
                &msg.text,
                None,
                &attachments,
            )?;
            Outcome::TurnSent { id: msg.id, fresh }
        }
        Request::ReleaseTurn { chat, id } => {
            store::stop_waiting(&lock(&app.db), workspace_id(&chat)?, workspace_id(&id)?)?;
            Outcome::Ok
        }
        Request::DecideApproval { chat, id, choice } => {
            let choice = match choice {
                ApprovalChoice::Once => "once",
                ApprovalChoice::Session => "session",
                ApprovalChoice::Deny => "deny",
            };
            if id.is_empty() || id.chars().count() > 64 {
                return Err(BAD);
            }
            lock(&app.approvals).answer_choice(workspace_id(&chat)?, &id, choice)?;
            Outcome::Ok
        }
        Request::Inbox { after } => Outcome::Inbox {
            page: inbox(&lock(&app.db), after)?,
        },
        Request::ReadThread { chat } => {
            store::mark_read(&lock(&app.db), workspace_id(&chat)?)?;
            Outcome::Ok
        }
        Request::ReadReply { chat, id } => {
            store::mark_reply_read(&lock(&app.db), workspace_id(&chat)?, workspace_id(&id)?)?;
            Outcome::Ok
        }
        _ => return Err(BAD),
    })
}
