import asyncio
import os
import secrets
import sqlite3
import sys
import unittest
from pathlib import Path
from uuid import uuid4

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
from aiohttp import ClientSession  # noqa: E402
from gateway.config import PlatformConfig  # noqa: E402
from gateway.platform_registry import platform_registry  # noqa: E402
from hermes_cli.plugins import PluginManager  # noqa: E402

ORIGIN = 'http://127.0.0.1:8766'
BROWSER_TMP = str(Path('/proc') / str(os.getpid()) / 'cwd' / PROFILE.parent.name / 'tmp')


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
        data_dir = PROFILE.parent/self._testMethodName
        if self._testMethodName == 'test_existing_python_workspace':
            data_dir.mkdir()
            with sqlite3.connect(data_dir/'history.sqlite3') as db:
                db.executescript((ROOT/'tests/python-v2.sql').read_text())
            db.close()
        proc = await asyncio.create_subprocess_exec(PROFILE.parent/'rothcold-agent', stdout=asyncio.subprocess.PIPE,
                env=dict(os.environ, ROTHCOLD_DATA_DIR=str(data_dir)))
        async def stop():
            if proc.returncode is None:
                proc.terminate()
            await proc.wait()
        self.addAsyncCleanup(stop)
        assert proc.stdout is not None
        self.assertEqual(await asyncio.wait_for(proc.stdout.readline(), 5),
                         f'Rothcold Agent listening on {ORIGIN}\n'.encode())
        entry = platform_registry.get('rothcold_agent')
        assert entry is not None and entry.check_fn()
        adapter = platform_registry.create_adapter('rothcold_agent', PlatformConfig(enabled=True))
        assert adapter is not None
        self.adapter = adapter
        self.assertTrue(await self.adapter.connect())
        self.addAsyncCleanup(self.adapter.disconnect)
        self.client = ClientSession()
        self.addAsyncCleanup(self.client.close)
        self.auth = {'Origin': ORIGIN}

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
    async def test_browser(self):
        release, calls = asyncio.Event(), []

        async def reply(event):
            calls.append(event.message_id)
            chat = event.source.chat_id
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
        p = await asyncio.create_subprocess_exec(os.environ['NODE'], str(ROOT/'tests/browser.cjs'),
                                                 stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                                 env=dict(os.environ, TMPDIR=BROWSER_TMP))
        try:
            assert p.stdout is not None and p.stdin is not None
            self.assertEqual(await asyncio.wait_for(p.stdout.readline(), 45), b'closed\n')
            release.set()
            await asyncio.wait_for(asyncio.gather(*self.adapter._background_tasks), 5)
            p.stdin.write(b'final\n')
            await p.stdin.drain()
            p.stdin.close()
            self.assertEqual(await asyncio.wait_for(p.wait(), 45), 0)
            self.assertEqual(len(calls), 1)
        finally:
            release.set()
            if p.returncode is None:
                p.kill()
                await p.wait()

    @unittest.skipUnless(os.environ.get('PLAYWRIGHT_DIR'), 'No local Playwright + Chromium')
    async def test_browser_offline(self):
        await self.adapter.disconnect()
        p = await asyncio.create_subprocess_exec(os.environ['NODE'], str(ROOT/'tests/browser.cjs'), '--offline',
                env=dict(os.environ, TMPDIR=BROWSER_TMP))
        try:
            self.assertEqual(await asyncio.wait_for(p.wait(), 45), 0)
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
        self.assertEqual((await self.client.post(ORIGIN + path, json=data, headers=self.bridge)).status, 401)
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

    async def test_login_rotation_and_rate_limit(self):
        await self.login()
        old = dict(self.auth)
        await self.login()
        self.assertEqual((await self.client.get(ORIGIN+'/api/chats',headers=old)).status,401)
        for _ in range(8):
            self.assertEqual((await self.post('/api/login',{'token':'wrong'})).status,401)
        self.assertEqual((await self.post('/api/login',{'token':self.token})).status,429)
        self.assertEqual((await self.client.get(ORIGIN+'/api/chats',headers=self.bridge)).status,401)

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

    async def test_boundary(self):
        for path in ('/api/channels', '/api/notifications'):
            self.assertEqual((await self.client.get(ORIGIN+path)).status,401)
        self.assertEqual((await self.post('/api/chats/x/read', {})).status,401)
        url = ORIGIN+'/api/chats'
        self.assertEqual((await self.client.get(url)).status,401)
        self.assertEqual((await self.client.post(ORIGIN+'/api/login',json={'token':self.token})).status,403)
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
        self.assertIn("frame-ancestors 'none'",r.headers['Content-Security-Policy'])
        self.assertNotIn('Access-Control-Allow-Origin',r.headers)
