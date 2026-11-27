use super::*;

#[test]
fn profile_autofill_is_passive_per_field_and_manual_sync_is_explicit() -> Result<()> {
    let mut db = Connection::open_in_memory()?;
    crate::store::init(&mut db)?;
    assert_eq!(
        read(&db)?,
        json!({"owner":{"name":"","avatar":null},"agent":{"name":"","avatar":null},"backends":[]})
    );
    db.execute_batch("INSERT INTO attachments(id,turn,purpose,filename,mime,kind,size) VALUES('remote',NULL,'backend_avatar','a.png','image/png','image',8),('custom',NULL,'avatar','a.png','image/png','image',8),('turn',NULL,'turn','a.png','image/png','image',8);")?;
    edit(
        &mut db,
        &json!({"owner":{"name":"Pat","avatar":"custom"},"agent":{"name":"Custom"}}),
    )?;
    publish(
        &mut db,
        "first",
        "hermes",
        "Backend",
        &json!("remote"),
        true,
    )?;
    assert_eq!(
        read(&db)?["agent"],
        json!({"name":"Custom","avatar":"remote"})
    );
    edit(&mut db, &json!({"agent":{"avatar":"custom"}}))?;
    publish(&mut db, "second", "other", "New", &Value::Null, true)?;
    publish(
        &mut db,
        "first",
        "hermes",
        "Backend 2",
        &json!("remote"),
        true,
    )?;
    let before = read(&db)?;
    assert_eq!(before["agent"], json!({"name":"Custom","avatar":"custom"}));
    assert_eq!(
        before["backends"]
            .as_array()
            .ok_or(crate::Error(
                S::INTERNAL_SERVER_ERROR,
                "profile backends must be an array"
            ))?
            .len(),
        2
    );
    let after = sync_profile(&mut db, "first", "offline", None)?;
    assert_eq!(
        after["agent"],
        json!({"name":"Backend 2","avatar":"remote"})
    );
    assert_eq!(after["owner"], before["owner"]);
    assert_eq!(
        after["sync"],
        json!({"backend":"first","refresh":"offline","name":true,"avatar":true})
    );
    publish(&mut db, "first", "hermes", "", &Value::Null, true)?;
    assert_eq!(
        sync_profile(&mut db, "first", "refreshed", None)?["agent"],
        after["agent"]
    );
    assert_eq!(
        sync_profile(&mut db, "missing", "offline", None)
            .unwrap_err()
            .0,
        S::CONFLICT
    );
    assert!(
        edit(
            &mut db,
            &json!({"owner":{"name":"rollback"},"agent":{"avatar":"turn"}})
        )
        .is_err()
    );
    assert_eq!(read(&db)?["owner"], before["owner"]);
    assert!(edit(&mut db, &json!({"agent":{"name":"bad\nname"}})).is_err());
    assert!(edit(&mut db, &json!({"agent":{"name":"x".repeat(81)}})).is_err());
    assert_eq!(
        edit(&mut db, &json!({"agent":{"name":"","avatar":null}}))?["agent"],
        json!({"name":"","avatar":null})
    );
    Ok(())
}

#[tokio::test]
async fn coalesced_refresh_waits_for_selected_backend_and_does_not_displace_approval()
-> std::result::Result<(), Box<dyn std::error::Error>> {
    let mut polls = ProfilePolls::default();
    assert!(polls.request("first").is_none());
    assert!(polls.claim("first", true).is_none());
    let (_, mut first) = polls
        .request("first")
        .ok_or("first refresh waiter was not registered")?;
    let (_, mut second) = polls
        .request("first")
        .ok_or("second refresh waiter was not registered")?;
    assert!(polls.claim("second", true).is_none());
    assert!(polls.claim("first", false).is_none());
    let id = polls
        .claim("first", true)
        .ok_or("selected backend did not receive the refresh claim")?;
    assert!(polls.claim("first", true).is_none());
    polls.complete("second", id, ("Wrong backend".into(), None));
    polls.complete("first", Uuid::new_v4(), ("Wrong ID".into(), None));
    assert!(!first.has_changed()?);
    assert!(!second.has_changed()?);
    polls.complete("first", id, ("Matched".into(), None));
    for receiver in [&mut first, &mut second] {
        let snapshot = tokio::time::timeout(
            Duration::from_millis(30),
            receiver.wait_for(Option::is_some),
        )
        .await??;
        assert_eq!(*snapshot, Some(("Matched".into(), None)));
    }
    assert!(polls.claim("first", true).is_none());
    Ok(())
}
