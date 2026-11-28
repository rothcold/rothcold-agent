"""Drive the shared v1 codec in isolated server/Gateway fixtures, never HTTP."""
import json
import subprocess


class NoiseFixture:
    def __init__(self, executable, addr, pin):
        self.process = subprocess.Popen(
            [executable, addr, pin], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            text=True, bufsize=1,
        )
        assert self.process.stdin is not None and self.process.stdout is not None
        self.commands = self.process.stdin
        self.results = self.process.stdout

    def close(self):
        self.commands.close()
        try:
            self.process.wait(3)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.results.close()

    def exchange(self, operation, **fields):
        try:
            self.commands.write(json.dumps({'type': operation, **fields}) + '\n')
            self.commands.flush()
            line = self.results.readline()
        except (BrokenPipeError, OSError) as error:
            raise ConnectionError('Noise fixture disconnected') from error
        if not line:
            raise ConnectionError('Noise fixture disconnected')
        outcome = json.loads(line)
        if outcome['type'] == 'fixture_disconnected':
            raise ConnectionError('Noise fixture disconnected')
        return outcome

    def call(self, operation, **fields):
        outcome = self.exchange(operation, **fields)
        assert outcome['type'] != 'error', outcome
        return outcome

    def pages(self, operation, **fields):
        cursor = None
        records = []
        while True:
            page = self.call(operation, after=cursor, **fields)['page']
            records.extend(page['items'])
            cursor = page['next']
            if cursor is None:
                return records

    def history(self, chat):
        turns = self.pages('history', chat=chat)
        for turn in turns:
            turn['updates'] = self.pages('turn_updates', chat=chat, turn=turn['id'])
            if not turn['attachments']:
                del turn['attachments']
        return turns

    def threads(self):
        return [{k: row[k] for k in ('id', 'title', 'channel')}
                for row in self.pages('threads', include_archived=False)]

    def start(self, message, channel='general'):
        outcome = self.call('start_thread', channel=channel, message=message)
        return outcome['fresh'], {k: outcome[k] for k in ('id', 'title', 'channel')}

    def send(self, chat, message):
        return self.call('send_turn', chat=chat, message=message)['fresh']

    def upload(self, filename, content):
        outcome = self.call('fixture_upload', purpose='turn', filename=filename, bytes=list(content))
        assert outcome['type'] == 'upload_complete'
        return outcome['attachment']
