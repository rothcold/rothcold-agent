# Web Noise v1

The standalone Web process serves trusted static assets and an exact same-origin WSS upgrade. It does not access SQLite, perform owner authentication, proxy HTTP business calls or serve attachment URLs. It requires the [normal Noise v1 server](noise-client-contract.md), not a dev listener. This is an operator wiring guide, not authorization to deploy.

## Build and stage

Use Node 24.13.0, pnpm 10.33.0 through `script/pnpm`, and Rust with the `wasm32-unknown-unknown` target installed. From the repository root:

```sh
script/pnpm install --frozen-lockfile --ignore-scripts
script/pnpm build
```

`web/noise-codec` is a thin browser ABI over the same locked Rust/Snow v1 codec as the server. The pinned Binaryen `wasm2js` build translates it to ordinary static JavaScript: there is no browser WASM compilation, code generation, remote loader, or CSP exception. Web Crypto supplies secure Noise randomness (no fallback) and signs fresh P-256 device proofs. Stage `web/server.mjs`, `web/default-web-config.json` and `web/dist/` including the combined notices; no Cargo/pnpm/Node modules are used at runtime.

The Rust browser listener enables `TCP_NODELAY` on its accepted loopback sockets. Each Noise result can contain several small records; do not let TCP hold later records while the browser waits for the reply. This changes neither the wire format nor the responder pin. [Newest-first history and caching](thread-history-plan.md) are a separate proposal, not part of this socket change.

## Configure a trusted origin

1. Use an operator-controlled, cookie-free private HTTPS site with a browser-trusted matching certificate and private ingress controls. Route the static site, and **only** exact configured WS upgrade paths, to the loopback Web process. Preserve the public Host and the browser's unmodified Origin. Do not route `/adapter/*` or any other internal listener. Do not issue cookies; a pre-cutover session is neither accepted nor transferred. On a dedicated previously used origin remove the old Web cookies before connecting or use a new dedicated origin.
2. Configure the normal Rust process with `ROTHCOLD_NOISE_WS_BIND=127.0.0.1:8767`, `ROTHCOLD_NOISE_WS_HOST=127.0.0.1:8767` and `ROTHCOLD_NOISE_WS_ORIGIN=https://workspace.private.example`. The exact Origin must match the Web site's configuration. Keep `/adapter/*` independently authenticated and loopback-only on `127.0.0.1:8766`.
3. Start the Web process with `ROTHCOLD_WEB_ORIGIN=https://workspace.private.example`, optional `ROTHCOLD_WEB_PORT` (default 8765), and optional `ROTHCOLD_WEB_CONFIG=/path/to/web.json`. `script/pnpm start` binds only `127.0.0.1`. `ROTHCOLD_WEB_ORIGIN` is the **public HTTPS** origin, even though the ingress forwards to Node over private loopback HTTP. The Web edge does not terminate TLS. Set ingress time, header and connection bounds and permit only the intended private clients.

Operator configuration contains public labels and fixed loopback destinations, not pins or secrets:

```json
{
  "defaultBackend": "local",
  "backends": {
    "local": { "label": "Local workspace", "port": 8767 },
    "secondary": { "label": "Secondary workspace", "port": 8867, "host": "127.0.0.1:8867" }
  }
}
```

Each public `/noise/<configured-id>` is upgrade-only; it maps to the operator's fixed loopback port and configured Host, with literal upstream `GET /noise`. Changing a mapping invalidates that selection's browser key scope even if the display label is unchanged. The edge does not accept a destination URL, a query, an authentication header, cookie, subprotocol or app bytes in the upgrade, and does not negotiate extensions. The Rust connector validates canonical framing, Origin and Host and limits lifetime and packet sizes. Public GETs outside the explicit static asset inventory return 404; `/backends.json` is public deployment configuration only (no server status, identity discovery, pins or authorization).

## Connect, lose a link, and restore

Run `rothcold-agent noise-pin` only in the intended server's trusted local environment and convey that exact public pin independently of the connector. At **Connect to a server**, choose the administrator-configured backend and enter the independently verified pin. Noise verification precedes service status, any device proof, and owner token input. A changed pin is not adopted automatically. The owner token is discarded after enrollment; it is never a cookie, persisted preference, URL, or bearer. The origin's IndexedDB stores only a structured-cloned non-extractable device signing key, public key and device ID under the backend mapping and verified pin. Incognito or clearing storage can lose the key without revoking the device; revoke old entries from another enrolled device.

After a live connection is lost, polling stops and that connection's pending requests, approval controls, active transfers and preview URLs expire. **Reconnect** explicitly re-verifies the same pin, generates a fresh proof, and reads workspace state again. Unsent ordinary drafts stay in memory for that selection. A submitted change without a receipt may have committed: check history after reconnecting. A deliberate unchanged enqueue retry keeps its prior turn UUID and input; approvals cannot be replayed. Changing backend or pin drops the previous selection's draft, route and media state. A revoked device returns to sign-in rather than retrying a proof forever. Logout revokes the current device server-side. An already-open foreground conversation refreshes even after its history settles, so a queued turn from another device is visible before Hermes sends a final or Inbox event.

All workspace calls and all file bytes (including avatars) use typed Noise. File transfers are serialized on the authorized link; an upload is invisible to messages until its complete receipt. Cancelling between transfer steps sends the typed cancel or closes a lost link. The UI exposes a download only after verifying its exact size, ordered chunks and terminal receipt. Active previews are leased local Blob URLs, never HTTP/Range. `kind=file` is downloaded as opaque data; HTML and SVG do not render inline.

## Disposable browser checks

```sh
# Point to local Playwright and, if needed, a matching local Chromium binary.
PLAYWRIGHT_DIR=/path/to/playwright CHROMIUM=/path/to/chromium \
  SCREENSHOTS=1 script/test-web
```

The fixture builds and runs the normal Rust binary and an independent native observation driver. Use a disposable machine/namespace with adapter port 8766 free. Other ports are local and chosen by the fixture. It generates a temporary loopback certificate, gives Chromium trust for that ephemeral SPKI only, and starts an isolated HTTPS ingress over the loopback Node edge. It does not read an operator profile or touch system trust. Screenshots are under `.screenshots/web-noise/`. These Web tests do not run the real Hermes Gateway or substitute for joint device acceptance.

`script/test-web` also runs the ported archive/Inbox, focus and mobile navigation, IME and touch command menu, profile sync, and real media regressions. The switch test always starts distinct disposable A and B workspace directories and pins, with different owner tokens, enrolled keys and contents. On macOS it runs the two normal binaries serially under the same Web origin. On Linux it additionally requires `bwrap`, starts B in an independent network namespace and exposes only B's Noise WebSocket port to the loopback Web edge via a disposable Unix-socket relay. Both adapter listeners retain literal loopback port 8766 in their respective namespaces. The Linux case also commits an A change while withholding its reply, then switches to B and verifies the delayed receipt and data do not cross workspace boundaries. No external traffic or real Gateway is used by these Web regressions.

Run `script/test-web` both with and without `SCREENSHOTS=1`. The initial system theme and composer readiness do not depend on image capture. For the lost-receipt test, let earlier reads finish on the shared link. The native observer confirms the turn is stored before the fixture drops its reply. Reconnecting must show exactly one copy of the turn.

The Inbox privacy assertion records the browser notification API at the OS boundary instead of relying on a headless macOS notification daemon. It checks that the UI does not replay the initial Inbox and later sends only a generic title/body for a real queued notification.
