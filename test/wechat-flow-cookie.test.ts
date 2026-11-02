import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { WechatLoginService } from '../src/server/wechat-login-service.js';
import { WechatSessionStore } from '../src/server/wechat-session-store.js';
import { wechatRoutes } from '../src/server/wechat-routes.js';

for (const [scheme, secure] of [['http', false], ['https', true]] as const) {
  test(`QR flow cookie authorizes polling over ${scheme} with transport-appropriate security`, async (t) => {
    const store = new WechatSessionStore(':memory:');
    t.after(() => store.close());
    const login = new WechatLoginService(store, {
      createQr: async () => ({
        qrPayload: 'qr',
        pollStatus: async () => ({ status: 'confirmed', credentials: {
          ownerIlinkUserId: 'alice', botId: 'bot', botToken: 'token', baseUrl: 'https://example.test/',
        } }),
      }),
    });
    const app = new Hono().route('/api', wechatRoutes({ login, qrSvg: () => '<svg/>' }));
    const url = `${scheme}://192.0.2.1/api/wechat/qrcode`;
    const start = await app.request(url, { method: 'POST', headers: {
      'x-forwarded-proto': secure ? 'http' : 'https',
      forwarded: `proto=${secure ? 'http' : 'https'}`,
    } });
    assert.equal(start.status, 201);
    const cookie = start.headers.get('set-cookie');
    assert.ok(cookie);
    for (const attribute of ['HttpOnly', 'SameSite=Strict', 'Path=/api/wechat', 'Max-Age=600']) {
      assert.ok(cookie.includes(attribute));
    }
    assert.equal(/(?:^|;\s*)Secure(?:;|$)/i.test(cookie), secure);
    const attempt: { attemptId: string } = await start.json();
    const unauthorized = await app.request(`${url}/${attempt.attemptId}`);
    assert.equal(unauthorized.status, 404);
    const poll = await app.request(`${url}/${attempt.attemptId}`, { headers: { cookie: cookie.split(';')[0] } });
    assert.equal(poll.status, 200);
    assert.deepEqual(await poll.json(), { status: 'confirmed' });
    assert.ok(store.getBinding('alice'));
  });
}
