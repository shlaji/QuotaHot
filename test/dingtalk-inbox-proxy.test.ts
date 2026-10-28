import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { dingtalkInboxProxyRoutes } from '../src/server/dingtalk-inbox-proxy/routes.js';

const prefix = '/api/dingtalk-inbox';
const token = 'server-only-secret';
function setup(fetch: (request: Request) => Promise<Response>, baseUrl = 'http://inbox.invalid/api/v1') {
  return new Hono().route(prefix, dingtalkInboxProxyRoutes({ baseUrl, token, fetch }));
}

for (const [method, path] of [
  ['GET', '/capability'], ['GET', '/people/search'], ['GET', '/groups/search'],
  ['GET', '/active-target'], ['PUT', '/active-target'], ['DELETE', '/active-target'],
  ['GET', '/messages'], ['POST', '/messages'], ['GET', '/events'],
]) {
  test(`forwards ${method} ${path} with the API root and original query`, async () => {
    const calls: Request[] = [];
    const app = setup(async (request) => { calls.push(request); return new Response(null, { status: 204 }); },
      'http://inbox.invalid/api/v1/');
    const query = '?query=%E5%BC%A0+san&before=a%2Fb&query=second';
    const response = await app.request(`${prefix}${path}${query}`, { method });
    assert.equal(response.status, 204);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, `http://inbox.invalid/api/v1${path}${query}`);
    assert.equal(calls[0]?.method, method);
    assert.equal(calls[0]?.redirect, 'manual');
  });
}

for (const [method, path] of [
  ['PATCH', '/active-target'], ['POST', '/events'], ['HEAD', '/messages'],
  ['OPTIONS', '/capability'], ['GET', '/unknown'], ['GET', '/messages/extra'],
  ['GET', '/people/search/'], ['GET', '//capability'],
]) {
  test(`rejects unsupported ${method} ${path} without calling upstream`, async () => {
    let calls = 0;
    const app = setup(async () => { calls++; return new Response(); });
    const response = await app.request(`${prefix}${path}`, { method });
    assert.ok(response.status === 404 || response.status === 405);
    assert.equal(calls, 0);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });
}

for (const [method, path] of [['PUT', '/active-target'], ['POST', '/messages']]) {
  test(`forwards only necessary request headers and the original ${method} body`, async () => {
    const body = '{ "targetType": "person", "targetId": "id", "text": "hello" }';
    const calls: Request[] = [];
    const app = setup(async (request) => { calls.push(request); return new Response('{}'); });
    await app.request(`${prefix}${path}`, { method, body, headers: {
      authorization: 'Basic browser-secret', cookie: 'session=browser-cookie',
      'content-type': 'application/json; charset=utf-8', accept: 'application/json',
      'x-injected': 'untrusted', origin: 'http://browser.invalid',
    } });
    assert.equal(calls.length, 1);
    const request = calls[0];
    assert.ok(request);
    assert.equal(await request.text(), body);
    assert.deepEqual([...request.headers].sort(), [
      ['accept', 'application/json'], ['authorization', `Bearer ${token}`],
      ['content-type', 'application/json; charset=utf-8'],
    ]);
  });
}

test('preserves upstream error status and content type without exposing upstream headers', async () => {
  const app = setup(async () => new Response('{"error":"unavailable"}', { status: 503, headers: {
    'content-type': 'application/problem+json', authorization: `Bearer ${token}`,
    'set-cookie': 'service=secret', 'x-debug': token, 'cache-control': 'public',
    'access-control-allow-origin': '*', location: 'http://private.invalid',
  } }));
  const response = await app.request(`${prefix}/capability`);
  assert.equal(response.status, 503);
  assert.deepEqual([...response.headers].sort(), [
    ['cache-control', 'no-store'], ['content-type', 'application/problem+json'],
    ['x-content-type-options', 'nosniff'],
  ]);
  assert.equal(await response.text(), '{"error":"unavailable"}');
});

test('returns a sanitized gateway error when transport throws secrets', async () => {
  const app = setup(async () => { throw new TypeError(`connect failed ${token} http://private.invalid`); });
  const response = await app.request(`${prefix}/capability`);
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(await response.json(), { error: 'dingtalk_inbox_upstream_unavailable' });
  assert.doesNotMatch(JSON.stringify([...response.headers]), /server-only-secret|private.invalid/);
});

test('passes the open SSE body directly and cancellation reaches the upstream source', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: first\n\n')); },
    cancel() { cancelled = true; },
  });
  const app = setup(async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
  const response = await app.request(`${prefix}/events`);
  assert.equal(response.body, stream);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  assert.ok(response.body);
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n');
  await reader.cancel();
  assert.equal(cancelled, true);
});

test('propagates client abort while upstream fetch is pending', async () => {
  const client = new AbortController();
  const started = Promise.withResolvers<Request>();
  const app = setup((request) => {
    started.resolve(request);
    return new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
    });
  });
  const pending = app.request(new Request(`http://browser.invalid${prefix}/events`, { signal: client.signal }));
  const upstream = await started.promise;
  client.abort();
  await pending;
  assert.equal(upstream.signal.aborted, true);
});

test('keeps request abort connected after SSE headers arrive', async () => {
  const client = new AbortController();
  const calls: Request[] = [];
  const app = setup(async (request) => {
    calls.push(request);
    return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
  });
  const response = await app.request(new Request(`http://browser.invalid${prefix}/events`, { signal: client.signal }));
  client.abort();
  assert.equal(calls[0]?.signal.aborted, true);
  await response.body?.cancel();
});
