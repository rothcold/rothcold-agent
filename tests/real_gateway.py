import json
import os
import pathlib
import secrets
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from contextlib import closing

from fixture_model import TITLE_CASES
from hermes_yaml import safe_dump, safe_load

home = pathlib.Path(os.environ.get('HERMES_HOME', '/')).resolve()
if (home.name != 'profile' or home.parent.parent != pathlib.Path('/tmp')  # noqa: S108 - fixed namespace mount in script/test-gateway
        or not home.parent.name.startswith('hermes-rothcold-agent-gateway.')
        or pathlib.Path(os.environ.get('HOME', '/')).resolve() != home.parent / 'home'):
    raise RuntimeError('Use script/test-gateway; refusing to run outside the disposable profile.')
if {name for _, name in socket.if_nameindex()} != {'lo'}:
    raise RuntimeError('A loopback-only network namespace is required.')
base='http://127.0.0.1:8766'
bridge = secrets.token_urlsafe(40)
owner = secrets.token_urlsafe(40)
env=dict(os.environ, ROTHCOLD_AGENT_ADAPTER_TOKEN=bridge, ROTHCOLD_AGENT_ALLOWED_USERS='owner', CUSTOM_API_KEY=secrets.token_urlsafe(20))
platform_env = {'PATH':'/usr/bin:/bin', 'HOME':str(home.parent/'home'),
                'ROTHCOLD_DATA_DIR':str(home.parent/'data'), 'ROTHCOLD_AGENT_OWNER_TOKEN':owner,
                'ROTHCOLD_AGENT_ADAPTER_TOKEN':bridge}
def request(path, data=None, token=None, *, filename=None):
    headers = {}
    if token:
        headers['Authorization'] = 'Bearer '+token
    if filename is not None:
        headers.update({'Content-Type': 'text/plain', 'X-Rothcold-Filename': filename})
    elif data is not None:
        headers['Content-Type']='application/json'
        data = json.dumps(data).encode()
    req = urllib.request.Request(base+path, headers=headers, data=data)  # noqa: S310 - fixed loopback HTTP origin
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=3) as res:
        return res.status,json.load(res)
def await_(f, n=45):
    end=time.monotonic()+n
    while time.monotonic()<end:
        try:
            a=f()
            if a:
                return a
        except (ConnectionError,urllib.error.URLError):
            pass
        time.sleep(.15)
    raise TimeoutError(f'Wait timed out: {f.__name__}')
def login():
    return request('/api/login', {'token':owner})[1]['session']
with (home/'fixture.log').open('w') as f, (home/'gateway.log').open('w') as g:
    fixture=subprocess.Popen([sys.executable, os.environ['ROOT']+'/tests/fixture_model.py'], env=env, stdout=f, stderr=f)
    def start_platform():
        return subprocess.Popen([home.parent/'rothcold-agent'],env=platform_env,stdout=g,stderr=g)
    platform=start_platform()
    gate=None
    try:
        token=await_(login)
        assert request('/api/status') == (200, {'service':'rothcold-agent', 'apiVersion':1})
        channel=request('/api/channels',{'name':'Work'},token)[1]['id']
        msg={'id':str(uuid.uuid4()),'text':TITLE_CASES['opener'][0]}
        status, thread=request('/api/chats',dict(msg,channel=channel),token)
        assert status == 202 and thread['title'] == msg['text']
        chat=thread['id']
        path='/api/chats/'+chat+'/turns'
        second={'id':str(uuid.uuid4()),'text':'Can I also use boxes?'}
        assert request(path,second,token)[0]==202
        queued=[dict(m,state='queued',answer=None,updates=[]) for m in (msg,second)]
        assert request(path,None,token)[1]==queued
        platform.terminate()
        platform.wait(10)
        platform=start_platform()
        await_(lambda: request('/api/me',None,token)[0] == 200)
        assert request(path,None,token)[1]==queued
        gate=subprocess.Popen([os.environ['CORE']+'/venv/bin/hermes','gateway','run'], env=env, stdout=g, stderr=g)
        fixture_log = home/'fixture.log'
        await_(lambda:'completion requested' in fixture_log.read_text())
        await_(lambda:'title requested opener' in fixture_log.read_text())
        await_(lambda: request(path,None,token)[1][0]['state'] == 'accepted' and request(path,None,token)[1][1] == queued[1])
        assert request('/api/notifications',None,token)[1] == []
        del token
        (home/'release-fixture').touch()
        # Observe only this fixture's DB. Reattach the HTTP client after the final commit.
        db_uri = (home.parent/'data/history.sqlite3').as_uri()+'?mode=ro'
        with closing(sqlite3.connect(db_uri, uri=True)) as db:
            await_(lambda: db.execute('SELECT 1 FROM notifications WHERE request=? AND unread=1',
                                      (msg['id'],)).fetchone())
        token=login()
        expected=[dict(m,state='answered',answer='Local fixture reply.') for m in (msg,second)]
        await_(lambda: [{k:r[k] for k in ('id','text','state','answer')} for r in request(path,None,token)[1]] == expected)
        assert request('/api/chats',dict(msg,channel=channel),token)==(200,thread)
        assert request(path,msg,token)[0]==200
        assert [{k:r[k] for k in ('id','text','state','answer')} for r in request(path,None,token)[1]] == expected
        events=[{'request':m['id'],'chat':chat,'channel':channel,'unread':1,
                 'title':msg['text'],'preview':'Local fixture reply.'} for m in (second,msg)]
        for _ in range(2):
            assert request('/api/notifications',None,token)[1] == events
        assert request('/api/chats',None,token)[1] == [{'id':chat,'title':msg['text'],'channel':channel}]
        # Both FIFO turns finished while the independent semantic title request was still held.
        (home/'release-title-opener').touch()
        named = dict(thread, title=TITLE_CASES['opener'][1])
        await_(lambda: request('/api/chats',None,token)[1] == [named])
        assert request(path,None,token)[1][0]['text'] == msg['text']
        events = [dict(event, title=named['title']) for event in events]
        assert request('/api/notifications',None,token)[1] == events
        assert request('/api/chats/'+chat+'/read',{},token)[0] == 200
        token=login()
        assert request('/api/notifications',None,token)[1] == [dict(event,unread=0) for event in events]
        # Verify /sethome slash command works in-band without invoking the model.
        sethome={'id':str(uuid.uuid4()),'text':'/sethome'}
        assert request(path,sethome,token)[0]==202
        await_(lambda: len(request(path,None,token)[1])==3 and request(path,None,token)[1][2]['state']=='answered')
        assert chat in (home/'config.yaml').read_text()
        assert (home/'fixture.log').read_text().count('completion requested') == 2

        filename = 'rothcold-attachment-fixture.txt'
        content = b'Disposable Gateway attachment fixture.\n'
        status, item = request('/api/attachments', content, token, filename=filename)
        assert status == 201 and item['filename'] == filename and item['kind'] == 'file'
        attachment_turn = {'id': str(uuid.uuid4()), 'text': '', 'attachments': [item['id']]}
        assert request(path, attachment_turn, token)[0] == 202

        def attachment_final():
            turns = request(path, None, token)[1]
            return next((turn for turn in turns if turn['id'] == attachment_turn['id']
                         and turn['state'] == 'answered'), None)

        final = await_(attachment_final)
        assert final['answer'] == 'Local fixture reply.' and final['text'] == '' and final['attachments'] == [item]
        assert request('/api/notifications', None, token)[1][0]['request'] == attachment_turn['id']
        time.sleep(.5)  # Allow another poll; the already-final turn must not run again.
        log = (home/'fixture.log').read_text()
        assert log.count('completion requested') == 3, log
        assert log.count('attachment reached model fixture') == 1, log
        print('Offline restart + real Gateway: two FIFO text turns, /sethome without inference, and one attachment-only turn reached the model and completed.')

        def start_thread(text, **extra):
            status, thread = request('/api/chats', {'id': str(uuid.uuid4()), 'text': text, **extra}, token)
            assert status == 202
            return thread

        def title(chat_id):
            return next(row['title'] for row in request('/api/chats', None, token)[1] if row['id'] == chat_id)

        def title_job_finished(chat_id):
            with closing(sqlite3.connect(db_uri, uri=True)) as db:
                return db.execute('SELECT 1 FROM thread_title_jobs WHERE chat=?', (chat_id,)).fetchone() is None

        attachment = request('/api/attachments', content, token, filename=filename)[1]
        attached = start_thread('', attachments=[attachment['id']])
        assert attached['title'] == filename and title_job_finished(attached['id'])
        await_(lambda: request(f"/api/chats/{attached['id']}/turns", None, token)[1][0]['state'] == 'answered')
        assert title(attached['id']) == filename

        race = start_thread(TITLE_CASES['race'][0])
        await_(lambda: 'title requested race' in fixture_log.read_text())
        manual = {'title': race['title']}
        assert request(f"/api/chats/{race['id']}/rename", manual, token) == (200, manual)
        (home/'release-title-race').touch()
        await_(lambda: 'title sent race' in fixture_log.read_text())
        rejected = start_thread(TITLE_CASES['failure'][0])
        await_(lambda: 'title sent failure' in fixture_log.read_text())
        await_(lambda: title_job_finished(rejected['id']))
        assert title(race['id']) == race['title']
        assert title(rejected['id']) == rejected['title']

        config = home/'config.yaml'

        def set_title_switches(**switches):
            current = safe_load(config.read_text())
            titles = current['auxiliary']['title_generation']
            assert titles['language'] == 'Japanese'
            titles.update(switches)
            config.write_text(safe_dump(current))

        set_title_switches(enabled=False)
        disabled = start_thread('This prompt must not reach the title model.')
        await_(lambda: title_job_finished(disabled['id']))
        assert title(disabled['id']) == disabled['title']
        set_title_switches(enabled=True, model_upgrade_enabled=False)
        no_upgrade = start_thread('This title upgrade must also be skipped.')
        await_(lambda: title_job_finished(no_upgrade['id']))
        assert title(no_upgrade['id']) == no_upgrade['title']
        title_requests = [line for line in fixture_log.read_text().splitlines() if 'title request' in line]
        assert title_requests == ['title requested opener', 'title requested race', 'title requested failure'], title_requests
        print('Real Gateway titles: first Chinese opener alone produced 矮柜图书收纳 (Hermes language set to Japanese); FIFO completed while the title was held. Failure, filename-only, same-fallback manual rename, and both disable flags preserved the fallback.')
    finally:
        for p in (gate,platform,fixture):
            if p is not None and p.poll() is None:
                p.terminate()
                try:
                    p.wait(10)
                except subprocess.TimeoutExpired:
                    p.kill()
                    p.wait()
