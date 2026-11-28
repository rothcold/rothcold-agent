# iPhone M0: local build and owner-device check

> **历史文档（迁移前 HTTPS M0）**：以下命令只适用于仍提供原生 `/api/*` 的旧快照；请勿对当前正常服务器运行。当前版本请使用 [iPhone Noise v1 手册](noise-ios.md)，浏览器使用 [Web Noise v1 手册](noise-web.md)。旧 HTTPS 夹具及其证书检查不是当前 Noise 验收证据。

M0 connects, signs in, restores or revokes a device session, and shows the active category/thread directory. Thread titles are read-only; opening threads and messaging start at M1. No hosted CI, cloud devices, production servers, or Hermes setup are needed.

## Build and test on an Apple silicon Mac

The local baseline is Xcode **27.2 (27B52)**, Rust **1.100.0**, UniFFI **0.33.0** (locked in `mobile/core/Cargo.lock`), and deployment target **iOS 26.0**. Use Xcode’s toolchain, Rust with `rustfmt` and `clippy`, and Python 3.9 or later (stdlib only). Use the matching Rosetta-free toolchains. From the repository root:

```sh
xcodebuild -version
export PATH="$(dirname "$(rustup which cargo)"):$PATH"
rustc --version
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
script/test-ios
script/ios-build
```

If the installed Rust does not match the baseline, select it explicitly before adding targets, e.g. `rustup toolchain install 1.100.0 --component rustfmt --component clippy` and `export RUSTUP_TOOLCHAIN=1.100.0`. `script/ios-core` regenerates the ignored Swift bindings and SDK-specific static archives. `script/ios-build` builds unsigned arm64 apps into `mobile/core/target/xcode/Build/Products/{Debug-iphoneos,Debug-iphonesimulator}/Rothcold.app`. It does not require an installed simulator runtime. These are build artifacts, not distribution builds.

`script/test-ios` requires free loopback port 8766. It runs Rust core tests and a macOS Swift harness that calls the generated UniFFI binding and sends real HTTPS requests to disposable loopback ingress using a fresh Rust API workspace and one-time credentials. The test process temporarily anchors its own certificate for positive checks without installing a certificate or changing system trust. The shipping transport is separately checked against the untrusted root. Host tests cover hostname mismatch, redirects, invalid status/login/directory, logout failure, and `401`. They check the restored bearer against the real `/api/me` (not called by the app) and use two HTTPS origins with distinct directory results to verify that a held response blocks switching servers. They use an in-memory session store; iOS Keychain and SwiftUI rendering still need the checks below.

```sh
for manifest in mobile/core/Cargo.toml server/Cargo.toml; do
    cargo fmt --manifest-path "$manifest" -- --check || break
    cargo test --locked --manifest-path "$manifest" --all-features || break
    cargo clippy --locked --manifest-path "$manifest" --all-targets --all-features -- -D warnings || break
done
```

## Start a disposable workspace for the owner’s iPhone

Do this on a test Mac with **nothing listening on 8766** (`lsof -nP -iTCP:8766 -sTCP:LISTEN` should print nothing). Choose a private LAN/VPN address and a private DNS name the phone can resolve. Use a firewall to restrict the TLS port to intended devices. Never start against an existing data directory.

In one dedicated shell, from the repo root (the shell variables are used in later commands):

```sh
umask 077
scratch="$(mktemp -d -t rothcold-iphone-m0)"
export ROTHCOLD_DATA_DIR="$scratch/workspace"
export ROTHCOLD_AGENT_OWNER_TOKEN="$(/usr/bin/openssl rand -hex 32)"
export ROTHCOLD_AGENT_ADAPTER_TOKEN="$(/usr/bin/openssl rand -hex 32)"
cargo build --locked --manifest-path server/Cargo.toml --target-dir server/target
./server/target/debug/rothcold-agent >"$scratch/api.log" 2>&1 &
api_pid=$!
```

Confirm `kill -0 "$api_pid"` succeeds and the new log says `Rothcold Agent listening on http://127.0.0.1:8766`. Then seed the fixture in the same shell:

```sh
python3 - <<'PY'
import os, runpy
runpy.run_path('tests/ios_ingress.py')['seed_workspace'](os.environ['ROTHCOLD_AGENT_OWNER_TOKEN'])
PY
```

Set up a temporary TLS reverse proxy on the same Mac. Example for Caddy already installed locally: save the following as `$scratch/Caddyfile`, replacing `api-m0.home.example` and `10.91.0.2` with the test DNS name and the Mac’s private IP. Port `8443` must be free.

```caddyfile
{
    admin off
    auto_https disable_redirects
    skip_install_trust
}

https://api-m0.home.example:8443 {
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

Run Caddy with disposable state and no owner or adapter token in its environment:

```sh
env -u ROTHCOLD_AGENT_OWNER_TOKEN -u ROTHCOLD_AGENT_ADAPTER_TOKEN \
    XDG_DATA_HOME="$scratch/caddy-data" XDG_CONFIG_HOME="$scratch/caddy-config" \
    caddy run --config "$scratch/Caddyfile" --adapter caddyfile >"$scratch/caddy.log" 2>&1 &
proxy_pid=$!
```

Check the log for successful startup and locate the public root at `$scratch/caddy-data/caddy/pki/authorities/local/root.crt`. To verify ingress without changing Mac trust, use `curl --cacert "$scratch/caddy-data/caddy/pki/authorities/local/root.crt" https://api-m0.home.example:8443/api/status`. Expect `service=rothcold-agent` and `apiVersion=1`; `/adapter/connect` must be `404`. Use the website’s configured DNS name, not an IP in place of a DNS certificate name. Do not turn on request logging or expose port 8766.

## Sign locally and run on the owner’s iPhone

1. Run `script/ios-core` once if you have not already built. Open `mobile/ios/Rothcold.xcodeproj` in Xcode. In **Settings → Accounts**, add the owner’s Apple account if needed. Under target **Rothcold → Signing & Capabilities**, use **Automatically manage signing**, select the owner’s team (Personal Team if supported), and use a unique bundle identifier for that team if `org.rothcold.agent.ios` is unavailable. Don’t commit team IDs or provisioning settings. Keep the same team and bundle ID for subsequent restore checks.
2. Connect an iPhone running iOS 26.0 or later by USB, unlock it, and approve the computer pairing. If prompted, enable **Settings → Privacy & Security → Developer Mode** on the phone and confirm after it restarts. Select the iPhone as the **Rothcold** scheme’s destination in Xcode and choose **Product → Run**; do not pass `CODE_SIGNING_ALLOWED=NO` for installation. Approve the developer app on the phone if iOS requests it. Allow Local Network access if prompted. For a simulator already available, select an installed arm64 iPhone runtime and run the same scheme; a generic build does not verify runtime loading.
3. Start with the disposable CA **not** installed on the phone. Connect to `http://api-m0.home.example:8443` and the HTTPS address in turn; both must stay on the connection screen (invalid scheme and untrusted certificate). No token should be requested. For the positive test, the owner can transfer **only** the public `root.crt` to this test iPhone, verify its fingerprint with `/usr/bin/openssl x509 -in root.crt -noout -fingerprint -sha256`, install the profile via Settings and explicitly enable full trust under **General → About → Certificate Trust Settings**. Never install test trust on production devices; never turn off certificate verification or transfer the CA private key. With the CA trusted, try `https://<private-IP>:8443` to a leaf issued only to the DNS name (the proxy may reject the incorrect TLS server name outright). Confirm the mismatched name does not reach sign-in.
4. Connect to the configured DNS origin over the private network. Verify the displayed address, use an invalid token once, then use the disposable `ROTHCOLD_AGENT_OWNER_TOKEN` from the test shell. Expect **General → Visible thread** and **Empty** only. Quit and reopen the app; it should restore the same directory without the owner token. For origin isolation, optionally configure a second HTTPS hostname in the same test ingress and select **Change server**. The second origin must ask for its own login; switching back must restore the first session without reusing the second’s credentials.
5. Use **Sign out this device** and relaunch; the app should remain signed out. Sign in again, then use a second disposable device session to revoke the iPhone by ID (`GET /api/sessions` and `POST /api/sessions/{id}/revoke`, see [native API instructions](../README.md#native-sessions-and-lanvpn-https)). Select **Refresh directory** on the iPhone; a `401` must clear the saved device session and return to sign-in, including on relaunch. Verify Light/Dark, large text, VoiceOver focus, and the connection and error screens on the device.
6. Delete the test app if no longer needed and remove the disposable CA profile and its trust from the test phone. Stop the test Caddy and Rust processes with `kill "$proxy_pid" "$api_pid"`; delete only the temporary directory printed by `printf '%s\n' "$scratch"`. Never reuse the test credentials.

The generic builds and macOS integration tests do not verify signing, provisioning, physical installation, iOS URLSession trust, Keychain persistence, or simulator/device launch. Record those observations separately after the owner runs this checklist.
