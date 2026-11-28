//! JSON-line driver for isolated Python server smoke tests, not a deployment client.
mod noise_fixture_client;

use noise_fixture_client::{Client, invalid, parse_pin};
use rothcold_noise_protocol::v1::{Record, Request, UploadPurpose};
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};

fn execute(client: &mut Client, data: Value) -> io::Result<Value> {
    if data["type"] == "fixture_upload" {
        let content: Vec<u8> = serde_json::from_value(data["bytes"].clone()).map_err(invalid)?;
        let name = data["filename"]
            .as_str()
            .ok_or_else(|| invalid(()))?
            .to_owned();
        let purpose: UploadPurpose =
            serde_json::from_value(data["purpose"].clone()).map_err(invalid)?;
        let mime = data.get("mime").and_then(Value::as_str).map(str::to_owned);
        return serde_json::to_value(client.upload_with_mime(purpose, name, &content, mime)?)
            .map_err(invalid);
    }
    if data["type"] == "fixture_file_step" {
        let request = serde_json::from_value(data["request"].clone()).map_err(invalid)?;
        client.send(&request)?;
        return match client.receive()? {
            Record::Control(reply) => serde_json::to_value(reply).map_err(invalid),
            Record::Chunk { sequence, data } => {
                Ok(json!({"type":"fixture_chunk", "sequence":sequence, "bytes":data}))
            }
        };
    }
    if data["type"] == "fixture_oversized_control" {
        // The production codec must not serialize a record that exceeds the ciphertext budget.
        let request = Request::LoginNative {
            owner_token: "x".repeat(70_000),
            name: "oversized fixture".into(),
        };
        return Ok(
            json!({"type":"fixture_control_rejected", "rejected":client.transport.request(&request).is_err()}),
        );
    }
    let request: Request = serde_json::from_value(data).map_err(invalid)?;
    match client.exchange(&request)? {
        Ok(outcome) => serde_json::to_value(outcome).map_err(invalid),
        Err(error) => serde_json::to_value(error).map_err(invalid),
    }
}

fn main() -> io::Result<()> {
    let mut args = std::env::args().skip(1);
    let addr = args
        .next()
        .ok_or_else(|| invalid(()))?
        .parse()
        .map_err(invalid)?;
    let pin = parse_pin(&args.next().ok_or_else(|| invalid(()))?)?;
    let stdin = io::stdin();
    let mut client = Client::connect(addr, pin)?;
    let mut stdout = io::stdout().lock();
    for input in stdin.lock().lines() {
        let data = serde_json::from_str(&input?).map_err(invalid)?;
        let result = execute(&mut client, data);
        let value = match &result {
            Ok(data) => data.clone(),
            Err(_) => json!({"type":"fixture_disconnected"}),
        };
        writeln!(&mut stdout, "{value}")?;
        stdout.flush()?;
        result?;
    }
    Ok(())
}
