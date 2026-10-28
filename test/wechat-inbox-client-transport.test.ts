import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { HttpResponse, request, type FetchOptions } from '../src/server/http.js';
import { IlinkBotClient, IlinkClientError } from '../src/server/wechat-inbox/client.js';

const binding = { baseUrl: 'https://first.example.test/', botToken: 'bot-secret-sentinel' };
const secrets = ['bot-secret-sentinel', 'context-secret', 'cdn-secret', 'upload-secret', 'raw-secret', 'typing-secret'];
const empty = '{"ret":0,"msgs":[],"get_updates_buf":"next"}';

function fixture(body = empty, status = 200) {
  const calls: { url: string; options: FetchOptions }[] = [];
  const transport: typeof request = async (url, options = {}) => {
    calls.push({ url, options });
    return new HttpResponse(status, new Headers(), Readable.from([body]));
  };
  return { client: new IlinkBotClient(binding, transport), calls, transport };
}

function safeError(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof IlinkClientError);
    assert.equal(error.code, code);
    assert.equal(error.cause, undefined);
    for (const secret of secrets) assert.equal(`${inspect(error)} ${JSON.stringify(error)}`.includes(secret), false);
    return true;
  };
}

test('getUpdates sends binding-scoped iLink authentication without Gateway signing or audit', async () => {
  const { client, calls } = fixture();
  const signal = new AbortController().signal;
  await client.getUpdates('opaque-cursor', { timeoutMs: 42_000, signal });
  assert.equal(calls[0]?.url, 'https://first.example.test/ilink/bot/getupdates');
  assert.equal(calls[0]?.options.method, 'POST');
  assert.equal(calls[0]?.options.timeoutMs, 42_000);
  assert.equal(calls[0]?.options.signal, signal);
  assert.equal(calls[0]?.options.followRedirects, false);
  assert.equal(calls[0]?.options.audit, undefined);
  assert.deepEqual(JSON.parse(String(calls[0]?.options.body)), {
    get_updates_buf: 'opaque-cursor', base_info: { channel_version: '2.2.0' },
  });
  const headers = new Headers(calls[0]?.options.headers);
  assert.equal(headers.get('Authorization'), `Bearer ${binding.botToken}`);
  assert.equal(headers.get('AuthorizationType'), 'ilink_bot_token');
  assert.equal(headers.get('iLink-App-Id'), 'bot');
  assert.equal(headers.get('iLink-App-ClientVersion'), '131584');
  assert.equal(headers.get('Content-Type'), 'application/json');
  for (const name of ['X-Signature', 'X-APPID', 'X-API-KEY', 'X-Nonce', 'X-Timestamp']) {
    assert.equal(headers.has(name), false);
  }
});

test('independent clients use their own base URL and token, with fresh secure request identities', async () => {
  const { client, calls, transport } = fixture();
  const other = new IlinkBotClient({ baseUrl: 'https://second.example.test/prefix/', botToken: 'other-token' }, transport);
  await Promise.all([client.getUpdates(), client.getUpdates(), other.getUpdates()]);
  assert.deepEqual(calls.map(({ url }) => url), [
    'https://first.example.test/ilink/bot/getupdates', 'https://first.example.test/ilink/bot/getupdates',
    'https://second.example.test/prefix/ilink/bot/getupdates',
  ]);
  assert.deepEqual(calls.map(({ options }) => new Headers(options.headers).get('Authorization')),
    [`Bearer ${binding.botToken}`, `Bearer ${binding.botToken}`, 'Bearer other-token']);
  const uins = calls.map(({ options }) => new Headers(options.headers).get('X-WECHAT-UIN') ?? '');
  assert.equal(new Set(uins).size, 3);
  for (const uin of uins) {
    const decimal = Buffer.from(uin, 'base64').toString('utf8');
    assert.match(decimal, /^(0|[1-9][0-9]*)$/);
    assert.ok(BigInt(decimal) <= 4294967295n);
  }
  const ids = calls.map(({ options }) => new Headers(options.headers).get('X-Request-ID') ?? '');
  assert.equal(new Set(ids).size, 3);
  for (const id of ids) assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(calls[0]?.options.timeoutMs, 35_000);
  assert.equal(JSON.parse(String(calls[0]?.options.body)).get_updates_buf, '');
  assert.equal(inspect(client).includes(binding.botToken), false);
  assert.equal(JSON.stringify(client).includes(binding.botToken), false);
});

for (const timeoutMs of [-1, 0, 1.5, 2_147_483_648, Number.MAX_SAFE_INTEGER]) {
  test(`rejects invalid timeout ${timeoutMs} with a sanitized client error`, async () => {
    const { client, calls } = fixture();
    await assert.rejects(client.getUpdates('', { timeoutMs }), safeError('invalid_request'));
    assert.equal(calls.length, 0);
  });
}

for (const body of ['{"ret":-14}', '{"ret":0,"errcode":-14}', '{"ret":5,"errcode":-14}']) {
  test(`maps session expiry before generic upstream errors: ${body}`, async () => {
    const { client } = fixture(body);
    await assert.rejects(client.getUpdates(), safeError('auth_required'));
  });
}

for (const body of ['{"ret":5}', '{"errcode":8}', '{"ret":0,"errcode":3}']) {
  test(`maps upstream rejection without leaking errmsg: ${body}`, async () => {
    const { client } = fixture(body.replace('}', ',"errmsg":"raw-secret context-secret upload-secret"}'));
    await assert.rejects(client.getUpdates(), safeError('upstream_failure'));
  });
}

for (const status of [301, 307, 401, 403, 429, 503]) {
  test(`maps HTTP ${status} without parsing or exposing response content`, async () => {
    const { client } = fixture('raw-secret upload-secret', status);
    await assert.rejects(client.getUpdates(), (error: unknown) => {
      safeError(status === 401 || status === 403 ? 'auth_required' : 'http_failure')(error);
      assert.ok(error instanceof IlinkClientError);
      assert.equal(error.httpStatus, status);
      return true;
    });
  });
}

for (const body of ['null', '[]', '{', '{"ret":"0"}', '{"errcode":null}', '{"msgs":{}}',
  '{"get_updates_buf":3}', '{"longpolling_timeout_ms":-1}', '{"longpolling_timeout_ms":0}',
  '{"longpolling_timeout_ms":1.5}', '{"msgs":null}']) {
  test(`rejects malformed boundary value ${body}`, async () => {
    const { client } = fixture(body);
    await assert.rejects(client.getUpdates(), safeError('invalid_response'));
  });
}

for (const [name, code] of [['TimeoutError', 'timeout'], ['AbortError', 'aborted'], ['Error', 'transport_failed']] as const) {
  test(`sanitizes ${name} and its transport cause`, async () => {
    const error = new Error(secrets.join(' '), { cause: secrets.join(' ') });
    error.name = name;
    const client = new IlinkBotClient(binding, async () => { throw error; });
    await assert.rejects(client.getUpdates(), safeError(code));
  });
}

test('sanitizes a response stream failure independently of JSON parse errors', async () => {
  const stream = Readable.from((async function* () { yield '{'; throw new Error('raw-secret'); })());
  const client = new IlinkBotClient(binding, async () => new HttpResponse(200, new Headers(), stream));
  await assert.rejects(client.getUpdates(), safeError('transport_failed'));
});

test('keeps HTTP classification when discarding a failed response stream also fails', async () => {
  const body = new Readable({ read() {}, destroy(_error, callback) { callback(new Error('raw-secret')); } });
  const client = new IlinkBotClient(binding, async () => new HttpResponse(403, new Headers(), body));
  await assert.rejects(client.getUpdates(), safeError('auth_required'));
});

test('does not log request secrets, raw upstream errors, or transport exceptions', async (context) => {
  const logs = ['log', 'warn', 'error', 'debug'].map((method) => {
    switch (method) {
      case 'log': return context.mock.method(console, 'log', () => undefined);
      case 'warn': return context.mock.method(console, 'warn', () => undefined);
      case 'error': return context.mock.method(console, 'error', () => undefined);
      default: return context.mock.method(console, 'debug', () => undefined);
    }
  });
  const { client } = fixture('{"ret":8,"errmsg":"bot-secret-sentinel context-secret cdn-secret upload-secret raw-secret"}');
  await assert.rejects(client.getUpdates(), safeError('upstream_failure'));
  for (const log of logs) assert.equal(log.mock.callCount(), 0);
});

for (const botToken of ['', ' ', 'bot\r\nsecret', 'bot secret']) {
  test('rejects missing or header-unsafe bot token without exposing it', () => {
    assert.throws(() => new IlinkBotClient({ ...binding, botToken }), safeError('invalid_binding'));
  });
}

for (const baseUrl of ['http://example.test', 'https://user:raw-secret@example.test', 'not-a-url',
  'https://example.test/?token=raw-secret', 'https://example.test/#raw-secret']) {
  test(`rejects unsafe binding URL before issuing a request: ${baseUrl}`, () => {
    assert.throws(() => new IlinkBotClient({ ...binding, baseUrl }), safeError('invalid_binding'));
  });
}

test('uses the real HTTP transport against a loopback simulator and parses its exact response bytes', async (context) => {
  const server = createServer((req, res) => {
    assert.equal(req.url, '/ilink/bot/getupdates');
    assert.equal(req.headers.authorization, `Bearer ${binding.botToken}`);
    res.end('{"ret":0,"msgs":[{"message_id":18446744073709551615,"message_type":1,"from_user_id":"contact"}],"get_updates_buf":"wire"}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const client = new IlinkBotClient(binding, (url, options) => request(
    `http://127.0.0.1:${address.port}${new URL(url).pathname}`, options));
  const result = await client.getUpdates();
  const entry = result.msgs[0];
  assert.ok(entry?.kind === 'message');
  assert.equal(entry.message.message_id, '18446744073709551615');
  assert.equal(result.get_updates_buf, 'wire');
});

for (const mode of ['timeout', 'aborted'] as const) {
  test(`real HTTP ${mode} terminates a pending response without becoming an empty successful batch`, async (context) => {
    const controller = new AbortController();
    const server = createServer((_req, res) => {
      res.write('{"msgs":[');
      if (mode === 'aborted') controller.abort(new Error('context-secret'));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    context.after(() => { server.closeAllConnections(); server.close(); });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const client = new IlinkBotClient(binding, (url, options) => request(
      `http://127.0.0.1:${address.port}${new URL(url).pathname}`, options));
    await assert.rejects(client.getUpdates('', { timeoutMs: mode === 'timeout' ? 30 : 5000, signal: controller.signal }), safeError(mode));
  });
}

for (const body of ['{"ret":-14,"errcode":"raw-secret"}', '{"ret":null,"errcode":-14,"msgs":false}']) {
  test('gives authentication expiry precedence over malformed envelope fields', async () => {
    await assert.rejects(fixture(body).client.getUpdates(), safeError('auth_required'));
  });
}
