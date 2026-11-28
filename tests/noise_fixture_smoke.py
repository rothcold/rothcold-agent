"""Run the Gateway's typed fixture driver against the release binary without Hermes."""
import os
import secrets
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

from noise_fixture import NoiseFixture


def smoke(binary, driver):
    with TemporaryDirectory(prefix='rothcold-noise-fixture-') as scratch:
        env = {'ROTHCOLD_DATA_DIR': str(Path(scratch) / 'workspace'),
               'ROTHCOLD_NOISE_NATIVE_BIND': '127.0.0.1:0',
               'ROTHCOLD_AGENT_OWNER_TOKEN': secrets.token_hex(32),
               'ROTHCOLD_AGENT_ADAPTER_TOKEN': secrets.token_hex(32)}
        pin = subprocess.check_output([binary, 'noise-pin'], env=env, text=True, timeout=5).strip()
        with subprocess.Popen([binary], env=env, stdout=subprocess.PIPE, text=True) as server:
            try:
                assert server.stdout is not None
                # The normal process reports its actual OS-assigned native address, not the identity.
                adapter_line = server.stdout.readline().strip()
                native_line = server.stdout.readline().strip()
                assert adapter_line == 'Rothcold Agent adapter listening on http://127.0.0.1:8766'
                addr = native_line.removeprefix('Rothcold Agent native Noise listening on ')
                assert addr.startswith('127.0.0.1:')
                client = NoiseFixture(driver, addr, pin)
                try:
                    session = client.call('login_native', owner_token=env['ROTHCOLD_AGENT_OWNER_TOKEN'],
                                          name='Disposable Gateway-driver smoke')
                    assert session['type'] == 'native_login'
                    assert session['pin'] == list(bytes.fromhex(pin))
                    def file_step(op, **fields):
                        return client.call('fixture_file_step', request={'type': op, **fields})

                    assert file_step('upload', purpose='turn', filename='cancel.txt', size=1)['type'] == 'upload_ready'
                    assert file_step('upload_cancel')['type'] == 'upload_cancelled'
                    too_large = client.exchange('fixture_file_step', request={
                        'type': 'upload', 'purpose': 'avatar', 'filename': 'big.png', 'size': 5*1024*1024+1,
                    })
                    assert (too_large['type'], too_large['code']) == ('error', 'limit')
                    assert client.call('fixture_oversized_control')['rejected']
                    payload = bytes(i % 251 for i in range(65_539))
                    item = client.upload('fixture.txt', payload)
                    assert file_step('download', id=item['id'])['attachment'] == item
                    chunks = [file_step('download_next') for _ in range(3)]
                    assert [c['sequence'] for c in chunks] == [0, 1, 2]
                    assert b''.join(bytes(c['bytes']) for c in chunks) == payload
                    assert file_step('download_next')['type'] == 'download_complete'
                    opener = {'id': str(uuid4()), 'text': '', 'attachments': [item['id']]}
                    fresh, thread = client.start(opener)
                    assert fresh
                    assert client.start(opener) == (False, thread)
                    assert client.threads() == [thread]
                    turns = client.history(thread['id'])
                    assert turns == [dict(opener, state='queued', answer=None, updates=[], attachments=[item])]
                finally:
                    client.close()
            finally:
                if server.poll() is None:
                    server.terminate()
                try:
                    server.wait(5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()


if __name__ == '__main__':
    assert len(sys.argv) == 3, 'supply the release binary and typed fixture driver paths'
    smoke(*map(os.path.abspath, sys.argv[1:]))
    print('Release fixture driver: Noise login, file cancellation, byte equality, bounds, queue and history passed.')
