"""Disposable loopback ingress fixtures; not a deployment proxy."""
import asyncio
import os
import re
from pathlib import Path

from aiohttp import ClientSession, ClientTimeout, DummyCookieJar, web
from multidict import CIMultiDict
from yarl import URL

API = 'http://127.0.0.1:8766'


def api_request(request):
    return request.method in ('GET', 'POST') and re.fullmatch(r'/api/[a-zA-Z0-9_/-]+', request.raw_path)


async def relay(client, request, origin, host):
    allowed = ('authorization', 'content-type', 'origin', 'sec-fetch-site', 'cookie', 'x-rothcold-server')
    headers = CIMultiDict((k, v) for k, v in request.headers.items() if k.lower() in allowed)
    headers['Host'] = host
    async with client.request(request.method, URL(origin + request.raw_path, encoded=True),
                              headers=headers, data=await request.read(), allow_redirects=False) as upstream:
        response_headers = CIMultiDict((k, v) for k, v in upstream.headers.items() if k.lower() in (
            'content-type', 'cache-control', 'content-security-policy', 'cross-origin-resource-policy',
            'referrer-policy', 'set-cookie', 'x-content-type-options'))
        return web.Response(status=upstream.status, headers=response_headers, body=await upstream.read())


async def serve_alternate_api():
    root = Path(os.environ['HERMES_HOME']).parent
    if not root.name.startswith('.test-'):
        raise RuntimeError('A disposable test home is required')
    child = await asyncio.create_subprocess_exec(root/'rothcold-agent', stdout=asyncio.subprocess.PIPE)
    try:
        assert child.stdout is not None
        assert await asyncio.wait_for(child.stdout.readline(), 5) == f'Rothcold Agent listening on {API}\n'.encode()
        async with ClientSession(timeout=ClientTimeout(total=3), cookie_jar=DummyCookieJar()) as client:
            async def route(request):
                if not api_request(request):
                    raise web.HTTPNotFound()
                return await relay(client, request, API, '127.0.0.1:8766')

            app = web.Application()
            app.router.add_route('*', '/{path:.*}', route)
            runner = web.AppRunner(app)
            await runner.setup()
            try:
                await web.UnixSite(runner, str(root/'alternate.sock')).start()
                print('Alternate test API ready', flush=True)
                await child.wait()
            finally:
                await runner.cleanup()
    finally:
        if child.returncode is None:
            child.terminate()
        await child.wait()


if __name__ == '__main__':
    asyncio.run(serve_alternate_api())
