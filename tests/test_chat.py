import asyncio
import math
import os
import secrets
import shutil
import sqlite3
import ssl
import struct
import subprocess
import sys
import time
import unittest
import wave
import zlib
from contextlib import asynccontextmanager, closing, suppress
from io import BytesIO
from pathlib import Path
from urllib.parse import quote
from uuid import UUID, uuid4

ROOT = Path(__file__).resolve().parents[1]
PROFILE = Path(os.environ.get('HERMES_HOME', '/'))
if not PROFILE.is_relative_to(ROOT) or not PROFILE.parent.name.startswith('.test-'):
    raise RuntimeError('Run script/test with its disposable home')


def local_only(event, args):
    if (event in ('socket.connect', 'socket.bind') and not isinstance(args[1], str)
            and args[1][0] not in ('127.0.0.1', '::1')):
        raise AssertionError('Non-loopback socket refused')
    if event == 'socket.getaddrinfo' and args[0] not in ('localhost', '127.0.0.1', '::1'):
        raise AssertionError('External lookup refused')


sys.addaudithook(local_only)
# Load the HTTP client and gateway only after installing the loopback audit hook.
from aiohttp import (  # noqa: E402
    ClientSession,
    CookieJar,
    DummyCookieJar,
    UnixConnector,
    web,
)
from gateway.config import PlatformConfig  # noqa: E402
from gateway.platform_registry import platform_registry  # noqa: E402
from hermes_cli.plugins import PluginManager  # noqa: E402
from http_ingress import api_request, relay  # noqa: E402
from yarl import URL  # noqa: E402

ORIGIN = 'http://127.0.0.1:8766'
WEB = 'http://127.0.0.1:8765'
BROWSER_TMP = str(Path('/proc') / str(os.getpid()) / 'cwd' / PROFILE.parent.name / 'tmp')



def sample_png(accent=(168, 207, 220)):
    def chunk(kind, payload):
        return struct.pack('>I', len(payload)) + kind + payload + struct.pack('>I', zlib.crc32(kind + payload))

    width, height = 240, 120
    rows = []
    for y in range(height):
        pixels = bytearray([0])
        for x in range(width):
            color = (44, 64, 82)
            if 15 < x < 80 and 16 < y < 103:
                color = accent
            if 102 < x < 222 and any(top < y < top + 9 for top in (24, 44, 64, 84)):
                color = (228, 225, 216)
            pixels.extend(color)
        rows.append(pixels)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(b''.join(rows))) + chunk(b'IEND', b''))


def sample_wav():
    stream = BytesIO()
    with wave.open(stream, 'wb') as audio:
        audio.setparams((1, 2, 8000, 0, 'NONE', 'not compressed'))
        audio.writeframes(b''.join(struct.pack('<h', int(3500 * math.sin(i * 2 * math.pi * 440 / 8000)))
                                   for i in range(4800)))
    return stream.getvalue()


def set_fixture_profile(name, avatar=None):
    assert PROFILE.parent.name.startswith('.test-')
    (PROFILE/'profile.yaml').write_text(f'display_name: {name}\n')
    if avatar is not None:
        (PROFILE/'assets').mkdir(exist_ok=True)
        (PROFILE/'assets/avatar.png').write_bytes(avatar)


def setUpModule():
    plugins = PROFILE / 'plugins'
    manager = PluginManager()
    manifest, = manager._scan_directory(plugins, 'user')
    assert manifest.kind == 'platform'
    assert manager._gate_manifest(manifest, set(), {'rothcold_agent'})
    manager._load_plugin(manifest)
    assert platform_registry.get('rothcold_agent')


class GatewayContract(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.token = secrets.token_urlsafe(32)
        bridge = secrets.token_urlsafe(32)
        os.environ.update(ROTHCOLD_AGENT_OWNER_TOKEN=self.token, ROTHCOLD_AGENT_ADAPTER_TOKEN=bridge,
                          ROTHCOLD_AGENT_ALLOWED_USERS='owner')
        self.bridge = {'Origin': ORIGIN, 'Authorization': 'Bearer ' + bridge}
        self.bridge_bearer = {'Authorization': self.bridge['Authorization']}
        data_dir = PROFILE.parent/self._testMethodName
        if self._testMethodName == 'test_existing_python_workspace':
            data_dir.mkdir()
            with sqlite3.connect(data_dir/'history.sqlite3') as db:
                db.executescript((ROOT/'tests/python-v2.sql').read_text())
                db.execute('PRAGMA user_version = 2')
            db.close()
        self.data_dir = data_dir
        self.proc = await self.start_api()
        self.addAsyncCleanup(self.stop_api)

        entry = platform_registry.get('rothcold_agent')
        assert entry is not None and entry.check_fn()
        adapter = platform_registry.create_adapter('rothcold_agent', PlatformConfig(enabled=True))
        assert adapter is not None
        self.adapter = adapter
        if self._testMethodName not in {'test_profile_autofill_customizations_and_live_refresh',
                                        'test_browser_profiles_attachments_and_moves'}:
            self.assertTrue(await self.adapter.connect())
        self.addAsyncCleanup(self.adapter.disconnect)
        self.client = ClientSession()
        self.addAsyncCleanup(self.client.close)
        self.auth = {}

    async def start_api(self):
        proc = await asyncio.create_subprocess_exec(PROFILE.parent/'rothcold-agent', stdout=asyncio.subprocess.PIPE,
                env=dict(os.environ, ROTHCOLD_DATA_DIR=str(self.data_dir)),
                umask=0 if self._testMethodName == 'test_cli_history_permissions' else -1)
        assert proc.stdout is not None
        self.assertEqual(await asyncio.wait_for(proc.stdout.readline(), 5),
                         f'Rothcold Agent listening on {ORIGIN}\n'.encode())
        return proc

    async def stop_api(self):
        if self.proc.returncode is None:
            self.proc.terminate()
        await self.proc.wait()

    async def start_web(self, entry=ROOT/'web/server.mjs', **settings):
        proc = await asyncio.create_subprocess_exec(os.environ['NODE'], entry,
                stdout=asyncio.subprocess.PIPE, env=settings)
        async def stop():
            if proc.returncode is None:
                proc.terminate()
            await proc.wait()
        self.addAsyncCleanup(stop)
        assert proc.stdout is not None
        origin = settings.get('ROTHCOLD_WEB_ORIGIN', WEB)
        self.assertEqual(await asyncio.wait_for(proc.stdout.readline(), 5),
                         f'Rothcold web listening for {origin}\n'.encode())
        return stop

    async def post(self, path, data):
        return await self.client.post(ORIGIN + path, json=data, headers=self.auth)

    async def get(self, path):
        response = await self.client.get(ORIGIN + path, headers=self.auth)
        self.assertEqual(response.status, 200)
        return await response.json()

    async def login(self):
        r = await self.post('/api/login', {'token':self.token})
        self.assertEqual(r.status, 200)
        self.auth['Authorization'] = 'Bearer ' + (await r.json())['session']

    async def upload(self, filename, content, mime, purpose='turn'):
        return await self.client.post(ORIGIN + '/api/attachments', data=BytesIO(content), headers={
            **self.auth, 'Content-Type': mime, 'X-Rothcold-Filename': quote(filename, safe=''),
            'X-Rothcold-Purpose': purpose,
        })

    def profile_fixture(self, name, avatar=None):
        set_fixture_profile(name, avatar)

        def cleanup():
            (PROFILE/'profile.yaml').unlink(missing_ok=True)
            (PROFILE/'assets/avatar.png').unlink(missing_ok=True)
            with suppress(FileNotFoundError):
                (PROFILE/'assets').rmdir()

        self.addCleanup(cleanup)

    async def await_profile(self, name):
        async with asyncio.timeout(5):
            while True:
                profile = await self.get('/api/profile')
                if any(backend['name'] == name for backend in profile['backends']):
                    return profile
                await asyncio.sleep(.05)

    async def test_profile_autofill_customizations_and_live_refresh(self):
        await self.adapter.disconnect()
        await self.login()
        self.assertEqual((await self.post('/api/profile/sync', {})).status, 409)
        self.profile_fixture('Studio Hermes', sample_png())
        self.assertTrue(await self.adapter.connect())
        original = await self.await_profile('Studio Hermes')
        self.assertEqual(original['agent']['name'], 'Studio Hermes')
        self.assertIsNotNone(original['agent']['avatar'])
        self.assertEqual(original['agent']['avatar'], original['backends'][0]['avatar'])
        self.assertEqual((await self.client.get(ORIGIN + '/api/attachments/' + original['agent']['avatar'])).status, 401)
        saved = await self.upload('custom.png', sample_png((231, 198, 143)), 'image/png', 'avatar')
        self.assertEqual(saved.status, 201)
        owner_avatar = (await saved.json())['id']
        custom = {'name': 'Local agent', 'avatar': owner_avatar}
        owner = {'name': 'Studio owner', 'avatar': owner_avatar}
        self.assertEqual((await self.post('/api/profile', {'owner': owner, 'agent': custom})).status, 200)
        await self.adapter.disconnect()
        set_fixture_profile('Changed in Hermes')
        self.assertTrue(await self.adapter.connect())
        unchanged = await self.await_profile('Changed in Hermes')
        self.assertEqual(unchanged['agent'], custom)
        self.assertEqual(unchanged['backends'][0]['avatar'], original['agent']['avatar'])
        set_fixture_profile('Refreshed in Hermes', sample_png((133, 185, 154)))
        response = await self.post('/api/profile/sync', {'backend': 'hermes'})
        self.assertEqual(response.status, 200)
        synced = await response.json()
        self.assertEqual(synced['sync'], {'backend': 'hermes', 'refresh': 'refreshed', 'name': True, 'avatar': True})
        self.assertEqual(synced['agent']['name'], 'Refreshed in Hermes')
        self.assertNotEqual(synced['agent']['avatar'], original['agent']['avatar'])
        self.assertEqual(synced['owner'], owner)
        with closing(sqlite3.connect(self.data_dir/'history.sqlite3')) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM attachments WHERE purpose='backend_avatar'").fetchone(), (2,))
        (PROFILE/'assets/avatar.png').unlink()
        last = await (await self.post('/api/profile/sync', {})).json()
        self.assertIsNone(last['backends'][0]['avatar'])
        self.assertEqual(last['agent']['avatar'], synced['agent']['avatar'])

    async def test_profile_sync_preserves_newer_agent_edit_and_requires_matching_report(self):
        await self.adapter.disconnect()
        await self.login()
        avatar = (await self.upload('owner.png', sample_png(), 'image/png', 'avatar'))
        self.assertEqual(avatar.status, 201)
        avatar_id = (await avatar.json())['id']
        self.assertEqual((await self.post('/api/profile', {'agent': {'name': 'Custom', 'avatar': avatar_id}})).status, 200)
        backend_avatar = await self.client.post(ORIGIN+'/adapter/avatar', data=sample_png(), headers={
            **self.bridge, 'Content-Type': 'image/png', 'X-Rothcold-Filename': 'backend.png',
        })
        self.assertEqual(backend_avatar.status, 201)
        profile = {'backend': 'hermes', 'kind': 'hermes', 'name': 'Fresh', 'avatar': (await backend_avatar.json())['id']}

        async def bridge_post(route, payload):
            return await self.client.post(ORIGIN + '/adapter/' + route, headers=self.bridge, json=payload)

        async def claim_refresh():
            async with asyncio.timeout(2):
                while True:
                    poll = await bridge_post('claim', {'backend': 'hermes'})
                    self.assertEqual(poll.status, 200)
                    result = await poll.json()
                    if result:
                        self.assertIs(result['sync_profile'], True)
                        self.assertEqual(UUID(result['sync_id']).version, 4)
                        return result['sync_id']
                    await asyncio.sleep(.01)

        await bridge_post('claim', {'backend': 'hermes'})
        request = asyncio.create_task(self.post('/api/profile/sync', {'backend': 'hermes'}))
        stale = await claim_refresh()
        # Clearing fields is manual too; a correlated report must not passively refill them.
        self.assertEqual((await self.post('/api/profile', {'agent': {'name': '', 'avatar': None}})).status, 200)
        self.assertEqual((await bridge_post('profile', dict(profile, sync_id=stale))).status, 200)
        conflict = await request
        self.assertEqual(conflict.status, 409)
        self.assertIn('manual edit was kept', await conflict.text())
        saved = await self.get('/api/profile')
        self.assertEqual(saved['agent'], {'name': '', 'avatar': None})
        self.assertEqual(saved['backends'][0]['name'], 'Fresh')

        request = asyncio.create_task(self.post('/api/profile/sync', {'backend': 'hermes'}))
        current = await claim_refresh()
        self.assertNotEqual(stale, current)
        self.assertEqual((await bridge_post('profile', dict(profile, sync_id=stale, name='Stale'))).status, 409)
        self.assertEqual((await self.get('/api/profile'))['backends'][0]['name'], 'Fresh')
        self.assertEqual((await bridge_post('profile', dict(profile, name='Unsolicited'))).status, 200)
        self.assertEqual((await self.get('/api/profile'))['agent']['name'], 'Unsolicited')
        self.assertFalse(request.done())
        self.assertEqual((await bridge_post('profile', dict(profile, sync_id=current, name='Matched'))).status, 200)
        response = await request
        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())['agent']['name'], 'Matched')

    async def test_native_upload_slots_reject_before_reading_body(self):
        await self.login()
        pending = []
        try:
            for expected in [b'100', b'100', b'503']:
                reader, writer = await asyncio.open_connection('127.0.0.1', 8766)
                pending.append((reader, writer))
                writer.write(('POST /api/attachments HTTP/1.1\r\nHost: 127.0.0.1:8766\r\n'
                              f'Authorization: {self.auth["Authorization"]}\r\n'
                              'Content-Type: text/plain\r\nX-Rothcold-Filename: test.txt\r\n'
                              'Expect: 100-continue\r\nContent-Length: 4\r\n\r\n').encode())
                await writer.drain()
                self.assertEqual((await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 2)).split(b' ')[1], expected)
            for reader, writer in pending[:2]:
                writer.write(b'test')
                await writer.drain()
                self.assertEqual((await asyncio.wait_for(reader.readline(), 2)).split(b' ')[1], b'201')
            self.assertEqual((await self.upload('available.txt', b'test', 'text/plain')).status, 201)
        finally:
            for _, writer in pending:
                writer.close()
                await writer.wait_closed()

    async def test_web_attachment_transfer_slots_with_slow_clients(self):
        upload_started = asyncio.Queue()
        download_started = asyncio.Queue()
        release_downloads = asyncio.Event()
        cookie = 'a' * 64
        packet = b'fixture'

        async def upload(request):
            # Observing the first byte before the client completes proves streaming.
            await upload_started.put(await request.content.readexactly(1))
            assert await request.content.read() == packet[1:]
            return web.Response(body=b'{}', content_type='application/json', status=201)

        async def media(request):
            await download_started.put(True)
            response = web.StreamResponse(headers={
                'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename=test',
            })
            await response.prepare(request)
            await release_downloads.wait()
            await response.write(packet)
            return response

        fixture = web.Application()
        async def status(_):
            return web.json_response({'service': 'rothcold-agent', 'apiVersion': 1})

        fixture.router.add_get('/api/status', status)
        fixture.router.add_post('/api/attachments', upload)
        fixture.router.add_get('/api/attachments/{id}', media)
        runner = web.AppRunner(fixture)
        await runner.setup()
        self.addAsyncCleanup(runner.cleanup)
        site = web.TCPSite(runner, '127.0.0.1', 0)
        await site.start()
        target = f'http://127.0.0.1:{runner.addresses[0][1]}'
        await self.start_web(ROTHCOLD_API_URL=target)
        base = await self.client.get(WEB+'/connection/check', headers={'X-Rothcold-Server': target})
        scope = (await base.json())['mediaBase'].split('/')[-1]
        web_cookie = f'rothcold_{scope}={cookie}'
        pending = []
        downloads = []
        try:
            for _ in range(2):
                reader, writer = await asyncio.open_connection('127.0.0.1', 8765)
                pending.append((reader, writer))
                writer.write(('POST /api/attachments HTTP/1.1\r\nHost: 127.0.0.1:8765\r\n'
                              f'Origin: {WEB}\r\nX-Rothcold-Server: {target}\r\nCookie: {web_cookie}\r\n'
                              'Content-Type: text/plain\r\nX-Rothcold-Filename: test.txt\r\n'
                              f'Content-Length: {len(packet)}\r\n\r\n').encode() + packet[:1])
                await writer.drain()
                self.assertEqual(await asyncio.wait_for(upload_started.get(), 2), packet[:1])
            def upload_via_web():
                return self.client.post(WEB+'/api/attachments', headers={
                    'Origin': WEB, 'X-Rothcold-Server': target, 'Cookie': web_cookie,
                    'Content-Type': 'text/plain', 'X-Rothcold-Filename': 'test.txt',
                }, data=packet)

            self.assertEqual((await upload_via_web()).status, 503)
            for reader, writer in pending:
                writer.write(packet[1:])
                await writer.drain()
                self.assertEqual((await asyncio.wait_for(reader.readline(), 2)).split(b' ')[1], b'201')
            self.assertEqual((await upload_via_web()).status, 201)

            media_url = f'{WEB}/api/media/{scope}/attachments/{uuid4()}'
            for _ in range(8):
                task = asyncio.create_task(self.client.get(media_url, headers={'Cookie': web_cookie}))
                downloads.append(task)
                await asyncio.wait_for(download_started.get(), 2)
            self.assertEqual((await self.client.get(media_url, headers={'Cookie': web_cookie})).status, 503)
            release_downloads.set()
            for task in downloads:
                self.assertEqual(await (await task).read(), packet)
            self.assertEqual(await (await self.client.get(media_url, headers={'Cookie': web_cookie})).read(), packet)
        finally:
            release_downloads.set()
            for task in downloads:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*downloads, return_exceptions=True)
            for _, writer in pending:
                writer.close()
                await writer.wait_closed()

    async def test_attachments_ranges_disk_safety_and_hermes_media_event(self):
        await self.adapter.disconnect()
        await self.login()
        data = [
            ('photo.png', sample_png(), 'image/png'),
            ('clip.webm', (ROOT/'tests/fixtures/video.webm').read_bytes(), 'video/webm'),
            ('voice.wav', sample_wav(), 'audio/wav'),
            ('../résumé.html', b'<!doctype html><h1>Fixture</h1>', 'text/html'),
            ('markup.svg', b'<svg onload="example()"/>', 'image/svg+xml'),
        ]
        items = []
        for index, (filename, content, mime) in enumerate(data):
            response = await self.upload(filename, content, mime)
            self.assertEqual(response.status, 201)
            item = await response.json()
            items.append(item)
            self.assertEqual(item['filename'], filename.split('/')[-1])
            self.assertEqual(item['mime'], mime if index < 3 else 'application/octet-stream')
            self.assertEqual(item['size'], len(content))
            stored = self.data_dir/'attachments'/item['id']
            self.assertEqual(stored.read_bytes(), content)
            self.assertEqual(stored.stat().st_mode & 0o777, 0o600)
            self.assertEqual(stored.parent.stat().st_mode & 0o777, 0o700)
            response = await self.client.get(ORIGIN + '/api/attachments/' + item['id'], headers=self.auth)
            self.assertEqual(response.status, 200)
            self.assertTrue(response.headers['Content-Disposition'].startswith('inline;' if index < 3 else 'attachment;'))
            self.assertEqual(await response.read(), content)
            response = await self.client.get(ORIGIN + '/api/attachments/' + item['id'] + '/download', headers=self.auth)
            self.assertTrue(response.headers['Content-Disposition'].startswith('attachment;'))
        target = ORIGIN + '/api/attachments/' + items[0]['id']
        response = await self.client.get(target, headers={**self.auth, 'Range': 'bytes=1-4'})
        self.assertEqual(response.status, 206)
        self.assertEqual(response.headers['Content-Range'], f'bytes 1-4/{len(data[0][1])}')
        self.assertEqual(await response.read(), data[0][1][1:5])
        self.assertEqual((await self.client.get(target, headers={**self.auth, 'Range': 'bytes=999999-'})).status, 416)
        self.assertEqual((await self.upload('profile.svg', data[-1][1], 'image/svg+xml', 'avatar')).status, 400)
        self.assertEqual((await self.upload('big.png', b'0'*(5*1024*1024+1), 'image/png', 'avatar')).status, 413)
        self.assertEqual((await self.post('/api/profile', {'owner': {'name': 'X'*65536}})).status, 413)
        adapter_path = ORIGIN + '/adapter/attachments/' + items[0]['id']
        self.assertEqual((await self.client.get(adapter_path, headers=self.bridge)).status, 404)
        chat = str(uuid4())
        payload = {'id': chat, 'attachments': [item['id'] for item in items], 'text': ''}
        response = await self.post('/api/chats', payload)
        self.assertEqual(response.status, 202)
        self.assertEqual((await response.json())['title'], 'photo.png')
        self.assertEqual((await self.post('/api/chats', payload)).status, 200)
        self.assertEqual((await self.post(f'/api/chats/{chat}/turns', {**payload, 'id': str(uuid4())})).status, 409)
        self.assertEqual((await self.client.get(adapter_path, headers=self.bridge)).status, 200)
        self.assertEqual((await self.client.get(adapter_path, headers=self.auth)).status, 401)
        self.assertEqual((await self.get(f'/api/chats/{chat}/turns'))[0]['attachments'], items)

        received = asyncio.get_running_loop().create_future()

        async def reply(event):
            received.set_result(event)
            return 'I received the files.'

        self.adapter.set_message_handler(reply)
        self.assertTrue(await self.adapter.connect())
        event = await asyncio.wait_for(received, 6)
        self.assertEqual(event.text, '')
        self.assertEqual(event.source.chat_id, chat)
        self.assertEqual(event.media_types, [item['mime'] for item in items])
        self.assertEqual(event.media_filenames, [item['filename'] for item in items])
        self.assertEqual([Path(path).read_bytes() for path in event.media_urls], [entry[1] for entry in data])

    async def test_adapter_retries_busy_attachment_download_before_single_admission(self):
        from unittest.mock import patch

        await self.login()
        content = b'Attachment contents after slot release.\n'
        file = await self.upload('retry.txt', content, 'text/plain')
        self.assertEqual(file.status, 201)
        item = await file.json()
        # These unread responses are larger than the loopback socket buffers.
        large = await self.upload('slow.bin', bytes(8 * 1024 * 1024), 'application/octet-stream')
        self.assertEqual(large.status, 201)
        large_id = (await large.json())['id']
        held = []
        busy = asyncio.Event()
        finish = asyncio.Event()
        admitted = asyncio.Event()
        downloads, admissions, events = [], [], []
        turn = str(uuid4())
        history = f'/api/chats/{turn}/turns'
        client = self.adapter.client
        assert client is not None
        get, post = client.get, self.adapter.post

        @asynccontextmanager
        async def observe_download(url, **kwargs):
            async with get(url, **kwargs) as response:
                if url.endswith('/' + item['id']):
                    downloads.append(response.status)
                    if response.status == 503:
                        busy.set()
                yield response

        async def observe_admission(route, data):
            result = await post(route, data)
            if route == 'admission' and data['id'] == turn:
                admissions.append(data['accepted'])
                admitted.set()
            return result

        async def reply(event):
            events.append(event)
            await finish.wait()
            return 'Received after a busy download.'

        self.adapter.set_message_handler(reply)
        try:
            for _ in range(8):
                reader, writer = await asyncio.open_connection('127.0.0.1', 8766, limit=4096)
                held.append(writer)
                writer.write((f'GET /api/attachments/{large_id} HTTP/1.1\r\nHost: 127.0.0.1:8766\r\n'
                              f'Authorization: {self.auth["Authorization"]}\r\n\r\n').encode())
                await writer.drain()
                header = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 3)
                self.assertEqual(header.split(b' ')[1], b'200')
            with (patch.object(client, 'get', side_effect=observe_download),
                  patch.object(self.adapter, 'post', side_effect=observe_admission)):
                queued = await self.post('/api/chats', {'id': turn, 'attachments': [item['id']]})
                self.assertEqual(queued.status, 202)
                await asyncio.wait_for(busy.wait(), 5)
                self.assertEqual((await self.get(history))[0]['state'], 'reserved')
                self.assertEqual(events, [])
                for writer in held:
                    writer.transport.abort()
                await asyncio.wait_for(admitted.wait(), 5)
                self.assertEqual((await self.get(history))[0]['state'], 'accepted')
                self.assertEqual(admissions, [True])
                self.assertEqual(downloads[0], 503)
                self.assertEqual(downloads[-1], 200)
                self.assertEqual(downloads.count(200), 1)
                self.assertEqual([event.message_id for event in events], [turn])
                self.assertEqual(Path(events[0].media_urls[0]).read_bytes(), content)
                finish.set()
                async with asyncio.timeout(5):
                    while (await self.get(history))[0]['state'] != 'answered':
                        await asyncio.sleep(.02)
        finally:
            finish.set()
            for writer in held:
                writer.transport.abort()
                await writer.wait_closed()

    async def test_move_offline_keeps_thread_and_queue_ids(self):
        await self.adapter.disconnect()
        await self.login()
        to = (await (await self.post('/api/channels', {'name': 'Research'})).json())['id']
        chat = str(uuid4())
        request = {'id': chat, 'text': 'Pending'}
        self.assertEqual((await self.post('/api/chats', request)).status, 202)
        self.assertEqual((await self.post(f'/api/chats/{chat}/move', {'channel': 'missing'})).status, 404)
        self.assertEqual((await self.post('/api/chats/missing/move', {'channel': to})).status, 404)
        response = await self.post(f'/api/chats/{chat}/move', {'channel': to})
        self.assertEqual(await response.json(), {'id': chat, 'channel': to})
        self.assertEqual(await self.get('/api/chats'), [{'id':chat, 'title':'Pending', 'channel':to}])
        self.assertEqual((await self.post('/api/chats', request)).status, 200)
        self.assertEqual((await self.get(f'/api/chats/{chat}/turns'))[0]['id'], chat)

    async def test_close_before_final(self):
        calls, release = [], asyncio.Event()

        async def ordinary_handler(event):
            calls.append(event)
            await release.wait()
            return 'One plain-text answer.'

        self.adapter.set_message_handler(ordinary_handler)
        await self.login()
        req = {'id':str(uuid4()), 'text':'Ordinary message'}
        replies = await asyncio.gather(self.post('/api/chats', req), self.post('/api/chats', req))
        first, replay = [await r.json() for r in replies]
        self.assertEqual(first, replay)
        chat = first['id']
        path = f'/api/chats/{chat}/turns'
        self.assertEqual(sorted(r.status for r in replies), [200,202])
        self.assertEqual((await self.post(path, dict(req,text='Other'))).status, 409)
        async with asyncio.timeout(5):
            while not calls:
                await asyncio.sleep(.05)
        self.assertFalse((await self.adapter.send(chat, 'status', reply_to=req['id'], metadata={'notify':True})).success)
        progress = await self.adapter.send(chat, '💻 terminal\ncargo test')
        self.assertTrue(progress.success and progress.message_id)
        edited = await self.adapter.edit_message(chat, progress.message_id, '💻 terminal\ncargo test\n📖 Reading src/main.rs')
        self.assertTrue(edited.success)
        commentary = await self.adapter.send(
            chat, 'Tests passed.', metadata={'_interim_send': True, 'reply_to_message_id': req['id']})
        self.assertTrue(commentary.success and commentary.message_id)
        expected_updates = [
            {'id': progress.message_id, 'kind': 'progress', 'text': '💻 terminal\ncargo test\n📖 Reading src/main.rs'},
            {'id': commentary.message_id, 'kind': 'commentary', 'text': 'Tests passed.'},
        ]
        self.assertEqual((await self.get(path))[0]['updates'], expected_updates)
        self.assertEqual([row for row in await self.get('/api/notifications') if row['chat'] == chat], [])
        await self.client.close()
        release.set()
        await asyncio.wait_for(asyncio.gather(*self.adapter._background_tasks), 5)
        self.assertEqual(len(calls), 1)
        event = calls[0]
        self.assertEqual((event.message_id,event.source.message_id,event.source.thread_id,event.source.chat_id,
                          event.source.user_id), (req['id'],req['id'],None,chat,'owner'))
        self.client = ClientSession()
        self.addAsyncCleanup(self.client.close)
        await self.login()
        for _ in range(2):
            rows = await (await self.client.get(ORIGIN+path,headers=self.auth)).json()
            self.assertEqual(rows,[dict(req,state='answered',answer='One plain-text answer.',updates=expected_updates)])
            result, _ = await self.adapter.send_final_ledgered(event, 'key', rows[0]['answer'], {}, reply_to=req['id'])
            self.assertEqual(result.message_id,'reply:'+req['id'])
        self.assertFalse((await self.adapter.edit_message(chat, progress.message_id, 'late edit')).success)
        inbox = ORIGIN+'/api/notifications'
        event_row = {'request':req['id'], 'chat':chat, 'channel':'general', 'unread':1}
        async def entries():
            return [row for row in await (await self.client.get(inbox, headers=self.auth)).json() if row['chat']==chat]
        for _ in range(2):
            self.assertEqual(await entries(), [event_row])
        self.assertEqual((await self.post('/api/chats/'+chat+'/read', {})).status,200)
        self.assertEqual((await self.post(path,req)).status,200)
        result, _ = await self.adapter.send_final_ledgered(event,'key','One plain-text answer.',{},reply_to=req['id'])
        self.assertEqual(result.message_id, 'reply:'+req['id'])
        self.assertEqual(await entries(), [dict(event_row,unread=0)])
        self.assertEqual(len(calls), 1)

    async def wait_for_fixture_approval(self, chat):
        from tools.approval_gateway_wait import _await_gateway_decision

        loop = asyncio.get_running_loop()
        def notify(data):
            card = self.adapter.send_exec_approval(chat, data['command'], chat, request_id=data['request_id'])
            assert asyncio.run_coroutine_threadsafe(card, loop).result(4).success
        return await asyncio.to_thread(_await_gateway_decision, chat, notify, {'command':'echo fixture'})

    @unittest.skipUnless(os.environ.get('PLAYWRIGHT_DIR'), 'No local Playwright + Chromium')
    async def test_browser_profiles_attachments_and_moves(self):
        await self.adapter.disconnect()
        initial_profile = 'Workspace Hermes'
        self.profile_fixture(initial_profile, sample_png())
        await self.login()
        (self.data_dir/'sample.png').write_bytes(sample_png((231, 198, 143)))
        (self.data_dir/'sample.wav').write_bytes(sample_wav())
        target = (await (await self.post('/api/channels', {'name':'Research'})).json())['id']
        remote = (await (await self.post('/api/channels', {'name':'Archive'})).json())['id']
        # Populate only the disposable Research directory so browser Back can restore its scroll.
        with closing(sqlite3.connect(self.data_dir/'history.sqlite3')) as db, db:
            for index in range(24):
                chat = str(uuid4())
                db.execute('INSERT INTO chats VALUES(?,?)', (chat, f'Research fixture {index+1}'))
                db.execute('INSERT INTO placement(chat,channel,original_channel) VALUES(?,?,?)', (chat, target, target))
        await self.start_web()

        async def reply(event):
            await self.adapter.send(event.source.chat_id, 'Reading the attachments.',
                                    metadata={'_interim_send': True, 'reply_to_message_id': event.message_id})
            return 'The attachments reached the gateway.'

        self.adapter.set_message_handler(reply)
        p = await asyncio.create_subprocess_exec(os.environ['NODE'], ROOT/'tests/browser.cjs', '--features',
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, env=dict(os.environ,
                TMPDIR=BROWSER_TMP, FEATURE_DATA=str(self.data_dir), MOVE_OFFLINE=target, MOVE_ONLINE=remote))
        try:
            assert p.stdout is not None and p.stdin is not None
            self.assertEqual(await asyncio.wait_for(p.stdout.readline(), 55), b'offline-moved\n')
            self.assertTrue(await self.adapter.connect())
            await self.await_profile(initial_profile)
            p.stdin.write(b'online\n')
            await p.stdin.drain()
            self.assertEqual(await asyncio.wait_for(p.stdout.readline(), 40), b'refresh-profile\n')
            set_fixture_profile('Refreshed Workspace Hermes', sample_png((133, 185, 154)))
            p.stdin.write(b'profile-ready\n')
            await p.stdin.drain()
            p.stdin.close()
            self.assertEqual(await asyncio.wait_for(p.wait(), 60), 0)
        finally:
            if p.returncode is None:
                p.kill()
                await p.wait()

    @unittest.skipUnless(os.environ.get('PLAYWRIGHT_DIR'), 'No local Playwright + Chromium')
    async def test_browser(self):
        release, calls = asyncio.Event(), []

        async def reply(event):
            calls.append(event.message_id)
            chat = event.source.chat_id
            if event.text != 'What should I read first?':
                return (
                    '## Notes for the working draft\n\n'
                    'The **main argument** belongs in the opening paragraph. Keep the edition notes separate so they can be checked against the source.\n\n'
                    '### Pass through the sources\n\n'
                    '1. Compare page references in the two editions.\n'
                    '2. Move quotations into `reading-notes.md`.\n'
                    '3. Mark uncertain references for a second pass.\n\n'
                    '> Keep source notes separate from interpretation.\n\n'
                    '| Section | Next step |\n| --- | --- |\n| Introduction | Check the scope |\n| References | Verify page numbers |'
                )
            prog = await self.adapter.send(chat, '💻 terminal\ncargo test')
            assert prog.success and prog.message_id
            await self.adapter.edit_message(chat, prog.message_id, '💻 terminal\ncargo test\n📖 Reading src/main.rs')
            await self.adapter.send(
                chat,
                'Checks passed. Writing **summary** now.',
                metadata={'_interim_send': True, 'reply_to_message_id': event.message_id},
            )
            decision = await self.wait_for_fixture_approval(chat)
            assert decision['choice'] == 'session'
            await release.wait()
            return (
                '## Reading plan\n\n'
                'Start with <chapter one> and **read** `Cargo.toml`.\n\n'
                '```rust\nfn main() {}\n```\n\n'
                '| Item | Status |\n| --- | --- |\n| build | ok |'
            )

        self.adapter.set_message_handler(reply)
        await self.start_web()
        p = await asyncio.create_subprocess_exec(os.environ['NODE'], str(ROOT/'tests/browser.cjs'),
                                                 stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                                 env=dict(os.environ, TMPDIR=BROWSER_TMP))
        try:
            assert p.stdout is not None and p.stdin is not None
            self.assertEqual(await asyncio.wait_for(p.stdout.readline(), 45), b'viewing\n')
            release.set()
            await asyncio.wait_for(asyncio.gather(*self.adapter._background_tasks), 5)
            p.stdin.write(b'final\n')
            await p.stdin.drain()
            p.stdin.close()
            self.assertEqual(await asyncio.wait_for(p.wait(), 75), 0)
            self.assertEqual(len(calls), 4)
        finally:
            release.set()
            if p.returncode is None:
                p.kill()
                await p.wait()

    @unittest.skipUnless(os.environ.get('PLAYWRIGHT_DIR'), 'No local Playwright + Chromium')
    async def test_browser_offline(self):
        await self.adapter.disconnect()
        alternate = 'http://127.0.0.1:8770'
        alternate_owner = secrets.token_urlsafe(32)
        alternate_db = PROFILE.parent/'alternate-data'
        isolated = await asyncio.create_subprocess_exec(
            'bwrap', '--unshare-net', '--die-with-parent', '--bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
            sys.executable, '-B', ROOT/'tests/http_ingress.py', stdout=asyncio.subprocess.PIPE,
            env=dict(os.environ, ROTHCOLD_DATA_DIR=str(alternate_db), ROTHCOLD_AGENT_OWNER_TOKEN=alternate_owner,
                     ROTHCOLD_AGENT_ADAPTER_TOKEN=secrets.token_urlsafe(32)))

        async def stop_alternate():
            if isolated.returncode is None:
                isolated.terminate()
            await isolated.wait()

        self.addAsyncCleanup(stop_alternate)
        assert isolated.stdout is not None
        self.assertEqual(await asyncio.wait_for(isolated.stdout.readline(), 5), b'Alternate test API ready\n')
        alternate_client = ClientSession(connector=UnixConnector(path=str(PROFILE.parent/'alternate.sock')),
                                         cookie_jar=DummyCookieJar())
        self.addAsyncCleanup(alternate_client.close)

        async def alternate_api(request):
            return await relay(alternate_client, request, alternate, '127.0.0.1:8770')

        fixture = web.Application()
        fixture.router.add_route('*', '/{path:.*}', alternate_api)
        runner = web.AppRunner(fixture)
        await runner.setup()
        self.addAsyncCleanup(runner.cleanup)
        await web.TCPSite(runner, '127.0.0.1', 8770).start()
        config = self.data_dir/'web.json'
        config.write_text(f'{{"trustedApis":["{alternate}"]}}')
        await self.start_web(ROTHCOLD_WEB_CONFIG=str(config))
        p = await asyncio.create_subprocess_exec(os.environ['NODE'], str(ROOT/'tests/browser.cjs'), '--offline',
                env=dict(os.environ, TMPDIR=BROWSER_TMP, ALTERNATE_OWNER_TOKEN=alternate_owner))
        try:
            self.assertEqual(await asyncio.wait_for(p.wait(), 75), 0)
            with closing(sqlite3.connect(alternate_db/'history.sqlite3')) as db:
                self.assertEqual(db.execute('SELECT text FROM turns').fetchall(), [('Only on server B',)])
                self.assertEqual(db.execute('SELECT name FROM device_sessions').fetchall(), [('Server B browser',)])
            with closing(sqlite3.connect(self.data_dir/'history.sqlite3')) as db:
                self.assertFalse(db.execute("SELECT 1 FROM turns WHERE text='Only on server B'").fetchone())
                self.assertEqual(db.execute('SELECT name FROM device_sessions').fetchall(), [])
        finally:
            if p.returncode is None:
                p.kill()
                await p.wait()

    async def test_live_session_approval(self):
        from unittest.mock import patch

        calls = []
        async def handler(event):
            calls.append(event.text)
            if len(calls) > 1:
                return 'Next task done.'
            decision = await self.wait_for_fixture_approval(event.source.chat_id)
            return 'Decision: ' + str(decision['choice'])

        self.adapter.set_message_handler(handler)
        await self.login()
        rid = str(uuid4())
        path = f'/api/chats/{rid}/turns'
        with patch('tools.approval_context._get_approval_timeout', return_value=15):
            await self.post('/api/chats', {'id':rid, 'text':'Fixture approval'})
            await self.post(path, {'id':str(uuid4()), 'text':'Next job'})
            async with asyncio.timeout(8):
                while not (cards := [u for u in (await self.get(path))[0]['updates'] if u.get('choices')]):
                    await asyncio.sleep(.05)
            self.assertEqual(calls, ['Fixture approval'])
            answer = {'id':str(uuid4()), 'text':'/approve session', 'approval':cards[0]['id']}
            self.assertEqual((await self.post('/api/chats/other/turns', answer)).status,409)
            self.assertEqual((await self.post(path, dict(answer, text='/approve always'))).status,400)
            self.assertEqual((await self.post(path, answer)).status,202)
            self.assertEqual((await self.post(path, answer)).status,409)
            async with asyncio.timeout(8):
                while (rows := await self.get(path))[-1]['state'] != 'answered':
                    await asyncio.sleep(.05)
            self.assertEqual([r['answer'] for r in rows], ['Decision: session','Next task done.'])
            self.assertEqual(len(await self.get('/api/notifications')),2)
            self.assertEqual((await self.post(path, answer)).status,409)

    async def test_approval_is_not_a_fifo_turn(self):
        await self.adapter.disconnect()
        await self.login()
        rid = str(uuid4())
        path = f'/api/chats/{rid}/turns'
        await self.post('/api/chats', {'id': rid, 'text': 'Needs a decision'})
        await self.client.post(ORIGIN+'/adapter/claim', headers=self.bridge, json={})
        await self.client.post(ORIGIN+'/adapter/admission', headers=self.bridge, json={'id':rid, 'accepted':True})
        result = await self.post(path, {'id':str(uuid4()), 'text':'/approve session'})
        self.assertEqual(result.status, 409, 'An unbound approval must not become a queued turn')
        self.assertEqual(len(await self.get(path)), 1)

    async def test_interrupted_admission(self):
        chat = str(uuid4())
        req = {'id':chat, 'text':'Uncertain admission'}
        await self.adapter.disconnect()
        await self.login()
        self.assertEqual((await self.post('/api/chats', req)).status, 202)
        claimed = await self.client.post(ORIGIN+'/adapter/claim', headers=self.bridge, json={})
        self.assertEqual((await claimed.json())['id'], chat)
        await self.adapter.connect(is_reconnect=True)
        calls = []

        async def unexpected_call(event):
            calls.append(event.message_id)

        self.adapter.set_message_handler(unexpected_call)
        await self.login()
        path = f'/api/chats/{chat}/turns'
        self.assertEqual((await self.post('/api/chats', req)).status, 200)
        self.assertEqual((await self.post(path, req)).status, 200)
        for meta in ({}, {'_interim_send':True}, {'thread_id':chat}, {'notify':True}):
            self.assertFalse((await self.adapter.send(chat, 'Unverified', metadata=meta)).success)
        async with asyncio.timeout(5):
            while (rows := await self.get(path))[0]['state'] == 'reserved':
                await asyncio.sleep(.05)
        self.assertEqual(rows, [dict(req, state='unknown', answer=None, updates=[])])
        self.assertEqual(calls, [])

    async def test_rename_offline_thread(self):
        await self.adapter.disconnect()
        chat = str(uuid4())
        req = {'id': chat, 'text': 'Original message'}
        path = f'/api/chats/{chat}/rename'
        data = {'title': 'Renamed'}
        self.assertEqual((await self.post(path, data)).status, 401)
        self.assertEqual((await self.client.post(ORIGIN + path, json=data, headers=self.bridge_bearer)).status, 401)
        await self.login()
        self.assertEqual((await self.post(path, data)).status, 404)
        self.assertEqual((await self.post('/api/chats', req)).status, 202)
        for invalid in (' ', None, 'a\nb', '📖' * 81):
            self.assertEqual((await self.post(path, {'title': invalid})).status, 400)
        for name in ('  Renamed  ', '📖' * 80):
            response = await self.post(path, {'title': name})
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {'title': name.strip()})
        receipt = {'id': chat, 'title': '📖' * 80, 'channel': 'general'}
        self.assertEqual(await self.get('/api/chats'), [receipt])
        self.assertEqual(await (await self.post('/api/chats', req)).json(), receipt)
        self.assertEqual(await self.get(f'/api/chats/{chat}/turns'),
                         [dict(req, state='queued', answer=None, updates=[])])
        self.assertEqual(await self.get('/api/notifications'), [])

    async def test_channels(self):
        await self.login()
        response = await self.post('/api/channels', {'name': '  Research  '})
        self.assertEqual(response.status, 201)
        channel = (await response.json())['id']
        listed = await (await self.client.get(ORIGIN+'/api/channels', headers=self.auth)).json()
        self.assertIn({'id':channel, 'name':'Research'}, listed)
        self.assertEqual((await self.post('/api/channels', {'name': 'research'})).status, 409)
        self.assertEqual((await self.post('/api/channels', {'name': ' '})).status, 400)
        async def reply(event):
            return 'Noted.'
        self.adapter.set_message_handler(reply)
        msg = {'id':str(uuid4()), 'text':'  Task\n' + '读' * 100, 'channel':channel}
        before = await self.get('/api/chats')
        self.assertEqual((await self.post('/api/chats', {'title':'Task'})).status, 400)
        self.assertEqual((await self.post('/api/chats', dict(msg,text=' '))).status, 400)
        self.assertEqual((await self.post('/api/chats', dict(msg,channel='missing'))).status, 404)
        self.assertEqual(await self.get('/api/chats'), before)
        response = await self.post('/api/chats', msg)
        self.assertEqual(response.status, 202)
        chat = (await response.json())['id']
        self.assertIn({'id':chat,'title':'Task ' + '读' * 75,'channel':channel}, await self.get('/api/chats'))
        self.assertEqual((await self.get(f'/api/chats/{chat}/turns'))[0]['text'], msg['text'])
        for changed in (dict(msg,text='Other'), dict(msg,channel='general')):
            self.assertEqual((await self.post('/api/chats', changed)).status, 409)
        self.assertEqual((await self.client.get(ORIGIN+f'/api/chats/{chat}/read',headers=self.auth)).status,405)
        self.assertEqual((await self.client.post(ORIGIN+f'/api/chats/{chat}/read',json={},
                                                 headers=self.auth|{'Origin':'null'})).status,403)

    async def test_final_body_limit_and_redelivery(self):
        await self.adapter.disconnect()
        await self.login()
        rid = str(uuid4())
        self.assertEqual((await self.post('/api/chats', {'id':rid, 'text':'question'})).status, 202)
        claim = await self.client.post(ORIGIN+'/adapter/claim', headers=self.bridge, json={})
        self.assertEqual((await claim.json())['id'], rid)
        answer = '🌲' * 65536
        data = {'chat':rid,'id':rid,'text':answer}
        for _ in range(2):
            r = await self.client.post(ORIGIN+'/adapter/final', headers=self.bridge, json=data)
            self.assertEqual(r.status, 200)
        self.assertEqual((await self.get(f'/api/chats/{rid}/turns'))[0]['answer'], answer)
        self.assertEqual(len(await self.get('/api/notifications')), 1)
        r = await self.client.post(ORIGIN+'/adapter/final', headers=self.bridge, json=dict(data,text=answer+'x'))
        self.assertEqual(r.status, 400)

    async def test_independent_device_sessions_restart_expiry_and_revocation(self):
        import hashlib

        first = await (await self.post('/api/login', {'token':self.token, 'name':'Phone'})).json()
        old = {'Authorization':'Bearer '+first['session']}
        await self.login()
        current = await self.get('/api/me')
        devices = await self.get('/api/sessions')
        self.assertEqual(devices['current'], current['id'])
        self.assertCountEqual(devices['devices'], [first['device'], current])
        with sqlite3.connect(self.data_dir/'history.sqlite3') as db:
            self.assertEqual(db.execute('SELECT hash FROM device_sessions WHERE id=?', (first['device']['id'],)).fetchone(),
                             (hashlib.sha256(first['session'].encode()).digest(),))
        await self.stop_api()
        self.proc = await self.start_api()
        self.assertEqual(await self.get('/api/me'), current)
        self.assertEqual(await (await self.client.get(ORIGIN+'/api/me', headers=old)).json(), first['device'])
        self.assertEqual((await self.post(f"/api/sessions/{first['device']['id']}/revoke", {})).status, 200)
        self.assertEqual((await self.client.get(ORIGIN+'/api/me', headers=old)).status, 401)
        self.assertEqual(await self.get('/api/me'), current)
        self.assertEqual((await self.post('/api/logout', {})).status, 200)
        self.assertEqual((await self.client.get(ORIGIN+'/api/me', headers=self.auth)).status, 401)
        await self.login()
        with sqlite3.connect(self.data_dir/'history.sqlite3') as db:
            db.execute('UPDATE device_sessions SET expires_at=1')
        self.assertEqual((await self.client.get(ORIGIN+'/api/me', headers=self.auth)).status, 401)

    async def test_login_rate_limit(self):
        for _ in range(8):
            self.assertEqual((await self.post('/api/login',{'token':'wrong'})).status,401)
        self.assertEqual((await self.post('/api/login',{'token':self.token})).status,429)
        self.assertEqual((await self.client.get(ORIGIN+'/api/chats',headers=self.bridge_bearer)).status,401)

    async def test_cli_history_permissions(self):
        self.assertEqual(self.data_dir.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.data_dir/'history.sqlite3').stat().st_mode & 0o777, 0o600)

    async def test_existing_python_workspace(self):
        await self.login()
        self.assertEqual(await self.get('/api/chats'), [{'id':'old','title':'Old title','channel':'general'}])
        self.assertEqual(await self.get('/api/notifications'), [{'request':'one','chat':'old','channel':'general','unread':0}])
        rows = await self.get('/api/chats/old/turns')
        self.assertEqual([(r['id'],r['state'],r['answer']) for r in rows],
                         [('one','answered','旧回复'),('two','unknown',None),('three','queued',None)])

    async def test_home_channel_push_and_standalone_send(self):
        entry = platform_registry.get('rothcold_agent')
        assert entry is not None and entry.standalone_sender_fn is not None
        self.assertEqual(entry.cron_deliver_env_var, 'ROTHCOLD_AGENT_HOME_CHANNEL')
        seen = []

        async def reply(event):
            seen.append(event.allow_gateway_control)
            return 'Ready.'

        self.adapter.set_message_handler(reply)
        await self.login()
        req = {'id': str(uuid4()), 'text': 'Home thread'}
        self.assertEqual((await self.post('/api/chats', req)).status, 202)
        chat = req['id']
        path = f'/api/chats/{chat}/turns'
        async with asyncio.timeout(5):
            while (rows := await self.get(path))[0]['state'] != 'answered':
                await asyncio.sleep(.05)
        self.assertEqual(seen, [True])
        self.assertEqual((await self.post(f'/api/chats/{chat}/read', {})).status, 200)
        pushed = await self.adapter.send(chat, 'Cron **digest** ready.', metadata={'notify': True})
        self.assertTrue(pushed.success and pushed.message_id and pushed.message_id.startswith('push:'))
        out_of_proc = await entry.standalone_sender_fn(PlatformConfig(enabled=True), chat, 'Cross-platform note')
        self.assertTrue(out_of_proc.get('success'))
        self.assertFalse((await self.adapter.send('missing-chat', 'Oops')).success)
        self.assertIn('error', await entry.standalone_sender_fn(PlatformConfig(enabled=True), 'missing-chat', 'Oops'))
        rows = await self.get(path)
        self.assertEqual(len(rows), 3)
        self.assertEqual([(r['text'], r['state'], r['answer']) for r in rows[1:]], [
            ('', 'answered', 'Cron **digest** ready.'),
            ('', 'answered', 'Cross-platform note'),
        ])
        inbox = [e for e in await self.get('/api/notifications') if e['chat'] == chat]
        self.assertEqual([e['unread'] for e in inbox], [1, 1, 0])

    async def test_delayed_upstream_401_does_not_clear_a_new_login(self):
        requested, release = asyncio.Event(), asyncio.Event()
        old_key, new_key = secrets.token_hex(32), secrets.token_hex(32)
        logins = iter((old_key, new_key))

        async def upstream(request):
            if request.path == '/api/status':
                return web.json_response({'service':'rothcold-agent','apiVersion':1})
            if request.path == '/api/login':
                return web.json_response({'session':next(logins), 'device':{'expires_at':int(time.time()) + 60}})
            if request.headers.get('Authorization') == 'Bearer '+old_key:
                requested.set()
                await release.wait()
                raise web.HTTPUnauthorized()
            self.assertEqual(request.headers.get('Authorization'), 'Bearer '+new_key)
            return web.Response(body=b'{"name":"New device"}', content_type='application/json')

        fixture = web.Application()
        fixture.router.add_route('*', '/{path:.*}', upstream)
        runner = web.AppRunner(fixture)
        await runner.setup()
        self.addAsyncCleanup(runner.cleanup)
        await web.TCPSite(runner, '127.0.0.1', 8770).start()
        target = 'http://127.0.0.1:8770'
        await self.start_web(ROTHCOLD_API_URL=target)
        async with ClientSession(cookie_jar=CookieJar(unsafe=True)) as browser:
            select = {'X-Rothcold-Server':target}
            owner = {'token':self.token}
            origin = select|{'Origin':WEB}
            self.assertEqual((await browser.post(WEB+'/api/login', json=owner, headers=origin)).status, 200)
            old = asyncio.create_task(browser.get(WEB+'/api/me', headers=select))
            try:
                await asyncio.wait_for(requested.wait(), 5)
                self.assertEqual((await browser.post(WEB+'/api/login', json=owner, headers=origin)).status, 200)
            finally:
                release.set()
                response = await asyncio.wait_for(old, 5)
            self.assertEqual(response.status, 401)
            self.assertNotIn('Set-Cookie', response.headers)
            self.assertEqual(await (await browser.get(WEB+'/api/me', headers=select)).json(), {'name':'New device'})

    async def test_standalone_web_default_is_packaged(self):
        stage = self.data_dir/'web-stage'
        stage.mkdir()
        for name in ('server.mjs', 'default-web-config.json'):
            shutil.copyfile(ROOT/'web'/name, stage/name)
        shutil.copytree(ROOT/'web/dist', stage/'dist')
        await self.start_web(stage/'server.mjs')
        async with self.client.get(WEB+'/connection/config') as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {'defaultApi': ORIGIN})

    async def test_web_connections_and_cookie_boundaries(self):
        seen = []
        async def other(request):
            seen.append((request.path, request.headers.get('Authorization'), request.headers.get('Cookie')))
            if request.host.endswith(':8771'):
                raise web.HTTPTemporaryRedirect(location=ORIGIN+'/api/status')
            if request.host.endswith(':8772'):
                return web.json_response({'service':'some-other-api','apiVersion':1})
            if request.path == '/api/status':
                return web.json_response({'service':'rothcold-agent','apiVersion':1})
            raise web.HTTPUnauthorized()

        fixture = web.Application()
        fixture.router.add_route('*', '/{tail:.*}', other)
        runner = web.AppRunner(fixture)
        await runner.setup()
        self.addAsyncCleanup(runner.cleanup)
        for port in (8770, 8771, 8772):
            await web.TCPSite(runner, '127.0.0.1', port).start()
        alt, redirect, wrong = (f'http://127.0.0.1:{port}' for port in (8770, 8771, 8772))
        config = self.data_dir/'web.json'
        config.write_text(f'{{"defaultApi":"{alt}","trustedApis":["{ORIGIN}","{alt}","{redirect}","{wrong}"]}}')
        stop_web = await self.start_web(ROTHCOLD_WEB_CONFIG=str(config))
        self.assertEqual(await (await self.client.get(WEB+'/connection/config')).json(), {'defaultApi':alt})
        for route, asset in [('/', 'index.html'), ('/app.js', 'app.js'), ('/app.css', 'app.css')]:
            response = await self.client.get(WEB+route)
            self.assertEqual(await response.read(), (ROOT/'web/dist'/asset).read_bytes())
            self.assertIn("frame-ancestors 'none'", response.headers['Content-Security-Policy'])
        for variant in ('dark', 'light'):
            asset = f'brand/icon-{variant}.svg'
            response = await self.client.get(f'{WEB}/{asset}')
            self.assertEqual(response.status, 200)
            self.assertEqual(response.content_type, 'image/svg+xml')
            self.assertEqual(await response.read(), (ROOT/'assets'/asset).read_bytes())
        await stop_web()
        stop_web = await self.start_web(ROTHCOLD_WEB_CONFIG=str(config), ROTHCOLD_API_URL=ORIGIN)
        self.assertEqual(await (await self.client.get(WEB+'/connection/config')).json(), {'defaultApi':ORIGIN})
        select = {'X-Rothcold-Server':ORIGIN}
        login_url = WEB+'/api/login'
        data = {'token':self.token,'name':'Browser fixture'}
        for chosen, code in [(ORIGIN,200), (alt,200), (redirect,502), (wrong,502),
                             (ORIGIN+'/',403), (ORIGIN+'@example.invalid',403), ('http://192.0.2.1',403)]:
            got = await self.client.get(WEB+'/connection/check', headers={'X-Rothcold-Server':chosen})
            self.assertEqual(got.status, code, chosen)
            self.assertNotIn('Location', got.headers)
        for chosen in [redirect, wrong]:
            response = await self.client.post(login_url, json=data, headers=select|{'Origin':WEB,'X-Rothcold-Server':chosen})
            self.assertEqual(response.status, 502)
        for headers in [select, select|{'Origin':ORIGIN}, select|{'Origin':'null'},
                        select|{'Origin':WEB,'Sec-Fetch-Site':'cross-site'},
                        select|{'Origin':WEB,'Authorization':'Bearer no'}]:
            self.assertEqual((await self.client.post(login_url, json=data, headers=headers)).status, 403)
        self.assertEqual((await self.client.get(WEB, headers={'Host':'localhost:8765'})).status, 403)
        self.assertEqual((await self.client.options(login_url, headers={'Origin':ORIGIN})).status, 405)
        response = await self.client.post(login_url, json=data, headers=select|{'Origin':WEB})
        self.assertEqual(response.status, 200)
        self.assertEqual(await response.json(), {})
        wire = response.headers['Set-Cookie']
        for attr in ('HttpOnly', 'SameSite=Strict', 'Max-Age='):
            self.assertIn(attr, wire)
        cookie = wire.split(';', 1)[0]
        browser = select|{'Cookie':cookie}
        self.assertEqual((await (await self.client.get(WEB+'/api/me', headers=browser)).json())['name'], data['name'])
        for path in ('/adapter/claim','/api/../adapter/claim','/api/%2E%2E/adapter/claim','/api/me?secret=x','/api//me'):
            self.assertEqual((await self.client.get(URL(WEB+path, encoded=True), headers=browser)).status, 404)
        self.assertEqual((await self.client.get(WEB+'/api/me', headers=browser|{'X-Rothcold-Server':alt})).status, 401)
        self.assertTrue(seen and all(call == ('/api/status', None, None) for call in seen), seen)
        await stop_web()
        await self.stop_api()
        self.proc = await self.start_api()
        stop_web = await self.start_web(ROTHCOLD_WEB_CONFIG=str(config), ROTHCOLD_API_URL=ORIGIN)
        self.assertEqual((await self.client.get(WEB+'/api/me', headers=browser)).status, 200)
        self.assertEqual((await self.client.post(WEB+'/api/logout', json={}, headers=browser)).status, 403)
        self.assertEqual((await self.client.get(WEB+'/api/me', headers=browser)).status, 200)
        logged_out = await self.client.post(WEB+'/api/logout', json={}, headers=browser|{'Origin':WEB})
        self.assertEqual(logged_out.status, 200)
        self.assertNotIn('Set-Cookie', logged_out.headers)
        self.assertEqual((await self.client.get(WEB+'/api/me', headers=browser)).status, 401)
        await stop_web()
        # Exercise the web process exactly as a TLS reverse proxy would reach it.
        https_origin = 'https://workspace.example.test'
        await self.start_web(ROTHCOLD_WEB_ORIGIN=https_origin)
        tls_headers = select|{'Host':'workspace.example.test','Origin':https_origin}
        response = await self.client.post(login_url, json=data, headers=tls_headers)
        self.assertEqual(response.status, 200)
        wire = response.headers['Set-Cookie']
        self.assertTrue(wire.startswith('__Host-'))
        self.assertIn('; Secure', wire)
        self.assertEqual((await self.client.post(login_url, json=data, headers=tls_headers|{'Origin':'http://workspace.example.test'})).status, 403)

    @unittest.skipUnless(all(shutil.which(tool) for tool in ('openssl', 'certutil')) and os.environ.get('PLAYWRIGHT_DIR'),
                         'No local OpenSSL, certutil or Playwright + Chromium')
    async def test_https_ingress_trusted_browser_and_native_api(self):
        workspace = 'https://127.0.0.1:8774'
        native = 'https://127.0.0.1:8775'
        ca, ca_key = (self.data_dir/name for name in ('ca.pem', 'ca.key'))
        leaf, leaf_key, csr, extensions = (self.data_dir/name for name in ('leaf.pem', 'leaf.key', 'leaf.csr', 'tls.cnf'))
        extensions.write_text('basicConstraints=critical,CA:FALSE\nsubjectAltName=IP:127.0.0.1\n'
                              'extendedKeyUsage=serverAuth\nauthorityKeyIdentifier=keyid,issuer\n')
        browser_home = self.data_dir/'browser'
        nss = browser_home/'.pki/nssdb'
        nss.mkdir(parents=True)
        for args in [
            ('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Rothcold test CA',
             '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', ca_key, '-out', ca),
            ('openssl', 'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=127.0.0.1',
             '-keyout', leaf_key, '-out', csr),
            ('openssl', 'x509', '-req', '-in', csr, '-CA', ca, '-CAkey', ca_key, '-CAcreateserial',
             '-days', '1', '-extfile', extensions, '-out', leaf),
            ('certutil', '-N', '-d', 'sql:'+str(nss), '--empty-password'),
            ('certutil', '-A', '-d', 'sql:'+str(nss), '-n', 'Rothcold test CA', '-t', 'C,,', '-i', ca),
        ]:
            result = await asyncio.to_thread(subprocess.run, args, capture_output=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(leaf, leaf_key)
        trust = ssl.create_default_context(cafile=str(ca))
        await self.start_web(ROTHCOLD_WEB_ORIGIN=workspace)
        ingress_client = ClientSession(cookie_jar=DummyCookieJar())
        self.addAsyncCleanup(ingress_client.close)

        async def route(request):
            if request.host == '127.0.0.1:8774':
                return await relay(ingress_client, request, WEB, request.host)
            if request.host == '127.0.0.1:8775' and api_request(request):
                return await relay(ingress_client, request, ORIGIN, '127.0.0.1:8766')
            raise web.HTTPNotFound()

        app = web.Application()
        app.router.add_route('*', '/{path:.*}', route)
        runner = web.AppRunner(app)
        await runner.setup()
        self.addAsyncCleanup(runner.cleanup)
        for port in (8774, 8775):
            await web.TCPSite(runner, '127.0.0.1', port, ssl_context=tls).start()
        async with ClientSession() as device:
            login = await device.post(native+'/api/login', json={'token':self.token,'name':'TLS native'}, ssl=trust)
            self.assertEqual(login.status, 200)
            self.assertNotIn('Set-Cookie', login.headers)
            auth = {'Authorization':'Bearer '+(await login.json())['session']}
            self.assertEqual((await device.get(native+'/api/me', headers=auth, ssl=trust)).status, 200)
            denied = await device.get(native+'/api/me', headers=auth|{'Origin':workspace}, ssl=trust)
            self.assertEqual(denied.status, 403)
            self.assertNotIn('Access-Control-Allow-Origin', denied.headers)
            for ingress in (native, workspace):
                # Use a valid adapter bearer: the TLS ingress must not route it at all.
                denied = await device.post(ingress+'/adapter/claim', json={}, headers=self.bridge, ssl=trust)
                self.assertEqual(denied.status, 404)
            self.assertEqual((await device.get(native+'/', ssl=trust)).status, 404)
        browser = await asyncio.create_subprocess_exec(os.environ['NODE'], ROOT/'tests/browser.cjs', '--tls',
                    env=dict(os.environ, TMPDIR=BROWSER_TMP, HOME=str(browser_home), TLS_WEB_ORIGIN=workspace))
        try:
            self.assertEqual(await asyncio.wait_for(browser.wait(), 30), 0)
        finally:
            if browser.returncode is None:
                browser.kill()
                await browser.wait()

    async def test_boundary(self):
        for path in ('/api/channels', '/api/notifications'):
            self.assertEqual((await self.client.get(ORIGIN+path)).status,401)
        self.assertEqual((await self.post('/api/chats/x/read', {})).status,401)
        url = ORIGIN+'/api/chats'
        self.assertEqual((await self.client.get(url)).status,401)
        self.assertEqual((await self.client.post(ORIGIN+'/api/login',json={'token':self.token}, headers={'Origin':ORIGIN})).status,403)
        self.assertEqual((await self.post('/api/login',{'token':'wrong'})).status,401)
        await self.login()
        for headers in ({'Host':'localhost:8766'}, {'Origin':'http://localhost:8766'}, {'Origin':'null'}):
            self.assertEqual((await self.client.get(url,headers=self.auth|headers)).status,403)
        self.assertEqual((await self.client.get(url+'?token=x',headers=self.auth)).status,403)
        self.assertEqual((await self.client.post(url,data='x',headers=self.auth)).status,415)
        self.assertEqual((await self.post('/api/chats',{'title':'x'*70000})).status,413)
        for route in ('claim', 'connect', 'update', 'push', 'final', 'admission'):
            self.assertEqual((await self.post('/adapter/'+route, {})).status,401)
        r = await self.client.get(ORIGIN)
        self.assertEqual(r.status, 404)
        self.assertEqual((await self.client.get(ORIGIN+'/app.js')).status, 404)
        self.assertEqual((await self.client.get(ORIGIN+'/app.css')).status, 404)
        self.assertIn("frame-ancestors 'none'",r.headers['Content-Security-Policy'])
        self.assertNotIn('Access-Control-Allow-Origin',r.headers)
        self.assertEqual((await self.client.get(url, headers=self.auth|{'Sec-Fetch-Site':'cross-site'})).status,403)
        self.assertEqual((await self.client.post(ORIGIN+'/adapter/claim', json={}, headers={'Authorization':self.bridge['Authorization']})).status,403)
