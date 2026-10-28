import assert from 'node:assert/strict';
import test from 'node:test';
import { wechatApi, WechatApiError } from '../src/web/wechat-api.js';

test('does not expose an ephemeral per-binding check request', () => {
  assert.equal('checkBinding' in wechatApi, false);
});

const cases = [
  { path: '/qrcode', method: 'POST', body: undefined, response: { attemptId: 'a', qrSvg: '<svg/>', expiresAt: 9000 }, call: (signal: AbortSignal) => wechatApi.startQr(signal) },
  { path: '/qrcode/a1', method: 'GET', response: { status: 'waiting' }, call: (signal: AbortSignal) => wechatApi.pollQr('a1', signal) },
  { path: '/qrcode/a1', method: 'DELETE', response: { status: 'cancelled' }, call: (signal: AbortSignal) => wechatApi.cancelQr('a1', signal) },
  { path: '/qrcode/a1', method: 'GET', response: { status: 'confirmed' }, call: (signal: AbortSignal) => wechatApi.pollQr('a1', signal) },
  { path: '/bindings/owner%20%2F%3F%23', method: 'DELETE', response: { status: 'unlinked' }, call: (signal: AbortSignal) => wechatApi.unlink('owner /?#', signal) },
] as const;

for (const fixture of cases) {
  test(`uses same-origin ${fixture.method} ${fixture.path} with cancellation`, async (context) => {
    const controller = new AbortController();
    let received: RequestInit | undefined;
    context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(input, `/api/wechat${fixture.path}`);
      received = init;
      return Response.json(fixture.response);
    });

    const result = await fixture.call(controller.signal);

    assert.deepEqual(result, fixture.response);
    assert.equal(received?.method, fixture.method);
    assert.equal(received?.signal, controller.signal);
    assert.equal(received?.credentials, 'same-origin');
    assert.equal(received?.cache, 'no-store');
    assert.equal(received?.body, 'body' in fixture ? fixture.body : undefined);
    assert.equal(new Headers(received?.headers).has('authorization'), false);
  });
}

for (const failure of [
  { status: 401, body: '{"error":"unauthorized"}', code: 'unauthorized' },
  { status: 502, body: '<html>gateway</html>', code: 'http_error' },
  { status: 503, body: 'null', code: 'http_error' },
]) {
  test(`preserves typed HTTP ${failure.status} errors`, async (context) => {
    context.mock.method(globalThis, 'fetch', async () => new Response(failure.body, { status: failure.status }));

    await assert.rejects(wechatApi.unlink('owner', new AbortController().signal), (error: unknown) =>
      error instanceof WechatApiError && error.status === failure.status && error.code === failure.code);
  });
}

test('propagates an aborted request without disguising it as an HTTP failure', async (context) => {
  const controller = new AbortController();
  controller.abort();
  context.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    return Response.json({ status: 'unlinked' });
  });

  await assert.rejects(wechatApi.unlink('owner', controller.signal), { name: 'AbortError' });
});

test('rejects malformed binding receipts instead of treating them as successful unlink operations', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'logged_in' }));

  await assert.rejects(wechatApi.unlink('owner', new AbortController().signal), (error: unknown) =>
    error instanceof WechatApiError && error.code === 'invalid_response');
});

test('does not expose system credential configuration methods', () => {
  assert.equal('config' in wechatApi, false);
  assert.equal('saveConfig' in wechatApi, false);
  for (const method of ['session', 'logout', 'binding']) assert.equal(method in wechatApi, false);
});

test('guides upstream authentication failures toward retrying QR login without reflecting private detail', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'wechat_upstream_auth_failed', message: 'private-upstream-detail' }, { status: 503 }));

  await assert.rejects(wechatApi.startQr(new AbortController().signal), (error: unknown) => {
    assert.ok(error instanceof WechatApiError);
    assert.equal(error.code, 'wechat_upstream_auth_failed');
    assert.match(error.message, /重试|重新扫码/);
    assert.doesNotMatch(error.message, /配置|AppID|Secret-Key|private-upstream-detail|HTTP/);
    return true;
  });
});

test('uses fixed recovery copy when QR authorization identity is missing without reflecting server detail', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => Response.json({
    error: 'wechat_identity_missing', message: 'private-upstream-message', detail: 'private-upstream-detail',
  }, { status: 502 }));

  await assert.rejects(wechatApi.pollQr('a1', new AbortController().signal), (error: unknown) => {
    assert.ok(error instanceof WechatApiError);
    assert.equal(error.status, 502);
    assert.equal(error.code, 'wechat_identity_missing');
    assert.equal(error.message, '授权身份信息不完整，绑定未完成，请重新扫码。');
    assert.doesNotMatch(error.message, /private-upstream/);
    return true;
  });
});
