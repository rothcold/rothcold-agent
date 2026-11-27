use super::*;

fn new_db() -> store::Result<Connection> {
    let mut db = Connection::open_in_memory()?;
    store::init(&mut db)?;
    Ok(db)
}

#[test]
fn version_five_keeps_existing_titles_without_backfill() -> store::Result<()> {
    let mut db = new_db()?;
    store::enqueue(&mut db, "old", "old", "Keep me", Some("general"), &[])?;
    db.execute_batch("DROP TABLE thread_title_jobs; PRAGMA user_version=5;")?;
    store::init(&mut db)?;
    assert_eq!(claim_job(&mut db)?, Value::Null);
    assert_eq!(store::chats(&db)?[0]["title"], "Keep me");
    Ok(())
}

#[test]
fn title_job_lease_cannot_repeat_or_overwrite_manual_rename() -> store::Result<()> {
    let mut db = new_db()?;
    for id in ["success", "expired", "manual", "failure", "not_started"] {
        store::enqueue(&mut db, id, id, "Original opener", Some("general"), &[])?;
    }
    // Saving the exact fallback still makes the title owner-controlled, even before a claim.
    store::rename(&mut db, "not_started", "Original opener")?;
    let mut lease = || -> store::Result<String> {
        let job = claim_job(&mut db)?;
        assert_eq!(job["text"], "Original opener");
        Ok(job["claim"].as_str().unwrap().to_owned())
    };
    let (success, expired, manual, failure) = (lease()?, lease()?, lease()?, lease()?);
    db.execute(
        "UPDATE thread_title_jobs SET expires=0 WHERE claim=?",
        [&expired],
    )?;
    store::rename(&mut db, "manual", "Original opener")?;
    finish_job(&mut db, &success, Some("Semantic title"))?;
    finish_job(&mut db, &success, Some("Duplicate result"))?;
    finish_job(&mut db, &expired, Some("Stale result"))?;
    finish_job(&mut db, &manual, Some("Owner did not choose this"))?;
    finish_job(&mut db, &failure, None)?;
    assert_eq!(claim_job(&mut db)?, Value::Null);
    for chat in store::chats(&db)?.as_array().unwrap() {
        let expected = if chat["id"] == "success" {
            "Semantic title"
        } else {
            "Original opener"
        };
        assert_eq!(chat["title"], expected);
    }
    assert_eq!(store::notifications(&db)?, json!([]));
    Ok(())
}
