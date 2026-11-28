//! Connector-independent Noise codec; production messages and pairing are in [`v1`].

pub mod v1;

use serde::{Deserialize, Serialize, de::DeserializeOwned};
pub use snow::TransportState;
use snow::{Builder, HandshakeState, Keypair};

const PATTERN: &str = "Noise_NK_25519_ChaChaPoly_BLAKE2s";
const PROLOGUE: &[u8] = b"rothcold-agent/noise-dev/1";
const TAG_BYTES: usize = 16;
pub const CHUNK_BYTES: usize = 32 * 1024;
pub const MAX_PLAINTEXT: usize = 1 + 4 + CHUNK_BYTES;
pub const MAX_PACKET: usize = MAX_PLAINTEXT + TAG_BYTES;
pub const HANDSHAKE_PACKET: usize = 32 + TAG_BYTES;
pub type Key = [u8; 32];

fn builder() -> Result<Builder<'static>, snow::Error> {
    Builder::new(PATTERN.parse()?).prologue(PROLOGUE)
}

pub fn generate_keypair() -> Result<Keypair, snow::Error> {
    builder()?.generate_keypair()
}

pub fn initiator(pin: &Key) -> Result<HandshakeState, snow::Error> {
    builder()?.remote_public_key(pin)?.build_initiator()
}

pub fn responder(private: &Key) -> Result<HandshakeState, snow::Error> {
    builder()?.local_private_key(private)?.build_responder()
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Client {
    Authenticate { credential: Key },
    Directory,
    Upload { filename: String, size: u64 },
    UploadFinish,
    UploadCancel,
    Download { id: String },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Server {
    Authorized,
    Directory { directory: serde_json::Value },
    UploadReady,
    UploadComplete { attachment: Attachment },
    UploadCancelled,
    DownloadStart { attachment: Attachment },
    DownloadComplete,
    Error { code: ErrorCode },
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attachment {
    pub id: String,
    pub filename: String,
    pub mime: String,
    pub kind: String,
    pub size: u64,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Unauthorized,
    Invalid,
    Busy,
    Missing,
    Limit,
    Storage,
}

pub enum Record<T> {
    Control(T),
    Chunk { sequence: u32, data: Vec<u8> },
}

#[derive(Debug)]
pub struct InvalidRecord;

type RecordResult<T> = Result<T, InvalidRecord>;

pub fn seal_control(state: &mut TransportState, value: &impl Serialize) -> RecordResult<Vec<u8>> {
    seal_control_bounded(state, value, MAX_PLAINTEXT)
}

fn seal_control_bounded(
    state: &mut TransportState,
    value: &impl Serialize,
    limit: usize,
) -> RecordResult<Vec<u8>> {
    let mut plain = vec![0; limit];
    let mut control = std::io::Cursor::new(&mut plain[1..]);
    serde_json::to_writer(&mut control, value).map_err(|_| InvalidRecord)?;
    let len = 1 + control.position() as usize;
    seal(state, &plain[..len])
}

pub fn seal_chunk(state: &mut TransportState, sequence: u32, data: &[u8]) -> RecordResult<Vec<u8>> {
    if data.is_empty() || data.len() > CHUNK_BYTES {
        return Err(InvalidRecord);
    }
    let mut plain = Vec::with_capacity(5 + data.len());
    plain.push(1);
    plain.extend(sequence.to_be_bytes());
    plain.extend(data);
    seal(state, &plain)
}

fn seal(state: &mut TransportState, plain: &[u8]) -> RecordResult<Vec<u8>> {
    let mut packet = vec![0; plain.len() + TAG_BYTES];
    let len = state
        .write_message(plain, &mut packet)
        .map_err(|_| InvalidRecord)?;
    packet.truncate(len);
    Ok(packet)
}

pub fn open<T: DeserializeOwned>(
    state: &mut TransportState,
    packet: &[u8],
) -> RecordResult<Record<T>> {
    open_bounded(state, packet, MAX_PACKET)
}

fn open_bounded<T: DeserializeOwned>(
    state: &mut TransportState,
    packet: &[u8],
    limit: usize,
) -> RecordResult<Record<T>> {
    if !(TAG_BYTES + 1..=limit).contains(&packet.len()) {
        return Err(InvalidRecord);
    }
    let mut plain = vec![0; packet.len() - TAG_BYTES];
    let len = state
        .read_message(packet, &mut plain)
        .map_err(|_| InvalidRecord)?;
    plain.truncate(len);
    match plain.as_slice() {
        [0, json @ ..] => serde_json::from_slice(json)
            .map(Record::Control)
            .map_err(|_| InvalidRecord),
        [1, a, b, c, d, data @ ..] if (1..=CHUNK_BYTES).contains(&data.len()) => {
            Ok(Record::Chunk {
                sequence: u32::from_be_bytes([*a, *b, *c, *d]),
                data: data.to_vec(),
            })
        }
        _ => Err(InvalidRecord),
    }
}

#[cfg(test)]
#[path = "../../../tests/noise_dev_cacophony.rs"]
mod cacophony;
