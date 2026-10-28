import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createWechatQrLoader, type WechatQrState } from '../src/web/wechat-qr-loader.js';

test('cancels a pending QR attempt and removes its SVG when leaving the tab', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'], now: 1000 });
  const requests: string[] = [];
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(`${init?.method} ${String(input)}`);
    return Response.json(init?.method === 'POST' ? { attemptId: 'a1', qrSvg: '<svg/>', expiresAt: Date.now() + 60000 } : { status: 'cancelled' });
  });
  const states: WechatQrState[] = [];
  const loader = createWechatQrLoader((state) => states.push(state), () => {});
  loader.start();
  await setImmediate();

  loader.stop();
  await setImmediate();
  context.mock.timers.tick(60000);

  assert.deepEqual(requests, ['POST /api/wechat/qrcode', 'DELETE /api/wechat/qrcode/a1']);
  assert.equal(states.at(-1)?.qr, null);
  assert.equal(states.at(-1)?.status, 'idle');
});

test('aborts and suppresses a late confirmation after cancellation', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let resolve: (response: Response) => void = () => { throw new Error('pending poll absent'); };
  let signal: AbortSignal | null | undefined;
  let confirmations = 0;
  context.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ attemptId: 'a1', qrSvg: '<svg/>', expiresAt: Date.now() + 60000 });
    if (init?.method === 'DELETE') return Response.json({ status: 'cancelled' });
    signal = init?.signal;
    return new Promise<Response>((fulfill) => { resolve = fulfill; });
  });
  const states: WechatQrState[] = [];
  const loader = createWechatQrLoader((state) => states.push(state), () => { confirmations++; });
  loader.start();
  await setImmediate();
  context.mock.timers.tick(2000);
  await setImmediate();

  loader.stop();
  resolve(Response.json({ status: 'confirmed', expiresAt: Date.now() + 60000 }));
  await setImmediate();

  assert.equal(signal?.aborted, true);
  assert.equal(confirmations, 0);
  assert.equal(states.at(-1)?.status, 'idle');
});

test('removes an expired QR code without issuing further status requests', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const methods: string[] = [];
  context.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    methods.push(init?.method ?? 'GET');
    return Response.json(init?.method === 'POST' ? { attemptId: 'a1', qrSvg: '<svg/>', expiresAt: 2000 } : { status: 'cancelled' });
  });
  const states: WechatQrState[] = [];
  const loader = createWechatQrLoader((state) => states.push(state), () => {});
  context.after(loader.stop);
  loader.start();
  await setImmediate();

  context.mock.timers.tick(2000);
  await setImmediate();

  assert.equal(states.at(-1)?.status, 'expired');
  assert.equal(states.at(-1)?.qr, null);
  assert.deepEqual(methods, ['POST', 'DELETE']);
});

async function pendingQr(context: TestContext) {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const requests: string[] = [];
  const polls: { signal: AbortSignal | null | undefined; resolve: (response: Response) => void }[] = [];
  const states: WechatQrState[] = [];
  let attempts = 0;
  let confirmations = 0;
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(`${init?.method} ${String(input)}`);
    if (init?.method === 'POST') {
      attempts++;
      return Response.json({ attemptId: `a${attempts}`, qrSvg: '<svg/>', expiresAt: Date.now() + 6000 });
    }
    if (init?.method === 'DELETE') return Response.json({ status: 'cancelled' });
    return new Promise<Response>((resolve) => { polls.push({ signal: init?.signal, resolve }); });
  });
  const loader = createWechatQrLoader((state) => states.push(state), () => { confirmations++; });
  context.after(loader.stop);
  loader.start();
  await setImmediate();
  context.mock.timers.tick(2000);
  await setImmediate();
  const poll = polls[0];
  assert.ok(poll);
  return { loader, states, requests, poll, confirmations: () => confirmations };
}

test('expires at the absolute deadline while a poll remains unresolved', async (context) => {
  const { states, requests, poll } = await pendingQr(context);

  context.mock.timers.tick(3999);
  assert.equal(states.at(-1)?.qr?.attemptId, 'a1');
  context.mock.timers.tick(1);
  await setImmediate();

  assert.deepEqual(states.at(-1), { qr: null, status: 'expired', error: '' });
  assert.equal(poll.signal?.aborted, true);
  assert.deepEqual(requests, ['POST /api/wechat/qrcode', 'GET /api/wechat/qrcode/a1', 'DELETE /api/wechat/qrcode/a1']);
  const count = states.length;
  context.mock.timers.tick(60000);
  await setImmediate();
  assert.equal(states.length, count);
  assert.equal(requests.length, 3);
});

for (const status of ['waiting', 'scanned', 'unverified', 'confirmed'] as const) {
  for (const deadlineFired of [true, false]) {
    test(`suppresses late ${status} when the deadline timer has ${deadlineFired ? 'fired' : 'been delayed'}`, async (context) => {
      const { states, requests, poll, confirmations } = await pendingQr(context);

      if (deadlineFired) context.mock.timers.tick(4000);
      else context.mock.timers.setTime(7000);
      poll.resolve(Response.json({ status, expiresAt: 67000 }));
      await setImmediate();

      assert.deepEqual(states.at(-1), { qr: null, status: 'expired', error: '' });
      assert.equal(confirmations(), 0);
      assert.equal(poll.signal?.aborted, true);
      const count = states.length;
      context.mock.timers.tick(60000);
      await setImmediate();
      assert.equal(states.length, count);
      assert.deepEqual(requests.slice(2), ['DELETE /api/wechat/qrcode/a1']);
    });
  }
}

test('keeps a restarted attempt intact after the old deadline and late confirmation', async (context) => {
  const { loader, states, requests, poll, confirmations } = await pendingQr(context);

  loader.start();
  await setImmediate();
  poll.resolve(Response.json({ status: 'confirmed', expiresAt: 67000 }));
  await setImmediate();
  context.mock.timers.tick(4000);
  await setImmediate();

  assert.equal(poll.signal?.aborted, true);
  assert.equal(states.at(-1)?.qr?.attemptId, 'a2');
  assert.equal(states.at(-1)?.status, 'waiting');
  assert.equal(confirmations(), 0);
  assert.equal(requests.filter((request) => request === 'DELETE /api/wechat/qrcode/a1').length, 1);
  context.mock.timers.tick(2000);
  await setImmediate();
  assert.deepEqual(states.at(-1), { qr: null, status: 'expired', error: '' });
  assert.equal(requests.at(-1), 'DELETE /api/wechat/qrcode/a2');
});

for (const deadlineFired of [true, false]) {
  test(`hidden-tab disposal stays idle when expiry ${deadlineFired ? 'precedes' : 'follows'} stop`, async (context) => {
    const { loader, states, requests, poll, confirmations } = await pendingQr(context);

    if (deadlineFired) context.mock.timers.tick(4000);
    loader.stop();
    const count = states.length;
    context.mock.timers.tick(60000);
    poll.resolve(Response.json({ status: 'confirmed', expiresAt: 67000 }));
    await setImmediate();

    assert.equal(states.length, count);
    assert.deepEqual(states.at(-1), { qr: null, status: 'idle', error: '' });
    assert.equal(poll.signal?.aborted, true);
    assert.equal(confirmations(), 0);
    assert.deepEqual(requests.slice(2), ['DELETE /api/wechat/qrcode/a1']);
  });
}

for (const status of ['confirmed', 'expired', 'unavailable'] as const) {
  test(`clears the deadline timer when a poll finishes with ${status} before expiry`, async (context) => {
    const { states, requests, poll, confirmations } = await pendingQr(context);

    poll.resolve(Response.json({ status, expiresAt: 67000 }));
    await setImmediate();
    const count = states.length;
    context.mock.timers.tick(60000);
    await setImmediate();

    assert.deepEqual(states.at(-1), { qr: null, status, error: '' });
    assert.equal(states.length, count);
    assert.equal(confirmations(), status === 'confirmed' ? 1 : 0);
    assert.deepEqual(requests.slice(2), status === 'confirmed' ? [] : ['DELETE /api/wechat/qrcode/a1']);
  });
}

for (const code of ['wechat_upstream_auth_failed', 'wechat_upstream_unavailable', 'wechat_identity_missing']) {
  test(`stops polling and removes QR on ${code}`, async (context) => {
    const { states, requests, poll, confirmations } = await pendingQr(context);

    poll.resolve(Response.json({ error: code, message: 'private-detail' }, { status: 503 }));
    await setImmediate();
    const count = requests.length;
    context.mock.timers.tick(60000);
    await setImmediate();

    assert.equal(states.at(-1)?.status, 'unavailable');
    assert.equal(states.at(-1)?.qr, null);
    assert.doesNotMatch(states.at(-1)?.error ?? '', /private-detail/);
    if (code === 'wechat_identity_missing') assert.equal(states.at(-1)?.error, '授权身份信息不完整，绑定未完成，请重新扫码。');
    assert.equal(poll.signal?.aborted, true);
    assert.equal(confirmations(), 0);
    assert.equal(requests.length, count);
    assert.equal(requests.at(-1), 'DELETE /api/wechat/qrcode/a1');
  });
}
