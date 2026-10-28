import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { IlinkClientError, type IlinkUpdates } from '../src/server/wechat-inbox/client.js';
import { WechatInboxStore } from '../src/server/wechat-inbox/store.js';
import type { InboxPollerDependencies } from '../src/server/wechat-inbox/poller.js';
import { binding, update, deferred, fixture } from './helpers/wechat-inbox-poller.js';

for (const timeout of [90_000, 2_147_483_647]) {
  test(`waits for the atomic handler before polling with the committed cursor and timeout ${timeout}`, async (t) => {
    const committed = deferred<void>();
    const received: IlinkUpdates[] = [];
    const f = fixture(t, { processUpdates: async (owner, batch) => {
      received.push(batch); await committed.promise; f.cursors.set(owner, 'service-committed');
    } });
    f.poller.start('owner', binding);
    await nextTurn();
    const batch = { ...update, longpolling_timeout_ms: timeout };
    f.requests[0].reply.resolve(batch);
    await nextTurn();
    assert.deepEqual(received, [batch]);
    assert.equal(f.requests.length, 1);
    committed.resolve();
    await nextTurn();
    assert.equal(f.requests[1].cursor, 'service-committed');
    assert.equal(f.requests[1].timeoutMs, timeout);
  });
}

test('replays after handler failure without advancing the cursor', async (t) => {
  let attempts = 0;
  const f = fixture(t, { processUpdates: async () => { if (++attempts === 1) throw new Error('database failure'); } });
  f.poller.start('owner', binding);
  await nextTurn();
  f.requests[0].reply.resolve(update);
  await nextTurn();
  assert.equal(f.poller.getState('owner'), 'backoff');
  f.waits[0].gate.resolve();
  await nextTurn();
  assert.equal(f.requests[1].cursor, 'persisted-cursor');
  f.requests[1].reply.resolve(update);
  await nextTurn();
  assert.equal(attempts, 2);
  assert.equal(f.requests[2].cursor, 'persisted-cursor', 'the response alone never commits a cursor');
});

test('preserves a committed cursor when responses omit or empty the next cursor', async (t) => {
  const f = fixture(t);
  f.poller.start('owner', binding);
  await nextTurn();
  for (const batch of [{ kind: 'updates', msgs: [] }, { kind: 'updates', msgs: [], get_updates_buf: '' }] satisfies IlinkUpdates[]) {
    f.requests.at(-1)?.reply.resolve(batch);
    await nextTurn();
    assert.equal(f.requests.at(-1)?.cursor, 'persisted-cursor');
  }
});

test('bounds exponential backoff and resets it only after successful processing', async (t) => {
  const f = fixture(t);
  f.poller.start('owner', binding);
  await nextTurn();
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    f.requests.at(-1)?.reply.reject(new IlinkClientError('timeout'));
    await nextTurn();
    assert.equal(f.waits.at(-1)?.ms, delay);
    f.waits.at(-1)?.gate.resolve();
    await nextTurn();
  }
  f.requests.at(-1)?.reply.resolve(update);
  await nextTurn();
  f.requests.at(-1)?.reply.reject(new Error('transport failure'));
  await nextTurn();
  assert.equal(f.waits.at(-1)?.ms, 1000);
  assert.equal(f.requests.at(-1)?.cursor, 'opaque-next');
});

for (const error of [new IlinkClientError('http_failure', 503), new IlinkClientError('aborted'),
  new Error('auth_required -14'), { code: 'auth_required', ret: -14 }]) {
  test(`retries non-authoritative auth-like or transient error ${String(error)}`, async (t) => {
    const f = fixture(t);
    f.poller.start('owner', binding);
    await nextTurn();
    f.requests[0].reply.reject(error);
    await nextTurn();
    assert.equal(f.poller.getState('owner'), 'backoff');
    assert.equal(f.waits.length, 1);
  });
}

test('stop waits for processing to drain before a new generation reads its cursor', async (t) => {
  const gate = deferred<void>();
  const f = fixture(t, { processUpdates: async (owner) => { await gate.promise; f.cursors.set(owner, 'committed-before-stop'); } });
  f.poller.start('owner', binding); await nextTurn();
  f.requests[0].reply.resolve(update); await nextTurn();
  let drained = false;
  const stopping = f.poller.stop('owner').then(() => { drained = true; });
  f.poller.start('owner', binding); await nextTurn();
  assert.equal(drained, false);
  assert.equal(f.requests.length, 1);
  gate.resolve(); await stopping; await nextTurn();
  assert.equal(f.requests[1].cursor, 'committed-before-stop');
});

test('stop aborts the worker signal passed to in-flight batch processing', async (t) => {
  const entered = deferred<AbortSignal | undefined>();
  const aborted = deferred<void>();
  const f = fixture(t, { processUpdates: async (_owner, _batch, options) => {
    entered.resolve(options?.signal);
    if (options?.signal) await new Promise<void>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => { aborted.resolve(); reject(new IlinkClientError('aborted')); }, { once: true });
    });
  } });
  f.poller.start('owner', binding); await nextTurn();
  f.requests[0].reply.resolve(update);
  const signal = await entered.promise;
  const stopping = f.poller.stop('owner');
  await stopping;
  assert.equal(signal, f.requests[0].signal);
  assert.equal(signal?.aborted, true);
  await aborted.promise;
  assert.equal(f.cursors.get('owner'), 'persisted-cursor');
  assert.equal(f.requests.length, 1);
  assert.equal(f.waits.length, 0);
});

test('the default backoff timer is abortable without waiting for its deadline', async (t) => {
  const f = fixture(t, { sleep: undefined });
  f.poller.start('owner', binding); await nextTurn();
  f.requests[0].reply.reject(new IlinkClientError('timeout')); await nextTurn();
  assert.equal(f.poller.getState('owner'), 'backoff');
  await f.poller.stop('owner');
  assert.equal(f.requests.length, 1);
});

for (const timeout of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
  test(`retains the prior representable timeout after ${timeout}`, async (t) => {
    const f = fixture(t);
    f.poller.start('owner', binding); await nextTurn();
    f.requests[0].reply.resolve({ ...update, longpolling_timeout_ms: timeout }); await nextTurn();
    assert.equal(f.requests[1].timeoutMs, 35_000);
  });
}

test('recovers a real stored cursor across pollers and leaves replay deduplication to the transaction', async (t) => {
  const store = new WechatInboxStore(':memory:');
  t.after(() => store.close());
  store.saveBinding({ ownerIlinkUserId: 'owner', botId: 'bot' }, '2026-10-20T00:00:00Z');
  const processUpdates: InboxPollerDependencies['processUpdates'] = async (owner, batch) => {
    store.saveBatch(owner, { nextCursor: batch.get_updates_buf ?? '', messages: batch.msgs.flatMap((result) => result.kind === 'message' ? [{
      remoteMessageId: result.message.message_id, clientId: null,
      direction: result.message.direction, messageType: result.message.message_type, kind: 'text', state: 'received',
      createdAt: '2026-10-20T00:00:00Z', runId: null, items: [{ kind: 'text', text: 'safe' }],
    }] : []) });
  };
  const first = fixture(t, { store, processUpdates });
  first.poller.start('owner', binding); await nextTurn();
  assert.equal(first.requests[0].cursor, '');
  first.requests[0].reply.resolve(update); await nextTurn();
  await first.poller.shutdown();
  const second = fixture(t, { store, processUpdates });
  second.poller.start('owner', binding); await nextTurn();
  assert.equal(second.requests[0].cursor, 'opaque-next');
  second.requests[0].reply.resolve(update); await nextTurn();
  assert.equal(store.listMessages('owner').items.length, 1);
  await second.poller.shutdown();
});
