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

# Different directory and frontmatter names verify the Gateway's slash slug, not an FS listing.
for directory, name in [('directory-is-not-a-slug', 'rothcold-smoke-skill'), ('disabled-fixture', 'rothcold-disabled-skill')]:
    folder = home / 'skills' / directory
    folder.mkdir(parents=True)
    (folder / 'SKILL.md').write_text(
        f'---\nname: {name}\ndescription: Disposable Gateway slash fixture.\n---\n\nSYNTHETIC_SLASH_SKILL_BODY\n')

with (home/'fixture.log').open('w') as f, (home/'gateway.log').open('w') as g:
    fixture=subprocess.Popen([sys.executable, os.environ['ROOT']+'/tests/fixture_model.py'], env=env, stdout=f, stderr=f)
    def start_platform():
        return subprocess.Popen([home.parent/'rothcold-agent'],env=platform_env,stdout=g,stderr=g)
    platform=start_platform()
    gate=None
    try:
        token=await_(login)
        assert request('/api/status') == (200, {'service':'rothcold-agent', 'apiVersion':1})
        assert request('/api/slash-catalog', None, token) == (200, {'catalog': None})
        channel=request('/api/channels',{'name':'Work'},token)[1]['id']
        msg={'id':str(uuid.uuid4()),'text':'Please reply with a short greeting.'}
        status, thread=request('/api/chats',dict(msg,channel=channel),token)
        assert status==202
        chat=thread['id']
        path='/api/chats/'+chat+'/turns'
        second={'id':str(uuid.uuid4()),'text':'Now repeat the greeting.'}
        assert request(path,second,token)[0]==202
        queued=[dict(m,state='queued',answer=None,updates=[]) for m in (msg,second)]
        assert request(path,None,token)[1]==queued
        platform.terminate()
        platform.wait(10)
        platform=start_platform()
        await_(lambda: request('/api/me',None,token)[0] == 200)
        assert request(path,None,token)[1]==queued
        gate=subprocess.Popen([os.environ['CORE']+'/venv/bin/hermes','gateway','run'], env=env, stdout=g, stderr=g)
        await_(lambda:'completion requested' in (home/'fixture.log').read_text())
        await_(lambda: request(path,None,token)[1][0]['state'] == 'accepted' and request(path,None,token)[1][1] == queued[1])
        assert request('/api/notifications',None,token)[1] == []
        del token
        (home/'release-fixture').touch()
        # Observe only this fixture's DB. Reattach the HTTP client after the final commit.
        db=sqlite3.connect((home.parent/'data/history.sqlite3').as_uri()+'?mode=ro', uri=True)
        try:
            await_(lambda: db.execute('SELECT 1 FROM notifications WHERE request=? AND unread=1',
                                      (msg['id'],)).fetchone())
        finally:
            db.close()
        token=login()
        expected=[dict(m,state='answered',answer='Local fixture reply.') for m in (msg,second)]
        await_(lambda: [{k:r[k] for k in ('id','text','state','answer')} for r in request(path,None,token)[1]] == expected)
        assert request('/api/chats',dict(msg,channel=channel),token)==(200,thread)
        assert request(path,msg,token)[0]==200
        assert [{k:r[k] for k in ('id','text','state','answer')} for r in request(path,None,token)[1]] == expected
        events=[{'request':m['id'],'chat':chat,'channel':channel,'unread':1} for m in (second,msg)]
        for _ in range(2):
            assert request('/api/notifications',None,token)[1] == events
        assert request('/api/chats',None,token)[1] == [{'id':chat,'title':msg['text'],'channel':channel}]
        assert request('/api/chats/'+chat+'/read',{},token)[0] == 200
        token=login()
        assert request('/api/notifications',None,token)[1] == [dict(event,unread=0) for event in events]
        catalog = await_(lambda: request('/api/slash-catalog', None, token)[1]['catalog'])
        assert set(catalog) == {'commands', 'skills'}
        assert 'sethome' in catalog['commands'] and 'quit' not in catalog['commands']
        assert 'rothcold-smoke-skill' in catalog['skills'], catalog
        assert 'rothcold-disabled-skill' not in catalog['skills']
        assert 'directory-is-not-a-slug' not in catalog['skills']
        assert 'SYNTHETIC_SLASH_SKILL_BODY' not in json.dumps(catalog)
        # Verify the catalog's /sethome works in-band without invoking the model.
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
        skill = {'id': str(uuid.uuid4()), 'text': '/rothcold-smoke-skill explicit skill invocation'}
        assert request(path, skill, token)[0] == 202
        await_(lambda: len(request(path, None, token)[1]) == 5 and request(path, None, token)[1][4]['state'] == 'answered')
        assert (home/'fixture.log').read_text().count('slash skill reached model fixture') == 1
        print('Offline restart + real Gateway: FIFO text, discovered /sethome, one attachment-only turn, and explicit invocation of a discovered synthetic skill passed. CLI-only and platform-disabled entries were absent.')
    finally:
        for p in (gate,platform,fixture):
            if p is not None and p.poll() is None:
                p.terminate()
                try:
                    p.wait(10)
                except subprocess.TimeoutExpired:
                    p.kill()
                    p.wait()
