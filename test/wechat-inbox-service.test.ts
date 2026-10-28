import assert from 'node:assert/strict';
import { mock, test, type TestContext } from 'node:test';
import { WechatSessionStore } from '../src/server/wechat-session-store.js';
import { WechatInboxStore, type InboxMessageInput } from '../src/server/wechat-inbox/store.js';
import type { IlinkJsonObject, IlinkMessage, IlinkMessageResult, IlinkUpdates } from '../src/server/wechat-inbox/client.js';

const { WechatInboxService } = await import('../src/server/wechat-inbox/service.js');
const now = Date.parse('2026-10-20T12:00:00.000Z');
const iso = new Date(now).toISOString();
const fingerprint = 'a'.repeat(64);

function message(id: string, items: readonly IlinkJsonObject[] = [{ type: 1, text_item: { text: 'hello' } }],
  extra: Partial<IlinkMessage> = {}): IlinkMessageResult {
  return { kind: 'message', message: { message_id: id, message_type: 1, direction: 'inbound',
    from_user_id: 'owner', item_list: items.map((item) => ({ kind: 'item', item })), ...extra } };
}
function updates(msgs: readonly IlinkMessageResult[], cursor = 'next'): IlinkUpdates {
  return { kind: 'updates', msgs, get_updates_buf: cursor };
}
function setup(t: TestContext) {
  const sessions = new WechatSessionStore(':memory:');
  const store = new WechatInboxStore(':memory:');
  t.after(() => { store.close(); sessions.close(); });
  for (const owner of ['owner', 'other']) {
    sessions.saveBinding({ ownerIlinkUserId: owner, botId: `bot-${owner}`, botToken: 'secret-token', baseUrl: 'https://secret-api.test' }, now);
  }
  const service = new WechatInboxService(sessions, store, { now: () => now, getPollState: () => 'polling' });
  service.activateBinding('owner');
  service.activateBinding('other');
  return { sessions, store, service };
}

test('binding summaries keep QR owners and lifecycle state without exposing credentials', (t) => {
  const { sessions, store, service } = setup(t);
  const bindings = service.listBindings();
  assert.deepEqual(bindings.map(({ ownerIlinkUserId, connectionState, canSend, replyContextState }) =>
    ({ ownerIlinkUserId, connectionState, canSend, replyContextState }))
    .sort((left, right) => left.ownerIlinkUserId.localeCompare(right.ownerIlinkUserId)), [
    { ownerIlinkUserId: 'other', connectionState: 'polling', canSend: true, replyContextState: 'waiting_for_inbound' },
    { ownerIlinkUserId: 'owner', connectionState: 'polling', canSend: true, replyContextState: 'waiting_for_inbound' },
  ]);
  assert.doesNotMatch(JSON.stringify(bindings), /secret|botToken|baseUrl/);
  service.deactivateBinding('owner');
  assert.equal(sessions.getBinding('owner'), null);
  assert.equal(store.getBinding('owner')?.unlinkedAt, iso);
  assert.equal(service.listBindings().find((entry) => entry.ownerIlinkUserId === 'owner')?.canSend, false);
  sessions.saveBinding({ ownerIlinkUserId: 'owner', botId: 'renewed', botToken: 'secret-new', baseUrl: 'https://secret-new.test' }, now + 1000);
  service.activateBinding('owner');
  assert.equal(store.getBinding('owner')?.unlinkedAt, null);
  assert.equal(store.getBinding('owner')?.createdAt, iso);
});

test('reply readiness follows only the selected owner verified inbound context', async (t) => {
  const { store, service } = setup(t);
  assert.deepEqual(service.listBindings().map(({ ownerIlinkUserId, replyContextState }) => [ownerIlinkUserId, replyContextState]), [
    ['other', 'waiting_for_inbound'], ['owner', 'waiting_for_inbound'],
  ]);
  await service.processUpdates('owner', updates([message('owner-first', undefined, { context_token: 'owner-context' })]));
  assert.deepEqual(service.listBindings().map(({ ownerIlinkUserId, replyContextState }) => [ownerIlinkUserId, replyContextState]), [
    ['other', 'waiting_for_inbound'], ['owner', 'ready'],
  ]);
  assert.equal(store.getLatestContextToken('other'), null);
});

test('does not save content or context from an inbound identity that does not match its binding', async (t) => {
  const { store, service } = setup(t);
  await service.processUpdates('owner', updates([message('foreign-first', [{ type: 1, text_item: { text: 'private foreign content' } }],
    { from_user_id: 'other', context_token: 'foreign-context' })]));
  const item = service.listMessages('owner').items[0]?.items[0];
  assert.equal(item?.kind, 'protocol_event');
  assert.equal(item?.text, '暂不支持或无法读取的消息内容');
  assert.equal(store.getLatestContextToken('owner'), null);
  assert.doesNotMatch(JSON.stringify(service.listMessages('owner')), /private foreign content|foreign-context/);
  assert.equal(service.listBindings().find(({ ownerIlinkUserId }) => ownerIlinkUserId === 'owner')?.replyContextState,
    'waiting_for_inbound');
});

test('ingests mixed entries atomically into the polling binding stream and keeps context private', async (t) => {
  const { store, service } = setup(t);
  const save = mock.method(store, 'saveBatch');
  const update = updates([
    message('1', undefined, { context_token: 'secret-context', create_time_ms: now - 1000 }),
    { kind: 'malformed_message', reason: 'invalid_message', fingerprint },
    message('2', [{ type: 1, text_item: { text: 'before' } }, { type: 11, tool_call_start_item: { tool_name: 'secret-tool' } },
      { type: 2, image_item: { media: { full_url: 'https://cdn.test/secret-url', aes_key: 'bad-key' } } },
      { type: 4, file_item: { media: { full_url: 'https://cdn.test/secret-url', aes_key: 'bad-key' } } },
      { type: 3, voice_item: { media: { full_url: 'https://cdn.test/secret-url', aes_key: 'bad-key' } } },
      { type: 1, text_item: { text: 'after' } }]),
    { kind: 'message', message: { message_id: '3', to_user_id: 'owner', direction: 'outbound', message_type: 2,
      client_id: 'upstream-client-3', context_token: 'secret-bot-context',
      item_list: [{ kind: 'malformed_item', reason: 'invalid_item', fingerprint }] } },
    message('4', undefined, { context_token: 'secret-latest', create_time_ms: -1 }),
  ]);
  await service.processUpdates('owner', update);
  assert.equal(save.mock.callCount(), 1);
  assert.equal(store.getCursor('owner'), 'next');
  const page = service.listMessages('owner');
  assert.deepEqual(page.items.map((entry) => [entry.remoteMessageId, entry.direction, entry.sequence]),
    [['1', 'inbound', 1], [null, 'inbound', 2], ['2', 'inbound', 3], ['3', 'outbound', 4], ['4', 'inbound', 5]]);
  assert.equal(page.items[0]?.createdAt, new Date(now - 1000).toISOString());
  assert.equal(page.items.at(-1)?.createdAt, iso);
  assert.deepEqual(page.items[2]?.items.map((item) => item.kind),
    ['text', 'protocol_event', 'protocol_event', 'protocol_event', 'protocol_event', 'text']);
  assert.equal(store.getLatestContextToken('owner'), 'secret-latest');
  assert.doesNotMatch(JSON.stringify(page), /secret|fingerprint|context_token|discarded-sender|tool_name|safeSummary|runId|messageType/);
  assert.deepEqual(service.listMessages('other').items, []);
  assert.equal(store.getCursor('other'), '');
});

test('deduplicates remote IDs and correlates a matching outbound client ID within the polling binding', async (t) => {
  const { store, service } = setup(t);
  const pending: InboxMessageInput = { remoteMessageId: null, clientId: 'per-message-client-id', direction: 'outbound',
    messageType: 2, kind: 'text', state: 'sending', createdAt: iso, runId: null,
    items: [{ kind: 'text', text: 'local pending' }] };
  store.saveBatch('owner', { nextCursor: 'old', messages: [pending] });
  const update = updates([
    message('1'),
    message('2', undefined, { direction: 'outbound', message_type: 2, to_user_id: 'owner', client_id: 'per-message-client-id' }),
    { kind: 'malformed_message', reason: 'invalid_message', fingerprint },
  ]);
  await service.processUpdates('owner', update);
  await service.processUpdates('owner', update);
  const page = service.listMessages('owner');
  assert.equal(page.items.length, 3);
  assert.equal(page.items[0]?.text, 'local pending');
  assert.equal(page.items[0]?.remoteMessageId, '2');
  assert.equal(page.items[0]?.state, 'accepted');
  assert.equal(page.items[1]?.remoteMessageId, '1');
  assert.equal(page.items[2]?.kind, 'protocol_event');
  await service.processUpdates('other', updates([message('other-1', undefined,
    { from_user_id: 'other', context_token: 'secret-other' })]));
  assert.equal(service.listMessages('other').items.length, 1);
  assert.equal(store.getLatestContextToken('other'), 'secret-other');
  assert.equal(store.getCursor('other'), 'next');
});

for (const timestamp of [undefined, NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER, 8640000000000001]) {
  test(`uses safe local time for invalid upstream epoch ${timestamp}`, async (t) => {
    const { service } = setup(t);
    await service.processUpdates('owner', updates([message('1', undefined, { create_time_ms: timestamp })]));
    assert.equal(service.listMessages('owner').items[0]?.createdAt, iso);
  });
}

test('accepts the maximum RFC3339 four-digit-year upstream epoch', async (t) => {
  const { service } = setup(t);
  await service.processUpdates('owner', updates([message('1', undefined, { create_time_ms: 253402300799999 })]));
  assert.equal(service.listMessages('owner').items[0]?.createdAt, '9999-12-31T23:59:59.999Z');
});

test('maps malformed content to safe binding-owned protocol items', async (t) => {
  const { service } = setup(t);
  await service.processUpdates('owner', updates([message('1', []), message('2', [
    { type: 1, text_item: { text: { secret: 'raw' } } }, { type: 999, secret: 'raw' },
    { type: 2, image_item: { url: 'https://guessed.test' } },
    { type: 2, image_item: { media: { encrypt_query_param: 'secret-param' } } },
  ])]));
  const items = service.listMessages('owner').items;
  assert.equal(items[0]?.items[0]?.kind, 'protocol_event');
  assert.deepEqual(items[1]?.items.map((item) => item.kind), Array(4).fill('protocol_event'));
  assert.doesNotMatch(JSON.stringify(items), /raw|secret|guessed/);
});

test('paginates binding messages and preserves readable history when binding is unlinked', async (t) => {
  const { service } = setup(t);
  await service.processUpdates('owner', updates([message('1'), message('2'), message('3')]));
  const latest = service.listMessages('owner', { limit: 2 });
  assert.equal(latest.hasMore, true);
  assert.deepEqual(latest.items.map((item) => item.remoteMessageId), ['2', '3']);
  assert.deepEqual(service.listMessages('owner', { before: latest.nextCursor }).items.map((item) => item.remoteMessageId), ['1']);
  service.deactivateBinding('owner');
  assert.equal(service.listMessages('owner').items.length, 3);
});

test('propagates a rejected batch writer rather than reporting successful ingestion', async (t) => {
  const { store, service } = setup(t);
  const failure = new TypeError('batch rejected');
  mock.method(store, 'saveBatch', async () => { throw failure; });
  await assert.rejects(service.processUpdates('owner', updates([message('1')])), (error: unknown) => error === failure);
  assert.equal(store.getCursor('owner'), '');
});
