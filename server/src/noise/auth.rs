use crate::{App, BAD, Error, Result, S, UNAUTHORIZED, lock, same, sessions};
use ring::signature::{ECDSA_P256_SHA256_FIXED, UnparsedPublicKey};
use rothcold_noise_protocol::{Key, v1};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};

pub type Authorization = [u8; 32];

fn scoped(pin: &Key, domain: &[u8], material: &[u8]) -> Authorization {
    let mut digest = Sha256::new();
    digest.update(b"rothcold-agent/noise/1/device\0");
    digest.update(pin);
    digest.update(domain);
    digest.update(material);
    digest.finalize().into()
}

fn bootstrap(app: &App, owner_token: &str, name: &str) -> Result<()> {
    let mut rate = lock(&app.auth);
    let now = Instant::now();
    if now >= rate.window {
        rate.window = now + Duration::from_secs(60);
        rate.failures = 0;
    }
    if rate.failures >= 8 {
        return Err(Error(
            S::TOO_MANY_REQUESTS,
            "Too many failed sign-ins. Wait before retrying.",
        ));
    }
    let valid = (32..=512).contains(&owner_token.len())
        && same(owner_token.as_bytes(), app.owner.as_bytes());
    if !valid {
        rate.failures += 1;
        return Err(UNAUTHORIZED);
    }
    if name.trim().is_empty()
        || name.chars().count() > 80
        || name.trim().chars().any(char::is_control)
    {
        return Err(BAD);
    }
    rate.failures = 0;
    Ok(())
}

pub fn authorize(db: &rusqlite::Connection, hash: &Authorization) -> Result<v1::Device> {
    sessions::authenticate_hash(db, hash)?.ok_or(UNAUTHORIZED)
}

pub fn login_native(
    app: &App,
    pin: &Key,
    owner_token: &str,
    name: &str,
) -> Result<(Authorization, v1::Outcome)> {
    bootstrap(app, owner_token, name)?;
    let mut credential = [0; 32];
    getrandom::fill(&mut credential).map_err(|_| {
        Error(
            S::INTERNAL_SERVER_ERROR,
            "Could not generate device credential",
        )
    })?;
    let hash = scoped(pin, b"native\0", &credential);
    let device = sessions::issue(&mut lock(&app.db), &hash, name.trim())?;
    Ok((
        hash,
        v1::Outcome::NativeLogin {
            pin: *pin,
            credential,
            device,
        },
    ))
}

pub fn resume_native(
    app: &App,
    pin: &Key,
    credential: &Key,
) -> Result<(Authorization, v1::Outcome)> {
    let hash = scoped(pin, b"native\0", credential);
    let device = authorize(&lock(&app.db), &hash)?;
    Ok((hash, v1::Outcome::Device { device }))
}

pub struct BrowserProof<'a> {
    pub pin: &'a Key,
    pub binding: &'a Key,
    pub public_key: &'a [u8],
    pub signature: &'a [u8],
}

impl BrowserProof<'_> {
    fn verify(&self, registering: bool, id: &str) -> Result<Authorization> {
        if self.public_key.len() != 65 || self.signature.len() != 64 || self.public_key[0] != 4 {
            return Err(UNAUTHORIZED);
        }
        let message = v1::browser_proof(self.pin, self.binding, registering, id, self.public_key);
        UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, self.public_key)
            .verify(&message, self.signature)
            .map_err(|_| UNAUTHORIZED)?;
        Ok(scoped(self.pin, b"browser\0", self.public_key))
    }

    pub fn register(
        &self,
        app: &App,
        owner_token: &str,
        name: &str,
    ) -> Result<(Authorization, v1::Outcome)> {
        bootstrap(app, owner_token, name)?;
        let hash = self.verify(true, "")?;
        let device = sessions::issue(&mut lock(&app.db), &hash, name.trim())?;
        Ok((hash, v1::Outcome::Device { device }))
    }

    pub fn resume(&self, app: &App, id: &str) -> Result<(Authorization, v1::Outcome)> {
        crate::request_id(id)?;
        let hash = self.verify(false, id)?;
        let device = authorize(&lock(&app.db), &hash)?;
        if device.id != id {
            return Err(UNAUTHORIZED);
        }
        Ok((hash, v1::Outcome::Device { device }))
    }
}
