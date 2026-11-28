//! Production Noise v1: native TCP and a loopback-only browser connector.
mod auth;
pub mod identity;
mod transfer;
mod workspace;

use crate::{App, Error, S, lock, only};
use axum::{
    Router,
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, Uri, header, uri::Authority},
    response::{IntoResponse, Response},
    routing::get,
    serve::ListenerExt,
};
use rothcold_noise_protocol::{
    Key, TransportState,
    v1::{self, ErrorCode, HANDSHAKE_PACKET, MAX_PACKET, Record, Reply, Request},
};
use std::{
    env,
    io::{self, Write},
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{OwnedSemaphorePermit, Semaphore},
    time::{Instant, timeout, timeout_at},
};

const HANDSHAKE_IDLE: Duration = Duration::from_secs(5);
const IDLE: Duration = Duration::from_secs(30);
const LIFETIME: Duration = Duration::from_secs(20 * 60);
const CONNECT_RATE: usize = 96;
const CONNECT_WINDOW: Duration = Duration::from_secs(10);

pub struct Config {
    pub native: SocketAddr,
    pub browser: Option<BrowserConfig>,
}

pub struct BrowserConfig {
    pub addr: SocketAddr,
    host: String,
    origin: String,
}

fn env_option(key: &str) -> io::Result<Option<String>> {
    match env::var(key) {
        Ok(value) => Ok(Some(value)),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(_) => Err(io::Error::other(format!("Invalid {key}"))),
    }
}

fn parse_addr(value: &str) -> io::Result<SocketAddr> {
    value
        .parse()
        .map_err(|_| io::Error::other("Noise bind must be an explicit IP:port address"))
}

fn safe_native_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_loopback()
                || ip.is_private()
                || (ip.octets()[0] == 100 && (64..128).contains(&ip.octets()[1]))
        }
        IpAddr::V6(ip) => ip.is_loopback() || ip.is_unique_local(),
    }
}

fn exact_authority(s: &str) -> bool {
    !s.contains(['@', '/', '?', '#']) && s.parse::<Authority>().is_ok_and(|a| !a.host().is_empty())
}

impl Config {
    pub fn load() -> io::Result<Self> {
        let native = parse_addr(
            &env_option("ROTHCOLD_NOISE_NATIVE_BIND")?.unwrap_or_else(|| "127.0.0.1:8768".into()),
        )?;
        if !safe_native_address(native.ip()) {
            return Err(io::Error::other(
                "Native Noise bind must be loopback or an explicit private LAN/VPN address",
            ));
        }
        let browser = match (
            env_option("ROTHCOLD_NOISE_WS_BIND")?,
            env_option("ROTHCOLD_NOISE_WS_HOST")?,
            env_option("ROTHCOLD_NOISE_WS_ORIGIN")?,
        ) {
            (None, None, None) => None,
            (Some(addr), Some(host), Some(origin)) => {
                let addr = parse_addr(&addr)?;
                if !addr.ip().is_loopback()
                    || !exact_authority(&host)
                    || !origin.strip_prefix("https://").is_some_and(exact_authority)
                {
                    return Err(io::Error::other(
                        "Browser Noise requires a loopback bind, exact Host and exact HTTPS Origin",
                    ));
                }
                Some(BrowserConfig { addr, host, origin })
            }
            _ => {
                return Err(io::Error::other(
                    "Set all three ROTHCOLD_NOISE_WS_BIND/HOST/ORIGIN settings to enable the browser connector",
                ));
            }
        };
        Ok(Self { native, browser })
    }
}

pub struct Service {
    app: App,
    identity: identity::Identity,
    native_gate: Gate,
    ws_gate: Gate,
}

struct Gate {
    connections: Arc<Semaphore>,
    rate: Mutex<(Instant, usize)>,
}

impl Gate {
    fn new(connections: usize) -> Self {
        Self {
            connections: Arc::new(Semaphore::new(connections)),
            rate: Mutex::new((Instant::now(), 0)),
        }
    }

    fn try_connection(&self) -> std::result::Result<OwnedSemaphorePermit, S> {
        let mut rate = lock(&self.rate);
        let now = Instant::now();
        if now >= rate.0 {
            *rate = (now + CONNECT_WINDOW, 0);
        }
        if rate.1 >= CONNECT_RATE {
            return Err(S::TOO_MANY_REQUESTS);
        }
        rate.1 += 1;
        self.connections
            .clone()
            .try_acquire_owned()
            .map_err(|_| S::SERVICE_UNAVAILABLE)
    }
}

impl Service {
    pub fn new(app: App, identity: identity::Identity) -> Arc<Self> {
        Arc::new(Self {
            app,
            identity,
            native_gate: Gate::new(24),
            ws_gate: Gate::new(24),
        })
    }

    pub async fn native(self: Arc<Self>, listener: TcpListener) -> io::Result<()> {
        loop {
            let (stream, _) = listener.accept().await?;
            if stream.set_nodelay(true).is_err() {
                continue;
            }
            let Ok(permit) = self.native_gate.try_connection() else {
                continue;
            };
            let service = self.clone();
            tokio::spawn(async move { service.connect(Pipe::Native(stream), permit).await });
        }
    }

    pub async fn browser(
        self: Arc<Self>,
        listener: TcpListener,
        config: BrowserConfig,
    ) -> io::Result<()> {
        axum::serve(
            listener.tap_io(|stream| {
                // Noise results use consecutive small records on this proxy hop.
                if let Err(error) = stream.set_nodelay(true) {
                    eprintln!("Could not set TCP_NODELAY on browser Noise socket: {error}");
                }
            }),
            Router::new()
                .route("/noise", get(upgrade))
                .with_state(Arc::new(Browser {
                    service: self,
                    config,
                })),
        )
        .await
    }

    async fn connect(&self, mut pipe: Pipe, _permit: OwnedSemaphorePermit) {
        let deadline = Instant::now() + LIFETIME;
        let Ok(Ok((transport, binding))) =
            timeout(HANDSHAKE_IDLE, handshake(&self.identity.private, &mut pipe)).await
        else {
            return;
        };
        let mut link = Link {
            pipe,
            transport,
            deadline,
        };
        let _ = timeout_at(deadline, self.serve(&mut link, &binding)).await;
    }

    async fn serve(&self, link: &mut Link, binding: &Key) -> LinkResult<()> {
        let pin = &self.identity.pin;
        let mut authorized = None;
        loop {
            let Record::Control(request) = link.receive().await? else {
                return Err(Failure::Close);
            };
            let outcome = match (link.pipe.browser(), request) {
                (_, Request::Status) => Ok(v1::Outcome::Status {
                    service: "rothcold-agent".into(),
                    version: v1::VERSION,
                }),
                (false, Request::LoginNative { owner_token, name }) if authorized.is_none() => {
                    establish(
                        &mut authorized,
                        auth::login_native(&self.app, pin, &owner_token, &name),
                    )
                }
                (
                    false,
                    Request::ResumeNative {
                        pin: requested,
                        credential,
                    },
                ) if *pin == requested && authorized.is_none() => establish(
                    &mut authorized,
                    auth::resume_native(&self.app, pin, &credential),
                ),
                (
                    true,
                    Request::RegisterBrowser {
                        pin: requested,
                        owner_token,
                        name,
                        public_key,
                        signature,
                    },
                ) if *pin == requested && authorized.is_none() => {
                    let proof = auth::BrowserProof {
                        pin,
                        binding,
                        public_key: &public_key,
                        signature: &signature,
                    };
                    establish(
                        &mut authorized,
                        proof.register(&self.app, &owner_token, &name),
                    )
                }
                (
                    true,
                    Request::ResumeBrowser {
                        pin: requested,
                        id,
                        public_key,
                        signature,
                    },
                ) if *pin == requested && authorized.is_none() => {
                    let proof = auth::BrowserProof {
                        pin,
                        binding,
                        public_key: &public_key,
                        signature: &signature,
                    };
                    establish(&mut authorized, proof.resume(&self.app, &id))
                }
                (_, request) => {
                    let Some(hash) = &authorized else {
                        link.error(crate::UNAUTHORIZED).await?;
                        continue;
                    };
                    match request {
                        Request::Upload {
                            purpose,
                            filename,
                            size,
                            mime,
                        } => {
                            let result = transfer::upload(
                                &self.app, hash, link, purpose, filename, size, mime,
                            )
                            .await;
                            link.transfer_result(result).await?;
                            continue;
                        }
                        Request::Download { id } => {
                            let result = transfer::download(&self.app, hash, link, &id).await;
                            link.transfer_result(result).await?;
                            continue;
                        }
                        request => workspace::execute(&self.app, hash, request).await,
                    }
                }
            };
            match outcome {
                Ok(outcome) => link.outcome(outcome).await?,
                Err(error) => link.error(error).await?,
            }
        }
    }
}

fn establish(
    authorized: &mut Option<auth::Authorization>,
    result: crate::Result<(auth::Authorization, v1::Outcome)>,
) -> crate::Result<v1::Outcome> {
    let (hash, outcome) = result?;
    *authorized = Some(hash);
    Ok(outcome)
}

struct Browser {
    service: Arc<Service>,
    config: BrowserConfig,
}

async fn upgrade(
    State(browser): State<Arc<Browser>>,
    uri: Uri,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !only(&headers, header::HOST, &browser.config.host)
        || !only(&headers, header::ORIGIN, &browser.config.origin)
        || headers.get_all("sec-websocket-key").iter().count() != 1
        || !only(
            &headers,
            axum::http::HeaderName::from_static("sec-websocket-version"),
            "13",
        )
        || uri.path() != "/noise"
        || uri.query().is_some()
        || uri.scheme().is_some()
        || uri.authority().is_some()
        || [
            "cookie",
            "authorization",
            "proxy-authorization",
            "sec-websocket-protocol",
            "content-length",
            "transfer-encoding",
        ]
        .iter()
        .any(|key| headers.contains_key(*key))
    {
        return S::FORBIDDEN.into_response();
    }
    let permit = match browser.service.ws_gate.try_connection() {
        Ok(permit) => permit,
        Err(status) => return status.into_response(),
    };
    ws.read_buffer_size(MAX_PACKET)
        .write_buffer_size(0)
        .max_write_buffer_size(2 * MAX_PACKET + 128)
        .max_frame_size(MAX_PACKET)
        .max_message_size(MAX_PACKET)
        .on_upgrade(move |socket| async move {
            browser
                .service
                .connect(Pipe::Browser(Box::new(socket)), permit)
                .await
        })
}

#[derive(Debug)]
enum Failure {
    Close,
    Reply(Error),
}
type LinkResult<T> = std::result::Result<T, Failure>;

impl From<v1::InvalidRecord> for Failure {
    fn from(_: v1::InvalidRecord) -> Self {
        Self::Close
    }
}
impl From<Error> for Failure {
    fn from(error: Error) -> Self {
        Self::Reply(error)
    }
}

enum Pipe {
    Native(TcpStream),
    Browser(Box<WebSocket>),
}

impl Pipe {
    fn browser(&self) -> bool {
        matches!(self, Self::Browser(_))
    }

    async fn receive(&mut self) -> LinkResult<Vec<u8>> {
        match self {
            Self::Native(stream) => {
                let len = stream.read_u16().await.map_err(|_| Failure::Close)? as usize;
                if len == 0 {
                    return Err(Failure::Close);
                }
                let mut bytes = vec![0; len];
                stream
                    .read_exact(&mut bytes)
                    .await
                    .map_err(|_| Failure::Close)?;
                Ok(bytes)
            }
            Self::Browser(ws) => match ws.recv().await {
                Some(Ok(Message::Binary(bytes))) => Ok(bytes.to_vec()),
                _ => Err(Failure::Close),
            },
        }
    }

    async fn send(&mut self, packet: Vec<u8>) -> LinkResult<()> {
        match self {
            Self::Native(stream) => {
                let len = u16::try_from(packet.len()).map_err(|_| Failure::Close)?;
                stream.write_u16(len).await.map_err(|_| Failure::Close)?;
                stream.write_all(&packet).await.map_err(|_| Failure::Close)
            }
            Self::Browser(ws) => ws
                .send(Message::Binary(packet.into()))
                .await
                .map_err(|_| Failure::Close),
        }
    }

    async fn wait_for_peer(&mut self) {
        match self {
            Self::Native(stream) => {
                let _ = stream.read_u8().await;
            }
            Self::Browser(ws) => {
                let _ = ws.recv().await;
            }
        }
    }
}

async fn handshake(private: &Key, pipe: &mut Pipe) -> LinkResult<(TransportState, Key)> {
    let mut state = v1::responder(private).map_err(|_| Failure::Close)?;
    let first = pipe.receive().await?;
    if first.len() != HANDSHAKE_PACKET || state.read_message(&first, &mut []).ok() != Some(0) {
        return Err(Failure::Close);
    }
    let mut reply = vec![0; HANDSHAKE_PACKET];
    if state.write_message(&[], &mut reply).ok() != Some(HANDSHAKE_PACKET) {
        return Err(Failure::Close);
    }
    pipe.send(reply).await?;
    let binding = v1::handshake_binding(&state)?;
    Ok((
        state.into_transport_mode().map_err(|_| Failure::Close)?,
        binding,
    ))
}

struct Link {
    pipe: Pipe,
    transport: TransportState,
    deadline: Instant,
}

impl Link {
    async fn receive(&mut self) -> LinkResult<Record<Request>> {
        let packet = timeout(IDLE, self.pipe.receive())
            .await
            .map_err(|_| Failure::Close)??;
        Ok(v1::open(&mut self.transport, &packet)?)
    }

    async fn send(&mut self, packet: Vec<u8>) -> LinkResult<()> {
        timeout(IDLE, self.pipe.send(packet))
            .await
            .map_err(|_| Failure::Close)?
    }

    async fn reply(&mut self, response: Reply) -> LinkResult<()> {
        let packet = v1::seal_control(&mut self.transport, &response)?;
        self.send(packet).await
    }

    async fn chunk(&mut self, sequence: u32, data: &[u8]) -> LinkResult<()> {
        let packet = v1::seal_chunk(&mut self.transport, sequence, data)?;
        self.send(packet).await
    }

    async fn outcome(&mut self, outcome: v1::Outcome) -> LinkResult<()> {
        // Serialize before publishing a start record; a partial serialization is not a result.
        struct Bounded(Vec<u8>);
        impl Write for Bounded {
            fn write(&mut self, data: &[u8]) -> io::Result<usize> {
                if data.len() > v1::MAX_RESULT - self.0.len() {
                    return Err(io::Error::other("Noise result exceeds limit"));
                }
                self.0.extend_from_slice(data);
                Ok(data.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let mut bytes = Bounded(Vec::new());
        if serde_json::to_writer(&mut bytes, &outcome).is_err() {
            return self
                .error(Error(
                    S::PAYLOAD_TOO_LARGE,
                    "Workspace record exceeds response limit",
                ))
                .await;
        }
        self.reply(Reply::ResultStart {
            size: bytes.0.len() as u64,
        })
        .await?;
        for (i, data) in bytes.0.chunks(v1::CHUNK_BYTES).enumerate() {
            self.chunk(i as u32, data).await?;
        }
        self.reply(Reply::ResultComplete).await
    }

    async fn transfer_result(&mut self, result: LinkResult<()>) -> LinkResult<()> {
        match result {
            Err(Failure::Reply(error)) => self.error(error).await,
            result => result,
        }
    }

    async fn error(&mut self, error: Error) -> LinkResult<()> {
        let code = match error.0 {
            S::UNAUTHORIZED => ErrorCode::Unauthorized,
            S::BAD_REQUEST => ErrorCode::Invalid,
            S::NOT_FOUND => ErrorCode::Missing,
            S::CONFLICT => ErrorCode::Conflict,
            S::PAYLOAD_TOO_LARGE => ErrorCode::Limit,
            S::TOO_MANY_REQUESTS => ErrorCode::RateLimited,
            S::SERVICE_UNAVAILABLE => ErrorCode::Busy,
            _ => ErrorCode::Storage,
        };
        self.reply(Reply::Error {
            code,
            message: error.1.into(),
        })
        .await
    }
}
