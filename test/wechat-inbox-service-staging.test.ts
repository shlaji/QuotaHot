import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { mock, test, type TestContext } from 'node:test';
import { HttpResponse, type request } from '../src/server/http.js';
import { WechatSessionStore } from '../src/server/wechat-session-store.js';
import { WechatInboxStore } from '../src/server/wechat-inbox/store.js';
import type { IlinkJsonObject, IlinkMessageResult, IlinkUpdates } from '../src/server/wechat-inbox/client.js';
import { InboxMediaStaging, InboxStagingError } from '../src/server/wechat-inbox/media-staging.js';

let transport: typeof request = async () => { assert.fail('unexpected CDN request'); };
let stagingRoot = '';
mock.module('../src/server/http.js', { exports: { HttpResponse,
  request: (...args: Parameters<typeof request>) => transport(...args) } });
mock.module('../src/server/wechat-inbox/media-staging.js', { exports: { InboxStagingError,
  InboxMediaStaging: class extends InboxMediaStaging { constructor() { super(stagingRoot); } } } });
const { WechatInboxService } = await import('../src/server/wechat-inbox/service.js');
const { IlinkMediaError } = await import('../src/server/wechat-inbox/media.js');
const now = Date.parse('2026-10-20T12:00:00.000Z');
function message(id: string, items: readonly IlinkJsonObject[] = [{ type: 1, text_item: { text: 'hello' } }]): IlinkMessageResult {
  return { kind: 'message', message: { message_id: id, message_type: 1, direction: 'inbound',
    from_user_id: 'owner', item_list: items.map((item) => ({ kind: 'item', item })) } };
}
function updates(msgs: readonly IlinkMessageResult[]): IlinkUpdates {
  return { kind: 'updates', msgs, get_updates_buf: 'next' };
}
function deferred<Value>() {
  let resolve: (value: Value) => void = () => assert.fail('uninitialized resolver');
  const promise = new Promise<Value>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function setup(t: TestContext) {
  stagingRoot = mkdtempSync(join(tmpdir(), 'inbox-service-stage-'));
  const root = stagingRoot;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessions = new WechatSessionStore(':memory:');
  const store = new WechatInboxStore(':memory:');
  t.after(() => { store.close(); sessions.close(); });
  sessions.saveBinding({ ownerIlinkUserId: 'owner', botId: 'bot', botToken: 'secret-token', baseUrl: 'https://secret-api.test' }, now);
  const service = new WechatInboxService(sessions, store, { now: () => now });
  service.activateBinding('owner');
  return { store, service, root };
}

test('aborts an in-flight CDN transfer and removes earlier staged media without committing', async (t) => {
  const { store, service, root } = setup(t);
  const controller = new AbortController();
  const entered = deferred<AbortSignal | undefined>();
  let calls = 0;
  transport = async (_url, options = {}) => {
    if (++calls === 1) return new HttpResponse(200, new Headers(), Readable.from([Buffer.from('first')]));
    entered.resolve(options.signal);
    if (!options.signal) throw new IlinkMediaError('aborted');
    return new Promise((_resolve, reject) => options.signal?.addEventListener(
      'abort', () => reject(controller.signal.reason), { once: true }));
  };
  const save = t.mock.method(store, 'saveBatch');
  const item = { type: 2, image_item: { media: { full_url: 'https://cdn.test/plain' } } };
  const processing = service.processUpdates('owner', updates([message('1', [item, item])]), { signal: controller.signal });
  const rejected = assert.rejects(processing);
  const signal = await entered.promise;
  controller.abort();
  assert.equal(signal, controller.signal);
  await rejected;
  assert.equal(save.mock.callCount(), 0);
  assert.equal(store.getCursor('owner'), '');
  assert.deepEqual(store.listMessages('owner').items, []);
  assert.deepEqual(readdirSync(root), []);
});

test('rejects an already cancelled text-only update before committing its cursor', async (t) => {
  const { store, service, root } = setup(t);
  const save = t.mock.method(store, 'saveBatch');
  await assert.rejects(service.processUpdates('owner', updates([message('1')]), { signal: AbortSignal.abort() }));
  assert.equal(save.mock.callCount(), 0);
  assert.equal(store.getCursor('owner'), '');
  assert.deepEqual(readdirSync(root), []);
});
