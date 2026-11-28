import json
import os
import pathlib
import secrets
import socket
import sqlite3
import subprocess
import sys
import time
import uuid
from contextlib import closing

from fixture_model import TITLE_CASES
from hermes_yaml import safe_dump, safe_load  # pyright: ignore[reportMissingImports]
from noise_fixture import NoiseFixture

home = pathlib.Path(os.environ.get('HERMES_HOME', '/')).resolve()
if (home.name != 'profile' or home.parent.parent != pathlib.Path('/tmp')  # noqa: S108 - fixed namespace mount in script/test-gateway
        or not home.parent.name.startswith('hermes-rothcold-agent-gateway.')
        or pathlib.Path(os.environ.get('HOME', '/')).resolve() != home.parent / 'home'):
    raise RuntimeError('Use script/test-gateway; refusing to run outside the disposable profile.')
if {name for _, name in socket.if_nameindex()} != {'lo'}:
    raise RuntimeError('A loopback-only network namespace is required.')
bridge = secrets.token_urlsafe(40)
owner = secrets.token_urlsafe(40)
env=dict(os.environ, ROTHCOLD_AGENT_ADAPTER_TOKEN=bridge, ROTHCOLD_AGENT_ALLOWED_USERS='owner', CUSTOM_API_KEY=secrets.token_urlsafe(20))
platform_env = {'PATH':'/usr/bin:/bin', 'HOME':str(home.parent/'home'),
                'ROTHCOLD_DATA_DIR':str(home.parent/'data'), 'ROTHCOLD_AGENT_OWNER_TOKEN':owner,
                'ROTHCOLD_AGENT_ADAPTER_TOKEN':bridge}
def await_(f, n=45):
    end=time.monotonic()+n
    while time.monotonic()<end:
        try:
            a=f()
            if a:
                return a
        except ConnectionError:
            pass
        time.sleep(.15)
    raise TimeoutError(f'Wait timed out: {f.__name__}')
addr = '127.0.0.1:8768'
pin = subprocess.check_output([home.parent / 'rothcold-agent', 'noise-pin'], env=platform_env, text=True).strip()


def connect(credential=None):
    client = NoiseFixture(home.parent / 'noise-fixture', addr, pin)
    try:
        if credential is None:
            session = client.call('login_native', owner_token=owner, name='Gateway fixture')
            assert session['pin'] == list(bytes.fromhex(pin))
            return client, session['credential']
        assert client.call('resume_native', pin=list(bytes.fromhex(pin)), credential=credential)['type'] == 'device'
        return client, credential
    except BaseException:
        client.close()
        raise

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
    active = None
    try:
        client, credential = await_(connect)
        active = client
        assert client.call('status') == {'type':'status', 'service':'rothcold-agent', 'version':1}
        assert client.call('slash_catalog')['catalog'] is None
        channel = client.call('create_category', name='Work')['id']
        msg={'id':str(uuid.uuid4()),'text':TITLE_CASES['opener'][0]}
        fresh, thread = client.start(msg, channel)
        assert fresh and thread['title'] == msg['text']
        chat=thread['id']
        second={'id':str(uuid.uuid4()),'text':'Can I also use boxes?'}
        assert client.send(chat, second)
        queued=[dict(m,state='queued',answer=None,updates=[]) for m in (msg,second)]
        assert client.history(chat)==queued
        client.close()
        active = None
        platform.terminate()
        platform.wait(10)
        platform=start_platform()
        client, _ = await_(lambda: connect(credential))
        active = client
        assert client.call('me')['type'] == 'device'
        assert client.history(chat)==queued
        gate=subprocess.Popen([os.environ['CORE']+'/venv/bin/hermes','gateway','run'], env=env, stdout=g, stderr=g)
        fixture_log = home/'fixture.log'
        await_(lambda:'completion requested' in fixture_log.read_text())
        await_(lambda:'title requested opener' in fixture_log.read_text())
        await_(lambda: client.history(chat)[0]['state'] == 'accepted' and client.history(chat)[1] == queued[1])
        assert client.pages('inbox') == []
        client.close()
        active = None
        (home/'release-fixture').touch()
        # Observe only this fixture's DB. Reattach the Noise client after the final commit.
        db_uri = (home.parent/'data/history.sqlite3').as_uri()+'?mode=ro'
        with closing(sqlite3.connect(db_uri, uri=True)) as db:
            await_(lambda: db.execute('SELECT 1 FROM notifications WHERE request=? AND unread=1',
                                      (msg['id'],)).fetchone())
        client, _ = connect(credential)
        active = client
        expected=[dict(m,state='answered',answer='Local fixture reply.') for m in (msg,second)]
        await_(lambda: [{k:r[k] for k in ('id','text','state','answer')} for r in client.history(chat)] == expected)
        assert client.start(msg, channel) == (False, thread)
        assert not client.send(chat, msg)
        assert [{k:r[k] for k in ('id','text','state','answer')} for r in client.history(chat)] == expected
        events=[{'request':m['id'],'chat':chat,'channel':channel,'unread':1,
                 'title':msg['text'],'preview':'Local fixture reply.'} for m in (second,msg)]
        for _ in range(2):
            assert client.pages('inbox') == events
        assert client.threads() == [{'id':chat,'title':msg['text'],'channel':channel}]
        # Both FIFO turns finished while the independent semantic title request was still held.
        (home/'release-title-opener').touch()
        named = dict(thread, title=TITLE_CASES['opener'][1])
        await_(lambda: client.threads() == [named])
        assert client.history(chat)[0]['text'] == msg['text']
        events = [dict(event, title=named['title']) for event in events]
        assert client.pages('inbox') == events
        assert client.call('read_thread', chat=chat)['type'] == 'ok'
        client.close()
        active = None
        client, _ = connect(credential)
        active = client
        assert client.pages('inbox') == [dict(event,unread=0) for event in events]
        catalog = await_(lambda: client.call('slash_catalog')['catalog'])
        assert set(catalog) == {'commands', 'skills'}
        assert 'sethome' in catalog['commands'] and 'quit' not in catalog['commands']
        assert 'rothcold-smoke-skill' in catalog['skills'], catalog
        assert 'rothcold-disabled-skill' not in catalog['skills']
        assert 'directory-is-not-a-slug' not in catalog['skills']
        assert 'SYNTHETIC_SLASH_SKILL_BODY' not in json.dumps(catalog)
        # Verify the catalog's /sethome works in-band without invoking the model.
        sethome={'id':str(uuid.uuid4()),'text':'/sethome'}
        assert client.send(chat, sethome)
        await_(lambda: len(client.history(chat))==3 and client.history(chat)[2]['state']=='answered')
        assert chat in (home/'config.yaml').read_text()
        assert (home/'fixture.log').read_text().count('completion requested') == 2

        filename = 'rothcold-attachment-fixture.txt'
        content = b'Disposable Gateway attachment fixture.\n'
        item = client.upload(filename, content)
        assert item['filename'] == filename and item['kind'] == 'file'
        attachment_turn = {'id': str(uuid.uuid4()), 'text': '', 'attachments': [item['id']]}
        assert client.send(chat, attachment_turn)

        def attachment_final():
            turns = client.history(chat)
            return next((turn for turn in turns if turn['id'] == attachment_turn['id']
                         and turn['state'] == 'answered'), None)

        final = await_(attachment_final)
        assert final['answer'] == 'Local fixture reply.' and final['text'] == '' and final['attachments'] == [item]
        assert client.pages('inbox')[0]['request'] == attachment_turn['id']
        time.sleep(.5)  # Allow another poll; the already-final turn must not run again.
        log = (home/'fixture.log').read_text()
        assert log.count('completion requested') == 3, log
        assert log.count('attachment reached model fixture') == 1, log
        skill = {'id': str(uuid.uuid4()), 'text': '/rothcold-smoke-skill explicit skill invocation'}
        assert client.send(chat, skill)
        await_(lambda: len(client.history(chat)) == 5 and client.history(chat)[4]['state'] == 'answered')
        assert (home/'fixture.log').read_text().count('slash skill reached model fixture') == 1
        print('Offline restart + real Gateway: FIFO text, discovered /sethome, one attachment-only turn, and explicit invocation of a discovered synthetic skill passed. CLI-only and platform-disabled entries were absent.')

        def start_thread(text, **extra):
            fresh, thread = client.start({'id': str(uuid.uuid4()), 'text': text, **extra})
            assert fresh
            return thread

        def title(chat_id):
            return next(row['title'] for row in client.threads() if row['id'] == chat_id)

        def title_job_finished(chat_id):
            with closing(sqlite3.connect(db_uri, uri=True)) as db:
                return db.execute('SELECT 1 FROM thread_title_jobs WHERE chat=?', (chat_id,)).fetchone() is None

        attachment = client.upload(filename, content)
        attached = start_thread('', attachments=[attachment['id']])
        assert attached['title'] == filename and title_job_finished(attached['id'])
        await_(lambda: client.history(attached['id'])[0]['state'] == 'answered')
        assert title(attached['id']) == filename

        race = start_thread(TITLE_CASES['race'][0])
        await_(lambda: 'title requested race' in fixture_log.read_text())
        manual = {'title': race['title']}
        assert client.call('rename_thread', id=race['id'], **manual) == {'type': 'thread_renamed', **manual}
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
        if active is not None:
            active.close()
        for p in (gate,platform,fixture):
            if p is not None and p.poll() is None:
                p.terminate()
                try:
                    p.wait(10)
                except subprocess.TimeoutExpired:
                    p.kill()
                    p.wait()
