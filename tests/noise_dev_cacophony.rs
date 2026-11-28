use super::*;

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

#[test]
fn cacophony_nk_handshake_and_first_transport_record() {
    // Public test vector: https://github.com/centromere/cacophony (also bundled in
    // snow 0.10.0 tests/vectors/cacophony.txt). This vector has its own prologue.
    let prologue = hex("4a6f686e2047616c74");
    let initiator_ephemeral =
        hex("893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a");
    let responder_pin = hex("31e0303fd6418d2f8c0e78b91f22e8caed0fbe48656dcf4767e4834f701b8f62");
    let responder_private = hex("4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893");
    let responder_ephemeral =
        hex("bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b");
    let mut first = Builder::new(PATTERN.parse().unwrap())
        .prologue(&prologue)
        .unwrap()
        .fixed_ephemeral_key_for_testing_only(&initiator_ephemeral)
        .remote_public_key(&responder_pin)
        .unwrap()
        .build_initiator()
        .unwrap();
    let mut second = Builder::new(PATTERN.parse().unwrap())
        .prologue(&prologue)
        .unwrap()
        .fixed_ephemeral_key_for_testing_only(&responder_ephemeral)
        .local_private_key(&responder_private)
        .unwrap()
        .build_responder()
        .unwrap();
    let mut packet = [0; 128];
    let mut decoded = [0; 128];
    let first_payload = b"Ludwig von Mises";
    let n = first.write_message(first_payload, &mut packet).unwrap();
    assert_eq!(
        packet[..n],
        hex(
            "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c794454ae7612d1724af42adb130160a9a94e67b5b169b4e00c189f6467cd17eb7cad"
        )
    );
    let m = second.read_message(&packet[..n], &mut decoded).unwrap();
    assert_eq!(&decoded[..m], first_payload);
    let second_payload = b"Murray Rothbard";
    let n = second.write_message(second_payload, &mut packet).unwrap();
    assert_eq!(
        packet[..n],
        hex(
            "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f144808843986a5c929337e337ac8b4a074af12ab9f76318a5f18c8b599a443af07383ce"
        )
    );
    let m = first.read_message(&packet[..n], &mut decoded).unwrap();
    assert_eq!(&decoded[..m], second_payload);
    let mut first = first.into_transport_mode().unwrap();
    let mut second = second.into_transport_mode().unwrap();
    let transport_payload = b"F. A. Hayek";
    let n = first.write_message(transport_payload, &mut packet).unwrap();
    assert_eq!(
        packet[..n],
        hex("550027c7a5d450017bcb5e12b8253b1c53fd2213aeda84891d5f95")
    );
    let m = second.read_message(&packet[..n], &mut decoded).unwrap();
    assert_eq!(&decoded[..m], transport_payload);
}
