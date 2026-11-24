# Rothcold Agent

Rothcold Agent is a private, single-owner messaging platform. Open `http://127.0.0.1:8766/`, sign in, and select a category. Use the sidebar to switch threads, or open `Workspace` on a phone. Select `New thread` under a category and send the first message to start it. The conversation scrolls separately from the reply box. Unsent drafts stay in the tab when you switch threads. To change its title, open the thread, select `Rename thread`, enter up to 80 characters, and select `Save title`. The bookmark stays the same, even when Hermes is offline. You can read history and send more messages while Hermes is offline. Categories, thread bookmarks, history, queued messages and notifications belong to Rothcold, not the gateway.

## Quickstart

Start a local workspace and save your first message. Hermes and model credentials are not required for this part. Use Linux, a POSIX shell and a free `127.0.0.1:8766`; if you already run Rothcold there, open the existing workspace instead of starting another server.

1. From the project root, build the web assets and then the Rust server. Install Node 24.13.0, a Rust toolchain with edition 2024 support, a C toolchain, pkg-config, SQLite development files, curl, tar and OpenSSL first. The wrapper downloads the pinned pnpm. If you already have a compatible `dist/rothcold-agent` binary, skip the build and use that path in step 2; the binary needs the system SQLite library.

   ```sh
   script/pnpm install --frozen-lockfile --ignore-scripts
   script/pnpm build
   cargo build --locked --release --manifest-path server/Cargo.toml --target-dir server/target
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

3. When the terminal says `Rothcold Agent listening on http://127.0.0.1:8766`, open [the workspace](http://127.0.0.1:8766/) on the same machine. Open `~/.config/rothcold-agent/quickstart/owner.env` locally and paste its value into `Owner token`. In `General`, send a first message. It creates a thread and shows `Queued. Waiting to send to Hermes.` This is the expected result without a gateway. Press `Ctrl+C` in the server terminal to stop; your message stays on disk.

4. To get an agent reply, use a Hermes Gateway that already has a working model. Follow [Build and verify](#build-and-verify) to build the adapter wheel, then [Run separately](#run-separately) to stage and enable `rothcold_agent`. Give the gateway `ROTHCOLD_AGENT_ALLOWED_USERS=owner` and the value from `adapter.env` as `ROTHCOLD_AGENT_ADAPTER_TOKEN`, never the owner token. Start the platform and gateway. The queued message is delivered without resending it.

## Runtime boundary

`browser ↔ Rothcold Agent ↔ rothcold_agent adapter ↔ Hermes Gateway ↔ agent`

- `server/` builds the Rust executable. It owns SQLite and serves the React + TypeScript assets from `web/`, embedded at build time. The platform needs neither Python, Hermes nor Node at runtime.
- `hermes-adapter/rothcold_agent/` is the Hermes platform adapter. It uses authenticated loopback HTTP to claim messages and deliver replies. It does not open the history database or serve a web page. Keep the platform ID `rothcold_agent`, the owner ID `owner`, and the thread UUID as the DM `chat_id`. Category IDs are never sent to Hermes.
- `dist/` contains the platform binary, web dependency notices and a separate Python wheel containing only the adapter. Do not stage the workspace into the Hermes plugin directory or sync packages into the host venv.

## Build and verify

Build the platform with Rust (edition 2024), Cargo, pkg-config and system SQLite development files. `Cargo.lock` pins crate versions; for disconnected builds, fetch the lockfile dependencies before entering the test namespace (`cargo fetch --locked --manifest-path server/Cargo.toml`). Use Node 24.13.0, pnpm 10.33.0, uv 0.13.9 and the pinned Hermes checkout with a CPython 3.14 venv at `venv/`. `script/pnpm` and `script/uv` keep build tools local. Set `HERMES_SOURCE` if the source checkout is not at `$HOME/.hermes/hermes-agent`.

```sh
script/pnpm install --frozen-lockfile --ignore-scripts
script/uv lock --check --no-build
script/build
SCREENSHOTS=1 script/test
script/test-gateway
```

If port 8766 is occupied, do not stop the live platform for a test. Run `SCREENSHOTS=1 bwrap --unshare-net --bind / / --dev /dev --proc /proc script/test` instead. The tests verify the wheel allowlist and RECORD, stage the verified adapter and start the Rust binary, and use synthetic databases and disposable credentials. The browser test uses local Chromium and Playwright. The separate Gateway test masks the owner home and runs in a loopback-only namespace. It queues two messages without Hermes, restarts the platform, starts the real gateway against a fixture model, and checks separate ordered replies and notifications. Do not replace this with a live-profile run.

## Run separately

After building, stage into a fresh release directory you own. `py` is a Python interpreter for staging the adapter only. The platform binary links system SQLite. Keep `LICENSE` and `web-licenses.md` alongside the binary.

```sh
"$py" -I -S script/stage-wheel.py dist/*.whl "$release/plugins"
install -m755 dist/rothcold-agent "$release/rothcold-agent"
install -m644 dist/LICENSE dist/web-licenses.md "$release/"
"$release/rothcold-agent"
```

Give the platform process `ROTHCOLD_AGENT_OWNER_TOKEN` for browser login and `ROTHCOLD_AGENT_ADAPTER_TOKEN` for the adapter. Set distinct random secrets of 32 to 512 printable ASCII characters without spaces. Supply them through protected process environments, not command arguments, URLs or source. `ROTHCOLD_DATA_DIR` selects a private data directory; the default is `~/.local/share/rothcold-agent`. The database is local plaintext. Never proxy or publish this listener.

For Hermes, install only the staged `rothcold_agent/` plugin, enable it, configure `ROTHCOLD_AGENT_ALLOWED_USERS=owner`, and supply the matching adapter token. The gateway does not need the browser owner token. Do not set `platform_toolsets.rothcold_agent: []` unless you intentionally want zero tools. Streaming stays off; mid-turn tool progress and interim assistant updates go to `/adapter/update` while the turn runs. Slash commands (such as `/sethome`, `/status`, `/model`, `/new`) are enabled; setting a home channel (via `/sethome` or `ROTHCOLD_AGENT_HOME_CHANNEL`) lets cron jobs and cross-platform sends deliver unsolicited messages to `/adapter/push` (including out-of-process via `standalone_sender_fn`). Start one adapter for this workspace. Startup order does not matter: the adapter retries the connection. Do not point multiple gateways at one workspace.

## Switch from the standalone Python platform

Build and verify first. With no work in flight, stop only `rothcold-agent.service` and take a consistent backup of the stopped workspace. Point the unit's `ExecStart` at the absolute path to the staged Rust binary instead of `python -m rothcold_agent`, and update the token variable names from `PERSONAL_CHAT_*` to `ROTHCOLD_AGENT_*`. Keep the same data directory; the Rust process does not use `PYTHONPATH`. Replace the Hermes `personal_chat` plugin with the staged `rothcold_agent` plugin, update Hermes config to enable `rothcold_agent`, and supply `ROTHCOLD_AGENT_ADAPTER_TOKEN` and `ROTHCOLD_AGENT_ALLOWED_USERS=owner`. Reload the user systemd manager and start both units. The SQLite schema upgrades automatically to v3 (adding `turn_updates`), so no export or import is needed. To roll back, stop both services and restore the previous plugin, config and launch command. Do not run the two platforms concurrently.

## Upgrade from the hosted plugin

Do not run both listeners on port 8766. Schedule a cutover when there are no outstanding tasks. Stop the old adapter. Back up its plugin and take a consistent SQLite backup of its stopped database (`$HERMES_HOME/personal_chat/history.sqlite3`). Put a separate backup copy at `$ROTHCOLD_DATA_DIR/history.sqlite3`, restrict the directory and file to the owner, then start the standalone platform and the new adapter. Never run both versions against the same data file. Check existing bookmarks, history, and one new thread. No service or production database is changed by the build or test scripts.

Opening a legacy store preserves chats, categories, turns, notifications, read flags and UUIDs. Historical final replies do not create new notifications. Pre-cutover reserved or accepted turns become `unknown`, not jobs to run again. The new file uses schema version 3. For rollback, stop both new processes and restore the original plugin and its pre-cutover database. Keep any new history separate; rollback does not merge it.

## Queue and privacy guarantees

- An execution approval is a live decision, not a queued message. Read the command, then use the prompt buttons or type `/approve`, `/approve session` or `/deny`. If several prompts are open, use the buttons on the intended prompt. Decisions name one request and cannot be replayed after expiry or reconnect. Upgrade the platform and adapter together with no work in flight. Previously queued unbound approval replies are retained as expired, not sent.
- A regular browser send writes a durable `queued` turn before returning HTTP 202. A new thread, its category placement and its first turn commit together. An exact request UUID replay returns its receipt; changed input conflicts. Acknowledgement means saved locally, not executed by Hermes.
- The adapter claims one message at a time per thread, by insertion order. Only a recorded final releases the next message. Claims from other threads can proceed. Restarting the platform preserves the offline queue. After a gateway restart or an ambiguous handoff, do not automatically replay a claimed message. A verified late final may settle it. While a turn is uncertain, its thread keeps later messages queued; start another thread if needed. There is no exactly-once inference guarantee across a crash.
- A matching Hermes final and its notification commit in one transaction. Identical redelivery is safe; conflicting text, a queued-but-unclaimed request, mid-turn updates and unanchored replies never become finals or trigger inbox notifications. Polling, sign-in and bookmarks never mark a notification read. Explicit thread selection and Mark thread read do.
- HTTP is loopback-only with literal Host and Origin checks, no CORS, and a restrictive CSP. Browser bearer sessions last eight hours and stay in memory. An owner session cannot claim adapter work. The adapter token cannot read browser history or create user turns. Keep both secrets out of logs.
- Replies, interim updates and delivered home-channel pushes render standard Markdown safely as React nodes (no raw HTML injection; only `http`/`https` links). Unsolicited pushes (`/adapter/push`) commit an answered message and unread inbox notification atomically, never block queued user turns, and are refused while a thread has an unsettled `unknown` turn. No token streaming, media attachments or external push. Limits: 128 categories, 128 threads, 128 turns per thread, 256 mid-turn updates per turn, 8,000 characters per user message and 65,536 per update, push or final.

Hermes contract: revision `caafe5389ae585ef77387a962aee05b1bcf17029`, notably `website/docs/developer-guide/adding-platform-adapters.md`, `gateway/platforms/base.py`, `gateway/platforms/event.py`, `gateway/session.py`, and `gateway/run_notifications.py`. See [AGENTS.md](AGENTS.md) for project instructions.

## License

Rothcold Agent is licensed under the [Apache License, Version 2.0](LICENSE). You may use it commercially, including to operate a paid hosted service, subject to the license terms. Third-party components retain their own licenses. The build includes notices for bundled web dependencies in `dist/web-licenses.md`.
