use rothcold_noise_protocol::v1::{self, Attachment, ErrorCode, Record, Reply, Request};
use std::sync::{Arc, Mutex};

#[derive(uniffi::Error, thiserror::Error, Debug)]
pub enum NoiseFailure {
    #[error("Cannot verify the independently supplied responder pin")]
    Identity,
    #[error("Invalid Noise v1 record or operation")]
    InvalidRecord,
}

#[derive(uniffi::Object)]
pub struct NativeHandshake(Mutex<Option<v1::Initiator>>);

#[derive(uniffi::Record)]
pub struct HandshakeStart {
    pub handshake: Arc<NativeHandshake>,
    pub first: Vec<u8>,
}

#[uniffi::export]
pub fn start_native_handshake(pin: Vec<u8>) -> Result<HandshakeStart, NoiseFailure> {
    let (initiator, first) =
        v1::Initiator::start(pin.try_into().map_err(|_| NoiseFailure::Identity)?)
            .map_err(|_| NoiseFailure::Identity)?;
    Ok(HandshakeStart {
        handshake: Arc::new(NativeHandshake(Mutex::new(Some(initiator)))),
        first: first.to_vec(),
    })
}

#[uniffi::export]
impl NativeHandshake {
    pub fn verify(&self, reply: Vec<u8>) -> Result<Arc<NativeCodec>, NoiseFailure> {
        let initiator = self
            .0
            .lock()
            .map_err(|_| NoiseFailure::InvalidRecord)?
            .take()
            .ok_or(NoiseFailure::InvalidRecord)?;
        let client = initiator
            .verify(&reply)
            .map_err(|_| NoiseFailure::Identity)?;
        Ok(Arc::new(NativeCodec(Mutex::new(Codec {
            client,
            result: None,
        }))))
    }
}

#[derive(uniffi::Object)]
pub struct NativeCodec(Mutex<Codec>);

struct Codec {
    client: v1::VerifiedClient,
    result: Option<v1::ResultReader>,
}

#[derive(uniffi::Record)]
pub struct NativeAttachment {
    pub id: String,
    pub filename: String,
    pub mime: String,
    pub kind: String,
    pub size: u64,
}

impl From<Attachment> for NativeAttachment {
    fn from(file: Attachment) -> Self {
        Self {
            id: file.id,
            filename: file.filename,
            mime: file.mime,
            kind: file.kind,
            size: file.size,
        }
    }
}

#[derive(uniffi::Enum)]
pub enum Rejection {
    Unauthorized,
    Invalid,
    Busy,
    Missing,
    Conflict,
    Limit,
    RateLimited,
    Storage,
}

impl From<ErrorCode> for Rejection {
    fn from(code: ErrorCode) -> Self {
        match code {
            ErrorCode::Unauthorized => Self::Unauthorized,
            ErrorCode::Invalid => Self::Invalid,
            ErrorCode::Busy => Self::Busy,
            ErrorCode::Missing => Self::Missing,
            ErrorCode::Conflict => Self::Conflict,
            ErrorCode::Limit => Self::Limit,
            ErrorCode::RateLimited => Self::RateLimited,
            ErrorCode::Storage => Self::Storage,
        }
    }
}

#[derive(uniffi::Enum)]
pub enum NativeReply {
    ResultPending,
    Outcome { json: Vec<u8> },
    Rejected { code: Rejection, message: String },
    UploadReady,
    UploadChunkAccepted { sequence: u32 },
    UploadComplete { attachment: NativeAttachment },
    DownloadStart { attachment: NativeAttachment },
    DownloadChunk { sequence: u32, bytes: Vec<u8> },
    DownloadComplete,
}

#[uniffi::export]
impl NativeCodec {
    /// Only a shared v1 Request can be sealed; this is not an arbitrary plaintext tunnel.
    pub fn request(&self, json: Vec<u8>) -> Result<Vec<u8>, NoiseFailure> {
        let request: Request =
            serde_json::from_slice(&json).map_err(|_| NoiseFailure::InvalidRecord)?;
        let mut codec = self.0.lock().map_err(|_| NoiseFailure::InvalidRecord)?;
        if codec.result.is_some() {
            return Err(NoiseFailure::InvalidRecord);
        }
        codec
            .client
            .request(&request)
            .map_err(|_| NoiseFailure::InvalidRecord)
    }

    pub fn upload_chunk(&self, sequence: u32, bytes: Vec<u8>) -> Result<Vec<u8>, NoiseFailure> {
        let mut codec = self.0.lock().map_err(|_| NoiseFailure::InvalidRecord)?;
        if codec.result.is_some() {
            return Err(NoiseFailure::InvalidRecord);
        }
        codec
            .client
            .upload_chunk(sequence, &bytes)
            .map_err(|_| NoiseFailure::InvalidRecord)
    }

    pub fn response(&self, packet: Vec<u8>) -> Result<NativeReply, NoiseFailure> {
        let invalid = |_| NoiseFailure::InvalidRecord;
        let mut codec = self.0.lock().map_err(|_| NoiseFailure::InvalidRecord)?;
        let record = codec.client.response(&packet).map_err(invalid)?;
        if let Some(reader) = &mut codec.result {
            return match record {
                Record::Chunk { sequence, data } => {
                    reader.chunk(sequence, &data).map_err(invalid)?;
                    Ok(NativeReply::ResultPending)
                }
                Record::Control(Reply::ResultComplete) => {
                    let outcome = codec
                        .result
                        .take()
                        .ok_or(NoiseFailure::InvalidRecord)?
                        .finish()
                        .map_err(invalid)?;
                    let json =
                        serde_json::to_vec(&outcome).map_err(|_| NoiseFailure::InvalidRecord)?;
                    Ok(NativeReply::Outcome { json })
                }
                _ => Err(NoiseFailure::InvalidRecord),
            };
        }
        Ok(match record {
            Record::Control(Reply::ResultStart { size }) => {
                codec.result = Some(v1::ResultReader::new(size).map_err(invalid)?);
                NativeReply::ResultPending
            }
            Record::Control(Reply::Error { code, message }) => NativeReply::Rejected {
                code: code.into(),
                message,
            },
            Record::Control(Reply::UploadReady) => NativeReply::UploadReady,
            Record::Control(Reply::UploadChunkAccepted { sequence }) => {
                NativeReply::UploadChunkAccepted { sequence }
            }
            Record::Control(Reply::UploadComplete { attachment }) => NativeReply::UploadComplete {
                attachment: attachment.into(),
            },
            Record::Control(Reply::DownloadStart { attachment }) => NativeReply::DownloadStart {
                attachment: attachment.into(),
            },
            Record::Chunk { sequence, data } => NativeReply::DownloadChunk {
                sequence,
                bytes: data,
            },
            Record::Control(Reply::DownloadComplete) => NativeReply::DownloadComplete,
            _ => return Err(NoiseFailure::InvalidRecord),
        })
    }
}

#[uniffi::export]
pub fn native_chunk_bytes() -> u32 {
    v1::CHUNK_BYTES as u32
}
