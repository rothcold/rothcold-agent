import asyncio
import logging
from contextlib import suppress
from uuid import uuid4

from aiohttp import ClientError, ClientResponseError, ClientSession, ClientTimeout
from gateway.config import Platform
from gateway.platforms._shared import get_scoped_secret, seed_extra_from_env
from gateway.platforms.base import BasePlatformAdapter, SendResult
from gateway.platforms.event import MessageEvent

ORIGIN = 'http://127.0.0.1:8766'
log = logging.getLogger(__name__)


def ready():
    token = get_scoped_secret('ROTHCOLD_AGENT_ADAPTER_TOKEN', '') or ''
    return (32 <= len(token) <= 512 and token.isascii() and not any(c.isspace() for c in token)
            and get_scoped_secret('ROTHCOLD_AGENT_ALLOWED_USERS', '') == 'owner')


def env_enablement():
    if not ready():
        return None
    return {'local_owner': True, **seed_extra_from_env((), home_env='ROTHCOLD_AGENT_HOME_CHANNEL')}


async def standalone_send(pconfig, chat_id, message, *, thread_id=None, media_files=None,
                          force_document=False, **kwargs):
    if not ready():
        return {'error': 'Rothcold Agent adapter credentials are not configured'}
    if thread_id:
        return {'error': 'Rothcold Agent does not support nested thread_id delivery'}
    target = str(chat_id or '').strip()
    if not target or not isinstance(message, str) or not 0 < len(message) <= RothcoldAgent.MAX_MESSAGE_LENGTH:
        return {'error': 'Invalid chat_id or message length for Rothcold Agent'}
    pid = str(uuid4())
    headers = {
        'Origin': ORIGIN,
        'Authorization': 'Bearer ' + get_scoped_secret('ROTHCOLD_AGENT_ADAPTER_TOKEN'),
    }
    try:
        async with (
            ClientSession(timeout=ClientTimeout(total=5), headers=headers) as client,
            client.post(
                ORIGIN + '/adapter/push',
                json={'chat': target, 'id': pid, 'text': message},
                allow_redirects=False,
            ) as response,
        ):
            response.raise_for_status()
            await response.json()
    except (ClientError, TimeoutError) as exc:
        return {'error': f'Rothcold platform did not confirm delivery: {exc}'}
    return {'success': True, 'platform': 'rothcold_agent', 'chat_id': target, 'message_id': f'push:{pid}'}


class RothcoldAgent(BasePlatformAdapter):
    MAX_MESSAGE_LENGTH = 65536

    def __init__(self, config):
        super().__init__(config, Platform('rothcold_agent'))
        self.client = None
        self.worker = None
        self._cards = {}

    async def connect(self, *, is_reconnect=False):
        if not ready():
            return False
        self.client = ClientSession(timeout=ClientTimeout(total=5), headers={
            'Origin': ORIGIN, 'Authorization': 'Bearer ' + get_scoped_secret('ROTHCOLD_AGENT_ADAPTER_TOKEN')})
        self.worker = asyncio.create_task(self.receive())
        self._mark_connected()
        return True

    async def disconnect(self):
        if self.worker:
            self.worker.cancel()
            with suppress(asyncio.CancelledError):
                await self.worker
            self.worker = None
        if self.client:
            await self.client.close()
            self.client = None
        self._cards.clear()
        self._mark_disconnected()

    async def post(self, route, data):
        client = self.client
        if client is None:
            raise ClientError('Adapter disconnected')
        async with client.post(ORIGIN + '/adapter/' + route, json=data, allow_redirects=False) as response:
            response.raise_for_status()
            return await response.json()

    async def receive(self):
        new_connection = True
        async with asyncio.TaskGroup() as tasks:
            while True:
                try:
                    if new_connection:
                        await self.post('connect', {})
                        new_connection = False
                    cards = self._live_cards()
                    row = await self.post('claim', {'approvals': cards} if cards else {})
                    if row and 'approval' in row:
                        await self._answer_card(row)
                        continue
                    if row:
                        tasks.create_task(self.admit(row))
                        continue
                except (ClientError, TimeoutError):
                    self._cards.clear()
                    if not new_connection:
                        log.warning('Lost platform connection; pending delivery will not be replayed')
                    new_connection = True
                await asyncio.sleep(1)

    async def admit(self, row):
        chat, rid = row['chat'], row['id']
        accepted = False
        try:
            accepted = await self.dispatch(chat, rid, row['text'], row['title'])
        except Exception:
            log.exception('Hermes admission did not complete')
        try:
            await self.post('admission', {'id': rid, 'accepted': accepted is True})
        except (ClientError, TimeoutError):
            log.warning('Admission not confirmed to platform; request will not be replayed')

    async def dispatch(self, chat, rid, text, title):
        source = self.build_source(chat, chat_name=title, user_id='owner',
                                   user_name='Owner', message_id=rid)
        event = MessageEvent(text=text, source=source, message_id=rid, user_id='owner',
                             allow_gateway_control=True)
        if event.get_command() in ('approve', 'deny'):
            # Legacy or noncanonical slash input must never resolve today's prompt.
            await self.post('final', {'chat': chat, 'id': rid, 'text': 'Expired approval reply. Not sent to Hermes.'})
            return True
        # The previous final can commit just before its Hermes session guard releases.
        previous = self._session_tasks.get(self._event_session_key(event))
        if previous is not None:
            await asyncio.wait({previous})
        await self.handle_message(event)
        return getattr(event, '_gateway_accepted', False)

    async def _send_exec_approval_prompt(self, prompt):
        if not prompt.request_id or not prompt.session_key or (prompt.metadata or {}).get('thread_id'):
            return SendResult(success=False, error='Missing scoped approval request')
        key = str(uuid4())
        commands = {'once': '/approve', 'session': '/approve session', 'deny': '/deny'}
        offered = [commands[c] for c in prompt.choices if c in commands]
        text = (f'Hermes requests approval\n{prompt.description}\n\n{prompt.command}\n\n'
                f'Reply before the request expires: {", ".join(offered)}')
        if len(text) > self.MAX_MESSAGE_LENGTH:
            return SendResult(success=False, error='Approval command does not fit in full')
        result = await self._post_update(prompt.chat_id, None, key, 'progress', text)
        if result and result.success:
            self._cards[key] = prompt
        return result or SendResult(success=False, error='No active turn for approval')

    def _live_cards(self):
        from tools.approval import ack_gateway_approval
        cards = []
        for key, p in list(self._cards.items()):
            if ack_gateway_approval(p.session_key, p.request_id):
                cards.append({'id': key, 'chat': p.chat_id,
                              'choices': [c for c in p.choices if c in ('once', 'session', 'deny')]})
            else:
                self._cards.pop(key)
        return cards

    async def _answer_card(self, row):
        from tools.approval import resolve_gateway_approval_card
        key, choice = row['approval'], row['choice']
        p = self._cards.get(key)
        if not p or row['chat'] != p.chat_id or choice not in p.choices or choice not in ('once', 'session', 'deny'):
            return
        self._cards.pop(key)
        count = resolve_gateway_approval_card(p.session_key, choice, p.request_id,
                                              actor_id='owner', extra=self.config.extra)
        status = f'Hermes received your decision: {choice}.' if count else 'Approval expired or not permitted. No decision applied.'
        await self._post_update(p.chat_id, None, key, 'progress', f'{status}\n\n{p.command}')

    async def get_chat_info(self, chat_id):
        return {'name': chat_id, 'type': 'dm'}

    async def send_final_ledgered(self, event, session_key, text_content, metadata, *, reply_to,
                                  is_ephemeral_response=False):
        # Tag only the core's final-text lane, not every notify-worthy/status send.
        # Bind the bytes too: core may try sending different plain fallback text.
        rid = event.ledger_message_id or event.message_id
        meta = dict(metadata or {})
        if rid and rid == reply_to and not event.source.thread_id and not is_ephemeral_response:
            meta['_rothcold_final'] = (event.source.chat_id, rid, text_content)
        return await super().send_final_ledgered(event, session_key, text_content, meta,
                                                 reply_to=reply_to, is_ephemeral_response=is_ephemeral_response)

    async def _post_update(self, chat_id, turn_id, update_id, kind, content):
        payload = {'chat': str(chat_id), 'id': update_id, 'kind': kind, 'text': content}
        if turn_id:
            payload['turn'] = str(turn_id)
        try:
            await self.post('update', payload)
        except ClientResponseError as exc:
            if exc.status == 409:
                return None
            return SendResult(success=False, error='Rothcold platform did not confirm update')
        except (ClientError, TimeoutError):
            return SendResult(success=False, error='Rothcold platform did not confirm update')
        return SendResult(success=True, message_id=update_id)

    async def edit_message(self, chat_id, message_id, content, *, finalize=False, metadata=None):
        meta = metadata or {}
        if (self.client and message_id and not meta.get('thread_id')
                and isinstance(content, str) and 0 < len(content) <= self.MAX_MESSAGE_LENGTH):
            result = await self._post_update(chat_id, None, str(message_id), 'progress', content)
            if result is not None:
                return result
        return SendResult(success=False, error='Unsupported progress edit')

    async def on_processing_complete(self, event, outcome):
        chat = event.source.chat_id
        rid = event.ledger_message_id or event.message_id
        # If commentary dedup suppressed send_final_ledgered, commit the stashed final text here.
        streamed = getattr(event, '_streamed_final_response', None)
        if (self.client and rid and isinstance(streamed, str) and 0 < len(streamed) <= self.MAX_MESSAGE_LENGTH):
            try:
                await self.post('final', {'chat': chat, 'id': rid, 'text': streamed})
            except (ClientError, TimeoutError):
                log.warning('Rothcold platform did not confirm deduped final delivery')

    async def _post_push(self, chat_id, content):
        pid = str(uuid4())
        try:
            await self.post('push', {'chat': str(chat_id), 'id': pid, 'text': content})
        except (ClientError, TimeoutError):
            return SendResult(success=False, error='Rothcold platform did not confirm delivery')
        return SendResult(success=True, message_id=f'push:{pid}')

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        meta = metadata or {}
        if not (self.client and not meta.get('thread_id') and not meta.get('non_conversational')
                and isinstance(content, str) and 0 < len(content) <= self.MAX_MESSAGE_LENGTH):
            return SendResult(success=False, error='Unsupported or conflicting text delivery')
        if reply_to and meta.get('_rothcold_final') == (chat_id, reply_to, content):
            try:
                await self.post('final', {'chat': chat_id, 'id': reply_to, 'text': content})
            except (ClientError, TimeoutError):
                return SendResult(success=False, error='Rothcold platform did not confirm delivery')
            return SendResult(success=True, message_id=f'reply:{reply_to}')
        if not reply_to and '_rothcold_final' not in meta:
            if meta.get('notify'):
                return await self._post_push(chat_id, content)
            if meta.get('_interim_send'):
                result = await self._post_update(
                    chat_id, meta.get('reply_to_message_id'), str(uuid4()), 'commentary', content)
                return result or SendResult(success=False, error='No active turn for interim update')
            result = await self._post_update(chat_id, None, str(uuid4()), 'progress', content)
            if result is not None:
                return result
            return await self._post_push(chat_id, content)
        return SendResult(success=False, error='Unsupported or conflicting text delivery')
