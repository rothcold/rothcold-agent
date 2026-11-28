//! Browser ABI for the shared production codec. All cryptography and record validation stay in Rust.
#![cfg(target_arch = "wasm32")]

use rothcold_noise_protocol::v1::{
    self, Initiator, InvalidRecord, Record, Reply, Request, ResultReader, VerifiedClient,
};
use std::{cell::RefCell, collections::BTreeMap};
use zeroize::Zeroize;

struct Link {
    client: VerifiedClient,
    result: Option<ResultReader>,
}

enum Client {
    Connecting(Box<Initiator>),
    Verified(Link),
}

struct Browser {
    scratch: Box<[u8]>,
    clients: BTreeMap<u32, Client>,
    last_id: u32,
}

thread_local! {
    static BROWSER: RefCell<Browser> = RefCell::new(Browser {
        scratch: vec![0; v1::MAX_RESULT + 1].into_boxed_slice(),
        clients: BTreeMap::new(),
        last_id: 0,
    });
}

#[link(wasm_import_module = "./noise-entropy.mjs")]
unsafe extern "C" {
    fn secure_random(ptr: *mut u8, len: usize) -> u32;
}

#[unsafe(no_mangle)]
unsafe fn __getrandom_v03_custom(ptr: *mut u8, len: usize) -> Result<(), getrandom::Error> {
    // Web Crypto must fill the complete destination or report failure; there is no fallback.
    if unsafe { secure_random(ptr, len) } != 1 {
        return Err(getrandom::Error::UNSUPPORTED);
    }
    Ok(())
}

#[unsafe(no_mangle)]
extern "C" fn scratch_ptr() -> *mut u8 {
    BROWSER.with_borrow_mut(|b| b.scratch.as_mut_ptr())
}

#[unsafe(no_mangle)]
extern "C" fn start() -> u32 {
    BROWSER.with_borrow_mut(|b| {
        let Some(id) = b.last_id.checked_add(1).filter(|_| b.clients.len() < 24) else {
            return 0;
        };
        let pin = b.scratch[..32].try_into().unwrap();
        let Ok((client, packet)) = Initiator::start(pin) else {
            return 0;
        };
        b.scratch[..packet.len()].copy_from_slice(&packet);
        b.last_id = id;
        b.clients.insert(id, Client::Connecting(Box::new(client)));
        id
    })
}

#[unsafe(no_mangle)]
extern "C" fn verify(id: u32, len: usize) -> i32 {
    BROWSER.with_borrow_mut(|b| {
        if len != v1::HANDSHAKE_PACKET {
            return -1;
        }
        let Some(Client::Connecting(client)) = b.clients.remove(&id) else {
            return -1;
        };
        let Ok(client) = client.verify(&b.scratch[..len]) else {
            return -1;
        };
        b.clients.insert(
            id,
            Client::Verified(Link {
                client,
                result: None,
            }),
        );
        0
    })
}

#[unsafe(no_mangle)]
extern "C" fn close(id: u32) {
    BROWSER.with_borrow_mut(|b| b.clients.remove(&id));
}

fn exchange(
    id: u32,
    len: usize,
    run: impl FnOnce(&mut Link, &[u8]) -> Result<Vec<u8>, InvalidRecord>,
) -> i32 {
    BROWSER.with_borrow_mut(|b| {
        let (Some(Client::Verified(link)), Some(input)) =
            (b.clients.get_mut(&id), b.scratch.get(..len))
        else {
            return -1;
        };
        match run(link, input) {
            Ok(bytes) if bytes.len() <= b.scratch.len() => {
                b.scratch[..bytes.len()].copy_from_slice(&bytes);
                bytes.len() as i32
            }
            _ => -1,
        }
    })
}

#[unsafe(no_mangle)]
extern "C" fn request(id: u32, len: usize) -> i32 {
    exchange(id, len, |link, bytes| {
        let mut value = serde_json::from_slice(bytes).map_err(|_| InvalidRecord)?;
        let sealed = link.client.request(&value);
        if let Request::RegisterBrowser { owner_token, .. } = &mut value {
            owner_token.zeroize();
        }
        sealed
    })
}

#[unsafe(no_mangle)]
extern "C" fn upload_chunk(id: u32, len: usize, sequence: u32) -> i32 {
    exchange(id, len, |link, bytes| {
        link.client.upload_chunk(sequence, bytes)
    })
}

#[unsafe(no_mangle)]
extern "C" fn proof(id: u32, len: usize) -> i32 {
    exchange(id, len, |link, bytes| {
        let (flag, rest) = bytes.split_first().ok_or(InvalidRecord)?;
        let (public_key, id) = rest.split_at_checked(65).ok_or(InvalidRecord)?;
        if !matches!((flag, id.len()), (1, 0) | (0, 36)) {
            return Err(InvalidRecord);
        }
        let id = std::str::from_utf8(id).map_err(|_| InvalidRecord)?;
        Ok(link.client.browser_proof(*flag == 1, id, public_key))
    })
}

#[unsafe(no_mangle)]
extern "C" fn response(id: u32, len: usize) -> i32 {
    exchange(id, len, |link, bytes| {
        match link.client.response(bytes)? {
            Record::Control(Reply::ResultStart { size }) if link.result.is_none() => {
                link.result = Some(ResultReader::new(size)?);
                Ok(vec![3])
            }
            Record::Chunk {
                sequence,
                data: bytes,
            } => match &mut link.result {
                Some(result) => {
                    result.chunk(sequence, &bytes)?;
                    Ok(vec![3])
                }
                None => {
                    let mut out = Vec::with_capacity(bytes.len() + 5);
                    out.push(1);
                    out.extend(sequence.to_be_bytes());
                    out.extend(bytes);
                    Ok(out)
                }
            },
            Record::Control(Reply::ResultComplete) => {
                let result = link.result.take().ok_or(InvalidRecord)?.finish()?;
                let mut out = vec![2];
                serde_json::to_writer(&mut out, &result).map_err(|_| InvalidRecord)?;
                Ok(out)
            }
            Record::Control(reply) if link.result.is_none() => {
                let mut out = vec![0];
                serde_json::to_writer(&mut out, &reply).map_err(|_| InvalidRecord)?;
                Ok(out)
            }
            _ => Err(InvalidRecord),
        }
    })
}
