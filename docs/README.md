# Noise integration guides

- [Wire, security boundaries, and server startup](noise-client-contract.md)
- [Planned: newest-first history, session caches and Mac handoff](thread-history-plan.md)
- [Web wiring and disposable Chromium checks](noise-web.md)
- [iPhone wiring, host and disposable simulator checks](noise-ios.md)
- [Release acceptance plan](ios-first-plan.md), [transport decision](adr/0002-noise-client-transport.md), and [historical HTTPS M0](ios-m0-runbook.md)

## Joint Web and iPhone acceptance

On an Apple silicon Mac with the local prerequisites in the [Web](noise-web.md) and [iPhone](noise-ios.md) guides, set `PLAYWRIGHT_DIR` and run `script/test-noise-joint`. The script creates and removes its own simulator. Keep adapter port 8766 free. It does not install on a physical phone or change system trust.

Chromium uploads a fresh random file to a disposable workspace. The SwiftUI app downloads it in the conversation, saves it through Files, imports it and attaches it to a new reply. The original browser tab must display that reply without navigation or reload, then download identical bytes. The script checks for business HTTP requests and writes a receipt to the printed `mobile/core/target/joint-*/joint-result.json`.

The first run exposed a stale settled thread in Web. After the foreground refresh fix, the repeated test passed with 98,345 bytes, SHA-256 `ac47e3bc25314fb8854cef3e97a07ddaeea45a9243725af2b7edacd6b26d5934` and zero browser business HTTP requests. Each rerun generates new bytes and a new digest. This is local protocol acceptance on iOS Simulator 27.2, not the Linux release gate or physical-iPhone sign-off.

## Regression migration inventory

The release gate is `SCREENSHOTS=1 script/test` plus the separate `script/test-gateway` on a supported Linux host. `script/test` runs server checks, stages the RECORD-verified adapter wheel and typed fixture client in a clean home, runs `tests/test_chat.py` with the pinned Hermes venv, then runs `script/test-web`. Only the adapter uses HTTP business routes. Browser trust and the second workspace are the Web suite's responsibility; keep synthetic certificates/trust in a throwaway home and the second server in a separate network namespace. Do not run Gateway outside its original loopback-only namespace. [Apple silicon checks](noise-ios.md) and the disposable cross-client journey are complementary; they do not substitute for Linux, a physical iPhone, or authorization to deploy.

### Python/Hermes adapter assertions

| Old assertion area | Current assertion |
| --- | --- |
| Startup/API login | Start the normal binary, independently obtain the pin using `noise-pin`, handshake on the ephemeral TCP listener, and use `LoginNative`. No `/api/login` health or bootstrap dependency. |
| `test_profile_autofill_customizations_and_live_refresh`, `test_profile_sync_preserves_newer_agent_edit_and_requires_matching_report` | Typed profile reads, edits, avatar upload and sync; adapter reports still HTTP. Preserve passive autofill, offline/no-profile behavior, live sync, two-device concurrent edit priority, stale/wrong report rejection and correlation. |
| `test_native_upload_slots_reject_before_reading_body` | `test_native_upload_slots_reject_before_reading_bytes`: reserve two typed slots, third gets `busy` before any bytes, cancel, verify cleanup and reuse. |
| `test_attachments_ranges_disk_safety_and_hermes_media_event` | `test_attachments_media_disk_safety_and_hermes_media_event`: verify typed file byte equality, safe filename/kind and disk permissions, SVG/HTML downgrade, raster avatar and request bounds, staging and atomic enqueue, adapter-only linked media Range (206/416), and real Hermes media-event bytes and metadata. Client HTTP and Range routes must be absent. |
| `test_adapter_retries_busy_attachment_download_before_single_admission` | Hold all eight slots with real typed `DownloadStart`, observe HTTP adapter `503` with the turn still reserved and no event, cancel downloads, then assert one successful adapter read, one admission and one media event. |
| `test_move_offline_keeps_thread_and_queue_ids`, `test_rename_offline_thread`, `test_channels` | Typed file-independent category/thread operations keep stable IDs and queues; missing, blank, duplicate and changed-ID inputs reject appropriately. The unauthenticated/HTTP receipt path is closed. |
| `test_close_before_final`, `test_interrupted_admission` | Two verified live connections race the durable enqueue; one is fresh. Disconnect clients through final, restore, retain progress/commentary/final and unchanged receipts; an uncertain Hermes claim is never replayed. |
| `test_live_session_approval`, `test_approval_is_not_a_fifo_turn` | Use typed card, chat and choice rather than HTTP slash-body multiplexing; reject mismatched, duplicate and expired decisions and unbound `/approve` as ordinary input; preserve the archived live decision and queued next turn. |
| `test_archive_is_reversible_without_changing_queue_or_inbox_correlation` | Typed active/all category and thread lists, hidden parent semantics, archive/restore, unknown-turn release by ID, late final, and grapheme-safe push/preview with read state. |
| `test_thread_title_adapter_boundary_and_single_use`, `test_final_body_limit_and_redelivery` | Adapter bearer, Origin and body validation remain HTTP. Verify independent title claim/result and duplicate result behavior, 65,536-character final over multi-record Noise, and no duplicate notification. |
| `test_independent_device_sessions_restart_expiry_and_revocation`, `test_login_rate_limit` | Typed independent devices, responder-scoped hash, real restart restore, revoke/logout/expiry on open and new links, and login throttling. |
| `test_cli_history_permissions`, `test_existing_python_workspace` | Check startup-created private paths and read the real synthetic v2 database through typed directory/history/inbox after normal in-place migration. |
| `test_home_channel_push_and_standalone_send` | Hermes registry and standalone sender still deliver correlated replies and pushes, reject a missing target, read state and safe previews. |
| `test_boundary` | Wrong native pin, unauthenticated typed operations, adapter/native authority separation, old `/api/*` and assets absent, no HTTP response from native TCP, adapter exact Host/Origin and request bounds, no CORS, typed slash catalog. |

### Browser and connector assertions

| Old browser or ingress fixture | Current assertion owner |
| --- | --- |
| `test_web_attachment_transfer_slots_with_slow_clients` (mock proxy) | Real server transfer bounds in the Python tests above and `script/test-noise`; the Web suite owns browser transfer completion, interruption and no byte fallback. There is no HTTP body proxy to test. |
| `test_browser`, `test_browser_profiles_attachments_and_moves`, `test_browser_archive_and_inbox_previews` | `script/test-web` owns real Chromium navigation, workspace state, composer/slash/approval, attachment/profile, archive and Inbox behavior against normal Noise. |
| `test_browser_offline` / alternate Unix-socket API relay | `script/test-web` owns offline/switching behavior. A second selector for the same responder proves only selector scoping; the Linux acceptance gate needs a separately namespaced server with a different workspace and pin. No HTTP API relay is allowed. |
| `test_delayed_upstream_401_does_not_clear_a_new_login`, `test_web_connections_and_cookie_boundaries` | The obsolete HTTP cookie and delayed 401 proxy behaviors do not carry over. Verify fresh proof, no browser bearer/cookie, explicit reconnect, dropped stale results, responder/selection isolation, upgrade allowlist and negative HTTP business routes in `script/test-web`. |
| `test_standalone_web_default_is_packaged` | Web ownership: stage `web/default-web-config.json` beside `web/server.mjs` and assert the fixed deployment config without any business HTTP. |
| `test_https_ingress_trusted_browser_and_native_api` | Web retains trusted HTTPS/WSS with disposable CA, exact Origin/Host and no proxy to adapter; native now checks the independent Noise pin, independent of HTTPS and browser trust. Old native HTTPS is not a fallback. |

The typed fixture driver smoke can be run against the release binary without installing or starting Hermes. See [the commands in the server contract](noise-client-contract.md#operator-runbook-and-disposable-validation). This is not a passing real Gateway or full browser suite.
