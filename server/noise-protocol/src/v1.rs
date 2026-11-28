//! Authoritative production v1 application messages, framing and client handshake.

use crate::{Key, TAG_BYTES};
use serde::{Deserialize, Serialize};
use snow::{Builder, HandshakeState, TransportState};

pub use crate::{Attachment, CHUNK_BYTES, HANDSHAKE_PACKET, InvalidRecord, Record, seal_chunk};

pub const PROLOGUE: &[u8] = b"rothcold-agent/noise/1";
pub const MAX_PACKET: usize = 65535;
pub const MAX_RESULT: usize = 512 * 1024;
pub const VERSION: u16 = 1;
const PROOF_DOMAIN: &[u8] = b"rothcold-agent/noise/1/browser-proof\0";

fn builder() -> Result<Builder<'static>, snow::Error> {
    Builder::new(crate::PATTERN.parse()?).prologue(PROLOGUE)
}

pub fn generate_keypair() -> Result<snow::Keypair, snow::Error> {
    builder()?.generate_keypair()
}

pub fn responder(private: &Key) -> Result<HandshakeState, snow::Error> {
    builder()?.local_private_key(private)?.build_responder()
}

pub struct Initiator {
    handshake: HandshakeState,
    pin: Key,
}

pub struct VerifiedClient {
    transport: TransportState,
    pin: Key,
    binding: Key,
}

impl Initiator {
    /// `pin` must have been independently verified; discovery and TLS do not provision it.
    pub fn start(pin: Key) -> Result<(Self, [u8; HANDSHAKE_PACKET]), snow::Error> {
        let mut handshake = builder()?.remote_public_key(&pin)?.build_initiator()?;
        let mut first = [0; HANDSHAKE_PACKET];
        handshake.write_message(&[], &mut first)?;
        Ok((Self { handshake, pin }, first))
    }

    pub fn verify(mut self, reply: &[u8]) -> Result<VerifiedClient, InvalidRecord> {
        if reply.len() != HANDSHAKE_PACKET
            || self.handshake.read_message(reply, &mut []).ok() != Some(0)
        {
            return Err(InvalidRecord);
        }
        let binding = handshake_binding(&self.handshake)?;
        Ok(VerifiedClient {
            transport: self
                .handshake
                .into_transport_mode()
                .map_err(|_| InvalidRecord)?,
            pin: self.pin,
            binding,
        })
    }
}

impl VerifiedClient {
    pub fn request(&mut self, request: &Request) -> Result<Vec<u8>, InvalidRecord> {
        match request {
            Request::ResumeNative { pin, .. }
            | Request::RegisterBrowser { pin, .. }
            | Request::ResumeBrowser { pin, .. }
                if *pin != self.pin =>
            {
                return Err(InvalidRecord);
            }
            _ => (),
        }
        seal_control(&mut self.transport, request)
    }

    pub fn upload_chunk(&mut self, sequence: u32, bytes: &[u8]) -> Result<Vec<u8>, InvalidRecord> {
        seal_chunk(&mut self.transport, sequence, bytes)
    }

    pub fn response(&mut self, packet: &[u8]) -> Result<Record<Reply>, InvalidRecord> {
        open(&mut self.transport, packet)
    }

    pub fn browser_proof(&self, registering: bool, id: &str, public_key: &[u8]) -> Vec<u8> {
        browser_proof(&self.pin, &self.binding, registering, id, public_key)
    }
}

pub fn handshake_binding(state: &HandshakeState) -> Result<Key, InvalidRecord> {
    if !state.is_handshake_finished() {
        return Err(InvalidRecord);
    }
    state
        .get_handshake_hash()
        .try_into()
        .map_err(|_| InvalidRecord)
}

pub fn browser_proof(
    pin: &Key,
    binding: &Key,
    registering: bool,
    id: &str,
    public_key: &[u8],
) -> Vec<u8> {
    let mut proof = PROOF_DOMAIN.to_vec();
    proof.extend(pin);
    proof.extend(binding);
    proof.push(u8::from(registering));
    proof.extend(public_key);
    proof.extend(id.as_bytes());
    proof
}

pub fn seal_control(
    state: &mut TransportState,
    value: &impl Serialize,
) -> Result<Vec<u8>, InvalidRecord> {
    crate::seal_control_bounded(state, value, MAX_PACKET - TAG_BYTES)
}

pub fn open<T: serde::de::DeserializeOwned>(
    state: &mut TransportState,
    packet: &[u8],
) -> Result<Record<T>, InvalidRecord> {
    crate::open_bounded(state, packet, MAX_PACKET)
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Status,
    LoginNative {
        owner_token: String,
        name: String,
    },
    ResumeNative {
        pin: Key,
        credential: Key,
    },
    RegisterBrowser {
        pin: Key,
        owner_token: String,
        name: String,
        public_key: Vec<u8>,
        signature: Vec<u8>,
    },
    ResumeBrowser {
        pin: Key,
        id: String,
        public_key: Vec<u8>,
        signature: Vec<u8>,
    },
    Me,
    Logout,
    Devices {
        #[serde(default)]
        after: Option<Cursor>,
    },
    RevokeDevice {
        id: String,
    },
    Profile,
    ProfileBackends {
        #[serde(default)]
        after: Option<Cursor>,
    },
    UpdateProfile {
        #[serde(default)]
        owner: Option<IdentityPatch>,
        #[serde(default)]
        agent: Option<IdentityPatch>,
    },
    SyncProfile {
        #[serde(default)]
        backend: Option<String>,
    },
    SlashCatalog,
    Categories {
        include_archived: bool,
        #[serde(default)]
        after: Option<Cursor>,
    },
    Threads {
        include_archived: bool,
        #[serde(default)]
        after: Option<Cursor>,
    },
    CreateCategory {
        name: String,
    },
    RenameCategory {
        id: String,
        name: String,
    },
    ArchiveCategory {
        id: String,
        archived: bool,
    },
    StartThread {
        channel: String,
        message: Message,
    },
    RenameThread {
        id: String,
        title: String,
    },
    MoveThread {
        id: String,
        channel: String,
    },
    ArchiveThread {
        id: String,
        archived: bool,
    },
    History {
        chat: String,
        #[serde(default)]
        after: Option<Cursor>,
    },
    TurnUpdates {
        chat: String,
        turn: String,
        #[serde(default)]
        after: Option<Cursor>,
    },
    SendTurn {
        chat: String,
        message: Message,
    },
    ReleaseTurn {
        chat: String,
        id: String,
    },
    DecideApproval {
        chat: String,
        id: String,
        choice: ApprovalChoice,
    },
    Inbox {
        #[serde(default)]
        after: Option<Cursor>,
    },
    ReadThread {
        chat: String,
    },
    ReadReply {
        chat: String,
        id: String,
    },
    Upload {
        purpose: UploadPurpose,
        filename: String,
        size: u64,
        #[serde(default)]
        mime: Option<String>,
    },
    UploadFinish,
    UploadCancel,
    Download {
        id: String,
    },
    DownloadNext,
    DownloadCancel,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Message {
    pub id: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IdentityPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<AvatarPatch>,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum AvatarPatch {
    Clear,
    Set { id: String },
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UploadPurpose {
    Turn,
    Avatar,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalChoice {
    Once,
    Session,
    Deny,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Reply {
    ResultStart { size: u64 },
    ResultComplete,
    UploadReady,
    UploadChunkAccepted { sequence: u32 },
    UploadComplete { attachment: Attachment },
    UploadCancelled,
    DownloadStart { attachment: Attachment },
    DownloadComplete,
    DownloadCancelled,
    Error { code: ErrorCode, message: String },
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Unauthorized,
    Invalid,
    Busy,
    Missing,
    Conflict,
    Limit,
    RateLimited,
    Storage,
}

/// Typed JSON of a bounded `ResultStart`/chunks/`ResultComplete` sequence.
#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Outcome {
    Status {
        service: String,
        version: u16,
    },
    NativeLogin {
        pin: Key,
        credential: Key,
        device: Device,
    },
    Device {
        device: Device,
    },
    Devices {
        current: String,
        page: Page<Device>,
    },
    Revoked {
        current: bool,
    },
    Profile {
        profile: Profile,
    },
    ProfileBackends {
        page: Page<BackendProfile>,
    },
    SlashCatalog {
        catalog: Option<SlashCatalog>,
    },
    Categories {
        page: Page<Category>,
    },
    Threads {
        page: Page<Thread>,
    },
    CategoryCreated {
        id: String,
    },
    CategoryRenamed {
        name: String,
    },
    Archived {
        archived: bool,
    },
    ThreadStarted {
        id: String,
        title: String,
        channel: String,
        fresh: bool,
    },
    ThreadRenamed {
        title: String,
    },
    ThreadMoved {
        id: String,
        channel: String,
    },
    History {
        page: Page<Turn>,
    },
    TurnUpdates {
        page: Page<TurnUpdate>,
    },
    TurnSent {
        id: String,
        fresh: bool,
    },
    Inbox {
        page: Page<Notification>,
    },
    Ok,
}

#[derive(Serialize, Deserialize)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next: Option<Cursor>,
}

/// An opaque SQLite order position encoded as decimal text to preserve 64-bit values in JS.
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Cursor(i64);

impl Cursor {
    pub fn from_rowid(rowid: i64) -> Self {
        Self(rowid)
    }
    pub fn rowid(self) -> i64 {
        self.0
    }
}

impl TryFrom<String> for Cursor {
    type Error = std::num::ParseIntError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        value.parse().map(Self)
    }
}

impl From<Cursor> for String {
    fn from(cursor: Cursor) -> Self {
        cursor.0.to_string()
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub expires_at: i64,
}

#[derive(Serialize, Deserialize)]
pub struct Category {
    pub id: String,
    pub name: String,
    pub archived: bool,
}

#[derive(Serialize, Deserialize)]
pub struct Thread {
    pub id: String,
    pub title: String,
    pub channel: String,
    pub archived: bool,
}

#[derive(Serialize, Deserialize)]
pub struct Turn {
    pub id: String,
    pub text: String,
    pub state: TurnState,
    pub answer: Option<String>,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnState {
    Queued,
    Reserved,
    Accepted,
    Unknown,
    Released,
    Answered,
}

#[derive(Serialize, Deserialize)]
pub struct TurnUpdate {
    pub id: String,
    pub kind: UpdateKind,
    pub text: String,
    #[serde(default)]
    pub choices: Vec<ApprovalChoice>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateKind {
    Progress,
    Commentary,
}

#[derive(Serialize, Deserialize)]
pub struct Notification {
    pub request: String,
    pub chat: String,
    pub channel: String,
    pub unread: bool,
    pub title: String,
    pub preview: String,
}

#[derive(Serialize, Deserialize)]
pub struct Profile {
    pub owner: Identity,
    pub agent: Identity,
    pub sync: Option<ProfileSync>,
}

#[derive(Serialize, Deserialize)]
pub struct Identity {
    pub name: String,
    pub avatar: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct BackendProfile {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub avatar: Option<String>,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize)]
pub struct ProfileSync {
    pub backend: String,
    pub refresh: Refresh,
    pub name: bool,
    pub avatar: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Refresh {
    Refreshed,
    TimedOut,
    Offline,
}

#[derive(Serialize, Deserialize)]
pub struct SlashCatalog {
    pub commands: Vec<String>,
    pub skills: Vec<String>,
}

/// Bounded result reader. Do not expose the result until `finish` succeeds.
pub struct ResultReader {
    size: usize,
    sequence: u32,
    bytes: Vec<u8>,
}

impl ResultReader {
    pub fn new(size: u64) -> Result<Self, InvalidRecord> {
        if !(1..=MAX_RESULT as u64).contains(&size) {
            return Err(InvalidRecord);
        }
        Ok(Self {
            size: size as usize,
            sequence: 0,
            bytes: Vec::with_capacity(size as usize),
        })
    }

    pub fn chunk(&mut self, sequence: u32, data: &[u8]) -> Result<(), InvalidRecord> {
        if sequence != self.sequence
            || data.is_empty()
            || data.len() != (self.size - self.bytes.len()).min(CHUNK_BYTES)
        {
            return Err(InvalidRecord);
        }
        self.sequence += 1;
        self.bytes.extend_from_slice(data);
        Ok(())
    }

    /// Call only when the separately authenticated `ResultComplete` has arrived.
    pub fn finish(self) -> Result<Outcome, InvalidRecord> {
        if self.bytes.len() != self.size {
            return Err(InvalidRecord);
        }
        serde_json::from_slice(&self.bytes).map_err(|_| InvalidRecord)
    }
}
