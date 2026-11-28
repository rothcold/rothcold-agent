//! Disposable loopback endpoint, compiled and started only by the opt-in test harness.

use crate::{
    App, Error,
    attachments::{
        self, noise as files,
        noise::{CancelCommit, CommitBoundary},
    },
    lock, sessions, store,
};
use axum::{
    Router,
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::get,
};
use protocol::InvalidRecord;
use rothcold_noise_protocol::{
    self as protocol, CHUNK_BYTES, Client, ErrorCode, HANDSHAKE_PACKET, Key, MAX_PACKET,
    MAX_PLAINTEXT, Record, Server,
};
use std::{io, net::SocketAddrV4, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Semaphore,
    task::spawn_blocking,
    time::{Instant, timeout, timeout_at},
};

const IDLE: Duration = Duration::from_secs(3);
const LIFETIME: Duration = Duration::from_secs(90);
const OPERATIONS: usize = 32;

struct Endpoint {
    app: App,
    host: String,
    private: Key,
    pin: Key,
    connections: Arc<Semaphore>,
}

fn router(addr: SocketAddrV4, app: App, private: Key, pin: Key) -> io::Result<Router> {
    if !addr.ip().is_loopback() {
        return Err(io::Error::other(
            "Noise development endpoint must use IPv4 loopback",
        ));
    }
    files::recover(&app.attachments, &lock(&app.db))?;
    Ok(Router::new()
        .route("/noise", get(upgrade))
        .with_state(Arc::new(Endpoint {
            app,
            host: addr.to_string(),
            private,
            pin,
            connections: Arc::new(Semaphore::new(12)),
        })))
}

async fn upgrade(
    State(endpoint): State<Arc<Endpoint>>,
    uri: Uri,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !crate::only(&headers, header::HOST, &endpoint.host)
        || uri.path() != "/noise"
        || uri.query().is_some()
        || uri.scheme().is_some()
        || uri.authority().is_some()
        || [
            "origin",
            "cookie",
            "authorization",
            "proxy-authorization",
            "sec-fetch-site",
            "sec-websocket-protocol",
            "sec-websocket-extensions",
            "content-length",
            "transfer-encoding",
        ]
        .iter()
        .any(|h| headers.contains_key(*h))
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(permit) = endpoint.connections.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    ws.read_buffer_size(MAX_PACKET)
        .write_buffer_size(0)
        .max_write_buffer_size(2 * MAX_PACKET + 128)
        .max_frame_size(MAX_PACKET)
        .max_message_size(MAX_PACKET)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            let deadline = Instant::now() + LIFETIME;
            let _ = timeout_at(deadline, connection(&endpoint, socket, deadline)).await;
        })
}

#[derive(Debug)]
enum Failure {
    Close,
    Reply(ErrorCode),
}

type Result<T> = std::result::Result<T, Failure>;

impl From<InvalidRecord> for Failure {
    fn from(_: InvalidRecord) -> Self {
        Self::Close
    }
}
impl From<Error> for Failure {
    fn from(error: Error) -> Self {
        Self::Reply(match error.0 {
            StatusCode::BAD_REQUEST => ErrorCode::Invalid,
            StatusCode::NOT_FOUND => ErrorCode::Missing,
            StatusCode::SERVICE_UNAVAILABLE => ErrorCode::Busy,
            _ => ErrorCode::Storage,
        })
    }
}

async fn receive(socket: &mut WebSocket) -> Result<axum::body::Bytes> {
    match timeout(IDLE, socket.recv()).await {
        Ok(Some(Ok(Message::Binary(data)))) => Ok(data),
        _ => Err(Failure::Close),
    }
}

async fn send(socket: &mut WebSocket, packet: Vec<u8>) -> Result<()> {
    timeout(IDLE, socket.send(Message::Binary(packet.into())))
        .await
        .map_err(|_| Failure::Close)?
        .map_err(|_| Failure::Close)
}

async fn handshake(
    endpoint: &Endpoint,
    socket: &mut WebSocket,
) -> Result<protocol::TransportState> {
    let mut state = protocol::responder(&endpoint.private).map_err(|_| Failure::Close)?;
    let first = receive(socket).await?;
    if first.len() != HANDSHAKE_PACKET || state.read_message(&first, &mut []).ok() != Some(0) {
        return Err(Failure::Close);
    }
    let mut reply = vec![0; HANDSHAKE_PACKET];
    if state.write_message(&[], &mut reply).ok() != Some(HANDSHAKE_PACKET) {
        return Err(Failure::Close);
    }
    send(socket, reply).await?;
    state.into_transport_mode().map_err(|_| Failure::Close)
}

struct Connection {
    socket: WebSocket,
    transport: protocol::TransportState,
}

impl Connection {
    async fn receive(&mut self) -> Result<Record<Client>> {
        Ok(protocol::open(
            &mut self.transport,
            &receive(&mut self.socket).await?,
        )?)
    }
    async fn control(&mut self, message: Server) -> Result<()> {
        send(
            &mut self.socket,
            protocol::seal_control(&mut self.transport, &message)?,
        )
        .await
    }
    async fn chunk(&mut self, sequence: u32, data: &[u8]) -> Result<()> {
        send(
            &mut self.socket,
            protocol::seal_chunk(&mut self.transport, sequence, data)?,
        )
        .await
    }
}

async fn connection(endpoint: &Endpoint, mut socket: WebSocket, deadline: Instant) -> Result<()> {
    let transport = handshake(endpoint, &mut socket).await?;
    let mut link = Connection { socket, transport };
    match serve(endpoint, &mut link, deadline).await {
        Err(Failure::Reply(code)) => link.control(Server::Error { code }).await,
        result => result,
    }
}

fn authorize(db: &rusqlite::Connection, pin: &Key, credential: &Key) -> Result<()> {
    match sessions::authenticate_noise_dev(db, pin, credential) {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(Failure::Reply(ErrorCode::Unauthorized)),
        Err(_) => Err(Failure::Reply(ErrorCode::Storage)),
    }
}

async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    spawn_blocking(job)
        .await
        .map_err(|_| Failure::Reply(ErrorCode::Storage))?
}

async fn authorize_request(endpoint: &Endpoint, credential: &Key) -> Result<()> {
    let app = endpoint.app.clone();
    let pin = endpoint.pin;
    let credential = *credential;
    blocking(move || authorize(&lock(&app.db), &pin, &credential)).await
}

async fn serve(endpoint: &Endpoint, link: &mut Connection, deadline: Instant) -> Result<()> {
    let Record::Control(Client::Authenticate { credential }) = link.receive().await? else {
        return Err(Failure::Reply(ErrorCode::Unauthorized));
    };
    authorize_request(endpoint, &credential).await?;
    link.control(Server::Authorized).await?;
    for _ in 0..OPERATIONS {
        let request = link.receive().await?;
        authorize_request(endpoint, &credential).await?;
        match request {
            Record::Control(Client::Directory) => {
                let app = endpoint.app.clone();
                let directory = blocking(move || {
                    store::archive::bounded_directory(&lock(&app.db), MAX_PLAINTEXT - 128)
                        .map_err(|_| Failure::Reply(ErrorCode::Storage))?
                        .ok_or(Failure::Reply(ErrorCode::Limit))
                })
                .await?;
                link.control(Server::Directory { directory }).await?;
            }
            Record::Control(Client::Upload { filename, size }) => {
                upload(endpoint, link, &credential, filename, size, deadline).await?;
            }
            Record::Control(Client::Download { id }) => {
                download(endpoint, link, &credential, &id).await?;
            }
            _ => return Err(Failure::Close),
        }
    }
    Ok(())
}

async fn upload(
    endpoint: &Endpoint,
    link: &mut Connection,
    credential: &Key,
    filename: String,
    size: u64,
    deadline: Instant,
) -> Result<()> {
    if size > attachments::FILE_LIMIT as u64 {
        return Err(Failure::Reply(ErrorCode::Limit));
    }
    if filename.len() > 1024 {
        return Err(Failure::Reply(ErrorCode::Invalid));
    }
    let app = endpoint.app.clone();
    let mut staged =
        blocking(move || Ok(files::StagedUpload::begin(&app, &filename, size)?)).await?;
    staged.classify(&[]);
    link.control(Server::UploadReady).await?;
    let mut remaining = size;
    let mut expected = 0;
    loop {
        let record = link.receive().await?;
        authorize_request(endpoint, credential).await?;
        match record {
            Record::Chunk { sequence, data }
                if remaining != 0
                    && data.len() as u64 == remaining.min(CHUNK_BYTES as u64)
                    && sequence == expected =>
            {
                if expected == 0 {
                    staged.classify(&data);
                }
                staged
                    .file
                    .write_all(&data)
                    .await
                    .map_err(|_| Failure::Reply(ErrorCode::Storage))?;
                remaining -= data.len() as u64;
                expected += 1;
            }
            Record::Control(Client::UploadCancel) => {
                drop(staged);
                return link.control(Server::UploadCancelled).await;
            }
            Record::Control(Client::UploadFinish) if remaining == 0 => break,
            _ => return Err(Failure::Close),
        }
    }
    staged
        .file
        .flush()
        .await
        .map_err(|_| Failure::Reply(ErrorCode::Storage))?;
    let app = endpoint.app.clone();
    let pin = endpoint.pin;
    let credential = *credential;
    // The worker owns the staged bytes and permit even if the async wait ends.
    let cancel = CancelCommit::new(deadline);
    let boundary = cancel.0.clone();
    let worker = blocking(move || {
        staged.prepare_final(&app.attachments)?;
        commit_prepared(&app, staged, &pin, &credential, &boundary)
    });
    let attachment = tokio::select! {
        biased;
        // No request may follow UploadFinish until the acknowledgement.
        _ = link.socket.recv() => return Err(Failure::Close),
        result = worker => result?,
    };
    link.control(Server::UploadComplete { attachment }).await
}

fn commit_prepared(
    app: &App,
    staged: files::StagedUpload,
    pin: &Key,
    credential: &Key,
    boundary: &CommitBoundary,
) -> Result<protocol::Attachment> {
    {
        let mut db = lock(&app.db);
        authorize(&db, pin, credential)?;
        let tx = db.transaction().map_err(Error::from)?;
        staged.record(&tx)?;
        // Before the claim, cancellation rolls back even an inserted row.
        // After the claim, SQLite resolves the commit independently of the socket.
        if !boundary.claim() {
            return Err(Failure::Close);
        }
        tx.commit().map_err(Error::from)?;
    }
    // File cleanup, including error-path Drop, is outside the DB mutex.
    Ok(staged.committed())
}

async fn download(
    endpoint: &Endpoint,
    link: &mut Connection,
    credential: &Key,
    id: &str,
) -> Result<()> {
    let app = endpoint.app.clone();
    let id = id.to_owned();
    let (attachment, mut file, _permit) =
        blocking(move || Ok(files::open_turn(&app, &id)?)).await?;
    let mut remaining = attachment.size;
    let mut buffer = vec![0; CHUNK_BYTES];
    link.control(Server::DownloadStart { attachment }).await?;
    let mut sequence = 0;
    while remaining > 0 {
        let size = remaining.min(CHUNK_BYTES as u64) as usize;
        file.read_exact(&mut buffer[..size])
            .await
            .map_err(|_| Failure::Reply(ErrorCode::Storage))?;
        authorize_request(endpoint, credential).await?;
        link.chunk(sequence, &buffer[..size]).await?;
        remaining -= size as u64;
        sequence += 1;
    }
    authorize_request(endpoint, credential).await?;
    link.control(Server::DownloadComplete).await
}

#[path = "../../tests/noise_dev.rs"]
mod tests;
