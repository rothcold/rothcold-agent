# Native iPhone Noise v1

This client is built for iPhone (iOS 26.0 minimum). It talks directly to the normal Rust server using `Network.framework` TCP and the repository's shared Noise v1 codec through locked UniFFI. There is no client HTTP transport, HTTPS certificate, ATS override, domain requirement, or HTTP media URL. The adapter remains a separate service on `127.0.0.1:8766`. See the [v1 contract](noise-client-contract.md) and [ADR](adr/0002-noise-client-transport.md); the older HTTPS M0 instructions don't apply.

## Connect, restore and revoke

1. Start the normal server with a disposable or otherwise explicitly approved workspace; keep the adapter loopback-only. Run `rothcold-agent noise-pin` in its trusted shell and provide the resulting **public** 64-character hex pin over a separate authenticated channel. Restrict a private-interface bind with a firewall/VPN ACL.
2. In the app enter the assigned private IP address (optional port, default `8768`; use `[address]:port` for IPv6 ULA). Check the complete public pin independently before entering it. Loopback is for local simulation/testing only. Neither an address nor the ability to connect proves identity.
3. Tap **Verify and connect**. Only after a verified Noise handshake and service/version check does the app restore or offer **Sign in**. Use the owner token transiently and pick a recognizable device name. The device credential is the only secret kept in Keychain, keyed by the canonical endpoint and verified pin, non-synchronizing and `WhenUnlockedThisDeviceOnly`. There is no migration of older HTTP sessions. Defaults store only the selected public endpoint/pin and appearance.
4. **Settings → Sign out this device** waits for server-side revocation (or a later authorization rejection) rather than silently treating a failed network request as signed out. Devices can revoke other devices. **Change server** clears workspace state and drafts; it does not revoke the old credential. If another device revokes this one while the app is closed, a denied restore clears the stale credential and shows sign-in. For a lost enrollment receipt, check and revoke any orphan from another signed-in device; don't blindly enroll again. For a changed pin, verify the replacement out of band and select it explicitly. No automatic pin replacement or mutation retry.

After an interrupted send, reconnect intentionally. The in-memory draft locks its original UUID/text/attachment IDs until the same send is deliberately retried or the owner explicitly unlocks it after checking history. Unlocking does not undo a committed turn. Approval decisions are sent only to a displayed live prompt, never saved or retried. For `unknown`, confirm **Stop waiting** on that exact turn; it does not cancel backend work or move a late final.

## Workspace scope

- Rust projects the active directory from paged categories/threads. iPhone shows category navigation, title-only search, independent archive/restore flags, rename and move, new-thread composition and thread replies. Archived conversations are still reachable from Inbox or the archived directory and allow live approval/recovery, but not ordinary sends.
- Conversation history shows queue state, progress/commentary, live choices and selectable inline Markdown for finals. Foreground Inbox/history refreshes without marking on fetch; a visible final needs a continuous 600 ms interval before sending its own receipt. Whole-thread marking is explicit. Commands and skills can be loaded into the draft from the selected server without sending; `/approve` and `/deny` are bound to a single live choice at draft start or can be selected on the card itself.
- Uploads go through Files, up to eight staged IDs per message. The full authenticated bytes are streamed in sequence and checked against receipts. A transfer can close on cancel; it doesn't finish a partial upload or undo a committed upload. Downloads become private local copies only after the terminal receipt and exact size. Supported raster/audio/video can use local preview; unsupported files, including SVG/HTML, can only be saved using Files. While a preview is up the app rechecks authorization about once a second and rechecks before opening the export picker. A failed check closes the preview and discards the private copy. Copies are also cleared on dismissal, background, or server switch. Revocation is detected by requests, not pushed by the server; already completed user exports are outside that lifetime.
- Settings includes device list/revocation, profile names, owner and agent avatar upload/view/clear, backend profile sync and appearance. Avatar upload/selection and its later download use Noise, not a separate image service.
- Not implemented: full Web block Markdown rendering (tables, rich code-block presentation), automatic foreground alert banners, durable drafts across termination, and exact category scroll/focus restoration. Native playback depends on the system's available codecs. No background push, Android, hosted-device test or physical-device installation is included.

## Run locally on Apple silicon

Use Xcode 27.2, the local `rustup` toolchain, and installed arm64 iOS/simulator Rust targets. `script/ios-build` builds both app SDKs unsigned. `script/test-ios` builds the normal Rust server and runs the production Swift/UniFFI host harness with synthetic credentials, an OS-assigned localhost Noise port, and a disposable data directory. It needs exclusive access to adapter port `8766`. Its mock adapter uses the unchanged loopback HTTP contract; it is not a real Hermes Gateway run.

For the installed iOS 27.2 simulator, create a disposable device instead of using a personal simulator or connected phone:

```sh
udid=$(xcrun simctl create 'Rothcold Noise Disposable 27.2' \
  com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro \
  com.apple.CoreSimulator.SimRuntime.iOS-27-2)
xcrun simctl boot "$udid"
xcrun simctl bootstatus "$udid" -b
script/test-ios "$udid"
xcrun simctl shutdown "$udid"
xcrun simctl delete "$udid"
```

`script/test-ios "$udid"` additionally runs the XCTest against another isolated normal server. The fixture accepts only the dedicated iOS 27.2 simulator. It uses Xcode's disposable ad-hoc simulator signing for Keychain (the native unsigned checks remain separate), without an Apple account, developer team, provisioning profile, trust change, shared group, or Keychain mock. It exports named screenshots and redacted test logs into the printed `mobile/core/target/ios-evidence-*` directory. The separate reconnect scenario drops a genuine send receipt, verifies there is no automatic replay, checks the same device and exact draft after explicit reconnect, and proves the existing connection and cold start both reject a device revoked by an independent verified device. A different loopback relay address and a replacement pinned server prove Keychain entries cannot cross either boundary. Do not run it on a simulator with personal data.

## Cross-client file check

The deterministic synthetic payload `ios-cross-client.bin` is 98,345 bytes (four Noise records), byte `i` = `(73*i + 19) % 256`, SHA-256 `e0a44fb296f2816dfd2699da22f394e5bd1bd5ab9999fe1081e4fe7f4db2b5d2`. The host and simulator fixtures write attachment/thread IDs and digests for their *disposable* servers. IDs from an exited fixture won't exist on the next server.

Run [`script/test-noise-joint`](../script/test-noise-joint) for the [automated Web-to-iPhone round trip](README.md#joint-web-and-iphone-acceptance). Unlike the standalone deterministic fixture, this test generates fresh random bytes in Chromium and checks the file returned by the iPhone UI in the original browser tab. For a separate transport-only check, the independently compiled iOS production transport can verify a peer attachment on a live disposable server: `mobile/core/target/ios-native-tests download <attachment-id>` with fixture-only `IOS_NOISE_TEST_ADDRESS`, `IOS_NOISE_TEST_PIN`, `IOS_NOISE_TEST_OWNER`, and `IOS_NOISE_TEST_ARTIFACTS` in the process environment. It prints `size sha256` and revokes its temporary device. Do not put a token in argv. A transport-only check does not replace the two-product UI test or authorize release.

Before a physical-device release, with explicit owner approval for the installation, verify local/private LAN or VPN permission and address reachability, pin mismatch/rotation, Keychain across true app restart and device lock, revocation while a native connection is open, VoiceOver/Dynamic Type and IME, local Photos/Files providers, export/save and representative raster/audio/video playback, and screenshots on a compact iPhone. Separately run the required Web and isolated Hermes Gateway checks on their supported hosts. No real device installs or trust/account changes are part of this runbook's automated checks.
