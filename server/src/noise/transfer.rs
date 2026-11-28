use super::{
    Failure, Link, LinkResult,
    auth::{Authorization, authorize},
};
use crate::{
    App, BAD, Error, S,
    attachments::{
        self,
        noise::{self, CancelCommit},
    },
    lock,
};
use rothcold_noise_protocol::v1::{CHUNK_BYTES, Record, Reply, Request, UploadPurpose};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    task::spawn_blocking,
    time::{Instant, timeout_at},
};

const TRANSFER: Duration = Duration::from_secs(120);
const STORAGE: Error = Error(S::INTERNAL_SERVER_ERROR, "Attachment storage unavailable");

async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> LinkResult<T> + Send + 'static,
) -> LinkResult<T> {
    spawn_blocking(job).await.map_err(|_| STORAGE)?
}

pub async fn upload(
    app: &App,
    auth: &Authorization,
    link: &mut Link,
    purpose: UploadPurpose,
    filename: String,
    size: u64,
    mime: Option<String>,
) -> LinkResult<()> {
    authorize(&lock(&app.db), auth)?;
    let max_size = match purpose {
        UploadPurpose::Turn => attachments::FILE_LIMIT,
        UploadPurpose::Avatar => attachments::AVATAR_LIMIT,
    };
    if size > max_size as u64 {
        return Err(Error(S::PAYLOAD_TOO_LARGE, "Attachment exceeds size limit").into());
    }
    if filename.len() > 1024
        || mime.as_ref().is_some_and(|mime| {
            mime.len() > 128 || !mime.is_ascii() || mime.bytes().any(|b| b.is_ascii_control())
        })
    {
        return Err(BAD.into());
    }
    let deadline = link.deadline.min(Instant::now() + TRANSFER);
    timeout_at(
        deadline,
        receive_upload(
            app,
            *auth,
            link,
            purpose,
            filename,
            size,
            mime.unwrap_or_default(),
            deadline,
        ),
    )
    .await
    .map_err(|_| Failure::Close)?
}

#[allow(clippy::too_many_arguments)]
async fn receive_upload(
    app: &App,
    hash: Authorization,
    link: &mut Link,
    purpose: UploadPurpose,
    filename: String,
    size: u64,
    mime: String,
    deadline: Instant,
) -> LinkResult<()> {
    let workspace = app.clone();
    let mut staged = blocking(move || {
        Ok(noise::StagedUpload::begin_upload(
            &workspace, &filename, size, purpose,
        )?)
    })
    .await?;
    staged.classify_hint(&[], &mime);
    authorize(&lock(&app.db), &hash)?;
    link.reply(Reply::UploadReady).await?;
    let mut remaining = size;
    let mut expected = 0;
    loop {
        let record = link.receive().await?;
        authorize(&lock(&app.db), &hash)?;
        match record {
            Record::Chunk { sequence, data }
                if remaining != 0
                    && sequence == expected
                    && data.len() as u64 == remaining.min(CHUNK_BYTES as u64) =>
            {
                if expected == 0 {
                    staged.classify_hint(&data, &mime);
                }
                staged.file.write_all(&data).await.map_err(|_| STORAGE)?;
                remaining -= data.len() as u64;
                expected += 1;
                link.reply(Reply::UploadChunkAccepted { sequence }).await?;
            }
            Record::Control(Request::UploadCancel) => {
                drop(staged);
                return link.reply(Reply::UploadCancelled).await;
            }
            Record::Control(Request::UploadFinish) if remaining == 0 => break,
            _ => return Err(Failure::Close),
        }
    }
    staged.file.flush().await.map_err(|_| STORAGE)?;
    let app = app.clone();
    let cancel = CancelCommit::new(deadline);
    let boundary = cancel.0.clone();
    let worker = blocking(move || {
        staged.prepare_final(&app.attachments)?;
        {
            let mut db = lock(&app.db);
            authorize(&db, &hash)?;
            let tx = db.transaction().map_err(Error::from)?;
            staged.record(&tx)?;
            if !boundary.claim() {
                return Err(Failure::Close);
            }
            tx.commit().map_err(Error::from)?;
        }
        Ok(staged.committed())
    });
    let attachment = tokio::select! {
        biased;
        // The owner must wait for a receipt before sending another record.
        _ = link.pipe.wait_for_peer() => return Err(Failure::Close),
        result = worker => result?,
    };
    link.reply(Reply::UploadComplete { attachment }).await
}

pub async fn download(
    app: &App,
    hash: &Authorization,
    link: &mut Link,
    id: &str,
) -> LinkResult<()> {
    let deadline = link.deadline.min(Instant::now() + TRANSFER);
    timeout_at(deadline, send_download(app, *hash, link, id.to_owned()))
        .await
        .map_err(|_| Failure::Close)?
}

async fn send_download(
    app: &App,
    hash: Authorization,
    link: &mut Link,
    id: String,
) -> LinkResult<()> {
    let workspace = app.clone();
    let (attachment, mut file, permit) = blocking(move || {
        authorize(&lock(&workspace.db), &hash)?;
        Ok(noise::open_download(&workspace, &id, false)?)
    })
    .await?;
    let mut remaining = attachment.size;
    let mut sequence = 0;
    let mut buffer = vec![0; CHUNK_BYTES];
    authorize(&lock(&app.db), &hash)?;
    link.reply(Reply::DownloadStart { attachment }).await?;
    loop {
        let record = link.receive().await?;
        authorize(&lock(&app.db), &hash)?;
        match record {
            Record::Control(Request::DownloadCancel) => {
                drop(permit);
                return link.reply(Reply::DownloadCancelled).await;
            }
            Record::Control(Request::DownloadNext) if remaining == 0 => {
                drop(permit);
                return link.reply(Reply::DownloadComplete).await;
            }
            Record::Control(Request::DownloadNext) => {
                let size = remaining.min(CHUNK_BYTES as u64) as usize;
                file.read_exact(&mut buffer[..size])
                    .await
                    .map_err(|_| STORAGE)?;
                authorize(&lock(&app.db), &hash)?;
                link.chunk(sequence, &buffer[..size]).await?;
                remaining -= size as u64;
                sequence += 1;
            }
            _ => return Err(Failure::Close),
        }
    }
}
