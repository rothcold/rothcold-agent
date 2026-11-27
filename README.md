# Rothcold Agent

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/icon-dark.svg">
  <img src="assets/brand/icon-light.svg" alt="Rothcold Agent logo" width="96" height="96">
</picture>

Rothcold Agent is a private, single-owner messaging platform. Open the web app at `http://127.0.0.1:8765/`, connect to your API, sign in, and select a category. The workspace rail opens Threads and Inbox. The gear at the top right opens Settings. Inbox and Settings use the full panel without a category sidebar. The breadcrumb shows your category and, inside a thread, its title. Select a category in the sidebar, then a thread from its list. Opening a thread replaces the category directory with the conversation in the main area. Use the back arrow to return to its category. On a phone, use `Workspace` to open the navigation drawer. Use `Find threads or categories` (`Ctrl+K` or `⌘K`) to filter names and titles, not message history. To create a thread, write its first message in the category directory and select `Start thread`. The conversation scrolls separately from the reply box. Unsent drafts stay in the tab when you switch threads or cancel a server change. Switching to a different server discards them. To change its title, open the thread, select `Rename thread`, enter up to 80 characters, and select `Save title`. The bookmark stays the same, even when Hermes is offline. You can read history and send more messages while Hermes is offline. Categories, thread bookmarks, history, queued messages and notifications belong to Rothcold, not the gateway.

Use **Move thread** next to **Rename thread** to change a thread's category without changing its bookmark, draft, or Hermes conversation. Moving works while Hermes is offline. Use **Attach files** in either composer to add up to eight files. Text is optional when files are attached. Images open in a full-size preview; supported video and audio play in the timeline. Every attachment can be downloaded.

Both message composers format Markdown as you type or paste it. Press `Enter` to send, or `Shift+Enter` or `Ctrl+Enter` to insert a line break. To start a code block while typing, enter three backticks followed by a space.

## Quickstart

Start a local workspace and save your first message. Hermes and model credentials are not required for this part. Use Linux, a POSIX shell and free loopback ports 8766 (API) and 8765 (web). If you already run Rothcold, do not start another process against its data directory.

1. Build each component from the project root. The API needs a Rust edition 2024 toolchain, a C toolchain, pkg-config and SQLite development files. An existing compatible `dist/rothcold-agent` needs only system SQLite at runtime. The web build separately needs Node 24.13.0, curl, tar and OpenSSL (for the pnpm 10.33.0 wrapper).

   ```sh
   cargo build --locked --release --manifest-path server/Cargo.toml --target-dir server/target
   script/pnpm install --frozen-lockfile --ignore-scripts
   script/pnpm build
   ```

2. Create two private tokens and start the server. Run this block again to reopen the same quickstart workspace with the same credentials. It uses a separate data directory from a service installation.

   ```sh
   umask 077
   keys="$HOME/.config/rothcold-agent/quickstart"
   mkdir -p "$keys"
   for name in owner adapter; do
     if [ ! -e "$keys/$name.env" ]; then openssl rand -hex 32 > "$keys/$name.env"; fi
   done
   export ROTHCOLD_AGENT_OWNER_TOKEN="$(cat "$keys/owner.env")"
   export ROTHCOLD_AGENT_ADAPTER_TOKEN="$(cat "$keys/adapter.env")"
   export ROTHCOLD_DATA_DIR="$HOME/.local/share/rothcold-agent/quickstart"
   ./server/target/release/rothcold-agent
   ```

3. In a **separate terminal**, without the owner or adapter secrets, start the web app with `script/pnpm start` (or `pnpm start` in `web/` with the pinned tools). Open [the web app](http://127.0.0.1:8765/) on this machine. On **Connect to a server**, the default is `http://127.0.0.1:8766`. Choose **Connect**; the web app checks the Rothcold API before showing the sign-in form. Paste the value of `~/.config/rothcold-agent/quickstart/owner.env` into **Owner token**, optionally naming this device. In **General**, send a message. It creates a thread and shows `Queued. Waiting to send to Hermes.` This is expected without a gateway. Press `Ctrl+C` in either terminal to stop that process; the API keeps the message on disk.

4. To get an agent reply, use a Hermes Gateway that already has a working model. Follow [Build and verify](#build-and-verify) to build the adapter wheel, then [Run separately](#run-separately) to stage and enable `rothcold_agent`. Give the gateway `ROTHCOLD_AGENT_ALLOWED_USERS=owner` and the value from `adapter.env` as `ROTHCOLD_AGENT_ADAPTER_TOKEN`, never the owner token. Start the platform and gateway. The queued message is delivered without resending it.

## Runtime boundary

`browser ↔ web/static + same-origin proxy ↔ Rust API ↔ loopback adapter ↔ Hermes Gateway`

- `server/` builds the API. It owns SQLite and listens on `127.0.0.1:8766`. It has no web assets or web build dependency and needs neither Python, Hermes nor Node. Native clients use the API directly or through the HTTPS API ingress below.
- `web/` builds and serves the React + TypeScript app. Its Node server serves `web/dist/` and proxies only supported browser API requests to trusted API origins. It never opens SQLite, reads the owner or adapter secret from the environment, or proxies `/adapter/*`. It can start while the API is offline; connecting will fail without asking for your token.
- `hermes-adapter/rothcold_agent/` uses authenticated loopback HTTP to claim messages and deliver replies. It does not open the database or serve a web page. Keep the platform ID `rothcold_agent`, owner ID `owner`, and thread UUID as the DM `chat_id`. Category IDs are never sent to Hermes.
- `script/build` produces the API binary, license and adapter-only wheel in `dist/`. `script/pnpm build` separately produces the web assets and web dependency notices (`web/dist/licenses.md`). Do not stage the workspace into the Hermes plugin directory or sync packages into the host venv.

## Web connection and devices

Choose an API address on the first visit. The field defaults to `ROTHCOLD_API_URL` in the **web process** environment, then `defaultApi` in the web config file, then the packaged `web/default-web-config.json` (`http://127.0.0.1:8766`). A verified address saved in this browser takes precedence on later visits. If it no longer works or is no longer trusted, the connection page shows the saved address so you can change it. To switch later, select the top-right **Settings** gear, then **Change server**. The old session stays with its original server; reconnecting to that exact address can restore it. To invalidate it instead, sign out before switching or revoke it on that server from another signed-in device.

The web config file defaults to `rothcold-web.json` next to `web/server.mjs`. To use another file set `ROTHCOLD_WEB_CONFIG` to its absolute path. Restart the web process after an admin config change. The effective default is trusted; additional exact addresses must be explicitly allowed in `trustedApis`. When overriding `defaultApi` with the environment, list the file's default in `trustedApis` if it should still be selectable. For example:

```json
{
  "defaultApi": "http://127.0.0.1:8766",
  "trustedApis": ["https://api.home.example"]
}
```

Use canonical origins only: scheme, host and optional non-default port, with no slash, path, credentials, query or fragment. Plain HTTP is accepted only on literal `127.0.0.1` or `[::1]`. The web server has no free-form proxy, follows no redirects, and verifies `/api/status` for the expected service and API version before login. This check identifies a compatible API; it does not make an untrusted server safe. Only allowlist operator-controlled origins and verify the address before submitting the owner token. Do not use plain HTTP over LAN or VPN. The web listening port defaults to 8765 (`ROTHCOLD_WEB_PORT`); set `ROTHCOLD_WEB_ORIGIN` to the exact public HTTPS origin behind TLS. The Node listener always binds `127.0.0.1`.

Each sign-in creates a new device session with a fixed 30-day lifetime. Logging in on a second device does not sign out the first. Reloads and process restarts preserve unexpired sessions when the database, web origin, and API address are unchanged. The owner token isn't stored in the browser; the session is a persistent HttpOnly, SameSite=Strict cookie (`Secure` on HTTPS). On local HTTP, cookies are not a port-level isolation mechanism: use the defaults only on a trusted workstation, not a shared browser host. In **Settings**, **Sign out this device** revokes only this session; its unusable cookie expires or is replaced at the next sign-in. You can use **Revoke** next to a lost device to end its session without needing its credential. Expiry or revocation requires signing in again. Rotating the owner token controls future logins but does not revoke devices already signed in; revoke those separately if needed.

In **Settings → Profile**, set the display names and avatars shown on owner and agent messages. An empty name uses the workspace fallback. **Sync from backend** refreshes a selected live backend (or uses its last saved profile when offline) and applies its non-empty name and any avatar to the agent. Passive backend reports fill empty agent fields only; they do not replace custom values.

## Native sessions and LAN/VPN HTTPS

For native clients, use JSON `POST /api/login` with `{"token":"<owner token>","name":"<optional device label>"}`. Take `session` from the response and keep it in OS-protected storage; the API returns it only when creating the session and stores only its hash. Send `Authorization: Bearer <session>` for `GET /api/me`, `GET /api/sessions`, `POST /api/logout`, or `POST /api/sessions/{id}/revoke` (send `{}` for logout/revoke). The list returns the current device ID plus device IDs, labels, creation and expiration times, never bearers. Times are Unix seconds. `401` means the credential is missing, expired or revoked. `GET /api/status` is public. Native clients must not send an `Origin` header or browser fetch metadata. There is no CORS; cross-origin browser calls cannot use this native API. Browsers use the web origin with a cookie, never a bearer in JavaScript.

- `GET /api/profile` returns owner, agent, and backend profiles. `POST /api/profile` patches the owner and/or agent (`name`: 0–80 characters without controls; `avatar`: an existing avatar ID or `null`). `POST /api/profile/sync` takes `{}` or `{"backend":"…"}` and returns the updated profile and a sync summary. A live refresh waits up to three seconds. If no backend profile is available, or the agent profile was edited while waiting, the endpoint returns `409`; a newer manual edit is preserved.
- `POST /api/attachments` accepts raw bytes with `Content-Type` and `X-Rothcold-Filename` (percent-encoded UTF-8 basename). `X-Rothcold-Purpose` is `turn` (default, 25 MiB) or `avatar` (raster image only, 5 MiB). Send the returned IDs in `attachments` on `POST /api/chats` or `POST /api/chats/{chat}/turns`. `GET /api/attachments/{id}` serves recognized raster images and audio/video inline with single-byte-range support; HTML, SVG and other files are downloads. Add `/download` to force a download for media as well. The web app uses backend-scoped `/api/media/…` URLs and the same device cookie, not public links. Attachment transfers return `503` when all transfer slots are busy; retry when a slot is free.
- `POST /api/chats/{chat}/move` takes `{"channel":"<category ID>"}` and changes only placement. Missing threads or categories return `404`.

On a phone or another machine use **trusted HTTPS** over private LAN/VPN for both the web and native endpoints. Leave both processes on loopback and run the TLS reverse proxy on the same host. Use distinct hostnames for the web and native API, firewall to intended LAN/VPN clients, and install a trusted private CA on those clients (including the web runtime if it uses the private HTTPS API as an upstream), or use a trusted certificate for your private hosts. If the web runtime must trust a private HTTPS upstream, run `node server.mjs` with an explicit `NODE_EXTRA_CA_CERTS` path in its restricted environment. Do not disable certificate verification. For example, on a Caddy host with a private VPN address `10.91.0.2`, point both names at that address in private DNS. Set the web process `ROTHCOLD_WEB_ORIGIN=https://workspace.home.example`; it can still use the default loopback API upstream. Replace the addresses and names below with your own:

```caddyfile
{
    auto_https disable_redirects
}

https://workspace.home.example {
    bind 10.91.0.2
    tls internal
    reverse_proxy 127.0.0.1:8765
}

https://api.home.example {
    bind 10.91.0.2
    tls internal
    @api {
        method GET POST
        path /api/*
    }
    handle @api {
        reverse_proxy 127.0.0.1:8766 {
            header_up Host 127.0.0.1:8766
        }
    }
    handle {
        respond 404
    }
}
```

Preserve the browser `Host` and `Origin` on web ingress; never rewrite or remove `Origin` to bypass checks on native ingress. Do not send credentials to an HTTP ingress (including one that redirects), expose the direct listeners, mount the entire Rust listener publicly, or publish `/adapter/*`. Do not enable request header/body logging or log `Authorization`, `Cookie` or `Set-Cookie`. Give the web process only its web config, not a shared secrets file. The API and web server do not rely on client-supplied `X-Forwarded-*` headers for authority.

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

If port 8766 is occupied, do not stop the live platform for a test. Run `SCREENSHOTS=1 bwrap --unshare-net --bind / / --dev /dev --proc /proc script/test` instead. The tests verify the wheel allowlist and RECORD, stage the verified adapter and start the Rust binary, and use synthetic databases and disposable credentials. The browser test builds and runs the standalone web server with local Chromium and Playwright. It uses `bwrap` for a second isolated API with a different database and credentials. With OpenSSL and `certutil`, a disposable TLS ingress fixture exercises a CA verified by Chromium and by the native HTTP client; it is not a Caddy test. Run with `SCREENSHOTS=1` to write desktop/mobile connection, settings/profile, category directory and thread detail, attachments, thread move, approvals, recovery and inbox examples under `.screenshots/`. The separate Gateway test masks the owner home and runs in a loopback-only namespace. It queues two messages without Hermes, restarts the platform, starts the real gateway against a fixture model, and checks separate ordered replies, notifications, and an attachment-only turn reaching the model. Do not replace this with a live-profile run.

## Run separately

After building, stage into a fresh release directory you own. `py` is a Python interpreter for staging the adapter only. The platform binary links system SQLite. Keep `LICENSE` alongside the binary. Separately stage `web/server.mjs` and `web/default-web-config.json` together alongside a copy of the complete `web/dist/` as its `dist/` directory (including `licenses.md`). Run Node 24.13.0 on that `server.mjs` with only web settings; no Node dependencies or build are needed after staging.

```sh
"$py" -I -S script/stage-wheel.py dist/*.whl "$release/plugins"
install -m755 dist/rothcold-agent "$release/rothcold-agent"
install -m644 dist/LICENSE "$release/"
"$release/rothcold-agent"
```

Give the platform process `ROTHCOLD_AGENT_OWNER_TOKEN` for browser login and `ROTHCOLD_AGENT_ADAPTER_TOKEN` for the adapter. Set distinct random secrets of 32 to 512 printable ASCII characters without spaces. Supply them through protected process environments, not command arguments, URLs or source. `ROTHCOLD_DATA_DIR` selects a private data directory; the default is `~/.local/share/rothcold-agent`. The database and files are local plaintext; back up the entire data directory, including `attachments/`. Files are private UUID-named blobs, including uploads removed before sending; there is no automatic cleanup. Do not publish the listener itself; proxy only the explicit HTTPS API ingress above.

For Hermes, install only the staged `rothcold_agent/` plugin, enable it, configure `ROTHCOLD_AGENT_ALLOWED_USERS=owner`, and supply the matching adapter token. The gateway does not need the browser owner token. Do not set `platform_toolsets.rothcold_agent: []` unless you intentionally want zero tools. Streaming stays off; mid-turn tool progress and interim assistant updates go to `/adapter/update` while the turn runs. Slash commands (such as `/sethome`, `/status`, `/model`, `/new`) are enabled; setting a home channel (via `/sethome` or `ROTHCOLD_AGENT_HOME_CHANNEL`) lets cron jobs and cross-platform sends deliver unsolicited messages to `/adapter/push` (including out-of-process via `standalone_sender_fn`). On connect and on an explicit refresh requested through `/adapter/claim`, the adapter reports its own Hermes profile name and optional `assets/avatar.{png,jpg,webp}` via `/adapter/profile` and `/adapter/avatar`. It downloads claimed files via `/adapter/attachments/{id}` and hands them to Hermes as message media. Start one adapter for this workspace. Startup order does not matter: the adapter retries the connection. Do not point multiple gateways at one workspace.

Type `/` in an empty new-thread or reply editor for the current Gateway’s **Commands** and **Skills**. Type more to filter; use the arrow keys and Enter or click/tap to fill the draft, not send it. Review the filled text before sending separately. Escape closes the menu; manual input still works if the directory is unavailable (offline, older versions, or discovery failed). `/approve` and `/deny` suggestions only appear for the one live prompt already bound to that reply and its allowed choices; the API and Gateway still validate the separate decision.

The staged adapter reads the pinned Gateway `/commands` registries with its availability, DM access and platform skill filters. This is the Gateway directory, not a listing of arbitrary quick commands, skill bundles, or CLI-only entries. It publishes only slugs to `/adapter/slash-catalog` about every 10 seconds (up to 128 commands and 256 skills, 64 ASCII characters each). Each API keeps its own snapshot in memory, clears it on connect, and expires it after 30 seconds. The browser reads only its current backend’s authenticated `/api/slash-catalog`; no skill body, file path, command arguments or credential fields are sent as catalog metadata. Discovery failure or mixed versions do not block normal delivery.

To check the feature without a real profile, use `script/test-gateway` for the catalog, platform-disabled skill, and explicit dispatch of a discovered command and synthetic skill. `SCREENSHOTS=1 script/test` covers menu selection, draft restoration, IME, and switching to a second backend; inspect `.screenshots/slash-new-thread-1100.png` and `.screenshots/slash-reply-375.png`. For a physical phone, repeat with a synthetic Gateway: tap a filtered skill, verify the composer still has an unsent draft, then type with a Chinese IME and verify committing a candidate does not send it.

## Upgrade from the embedded Rust web app

Back up the stopped API's data directory before the upgrade and cut over with no outstanding work. Keep the data-directory and token settings; the API upgrades older schemas through v5 in place. Start the web process separately and open its URL instead of the old port 8766 web URL. Sign in once to create a persistent device session; old in-memory bearer sessions are not carried over. For rollback to the embedded release, use the pre-upgrade backup rather than pointing the old binary at schema v5.

## Switch from the standalone Python platform

Build and verify first. With no work in flight, stop only `rothcold-agent.service` and take a consistent backup of the stopped workspace. Point the unit's `ExecStart` at the absolute path to the staged Rust binary instead of `python -m rothcold_agent`, and update the token variable names from `PERSONAL_CHAT_*` to `ROTHCOLD_AGENT_*`. Keep the same data directory; the Rust process does not use `PYTHONPATH`. Replace the Hermes `personal_chat` plugin with the staged `rothcold_agent` plugin, update Hermes config to enable `rothcold_agent`, and supply `ROTHCOLD_AGENT_ADAPTER_TOKEN` and `ROTHCOLD_AGENT_ALLOWED_USERS=owner`. Start the separately built web process, then reload the user systemd manager and start both units. The former API URL no longer serves the browser UI. The SQLite schema upgrades automatically through v3 (`turn_updates`), v4 (`device_sessions`), and v5 (`attachments`, `identities`, `backend_profiles`), so no export or import is needed. To roll back, stop both services and restore the previous plugin, config and launch command. Do not run the two platforms concurrently.

## Upgrade from the hosted plugin

Do not run both listeners on port 8766. Schedule a cutover when there are no outstanding tasks. Stop the old adapter. Back up its plugin and take a consistent SQLite backup of its stopped database (`$HERMES_HOME/personal_chat/history.sqlite3`). Put a separate backup copy at `$ROTHCOLD_DATA_DIR/history.sqlite3`, restrict the directory and file to the owner, then start the standalone platform and the new adapter. Never run both versions against the same data file. Check existing bookmarks, history, and one new thread. No service or production database is changed by the build or test scripts.

Opening a legacy store preserves chats, categories, turns, notifications, read flags and UUIDs. Historical final replies do not create new notifications. Pre-cutover reserved or accepted turns become `unknown`, not jobs to run again. The new file uses schema version 5. For rollback, stop both new processes and restore the original plugin and its pre-cutover database. Keep any new history separate; rollback does not merge it.

## Queue and privacy guarantees

- An execution approval is a live decision, not a queued message. Read the command, then use the prompt buttons or type `/approve`, `/approve session` or `/deny`. If several prompts are open, use the buttons on the intended prompt. Decisions name one request and cannot be replayed after expiry or reconnect. Upgrade the platform and adapter together with no work in flight. Previously queued unbound approval replies are retained as expired, not sent.
- A regular browser send writes a durable `queued` turn before returning HTTP 202. A new thread, its category placement, its first turn and attachment links commit together. An exact request UUID replay returns its receipt; changed input conflicts. Acknowledgement means saved locally, not executed by Hermes.
- The adapter claims one message at a time per thread, by insertion order. A final releases the next message automatically. Claims from other threads can proceed. Restarting the platform preserves the offline queue. After a gateway restart or an ambiguous handoff, do not automatically replay a claimed message. A verified late final may settle it. An `unknown` turn blocks later messages until its final arrives or the owner selects `Stop waiting and continue in this thread` and confirms. Confirmation releases only that turn. It does not cancel or retry work, approve commands, or create a notification. Queued messages keep their order and thread. A late final is shown on the original turn. There is no exactly-once inference guarantee across a crash.
- A matching Hermes final and its notification commit in one transaction. Identical redelivery is safe; conflicting text, a queued-but-unclaimed request, mid-turn updates and unanchored replies never become finals or trigger inbox notifications. Opening a thread or polling never clears its inbox by itself. A reply is marked read when its body stays visible in the focused thread for 600 ms with the navigation drawer closed. `Mark thread read` still clears the whole thread. In `Notifications`, select `Enable browser alerts` to request system notifications while the workspace is open and signed in. New unread messages outside your view can trigger an alert; login does not replay old alerts. Alerts contain no conversation text. Select `Turn off browser alerts` to stop them.
- The web proxy enforces same-origin browser requests and a restrictive CSP. The loopback API has no assets and no CORS. An owner session cannot claim adapter work. The adapter token cannot read browser history or create user turns. Keep credentials out of logs.
- Replies, interim updates and delivered home-channel pushes render standard Markdown safely as React nodes (no raw HTML injection; only `http`/`https` links). Unsolicited pushes (`/adapter/push`) commit an answered message and unread inbox notification atomically, never block queued user turns, and are refused while a thread has an unsettled `unknown` turn. No token streaming, outbound agent file attachments or external push. Limits: 128 categories, 128 threads, 128 turns per thread, 256 mid-turn updates per turn, 8,000 characters per user message and 65,536 per update, push or final.

Hermes contract: revision `caafe5389ae585ef77387a962aee05b1bcf17029`, notably `website/docs/developer-guide/adding-platform-adapters.md`, `gateway/platforms/base.py`, `gateway/platforms/event.py`, `gateway/session.py`, and `gateway/run_notifications.py`. Slash discovery also follows `hermes_cli/commands.py`, `hermes_cli/slash_exec.py`, `gateway/slash_access.py`, `gateway/run_inbound.py`, and `agent/skill_commands.py`. See [AGENTS.md](AGENTS.md) for project instructions.

## License

Rothcold Agent is licensed under the [Apache License, Version 2.0](LICENSE). You may use it commercially, including to operate a paid hosted service, subject to the license terms. Third-party components retain their own licenses. The build includes notices for bundled web dependencies in `web/dist/licenses.md`.
