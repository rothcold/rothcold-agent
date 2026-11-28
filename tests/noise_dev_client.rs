//! Reference client for the real disposable listener, not a Web/iOS integration.

use super::*;
use futures_util::{SinkExt, StreamExt};
use std::io::{Read, Seek, Write};
use tempfile::NamedTempFile;
use tokio::net::TcpStream;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};

pub(super) type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum ClientError {
    Transport,
    PinOrHandshake,
    CredentialScope,
    Framing,
    Protocol,
    Business(ErrorCode),
    File,
}
use ClientError::*;
type Result<T> = std::result::Result<T, ClientError>;

pub(super) struct ScopedCredential {
    responder: Key,
    secret: Key,
}

impl ScopedCredential {
    pub fn issued_for(responder: Key, secret: Key) -> Self {
        Self { responder, secret }
    }
}

pub(super) struct ReferenceClient {
    socket: Option<Socket>,
    responder: Key,
    transport: protocol::TransportState,
}

impl ReferenceClient {
    pub async fn connect(url: &str, pin: &Key) -> Result<Self> {
        let conf = WebSocketConfig::default()
            .max_frame_size(Some(MAX_PACKET))
            .max_message_size(Some(MAX_PACKET))
            .read_buffer_size(MAX_PACKET)
            .write_buffer_size(0)
            .max_write_buffer_size(2 * MAX_PACKET + 128);
        let (mut socket, _) = timeout(IDLE, connect_async_with_config(url, Some(conf), false))
            .await
            .map_err(|_| Transport)?
            .map_err(|_| Transport)?;
        let mut state = protocol::initiator(pin).map_err(|_| PinOrHandshake)?;
        let mut first = vec![0; HANDSHAKE_PACKET];
        if state.write_message(&[], &mut first).ok() != Some(HANDSHAKE_PACKET) {
            return Err(PinOrHandshake);
        }
        send(&mut socket, first).await.map_err(|_| PinOrHandshake)?;
        let response = receive(&mut socket).await.map_err(|_| PinOrHandshake)?;
        if response.len() != HANDSHAKE_PACKET
            || state.read_message(&response, &mut []).ok() != Some(0)
        {
            return Err(PinOrHandshake);
        }
        // No configured credential is available to this handshake function.
        let transport = state.into_transport_mode().map_err(|_| PinOrHandshake)?;
        Ok(Self {
            socket: Some(socket),
            responder: *pin,
            transport,
        })
    }

    pub async fn authorize(&mut self, credential: &ScopedCredential) -> Result<()> {
        if credential.responder != self.responder {
            return Err(CredentialScope);
        }
        self.send(Client::Authenticate {
            credential: credential.secret,
        })
        .await?;
        match self.next().await? {
            Record::Control(Server::Authorized) => Ok(()),
            _ => Err(Protocol),
        }
    }

    pub async fn directory(&mut self) -> Result<serde_json::Value> {
        self.send(Client::Directory).await?;
        match self.next().await? {
            Record::Control(Server::Directory { directory }) => Ok(directory),
            _ => Err(Protocol),
        }
    }

    pub async fn begin(&mut self, filename: &str, size: u64) -> Result<()> {
        self.send(Client::Upload {
            filename: filename.into(),
            size,
        })
        .await?;
        match self.next().await? {
            Record::Control(Server::UploadReady) => Ok(()),
            _ => Err(Protocol),
        }
    }

    pub async fn upload(
        &mut self,
        filename: &str,
        size: u64,
        mut input: impl Read,
    ) -> Result<protocol::Attachment> {
        self.begin(filename, size).await?;
        let mut remaining = size;
        let mut sequence = 0;
        let mut block = vec![0; CHUNK_BYTES];
        while remaining != 0 {
            let size = remaining.min(CHUNK_BYTES as u64) as usize;
            if input.read_exact(&mut block[..size]).is_err() {
                self.socket.take();
                return Err(File);
            }
            self.chunk(sequence, &block[..size]).await?;
            sequence += 1;
            remaining -= size as u64;
        }
        if !matches!(input.read(&mut [0]), Ok(0)) {
            // After UploadReady the server is waiting for the next upload record.
            // Drop the socket rather than allowing reuse in that state.
            self.socket.take();
            return Err(File);
        }
        self.finish_upload().await?;
        match self.next().await? {
            Record::Control(Server::UploadComplete { attachment }) if attachment.size == size => {
                Ok(attachment)
            }
            _ => Err(Protocol),
        }
    }

    pub async fn download(&mut self, id: &str, temp: &std::path::Path) -> Result<NamedTempFile> {
        let size = self.begin_download(id).await?;
        self.receive_download(size, temp).await
    }

    pub async fn begin_download(&mut self, id: &str) -> Result<u64> {
        self.send(Client::Download { id: id.into() }).await?;
        let Record::Control(Server::DownloadStart { attachment }) = self.next().await? else {
            return Err(Protocol);
        };
        if attachment.id != id || attachment.size > attachments::FILE_LIMIT as u64 {
            return Err(Protocol);
        }
        Ok(attachment.size)
    }

    pub async fn receive_download(
        &mut self,
        size: u64,
        temp: &std::path::Path,
    ) -> Result<NamedTempFile> {
        let mut output = NamedTempFile::new_in(temp).map_err(|_| File)?;
        let mut remaining = size;
        let mut expected = 0;
        loop {
            match self.next().await? {
                Record::Chunk { sequence, data }
                    if remaining > 0
                        && sequence == expected
                        && data.len() as u64 == remaining.min(CHUNK_BYTES as u64) =>
                {
                    output.write_all(&data).map_err(|_| File)?;
                    remaining -= data.len() as u64;
                    expected += 1;
                }
                Record::Control(Server::DownloadComplete) if remaining == 0 => {
                    output.as_file_mut().rewind().map_err(|_| File)?;
                    return Ok(output);
                }
                _ => return Err(Protocol),
            }
        }
    }

    pub async fn finish_upload(&mut self) -> Result<()> {
        self.send(Client::UploadFinish).await
    }

    pub async fn cancel_upload(&mut self) -> Result<()> {
        self.send(Client::UploadCancel).await
    }

    pub fn socket(&mut self) -> Result<&mut Socket> {
        self.socket.as_mut().ok_or(Transport)
    }

    async fn send(&mut self, value: Client) -> Result<()> {
        let socket = self.socket.as_mut().ok_or(Transport)?;
        let data = protocol::seal_control(&mut self.transport, &value).map_err(|_| Framing)?;
        send(socket, data).await
    }

    pub async fn chunk(&mut self, sequence: u32, data: &[u8]) -> Result<Vec<u8>> {
        let socket = self.socket.as_mut().ok_or(Transport)?;
        let packet =
            protocol::seal_chunk(&mut self.transport, sequence, data).map_err(|_| Framing)?;
        send(socket, packet.clone()).await?;
        Ok(packet)
    }

    pub async fn next(&mut self) -> Result<Record<Server>> {
        let incoming = receive(self.socket()?).await?;
        match protocol::open(&mut self.transport, &incoming).map_err(|_| Framing)? {
            Record::Control(Server::Error { code }) => Err(Business(code)),
            message => Ok(message),
        }
    }
}

async fn send(socket: &mut Socket, packet: Vec<u8>) -> Result<()> {
    timeout(IDLE, socket.send(Message::Binary(packet.into())))
        .await
        .map_err(|_| Transport)?
        .map_err(|_| Transport)
}

async fn receive(socket: &mut Socket) -> Result<axum::body::Bytes> {
    match timeout(IDLE, socket.next()).await {
        Ok(Some(Ok(Message::Binary(data)))) => Ok(data),
        _ => Err(Transport),
    }
}
