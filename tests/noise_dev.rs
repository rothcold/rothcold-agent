use super::*;
use crate::{Auth, Platform};
use futures_util::SinkExt;
use std::{fs, io::Read, net::Ipv4Addr, path::Path, sync::Mutex, time::Instant as StdInstant};
use tempfile::TempDir;
use tokio::{net::TcpListener, task::JoinHandle, time::sleep};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{self, Message, client::IntoClientRequest},
};
use uuid::Uuid;

#[path = "noise_dev_client.rs"]
mod client;
use client::{ClientError, ReferenceClient, ScopedCredential};

struct Fixture {
    app: App,
    pin: Key,
    credential: Key,
    device_id: String,
    url: String,
    task: JoinHandle<()>,
    home: TempDir,
}

fn keypair() -> (Key, Key) {
    let pair = protocol::generate_keypair().expect("fixture key source");
    let private = pair
        .private
        .as_slice()
        .try_into()
        .expect("private key length");
    let pin = pair
        .public
        .as_slice()
        .try_into()
        .expect("public key length");
    (private, pin)
}

fn random_credential() -> Key {
    let mut credential = [0; 32];
    getrandom::fill(&mut credential).expect("fixture CSPRNG");
    credential
}

impl Fixture {
    async fn start() -> Self {
        let home = tempfile::tempdir().unwrap();
        let mut db = rusqlite::Connection::open(home.path().join("history.sqlite3")).unwrap();
        store::init(&mut db).unwrap();
        db.execute_batch("INSERT INTO channels(id,name,archived) VALUES('old','Archived category',1);
            INSERT INTO chats(id,title,archived) VALUES('archived-thread','Archived thread',1),('under-archive','In archived category',0),('active-thread','Active thread',0);
            INSERT INTO placement(chat,channel) VALUES('archived-thread','general'),('under-archive','old'),('active-thread','general');").unwrap();
        let (private, pin) = keypair();
        let credential = random_credential();
        let device_id = sessions::provision_noise_dev(&db, &pin, &credential).unwrap();
        let attachments = home.path().join("attachments");
        attachments::init_dir(&attachments).unwrap();
        let app = Arc::new(Platform {
            db: Mutex::new(db),
            auth: Mutex::new(Auth {
                window: StdInstant::now(),
                failures: 0,
            }),
            approvals: Mutex::default(),
            attachments,
            attachment_slots: Default::default(),
            profiles: Mutex::default(),
            slash_catalog: Mutex::default(),
            owner: "unused synthetic HTTP owner".into(),
            bridge: "unused synthetic adapter bearer".into(),
        });
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let std::net::SocketAddr::V4(addr) = listener.local_addr().unwrap() else {
            unreachable!()
        };
        let router = router(addr, app.clone(), private, pin).unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        Self {
            app,
            pin,
            credential,
            device_id,
            url: format!("ws://{addr}/noise"),
            task,
            home,
        }
    }
    async fn connect(&self) -> ReferenceClient {
        ReferenceClient::connect(&self.url, &self.pin)
            .await
            .unwrap()
    }
    async fn authorized(&self) -> ReferenceClient {
        let mut client = self.connect().await;
        client.authorize(&self.scoped_credential()).await.unwrap();
        client
    }
    fn scoped_credential(&self) -> ScopedCredential {
        ScopedCredential::issued_for(self.pin, self.credential)
    }
    fn files(&self) -> Vec<String> {
        let mut entries: Vec<_> = fs::read_dir(&self.app.attachments)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        entries.sort();
        entries
    }
    fn rows(&self) -> u32 {
        lock(&self.app.db)
            .query_row("SELECT count(*) FROM attachments", [], |r| r.get(0))
            .unwrap()
    }
    fn expire(&self) {
        lock(&self.app.db)
            .execute(
                "UPDATE device_sessions SET expires_at=0 WHERE id=?",
                [&self.device_id],
            )
            .unwrap();
    }
    fn revoke(&self) {
        lock(&self.app.db)
            .execute("DELETE FROM device_sessions WHERE id=?", [&self.device_id])
            .unwrap();
    }
    async fn clean_uploads(&self) {
        timeout(IDLE, async {
            while !self.files().is_empty() {
                sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("staged files should be gone");
        assert_eq!(self.rows(), 0);
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[tokio::test]
async fn directory_and_multirecord_turn_file() {
    let f = Fixture::start().await;
    let mut first = f.authorized().await;
    let directory = first.directory().await.unwrap();
    assert_eq!(
        directory,
        store::archive::directory(&lock(&f.app.db)).unwrap()
    );
    assert_eq!(directory["channels"][1]["archived"], 1);
    assert!(
        directory["chats"]
            .as_array()
            .unwrap()
            .iter()
            .any(|chat| chat["id"] == "archived-thread" && chat["archived"] == 1)
    );

    let content: Vec<u8> = (0..CHUNK_BYTES * 3 + 17)
        .map(|n| ((n * 31 + n / 256) % 256) as u8)
        .collect();
    let metadata = first
        .upload("../sample.svg", content.len() as u64, content.as_slice())
        .await
        .unwrap();
    assert_eq!(metadata.filename, "sample.svg");
    assert_eq!(metadata.size, content.len() as u64);
    assert_eq!(metadata.kind, "file");
    assert_eq!(metadata.mime, "application/octet-stream");
    assert_eq!(f.files(), std::slice::from_ref(&metadata.id));
    assert_eq!(f.rows(), 1);
    let adapter = attachments::adapter_view(
        State(f.app.clone()),
        axum::extract::Path(metadata.id.clone()),
        HeaderMap::new(),
    )
    .await;
    assert!(matches!(adapter, Err(Error(StatusCode::NOT_FOUND, _))));

    let mut second = f.authorized().await;
    let mut output = second.download(&metadata.id, f.home.path()).await.unwrap();
    let mut received = Vec::new();
    output.read_to_end(&mut received).unwrap();
    assert_eq!(received, content);
    assert_eq!(
        fs::read(f.app.attachments.join(metadata.id)).unwrap(),
        content
    );
    let missing = Uuid::new_v4().to_string();
    assert_eq!(
        second.download(&missing, f.home.path()).await.err(),
        Some(ClientError::Business(ErrorCode::Missing))
    );
}

#[tokio::test]
async fn pin_and_device_capability_are_independent_and_scoped() {
    let f = Fixture::start().await;
    let (_, wrong_pin) = keypair();
    assert_eq!(
        ReferenceClient::connect(&f.url, &wrong_pin).await.err(),
        Some(ClientError::PinOrHandshake)
    );
    assert!(
        sessions::authenticate_noise_dev(&lock(&f.app.db), &wrong_pin, &f.credential)
            .unwrap()
            .is_none()
    );
    let hex = f
        .credential
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    assert!(
        sessions::authenticate(&lock(&f.app.db), hex.as_bytes())
            .unwrap()
            .is_none()
    );
    assert_eq!(
        f.connect().await.directory().await.err(),
        Some(ClientError::Business(ErrorCode::Unauthorized))
    );
    assert_eq!(
        f.connect()
            .await
            .authorize(&ScopedCredential::issued_for(f.pin, random_credential()))
            .await
            .err(),
        Some(ClientError::Business(ErrorCode::Unauthorized))
    );

    let mut still_open = f.authorized().await;
    f.revoke();
    assert_eq!(
        still_open.directory().await.err(),
        Some(ClientError::Business(ErrorCode::Unauthorized))
    );
    assert_eq!(
        f.connect()
            .await
            .authorize(&f.scoped_credential())
            .await
            .err(),
        Some(ClientError::Business(ErrorCode::Unauthorized))
    );

    let f = Fixture::start().await;
    let mut open = f.authorized().await;
    f.expire();
    assert_eq!(
        open.begin("expired", 1).await.err(),
        Some(ClientError::Business(ErrorCode::Unauthorized))
    );
    assert_eq!(
        f.connect()
            .await
            .authorize(&f.scoped_credential())
            .await
            .err(),
        Some(ClientError::Business(ErrorCode::Unauthorized))
    );
}

#[tokio::test]
async fn websocket_upgrade_rejects_ambient_authority_and_only_carries_binary() {
    let f = Fixture::start().await;
    for (header, value) in [
        ("origin", "https://example.invalid"),
        ("origin", "null"),
        ("cookie", "session=fixture"),
        ("authorization", "Bearer fixture"),
        ("host", "example.invalid"),
    ] {
        let mut request = f.url.as_str().into_client_request().unwrap();
        request.headers_mut().insert(header, value.parse().unwrap());
        let result = timeout(IDLE, connect_async(request)).await.unwrap();
        assert!(
            matches!(result, Err(tungstenite::Error::Http(response)) if response.status() == StatusCode::FORBIDDEN)
        );
    }
    let result = timeout(IDLE, connect_async(format!("{}?fixture", f.url)))
        .await
        .unwrap();
    assert!(
        matches!(result, Err(tungstenite::Error::Http(response)) if response.status() == StatusCode::FORBIDDEN)
    );
    let mut client = f.authorized().await;
    client
        .socket()
        .unwrap()
        .send(Message::Text("directory".into()))
        .await
        .unwrap();
    assert_eq!(client.next().await.err(), Some(ClientError::Transport));
}

#[tokio::test]
async fn aborted_uploads_never_become_visible_and_release_slots() {
    let f = Fixture::start().await;
    let mut first = f.authorized().await;
    let mut second = f.authorized().await;
    first
        .begin("partial", CHUNK_BYTES as u64 + 1)
        .await
        .unwrap();
    second.begin("partial", 1).await.unwrap();
    assert_eq!(f.files().len(), 2);
    assert_eq!(f.rows(), 0);
    let pending = f.files()[0]
        .strip_prefix(files::PENDING)
        .unwrap()
        .to_owned();
    assert_eq!(
        f.authorized()
            .await
            .download(&pending, f.home.path())
            .await
            .err(),
        Some(ClientError::Business(ErrorCode::Missing))
    );
    assert_eq!(
        f.authorized().await.begin("busy", 1).await.err(),
        Some(ClientError::Business(ErrorCode::Busy))
    );
    first.chunk(0, &[1; CHUNK_BYTES]).await.unwrap();
    first.cancel_upload().await.unwrap();
    assert!(matches!(
        first.next().await.unwrap(),
        Record::Control(Server::UploadCancelled)
    ));
    assert_eq!(f.files().len(), 1);
    second.chunk(0, &[2]).await.unwrap();
    drop(second);
    f.clean_uploads().await;

    first.begin("partial", 2).await.unwrap();
    first.finish_upload().await.unwrap();
    assert_eq!(first.next().await.err(), Some(ClientError::Transport));
    f.clean_uploads().await;

    let mut out_of_order = f.authorized().await;
    out_of_order.begin("partial", 1).await.unwrap();
    out_of_order.chunk(1, &[1]).await.unwrap();
    assert_eq!(
        out_of_order.next().await.err(),
        Some(ClientError::Transport)
    );
    f.clean_uploads().await;

    let mut timed_out = f.authorized().await;
    timed_out.begin("partial", 1).await.unwrap();
    assert_eq!(f.files().len(), 1);
    timeout(IDLE + Duration::from_secs(2), async {
        while !f.files().is_empty() {
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("idle upload must be dropped");
    f.clean_uploads().await;
}

#[tokio::test]
async fn revoked_and_failed_commit_remove_staging() {
    let f = Fixture::start().await;
    let mut revoked = f.authorized().await;
    revoked.begin("revoke-before-finish", 1).await.unwrap();
    revoked.chunk(0, &[7]).await.unwrap();
    f.revoke();
    revoked.finish_upload().await.unwrap();
    assert_eq!(
        revoked.next().await.err(),
        Some(ClientError::Business(ErrorCode::Unauthorized))
    );
    f.clean_uploads().await;

    let f = Fixture::start().await;
    lock(&f.app.db).execute_batch("CREATE TRIGGER fixture_fail BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT,'synthetic commit failure'); END;").unwrap();
    let error = f
        .authorized()
        .await
        .upload("commit-fails", 1, &[7][..])
        .await
        .err();
    assert_eq!(error, Some(ClientError::Business(ErrorCode::Storage)));
    f.clean_uploads().await;
}

#[tokio::test]
async fn tampered_replayed_and_oversized_records_abort_upload() {
    let f = Fixture::start().await;
    for fail in ["replay", "tamper", "truncated", "oversized"] {
        let mut client = f.authorized().await;
        client
            .begin("malformed", CHUNK_BYTES as u64 + 1)
            .await
            .unwrap();
        let mut packet = client.chunk(0, &[7; CHUNK_BYTES]).await.unwrap();
        match fail {
            "tamper" => {
                packet[0] ^= 0x80;
            }
            "truncated" => {
                packet.truncate(10);
            }
            "oversized" => {
                packet.resize(MAX_PACKET + 1, 0);
            }
            _ => (),
        }
        timeout(
            IDLE,
            client
                .socket()
                .unwrap()
                .send(Message::Binary(packet.into())),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(client.next().await.err(), Some(ClientError::Transport));
        f.clean_uploads().await;
    }
    assert_eq!(
        f.authorized()
            .await
            .begin("over-limit", attachments::FILE_LIMIT as u64 + 1)
            .await
            .err(),
        Some(ClientError::Business(ErrorCode::Limit))
    );
}

fn interrupted_link(dir: &Path, id: &str) -> std::path::PathBuf {
    let marker = dir.join(format!(".noise-dev-upload-{id}"));
    fs::write(&marker, [1, 2, 3]).unwrap();
    fs::hard_link(&marker, dir.join(id)).unwrap();
    marker
}

#[tokio::test]
async fn startup_cleanup_distinguishes_committed_from_pending_names() {
    let f = Fixture::start().await;
    let id = f
        .authorized()
        .await
        .upload("committed", 3, &[1, 2, 3][..])
        .await
        .unwrap()
        .id;
    let dir = &f.app.attachments;
    let committed_marker = dir.join(format!(".noise-dev-upload-{id}"));
    fs::hard_link(dir.join(&id), &committed_marker).unwrap();
    let interrupted = Uuid::new_v4().to_string();
    let marker = interrupted_link(dir, &interrupted);
    let other = dir.join(format!(".noise-dev-upload-{}", Uuid::new_v4()));
    fs::write(&other, [1]).unwrap();
    files::recover(dir, &lock(&f.app.db)).unwrap();
    assert!(!dir.join(interrupted).exists());
    for path in [committed_marker, marker, other] {
        assert!(!path.exists());
    }
    assert_eq!(f.files(), [id]);
    assert_eq!(f.rows(), 1);
}

#[tokio::test]
async fn limits_directory_before_reply() {
    let f = Fixture::start().await;
    lock(&f.app.db)
        .execute(
            "UPDATE channels SET name=? WHERE id='general'",
            ["a".repeat(MAX_PACKET)],
        )
        .unwrap();
    assert_eq!(
        f.authorized().await.directory().await.err(),
        Some(ClientError::Business(ErrorCode::Limit))
    );
}

#[tokio::test]
async fn download_busy_and_incomplete_output_stays_private() {
    let f = Fixture::start().await;
    let id = f
        .authorized()
        .await
        .upload("download-target", 1, &[7][..])
        .await
        .unwrap()
        .id;
    let slots: Vec<_> = (0..8)
        .map(|_| files::open_turn(&f.app, &id).ok().unwrap())
        .collect();
    let output = tempfile::tempdir_in(f.home.path()).unwrap();
    assert_eq!(
        f.authorized()
            .await
            .download(&id, output.path())
            .await
            .err(),
        Some(ClientError::Business(ErrorCode::Busy))
    );
    drop(slots);

    // Sparse complete file in the fixture. Do not drain the socket until after
    // revocation: 25 MiB exceeds the loopback socket buffers on the test hosts.
    let limit = attachments::FILE_LIMIT as u64;
    fs::OpenOptions::new()
        .write(true)
        .open(f.app.attachments.join(&id))
        .unwrap()
        .set_len(limit)
        .unwrap();
    lock(&f.app.db)
        .execute(
            "UPDATE attachments SET size=? WHERE id=?",
            rusqlite::params![limit, id],
        )
        .unwrap();
    let mut client = f.authorized().await;
    let size = client.begin_download(&id).await.unwrap();
    assert_eq!(size, limit);
    f.revoke();
    assert_eq!(
        client.receive_download(size, output.path()).await.err(),
        Some(ClientError::Business(ErrorCode::Unauthorized))
    );
    assert!(fs::read_dir(output.path()).unwrap().next().is_none());
    assert_eq!(f.files(), [id]);
}

#[tokio::test]
async fn detached_finalize_rolls_back_on_cancellation_or_expired_deadline() {
    use tokio::sync::oneshot;

    let f = Fixture::start().await;
    for cancel_wait in [true, false] {
        let deadline = if cancel_wait {
            Instant::now() + LIFETIME
        } else {
            Instant::now()
        };
        let cancel = CancelCommit::new(deadline);
        let boundary = cancel.0.clone();
        let app = f.app.clone();
        let pin = f.pin;
        let credential = f.credential;
        let data = b"staged fixture bytes";
        let mut staged = files::StagedUpload::begin(&app, "pending", data.len() as u64).unwrap();
        staged.classify(data);
        staged.file.write_all(data).await.unwrap();
        staged.file.flush().await.unwrap();
        let (prepared, ready) = oneshot::channel();
        let (resume, release) = oneshot::channel();
        let worker = spawn_blocking(move || {
            staged.prepare_final(&app.attachments).unwrap();
            prepared.send(()).unwrap();
            release.blocking_recv().unwrap();
            commit_prepared(&app, staged, &pin, &credential, &boundary)
        });
        timeout(IDLE, ready).await.unwrap().unwrap();
        let names = f.files();
        assert_eq!(
            names.len(),
            2,
            "temporary and final names exist before commit"
        );
        for name in names {
            assert_eq!(fs::read(f.app.attachments.join(name)).unwrap(), data);
        }
        assert_eq!(f.rows(), 0, "neither name is business-visible");
        let other_slot = f.app.attachment_slots.upload().unwrap();
        assert!(f.app.attachment_slots.upload().is_err());

        let still_waiting = if cancel_wait {
            // Simulate a timed-out wait after the blocking worker has started.
            let expired = timeout(Duration::ZERO, async move {
                let _cancel = cancel;
                std::future::pending::<()>().await;
            })
            .await;
            assert!(expired.is_err());
            None
        } else {
            // Even if the async side has not yet polled its timer, the worker cannot
            // claim a boundary after its deadline.
            Some(cancel)
        };
        assert!(
            f.app.attachment_slots.upload().is_err(),
            "the worker owns its slot until cleanup"
        );
        resume.send(()).unwrap();
        let result = timeout(IDLE, worker).await.unwrap().unwrap();
        assert!(matches!(result, Err(Failure::Close)));
        drop(still_waiting);
        assert!(f.files().is_empty());
        assert_eq!(
            f.rows(),
            0,
            "the transaction's uncommitted insert rolls back"
        );
        assert!(
            f.app.attachment_slots.upload().is_ok(),
            "cleanup returned the worker's slot"
        );
        drop(other_slot);
    }
}

#[tokio::test]
async fn committed_upload_survives_unread_acknowledgement() {
    let f = Fixture::start().await;
    let mut client = f.authorized().await;
    let data = [7, 11, 13];
    client.begin("unread-ack", data.len() as u64).await.unwrap();
    client.chunk(0, &data).await.unwrap();
    client.finish_upload().await.unwrap();
    // Observe the real DB commit without awaiting the acknowledgement.
    let id = timeout(IDLE, async {
        loop {
            let app = f.app.clone();
            let row = spawn_blocking(move || {
                lock(&app.db).query_row("SELECT id FROM attachments", [], |r| r.get::<_, String>(0))
            })
            .await
            .unwrap();
            match row {
                Ok(id) => break id,
                Err(rusqlite::Error::QueryReturnedNoRows) => sleep(Duration::from_millis(5)).await,
                Err(e) => panic!("unexpected test DB error: {e}"),
            }
        }
    })
    .await
    .unwrap();
    drop(client);
    let mut downloaded = f
        .authorized()
        .await
        .download(&id, f.home.path())
        .await
        .unwrap();
    let mut bytes = Vec::new();
    downloaded.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, data);
    assert_eq!(f.rows(), 1);
}

#[tokio::test]
async fn local_upload_read_or_size_error_closes_connection() {
    struct FaultAfterOneByte(bool);
    impl Read for FaultAfterOneByte {
        fn read(&mut self, into: &mut [u8]) -> io::Result<usize> {
            if std::mem::replace(&mut self.0, true) {
                return Err(io::Error::other("synthetic local read fault"));
            }
            into[0] = 7;
            Ok(1)
        }
    }

    async fn check(f: &Fixture, size: u64, source: impl Read) {
        let mut client = f.authorized().await;
        assert_eq!(
            client.upload("bad-input", size, source).await.err(),
            Some(ClientError::File)
        );
        assert_eq!(client.directory().await.err(), Some(ClientError::Transport));
        f.clean_uploads().await;
    }

    let f = Fixture::start().await;
    check(&f, CHUNK_BYTES as u64 + 1, vec![7; CHUNK_BYTES].as_slice()).await;
    check(&f, 1, &[7, 8][..]).await;
    check(&f, 1, FaultAfterOneByte(false)).await;
    check(&f, 2, FaultAfterOneByte(false)).await;
    assert!(f.authorized().await.directory().await.is_ok());
}

#[tokio::test]
async fn client_never_sends_credential_scoped_to_another_verified_responder() {
    let first = Fixture::start().await;
    let second = Fixture::start().await;
    let mut client = second.connect().await;
    assert_eq!(
        client.authorize(&first.scoped_credential()).await,
        Err(ClientError::CredentialScope)
    );
    // The connection still accepts precisely its first valid authentication, showing
    // that the mismatch neither sent a record nor advanced its send nonce.
    client.authorize(&second.scoped_credential()).await.unwrap();
    assert!(client.directory().await.is_ok());
}
