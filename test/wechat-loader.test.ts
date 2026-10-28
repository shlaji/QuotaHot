import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import QRCode from 'qrcode';
import { createWechatLoader } from '../src/web/wechat-loader.js';

test('does not expose a per-binding check operation', () => {
  const loader = createWechatLoader(() => {});

  assert.equal('checkBinding' in loader, false);
});

test('activation and time passage never request cookie session or single binding endpoints', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const fetch = context.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'unlinked' }));
  const loader = createWechatLoader(() => {});
  context.after(() => loader.setActive(false));
  loader.setActive(true);
  await setImmediate();
  context.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(fetch.mock.callCount(), 0);
  for (const key of ['session', 'binding', 'logout']) assert.equal(key in loader.getState(), false);
});

test('confirmed QR only advances binding revision without an identity or expiry receipt', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const qrSvg = await QRCode.toString('synthetic-add-owner', { type: 'svg' });
  const requests: string[] = [];
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(`${init?.method} ${input}`);
    return Response.json(init?.method === 'POST' ? { attemptId: 'a1', qrSvg, expiresAt: Date.now() + 60_000 } : { status: 'confirmed' });
  });
  const loader = createWechatLoader(() => {});
  context.after(() => loader.setActive(false));
  loader.setActive(true);
  loader.startQr();
  loader.startQr();
  await setImmediate();
  context.mock.timers.tick(2000);
  await setImmediate();
  assert.deepEqual(requests, ['POST /api/wechat/qrcode', 'GET /api/wechat/qrcode/a1']);
  assert.equal(loader.getState().qr.status, 'confirmed');
  assert.equal(loader.getState().revision, 1);
});

test('leaving the page cancels a late QR creation without restoring its image', async (context) => {
  const pending = Promise.withResolvers<Response>();
  const qrSvg = await QRCode.toString('synthetic-late-owner', { type: 'svg' });
  const cancellations: string[] = [];
  let signal: AbortSignal | null | undefined;
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') { signal = init.signal; return pending.promise; }
    cancellations.push(String(input));
    return Response.json({ status: 'cancelled' });
  });
  const loader = createWechatLoader(() => {});
  loader.setActive(true);
  loader.startQr();
  loader.setActive(false);
  pending.resolve(Response.json({ attemptId: 'late', qrSvg, expiresAt: Date.now() + 60_000 }));
  await setImmediate();
  assert.equal(signal?.aborted, true);
  assert.deepEqual(cancellations, ['/api/wechat/qrcode/late']);
  assert.equal(loader.getState().qr.status, 'idle');
});
