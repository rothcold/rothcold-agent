use super::*;

fn empty() -> Connection {
    let mut db = Connection::open_in_memory().unwrap();
    init(&mut db).unwrap();
    db
}

#[test]
fn legacy_upgrade_rolls_back_then_preserves_ids_and_answers() {
    let mut db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE chats(id TEXT PRIMARY KEY,title TEXT NOT NULL);
      CREATE TABLE turns(id TEXT PRIMARY KEY,chat TEXT NOT NULL REFERENCES chats(id),text TEXT NOT NULL,state TEXT NOT NULL,answer TEXT);
      INSERT INTO chats VALUES ('old','Legacy'); INSERT INTO turns VALUES ('msg','old','Question','answered','Reply');
      CREATE TABLE notifications(existing TEXT);").unwrap();
    assert!(init(&mut db).is_err());
    assert_eq!(count(&db, "PRAGMA user_version", []).unwrap(), 0);
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM sqlite_master WHERE name='channels'",
            []
        )
        .unwrap(),
        0
    );
    db.execute_batch("DROP TABLE notifications").unwrap();
    for _ in 0..2 {
        init(&mut db).unwrap();
        assert_eq!(
            chats(&db).unwrap(),
            json!([{"id":"old","title":"Legacy","channel":"general"}])
        );
        assert_eq!(
            history(&db, "old").unwrap(),
            json!([{"id":"msg","text":"Question","state":"answered","answer":"Reply","updates":[]}])
        );
        assert!(!enqueue(&mut db, "old", "msg", "Question", None).unwrap().0);
        finish(&mut db, "old", "msg", "Reply").unwrap();
        assert_eq!(notifications(&db).unwrap(), json!([]));
    }
}

#[test]
fn version_one_does_not_replay_old_admissions() {
    let mut db = empty();
    enqueue(&mut db, "old", "old", "work", Some("general")).unwrap();
    claim(&mut db).unwrap();
    admission(&db, "old", true).unwrap();
    db.execute_batch("PRAGMA user_version=1").unwrap();
    init(&mut db).unwrap();
    assert_eq!(history(&db, "old").unwrap()[0]["state"], "unknown");
    assert_eq!(claim(&mut db).unwrap(), Value::Null);
}

#[test]
fn upgrade_expires_unbound_approval_without_running_it_or_notifying() {
    let mut db = empty();
    enqueue(&mut db, "a", "a", "first", Some("general")).unwrap();
    enqueue(&mut db, "a", "b", " /Approve session", None).unwrap();
    enqueue(&mut db, "a", "c", "later", None).unwrap();
    init(&mut db).unwrap();
    assert_eq!(claim(&mut db).unwrap()["id"], "a");
    assert!(claim(&mut db).unwrap().is_null());
    assert_eq!(
        history(&db, "a").unwrap()[1]["answer"],
        "Expired approval reply. Not sent to Hermes."
    );
    assert_eq!(notifications(&db).unwrap(), json!([]));
    finish(&mut db, "a", "a", "done").unwrap();
    assert_eq!(claim(&mut db).unwrap()["id"], "c");
}

#[test]
fn queued_work_is_fifo_per_thread_and_uncertain_claims_block_only_their_thread() {
    let mut db = empty();
    enqueue(&mut db, "a", "a", "one", Some("general")).unwrap();
    enqueue(&mut db, "a", "b", "two", None).unwrap();
    enqueue(&mut db, "c", "c", "three", Some("general")).unwrap();
    assert_eq!(claim(&mut db).unwrap()["id"], "a");
    interrupt(&db).unwrap();
    assert!(finish(&mut db, "a", "b", "early").is_err());
    assert_eq!(claim(&mut db).unwrap()["id"], "c");
    assert!(claim(&mut db).unwrap().is_null());
    assert!(finish(&mut db, "c", "a", "wrong thread").is_err());
    finish(&mut db, "a", "a", "late").unwrap();
    assert_eq!(claim(&mut db).unwrap()["id"], "b");
    assert!(claim(&mut db).unwrap().is_null());
}

#[test]
fn opening_and_final_are_atomic_and_replay_safe() {
    let mut db = empty();
    db.execute_batch(
        "CREATE TRIGGER fail BEFORE INSERT ON turns BEGIN SELECT RAISE(ABORT,'full'); END",
    )
    .unwrap();
    assert!(enqueue(&mut db, "a", "a", "hello", Some("general")).is_err());
    assert_eq!(chats(&db).unwrap(), json!([]));
    db.execute_batch("DROP TRIGGER fail").unwrap();
    enqueue(&mut db, "a", "a", "hello", Some("general")).unwrap();
    claim(&mut db).unwrap();
    db.execute_batch(
        "CREATE TRIGGER fail BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'full'); END",
    )
    .unwrap();
    assert!(finish(&mut db, "a", "a", "reply").is_err());
    assert!(history(&db, "a").unwrap()[0]["answer"].is_null());
    db.execute_batch("DROP TRIGGER fail").unwrap();
    finish(&mut db, "a", "a", "reply").unwrap();
    mark_read(&db, "a").unwrap();
    finish(&mut db, "a", "a", "reply").unwrap();
    assert!(finish(&mut db, "a", "a", "changed").is_err());
    assert_eq!(
        notifications(&db).unwrap(),
        json!([{"chat":"a","request":"a","channel":"general","unread":0}])
    );
}

#[test]
fn mid_turn_updates_upsert_in_order_and_reject_inactive_turns() {
    let mut db = empty();
    enqueue(&mut db, "a", "a", "build", Some("general")).unwrap();
    enqueue(&mut db, "a", "b", "queued", None).unwrap();
    // Queued turn cannot accept updates yet.
    assert!(record_update(&mut db, "a", Some("a"), "u1", "progress", "step 1").is_err());
    claim(&mut db).unwrap();
    admission(&db, "a", true).unwrap();
    // Progress bubble upserts in place; commentary appends after it.
    record_update(&mut db, "a", None, "u1", "progress", "step 1").unwrap();
    record_update(&mut db, "a", Some("a"), "u1", "progress", "step 1\nstep 2").unwrap();
    record_update(&mut db, "a", Some("a"), "u2", "commentary", "Halfway done.").unwrap();
    record_update(&mut db, "a", None, "u3", "progress", "step 3").unwrap();
    // Wrong kind or wrong chat/turn rejected; notifications remain empty.
    assert!(record_update(&mut db, "a", Some("a"), "u1", "commentary", "bad").is_err());
    assert!(record_update(&mut db, "a", Some("b"), "u4", "progress", "queued").is_err());
    assert!(record_update(&mut db, "other", Some("a"), "u4", "progress", "wrong chat").is_err());
    assert_eq!(notifications(&db).unwrap(), json!([]));
    assert_eq!(
        history(&db, "a").unwrap()[0]["updates"],
        json!([
            {"id":"u1","kind":"progress","text":"step 1\nstep 2"},
            {"id":"u2","kind":"commentary","text":"Halfway done."},
            {"id":"u3","kind":"progress","text":"step 3"}
        ])
    );
    finish(&mut db, "a", "a", "Final reply").unwrap();
    // Once answered, further updates are rejected and existing updates stay intact.
    assert!(record_update(&mut db, "a", Some("a"), "u4", "progress", "late").is_err());
    assert!(record_update(&mut db, "a", None, "u4", "progress", "late").is_err());
    assert_eq!(
        history(&db, "a").unwrap()[0]["updates"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn unsolicited_push_commits_with_notification_and_respects_unknown_turns() {
    let mut db = empty();
    assert!(push(&mut db, "missing", "p1", "cron").is_err());
    enqueue(&mut db, "a", "a", "hello", Some("general")).unwrap();
    claim(&mut db).unwrap();
    finish(&mut db, "a", "a", "hi").unwrap();
    mark_read(&db, "a").unwrap();
    // Push commits atomically with an unread notification and replays idempotently.
    push(&mut db, "a", "p1", "Cron report").unwrap();
    push(&mut db, "a", "p1", "Cron report").unwrap();
    assert!(push(&mut db, "a", "p1", "Changed").is_err());
    assert_eq!(
        notifications(&db).unwrap(),
        json!([
            {"request":"p1","chat":"a","channel":"general","unread":1},
            {"request":"a","chat":"a","channel":"general","unread":0}
        ])
    );
    // Does not block subsequent queued user turns.
    enqueue(&mut db, "a", "b", "follow-up", None).unwrap();
    assert_eq!(claim(&mut db).unwrap()["id"], "b");
    // Unsettled unknown turn blocks unsolicited pushes on that thread.
    interrupt(&db).unwrap();
    assert!(push(&mut db, "a", "p2", "Blocked while unknown").is_err());
}
