"""Disposable loopback-only controls for XCTest; the app only sees normal Noise TCP."""

import json
import select
import socket
import subprocess
from contextlib import ExitStack, contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socketserver import BaseRequestHandler, ThreadingTCPServer
from threading import Lock, Thread

RECOVERY_DRAFT = "Keep this exact ordinary draft after losing the send receipt"
LIVE_DEVICE = "Simulator Live Revocation"
MEDIA_DEVICE = "Simulator Media Revocation"
REVOKED_DRAFT = "This draft must never be queued after a peer revokes this device"
COLD_DEVICE = "Simulator Cold Revocation"
ROTATION_DEVICE = "Simulator Pin Scope"


def packet_size(operation):
    return len(json.dumps(operation, separators=(",", ":")).encode()) + 17


def frame(sock):
    def exact(count):
        data = bytearray()
        while len(data) < count:
            chunk = sock.recv(count - len(data))
            if not chunk:
                raise EOFError
            data.extend(chunk)
        return bytes(data)

    prefix = exact(2)
    size = int.from_bytes(prefix, "big")
    assert size
    return prefix + exact(size)


class NoiseRelay(ThreadingTCPServer):
    daemon_threads = True

    def __init__(self, state, name):
        self.state, self.name = state, name
        super().__init__(("127.0.0.1", 0), RelayPeer)

    @property
    def address(self):
        return f"127.0.0.1:{self.server_address[1]}"


class RelayPeer(BaseRequestHandler):
    def handle(self):
        relay = self.server
        assert isinstance(relay, NoiseRelay)
        state = relay.state
        local = self.request
        drop_reply = False
        try:
            with socket.create_connection(state.target, timeout=5) as remote:
                local.settimeout(5)
                while True:
                    ready, _, _ = select.select((local, remote), (), (), 45)
                    if not ready:
                        return
                    for source in ready:
                        packet = frame(source)
                        if source == local:
                            drop_reply |= state.before_forward(relay.name, len(packet) - 2)
                            remote.sendall(packet)
                        elif drop_reply:
                            # A genuine server response exists, but none reaches the app.
                            return
                        else:
                            local.sendall(packet)
        except (OSError, EOFError):
            return


class Scenario:
    def __init__(self, stack, launch, authorize, seed, artifacts, simulator):
        self.stack, self.launch, self.authorize = stack, launch, authorize
        self.simulator = simulator
        self.lock = Lock()
        self.frames = {"primary": [], "alias": []}
        self.sends = 0
        self.armed = False
        self.env = self.start_server()
        self.thread = seed(self.env, self.adapter, artifacts)
        self.send_size = self.send_packet_size(RECOVERY_DRAFT)
        self.revoke_size = self.send_packet_size(REVOKED_DRAFT)
        self.revoke_on_send = False

    def send_packet_size(self, text):
        return packet_size({"type": "send_turn", "chat": self.thread, "message": {
            "id": "0" * 36, "text": text, "attachments": [],
        }})

    def start_server(self):
        env, self.adapter, _ = self.stack.enter_context(self.launch())
        self.target = ("127.0.0.1", int(env["IOS_NOISE_TEST_ADDRESS"].split(":")[1]))
        return env

    def before_forward(self, relay, size):
        with self.lock:
            self.frames[relay].append(size)
            if relay == "primary" and size == self.send_size:
                self.sends += 1
                if self.armed:
                    self.armed = False
                    return True
            revoke = relay == "primary" and size == self.revoke_size and self.revoke_on_send
            if revoke:
                self.revoke_on_send = False
        if revoke:
            self.revoke(LIVE_DEVICE)
        return False

    def verify_receipt(self, sends):
        with self.lock:
            assert self.sends == sends and not self.armed, (self.sends, sends)
        with self.peer() as client:
            turns = client.history(self.thread)
            assert len(turns) == 2 and turns[1]["text"] == RECOVERY_DRAFT and turns[1]["state"] == "queued"

    def assert_unauthenticated_selection(self, relay):
        with self.lock:
            assert self.frames[relay] == [48, packet_size({"type": "status"})], self.frames[relay]

    @contextmanager
    def peer(self):
        client = self.authorize(self.env, "Verified simulator test peer")
        try:
            yield client
        finally:
            client.call("logout")
            client.close()

    def revoke(self, name):
        with self.peer() as client:
            devices = [item for item in client.pages("devices") if item["name"] == name]
            assert len(devices) == 1, name
            assert client.call("revoke_device", id=devices[0]["id"]) == {"type": "revoked", "current": False}

    def check_device(self, name):
        with self.peer() as client:
            devices = [item for item in client.pages("devices") if item["name"] == name]
            device, = devices
            if name == LIVE_DEVICE and hasattr(self, "live_id"):
                assert self.live_id == device["id"]
            elif name == LIVE_DEVICE:
                self.live_id = device["id"]

    def rotate(self):
        self.check_device(ROTATION_DEVICE)
        old_pin = self.env["IOS_NOISE_TEST_PIN"]
        self.stack.close()  # same relay endpoint, different normal binary process and workspace
        self.env = self.start_server()
        new_pin = self.env["IOS_NOISE_TEST_PIN"]
        assert old_pin != new_pin
        return new_pin

    def assert_rejected_send(self):
        with self.lock:
            assert not self.revoke_on_send, "enrollment was not revoked before forwarding SendTurn"
        with self.peer() as client:
            assert all(turn["text"] != REVOKED_DRAFT for turn in client.history(self.thread))

    def check_media_copy(self, present):
        data = subprocess.check_output(["xcrun", "simctl", "get_app_container", self.simulator,
                                        "org.rothcold.agent.ios", "data"], text=True).strip()
        copies = list(Path(data).rglob("rothcold-noise-file-*"))
        assert bool(copies) == present, "unexpected private preview copy state"

    def revoke_before_send(self):
        with self.lock:
            self.revoke_on_send = True

    def respond(self, action):
        actions = {
            "original-device": lambda: self.check_device(LIVE_DEVICE),
            "alias-request-scope": lambda: self.assert_unauthenticated_selection("alias"),
            "arm": self.arm,
            "no-replay": lambda: self.verify_receipt(1),
            "explicit-retry": lambda: self.verify_receipt(2),
            "revoke-before-send": self.revoke_before_send,
            "send-rejected": self.assert_rejected_send,
            "present-media": lambda: self.check_media_copy(True),
            "revoke-live-media": lambda: self.revoke(MEDIA_DEVICE),
            "discarded-media": lambda: self.check_media_copy(False),
            "revoke-cold": lambda: self.revoke(COLD_DEVICE),
            "rotate": self.rotate,
            "reset-frames": self.reset_frames,
            "rotated-request-scope": lambda: self.assert_unauthenticated_selection("primary"),
        }
        return actions[action]()

    def arm(self):
        with self.lock:
            assert not self.armed and self.sends == 0
            self.armed = True

    def reset_frames(self):
        with self.lock:
            self.frames["primary"].clear()


class FixtureControl(ThreadingHTTPServer):
    def __init__(self, scenario):
        self.scenario = scenario
        super().__init__(("127.0.0.1", 0), ControlHandler)


class ControlHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        control = self.server
        assert isinstance(control, FixtureControl)
        try:
            result = control.scenario.respond(self.path.removeprefix("/"))
            payload = json.dumps(result).encode()
            self.send_response(200)
        except Exception as error:
            payload = json.dumps(f"Fixture control failed ({self.path}): {error}").encode()
            self.send_response(500)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format, *args):
        pass


@contextmanager
def background(listener):
    thread = Thread(target=listener.serve_forever, daemon=True)
    thread.start()
    try:
        yield listener
    finally:
        listener.shutdown()
        listener.server_close()
        thread.join()


@contextmanager
def reconnect_fixture(launch, authorize, seed, artifacts, simulator):
    with ExitStack() as stack:
        scenario = Scenario(stack, launch, authorize, seed, artifacts, simulator)
        with (
            background(NoiseRelay(scenario, "primary")) as primary,
            background(NoiseRelay(scenario, "alias")) as alias,
            background(FixtureControl(scenario)) as control,
        ):
            yield {**scenario.env, "IOS_NOISE_TEST_ADDRESS": primary.address,
                   "IOS_NOISE_TEST_ALIAS": alias.address,
                   "IOS_NOISE_TEST_CONTROL": f"http://127.0.0.1:{control.server_address[1]}"}
