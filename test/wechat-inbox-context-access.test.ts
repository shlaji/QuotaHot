import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { Hono } from 'hono';
import { HttpResponse, type request } from '../src/server/http.js';
import { WechatSessionStore } from '../src/server/wechat-session-store.js';
import { IlinkBotClient } from '../src/server/wechat-inbox/client.js';
import { WechatInboxStore } from '../src/server/wechat-inbox/store.js';
import { WechatInboxService } from '../src/server/wechat-inbox/service.js';
import { InboxSendError, WechatInboxSender } from '../src/server/wechat-inbox/sender.js';
import { WechatInboxTyping } from '../src/server/wechat-inbox/typing.js';
import { wechatInboxRoutes } from '../src/server/wechat-inbox/routes.js';
import { assertContractResponse } from './helpers/wechat-inbox-contract.js';
import { input } from './helpers/wechat-inbox-store.js';

function setup(context: TestContext) {
  const sessions = new WechatSessionStore(':memory:');
  const store = new WechatInboxStore(':memory:');
  context.after(() => { sessions.close(); store.close(); });
  const calls: string[] = [];
  const transport: typeof request = async (url) => {
    calls.push(url);
    return new HttpResponse(200, new Headers(), Readable.from([
      JSON.stringify({ ret: 0, typing_ticket: 'synthetic-ticket' }),
    ]));
  };
  const options = { getPollState: () => 'polling' as const,
    createClient: (binding: ConstructorParameters<typeof IlinkBotClient>[0]) => new IlinkBotClient(binding, transport) };
  const service = new WechatInboxService(sessions, store, options);
  for (const owner of ['owner', 'other']) {
    sessions.saveBinding({ ownerIlinkUserId: owner, botId: 'bot', botToken: 'synthetic-token', baseUrl: 'https://api.test' }, 0);
    service.activateBinding(owner);
  }
  const sender = new WechatInboxSender(sessions, store, options);
  const typing = new WechatInboxTyping(sessions, store, options);
  const app = new Hono().route('/api/wechat-inbox', wechatInboxRoutes({ service, sender, typing }));
  return { store, service, sender, typing, app, calls };
}

test('allows text and typing after matching owner inbound context without a global gate', async (context) => {
  const { service, sender, typing, calls } = setup(context);
  await service.processUpdates('owner', { kind: 'updates', get_updates_buf: 'next', msgs: [{ kind: 'message', message: {
    message_id: 'first', message_type: 1, direction: 'inbound', from_user_id: 'owner', context_token: 'synthetic-context',
    item_list: [{ kind: 'item', item: { type: 1, text_item: { text: 'saved history' } } }],
  } }] });

  assert.equal((await sender.send({ owner: 'owner', kind: 'text', text: 'reply' })).state, 'accepted');
  assert.deepEqual(await typing.send({ owner: 'owner', status: 1 }), { ok: true, errorCode: null });
  assert.equal(calls.length, 3);
  assert.equal(service.listBindings().find((binding) => binding.ownerIlinkUserId === 'owner')?.replyContextState, 'ready');
  assert.equal(service.listBindings().find((binding) => binding.ownerIlinkUserId === 'other')?.replyContextState, 'waiting_for_inbound');
});

for (const contextToken of [undefined, '', ' \t\n']) {
  for (const action of ['text', 'image', 'file', 'video', 'typing', 'cancel'] as const) {
    test(`rejects direct ${action} without effects for owner context ${JSON.stringify(contextToken)}`, async (context) => {
      const { store, sender, typing, calls } = setup(context);
      store.saveBatch('other', { nextCursor: '', messages: [{ ...input('other'), contextToken: 'other-context' }] });
      store.saveBatch('owner', { nextCursor: '', messages: [{ ...input('history'), contextToken }] });
      const save = context.mock.method(store, 'saveBatch');
      let consumed = false;
      const source = (async function* () { consumed = true; yield Buffer.from('media'); })();

      const operation = action === 'typing' || action === 'cancel'
        ? typing.send({ owner: 'owner', status: action === 'typing' ? 1 : 2 })
        : sender.send(action === 'text' ? { owner: 'owner', kind: 'text', text: 'must wait' }
          : { owner: 'owner', kind: action, source, fileName: 'test.bin', mediaType: 'application/octet-stream' });

      await assert.rejects(operation, new InboxSendError('context_required'));
      assert.deepEqual(calls, []);
      assert.equal(consumed, false);
      assert.equal(save.mock.callCount(), 0);
    });
  }
}

for (const action of ['messages', 'typing'] as const) {
  for (const staleSummary of [false, true]) {
    test(`returns context-required before ${action} effects with stale summary=${staleSummary}`, async (context) => {
      const { store, service, sender, typing, app, calls } = setup(context);
      store.saveBatch('owner', { nextCursor: '', messages: [{ ...input('history'), contextToken: 'old-context' }] });
      const summaries = service.listBindings();
      context.mock.method(store, 'getLatestContextToken', () => null);
      if (staleSummary) context.mock.method(service, 'listBindings', () => summaries);
      const send = context.mock.method(sender, 'send');
      const type = context.mock.method(typing, 'send');
      const save = context.mock.method(store, 'saveBatch');

      const response = await app.request(`/api/wechat-inbox/bindings/owner/${action}`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: staleSummary
          ? JSON.stringify(action === 'messages' ? { kind: 'text', text: 'must wait' } : { status: 'typing' }) : '{' });

      assert.equal(response.status, 409);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.clone().json(), { error: 'wechat_inbox_context_required' });
      await assertContractResponse(response, ['POST', `/bindings/{bindingId}/${action}`]);
      assert.equal(send.mock.callCount(), staleSummary && action === 'messages' ? 1 : 0);
      assert.equal(type.mock.callCount(), staleSummary && action === 'typing' ? 1 : 0);
      assert.equal(save.mock.callCount(), 0);
      assert.deepEqual(calls, []);
    });
  }
}

test('rejects missing context before parsing malformed multipart or dispatching media', async (context) => {
  const { store, sender, app, calls } = setup(context);
  const send = context.mock.method(sender, 'send');
  const save = context.mock.method(store, 'saveBatch');

  const response = await app.request('/api/wechat-inbox/bindings/owner/messages', {
    method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=missing' }, body: 'invalid multipart',
  });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'wechat_inbox_context_required' });
  assert.equal(send.mock.callCount(), 0);
  assert.equal(save.mock.callCount(), 0);
  assert.deepEqual(calls, []);
});

test('keeps history readable without a reply context', async (context) => {
  const { store, app } = setup(context);
  store.saveBatch('owner', { nextCursor: '', messages: [input('history')] });

  const response = await app.request('/api/wechat-inbox/bindings/owner/messages');

  assert.equal(response.status, 200);
  await assertContractResponse(response.clone(), ['GET', '/bindings/{bindingId}/messages']);
  assert.equal((await response.json()).items.length, 1);
});
