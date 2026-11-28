//! Black-box smoke against the normal executable and disposable synthetic workspaces.
mod noise_fixture_client;

use futures_util::{SinkExt, StreamExt};
use noise_fixture_client::{Client, parse_pin, send_raw};
use ring::{
    rand::SystemRandom,
    signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair},
};
use rothcold_noise_protocol::{
    Key,
    v1::{self, ErrorCode, Initiator, Outcome, Record, Reply, Request},
};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::Path,
    process::{Child, Command, Stdio},
    time::Duration,
};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};
use uuid::Uuid;

const OWNER: &str = "synthetic-owner-never-use-outside-disposable-fixtures";
const ADAPTER: &str = "separate-synthetic-fixture-adapter-authority";
const ORIGIN: &str = "https://workspace.fixture.invalid:8443";
const HOST: &str = "connector.fixture.invalid:8443";
const BINARY: &str = env!("CARGO_BIN_EXE_rothcold-agent");

struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn pin(dir: &Path) -> Key {
    let output = Command::new(BINARY)
        .env_clear()
        .env("ROTHCOLD_DATA_DIR", dir)
        .arg("noise-pin")
        .output()
        .unwrap();
    assert!(output.status.success(), "noise-pin failed");
    parse_pin(std::str::from_utf8(&output.stdout).unwrap()).unwrap()
}

fn server(dir: &Path) -> (Server, SocketAddr, SocketAddr) {
    let child = Command::new(BINARY)
        .env_clear()
        .env("ROTHCOLD_DATA_DIR", dir)
        .env("ROTHCOLD_AGENT_OWNER_TOKEN", OWNER)
        .env("ROTHCOLD_AGENT_ADAPTER_TOKEN", ADAPTER)
        .env("ROTHCOLD_NOISE_NATIVE_BIND", "127.0.0.1:0")
        .env("ROTHCOLD_NOISE_WS_BIND", "127.0.0.1:0")
        .env("ROTHCOLD_NOISE_WS_HOST", HOST)
        .env("ROTHCOLD_NOISE_WS_ORIGIN", ORIGIN)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut child = Server(child);
    let lines: Vec<_> = BufReader::new(child.0.stdout.take().unwrap())
        .lines()
        .take(3)
        .map(|line| line.unwrap())
        .collect();
    assert_eq!(
        lines.len(),
        3,
        "could not launch normal binary; test requires exclusive loopback adapter port 8766"
    );
    let addr = |index: usize| {
        lines[index]
            .split_whitespace()
            .last()
            .unwrap()
            .parse()
            .unwrap()
    };
    (child, addr(1), addr(2))
}

fn http(addr: &str, path: &str, token: &str, origin: &str, body: Option<&str>) -> (u16, String) {
    let mut stream = TcpStream::connect(addr).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let method = if body.is_some() { "POST" } else { "GET" };
    write!(stream, "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nOrigin: {origin}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n").unwrap();
    if let Some(body) = body {
        write!(
            stream,
            "Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
    } else {
        write!(stream, "\r\n").unwrap();
    }
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    let (head, body) = response.split_once("\r\n\r\n").unwrap();
    (
        head.split_whitespace().nth(1).unwrap().parse().unwrap(),
        body.to_owned(),
    )
}

fn adapter(path: &str, data: Value) -> Value {
    let (status, body) = http(
        "127.0.0.1:8766",
        &format!("/adapter/{path}"),
        ADAPTER,
        "http://127.0.0.1:8766",
        Some(&data.to_string()),
    );
    assert_eq!(status, 200, "adapter {path}: {body}");
    serde_json::from_str(&body).unwrap()
}

fn result(client: &mut Client, request: Request) -> Outcome {
    client
        .exchange(&request)
        .unwrap()
        .unwrap_or_else(|error| panic!("{}", serde_json::to_string(&error).unwrap()))
}

fn denied(client: &mut Client, request: Request, expected: ErrorCode) {
    assert!(
        matches!(client.exchange(&request).unwrap(), Err(Reply::Error { code, .. }) if code == expected)
    );
}

fn login(client: &mut Client, token: &str) -> (Key, v1::Device) {
    let Outcome::NativeLogin {
        credential, device, ..
    } = result(
        client,
        Request::LoginNative {
            owner_token: token.into(),
            name: "Synthetic Native".into(),
        },
    )
    else {
        panic!("wrong login result")
    };
    (credential, device)
}

fn message(text: &str) -> v1::Message {
    v1::Message {
        id: Uuid::new_v4().to_string(),
        text: text.into(),
        attachments: vec![],
    }
}

fn download(client: &mut Client, id: String) -> Vec<u8> {
    client.send(&Request::Download { id }).unwrap();
    let Record::Control(Reply::DownloadStart { attachment }) = client.receive().unwrap() else {
        panic!("download start")
    };
    let mut output = Vec::new();
    let mut index = 0;
    loop {
        client.send(&Request::DownloadNext).unwrap();
        match client.receive().unwrap() {
            Record::Chunk { sequence, data } => {
                assert_eq!(sequence, index);
                index += 1;
                output.extend(data);
            }
            Record::Control(Reply::DownloadComplete) => break,
            _ => panic!("unexpected download reply"),
        }
    }
    assert_eq!(output.len() as u64, attachment.size);
    output
}

type BrowserSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn web(
    addr: SocketAddr,
    origin: Option<&str>,
    host: &str,
) -> Result<BrowserSocket, tokio_tungstenite::tungstenite::Error> {
    let mut request = format!("ws://{addr}/noise").into_client_request().unwrap();
    request.headers_mut().insert("Host", host.parse().unwrap());
    if let Some(origin) = origin {
        request
            .headers_mut()
            .insert("Origin", origin.parse().unwrap());
    }
    connect_async(request).await.map(|(socket, _)| socket)
}

async fn web_verify(socket: &mut BrowserSocket, pin: Key) -> v1::VerifiedClient {
    let (verify, first) = Initiator::start(pin).unwrap();
    socket
        .send(Message::Binary(first.to_vec().into()))
        .await
        .unwrap();
    let Message::Binary(data) = socket.next().await.unwrap().unwrap() else {
        panic!("Noise handshake frame was not binary")
    };
    verify.verify(&data).unwrap()
}

async fn web_request(
    socket: &mut BrowserSocket,
    codec: &mut v1::VerifiedClient,
    request: &Request,
) -> Result<Outcome, ErrorCode> {
    socket
        .send(Message::Binary(codec.request(request).unwrap().into()))
        .await
        .unwrap();
    let mut result = None;
    loop {
        let Message::Binary(data) = socket.next().await.unwrap().unwrap() else {
            panic!("unexpected WS frame")
        };
        match codec.response(&data).unwrap() {
            Record::Control(Reply::Error { code, .. }) => return Err(code),
            Record::Control(Reply::ResultStart { size }) => {
                result = Some(v1::ResultReader::new(size).unwrap())
            }
            Record::Chunk { sequence, data } => {
                result.as_mut().unwrap().chunk(sequence, &data).unwrap()
            }
            Record::Control(Reply::ResultComplete) => return Ok(result.unwrap().finish().unwrap()),
            _ => panic!("unexpected WS reply"),
        }
    }
}

async fn browser_scope(
    addr: SocketAddr,
    pin: Key,
    native_credential: Key,
) -> (v1::Device, BrowserSocket, v1::VerifiedClient) {
    for (origin, host) in [
        (None, HOST),
        (Some("null"), HOST),
        (Some("https://foreign.invalid"), HOST),
        (Some(ORIGIN), "wrong.fixture.invalid"),
    ] {
        assert!(
            matches!(web(addr, origin, host).await, Err(tokio_tungstenite::tungstenite::Error::Http(response)) if response.status() == 403)
        );
    }
    let mut ws = web(addr, Some(ORIGIN), HOST).await.unwrap();
    let mut channel = web_verify(&mut ws, pin).await;
    assert!(matches!(
        web_request(
            &mut ws,
            &mut channel,
            &Request::ResumeNative {
                pin,
                credential: native_credential
            }
        )
        .await,
        Err(ErrorCode::Unauthorized)
    ));
    let rand = SystemRandom::new();
    let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rand).unwrap();
    let key =
        EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rand).unwrap();
    let public_key = key.public_key().as_ref().to_vec();
    let sign = |channel: &v1::VerifiedClient, register, id| {
        key.sign(&rand, &channel.browser_proof(register, id, &public_key))
            .unwrap()
            .as_ref()
            .to_vec()
    };
    let request = Request::RegisterBrowser {
        pin,
        owner_token: OWNER.into(),
        name: "Synthetic browser".into(),
        signature: sign(&channel, true, ""),
        public_key: public_key.clone(),
    };
    let Outcome::Device { device } = web_request(&mut ws, &mut channel, &request).await.unwrap()
    else {
        panic!("browser received unexpected login result (no bearer allowed)")
    };
    assert!(matches!(
        web_request(
            &mut ws,
            &mut channel,
            &Request::Categories {
                include_archived: true,
                after: None
            }
        )
        .await,
        Ok(Outcome::Categories { .. })
    ));
    let stale = sign(&channel, false, &device.id);
    drop(ws);
    let mut ws = web(addr, Some(ORIGIN), HOST).await.unwrap();
    let mut channel = web_verify(&mut ws, pin).await;
    let resume = |signature| Request::ResumeBrowser {
        pin,
        id: device.id.clone(),
        public_key: public_key.clone(),
        signature,
    };
    assert!(matches!(
        web_request(&mut ws, &mut channel, &resume(stale)).await,
        Err(ErrorCode::Unauthorized)
    ));
    let fresh = sign(&channel, false, &device.id);
    assert!(matches!(
        web_request(&mut ws, &mut channel, &resume(fresh)).await,
        Ok(Outcome::Device { .. })
    ));
    (device, ws, channel)
}

async fn web_download(
    socket: &mut BrowserSocket,
    codec: &mut v1::VerifiedClient,
    id: String,
) -> Vec<u8> {
    async fn record(
        socket: &mut BrowserSocket,
        codec: &mut v1::VerifiedClient,
        request: Request,
    ) -> Record<Reply> {
        socket
            .send(Message::Binary(codec.request(&request).unwrap().into()))
            .await
            .unwrap();
        let Message::Binary(packet) = socket.next().await.unwrap().unwrap() else {
            panic!("nonbinary reply")
        };
        codec.response(&packet).unwrap()
    }
    let Record::Control(Reply::DownloadStart { attachment }) =
        record(socket, codec, Request::Download { id }).await
    else {
        panic!("download not started")
    };
    let mut output = Vec::new();
    let mut expected = 0;
    loop {
        match record(socket, codec, Request::DownloadNext).await {
            Record::Chunk { sequence, data } => {
                assert_eq!(sequence, expected);
                expected += 1;
                output.extend(data);
            }
            Record::Control(Reply::DownloadComplete) => break,
            _ => panic!("unexpected download reply"),
        }
    }
    assert_eq!(output.len() as u64, attachment.size);
    output
}

fn connect_restored(addr: SocketAddr, pin: Key, credential: Key) -> Client {
    let mut client = Client::connect(addr, pin).unwrap();
    assert!(matches!(
        result(&mut client, Request::ResumeNative { pin, credential }),
        Outcome::Device { .. }
    ));
    client
}

fn fixture_transfer_slots(addr: SocketAddr, pin: Key, credential: Key, dir: &Path) {
    let mut clients: Vec<_> = (0..3)
        .map(|_| connect_restored(addr, pin, credential))
        .collect();
    for (index, client) in clients.iter_mut().enumerate() {
        client
            .send(&Request::Upload {
                purpose: v1::UploadPurpose::Turn,
                filename: "pending.txt".into(),
                size: 4,
                mime: None,
            })
            .unwrap();
        if index < 2 {
            assert!(matches!(
                client.receive().unwrap(),
                Record::Control(Reply::UploadReady)
            ));
        } else {
            assert!(matches!(
                client.receive().unwrap(),
                Record::Control(Reply::Error {
                    code: ErrorCode::Busy,
                    ..
                })
            ));
        }
    }
    for client in &mut clients[..2] {
        client.send(&Request::UploadCancel).unwrap();
        assert!(matches!(
            client.receive().unwrap(),
            Record::Control(Reply::UploadCancelled)
        ));
    }
    assert!(!fs::read_dir(dir.join("attachments")).unwrap().any(|f| {
        f.unwrap()
            .file_name()
            .to_str()
            .unwrap()
            .starts_with(".noise-upload-")
    }));
    assert!(matches!(
        clients[2]
            .upload(v1::UploadPurpose::Turn, "slot.txt".into(), b"test")
            .unwrap(),
        Reply::UploadComplete { .. }
    ));
}

#[test]
fn normal_binary_serves_typed_noise_and_keeps_only_adapter_http() {
    let scratch = tempfile::tempdir().unwrap();
    let dir = scratch.path().join("workspace");
    let server_pin = pin(&dir);
    assert_eq!(pin(&dir), server_pin);
    let metadata = fs::metadata(dir.join("noise-v1.identity")).unwrap();
    assert_eq!(metadata.mode() & 0o777, 0o600);
    let (server_process, native, ws) = server(&dir);
    assert!(Client::connect(native, [0x90; 32]).is_err());
    let adapter_addr = "127.0.0.1:8766";
    assert_eq!(
        http(
            adapter_addr,
            "/api/status",
            ADAPTER,
            "http://127.0.0.1:8766",
            None
        )
        .0,
        404
    );
    assert_eq!(
        http(
            &ws.to_string(),
            "/adapter/claim",
            ADAPTER,
            ORIGIN,
            Some("{}")
        )
        .0,
        404
    );
    assert_eq!(
        http(&ws.to_string(), "/api/login", OWNER, ORIGIN, Some("{}")).0,
        404
    );
    assert_eq!(
        http(
            adapter_addr,
            "/adapter/claim",
            OWNER,
            "http://127.0.0.1:8766",
            Some("{}")
        )
        .0,
        401
    );
    assert_eq!(
        http(adapter_addr, "/adapter/claim", ADAPTER, ORIGIN, Some("{}")).0,
        403
    );

    let mut client = Client::connect(native, server_pin).unwrap();
    assert!(matches!(
        result(&mut client, Request::Status),
        Outcome::Status { version: 1, .. }
    ));
    denied(
        &mut client,
        Request::Categories {
            include_archived: true,
            after: None,
        },
        ErrorCode::Unauthorized,
    );
    denied(
        &mut client,
        Request::LoginNative {
            owner_token: ADAPTER.into(),
            name: "Wrong authority".into(),
        },
        ErrorCode::Unauthorized,
    );
    let (credential, device) = login(&mut client, OWNER);
    let forbidden_pin = Request::ResumeNative {
        pin: [0x89; 32],
        credential,
    };
    assert!(client.transport.request(&forbidden_pin).is_err());
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let (browser, mut browser_socket, mut browser_codec) = runtime.block_on(async {
        tokio::time::timeout(
            Duration::from_secs(10),
            browser_scope(ws, server_pin, credential),
        )
        .await
        .unwrap()
    });
    let mut category = String::new();
    for i in 0..19 {
        let Outcome::CategoryCreated { id } = result(
            &mut client,
            Request::CreateCategory {
                name: format!("Category {i}"),
            },
        ) else {
            panic!("category result")
        };
        category = id;
    }
    let Outcome::Categories { page } = result(
        &mut client,
        Request::Categories {
            include_archived: true,
            after: None,
        },
    ) else {
        panic!("categories result")
    };
    assert_eq!(page.items.len(), 16);
    assert!(
        matches!(result(&mut client, Request::Categories { include_archived: true, after: page.next }), Outcome::Categories { page } if page.items.len() == 4 && page.next.is_none())
    );
    let png = b"\x89PNG\r\n\x1a\nfixture";
    assert!(matches!(
        client
            .upload(v1::UploadPurpose::Avatar, "avatar.svg".into(), b"<svg/>")
            .unwrap(),
        Reply::Error {
            code: ErrorCode::Invalid,
            ..
        }
    ));
    let Reply::UploadComplete { attachment: avatar } = client
        .upload(v1::UploadPurpose::Avatar, "avatar.png".into(), png)
        .unwrap()
    else {
        panic!("avatar upload")
    };
    assert_eq!(download(&mut client, avatar.id.clone()), png);
    let profile = Request::UpdateProfile {
        owner: Some(v1::IdentityPatch {
            name: Some("Fixture Owner".into()),
            avatar: Some(v1::AvatarPatch::Set { id: avatar.id }),
        }),
        agent: None,
    };
    assert!(
        matches!(result(&mut client, profile), Outcome::Profile { profile } if profile.owner.name == "Fixture Owner")
    );
    adapter(
        "profile",
        json!({"kind":"hermes","backend":"hermes","name":"Fixture Agent","avatar":null}),
    );
    assert!(
        matches!(result(&mut client, Request::SyncProfile { backend: None }), Outcome::Profile { profile } if profile.agent.name == "Fixture Agent" && profile.sync.is_some())
    );
    adapter(
        "slash-catalog",
        json!({"catalog":{"commands":["sethome"],"skills":["sample"]}}),
    );
    assert!(
        matches!(result(&mut client, Request::SlashCatalog), Outcome::SlashCatalog { catalog: Some(catalog) } if catalog.skills == ["sample"])
    );

    fixture_transfer_slots(native, server_pin, credential, &dir);
    let bytes: Vec<_> = (0..98_321).map(|i| (i % 251) as u8).collect();
    let Reply::UploadComplete { attachment } = client
        .upload(v1::UploadPurpose::Turn, "notes.html".into(), &bytes)
        .unwrap()
    else {
        panic!("attachment upload")
    };
    assert_eq!(attachment.kind, "file");
    assert_eq!(
        http(
            adapter_addr,
            &format!("/adapter/attachments/{}", attachment.id),
            ADAPTER,
            "http://127.0.0.1:8766",
            None
        )
        .0,
        404
    );
    let mut reader = Client::connect(native, server_pin).unwrap();
    assert!(matches!(
        result(
            &mut reader,
            Request::ResumeNative {
                pin: server_pin,
                credential
            }
        ),
        Outcome::Device { .. }
    ));
    assert_eq!(download(&mut reader, attachment.id.clone()), bytes);
    let from_ws = runtime.block_on(async {
        tokio::time::timeout(
            Duration::from_secs(10),
            web_download(
                &mut browser_socket,
                &mut browser_codec,
                attachment.id.clone(),
            ),
        )
        .await
        .unwrap()
    });
    assert_eq!(from_ws, bytes);
    assert!(matches!(
        result(&mut client, Request::RevokeDevice { id: browser.id }),
        Outcome::Revoked { current: false }
    ));
    assert!(matches!(
        runtime.block_on(web_request(
            &mut browser_socket,
            &mut browser_codec,
            &Request::Me
        )),
        Err(ErrorCode::Unauthorized)
    ));

    let mut first = message("First real Noise turn");
    let chat = first.id.clone();
    first.attachments.push(attachment.id);
    assert!(matches!(
        result(
            &mut client,
            Request::StartThread {
                channel: category.clone(),
                message: first
            }
        ),
        Outcome::ThreadStarted { fresh: true, .. }
    ));
    let next = message("Second remains queued until recovery");
    let next_id = next.id.clone();
    assert!(matches!(
        result(
            &mut client,
            Request::SendTurn {
                chat: chat.clone(),
                message: next
            }
        ),
        Outcome::TurnSent { fresh: true, .. }
    ));
    assert_eq!(adapter("claim", json!({}))["id"], chat);
    adapter("admission", json!({"id":chat,"accepted":true}));
    assert!(adapter("claim", json!({})).is_null());
    let prompt = "approval-fixture";
    adapter(
        "update",
        json!({"chat":chat,"turn":chat,"id":prompt,"kind":"commentary","text":"Approval is required"}),
    );
    let cards = json!({"approvals":[{"chat":chat,"id":prompt,"choices":["once","deny"]}]});
    assert!(adapter("claim", cards.clone()).is_null());
    assert!(
        matches!(result(&mut client, Request::TurnUpdates { chat: chat.clone(), turn: chat.clone(), after: None }), Outcome::TurnUpdates { page } if page.items[0].choices.len() == 2)
    );
    denied(
        &mut client,
        Request::DecideApproval {
            chat: chat.clone(),
            id: prompt.into(),
            choice: v1::ApprovalChoice::Session,
        },
        ErrorCode::Conflict,
    );
    assert!(matches!(
        result(
            &mut client,
            Request::DecideApproval {
                chat: chat.clone(),
                id: prompt.into(),
                choice: v1::ApprovalChoice::Once
            }
        ),
        Outcome::Ok
    ));
    assert_eq!(adapter("claim", cards)["choice"], "once");
    adapter("connect", json!({}));
    assert!(adapter("claim", json!({})).is_null());
    assert!(matches!(
        result(
            &mut client,
            Request::ReleaseTurn {
                chat: chat.clone(),
                id: chat.clone()
            }
        ),
        Outcome::Ok
    ));
    assert_eq!(adapter("claim", json!({}))["id"], next_id);
    let long = "\u{0001}".repeat(65_536);
    adapter("final", json!({"chat":chat,"id":chat,"text":long}));
    let Outcome::History { page } = result(
        &mut client,
        Request::History {
            chat: chat.clone(),
            after: None,
        },
    ) else {
        panic!("history result")
    };
    assert_eq!(page.items[0].answer.as_deref(), Some(long.as_str()));
    assert!(
        matches!(result(&mut client, Request::History { chat: chat.clone(), after: page.next }), Outcome::History { page } if page.items[0].id == next_id)
    );
    assert!(matches!(
        result(
            &mut client,
            Request::ArchiveCategory {
                id: category,
                archived: true
            }
        ),
        Outcome::Archived { archived: true }
    ));
    assert!(
        matches!(result(&mut client, Request::Threads { include_archived: false, after: None }), Outcome::Threads { page } if page.items.is_empty())
    );
    assert!(
        matches!(result(&mut client, Request::Threads { include_archived: true, after: None }), Outcome::Threads { page } if !page.items[0].archived)
    );
    assert!(
        matches!(result(&mut client, Request::Inbox { after: None }), Outcome::Inbox { page } if page.items[0].unread)
    );
    assert!(matches!(
        result(
            &mut client,
            Request::ReadReply {
                chat: chat.clone(),
                id: chat
            }
        ),
        Outcome::Ok
    ));
    assert!(
        matches!(result(&mut client, Request::Inbox { after: None }), Outcome::Inbox { page } if !page.items[0].unread)
    );

    let mut replay = Client::connect(native, server_pin).unwrap();
    let encrypted = replay.transport.request(&Request::Status).unwrap();
    send_raw(&mut replay.socket, &encrypted).unwrap();
    assert!(matches!(
        replay.receive().unwrap(),
        Record::Control(Reply::ResultStart { .. })
    ));
    assert!(matches!(replay.receive().unwrap(), Record::Chunk { .. }));
    assert!(matches!(
        replay.receive().unwrap(),
        Record::Control(Reply::ResultComplete)
    ));
    send_raw(&mut replay.socket, &encrypted).unwrap();
    assert!(replay.receive().is_err());

    drop(server_process);
    assert_eq!(pin(&dir), server_pin);
    let (_restarted, native, _) = server(&dir);
    let mut restored = Client::connect(native, server_pin).unwrap();
    assert!(
        matches!(result(&mut restored, Request::ResumeNative { pin: server_pin, credential }), Outcome::Device { device: current } if current.id == device.id)
    );
    assert!(matches!(
        result(&mut restored, Request::Logout),
        Outcome::Ok
    ));
    denied(&mut restored, Request::Me, ErrorCode::Unauthorized);
    let mut revoked = Client::connect(native, server_pin).unwrap();
    denied(
        &mut revoked,
        Request::ResumeNative {
            pin: server_pin,
            credential,
        },
        ErrorCode::Unauthorized,
    );
    let mut expired = Client::connect(native, server_pin).unwrap();
    let (expired_credential, expired_device) = login(&mut expired, OWNER);
    let db = rusqlite::Connection::open(dir.join("history.sqlite3")).unwrap();
    assert_eq!(
        db.execute(
            "UPDATE device_sessions SET expires_at=1 WHERE id=?",
            [&expired_device.id],
        )
        .unwrap(),
        1,
    );
    drop(db);
    denied(&mut expired, Request::Me, ErrorCode::Unauthorized);
    let mut expiry_check = Client::connect(native, server_pin).unwrap();
    denied(
        &mut expiry_check,
        Request::ResumeNative {
            pin: server_pin,
            credential: expired_credential,
        },
        ErrorCode::Unauthorized,
    );
    for _ in 0..8 {
        denied(
            &mut revoked,
            Request::LoginNative {
                owner_token: "not-the-owner".repeat(4),
                name: "Fixture".into(),
            },
            ErrorCode::Unauthorized,
        );
    }
    denied(
        &mut revoked,
        Request::LoginNative {
            owner_token: OWNER.into(),
            name: "Fixture".into(),
        },
        ErrorCode::RateLimited,
    );
    fs::set_permissions(
        dir.join("noise-v1.identity"),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert!(
        !Command::new(BINARY)
            .env_clear()
            .env("ROTHCOLD_DATA_DIR", &dir)
            .arg("noise-pin")
            .output()
            .unwrap()
            .status
            .success()
    );
    // Start a normal binary on the unchanged v2 fixture, not a hand-built v7 DB.
    drop(_restarted);
    let legacy = scratch.path().join("legacy");
    let legacy_pin = pin(&legacy);
    let db = rusqlite::Connection::open(legacy.join("history.sqlite3")).unwrap();
    db.execute_batch(include_str!("python-v2.sql")).unwrap();
    db.pragma_update(None, "user_version", 2).unwrap();
    drop(db);
    let (_legacy, addr, _) = server(&legacy);
    let mut client = Client::connect(addr, legacy_pin).unwrap();
    login(&mut client, OWNER);
    assert!(
        matches!(result(&mut client, Request::Threads { include_archived: true, after: None }), Outcome::Threads { page } if page.items[0].id == "old")
    );
    assert!(
        matches!(result(&mut client, Request::History { chat: "old".into(), after: None }), Outcome::History { page } if !page.items.is_empty())
    );
    let db = rusqlite::Connection::open(legacy.join("history.sqlite3")).unwrap();
    let version: u32 = db
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    assert_eq!(version, 7);
}
