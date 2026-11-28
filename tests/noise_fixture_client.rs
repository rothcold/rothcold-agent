//! Synchronous TCP connector used only by server-owned fixtures.

use rothcold_noise_protocol::{
    Key,
    v1::{self, Initiator, Outcome, Record, Reply, Request, ResultReader, VerifiedClient},
};
use std::{
    io::{self, Read, Write},
    net::{SocketAddr, TcpStream},
    time::Duration,
};

pub struct Client {
    pub socket: TcpStream,
    pub transport: VerifiedClient,
}

pub fn invalid<E: std::fmt::Debug>(_: E) -> io::Error {
    io::Error::other("invalid Noise fixture packet")
}

pub fn send_raw(socket: &mut TcpStream, data: &[u8]) -> io::Result<()> {
    let len = u16::try_from(data.len()).map_err(invalid)?;
    socket.write_all(&len.to_be_bytes())?;
    socket.write_all(data)
}

pub fn receive_raw(socket: &mut TcpStream) -> io::Result<Vec<u8>> {
    let mut header = [0; 2];
    socket.read_exact(&mut header)?;
    let mut data = vec![0; usize::from(u16::from_be_bytes(header))];
    socket.read_exact(&mut data)?;
    Ok(data)
}

impl Client {
    pub fn connect(addr: SocketAddr, pin: Key) -> io::Result<Self> {
        if !addr.ip().is_loopback() {
            return Err(io::Error::other("fixture requires loopback"));
        }
        let mut socket = TcpStream::connect_timeout(&addr, Duration::from_secs(3))?;
        socket.set_read_timeout(Some(Duration::from_secs(6)))?;
        socket.set_write_timeout(Some(Duration::from_secs(6)))?;
        socket.set_nodelay(true)?;
        let (link, first) = Initiator::start(pin).map_err(invalid)?;
        send_raw(&mut socket, &first)?;
        let transport = link.verify(&receive_raw(&mut socket)?).map_err(invalid)?;
        Ok(Self { socket, transport })
    }

    pub fn send(&mut self, request: &Request) -> io::Result<()> {
        let data = self.transport.request(request).map_err(invalid)?;
        send_raw(&mut self.socket, &data)
    }

    pub fn receive(&mut self) -> io::Result<Record<Reply>> {
        self.transport
            .response(&receive_raw(&mut self.socket)?)
            .map_err(invalid)
    }

    pub fn exchange(&mut self, request: &Request) -> io::Result<Result<Outcome, Reply>> {
        self.send(request)?;
        let mut result = match self.receive()? {
            Record::Control(Reply::ResultStart { size }) => {
                ResultReader::new(size).map_err(invalid)?
            }
            Record::Control(reply @ Reply::Error { .. }) => return Ok(Err(reply)),
            _ => return Err(invalid(())),
        };
        loop {
            match self.receive()? {
                Record::Chunk { sequence, data } => {
                    result.chunk(sequence, &data).map_err(invalid)?
                }
                Record::Control(Reply::ResultComplete) => {
                    return Ok(Ok(result.finish().map_err(invalid)?));
                }
                _ => return Err(invalid(())),
            }
        }
    }

    #[cfg(test)]
    pub fn upload(
        &mut self,
        purpose: v1::UploadPurpose,
        filename: String,
        data: &[u8],
    ) -> io::Result<Reply> {
        self.upload_with_mime(purpose, filename, data, None)
    }

    pub fn upload_with_mime(
        &mut self,
        purpose: v1::UploadPurpose,
        filename: String,
        data: &[u8],
        mime: Option<String>,
    ) -> io::Result<Reply> {
        self.send(&Request::Upload {
            purpose,
            filename,
            size: data.len() as u64,
            mime,
        })?;
        match self.receive()? {
            Record::Control(Reply::UploadReady) => (),
            Record::Control(error @ Reply::Error { .. }) => return Ok(error),
            _ => return Err(invalid(())),
        }
        for (index, bytes) in data.chunks(v1::CHUNK_BYTES).enumerate() {
            let sequence = index as u32;
            let packet = self
                .transport
                .upload_chunk(sequence, bytes)
                .map_err(invalid)?;
            send_raw(&mut self.socket, &packet)?;
            match self.receive()? {
                Record::Control(Reply::UploadChunkAccepted { sequence: accepted })
                    if sequence == accepted => {}
                Record::Control(error @ Reply::Error { .. }) => return Ok(error),
                _ => return Err(invalid(())),
            }
        }
        self.send(&Request::UploadFinish)?;
        match self.receive()? {
            Record::Control(reply @ (Reply::UploadComplete { .. } | Reply::Error { .. })) => {
                Ok(reply)
            }
            _ => Err(invalid(())),
        }
    }
}

pub fn parse_pin(text: &str) -> io::Result<Key> {
    let text = text.trim();
    if text.len() != 64 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid(()));
    }
    let mut out = [0; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).map_err(invalid)?;
    }
    Ok(out)
}
