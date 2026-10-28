import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { IlinkClientError, type IlinkUpdates } from '../src/server/wechat-inbox/client.js';
import { binding, update, deferred, fixture } from './helpers/wechat-inbox-poller.js';

test('coalesces simultaneous starts and recovers the persisted opaque cursor', async (t) => {
  const f = fixture(t);
  await Promise.all([f.poller.start('owner', binding), f.poller.start('owner', binding)]);
  await nextTurn();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].cursor, 'persisted-cursor');
  assert.equal(f.requests[0].timeoutMs, 35_000);
  assert.equal(f.poller.getState('owner'), 'polling');
  assert.equal(f.poller.getState('missing'), 'stopped');
});

test('retains relogin_required after auth expiry and restarts only after explicit stop', async (t) => {
  const f = fixture(t);
  f.poller.start('owner', binding);
  await nextTurn();
  f.requests[0].reply.reject(new IlinkClientError('auth_required'));
  await nextTurn();
  assert.equal(f.poller.getState('owner'), 'relogin_required');
  f.poller.start('owner', binding);
  await nextTurn();
  assert.equal(f.requests.length, 1);
  assert.equal(f.waits.length, 0);
  await f.poller.stop('owner');
  f.poller.start('owner', { ...binding, botToken: 'renewed' });
  await nextTurn();
  assert.equal(f.requests.length, 2);
});

test('stops one owner globally without aborting unrelated owners', async (t) => {
  const f = fixture(t);
  f.poller.start('owner', binding); f.poller.start('other', binding);
  await nextTurn();
  await f.poller.stop('owner');
  assert.equal(f.requests[0].signal?.aborted, true);
  assert.equal(f.requests[1].signal?.aborted, false);
  assert.equal(f.poller.getState('owner'), 'stopped');
});

test('drains a stopped generation before starting its replacement and discards late updates', async (t) => {
  const late = deferred<IlinkUpdates>();
  let clients = 0;
  const f = fixture(t, { createClient: () => {
    if (++clients === 1) return { getUpdates: () => late.promise };
    return { getUpdates: (_cursor, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new IlinkClientError('aborted')), { once: true });
    }) };
  } });
  f.poller.start('owner', binding);
  await nextTurn();
  const stopping = f.poller.stop('owner');
  f.poller.start('owner', { ...binding, botToken: 'new' });
  f.poller.start('owner', binding);
  await nextTurn();
  assert.equal(clients, 1);
  late.resolve(update);
  await stopping; await nextTurn();
  assert.equal(clients, 2);
  assert.deepEqual(f.processed, []);
  assert.equal(f.poller.getState('owner'), 'polling');
});

test('stopAll cancels polling and backoff and shutdown prevents future starts', async (t) => {
  const f = fixture(t);
  f.poller.start('owner', binding); f.poller.start('other', binding); await nextTurn();
  f.requests[0].reply.reject(new IlinkClientError('timeout')); await nextTurn();
  await f.poller.stopAll();
  assert.equal(f.waits[0].signal.aborted, true);
  assert.equal(f.requests[1].signal?.aborted, true);
  f.poller.start('owner', binding); await nextTurn();
  assert.equal(f.requests.length, 3);
  await f.poller.shutdown();
  f.poller.start('owner', binding); await nextTurn();
  assert.equal(f.requests.length, 3);
});

test('notification failures and pending notifications never block polling or shutdown', async (t) => {
  const calls: string[] = [];
  const f = fixture(t, {
    notifyStart: () => { calls.push('start'); throw new Error('private diagnostic'); },
    notifyStop: async () => { calls.push('stop'); throw new Error('private diagnostic'); },
  });
  f.poller.start('owner', binding); await nextTurn();
  assert.equal(f.requests.length, 1);
  await f.poller.stop('owner'); await nextTurn();
  assert.deepEqual(calls, ['start', 'stop']);
  const pending = fixture(t, { notifyStart: () => new Promise(() => {}), notifyStop: () => new Promise(() => {}) });
  pending.poller.start('owner', binding); await nextTurn();
  assert.equal(pending.requests.length, 1);
  await pending.poller.shutdown();
});
