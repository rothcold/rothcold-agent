use curve25519_dalek::montgomery::MontgomeryPoint;
use rothcold_noise_protocol::Key;
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};

const FILE: &str = "noise-v1.identity";

pub struct Identity {
    pub private: Key,
    pub pin: Key,
}

pub fn check_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let meta = fs::symlink_metadata(dir)?;
    if !meta.is_dir()
        || meta.uid() != rustix::process::geteuid().as_raw()
        || meta.mode() & 0o077 != 0
    {
        return Err(io::Error::other(
            "Workspace data directory must be owned by this user and private",
        ));
    }
    Ok(())
}

fn private_file(file: &File) -> io::Result<()> {
    let meta = file.metadata()?;
    if !meta.is_file()
        || meta.uid() != rustix::process::geteuid().as_raw()
        || meta.mode() & 0o077 != 0
    {
        return Err(io::Error::other(
            "Noise identity or lock is not a private regular file",
        ));
    }
    Ok(())
}

fn lockfile(dir: &Path, name: &str) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(dir.join(name))?;
    private_file(&file)?;
    rustix::fs::flock(&file, rustix::fs::FlockOperation::NonBlockingLockExclusive)?;
    Ok(file)
}

pub fn workspace_lock(dir: &Path) -> io::Result<File> {
    lockfile(dir, ".workspace.lock")
}

pub fn load(dir: &Path) -> io::Result<Identity> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(dir.join(FILE))?;
    private_file(&file)?;
    let mut private = [0; 32];
    if file.metadata()?.len() != private.len() as u64 {
        return Err(io::Error::other(
            "Invalid Noise identity file; no replacement generated",
        ));
    }
    file.read_exact(&mut private)?;
    if private == [0; 32] {
        return Err(io::Error::other("Invalid Noise identity file"));
    }
    Ok(identity(private))
}

fn identity(private: Key) -> Identity {
    let pin = MontgomeryPoint::mul_base_clamped(private).to_bytes();
    Identity { private, pin }
}

pub fn load_or_create(dir: &Path) -> io::Result<Identity> {
    let _guard = lockfile(dir, ".noise-identity.lock")?;
    match load(dir) {
        Ok(identity) => return Ok(identity),
        Err(e) if e.kind() == io::ErrorKind::NotFound => (),
        Err(e) => return Err(e),
    }
    let _workspace = workspace_lock(dir)?;
    let mut private = [0; 32];
    getrandom::fill(&mut private)
        .map_err(|_| io::Error::other("Could not generate Noise identity"))?;
    let pending = dir.join(".noise-identity.pending");
    match fs::remove_file(&pending) {
        Ok(()) => (),
        Err(e) if e.kind() == io::ErrorKind::NotFound => (),
        Err(e) => return Err(e),
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&pending)?;
    file.write_all(&private)?;
    file.sync_all()?;
    fs::rename(pending, dir.join(FILE))?;
    File::open(dir)?.sync_all()?;
    Ok(identity(private))
}
