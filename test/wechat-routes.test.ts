import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { WechatLoginService, type WechatLoginOptions } from '../src/server/wechat-login-service.js';
import { WechatSessionStore } from '../src/server/wechat-session-store.js';
import { WechatClawbotClient, WechatClawbotError, type QrLoginStatus } from '../src/server/wechat-clawbot-client.js';
import { HttpResponse, request } from '../src/server/http.js';
import { Readable } from 'node:stream';
import { wechatRoutes } from '../src/server/wechat-routes.js';
import { assertContractResponse, contract, record } from './helpers/wechat-inbox-contract.js';

const origin = Date.parse('2026-10-19T12:00:00Z');
const credentials = { ownerIlinkUserId: 'alice', botId: 'bot', botToken: 'secret-bot-token', baseUrl: 'https://private.invalid/' };
const confirmed = { status: 'confirmed', credentials } as const;
const cookieName = 'quotahot_wechat';
const flowCookieName = 'quotahot_wechat_flow';

function fixture(t: TestContext, lifecycle: Pick<WechatLoginOptions, 'beforeBindingChange' | 'afterBindingChange'> = {}) {
  const sessions = new WechatSessionStore(':memory:');
  t.after(() => sessions.close());
  let now = origin;
  let reply: () => Promise<QrLoginStatus> = async () => confirmed;
  const rendered: string[] = [];
  const client = { createQr: async () => ({ qrPayload: 'private-qr-payload', pollStatus: () => reply() }) };
  const login = new WechatLoginService(sessions, client, { now: () => now, ...lifecycle });
  const app = new Hono();
  app.route('/api', wechatRoutes({ login,
    qrSvg: (payload: string) => { rendered.push(payload); return '<svg xmlns="http://www.w3.org/2000/svg"/>'; } }));
  const request = (path: string, init: RequestInit = {}) => app.request(`http://localhost/api/wechat${path}`, init);
  const browser = async (owner = 'alice') => {
    reply = async () => ({ ...confirmed, credentials: { ...credentials, ownerIlinkUserId: owner } });
    const start = await request('/qrcode', { method: 'POST' });
    const attempt: unknown = await start.json();
    assert.ok(attempt && typeof attempt === 'object' && 'attemptId' in attempt && typeof attempt.attemptId === 'string');
    const flowCookie = start.headers.get('set-cookie')?.split(';')[0];
    assert.ok(flowCookie);
    const response = await request(`/qrcode/${attempt.attemptId}`, authenticated(flowCookie));
    assert.deepEqual(await response.json(), { status: 'confirmed' });
    assert.equal(response.headers.get('set-cookie'), null);
    return `${cookieName}=obsolete-${owner}`;
  };
  return { app, request, browser, sessions, login, rendered, client,
    time: (value: number) => { now = value; }, reply: (value: () => Promise<QrLoginStatus>) => { reply = value; } };
}

const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const authenticated = (cookie: string, init: RequestInit = {}): RequestInit => ({ ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), cookie } });

test('does not expose per-binding QR checks for persisted bindings or legacy cookies', async (t) => {
  const f = fixture(t);
  const cookie = await f.browser();

  for (const headers of [new Headers(), new Headers({ cookie })]) {
    const response = await f.request('/bindings/alice/check', { method: 'POST', headers });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(Object.hasOwn(record(contract.paths), '/bindings/{bindingId}/check'), false);
  assert.equal(Object.hasOwn(record(record(contract.components).schemas), 'BindingCheck'), false);
});

for (const [error, status, code] of [
  [new WechatClawbotError('auth_required', 401), 502, 'wechat_upstream_auth_failed'],
  [new WechatClawbotError('auth_required', 403), 502, 'wechat_upstream_auth_failed'],
  [new WechatClawbotError('http_failure', 503), 502, 'wechat_upstream_unavailable'],
  [new WechatClawbotError('request_failed'), 502, 'wechat_upstream_unavailable'],
  [new WechatClawbotError('invalid_response'), 502, 'wechat_upstream_unavailable'],
] as const) {
  for (const phase of ['create', 'poll'] as const) {
    test(`returns safe ${code}/${error instanceof WechatClawbotError ? error.httpStatus : ''} during ${phase}`, async (t) => {
      const f = fixture(t);
      const attempt = phase === 'poll' ? await f.login.start() : undefined;
      Object.assign(error, { cause: new Error('secret-bot-token private-qr-payload'),
        headers: { 'X-Signature': 'signature-sentinel' }, body: 'upstream-body-sentinel' });
      const fail = async (): Promise<never> => { throw error; };
      if (phase === 'create') f.client.createQr = fail;
      else f.reply(fail);

      const response = attempt ? await f.request(`/qrcode/${attempt.attemptId}`, authenticated(`${flowCookieName}=${attempt.flowToken}`))
          : await f.request('/qrcode', { method: 'POST' });

      const transient = error instanceof WechatClawbotError && error.code !== 'auth_required' && phase !== 'create';
      assert.equal(response.status, transient ? 200 : status);
      const body: unknown = await response.json();
      if (!transient) assert.deepEqual(body, { error: code });
      else assert.deepEqual(body, { status: 'unverified' });
      assert.doesNotMatch(JSON.stringify(body), /secret-bot-token|private-qr-payload|signature-sentinel|upstream-body-sentinel|X-Signature|cause|headers/);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(f.sessions.getBinding('alice'), null);
    });
  }
}

test('returns a safe identity-specific error when QR creation throws identity_missing', async (t) => {
  const f = fixture(t);
  const prior = await f.browser();
  const bindings = f.sessions.listBindings();
  const error = Object.assign(new WechatClawbotError('identity_missing'), {
    cause: new Error('secret-bot-token private-qr-payload'),
    headers: { 'X-Signature': 'signature-sentinel' }, body: 'upstream-body-sentinel',
  });
  f.client.createQr = async () => { throw error; };

  const response = await f.request('/qrcode', authenticated(prior, { method: 'POST' }));

  assert.equal(response.status, 502);
  const body: unknown = await response.json();
  assert.deepEqual(body, { error: 'wechat_identity_missing' });
  assert.doesNotMatch(JSON.stringify(body), /secret-bot-token|private-qr-payload|signature-sentinel|upstream-body-sentinel|X-Signature|cause|headers/);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(f.sessions.listBindings(), bindings);
  assert.equal((await f.request('/session', authenticated(prior))).status, 404);
  assert.equal((await f.request('/session')).status, 404);
});

for (const ilink_user_id of [undefined, null, '', ' \t\n']) {
  test(`live HTTP maps missing QR identity ${JSON.stringify(ilink_user_id)} to a safe identity-specific error`, async (t) => {
    const f = fixture(t);
    const prior = await f.browser();
    const other = await f.browser('bob');
    const bindings = f.sessions.listBindings();
    let calls = 0;
    const client = new WechatClawbotClient(async () => {
        calls++;
        const qrcode = 'private-qr-payload';
        return new HttpResponse(200, new Headers(), Readable.from([JSON.stringify(calls === 1
          ? { ret: 0, qrcode, qrcode_img_content: `https://liteapp.weixin.qq.com/q/test?qrcode=${qrcode}&bot_type=3` }
          : { ret: 0, status: 'confirmed', ilink_user_id, ilink_bot_id: 'bot', bot_token: credentials.botToken,
            baseurl: credentials.baseUrl })]));
      });
    const login = new WechatLoginService(f.sessions, client, { now: () => origin });
    const app = new Hono().route('/api', wechatRoutes({ ...f, login, qrSvg: () => '<svg/>' }));
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/api/wechat`;
    const start = await fetch(`${base}/qrcode`, authenticated(prior, { method: 'POST' }));
    const attempt: { attemptId: string } = await start.json();
    const flow = start.headers.get('set-cookie')?.split(';')[0];
    assert.ok(flow);

    const response = await fetch(`${base}/qrcode/${attempt.attemptId}`, authenticated(`${prior}; ${flow}`));

    assert.equal(response.status, 502);
    const body: unknown = await response.json();
    assert.deepEqual(body, { error: 'wechat_identity_missing' });
    assert.doesNotMatch(JSON.stringify(body), /secret-bot-token|private-qr-payload|private\.invalid|bot_token|browserToken|flowToken/);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(f.sessions.listBindings(), bindings);
    for (const cookie of [prior, other]) assert.equal((await fetch(`${base}/session`, authenticated(cookie))).status, 404);
    assert.equal((await fetch(`${base}/session`)).status, 404);
    const repeated = await fetch(`${base}/qrcode/${attempt.attemptId}`, authenticated(flow));
    assert.equal(repeated.status, 404);
    assert.deepEqual(await repeated.json(), { status: 'unavailable' });
    assert.equal(calls, 2);
  });
}

test('rejects polling a known attempt from a different browser without issuing or clearing cookies', async (t) => {
  const f = fixture(t);
  const start = await f.request('/qrcode', { method: 'POST' });
  const attempt: { attemptId: string } = await start.json();

  const response = await f.request(`/qrcode/${attempt.attemptId}`, authenticated(`${flowCookieName}=foreign`));

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { status: 'unavailable' });
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(f.sessions.getBinding('alice'), null);
});

test('wrong-browser cancel cannot cancel the initiating browser flow', async (t) => {
  const f = fixture(t);
  const start = await f.request('/qrcode', { method: 'POST' });
  const attempt: { attemptId: string } = await start.json();
  const flowCookie = start.headers.get('set-cookie')?.split(';')[0] ?? '';

  const cancelled = await f.request(`/qrcode/${attempt.attemptId}`, authenticated(`${flowCookieName}=foreign`, { method: 'DELETE' }));

  assert.equal(cancelled.status, 404);
  assert.equal(cancelled.headers.get('set-cookie'), null);
  const confirmedResponse = await f.request(`/qrcode/${attempt.attemptId}`, authenticated(flowCookie));
  assert.equal(confirmedResponse.status, 200);
  assert.equal((await confirmedResponse.json()).status, 'confirmed');
});

test('a legacy browser cookie cannot poll or cancel a QR flow without its flow cookie', async (t) => {
  const f = fixture(t);
  const start = await f.request('/qrcode', { method: 'POST' });
  const attempt: { attemptId: string } = await start.json();
  const flow = start.headers.get('set-cookie')?.split(';')[0];
  assert.ok(flow);

  for (const method of ['GET', 'DELETE']) {
    const response = await f.request(`/qrcode/${attempt.attemptId}`, authenticated(`${cookieName}=legacy`, { method }));
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { status: 'unavailable' });
    assert.equal(response.headers.get('set-cookie'), null);
  }
  const confirmation = await f.request(`/qrcode/${attempt.attemptId}`, authenticated(`${cookieName}=legacy; ${flow}`));
  assert.deepEqual(await confirmation.json(), { status: 'confirmed' });
  assert.equal(confirmation.headers.get('set-cookie'), null);
});

test('renders QR locally without fetching an external image or returning the raw payload', async (t) => {
  const f = fixture(t);
  t.mock.method(globalThis, 'fetch', () => { throw new Error('external image request'); });
  const response = await f.request('/qrcode', { method: 'POST' });
  const body: unknown = await response.json();
  assert.equal(response.status, 201);
  assert.deepEqual(f.rendered, ['private-qr-payload']);
  assert.ok(body && typeof body === 'object' && 'expiresAt' in body && 'qrSvg' in body);
  assert.equal(body.expiresAt, origin + 600_000);
  assert.match(String(body.qrSvg), /^<svg/);
  assert.doesNotMatch(JSON.stringify(body), /private-qr-payload|secret-bot-token|browserToken|flowToken/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie);
  assert.match(cookie, new RegExp(`^${flowCookieName}=[A-Za-z0-9_-]{43};`));
  for (const attribute of ['HttpOnly', 'SameSite=Strict', 'Path=/api/wechat', 'Max-Age=600']) assert.ok(cookie.includes(attribute));
});

test('confirms a binding without issuing a persistent browser cookie or session expiry', async (t) => {
  const f = fixture(t);
  const attempt = await f.login.start();
  const response = await f.request(`/qrcode/${attempt.attemptId}`, authenticated(`${flowCookieName}=${attempt.flowToken}`));
  const cookie = response.headers.get('set-cookie');
  assert.equal(cookie, null);
  assert.equal(response.headers.getSetCookie().some((value) => value.startsWith(`${flowCookieName}=;`)), false);
  assert.deepEqual(await response.json(), { status: 'confirmed' });
  const repeated = await f.request(`/qrcode/${attempt.attemptId}`);
  assert.equal(repeated.headers.get('set-cookie'), null);
  assert.deepEqual(await repeated.json(), { status: 'unavailable' });
});

for (const status of ['waiting', 'scanned', 'expired'] as const) {
  test(`does not authenticate a browser when the QR poll is ${status}`, async (t) => {
    const f = fixture(t);
    f.reply(async () => ({ status }));
    const attempt = await f.login.start();
    const response = await f.request(`/qrcode/${attempt.attemptId}`, authenticated(`${flowCookieName}=${attempt.flowToken}`));
    assert.deepEqual(await response.json(), { status });
  assert.equal(response.headers.get('set-cookie'), null);
  });
}

test('cancels attempts and enforces the ten minute boundary through HTTP', async (t) => {
  const f = fixture(t);
  const cancelled = await f.login.start();
  const cancellation = await f.request(`/qrcode/${cancelled.attemptId}`, authenticated(`${flowCookieName}=${cancelled.flowToken}`, { method: 'DELETE' }));
  assert.equal(cancellation.headers.get('set-cookie'), null);
  assert.deepEqual(await (await f.request(`/qrcode/${cancelled.attemptId}`)).json(), { status: 'unavailable' });
  const expired = await f.login.start();
  f.time(origin + 600_000);
  assert.deepEqual(await (await f.request(`/qrcode/${expired.attemptId}`, authenticated(`${flowCookieName}=${expired.flowToken}`))).json(), { status: 'expired' });
});

for (const [path, method] of [['/session', 'GET'], ['/session', 'DELETE'], ['/binding', 'GET'], ['/binding/check', 'POST'], ['/binding', 'DELETE']] as const) {
  test(`removes obsolete route ${method} ${path} even with legacy cookies`, async (t) => {
    const f = fixture(t);
    const cookie = await f.browser();
    f.time(origin + 43_200_000);
    for (const headers of [new Headers(), new Headers({ cookie: `${cookieName}=forged` }), new Headers({ cookie })]) {
      const response = await f.request(`${path}?owner=alice`, { method, headers });
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  });
}

test('binding unlink without cookies pauses immediately and awaits only its owner drain', { timeout: 2000 }, async (t) => {
  let hold = false;
  let release: () => void = () => assert.fail('drain not entered');
  let entered: () => void = () => assert.fail('wait not initialized');
  const draining = new Promise<void>((resolve) => { entered = resolve; });
  const transitions: string[] = [];
  const f = fixture(t, { beforeBindingChange: async (owner) => {
    transitions.push(`before:${owner}`);
    if (hold) await new Promise<void>((resolve) => { release = resolve; entered(); });
  }, afterBindingChange: (owner) => { transitions.push(`after:${owner}`); } });
  await f.browser();
  await f.browser('bob');
  transitions.length = 0;
  hold = true;
  let completed = false;
  const unlinking = Promise.resolve(f.request('/bindings/alice?owner=bob', { method: 'DELETE' })).then((response) => {
    completed = true; return response;
  });
  await draining;
  assert.equal(f.sessions.isBindingPaused('alice'), true);
  assert.equal(f.sessions.isBindingPaused('bob'), false);
  assert.equal(completed, false);
  release();
  assert.equal((await unlinking).status, 200);
  assert.equal(f.sessions.getBinding('alice'), null);
  assert.ok(f.sessions.getBinding('bob'));
  assert.deepEqual(transitions, ['before:alice', 'after:alice']);
});

test('missing binding management returns safe 404 without invoking lifecycle hooks', async (t) => {
  const changes: string[] = [];
  const f = fixture(t, { beforeBindingChange: async (owner) => { changes.push(owner); } });
  for (const [path, method] of [['/bindings/missing', 'DELETE']] as const) {
    const response = await f.request(path, { method });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'wechat_binding_not_found' });
    assert.equal(response.headers.get('set-cookie'), null);
  }
  assert.deepEqual(changes, []);
});

test('matches binding management routes to OpenAPI paths on the wechat server', (t) => {
  const f = fixture(t);
  const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);
  const declared = Object.entries(record(contract.paths)).flatMap(([path, entry]) => {
    const item = record(entry);
    const servers = item.servers ?? contract.servers;
    assert.ok(Array.isArray(servers) && servers.length > 0);
    const prefix = record(servers[0]).url;
    assert.equal(typeof prefix, 'string');
    if (prefix !== '/api/wechat') return [];
    return Object.keys(item).filter((method) => methods.has(method)).map((method) =>
      `${method.toUpperCase()} ${prefix}${path.replace(/\{([^}]+)\}/g, ':$1')}`);
  });
  const actual = f.app.routes.filter((route) => route.method !== 'ALL'
    && route.path.startsWith('/api/wechat/bindings/')).map((route) => `${route.method} ${route.path}`);
  assert.deepEqual([...new Set(actual)].sort(), declared.sort());
});

test('does not register the standalone local conversation API for authenticated QR sessions', async (t) => {
  const f = fixture(t);
  const alice = await f.browser();
  for (const [path, method] of [['/conversations', 'GET'], ['/conversations', 'POST'],
    ['/conversations/any', 'GET'], ['/conversations/any', 'DELETE'], ['/conversations/any/messages', 'POST']] as const) {
    const response = await f.request(path, authenticated(alice, { method, ...(method === 'POST' ? json({ title: 'local' }) : {}) }));
    assert.equal(response.status, 404);
  }
});

test('unlink requires no browser cookie and leaves other bindings active', async (t) => {
  const f = fixture(t);
  await f.browser();
  await f.browser('bob');
  const response = await f.request('/bindings/alice', { method: 'DELETE' });
  assert.equal(response.status, 200);
  await assertContractResponse(response.clone(), ['DELETE', '/bindings/{bindingId}']);
  assert.deepEqual(await response.json(), { status: 'unlinked' });
  assert.equal(f.sessions.getBinding('alice'), null);
  assert.ok(f.sessions.getBinding('bob'));
});

for (const body of [null, [], { owner: 'mallory' }, { ownerIlinkUserId: 'mallory' }, { token: 'secret-bot-token' }]) {
  test(`rejects unexpected QR request body ${JSON.stringify(body)}`, async (t) => {
    const f = fixture(t);
    assert.equal((await f.request('/qrcode', json(body))).status, 400);
    assert.deepEqual(f.rendered, []);
  });
}

test('rejects malformed JSON and caller identity on all authenticated mutations', async (t) => {
  const f = fixture(t);
  const cookie = await f.browser();
  const malformed = await f.request('/qrcode', { method: 'POST', body: '{secret-bot-token' });
  assert.equal(malformed.status, 400);
  assert.doesNotMatch(await malformed.text(), /secret-bot-token/);
  for (const path of ['/bindings/alice', '/qrcode/any']) {
    const init = { ...json({ ownerIlinkUserId: 'mallory' }), method: 'DELETE' };
    assert.equal((await f.request(path, authenticated(cookie, init))).status, 400);
  }
});

for (const source of ['upstream', 'renderer']) test(`sanitizes ${source} failures containing credentials`, async (t) => {
  const f = fixture(t);
  const fail = () => { throw new Error('secret-bot-token private-qr-payload'); };
  if (source === 'upstream') f.client.createQr = fail;
  const app = new Hono();
  app.route('/api', wechatRoutes({ ...f, qrSvg: fail }));
  const response = await app.request('/api/wechat/qrcode', { method: 'POST' });
  assert.equal(response.status, 500);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { error: 'wechat_internal_error' });
});

test('serves the mounted router over live HTTP with private no-store and unauthenticated errors', async (t) => {
  const f = fixture(t);
  const cookie = await f.browser();
  const server = serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0 });
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  for (const headers of [new Headers({ cookie }), new Headers()]) {
    const response: Response = await fetch(`http://127.0.0.1:${address.port}/api/wechat/session`, { headers });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  const url = `http://127.0.0.1:${address.port}/api/wechat/qrcode`;
  const start = await fetch(url, { method: 'POST' });
  const attempt: { attemptId: string } = await start.json();
  const flowCookie = start.headers.get('set-cookie')?.split(';')[0];
  assert.ok(flowCookie);
  for (const headers of [new Headers(), new Headers({ cookie: `${flowCookieName}=foreign` })]) {
    const rejected = await fetch(`${url}/${attempt.attemptId}`, { headers });
    assert.equal(rejected.status, 404);
    assert.equal(rejected.headers.get('set-cookie'), null);
  }
  const confirmedResponse = await fetch(`${url}/${attempt.attemptId}`, { headers: { cookie: flowCookie } });
  assert.equal((await confirmedResponse.json()).status, 'confirmed');
  assert.equal(confirmedResponse.headers.get('set-cookie'), null);
  const checked = await fetch(`http://127.0.0.1:${address.port}/api/wechat/bindings/alice/check`, { method: 'POST' });
  assert.equal(checked.status, 404);
  const unlinked = await fetch(`http://127.0.0.1:${address.port}/api/wechat/bindings/alice`, { method: 'DELETE' });
  assert.deepEqual(await unlinked.json(), { status: 'unlinked' });
});

test('rotates the anonymous browser flow cookie and rejects its replaced attempt', async (t) => {
  const f = fixture(t);
  const first = await f.request('/qrcode', { method: 'POST' });
  const older: { attemptId: string } = await first.json();
  const olderCookie = first.headers.get('set-cookie')?.split(';')[0];
  assert.ok(olderCookie);

  const second = await f.request('/qrcode', authenticated(olderCookie, { method: 'POST' }));

  const newer: { attemptId: string } = await second.json();
  const newerCookie = second.headers.get('set-cookie')?.split(';')[0];
  assert.ok(newerCookie);
  assert.notEqual(newerCookie, olderCookie);
  for (const [id, cookie] of [[older.attemptId, olderCookie], [older.attemptId, newerCookie], [newer.attemptId, olderCookie]] as const) {
    const response = await f.request(`/qrcode/${id}`, authenticated(cookie));
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('set-cookie'), null);
  }
  const response = await f.request(`/qrcode/${newer.attemptId}`, authenticated(newerCookie));
  assert.equal((await response.json()).status, 'confirmed');
});

test('iLink QR lifecycle without system credentials saves binding across upstream failures and recovery', async (t) => {
  const f = fixture(t);
  const qrcode = 'local-qr-capability-sentinel';
  const payload = `https://liteapp.weixin.qq.com/q/test-slug?qrcode=${qrcode}&bot_type=3`;
  const calls: { path: string | undefined; body: string; method: string | undefined }[] = [];
  let upstreamStatus = 200;
  const upstream = createServer(async (incoming, response) => {
    let body = '';
    for await (const chunk of incoming) body += chunk;
    calls.push({ path: incoming.url, body, method: incoming.method });
    assert.equal(incoming.headers['x-signature'], undefined);
    assert.equal(incoming.headers['x-appid'], undefined);
    if (incoming.method === 'POST') {
      assert.equal(incoming.headers['ilink-app-id'], 'bot');
      assert.equal(incoming.headers['ilink-app-clientversion'], '131584');
      assert.equal(incoming.headers['content-type'], 'application/x-www-form-urlencoded');
    }
    response.writeHead(upstreamStatus);
    response.end(JSON.stringify(upstreamStatus !== 200 ? { message: `${credentials.botToken} ${qrcode}` }
      : incoming.method === 'GET'
        ? { ret: 0, qrcode, qrcode_img_content: payload }
        : { ret: 0, status: 'confirmed', ilink_user_id: 'alice', ilink_bot_id: 'bot', bot_token: credentials.botToken,
          baseurl: credentials.baseUrl }));
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    upstream.closeAllConnections();
    upstream.close((error) => error ? reject(error) : resolve());
  }));
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const client = new WechatClawbotClient((url, options) => {
    const target = new URL(url);
    assert.equal(target.origin, 'https://ilinkai.weixin.qq.com');
    return request(`http://127.0.0.1:${address.port}${target.pathname}${target.search}`, options);
  });
  const transitions: string[] = [];
  const login = new WechatLoginService(f.sessions, client, { now: () => origin,
    beforeBindingChange: async (owner) => { transitions.push(`before:${owner}`); },
    afterBindingChange: (owner) => { transitions.push(`after:${owner}`); },
  });
  const app = new Hono().route('/api', wechatRoutes({ ...f, login, qrSvg: () => '<svg/>' }));
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await once(server, 'listening');
  const browserAddress = server.address();
  assert.ok(browserAddress && typeof browserAddress !== 'string');
  const base = `http://127.0.0.1:${browserAddress.port}/api/wechat`;

  const start = await fetch(`${base}/qrcode`, { method: 'POST' });
  assert.equal(start.status, 201);
  const attempt: { attemptId: string } = await start.json();
  assert.doesNotMatch(JSON.stringify(attempt), /local-qr-capability-sentinel|secret-bot-token|bot_token|qrcode/);
  assert.equal(start.headers.get('cache-control'), 'no-store');
  const flow = start.headers.get('set-cookie')?.split(';')[0];
  assert.ok(flow);
  upstreamStatus = 503;
  const transient = await fetch(`${base}/qrcode/${attempt.attemptId}`, authenticated(flow));
  assert.deepEqual(await transient.json(), { status: 'unverified' });
  upstreamStatus = 401;
  const rejected = await fetch(`${base}/qrcode/${attempt.attemptId}`, authenticated(flow));
  assert.equal(rejected.status, 502);
  assert.deepEqual(await rejected.json(), { error: 'wechat_upstream_auth_failed' });
  upstreamStatus = 200;
  const confirmation = await fetch(`${base}/qrcode/${attempt.attemptId}`, authenticated(flow));
  assert.deepEqual(await confirmation.json(), { status: 'confirmed' });
  assert.equal(confirmation.headers.get('cache-control'), 'no-store');
  assert.equal(confirmation.headers.get('set-cookie'), null);
  assert.doesNotMatch(flow, /local-qr-capability-sentinel|secret-bot-token/);
  assert.deepEqual(f.sessions.getBinding('alice'), { ...credentials, createdAt: origin, updatedAt: origin });
  assert.deepEqual(transitions, ['before:alice', 'after:alice']);
  assert.equal((await fetch(`${base}/bindings/alice/check`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${base}/session`)).status, 404);
  assert.deepEqual(calls, [
    { path: '/ilink/bot/get_bot_qrcode?bot_type=3', method: 'GET', body: '' },
    ...Array.from({ length: 3 }, () => ({ path: '/ilink/bot/get_qrcode_status', method: 'POST', body: new URLSearchParams({ qrcode }).toString() })),
  ]);
});
