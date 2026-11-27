use super::*;

fn empty() -> Result<Connection> {
    let mut db = Connection::open_in_memory()?;
    init(&mut db)?;
    Ok(db)
}

fn restore_v4_shape(db: &Connection) -> SqlResult<()> {
    db.execute_batch(
        "DROP TABLE backend_profiles; DROP TABLE identities; DROP TABLE attachments;
        ALTER TABLE placement DROP COLUMN original_channel; PRAGMA user_version=4;",
    )
}

#[test]
fn legacy_upgrade_rolls_back_then_preserves_ids_and_answers() -> Result<()> {
    let mut db = Connection::open_in_memory()?;
    db.execute_batch("CREATE TABLE chats(id TEXT PRIMARY KEY,title TEXT NOT NULL);
      CREATE TABLE turns(id TEXT PRIMARY KEY,chat TEXT NOT NULL REFERENCES chats(id),text TEXT NOT NULL,state TEXT NOT NULL,answer TEXT);
      INSERT INTO chats VALUES ('old','Legacy'); INSERT INTO turns VALUES ('msg','old','Question','answered','Reply');
      CREATE TABLE notifications(existing TEXT);")?;
    assert!(init(&mut db).is_err());
    assert_eq!(count(&db, "PRAGMA user_version", [])?, 0);
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM sqlite_master WHERE name='channels'",
            []
        )?,
        0
    );
    db.execute_batch("DROP TABLE notifications")?;
    for _ in 0..2 {
        init(&mut db)?;
        assert_eq!(
            chats(&db)?,
            json!([{"id":"old","title":"Legacy","channel":"general"}])
        );
        assert_eq!(
            history(&db, "old")?,
            json!([{"id":"msg","text":"Question","state":"answered","answer":"Reply","updates":[]}])
        );
        assert!(!enqueue(&mut db, "old", "msg", "Question", None, &[])?.0);
        finish(&mut db, "old", "msg", "Reply")?;
        assert_eq!(notifications(&db)?, json!([]));
    }
    Ok(())
}

#[test]
fn version_one_does_not_replay_old_admissions() -> Result<()> {
    let mut db = empty()?;
    enqueue(&mut db, "old", "old", "work", Some("general"), &[])?;
    claim(&mut db)?;
    admission(&db, "old", true)?;
    restore_v4_shape(&db)?;
    db.execute_batch("DROP TABLE device_sessions; PRAGMA user_version=1")?;
    init(&mut db)?;
    assert_eq!(history(&db, "old")?[0]["state"], "unknown");
    assert_eq!(claim(&mut db)?, Value::Null);
    Ok(())
}

#[test]
fn upgrade_expires_unbound_approval_without_running_it_or_notifying() -> Result<()> {
    let mut db = empty()?;
    enqueue(&mut db, "a", "a", "first", Some("general"), &[])?;
    enqueue(&mut db, "a", "b", " /Approve session", None, &[])?;
    enqueue(&mut db, "a", "c", "later", None, &[])?;
    init(&mut db)?;
    assert_eq!(claim(&mut db)?["id"], "a");
    assert!(claim(&mut db)?.is_null());
    assert_eq!(
        history(&db, "a")?[1]["answer"],
        "Expired approval reply. Not sent to Hermes."
    );
    assert_eq!(notifications(&db)?, json!([]));
    finish(&mut db, "a", "a", "done")?;
    assert_eq!(claim(&mut db)?["id"], "c");
    Ok(())
}

#[test]
fn queued_work_is_fifo_per_thread_and_uncertain_claims_block_only_their_thread() -> Result<()> {
    let mut db = empty()?;
    enqueue(&mut db, "a", "a", "one", Some("general"), &[])?;
    enqueue(&mut db, "a", "b", "two", None, &[])?;
    enqueue(&mut db, "c", "c", "three", Some("general"), &[])?;
    assert_eq!(claim(&mut db)?["id"], "a");
    interrupt(&db)?;
    assert!(finish(&mut db, "a", "b", "early").is_err());
    assert_eq!(claim(&mut db)?["id"], "c");
    assert!(claim(&mut db)?.is_null());
    assert!(finish(&mut db, "c", "a", "wrong thread").is_err());
    finish(&mut db, "a", "a", "late")?;
    assert_eq!(claim(&mut db)?["id"], "b");
    assert!(claim(&mut db)?.is_null());
    Ok(())
}

#[test]
fn owner_can_release_only_an_unknown_turn_and_late_final_stays_correlated() -> Result<()> {
    let mut db = empty()?;
    enqueue(&mut db, "a", "a", "original", Some("general"), &[])?;
    enqueue(&mut db, "a", "b", "continue", None, &[])?;
    enqueue(&mut db, "a", "c", "third", None, &[])?;
    assert!(stop_waiting(&db, "a", "b").is_err());
    claim(&mut db)?;
    assert!(stop_waiting(&db, "a", "a").is_err());
    admission(&db, "a", true)?;
    assert!(stop_waiting(&db, "a", "a").is_err());
    interrupt(&db)?;
    assert!(stop_waiting(&db, "other", "a").is_err());
    assert!(claim(&mut db)?.is_null());
    stop_waiting(&db, "a", "a")?;
    init(&mut db)?;
    stop_waiting(&db, "a", "a")?;
    assert_eq!(notifications(&db)?, json!([]));
    assert_eq!(claim(&mut db)?["id"], "b");
    finish(&mut db, "a", "a", "late reply")?;
    finish(&mut db, "a", "a", "late reply")?;
    assert!(finish(&mut db, "a", "a", "conflicting").is_err());
    assert!(claim(&mut db)?.is_null());
    let rows = history(&db, "a")?;
    assert_eq!(rows[0]["state"], "released");
    assert_eq!(rows[0]["answer"], "late reply");
    assert!(rows[1]["answer"].is_null());
    assert_eq!(
        notifications(&db)?,
        json!([{"chat":"a","request":"a","channel":"general","unread":1}])
    );
    finish(&mut db, "a", "b", "next final")?;
    assert!(stop_waiting(&db, "a", "b").is_err());
    assert_eq!(claim(&mut db)?["id"], "c");
    Ok(())
}

#[test]
fn opening_and_final_are_atomic_and_replay_safe() -> Result<()> {
    let mut db = empty()?;
    db.execute_batch(
        "CREATE TRIGGER fail BEFORE INSERT ON turns BEGIN SELECT RAISE(ABORT,'full'); END",
    )?;
    assert!(enqueue(&mut db, "a", "a", "hello", Some("general"), &[]).is_err());
    assert_eq!(chats(&db)?, json!([]));
    db.execute_batch("DROP TRIGGER fail")?;
    enqueue(&mut db, "a", "a", "hello", Some("general"), &[])?;
    claim(&mut db)?;
    db.execute_batch(
        "CREATE TRIGGER fail BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'full'); END",
    )?;
    assert!(finish(&mut db, "a", "a", "reply").is_err());
    assert!(history(&db, "a")?[0]["answer"].is_null());
    db.execute_batch("DROP TRIGGER fail")?;
    finish(&mut db, "a", "a", "reply")?;
    mark_read(&db, "a")?;
    finish(&mut db, "a", "a", "reply")?;
    assert!(finish(&mut db, "a", "a", "changed").is_err());
    assert_eq!(
        notifications(&db)?,
        json!([{"chat":"a","request":"a","channel":"general","unread":0}])
    );
    Ok(())
}

#[test]
fn visible_receipts_only_clear_the_named_reply_in_its_thread() -> Result<()> {
    let mut db = empty()?;
    enqueue(&mut db, "a", "a", "first", Some("general"), &[])?;
    enqueue(&mut db, "b", "b", "other", Some("general"), &[])?;
    push(&mut db, "a", "one", "first delivery")?;
    push(&mut db, "a", "two", "racing delivery")?;
    mark_reply_read(&db, "b", "two")?;
    for _ in 0..2 {
        mark_reply_read(&db, "a", "one")?;
    }
    let inbox = notifications(&db)?;
    assert_eq!(inbox[0]["request"], "two");
    assert_eq!(inbox[0]["unread"], 1);
    assert_eq!(inbox[1]["unread"], 0);
    Ok(())
}

#[test]
fn mid_turn_updates_upsert_in_order_and_reject_inactive_turns() -> Result<()> {
    let mut db = empty()?;
    enqueue(&mut db, "a", "a", "build", Some("general"), &[])?;
    enqueue(&mut db, "a", "b", "queued", None, &[])?;
    // Queued turn cannot accept updates yet.
    assert!(record_update(&mut db, "a", Some("a"), "u1", "progress", "step 1").is_err());
    claim(&mut db)?;
    admission(&db, "a", true)?;
    // Progress bubble upserts in place; commentary appends after it.
    record_update(&mut db, "a", None, "u1", "progress", "step 1")?;
    record_update(&mut db, "a", Some("a"), "u1", "progress", "step 1\nstep 2")?;
    record_update(&mut db, "a", Some("a"), "u2", "commentary", "Halfway done.")?;
    record_update(&mut db, "a", None, "u3", "progress", "step 3")?;
    // Wrong kind or wrong chat/turn rejected; notifications remain empty.
    assert!(record_update(&mut db, "a", Some("a"), "u1", "commentary", "bad").is_err());
    assert!(record_update(&mut db, "a", Some("b"), "u4", "progress", "queued").is_err());
    assert!(record_update(&mut db, "other", Some("a"), "u4", "progress", "wrong chat").is_err());
    assert_eq!(notifications(&db)?, json!([]));
    assert_eq!(
        history(&db, "a")?[0]["updates"],
        json!([
            {"id":"u1","kind":"progress","text":"step 1\nstep 2"},
            {"id":"u2","kind":"commentary","text":"Halfway done."},
            {"id":"u3","kind":"progress","text":"step 3"}
        ])
    );
    finish(&mut db, "a", "a", "Final reply")?;
    // Once answered, further updates are rejected and existing updates stay intact.
    assert!(record_update(&mut db, "a", Some("a"), "u4", "progress", "late").is_err());
    assert!(record_update(&mut db, "a", None, "u4", "progress", "late").is_err());
    assert_eq!(
        history(&db, "a")?[0]["updates"]
            .as_array()
            .ok_or(Error::Conflict("history updates must be an array"))?
            .len(),
        3
    );
    Ok(())
}

#[test]
fn unsolicited_push_commits_with_notification_and_respects_unknown_turns() -> Result<()> {
    let mut db = empty()?;
    assert!(push(&mut db, "missing", "p1", "cron").is_err());
    enqueue(&mut db, "a", "a", "hello", Some("general"), &[])?;
    claim(&mut db)?;
    finish(&mut db, "a", "a", "hi")?;
    mark_read(&db, "a")?;
    // Push commits atomically with an unread notification and replays idempotently.
    push(&mut db, "a", "p1", "Cron report")?;
    push(&mut db, "a", "p1", "Cron report")?;
    assert!(push(&mut db, "a", "p1", "Changed").is_err());
    assert_eq!(
        notifications(&db)?,
        json!([
            {"request":"p1","chat":"a","channel":"general","unread":1},
            {"request":"a","chat":"a","channel":"general","unread":0}
        ])
    );
    // Does not block subsequent queued user turns.
    enqueue(&mut db, "a", "b", "follow-up", None, &[])?;
    assert_eq!(claim(&mut db)?["id"], "b");
    // Unsettled unknown turn blocks unsolicited pushes on that thread.
    interrupt(&db)?;
    assert!(push(&mut db, "a", "p2", "Blocked while unknown").is_err());
    Ok(())
}

#[test]
fn version_three_adds_device_sessions_without_touching_workspace() -> Result<()> {
    let mut db = empty()?;
    restore_v4_shape(&db)?;
    db.execute_batch(
        "DROP TABLE device_sessions;
         PRAGMA user_version=3;
         INSERT INTO chats VALUES ('legacy','Title');
         INSERT INTO placement VALUES ('legacy','general');
         INSERT INTO turns VALUES ('turn','legacy','Question','answered','Reply');
         INSERT INTO turn_updates VALUES ('update','turn','commentary','Note');
         INSERT INTO notifications VALUES ('turn',0);",
    )?;
    init(&mut db)?;
    assert_eq!(count(&db, "PRAGMA user_version", [])?, 5);
    assert_eq!(count(&db, "SELECT count(*) FROM device_sessions", [])?, 0);
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM turn_updates WHERE id='update'",
            []
        )?,
        1
    );
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM notifications WHERE request='turn' AND unread=0",
            []
        )?,
        1
    );
    Ok(())
}

#[test]
fn version_four_migrates_move_and_preserves_original_enqueue_receipt_and_notifications()
-> Result<()> {
    let mut db = empty()?;
    let to = category(&mut db, "Other")?["id"]
        .as_str()
        .ok_or(Error::Conflict("new category ID must be a string"))?
        .to_string();
    enqueue(
        &mut db,
        "chat",
        "chat",
        "Original title",
        Some("general"),
        &[],
    )?;
    claim(&mut db)?;
    finish(&mut db, "chat", "chat", "Reply")?;
    let history_before = history(&db, "chat")?;
    restore_v4_shape(&db)?;
    init(&mut db)?;
    init(&mut db)?;
    assert_eq!(count(&db, "PRAGMA user_version", [])?, 5);
    assert!(matches!(
        move_thread(&db, "missing", &to),
        Err(Error::Missing)
    ));
    assert!(matches!(
        move_thread(&db, "chat", "missing"),
        Err(Error::Missing)
    ));
    move_thread(&db, "chat", &to)?;
    let receipt = enqueue(
        &mut db,
        "chat",
        "chat",
        "Original title",
        Some("general"),
        &[],
    )?;
    assert_eq!(
        receipt,
        (
            false,
            json!({"id":"chat","title":"Original title","channel":to})
        )
    );
    assert!(enqueue(&mut db, "chat", "chat", "Original title", Some(&to), &[]).is_err());
    assert_eq!(history(&db, "chat")?, history_before);
    assert_eq!(
        notifications(&db)?,
        json!([{"request":"chat","chat":"chat","channel":to,"unread":1}])
    );
    Ok(())
}

#[test]
fn attachments_link_atomically_and_only_exact_replay_can_reuse_them() -> Result<()> {
    let mut db = empty()?;
    db.execute_batch("INSERT INTO attachments(id,turn,purpose,filename,mime,kind,size) VALUES('other',NULL,'turn','other.wav','audio/wav','audio',23),('file',NULL,'turn','A Report.pdf','application/octet-stream','file',42),('avatar',NULL,'avatar','photo.png','image/png','image',9);")?;
    for ids in [
        &["file", "missing"][..],
        &["file", "avatar"][..],
        &["file", "file"][..],
    ] {
        assert!(enqueue(&mut db, "chat", "chat", "", Some("general"), ids).is_err());
        assert_eq!(chats(&db)?, json!([]));
        assert_eq!(
            count(
                &db,
                "SELECT count(*) FROM attachments WHERE turn IS NOT NULL",
                []
            )?,
            0
        );
    }
    let ids = &["file", "other"];
    let first = enqueue(&mut db, "chat", "chat", "", Some("general"), ids)?;
    assert_eq!(
        first,
        (
            true,
            json!({"id":"chat","title":"A Report.pdf","channel":"general"})
        )
    );
    assert_eq!(
        enqueue(&mut db, "chat", "chat", "", Some("general"), ids)?,
        (false, first.1)
    );
    assert!(enqueue(&mut db, "chat", "chat", "", Some("general"), &["file"]).is_err());
    assert!(enqueue(&mut db, "chat", "next", "reuse", None, &["file"]).is_err());
    assert!(
        enqueue(
            &mut db,
            "chat",
            "chat",
            "",
            Some("general"),
            &["other", "file"]
        )
        .is_err()
    );
    let claimed = claim(&mut db)?;
    assert_eq!(claimed["text"], "");
    assert_eq!(
        claimed["attachments"]
            .as_array()
            .ok_or(Error::Conflict("claimed attachments must be an array"))?
            .len(),
        2
    );
    assert_eq!(claimed["attachments"][0]["id"], "file");
    assert_eq!(
        history(&db, "chat")?[0]["attachments"],
        claimed["attachments"]
    );
    assert_eq!(
        history(&db, "chat")?
            .as_array()
            .ok_or(Error::Conflict("thread history must be an array"))?
            .len(),
        1
    );
    Ok(())
}
