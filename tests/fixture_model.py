"""Manual offline Gateway check only. Not imported or started by the plugin."""
import json
import os
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

MODEL = 'local-fixture'
ANSWER = 'Local fixture reply.'


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
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
        print('completion requested', flush=True)
        until = time.monotonic() + 60
        while not release.is_file():
            if time.monotonic() >= until:
                return self.send_error(503)
            time.sleep(.05)
        common = {'id':'fixture-1', 'model':MODEL, 'created':1}
        message = {'role':'assistant','content':ANSWER}
        if request.get('stream'):
            chunks = [dict(common, object='chat.completion.chunk', choices=[dict(index=0,delta=d,finish_reason=r)])
                      for d,r in [(message,None), ({},'stop')]]
            self.respond(''.join('data: '+json.dumps(c)+'\n\n' for c in chunks)+'data: [DONE]\n\n', 'text/event-stream')
        else:
            self.respond(dict(common, object='chat.completion', choices=[dict(index=0,message=message,finish_reason='stop')],
                              usage=dict(prompt_tokens=10,completion_tokens=4,total_tokens=14)))


if __name__ == '__main__':
    release = Path(os.environ['HERMES_HOME']) / 'release-fixture'
    HTTPServer(('127.0.0.1', 8767), Handler).serve_forever()
