//! Reproduce the browser ABI known-answer vector with native Snow and the production prologue.
use rothcold_noise_protocol::v1::{self, Reply, Request};
use snow::Builder;

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}
fn print(packet: &[u8]) {
    for byte in packet {
        print!("{byte:02x}");
    }
    println!();
}
fn main() {
    // Fixed public test material from Cacophony's NK test; never used by the product.
    let pin = hex("31e0303fd6418d2f8c0e78b91f22e8caed0fbe48656dcf4767e4834f701b8f62");
    let first = hex("893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a");
    let secret = hex("4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893");
    let second = hex("bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b");
    let build = || {
        Builder::new("Noise_NK_25519_ChaChaPoly_BLAKE2s".parse().unwrap())
            .prologue(v1::PROLOGUE)
            .unwrap()
    };
    let mut initiator = build()
        .fixed_ephemeral_key_for_testing_only(&first)
        .remote_public_key(&pin)
        .unwrap()
        .build_initiator()
        .unwrap();
    let mut responder = build()
        .fixed_ephemeral_key_for_testing_only(&second)
        .local_private_key(&secret)
        .unwrap()
        .build_responder()
        .unwrap();
    let mut packet = [0; v1::HANDSHAKE_PACKET];
    initiator.write_message(&[], &mut packet).unwrap();
    print(&packet);
    responder.read_message(&packet, &mut []).unwrap();
    responder.write_message(&[], &mut packet).unwrap();
    print(&packet);
    initiator.read_message(&packet, &mut []).unwrap();
    let mut initiator = initiator.into_transport_mode().unwrap();
    let mut responder = responder.into_transport_mode().unwrap();
    let request = v1::seal_control(&mut initiator, &Request::Status).unwrap();
    print(&request);
    assert!(matches!(
        v1::open::<Request>(&mut responder, &request).unwrap(),
        v1::Record::Control(Request::Status)
    ));
    let outcome = br#"{"type":"status","service":"rothcold-agent","version":1}"#;
    print(
        &v1::seal_control(
            &mut responder,
            &Reply::ResultStart {
                size: outcome.len() as u64,
            },
        )
        .unwrap(),
    );
    print(&v1::seal_chunk(&mut responder, 0, outcome).unwrap());
    print(&v1::seal_control(&mut responder, &Reply::ResultComplete).unwrap());
}
