import assert from 'node:assert/strict';
import test from 'node:test';
import { createWechatLoader } from '../src/web/wechat-loader.js';
import { setImmediate } from 'node:timers/promises';

test('unlink operations are independently busy and reject duplicate row requests without checking bindings', async (context) => {
  const pending = Promise.withResolvers<Response>();
  const requests: string[] = [];
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(`${init?.method} ${input}`);
    return String(input).endsWith('/owner-a') ? pending.promise : Response.json({ status: 'unlinked' });
  });
  const loader = createWechatLoader(() => {});
  loader.setActive(true);
  context.after(() => loader.setActive(false));
  const unlink = loader.unlink('owner-a');
  await loader.unlink('owner-a');
  await loader.unlink('owner-b');
  assert.equal(loader.getState().bindings['owner-a']?.busy, 'unlink');
  assert.equal(loader.getState().bindings['owner-b']?.status, 'unlinked');
  pending.resolve(Response.json({ status: 'unlinked' }));
  await unlink;
  assert.equal(loader.getState().bindings['owner-a']?.status, 'unlinked');
  assert.equal(loader.getState().revision, 2);
  assert.deepEqual(requests, ['DELETE /api/wechat/bindings/owner-a', 'DELETE /api/wechat/bindings/owner-b']);
});

test('an error stays on its row and a sibling success cannot erase it', async (context) => {
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => String(input).includes('owner-a')
    ? Response.json({ error: 'private-detail' }, { status: 503 }) : Response.json({ status: 'unlinked' }));
  const loader = createWechatLoader(() => {});
  loader.setActive(true);
  context.after(() => loader.setActive(false));
  await loader.unlink('owner-a');
  const error = loader.getState().bindings['owner-a']?.error;
  await loader.unlink('owner-b');
  assert.ok(error);
  assert.doesNotMatch(error, /private-detail/);
  assert.equal(loader.getState().bindings['owner-a']?.error, error);
  assert.equal(loader.getState().bindings['owner-b']?.error, '');
  assert.equal(loader.getState().revision, 1);
});

test('inactive mutations are ignored and aborted receipts cannot overwrite a newer row operation', async (context) => {
  const pending = Promise.withResolvers<Response>();
  let signal: AbortSignal | null | undefined;
  const fetch = context.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    signal = init?.signal;
    return pending.promise;
  });
  const loader = createWechatLoader(() => {});
  await loader.unlink('owner-a');
  assert.equal(fetch.mock.callCount(), 0);
  loader.setActive(true);
  const old = loader.unlink('owner-a');
  loader.setActive(false);
  assert.equal(signal?.aborted, true);
  pending.resolve(Response.json({ status: 'unlinked' }));
  await old;
  assert.equal(loader.getState().bindings['owner-a']?.busy, '');
  assert.equal(loader.getState().bindings['owner-a']?.status, null);
  assert.equal(loader.getState().revision, 0);
});

test('adding a user again clears obsolete successful row receipts while preserving row errors', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/bindings/failed')) return Response.json({ error: 'unavailable' }, { status: 503 });
    if (String(input).includes('/bindings/')) return Response.json({ status: 'unlinked' });
    return Response.json(init?.method === 'POST' ? { attemptId: 'again', qrSvg: '<svg/>', expiresAt: Date.now() + 60_000 } : { status: 'confirmed' });
  });
  const loader = createWechatLoader(() => {});
  context.after(() => loader.setActive(false));
  loader.setActive(true);
  await loader.unlink('owner');
  await loader.unlink('failed');
  const error = loader.getState().bindings.failed?.error;

  loader.startQr();
  await setImmediate();
  context.mock.timers.tick(2000);
  await setImmediate();

  assert.equal(loader.getState().bindings.owner?.status, null);
  assert.equal(loader.getState().bindings.failed?.error, error);
});
