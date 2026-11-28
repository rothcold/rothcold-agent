"""Run host and optional iPhone UI tests against normal disposable Noise servers."""

import contextlib
import hashlib
import http.client
import json
import os
import re
import secrets
import select
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from uuid import uuid4

from ios_reconnect import reconnect_fixture
from noise_fixture import NoiseFixture

UI_SUITE = "RothcoldUITests/IOSWorkspaceUITests"
UI_TRANSFER = f"{UI_SUITE}/testVerifiedWorkspaceRestoreAndFilePreview"
UI_REVOCATION = f"{UI_SUITE}/testVerifiedWorkspaceRevocationAndReconnect"


@contextlib.contextmanager
def server(binary):
    with tempfile.TemporaryDirectory(prefix="rothcold-ios-noise-") as directory:
        workspace = Path(directory) / "workspace"
        owner, adapter = secrets.token_hex(32), secrets.token_hex(32)
        server_env = {
            "ROTHCOLD_DATA_DIR": str(workspace),
            "ROTHCOLD_NOISE_NATIVE_BIND": "127.0.0.1:0",
            "ROTHCOLD_AGENT_OWNER_TOKEN": owner,
            "ROTHCOLD_AGENT_ADAPTER_TOKEN": adapter,
        }
        pin = subprocess.check_output([binary, "noise-pin"], env=server_env, text=True, timeout=5).strip()
        with subprocess.Popen([binary], env=server_env, stdout=subprocess.PIPE) as process:
            try:
                assert process.stdout is not None
                lines = bytearray()
                while lines.count(b"\n") < 2:
                    assert select.select([process.stdout], [], [], 10)[0], "normal server did not start"
                    data = os.read(process.stdout.fileno(), 16384)
                    assert data, "normal server did not start; check that adapter port 8766 is free"
                    lines.extend(data)
                adapter_line, native_line, *_ = lines.decode().splitlines()
                assert adapter_line == "Rothcold Agent adapter listening on http://127.0.0.1:8766"
                address = native_line.removeprefix("Rothcold Agent native Noise listening on ")
                assert address.startswith("127.0.0.1:")
                yield {"IOS_NOISE_TEST_ADDRESS": address, "IOS_NOISE_TEST_PIN": pin, "IOS_NOISE_TEST_OWNER": owner}, adapter, workspace
            finally:
                if process.poll() is None:
                    process.terminate()
                try:
                    process.wait(5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def adapter_call(token, operation, **fields):
    connection = http.client.HTTPConnection("127.0.0.1", 8766, timeout=5)
    try:
        connection.request("POST", f"/adapter/{operation}", body=json.dumps(fields), headers={
            "Origin": "http://127.0.0.1:8766", "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        })
        response = connection.getresponse()
        assert response.status == 200, (operation, response.status)
        return json.load(response)
    finally:
        connection.close()


def fixture_client(driver, env, label):
    client = NoiseFixture(driver, env["IOS_NOISE_TEST_ADDRESS"], env["IOS_NOISE_TEST_PIN"])
    try:
        receipt = client.call("login_native", owner_token=env["IOS_NOISE_TEST_OWNER"], name=label)
        assert receipt["type"] == "native_login"
        return client
    except BaseException:
        client.close()
        raise


def check_business(harness, driver, env, adapter, artifacts):
    client = fixture_client(driver, env, "Business fixture seeder")
    try:
        turn, reply = str(uuid4()), str(uuid4())
        _, thread = client.start({"id": turn, "text": "First turn", "attachments": []})
        chat = thread["id"]
        assert adapter_call(adapter, "claim")["id"] == turn
        adapter_call(adapter, "admission", id=turn, accepted=True)
        cards = [{"chat": chat, "id": "approval-a", "choices": ["once"]},
                 {"chat": chat, "id": "approval-b", "choices": ["deny"]}]
        for card in cards:
            adapter_call(adapter, "update", chat=chat, turn=turn, id=card["id"], kind="progress", text=card["id"])
        adapter_call(adapter, "claim", approvals=cards)
        runner_env = {**env, "IOS_NOISE_TEST_ARTIFACTS": str(artifacts)}
        subprocess.run([harness, "approve", chat, turn], env=runner_env, check=True, timeout=5)
        assert adapter_call(adapter, "claim", approvals=cards) == {"approval": "approval-b", "chat": chat, "choice": "deny"}
        adapter_call(adapter, "connect")
        assert client.send(chat, {"id": reply, "text": "Wait behind the unknown", "attachments": []})
        assert adapter_call(adapter, "claim") is None
        adapter_call(adapter, "slash-catalog", catalog={"commands": ["status"], "skills": ["synthetic-skill"]})
        subprocess.run([harness, "recover", chat, turn], env=runner_env, check=True, timeout=5)
        assert adapter_call(adapter, "claim")["id"] == reply
        adapter_call(adapter, "final", chat=chat, id=turn, text="Late final remains on the original turn")
        assert client.history(chat)[0]["answer"] == "Late final remains on the original turn"
        assert client.pages("inbox")[0]["unread"] is True
    finally:
        client.call("logout")
        client.close()
    print("Typed slash catalog, two live choices, no decision replay, FIFO unknown/release and late final passed.")


def seed_simulator(driver, env, adapter, artifacts, manifest=None):
    client = fixture_client(driver, env, "Simulator seeder")
    try:
        avatar_data = (artifacts / "fixture-avatar.png").read_bytes()
        avatar = client.call("fixture_upload", purpose="avatar", filename="fixture-avatar.png", bytes=list(avatar_data))["attachment"]
        client.call("update_profile", owner={"name": "Fixture Owner", "avatar": {"type": "set", "id": avatar["id"]}})
        svg = client.upload("download-only.svg", (artifacts / "download-only.svg").read_bytes())
        payload = (artifacts / "ios-cross-client.bin").read_bytes()
        binary = client.upload("ios-cross-client.bin", payload)
        turn = str(uuid4())
        _, thread = client.start({"id": turn, "text": "An attachment from another device", "attachments": [svg["id"], binary["id"]]})
        client.call("rename_thread", id=thread["id"], title="Received files")
        claim = adapter_call(adapter, "claim")
        assert claim["id"] == turn
        adapter_call(adapter, "admission", id=turn, accepted=True)
        adapter_call(adapter, "update", chat=thread["id"], turn=turn, id="synthetic-progress", kind="progress", text="Fixture progress")
        adapter_call(adapter, "final", chat=thread["id"], id=turn, text="Simulator final reply")
        ((manifest or artifacts) / "simulator-cross-client-file.json").write_text(json.dumps({
            "thread": thread["id"], "attachment": binary["id"], "filename": binary["filename"],
            "size": len(payload), "sha256": hashlib.sha256(payload).hexdigest(),
        }))
        return thread["id"]
    finally:
        client.call("logout")
        client.close()


def simulator_test(simulator, env, output, only_testing=None):
    simulator_data = json.loads(subprocess.check_output(["xcrun", "simctl", "list", "devices", "-j"]))
    matches = [device for runtime, devices in simulator_data["devices"].items() for device in devices
               if runtime == "com.apple.CoreSimulator.SimRuntime.iOS-27-2" and device["udid"] == simulator]
    assert len(matches) == 1 and matches[0]["name"] == "Rothcold Noise Disposable 27.2", "supply the dedicated simulator described in docs/noise-ios.md"
    assert matches[0]["state"] == "Booted", "boot the dedicated simulator first"
    subprocess.run(["xcrun", "simctl", "uninstall", simulator, "org.rothcold.agent.ios"],
                   capture_output=True, check=False)
    derived = output / "xcode"
    base = ["xcodebuild", "-project", "mobile/ios/Rothcold.xcodeproj", "-scheme", "Rothcold", "-configuration", "Debug",
            "-destination", f"platform=iOS Simulator,id={simulator}", "-derivedDataPath", str(derived),
            "-parallel-testing-enabled", "NO", "CODE_SIGNING_ALLOWED=YES", "CODE_SIGN_IDENTITY=-",
            "CODE_SIGN_STYLE=Manual", "DEVELOPMENT_TEAM=", "PROVISIONING_PROFILE_SPECIFIER="]
    selection = [f"-only-testing:{only_testing}"] if only_testing else []
    runner_env = {f"TEST_RUNNER_{name}": value for name, value in env.items()}
    with tempfile.TemporaryDirectory(prefix="ui-", dir=output) as scratch:
        scratch = Path(scratch)
        xcresult, raw_log = scratch / "ios-ui.xcresult", scratch / "log"
        with raw_log.open("w") as log:
            result = subprocess.run([*base, *selection, "-resultBundlePath", str(xcresult), "test"],
                                    env={**os.environ, **runner_env}, stdout=log, stderr=subprocess.STDOUT, timeout=360)
        log_text = raw_log.read_text(errors="replace")
        owner = env["IOS_NOISE_TEST_OWNER"]
        for size in range(len(owner), 7, -1):
            log_text = log_text.replace(owner[:size], "[synthetic credential redacted]")
        (output / "ios-ui.log").write_text(log_text)
        if xcresult.exists():
            export_screenshots(xcresult, scratch, output)
    assert result.returncode == 0, f"iPhone XCTest failed; see {output / 'ios-ui.log'}"


def export_screenshots(result, scratch, output):
    temporary = scratch / "exported"
    subprocess.run(["xcrun", "xcresulttool", "export", "attachments", "--path", str(result),
                    "--output-path", str(temporary)], stdout=subprocess.DEVNULL, check=True)
    screenshots = output / "screenshots"
    screenshots.mkdir()
    for test in json.loads((temporary / "manifest.json").read_text()):
        for item in test["attachments"]:
            name = item.get("suggestedHumanReadableName", "").split("_", 1)[0]
            if re.fullmatch(r"[0-9]{2}-[a-z-]+", name) and item["exportedFileName"].endswith(".png"):
                shutil.copyfile(temporary / item["exportedFileName"], screenshots / f"{name}.png")


def main(binary, harness, driver, artifacts, simulator=None):
    artifacts = Path(artifacts).resolve()
    artifacts.mkdir(parents=True, mode=0o700)
    with server(binary) as (env, _, workspace):
        subprocess.run([harness], env={**env, "IOS_NOISE_TEST_ARTIFACTS": str(artifacts)}, check=True, timeout=90)
        assert not list((workspace / "attachments").glob(".noise-upload-*")), "canceled upload still staged"
    with server(binary) as (env, adapter, _):
        check_business(harness, driver, env, adapter, artifacts)
    if simulator:
        with server(binary) as (env, adapter, _):
            thread = seed_simulator(driver, env, adapter, artifacts)
            simulator_test(simulator, env, artifacts, only_testing=UI_TRANSFER)
            client = fixture_client(driver, env, "Simulator assertions")
            try:
                turns = client.history(thread)
                assert turns[0]["answer"] == "Simulator final reply"
                assert turns[1]["text"] == "Queued from iPhone simulator" and turns[1]["state"] == "queued"
                assert any(turn["text"] == "New iPhone simulator thread" for chat in client.threads()
                           if chat["id"] != thread for turn in client.history(chat["id"]))
                saved = json.loads((artifacts / "simulator-cross-client-file.json").read_text())
                uploaded, = turns[1]["attachments"]
                assert uploaded["id"] != saved["attachment"]
                observed = subprocess.check_output([harness, "download", uploaded["id"]],
                                                   env={**env, "IOS_NOISE_TEST_ARTIFACTS": str(artifacts)},
                                                   timeout=10, text=True).strip()
                assert observed == f"{saved['size']} {saved['sha256']}"
                (artifacts / "simulator-verified-transfer.json").write_text(json.dumps({
                    **saved, "simulator_reuploaded_attachment": uploaded["id"], "native_read_back": observed,
                }))
                devices = client.pages("devices")
                assert not any(device["name"] == "Simulator Flow" for device in devices), "logout did not revoke device"
                assert all(not item["unread"] for item in client.pages("inbox")), "foreground final should have been marked seen"
            finally:
                client.call("logout")
                client.close()
            print("iPhone 27.2 UI: Keychain relaunch, final/read receipt, local Files export/re-import, four-record upload/download, new thread, avatar and logout passed.")
        authorization = artifacts / "authorization"
        authorization.mkdir()
        with reconnect_fixture(lambda: server(binary), lambda env, label: fixture_client(driver, env, label),
                               lambda env, adapter, art: seed_simulator(driver, env, adapter, art, manifest=authorization),
                               artifacts, simulator) as env:
            simulator_test(simulator, env, authorization, only_testing=UI_REVOCATION)
        print("iPhone 27.2 UI: live revocation, protected preview dismissal, cold sign-in, swapped pin/endpoint scope, and explicit receipt recovery passed.")
    print(f"Evidence: {artifacts}")


if __name__ == "__main__":
    assert len(sys.argv) in (5, 6)
    main(*map(os.path.abspath, sys.argv[1:5]), *sys.argv[5:])
