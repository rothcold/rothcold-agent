use super::*;

fn attachment_test_error(error: crate::Error) -> std::io::Error {
    std::io::Error::other(format!("{}: {}", error.0, error.1))
}

#[test]
fn classification_requires_safe_signatures_not_declared_html_or_svg() {
    for bytes in [
        b"<svg onload='alert(1)'>".as_slice(),
        b"<!doctype html>",
        b"OggS\0\x02",
    ] {
        assert_eq!(
            classify(bytes, "image/png", "look.png"),
            ("file", "application/octet-stream")
        );
    }
    for (bytes, expected) in [
        (b"\x89PNG\r\n\x1a\n".as_slice(), ("image", "image/png")),
        (b"\xff\xd8\xff", ("image", "image/jpeg")),
        (b"GIF89a", ("image", "image/gif")),
        (b"RIFF1234WEBP", ("image", "image/webp")),
        (b"RIFF1234WAVE", ("audio", "audio/wav")),
        (b"fLaC", ("audio", "audio/flac")),
        (b"\0\0\0\x10ftypM4A 1234", ("audio", "audio/mp4")),
        (b"\0\0\0\x10ftypmp421234", ("video", "video/mp4")),
        (b"\0\0\0\x10ftypqt  1234", ("video", "video/quicktime")),
    ] {
        assert_eq!(
            classify(bytes, "application/octet-stream", "file"),
            expected
        );
    }
    let webm = b"\x1a\x45\xdf\xa3\x42\x82\x84webm";
    assert_eq!(
        classify(webm, "audio/webm; codecs=opus", "sample.webm"),
        ("audio", "audio/webm")
    );
    assert_eq!(
        classify(webm, "application/octet-stream", "sample.webm"),
        ("video", "video/webm")
    );
    let mut ogg = [0; 37];
    ogg[..6].copy_from_slice(b"OggS\0\x02");
    ogg[26] = 1;
    ogg[28..36].copy_from_slice(b"OpusHead");
    assert_eq!(
        classify(&ogg, "video/ogg", "sample.ogg"),
        ("audio", "audio/ogg")
    );
    ogg[28..35].copy_from_slice(b"\x80theora");
    assert_eq!(
        classify(&ogg, "audio/ogg", "sample.ogg"),
        ("video", "video/ogg")
    );
}

#[test]
fn filename_sanitization_and_disposition() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-rothcold-filename",
        "..%2Ffoo%5C%20r%C3%A9sum%C3%A9%0A.pdf%20".parse()?,
    );
    assert_eq!(
        filename(&headers).map_err(attachment_test_error)?,
        "résumé.pdf"
    );
    assert_eq!(
        disposition(true, "résumé.pdf"),
        "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"
    );
    headers.insert("x-rothcold-filename", "%ff".parse()?);
    assert!(filename(&headers).is_err());
    headers.insert("x-rothcold-filename", "..%2F..".parse()?);
    assert!(filename(&headers).is_err());
    Ok(())
}

#[test]
fn single_byte_ranges_clip_and_reject_invalid_or_unsatisfiable_ranges() {
    for (header, expected) in [
        ("bytes=0-0", Some((0, 0))),
        ("bytes=2-9", Some((2, 4))),
        ("bytes=2-", Some((2, 4))),
        ("bytes=-2", Some((3, 4))),
        ("bytes=-9", Some((0, 4))),
        ("bytes=5-", None),
        ("bytes=-0", None),
        ("bytes=4-1", None),
        ("bytes=0-1,3-4", None),
        ("items=0-3", None),
    ] {
        assert_eq!(byte_range(header, 5), expected, "{header}");
    }
    assert_eq!(byte_range("bytes=0-", 0), None);
}

#[tokio::test]
async fn served_downloads_use_safe_headers_and_hold_transfer_slots_through_body()
-> std::result::Result<(), Box<dyn std::error::Error>> {
    let dir = std::env::temp_dir().join(format!("rothcold-test-{}", Uuid::new_v4()));
    init_dir(&dir)?;
    struct Scratch(std::path::PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let scratch = Scratch(dir);
    let mut db = Connection::open_in_memory()?;
    crate::store::init(&mut db)
        .map_err(crate::Error::from)
        .map_err(attachment_test_error)?;
    let app = std::sync::Arc::new(crate::Platform {
        db: std::sync::Mutex::new(db),
        auth: std::sync::Mutex::new(crate::Auth {
            window: std::time::Instant::now(),
            failures: 0,
        }),
        approvals: Default::default(),
        profiles: Default::default(),
        attachments: scratch.0.clone(),
        attachment_slots: Default::default(),
        owner: String::new(),
        bridge: String::new(),
    });
    let mut headers = HeaderMap::new();
    headers.insert("x-rothcold-filename", "test.png".parse()?);
    headers.insert(header::CONTENT_TYPE, "image/png".parse()?);
    for content in [
        b"<svg xmlns='http://www.w3.org/2000/svg'/>".as_slice(),
        b"<!DOCTYPE html><script></script>",
    ] {
        let (_, Json(item)) = save(
            app.clone(),
            headers.clone(),
            Bytes::from_static(content),
            false,
        )
        .await
        .map_err(attachment_test_error)?;
        let served = serve(app.clone(), item.id, HeaderMap::new(), false, false)
            .await
            .map_err(attachment_test_error)?;
        assert_eq!(
            served.headers()[header::CONTENT_TYPE],
            "application/octet-stream"
        );
        assert_eq!(
            served.headers()[header::CONTENT_DISPOSITION],
            "attachment; filename*=UTF-8''test.png"
        );
        assert_eq!(
            axum::body::to_bytes(served.into_body(), 1024).await?,
            content
        );
    }
    let (_, Json(image)) = save(
        app.clone(),
        headers,
        Bytes::from_static(b"\x89PNG\r\n\x1a\n"),
        false,
    )
    .await
    .map_err(attachment_test_error)?;
    let mut range = HeaderMap::new();
    range.insert(header::RANGE, "bytes=1-3".parse()?);
    let served = serve(app.clone(), image.id.clone(), range, false, false)
        .await
        .map_err(attachment_test_error)?;
    assert_eq!(served.status(), S::PARTIAL_CONTENT);
    assert_eq!(served.headers()[header::CONTENT_RANGE], "bytes 1-3/8");
    assert_eq!(served.headers()[header::ACCEPT_RANGES], "bytes");
    assert_eq!(served.headers()[header::CONTENT_LENGTH], "3");
    assert_eq!(
        axum::body::to_bytes(served.into_body(), 1024).await?,
        b"PNG".as_slice()
    );
    let mut responses = Vec::new();
    for _ in 0..DOWNLOAD_SLOTS {
        responses.push(
            serve(
                app.clone(),
                image.id.clone(),
                HeaderMap::new(),
                false,
                false,
            )
            .await
            .map_err(attachment_test_error)?,
        );
    }
    let saturated = serve(
        app.clone(),
        image.id.clone(),
        HeaderMap::new(),
        false,
        false,
    )
    .await
    .unwrap_err();
    assert_eq!(saturated.0, S::SERVICE_UNAVAILABLE);
    drop(responses.pop());
    assert_eq!(
        serve(app, image.id, HeaderMap::new(), false, false)
            .await
            .map_err(attachment_test_error)?
            .status(),
        S::OK
    );
    Ok(())
}
