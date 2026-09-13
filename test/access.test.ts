import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { accessGuard, webCredentials, type WebCredentials } from '../src/server/access.js';

function authorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function app(credentials: WebCredentials | null) {
  const app = new Hono();
  app.use('*', accessGuard(credentials));
  app.get('/api/state', (c) => c.json({ ok: true }));
  app.post('/api/config', (c) => c.json({ ok: true }));
  return app;
}

test('未配置认证时 API 放行但保留安全响应头', async () => {
  const response = await app(null).request('/api/state');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('配置自定义用户名密码时要求匹配的 Basic Auth', async () => {
  const credentials = { username: 'alice', password: 'synthetic-password' };
  assert.equal((await app(credentials).request('/api/state')).status, 401);
  const response = await app(credentials).request('/api/state', {
    headers: { authorization: authorization('alice', 'synthetic-password') },
  });
  assert.equal(response.status, 200);
});

test('环境变量控制认证，密码存在时用户名默认为 quotahot', (t) => {
  const previousUsername = process.env.QUOTAHOT_AUTH_USERNAME;
  const previousPassword = process.env.QUOTAHOT_AUTH_PASSWORD;
  t.after(() => {
    if (previousUsername === undefined) delete process.env.QUOTAHOT_AUTH_USERNAME;
    else process.env.QUOTAHOT_AUTH_USERNAME = previousUsername;
    if (previousPassword === undefined) delete process.env.QUOTAHOT_AUTH_PASSWORD;
    else process.env.QUOTAHOT_AUTH_PASSWORD = previousPassword;
  });

  delete process.env.QUOTAHOT_AUTH_USERNAME;
  delete process.env.QUOTAHOT_AUTH_PASSWORD;
  assert.equal(webCredentials(), null);

  process.env.QUOTAHOT_AUTH_PASSWORD = 'configured-password';
  assert.deepEqual(webCredentials(), { username: 'quotahot', password: 'configured-password' });

  process.env.QUOTAHOT_AUTH_USERNAME = 'configured-user';
  assert.deepEqual(webCredentials(), { username: 'configured-user', password: 'configured-password' });

  delete process.env.QUOTAHOT_AUTH_PASSWORD;
  assert.throws(() => webCredentials(), /QUOTAHOT_AUTH_PASSWORD/);
});

test('跨站请求即使带有浏览器缓存的密码也被拒绝', async () => {
  const response = await app({ username: 'alice', password: 'synthetic-password' }).request('/api/config', {
    method: 'POST',
    headers: {
      authorization: authorization('alice', 'synthetic-password'),
      origin: 'https://untrusted.example',
      'sec-fetch-site': 'cross-site',
    },
  });
  assert.equal(response.status, 403);
});
