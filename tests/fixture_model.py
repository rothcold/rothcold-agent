"""Manual offline Gateway check only. Not imported or started by the plugin."""
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MODEL = 'local-fixture'
ANSWER = 'Local fixture reply.'
TITLE_CASES = {
    'opener': ('麻烦想一想怎么让家里闲置的矮柜装得下更多的书，还能随手拿取。', '矮柜图书收纳'),
    'race': ('先想想把一整周的开销分成食物、出行和其他费用。', '每周预算分类'),
    'failure': ('Help me outline the causes of the dry creek.', None),
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # never log headers, URLs, or prompts

    def respond(self, data, mime='application/json'):
        body = data.encode() if isinstance(data, str) else json.dumps(data).encode()
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path != '/v1/models':
            return self.send_error(404)
        self.respond({'object':'list', 'data':[{'id':MODEL,'object':'model','owned_by':'fixture'}]})

    def do_POST(self):
        if self.path != '/v1/chat/completions':
            return self.send_error(404)
        size = int(self.headers.get('Content-Length', '0'))
        if not 0 < size <= 2_000_000:
            return self.send_error(413)
        request = json.loads(self.rfile.read(size))
        name = request.get('response_format', {}).get('json_schema', {}).get('name')
        if name == 'rothcold_thread_title':
            return self.thread_title(request)
        if name == 'session_title':
            return self.completion(json.dumps({'title': 'Hermes Session'}))
        print('completion requested', flush=True)
        if any('rothcold-attachment-fixture.txt' in str(message.get('content', ''))
               for message in request.get('messages', []) if message.get('role') == 'user'):
            print('attachment reached model fixture', flush=True)
        until = time.monotonic() + 60
        while not release.is_file():
            if time.monotonic() >= until:
                return self.send_error(503)
            time.sleep(.05)
        self.completion(ANSWER, stream=request.get('stream'))

    def thread_title(self, request):
        messages = request['messages']
        assert [m['role'] for m in messages] == ['system', 'user']
        assert 'same language as that message' in messages[0]['content']
        assert 'Japanese' not in messages[0]['content'] and not request.get('tools')
        case = next((name for name, (text, _) in TITLE_CASES.items() if text == messages[1]['content']), None)
        if case is None:
            print('unexpected title request', flush=True)
            return self.send_error(400)
        print(f'title requested {case}', flush=True)
        if case != 'failure':
            marker = release.with_name(f'release-title-{case}')
            until = time.monotonic() + 15
            while not marker.is_file():
                if time.monotonic() >= until:
                    return self.send_error(503)
                time.sleep(.05)
        title = TITLE_CASES[case][1]
        self.completion(json.dumps({'title': title}, ensure_ascii=False) if title else 'invalid JSON')
        print(f'title sent {case}', flush=True)

    def completion(self, text, *, stream=False):
        common = {'id':'fixture-1', 'model':MODEL, 'created':1}
        message = {'role':'assistant','content':text}
        if stream:
            chunks = [dict(common, object='chat.completion.chunk', choices=[dict(index=0,delta=d,finish_reason=r)])
                      for d,r in [(message,None), ({},'stop')]]
            self.respond(''.join('data: '+json.dumps(c)+'\n\n' for c in chunks)+'data: [DONE]\n\n', 'text/event-stream')
        else:
            self.respond(dict(common, object='chat.completion', choices=[dict(index=0,message=message,finish_reason='stop')],
                              usage=dict(prompt_tokens=10,completion_tokens=4,total_tokens=14)))


if __name__ == '__main__':
    release = Path(os.environ['HERMES_HOME']) / 'release-fixture'
    ThreadingHTTPServer(('127.0.0.1', 8767), Handler).serve_forever()
