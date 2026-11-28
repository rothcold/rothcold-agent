"""Pinned Hermes adapter behavior on real Noise workspace and loopback adapter listeners."""
import asyncio
import math
import os
import secrets
import sqlite3
import struct
import subprocess
import sys
import unittest
import wave
import zlib
from contextlib import asynccontextmanager, closing, suppress
from io import BytesIO
from pathlib import Path
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
from aiohttp import ClientSession  # pyright: ignore[reportMissingImports]  # noqa: E402
from gateway.config import PlatformConfig  # pyright: ignore[reportMissingImports]  # noqa: E402
from gateway.platform_registry import platform_registry  # pyright: ignore[reportMissingImports]  # noqa: E402
from hermes_cli.plugins import PluginManager  # pyright: ignore[reportMissingImports]  # noqa: E402
from noise_fixture import NoiseFixture  # noqa: E402

ORIGIN = 'http://127.0.0.1:8766'



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
        self.bridge_token = bridge
        self.bridge = {'Origin': ORIGIN, 'Authorization': 'Bearer ' + bridge}
        self.owner_headers = {'Origin': ORIGIN, 'Authorization': 'Bearer '+self.token}
        self.bridge_bearer = {'Authorization': self.bridge['Authorization']}
        data_dir = PROFILE.parent/self._testMethodName
        if self._testMethodName == 'test_existing_python_workspace':
            data_dir.mkdir(mode=0o700)
            with sqlite3.connect(data_dir/'history.sqlite3') as db:
                db.executescript((ROOT/'tests/python-v2.sql').read_text())
                db.execute('PRAGMA user_version = 2')
            db.close()
        self.data_dir = data_dir
        self.server_env = dict(os.environ, ROTHCOLD_DATA_DIR=str(data_dir), ROTHCOLD_NOISE_NATIVE_BIND='127.0.0.1:0')
        self.binary = PROFILE.parent/'rothcold-agent'
        self.pin = subprocess.check_output([self.binary, 'noise-pin'], env=self.server_env, text=True, timeout=5).strip()
        self.pin_bytes = list(bytes.fromhex(self.pin))
        self.proc = await self.start_api()
        self.addAsyncCleanup(self.stop_api)
        self.device = self.connect_noise()

        entry = platform_registry.get('rothcold_agent')
        assert entry is not None and entry.check_fn()
        adapter = platform_registry.create_adapter('rothcold_agent', PlatformConfig(enabled=True))
        assert adapter is not None
        self.adapter = adapter
        if self._testMethodName != 'test_profile_autofill_customizations_and_live_refresh':
            self.assertTrue(await self.adapter.connect())
        self.addAsyncCleanup(self.adapter.disconnect)
        self.client = ClientSession()
        self.addAsyncCleanup(self.client.close)

    async def start_api(self):
        proc = await asyncio.create_subprocess_exec(self.binary, stdout=asyncio.subprocess.PIPE,
                env=self.server_env, umask=0 if self._testMethodName == 'test_cli_history_permissions' else -1)
        try:
            assert proc.stdout is not None
            self.assertEqual(await asyncio.wait_for(proc.stdout.readline(), 5),
                             f'Rothcold Agent adapter listening on {ORIGIN}\n'.encode())
            native = (await asyncio.wait_for(proc.stdout.readline(), 5)).decode().strip()
            prefix = 'Rothcold Agent native Noise listening on '
            self.assertTrue(native.startswith(prefix + '127.0.0.1:'))
            self.native = native.removeprefix(prefix)
            return proc
        except BaseException:
            if proc.returncode is None:
                proc.terminate()
            await proc.wait()
            raise

    async def stop_api(self):
        if self.proc.returncode is None:
            self.proc.terminate()
        await self.proc.wait()

    def connect_noise(self, pin=None):
        client = NoiseFixture(PROFILE.parent/'noise-fixture', self.native, self.pin if pin is None else pin)
        self.addCleanup(client.close)
        return client

    async def request(self, operation, *, via=None, error=None, **fields):
        client = self.device if via is None else via
        outcome = await asyncio.to_thread(client.exchange, operation, **fields)
        if error is not None:
            self.assertEqual((outcome['type'], outcome.get('code')), ('error', error), outcome)
        else:
            self.assertNotEqual(outcome['type'], 'error', outcome)
        return outcome

    async def login(self, *, via=None, name='Fixture device'):
        return await self.request('login_native', via=via, owner_token=self.token, name=name)

    async def resume(self, session, *, via=None, error=None):
        return await self.request('resume_native', via=via, error=error,
                                  pin=self.pin_bytes, credential=session['credential'])

    async def pages(self, operation, **fields):
        return await asyncio.to_thread(self.device.pages, operation, **fields)

    async def history(self, chat):
        return await asyncio.to_thread(self.device.history, chat)

    async def threads(self):
        return await asyncio.to_thread(self.device.threads)

    async def profile(self):
        profile = (await self.request('profile'))['profile']
        return dict(profile, backends=await self.pages('profile_backends'))

    async def edit_profile(self, **identities):
        for identity in identities.values():
            if 'avatar' in identity:
                id_ = identity['avatar']
                identity['avatar'] = {'type': 'clear'} if id_ is None else {'type': 'set', 'id': id_}
        return (await self.request('update_profile', **identities))['profile']

    async def start_thread(self, message, *, channel='general', via=None, error=None, fresh: bool | None = True):
        result = await self.request('start_thread', via=via, error=error, channel=channel, message=message)
        if error is None and fresh is not None:
            self.assertIs(result['fresh'], fresh)
        return result

    async def send_turn(self, chat, message, *, error=None, fresh=True):
        result = await self.request('send_turn', error=error, chat=chat, message=message)
        if error is None:
            self.assertIs(result['fresh'], fresh)
        return result

    async def file_step(self, operation, *, via=None, error=None, **fields):
        return await self.request('fixture_file_step', via=via, error=error, request={'type': operation, **fields})

    async def upload(self, filename, content, mime, purpose='turn', *, error=None):
        result = await self.request('fixture_upload', error=error, filename=filename, bytes=list(content),
                                    mime=mime, purpose=purpose)
        if error is None:
            self.assertEqual(result['type'], 'upload_complete')
            return result['attachment']
        return result

    async def download(self, id_):
        outcome = await self.file_step('download', id=id_)
        self.assertEqual(outcome['type'], 'download_start')
        attachment = outcome['attachment']
        content = bytearray()
        sequence = 0
        while True:
            outcome = await self.file_step('download_next')
            if outcome['type'] == 'download_complete':
                break
            self.assertEqual((outcome['type'], outcome['sequence']), ('fixture_chunk', sequence))
            self.assertEqual(len(outcome['bytes']), min(32768, attachment['size'] - len(content)))
            sequence += 1
            content.extend(outcome['bytes'])
        self.assertEqual(len(content), attachment['size'])
        return attachment, bytes(content)

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
                profile = await self.profile()
                if any(backend['name'] == name for backend in profile['backends']):
                    return profile
                await asyncio.sleep(.05)

    async def test_profile_autofill_customizations_and_live_refresh(self):
        await self.adapter.disconnect()
        await self.login()
        await self.request('sync_profile', error='conflict')
        self.profile_fixture('Studio Hermes', sample_png())
        self.assertTrue(await self.adapter.connect())
        original = await self.await_profile('Studio Hermes')
        self.assertEqual(original['agent']['name'], 'Studio Hermes')
        self.assertIsNotNone(original['agent']['avatar'])
        self.assertEqual(original['agent']['avatar'], original['backends'][0]['avatar'])
        await self.file_step('download', via=self.connect_noise(), id=original['agent']['avatar'], error='unauthorized')
        saved = await self.upload('custom.png', sample_png((231, 198, 143)), 'image/png', 'avatar')
        owner_avatar = saved['id']
        custom = {'name': 'Local agent', 'avatar': owner_avatar}
        owner = {'name': 'Studio owner', 'avatar': owner_avatar}
        await self.edit_profile(owner=dict(owner), agent=dict(custom))
        await self.adapter.disconnect()
        set_fixture_profile('Changed in Hermes')
        self.assertTrue(await self.adapter.connect())
        unchanged = await self.await_profile('Changed in Hermes')
        self.assertEqual(unchanged['agent'], custom)
        self.assertEqual(unchanged['backends'][0]['avatar'], original['agent']['avatar'])
        set_fixture_profile('Refreshed in Hermes', sample_png((133, 185, 154)))
        synced = (await self.request('sync_profile', backend='hermes'))['profile']
        self.assertEqual(synced['sync'], {'backend': 'hermes', 'refresh': 'refreshed', 'name': True, 'avatar': True})
        self.assertEqual(synced['agent']['name'], 'Refreshed in Hermes')
        self.assertNotEqual(synced['agent']['avatar'], original['agent']['avatar'])
        self.assertEqual(synced['owner'], owner)
        with closing(sqlite3.connect(self.data_dir/'history.sqlite3')) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM attachments WHERE purpose='backend_avatar'").fetchone(), (2,))
        (PROFILE/'assets/avatar.png').unlink()
        last = (await self.request('sync_profile'))['profile']
        self.assertIsNone((await self.pages('profile_backends'))[0]['avatar'])
        self.assertEqual(last['agent']['avatar'], synced['agent']['avatar'])

    async def test_profile_sync_preserves_newer_agent_edit_and_requires_matching_report(self):
        await self.adapter.disconnect()
        session = await self.login()
        sync_device = self.connect_noise()
        await self.resume(session, via=sync_device)
        avatar = await self.upload('owner.png', sample_png(), 'image/png', 'avatar')
        await self.edit_profile(agent={'name': 'Custom', 'avatar': avatar['id']})
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
        request = asyncio.create_task(self.request('sync_profile', via=sync_device, backend='hermes', error='conflict'))
        stale = await claim_refresh()
        # Clearing fields is manual too; a correlated report must not passively refill them.
        await self.edit_profile(agent={'name': '', 'avatar': None})
        self.assertEqual((await bridge_post('profile', dict(profile, sync_id=stale))).status, 200)
        conflict = await request
        self.assertIn('manual edit was kept', conflict['message'])
        saved = await self.profile()
        self.assertEqual(saved['agent'], {'name': '', 'avatar': None})
        self.assertEqual(saved['backends'][0]['name'], 'Fresh')

        request = asyncio.create_task(self.request('sync_profile', via=sync_device, backend='hermes'))
        current = await claim_refresh()
        self.assertNotEqual(stale, current)
        self.assertEqual((await bridge_post('profile', dict(profile, sync_id=stale, name='Stale'))).status, 409)
        self.assertEqual((await self.profile())['backends'][0]['name'], 'Fresh')
        self.assertEqual((await bridge_post('profile', dict(profile, name='Unsolicited'))).status, 200)
        self.assertEqual((await self.profile())['agent']['name'], 'Unsolicited')
        self.assertFalse(request.done())
        self.assertEqual((await bridge_post('profile', dict(profile, sync_id=current, name='Matched'))).status, 200)
        response = await request
        self.assertEqual(response['profile']['agent']['name'], 'Matched')

    async def test_native_upload_slots_reject_before_reading_bytes(self):
        session = await self.login()
        holders = [self.connect_noise() for _ in range(2)]
        for reader in holders:
            await self.resume(session, via=reader)
            result = await self.file_step('upload', via=reader, filename='pending.txt', purpose='turn', size=4)
            self.assertEqual(result['type'], 'upload_ready')
        await self.file_step('upload', filename='busy.txt', purpose='turn', size=4, error='busy')
        for reader in holders:
            self.assertEqual((await self.file_step('upload_cancel', via=reader))['type'], 'upload_cancelled')
        self.assertEqual(list((self.data_dir/'attachments').iterdir()), [])
        self.assertEqual((await self.upload('available.txt', b'test', 'text/plain'))['size'], 4)

    async def test_attachments_media_disk_safety_and_hermes_media_event(self):
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
            item = await self.upload(filename, content, mime)
            items.append(item)
            self.assertEqual(item['filename'], filename.split('/')[-1])
            self.assertEqual(item['mime'], mime if index < 3 else 'application/octet-stream')
            self.assertEqual(item['size'], len(content))
            stored = self.data_dir/'attachments'/item['id']
            self.assertEqual(stored.read_bytes(), content)
            self.assertEqual(stored.stat().st_mode & 0o777, 0o600)
            self.assertEqual(stored.parent.stat().st_mode & 0o777, 0o700)
            self.assertEqual(item['kind'], ('image', 'video', 'audio', 'file', 'file')[index])
            self.assertEqual(await self.download(item['id']), (item, content))
        target = ORIGIN + '/api/attachments/' + items[0]['id']
        for suffix, headers in (('', {'Range': 'bytes=1-4'}), ('/download', {})):
            self.assertEqual((await self.client.get(target + suffix, headers=headers)).status, 404)
        await self.upload('profile.svg', data[-1][1], 'image/svg+xml', 'avatar', error='invalid')
        await self.file_step('upload', filename='big.png', purpose='avatar', size=5*1024*1024+1, error='limit')
        await self.request('update_profile', owner={'name': 'X'*81}, error='invalid')
        self.assertTrue((await self.request('fixture_oversized_control'))['rejected'])
        adapter_path = ORIGIN + '/adapter/attachments/' + items[0]['id']
        self.assertEqual((await self.client.get(adapter_path, headers=self.bridge)).status, 404)
        chat = str(uuid4())
        payload = {'id': chat, 'attachments': [item['id'] for item in items], 'text': ''}
        self.assertEqual((await self.start_thread(payload))['title'], 'photo.png')
        await self.start_thread(payload, fresh=False)
        await self.send_turn(chat, {**payload, 'id': str(uuid4())}, error='conflict')
        self.assertEqual((await self.client.get(adapter_path, headers=self.bridge)).status, 200)
        # Range remains adapter-only for linked supported media.
        response = await self.client.get(adapter_path, headers=self.bridge|{'Range': 'bytes=1-4'})
        self.assertEqual(response.status, 206)
        self.assertEqual(response.headers['Content-Range'], f'bytes 1-4/{len(data[0][1])}')
        self.assertEqual(await response.read(), data[0][1][1:5])
        response = await self.client.get(adapter_path, headers=self.bridge|{'Range': 'bytes=999999-'})
        self.assertEqual(response.status, 416)
        self.assertEqual((await self.client.get(adapter_path, headers=self.owner_headers)).status, 401)
        self.assertEqual((await self.history(chat))[0]['attachments'], items)

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

        session = await self.login()
        content = b'Attachment contents after slot release.\n'
        item = await self.upload('retry.txt', content, 'text/plain')
        held_item = await self.upload('held.bin', b'fixture', 'application/octet-stream')
        held = []
        busy = asyncio.Event()
        finish = asyncio.Event()
        admitted = asyncio.Event()
        downloads, admissions, events = [], [], []
        turn = str(uuid4())
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
                holder = self.connect_noise()
                await self.resume(session, via=holder)
                result = await self.file_step('download', via=holder, id=held_item['id'])
                self.assertEqual(result['type'], 'download_start')
                held.append(holder)
            await self.file_step('download', id=held_item['id'], error='busy')
            with (patch.object(client, 'get', side_effect=observe_download),
                  patch.object(self.adapter, 'post', side_effect=observe_admission)):
                await self.start_thread({'id': turn, 'attachments': [item['id']]})
                await asyncio.wait_for(busy.wait(), 5)
                self.assertEqual((await self.history(turn))[0]['state'], 'reserved')
                self.assertEqual(events, [])
                for holder in held:
                    self.assertEqual((await self.file_step('download_cancel', via=holder))['type'], 'download_cancelled')
                await asyncio.wait_for(admitted.wait(), 5)
                self.assertEqual((await self.history(turn))[0]['state'], 'accepted')
                self.assertEqual(admissions, [True])
                self.assertEqual(downloads[0], 503)
                self.assertEqual(downloads[-1], 200)
                self.assertEqual(downloads.count(200), 1)
                self.assertEqual([event.message_id for event in events], [turn])
                self.assertEqual(Path(events[0].media_urls[0]).read_bytes(), content)
                finish.set()
                async with asyncio.timeout(5):
                    while (await self.history(turn))[0]['state'] != 'answered':
                        await asyncio.sleep(.02)
        finally:
            finish.set()


    async def test_move_offline_keeps_thread_and_queue_ids(self):
        await self.adapter.disconnect()
        await self.login()
        to = (await self.request('create_category', name='Research'))['id']
        chat = str(uuid4())
        message = {'id': chat, 'text': 'Pending'}
        await self.start_thread(message)
        await self.request('move_thread', id=chat, channel='missing', error='missing')
        await self.request('move_thread', id='missing', channel=to, error='missing')
        self.assertEqual(await self.request('move_thread', id=chat, channel=to),
                         {'type':'thread_moved', 'id': chat, 'channel': to})
        self.assertEqual(await self.threads(), [{'id':chat, 'title':'Pending', 'channel':to}])
        await self.start_thread(message, fresh=False)
        self.assertEqual((await self.history(chat))[0]['id'], chat)

    async def test_close_before_final(self):
        calls, release = [], asyncio.Event()

        async def ordinary_handler(event):
            calls.append(event)
            await release.wait()
            return 'One plain-text answer.'

        self.adapter.set_message_handler(ordinary_handler)
        session = await self.login()
        duplicate = self.connect_noise()
        await self.resume(session, via=duplicate)
        req = {'id':str(uuid4()), 'text':'Ordinary message'}
        first, replay = await asyncio.gather(self.start_thread(req, fresh=None),
                                             self.start_thread(req, via=duplicate, fresh=None))
        self.assertCountEqual([first.pop('fresh'), replay.pop('fresh')], [False, True])
        self.assertEqual(first, replay)
        chat = first['id']
        await self.send_turn(chat, dict(req,text='Other'), error='conflict')
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
            {'id': progress.message_id, 'kind': 'progress', 'text': '💻 terminal\ncargo test\n📖 Reading src/main.rs', 'choices': []},
            {'id': commentary.message_id, 'kind': 'commentary', 'text': 'Tests passed.', 'choices': []},
        ]
        self.assertEqual((await self.history(chat))[0]['updates'], expected_updates)
        self.assertEqual([row for row in await self.pages('inbox') if row['chat'] == chat], [])
        self.device.close()
        duplicate.close()
        release.set()
        await asyncio.wait_for(asyncio.gather(*self.adapter._background_tasks), 5)
        self.assertEqual(len(calls), 1)
        event = calls[0]
        self.assertEqual((event.message_id,event.source.message_id,event.source.thread_id,event.source.chat_id,
                          event.source.user_id), (req['id'],req['id'],None,chat,'owner'))
        self.device = self.connect_noise()
        await self.resume(session)
        for _ in range(2):
            rows = await self.history(chat)
            self.assertEqual(rows,[dict(req,state='answered',answer='One plain-text answer.',updates=expected_updates)])
            result, _ = await self.adapter.send_final_ledgered(event, 'key', rows[0]['answer'], {}, reply_to=req['id'])
            self.assertEqual(result.message_id,'reply:'+req['id'])
        self.assertFalse((await self.adapter.edit_message(chat, progress.message_id, 'late edit')).success)
        event_row = {'request':req['id'], 'chat':chat, 'channel':'general', 'unread':1,
                     'title':'Ordinary message', 'preview':'One plain-text answer.'}
        async def entries():
            return [row for row in await self.pages('inbox') if row['chat']==chat]
        for _ in range(2):
            self.assertEqual(await entries(), [event_row])
        await self.request('read_thread', chat=chat)
        await self.send_turn(chat, req, fresh=False)
        result, _ = await self.adapter.send_final_ledgered(event,'key','One plain-text answer.',{},reply_to=req['id'])
        self.assertEqual(result.message_id, 'reply:'+req['id'])
        self.assertEqual(await entries(), [dict(event_row,unread=0)])
        self.assertEqual(len(calls), 1)

    async def wait_for_fixture_approval(self, chat):
        from tools.approval_gateway_wait import _await_gateway_decision  # pyright: ignore[reportMissingImports]

        loop = asyncio.get_running_loop()
        def notify(data):
            card = self.adapter.send_exec_approval(chat, data['command'], chat, request_id=data['request_id'])
            assert asyncio.run_coroutine_threadsafe(card, loop).result(4).success
        return await asyncio.to_thread(_await_gateway_decision, chat, notify, {'command':'echo fixture'})

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
        with patch('tools.approval_context._get_approval_timeout', return_value=15):
            await self.start_thread({'id':rid, 'text':'Fixture approval'})
            await self.send_turn(rid, {'id':str(uuid4()), 'text':'Next job'})
            async with asyncio.timeout(8):
                while not (cards := [u for u in (await self.history(rid))[0]['updates'] if u.get('choices')]):
                    await asyncio.sleep(.05)
            self.assertEqual(calls, ['Fixture approval'])
            await self.request('archive_thread', id=rid, archived=True)
            prompt = cards[0]['id']
            await self.request('decide_approval', chat='other', id=prompt, choice='session', error='conflict')
            await self.send_turn(rid, {'id':str(uuid4()), 'text':'/approve always'}, error='conflict')
            self.assertIn('session', cards[0]['choices'])
            await self.request('decide_approval', chat=rid, id=prompt, choice='session')
            await self.request('decide_approval', chat=rid, id=prompt, choice='session', error='conflict')
            async with asyncio.timeout(8):
                while (rows := await self.history(rid))[-1]['state'] != 'answered':
                    await asyncio.sleep(.05)
            self.assertEqual([r['answer'] for r in rows], ['Decision: session','Next task done.'])
            self.assertEqual(len(await self.pages('inbox')),2)
            await self.request('decide_approval', chat=rid, id=prompt, choice='session', error='conflict')

    async def test_archive_is_reversible_without_changing_queue_or_inbox_correlation(self):
        await self.adapter.disconnect()
        await self.request('categories', include_archived=True, error='unauthorized')
        await self.request('threads', include_archived=True, error='unauthorized')
        await self.login()
        category = await self.request('create_category', name='Research')
        cat = category['id']
        for invalid, error in [('  ', 'invalid'), ('GENERAL', 'conflict')]:
            await self.request('rename_category', id=cat, name=invalid, error=error)
        await self.request('rename_category', id='general', name='Home')
        await self.request('archive_category', id='general', archived=True, error='conflict')
        self.assertEqual((await self.request('rename_category', id=cat, name=' Notes '))['name'], 'Notes')
        a, b, queued, push, general = (str(uuid4()) for _ in range(5))
        first = {'id': a, 'text': 'A thread'}
        next_turn = {'id': queued, 'text': 'Already queued'}
        await self.start_thread(first, channel=cat)
        await self.send_turn(a, next_turn)
        await self.start_thread({'id': b, 'text': 'B thread'}, channel=cat)
        general_thread = await self.start_thread({'id':general, 'text':'General opener'})
        self.assertEqual(general_thread['channel'], 'general')

        async def adapter(route, payload):
            return await self.client.post(ORIGIN + '/adapter/' + route, headers=self.bridge, json=payload)

        self.assertEqual((await (await adapter('claim', {})).json())['id'], a)
        self.assertEqual((await adapter('admission', {'id': a, 'accepted': True})).status, 200)
        self.assertEqual((await adapter('connect', {})).status, 200)
        self.assertEqual((await self.history(a))[0]['state'], 'unknown')
        await self.request('archive_thread', id=a, archived=True)
        await self.request('archive_category', id=cat, archived=True)
        self.assertEqual(await self.pages('categories', include_archived=False),
                         [{'id':'general', 'name':'Home', 'archived':False}])
        self.assertEqual([c['id'] for c in await self.threads()], [general])
        categories = await self.pages('categories', include_archived=True)
        self.assertEqual([(c['name'], c['archived']) for c in categories], [('Home', False), ('Notes', True)])
        threads = await self.pages('threads', include_archived=True)
        self.assertEqual({c['id']: c['archived'] for c in threads}, {general: False, b: False, a: True})
        await self.start_thread(first, channel=cat, fresh=False)
        await self.send_turn(a, next_turn, fresh=False)
        await self.send_turn(a, dict(next_turn, text='Different input'), error='conflict')
        await self.start_thread(dict(first, id=str(uuid4())), channel=cat, error='conflict')
        await self.send_turn(b, {'id':str(uuid4()), 'text':'New input'}, error='conflict')
        await self.request('move_thread', id=b, channel='general', error='conflict')
        await self.request('move_thread', id=general, channel=cat, error='conflict')
        await self.request('release_turn', chat=a, id=a)
        self.assertEqual((await (await adapter('claim', {})).json())['id'], queued)
        self.assertEqual((await adapter('final', {'chat': a, 'id': a, 'text': '## Late **reply**'})).status, 200)
        await self.request('read_reply', chat=a, id=a)
        self.assertEqual((await adapter('final', {'chat': a, 'id': queued, 'text': 'Second reply'})).status, 200)
        body = f"**{'云' * 139}👩🏽‍🚀** End"
        for _ in range(2):
            self.assertEqual((await adapter('push', {'chat': a, 'id': push, 'text': body})).status, 200)
        for _ in range(2):
            notices = await self.pages('inbox')
            self.assertEqual([(n['request'], n['title'], n['preview'], n['unread']) for n in notices],
                             [(push, 'A thread', '云' * 139 + '👩🏽‍🚀…', 1),
                              (queued, 'A thread', 'Second reply', 1), (a, 'A thread', 'Late reply', 0)])
        self.assertEqual([(t['state'], t['answer']) for t in await self.history(a)],
                         [('released', '## Late **reply**'), ('answered', 'Second reply'), ('answered', body)])

        await self.request('archive_category', id=cat, archived=False)
        self.assertEqual([c['id'] for c in await self.threads()], [general, b])
        new_turn = {'id': str(uuid4()), 'text': 'After restore'}
        await self.send_turn(a, new_turn, error='conflict')
        await self.request('archive_thread', id=a, archived=False)
        await self.send_turn(a, new_turn)

    async def test_approval_is_not_a_fifo_turn(self):
        await self.adapter.disconnect()
        await self.login()
        rid = str(uuid4())
        await self.start_thread({'id': rid, 'text': 'Needs a decision'})
        await self.client.post(ORIGIN+'/adapter/claim', headers=self.bridge, json={})
        await self.client.post(ORIGIN+'/adapter/admission', headers=self.bridge, json={'id':rid, 'accepted':True})
        await self.send_turn(rid, {'id':str(uuid4()), 'text':'/approve session'}, error='conflict')
        self.assertEqual(len(await self.history(rid)), 1)

    async def test_interrupted_admission(self):
        chat = str(uuid4())
        req = {'id':chat, 'text':'Uncertain admission'}
        await self.adapter.disconnect()
        await self.login()
        await self.start_thread(req)
        claimed = await self.client.post(ORIGIN+'/adapter/claim', headers=self.bridge, json={})
        self.assertEqual((await claimed.json())['id'], chat)
        await self.adapter.connect(is_reconnect=True)
        calls = []

        async def unexpected_call(event):
            calls.append(event.message_id)

        self.adapter.set_message_handler(unexpected_call)
        await self.start_thread(req, fresh=False)
        await self.send_turn(chat, req, fresh=False)
        for meta in ({}, {'_interim_send':True}, {'thread_id':chat}, {'notify':True}):
            self.assertFalse((await self.adapter.send(chat, 'Unverified', metadata=meta)).success)
        async with asyncio.timeout(5):
            while (rows := await self.history(chat))[0]['state'] == 'reserved':
                await asyncio.sleep(.05)
        self.assertEqual(rows, [dict(req, state='unknown', answer=None, updates=[])])
        self.assertEqual(calls, [])

    async def test_rename_offline_thread(self):
        await self.adapter.disconnect()
        chat = str(uuid4())
        message = {'id': chat, 'text': 'Original message'}
        await self.request('rename_thread', id=chat, title='Renamed', error='unauthorized')
        await self.request('login_native', owner_token=self.bridge_token, name='Adapter authority', error='unauthorized')
        await self.login()
        await self.request('rename_thread', id=chat, title='Renamed', error='missing')
        await self.start_thread(message)
        for invalid in (' ', 'a\nb', '📖' * 81):
            await self.request('rename_thread', id=chat, title=invalid, error='invalid')
        for name in ('  Renamed  ', '📖' * 80):
            self.assertEqual(await self.request('rename_thread', id=chat, title=name),
                             {'type':'thread_renamed', 'title': name.strip()})
        receipt = {'id': chat, 'title': '📖' * 80, 'channel': 'general'}
        self.assertEqual(await self.threads(), [receipt])
        response = await self.start_thread(message, fresh=False)
        self.assertEqual({k: response[k] for k in receipt}, receipt)
        self.assertEqual(await self.history(chat), [dict(message, state='queued', answer=None, updates=[])])
        self.assertEqual(await self.pages('inbox'), [])

    async def test_thread_title_adapter_boundary_and_single_use(self):
        await self.adapter.disconnect()
        await self.login()
        chat = str(uuid4())
        opener = {'id': chat, 'text': 'First title prompt'}
        await self.start_thread(opener)
        claim_path = ORIGIN + '/adapter/title-claim'
        result_path = ORIGIN + '/adapter/title-result'
        self.assertEqual((await self.client.post(claim_path, json={}, headers=self.owner_headers)).status, 401)
        self.assertEqual((await self.client.post(claim_path, json={}, headers=self.bridge_bearer)).status, 403)
        async with self.client.post(claim_path, json={}, headers=self.bridge) as response:
            self.assertEqual(response.status, 200)
            job = await response.json()
        self.assertEqual(job['text'], opener['text'])
        self.assertEqual(set(job), {'claim', 'text'})
        for title in ('a\nb', 'x' * 81, 'a\u2028b'):
            async with self.client.post(result_path, json=dict(job, title=title), headers=self.bridge) as response:
                self.assertEqual(response.status, 400)
        for title in ('Semantic title', 'Duplicate result'):
            async with self.client.post(result_path, json={'claim': job['claim'], 'title': title},
                                        headers=self.bridge) as response:
                self.assertEqual(response.status, 200)
        self.assertEqual(await self.threads(), [{'id': chat, 'title': 'Semantic title', 'channel': 'general'}])
        self.assertEqual(await self.history(chat),
                         [dict(opener, state='queued', answer=None, updates=[])])
        self.assertEqual(await self.pages('inbox'), [])

    async def test_channels(self):
        await self.login()
        channel = (await self.request('create_category', name='  Research  '))['id']
        self.assertIn({'id':channel, 'name':'Research', 'archived':False},
                      await self.pages('categories', include_archived=False))
        await self.request('create_category', name='research', error='conflict')
        await self.request('create_category', name=' ', error='invalid')
        async def reply(event):
            return 'Noted.'
        self.adapter.set_message_handler(reply)
        message = {'id':str(uuid4()), 'text':'  Task\n' + '读' * 100}
        before = await self.threads()
        await self.start_thread({'id':'Task'}, channel=channel, error='invalid')
        await self.start_thread(dict(message, text=' '), channel=channel, error='invalid')
        await self.start_thread(message, channel='missing', error='missing')
        self.assertEqual(await self.threads(), before)
        chat = (await self.start_thread(message, channel=channel))['id']
        self.assertIn({'id':chat,'title':'Task ' + '读' * 75,'channel':channel}, await self.threads())
        self.assertEqual((await self.history(chat))[0]['text'], message['text'])
        await self.start_thread(dict(message, text='Other'), channel=channel, error='conflict')
        await self.start_thread(message, channel='general', error='conflict')
        # There is no unauthenticated or HTTP read-receipt path to mutate state.
        await self.request('read_thread', via=self.connect_noise(), chat=chat, error='unauthorized')
        route = ORIGIN + f'/api/chats/{chat}/read'
        self.assertEqual((await self.client.get(route)).status, 404)
        self.assertEqual((await self.client.post(route, json={}, headers={'Origin':'null'})).status, 404)

    async def test_final_body_limit_and_redelivery(self):
        await self.adapter.disconnect()
        await self.login()
        rid = str(uuid4())
        await self.start_thread({'id':rid, 'text':'question'})
        claim = await self.client.post(ORIGIN+'/adapter/claim', headers=self.bridge, json={})
        self.assertEqual((await claim.json())['id'], rid)
        answer = '🌲' * 65536
        data = {'chat':rid,'id':rid,'text':answer}
        for _ in range(2):
            r = await self.client.post(ORIGIN+'/adapter/final', headers=self.bridge, json=data)
            self.assertEqual(r.status, 200)
        self.assertEqual((await self.history(rid))[0]['answer'], answer)
        self.assertEqual(len(await self.pages('inbox')), 1)
        r = await self.client.post(ORIGIN+'/adapter/final', headers=self.bridge, json=dict(data,text=answer+'x'))
        self.assertEqual(r.status, 400)

    async def test_independent_device_sessions_restart_expiry_and_revocation(self):
        import hashlib

        old = self.connect_noise()
        first = await self.login(via=old, name='Phone')
        second = await self.login()
        current = (await self.request('me'))['device']
        devices = await self.request('devices')
        self.assertEqual(devices['current'], current['id'])
        self.assertCountEqual(devices['page']['items'], [first['device'], current])
        expected = hashlib.sha256(b'rothcold-agent/noise/1/device\0' + bytes.fromhex(self.pin)
                                  + b'native\0' + bytes(first['credential'])).digest()
        with closing(sqlite3.connect(self.data_dir/'history.sqlite3')) as db:
            self.assertEqual(db.execute('SELECT hash FROM device_sessions WHERE id=?', (first['device']['id'],)).fetchone(),
                             (expected,))
        self.device.close()
        old.close()
        await self.stop_api()
        self.proc = await self.start_api()
        self.device = self.connect_noise()
        old = self.connect_noise()
        self.assertEqual((await self.resume(second))['device'], current)
        self.assertEqual((await self.resume(first, via=old))['device'], first['device'])
        self.assertFalse((await self.request('revoke_device', id=first['device']['id']))['current'])
        await self.request('me', via=old, error='unauthorized')
        await self.resume(first, via=self.connect_noise(), error='unauthorized')
        self.assertEqual((await self.request('me'))['device'], current)
        await self.request('logout')
        await self.request('me', error='unauthorized')
        self.device = self.connect_noise()
        third = await self.login()
        with closing(sqlite3.connect(self.data_dir/'history.sqlite3')) as db, db:
            db.execute('UPDATE device_sessions SET expires_at=1 WHERE id=?', [third['device']['id']])
        await self.request('me', error='unauthorized')
        await self.resume(third, via=self.connect_noise(), error='unauthorized')

    async def test_login_rate_limit(self):
        for _ in range(8):
            await self.request('login_native', owner_token=secrets.token_urlsafe(32), name='Fixture', error='unauthorized')
        await self.request('login_native', owner_token=self.token, name='Fixture', error='rate_limited')
        await self.request('threads', include_archived=False, error='unauthorized')

    async def test_cli_history_permissions(self):
        self.assertEqual(self.data_dir.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.data_dir/'history.sqlite3').stat().st_mode & 0o777, 0o600)

    async def test_existing_python_workspace(self):
        await self.login()
        self.assertEqual(await self.threads(), [{'id':'old','title':'Old title','channel':'general'}])
        self.assertEqual(await self.pages('inbox'),
                         [{'request':'one','chat':'old','channel':'general','unread':0,
                           'title':'Old title','preview':'旧回复'}])
        self.assertEqual(await self.pages('categories', include_archived=True),
                         [{'id':'general','name':'General','archived':False}])
        self.assertEqual(await self.pages('threads', include_archived=True),
                         [{'id':'old','title':'Old title','channel':'general','archived':False}])
        rows = await self.history('old')
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
        await self.start_thread(req)
        chat = req['id']
        async with asyncio.timeout(5):
            while (rows := await self.history(chat))[0]['state'] != 'answered':
                await asyncio.sleep(.05)
        self.assertEqual(seen, [True])
        await self.request('read_thread', chat=chat)
        pushed = await self.adapter.send(chat, 'Cron **digest** ready.', metadata={'notify': True})
        self.assertTrue(pushed.success and pushed.message_id and pushed.message_id.startswith('push:'))
        out_of_proc = await entry.standalone_sender_fn(PlatformConfig(enabled=True), chat, 'Cross-platform note')
        self.assertTrue(out_of_proc.get('success'))
        self.assertFalse((await self.adapter.send('missing-chat', 'Oops')).success)
        self.assertIn('error', await entry.standalone_sender_fn(PlatformConfig(enabled=True), 'missing-chat', 'Oops'))
        rows = await self.history(chat)
        self.assertEqual(len(rows), 3)
        self.assertEqual([(r['text'], r['state'], r['answer']) for r in rows[1:]], [
            ('', 'answered', 'Cron **digest** ready.'),
            ('', 'answered', 'Cross-platform note'),
        ])
        inbox = [e for e in await self.pages('inbox') if e['chat'] == chat]
        self.assertEqual([e['unread'] for e in inbox], [1, 1, 0])

    async def test_boundary(self):
        wrong_pin = bytes(byte ^ 0xff for byte in bytes.fromhex(self.pin)).hex()
        unverified = self.connect_noise(pin=wrong_pin)
        with self.assertRaises(ConnectionError):
            # Status contains no credential, even if this negative handshake unexpectedly succeeded.
            await asyncio.to_thread(unverified.exchange, 'status')
        self.assertEqual((await self.request('status'))['version'], 1)
        await self.request('categories', include_archived=False, error='unauthorized')
        await self.request('inbox', error='unauthorized')
        await self.request('read_thread', chat='x', error='unauthorized')
        await self.request('slash_catalog', error='unauthorized')
        await self.request('login_native', owner_token=self.bridge_token, name='Adapter authority', error='unauthorized')
        session = await self.login()
        device_header = {'Origin': ORIGIN, 'Authorization': 'Bearer ' + bytes(session['credential']).hex()}
        self.assertEqual((await self.client.post(ORIGIN+'/adapter/claim', json={}, headers=device_header)).status, 401)
        for route in ('claim', 'connect', 'update', 'push', 'final', 'admission', 'slash-catalog'):
            denied = await self.client.post(ORIGIN+'/adapter/'+route, json={}, headers=self.owner_headers)
            self.assertEqual(denied.status, 401)
        for fields in ({'Host':'localhost:8766'}, {'Origin':'http://localhost:8766'}, {'Origin':'null'}):
            denied = await self.client.post(ORIGIN+'/adapter/claim', json={}, headers=self.bridge|fields)
            self.assertEqual(denied.status, 403)
        self.assertEqual((await self.client.post(ORIGIN+'/adapter/claim?token=x', json={}, headers=self.bridge)).status, 403)
        self.assertEqual((await self.client.post(ORIGIN+'/adapter/claim', data='x', headers=self.bridge)).status, 415)
        oversized = await self.client.post(ORIGIN+'/adapter/claim', json={'fixture': 'x' * 65536}, headers=self.bridge)
        self.assertEqual(oversized.status, 413)
        report_path = ORIGIN + '/adapter/slash-catalog'
        report = {'catalog': {'commands': ['status'], 'skills': ['synthetic-skill']}}
        self.assertEqual((await self.client.post(report_path, headers=self.bridge_bearer, json=report)).status, 403)
        self.assertEqual((await self.client.post(report_path, headers=self.bridge, json=report)).status, 200)
        self.assertEqual((await self.request('slash_catalog'))['catalog'], report['catalog'])
        for path in ('/', '/app.js', '/app.css', '/api/status', '/api/login', '/api/chats', '/api/channels',
                     '/api/notifications', '/api/slash-catalog', '/api/attachments/x', '/noise'):
            denied = await self.client.get(ORIGIN+path, headers=self.bridge|{'Sec-Fetch-Site':'cross-site'})
            self.assertEqual(denied.status, 404, path)
            self.assertEqual(denied.headers['Cache-Control'], 'no-store')
            self.assertIn("frame-ancestors 'none'", denied.headers['Content-Security-Policy'])
            self.assertNotIn('Access-Control-Allow-Origin', denied.headers)
        denied = await self.client.post(ORIGIN+'/api/login', json={'token':self.token}, headers={'Origin':ORIGIN})
        self.assertEqual(denied.status, 404)
        reader, writer = await asyncio.open_connection('127.0.0.1', int(self.native.rsplit(':', 1)[1]))
        try:
            writer.write(b'GET /api/status HTTP/1.1\r\nHost: localhost\r\n\r\n')
            await writer.drain()
            writer.write_eof()
            self.assertEqual(await asyncio.wait_for(reader.read(), 5), b'')
        finally:
            writer.close()
            await writer.wait_closed()
