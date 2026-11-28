# Rothcold Agent

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/icon-dark.svg">
  <img src="assets/brand/icon-light.svg" alt="Rothcold Agent logo" width="96" height="96">
</picture>

Rothcold Agent is a private, single-owner messaging platform. The normal Rust binary now uses [Noise v1](docs/noise-client-contract.md) for all client business. The [Web](docs/noise-web.md) and [iPhone](docs/noise-ios.md) clients in this tree use that protocol; the earlier HTTPS M0 instructions are historical. Implementation and local fixtures are not approval to deploy or a claim of full release acceptance. The workspace rail opens Threads and Inbox. The gear at the top right opens Settings. Inbox and Settings use the full panel without a category sidebar. The breadcrumb shows your category and, inside a thread, its title. Select a category in the sidebar, then a thread from its list. Opening a thread replaces the category directory with the conversation in the main area. Use the back arrow to return to its category. On a phone, use `Workspace` to open the navigation drawer. Use `Find threads or categories` (`Ctrl+K` or `⌘K`) to filter names and titles, not message history. To create a thread, write its first message in the category directory and select `Start thread`. The conversation scrolls separately from the reply box. Unsent drafts stay in the tab when you switch threads or cancel a server change. Switching to a different server discards them. To change its title, open the thread, select `Rename thread`, enter up to 80 characters, and select `Save title`. The bookmark stays the same, even when Hermes is offline. You can read history and send more messages while Hermes is offline. Categories, thread bookmarks, history, queued messages and notifications belong to Rothcold, not the gateway.

Use **Move thread** next to **Rename thread** to change a thread's category without changing its bookmark, draft, or Hermes conversation. Moving works while Hermes is offline. Use **Attach files** in either composer to add up to eight files. Text is optional when files are attached. Images open in a full-size preview; supported video and audio play in the timeline. Every attachment can be downloaded.

Open **Category actions** to rename, archive or restore a category. The default category can be renamed, but cannot be archived. Use **Archive thread** and **Restore thread** inside a conversation. **Archived** in workspace navigation lists hidden categories and threads. Archiving a category hides all of its threads without changing their own archive flags. Existing links and Inbox rows still open archived conversations; restore both the category and the thread (if individually archived) to send normally.

Both message composers format Markdown as you type or paste it. Press `Enter` to send, or `Shift+Enter` or `Ctrl+Enter` to insert a line break. To start a code block while typing, enter three backticks followed by a space.

## Quickstart

Verify the normal server with `script/test-noise` (Rust, SQLite development files, and the WASM Rust target; on macOS also the iOS Rust target). It uses a disposable synthetic SQLite workspace, no Hermes or external service. Run it only with the adapter loopback port 8766 free or in an isolated namespace. To start a persistent local workspace, build the Rust binary and prepare two distinct local secrets (32–512 printable ASCII characters without spaces; do not reuse these examples for a live environment):

```sh
cargo build --locked --release --manifest-path server/Cargo.toml --target-dir server/target
umask 077
keys="$HOME/.config/rothcold-agent/quickstart"
mkdir -p "$keys"
for name in owner adapter; do
  if [ ! -e "$keys/$name.env" ]; then openssl rand -hex 32 > "$keys/$name.env"; fi
done
export ROTHCOLD_AGENT_OWNER_TOKEN="$(cat "$keys/owner.env")"
export ROTHCOLD_AGENT_ADAPTER_TOKEN="$(cat "$keys/adapter.env")"
export ROTHCOLD_DATA_DIR="$HOME/.local/share/rothcold-agent/quickstart"
./server/target/release/rothcold-agent noise-pin
./server/target/release/rothcold-agent
```

Convey the public pin out of band before connecting a v1 client. There is no HTTP login or media fallback. The adapter is not needed to queue work; do not run two servers for one data directory. See the [Noise contract](docs/noise-client-contract.md) for credentials, private LAN/VPN, WSS ingress, fixture and identity recovery instructions.

## Runtime boundary

- `server/` owns SQLite, private files, the Noise responder, and the loopback adapter endpoint. It has no web assets or Python, Node or Hermes runtime dependency. Native clients use Noise on TCP; the optional browser connector uses WSS via a trusted private HTTPS ingress forwarding only `/noise` to a loopback WS bind. Neither connector accepts adapter credentials.
- The Web static site and native app are separate products. The [transport decision](docs/adr/0002-noise-client-transport.md) records the current transport and [iOS delivery plan](docs/ios-first-plan.md) records the remaining acceptance gates. Do not use the older M0 HTTPS instructions with this binary.
- `hermes-adapter/rothcold_agent/` continues to use authenticated loopback HTTP at **127.0.0.1:8766**. It does not open the database or serve a web page. Keep platform ID `rothcold_agent`, owner ID `owner`, and thread UUID as DM `chat_id`. Category IDs are never sent to Hermes. Never expose `/adapter/*` on client ingress.
- `script/build` produces the server binary, license and adapter-only wheel in `dist/`. `script/pnpm build` separately produces the web assets and notices (`web/dist/licenses.md`). Do not stage the workspace into the Hermes plugin directory or sync packages into the host venv.

### Browser appearance

In **Settings → Appearance**, choose **Follow system** (default), **Light**, or **Dark**. Follow system changes as your system appearance changes; manual choices stay fixed. The choice is stored per browser profile and web origin, not per account or backend, and applies to connection and sign-in screens as well as the workspace. If browser storage is unavailable, a manual choice lasts until the page reloads. The web browser must support CSS `light-dark()`.

To check appearance manually, choose Light with the system set to Dark, reload the workspace, then sign out and choose Change server. The workspace, sign-in and connection screens should start in Light without flashing a dark surface. Repeat with Dark and a light system, then select Follow system and change the system appearance while the workspace is open. Check Settings, an unread Inbox item, a thread with Markdown and its composer, and a pending approval at desktop and phone widths. The Chromium suite captures `theme-*.png` in `.screenshots/` when run with `SCREENSHOTS=1` and checks preference behavior and rendered contrast independently of the captures.

## Build and verify

Build the platform with Rust (edition 2024), Cargo, pkg-config and system SQLite development files. `Cargo.lock` pins crate versions; for disconnected builds, fetch the lockfile dependencies before entering the test namespace (`cargo fetch --locked --manifest-path server/Cargo.toml`). Use Node 24.13.0, pnpm 10.33.0, uv 0.13.9 and the pinned Hermes checkout with a CPython 3.14 venv at `venv/`. `script/pnpm` and `script/uv` keep build tools local. Set `HERMES_SOURCE` if the source checkout is not at `$HOME/.hermes/hermes-agent`.

```sh
script/pnpm install --frozen-lockfile --ignore-scripts
script/uv lock --check --no-build
script/build        # API and adapter only
script/pnpm build   # web only
SCREENSHOTS=1 script/test
script/test-gateway
```

`script/test-noise` is the normal-binary, synthetic server/codec smoke. `script/test-gateway` packages only the allowlisted wheel, hides the owner home, and uses a loopback-only namespace, the typed native fixture client and a fake model. It retains queued restart, FIFO, title modeling/race, attachment-only delivery and slash command/skill checks. Do not replace it with a live-profile run. If port 8766 is occupied, use a separate network namespace for test processes; do not stop the live platform for tests. `SCREENSHOTS=1 script/test` is the full server/adapter and browser regression gate on the supported Linux fixture host. It stages the verified wheel and typed Noise driver in a disposable home for the pinned Python adapter assertions, then invokes `script/test-web` for browser, TLS and workspace isolation checks. See the [regression inventory](docs/README.md#regression-migration-inventory) and [Web fixture guide](docs/noise-web.md#disposable-browser-checks). Use [the native guide](docs/noise-ios.md) for Apple silicon host and disposable simulator tests; they do not imply physical iPhone coverage.

## Run separately

After building, stage into a fresh release directory you own. `py` is a Python interpreter for staging the adapter only. The platform binary links system SQLite. Keep `LICENSE` alongside the binary. Separately stage `web/server.mjs` and `web/default-web-config.json` together alongside a copy of the complete `web/dist/` as its `dist/` directory (including `licenses.md`). Run Node 24.13.0 on that `server.mjs` with only web settings; no Node dependencies or build are needed after staging.

```sh
"$py" -I -S script/stage-wheel.py dist/*.whl "$release/plugins"
install -m755 dist/rothcold-agent "$release/rothcold-agent"
install -m644 dist/LICENSE "$release/"
"$release/rothcold-agent"
```

Give the platform process `ROTHCOLD_AGENT_OWNER_TOKEN` for verified Web and native enrollment and `ROTHCOLD_AGENT_ADAPTER_TOKEN` for the adapter. Set distinct random secrets of 32 to 512 printable ASCII characters without spaces. Supply them through protected process environments, not command arguments, URLs or source. `ROTHCOLD_DATA_DIR` selects a private data directory; the default is `~/.local/share/rothcold-agent`. The database and files are local plaintext; back up the entire data directory, including `attachments/`. Files are private UUID-named blobs, including uploads removed before sending; there is no automatic cleanup. Keep the adapter on loopback and follow the Noise contract’s private bind/proxy rules. Back up the persisted Noise identity with the workspace.

For Hermes, install only the staged `rothcold_agent/` plugin, enable it, configure `ROTHCOLD_AGENT_ALLOWED_USERS=owner`, and supply the matching adapter token. The gateway does not need the browser owner token. Do not set `platform_toolsets.rothcold_agent: []` unless you intentionally want zero tools. Streaming stays off; mid-turn tool progress and interim assistant updates go to `/adapter/update` while the turn runs. Slash commands (such as `/sethome`, `/status`, `/model`, `/new`) are enabled; setting a home channel (via `/sethome` or `ROTHCOLD_AGENT_HOME_CHANNEL`) lets cron jobs and cross-platform sends deliver unsolicited messages to `/adapter/push` (including out-of-process via `standalone_sender_fn`). On connect and on an explicit refresh requested through `/adapter/claim`, the adapter reports its own Hermes profile name and optional `assets/avatar.{png,jpg,webp}` via `/adapter/profile` and `/adapter/avatar`. It downloads claimed files via `/adapter/attachments/{id}` and hands them to Hermes as message media. Start one adapter for this workspace. Startup order does not matter: the adapter retries the connection. Do not point multiple gateways at one workspace.

Type `/` in an empty new-thread or reply editor for the current Gateway’s **Commands** and **Skills**. Type more to filter; an exact name moves to the top. Use the arrow keys and Enter or click/tap to fill the draft, not send it. Review the filled text before sending separately. Escape closes the menu; manual input still works if the directory is unavailable (offline, older versions, or discovery failed). `/approve` and `/deny` suggestions only appear for the one live prompt already bound to that reply and its allowed choices; the API and Gateway still validate the separate decision.

The staged adapter reads the pinned Gateway `/commands` registries with its availability, DM access and platform skill filters. This is the Gateway directory, not a listing of arbitrary quick commands, skill bundles, or CLI-only entries. It publishes only slugs to `/adapter/slash-catalog` about every 10 seconds (up to 128 commands and 256 skills, 64 ASCII characters each). Each API keeps its own snapshot in memory, clears it on connect, and expires it after 30 seconds. The browser reads only its current backend’s authorized Noise `SlashCatalog`; no skill body, file path, command arguments or credential fields are sent as catalog metadata. Discovery failure or mixed versions do not block normal delivery.

To check the feature without a real profile, use `script/test-gateway` for the catalog, platform-disabled skill, and explicit dispatch of a discovered command and synthetic skill. `SCREENSHOTS=1 script/test` covers menu selection, draft restoration, IME, and switching to a second backend; inspect `.screenshots/slash-new-thread-1100.png`, `.screenshots/slash-reply-375.png`, and `.screenshots/slash-approval-375.png`. For a physical phone, repeat with a synthetic Gateway: tap a filtered skill, verify the composer still has an unsent draft, then type with a Chinese IME and verify committing a candidate does not send it.

## Upgrade from the embedded Rust web app

Back up the stopped API's data directory before the upgrade and cut over with no outstanding work. Keep the data-directory and token settings; the API upgrades older schemas through v7 in place. Use a verified Noise v1 client and independently provision the public pin. Older HTTP bearer sessions cannot be restored. For rollback to the embedded release, use the pre-upgrade backup rather than pointing the old binary at schema v7.

## Switch from the standalone Python platform

Build and verify first. With no work in flight, stop only `rothcold-agent.service` and take a consistent backup of the stopped workspace. Point the unit's `ExecStart` at the absolute path to the staged Rust binary instead of `python -m rothcold_agent`, and update the token variable names from `PERSONAL_CHAT_*` to `ROTHCOLD_AGENT_*`. Keep the same data directory; the Rust process does not use `PYTHONPATH`. Replace the Hermes `personal_chat` plugin with the staged `rothcold_agent` plugin, update Hermes config to enable `rothcold_agent`, and supply `ROTHCOLD_AGENT_ADAPTER_TOKEN` and `ROTHCOLD_AGENT_ALLOWED_USERS=owner`. Start the server with its private Noise identity; do not route client traffic to the former HTTP API URL. The SQLite schema upgrades automatically through v3 (`turn_updates`), v4 (`device_sessions`), v5 (`attachments`, `identities`, `backend_profiles`), v6 (`thread_title_jobs`), and v7 (archive flags and Inbox previews), so no export or import is needed. To roll back, stop both services and restore the previous plugin, config and launch command. Do not run the two platforms concurrently.

## Upgrade from the hosted plugin

Do not run both listeners on port 8766. Schedule a cutover when there are no outstanding tasks. Stop the old adapter. Back up its plugin and take a consistent SQLite backup of its stopped database (`$HERMES_HOME/personal_chat/history.sqlite3`). Put a separate backup copy at `$ROTHCOLD_DATA_DIR/history.sqlite3`, restrict the directory and file to the owner, then start the standalone platform and the new adapter. Never run both versions against the same data file. Check existing bookmarks, history, and one new thread. No service or production database is changed by the build or test scripts.

Opening a legacy store preserves chats, categories, turns, notifications, read flags and UUIDs. Historical final replies do not create new notifications; only existing notices get previews on upgrade. Existing categories and threads start unarchived. Pre-cutover reserved or accepted turns become `unknown`, not jobs to run again. The new file uses schema version 7. For rollback, stop both new processes and restore the original plugin and its pre-cutover database. Keep any new history separate; rollback does not merge it.

## Queue and privacy guarantees

- An execution approval is a live decision, not a queued message. Read the command, then use the prompt buttons or type `/approve`, `/approve session` or `/deny`. If several prompts are open, use the buttons on the intended prompt. Decisions name one request and cannot be replayed after expiry or reconnect. Upgrade the platform and adapter together with no work in flight. Previously queued unbound approval replies are retained as expired, not sent.
- A regular browser send writes a durable `queued` turn before returning the Noise receipt. A new thread, its category placement, its first turn and attachment links commit together. An exact request UUID replay returns its receipt; changed input conflicts. Acknowledgement means saved locally, not executed by Hermes.
- Archived locations reject new ordinary turns, even from old clients, but accept exact retries of previously queued requests. Archiving is not cancellation: the existing queue, live approval decisions, late finals, deliveries and read state are unchanged.
- New threads immediately show the temporary title from the opening text or, for a file-only opener, the first filename. With Hermes connected, a separate tool-free title request uses only the opening text (no replies, attachment bytes or expanded conversation). It uses the configured Hermes `auxiliary.title_generation` model route and respects both `enabled` and `model_upgrade_enabled`, but ignores Hermes session titles’ `language` override: the thread title should match the opener. Title attempts time out after 10 seconds and lost attempts are not retried. Failures keep the temporary title; old threads and file-only threads are not retitled. A manual rename always wins even when the saved name equals the temporary title. No extra turn or notification is created.
- The adapter claims one message at a time per thread, by insertion order. A final releases the next message automatically. Claims from other threads can proceed. Restarting the platform preserves the offline queue. After a gateway restart or an ambiguous handoff, do not automatically replay a claimed message. A verified late final may settle it. An `unknown` turn blocks later messages until its final arrives or the owner selects `Stop waiting and continue in this thread` and confirms. Confirmation releases only that turn. It does not cancel or retry work, approve commands, or create a notification. Queued messages keep their order and thread. A late final is shown on the original turn. There is no exactly-once inference guarantee across a crash.
- A matching Hermes final and its notification commit in one transaction. Identical redelivery is safe; conflicting text, a queued-but-unclaimed request, mid-turn updates and unanchored replies never become finals or trigger inbox notifications. Opening a thread or polling never clears its inbox by itself. A reply is marked read when its body stays visible in the focused thread for 600 ms with the navigation drawer closed. `Mark thread read` still clears the whole thread. In `Notifications`, select `Enable browser alerts` to request system notifications while the workspace is open and signed in. New unread messages outside your view can trigger an alert; login does not replay old alerts. Alerts contain no conversation text. Select `Turn off browser alerts` to stop them.
- The browser connector serves only an exact-Origin WSS upgrade via its separate private ingress, and no business HTTP. The loopback adapter has no assets and no CORS. An owner session cannot claim adapter work. The adapter token cannot read browser history or create user turns. Keep credentials out of logs.
- Replies, interim updates and delivered home-channel pushes render standard Markdown safely as React nodes (no raw HTML injection; only `http`/`https` links). Unsolicited pushes (`/adapter/push`) commit an answered message and unread inbox notification atomically, never block queued user turns, and are refused while a thread has an unsettled `unknown` turn. No token streaming, outbound agent file attachments or external push. Limits: 128 categories, 128 threads, 128 turns per thread, 256 mid-turn updates per turn, 8,000 characters per user message and 65,536 per update, push or final.

Hermes contract: revision `caafe5389ae585ef77387a962aee05b1bcf17029`, notably `website/docs/developer-guide/adding-platform-adapters.md`, `gateway/platforms/base.py`, `gateway/platforms/event.py`, `gateway/session.py`, `gateway/run_notifications.py`, `agent/title_generator.py` (`build_title_input`), and `agent/auxiliary_client.py` (`async_call_llm`, `title_generation`). Slash discovery also follows `hermes_cli/commands.py`, `hermes_cli/slash_exec.py`, `gateway/slash_access.py`, `gateway/run_inbound.py`, and `agent/skill_commands.py`. See [AGENTS.md](AGENTS.md) for project instructions.

## License

Rothcold Agent is licensed under the [Apache License, Version 2.0](LICENSE). You may use it commercially, including to operate a paid hosted service, subject to the license terms. Third-party components retain their own licenses. The build includes notices for bundled web dependencies in `web/dist/licenses.md`.
