import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { inspect } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { HttpResponse, request, type FetchOptions } from '../src/server/http.js';
import { WechatClawbotClient, WechatClawbotError } from '../src/server/wechat-clawbot-client.js';

const endpoint = 'https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3';
const statusEndpoint = 'https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status';
const qrToken = 'qr-secret-unique';
const botToken = 'bot-secret-unique';
const payload = `https://liteapp.weixin.qq.com/q/synthetic-slug?qrcode=${qrToken}&bot_type=3`;
const legacyPayload = `https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=${qrToken}`;
const outerUrl = `https://image.example.test/qr?token=outer-secret&data=${encodeURIComponent(legacyPayload)}`;
const createData = { ret: 0, qrcode: qrToken, qrcode_img_content: payload };
const observedResponse = createData;
const credentials = {
  bot_token: botToken, ilink_bot_id: 'bot-1', ilink_user_id: 'owner-1',
};
const baseurl = 'https://ilinkai.weixin.qq.com/';

function confirmedData(credentialData: Record<string, unknown> = credentials, url: unknown = baseurl) {
  return { ret: 0, status: 'confirmed', ...credentialData, baseurl: url };
}

function fixture(replies: readonly { readonly status?: number; readonly body: unknown }[]) {
  const calls: { readonly url: string; readonly options: FetchOptions }[] = [];
  const requester = async (url: string, options: FetchOptions = {}) => {
    const reply = replies[calls.length];
    assert.ok(reply, 'unexpected extra HTTP request');
    calls.push({ url, options });
    return new HttpResponse(reply.status ?? 200, new Headers(), Readable.from([
      typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body),
    ]));
  };
  return { client: new WechatClawbotClient(requester), calls };
}

function safeError(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof WechatClawbotError);
    assert.equal(error.code, code);
    const serialized = `${inspect(error)} ${JSON.stringify(error)}`;
    for (const secret of [qrToken, botToken, outerUrl, 'outer-secret', 'response-secret']) {
      assert.equal(serialized.includes(secret), false);
    }
    assert.equal(error.cause, undefined);
    return true;
  };
}

test('create sends the exact bodyless iLink GET without audit and returns only local QR data', async () => {
  const { client, calls } = fixture([{ body: observedResponse }]);
  const signal = new AbortController().signal;

  const attempt = await client.createQr(signal);

  assert.equal(attempt.qrPayload, payload);
  assert.deepEqual(Object.keys(attempt), ['qrPayload']);
  assert.equal('qrcode' in attempt, false);
  assert.equal(JSON.stringify(attempt), JSON.stringify({ qrPayload: payload }));
  assert.equal(inspect(attempt).includes('outer-secret'), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, endpoint);
  assert.equal(calls[0]?.options.method, 'GET');
  assert.equal(calls[0]?.options.body, undefined);
  assert.equal(calls[0]?.options.timeoutMs, 15_000);
  assert.equal(calls[0]?.options.signal, signal);
  assert.equal(calls[0]?.options.audit, undefined);
  assert.equal(calls[0]?.options.followRedirects, false);
  assert.deepEqual([...new Headers(calls[0]?.options.headers)], []);
});

test('create accepts direct JSON with numeric ret zero and the scan URL', async () => {
  const { client } = fixture([{ body: createData }]);

  const attempt = await client.createQr();

  assert.equal(attempt.qrPayload, payload);
});

for (const [upstream, expected] of [['wait', 'waiting'], ['scaned', 'scanned'], ['expired', 'expired']] as const) {
  test(`poll maps direct ${upstream} without exposing unconfirmed credentials`, async () => {
    const { client, calls } = fixture([
      { body: createData },
      { body: { ret: 0, status: upstream, ...credentials } },
    ]);
    const attempt = await client.createQr();
    const signal = new AbortController().signal;

    const result = await attempt.pollStatus(signal);

    assert.deepEqual(result, { status: expected });
    assert.equal(calls[1]?.url, statusEndpoint);
    assert.equal(calls[1]?.options.method, 'POST');
    assert.equal(calls[1]?.options.body, new URLSearchParams({ qrcode: qrToken }).toString());
    assert.equal(calls[1]?.options.timeoutMs, 120_000);
    assert.equal(calls[1]?.options.signal, signal);
    assert.equal(calls[1]?.options.followRedirects, false);
    assert.equal(calls[1]?.options.audit, undefined);
    assert.deepEqual(Object.fromEntries(new Headers(calls[1]?.options.headers)), {
      'content-type': 'application/x-www-form-urlencoded',
      'ilink-app-id': 'bot', 'ilink-app-clientversion': '131584',
    });
  });
}

test('confirmed direct poll returns the trusted owner and only documented credentials', async () => {
  const { client } = fixture([
    { body: createData },
    { body: { ...confirmedData(), channel_id: 'untrusted' } },
  ]);
  const attempt = await client.createQr();

  const result = await attempt.pollStatus();

  assert.deepEqual(result, { status: 'confirmed', credentials: {
    ownerIlinkUserId: 'owner-1', botId: 'bot-1', botToken, baseUrl: baseurl,
  } });
});

test('reads top-level confirmed credentials and normalizes baseurl', async () => {
  const { client } = fixture([
    { body: createData },
    { body: {
      ret: 0, status: 'confirmed', ...credentials,
      baseurl: 'https://ilinkai.weixin.qq.com',
    } },
  ]);
  const attempt = await client.createQr();

  assert.deepEqual(await attempt.pollStatus(), { status: 'confirmed', credentials: {
    ownerIlinkUserId: 'owner-1', botId: 'bot-1', botToken,
    baseUrl: 'https://ilinkai.weixin.qq.com/',
  } });
});

test('reuses the private QR capability to check status again after confirmation', async () => {
  const { client, calls } = fixture([
    { body: createData },
    { body: confirmedData() },
    { body: { ret: 0, status: 'expired' } },
  ]);
  const attempt = await client.createQr();

  assert.equal((await attempt.pollStatus()).status, 'confirmed');
  assert.deepEqual(await attempt.pollStatus(), { status: 'expired' });
  assert.equal(Object.keys(attempt).includes('qrcode'), false);
  assert.deepEqual(calls.slice(1).map(({ options }) => options.body), [
    new URLSearchParams({ qrcode: qrToken }).toString(), new URLSearchParams({ qrcode: qrToken }).toString(),
  ]);
  for (const { options } of calls) {
    const headers = new Headers(options.headers);
    for (const name of ['X-APPID', 'X-Signature', 'X-API-KEY', 'X-Nonce', 'X-Request-ID', 'X-Timestamp']) {
      assert.equal(headers.has(name), false);
    }
  }
});

for (const status of [301, 307, 308, 401, 403, 500]) {
  test(`HTTP ${status} cannot establish identity and does not expose its body`, async () => {
    const { client } = fixture([
      { body: createData },
      { status, body: { ...confirmedData(), message: 'response-secret' } },
    ]);
    const attempt = await client.createQr();

    await assert.rejects(attempt.pollStatus(), (error: unknown) => {
      safeError(status === 401 || status === 403 ? 'auth_required' : 'http_failure')(error);
      assert.ok(error instanceof WechatClawbotError);
      assert.equal(error.httpStatus, status);
      return true;
    });
  });
}

for (const status of [401, 403, 503]) {
  test(`preserves HTTP ${status} classification when response stream cleanup fails`, async () => {
    const sentinel = 'response-secret-cleanup-sentinel';
    const body = new Readable({
      read() {},
      destroy(_error, callback) { callback(new Error(sentinel)); },
    });
    const client = new WechatClawbotClient(async () =>
      new HttpResponse(status, new Headers(), body));

    const outcome = await client.createQr().then(() => undefined, (error: unknown) => error);

    safeError(status === 401 || status === 403 ? 'auth_required' : 'http_failure')(outcome);
    assert.ok(outcome instanceof WechatClawbotError);
    assert.equal(outcome.httpStatus, status);
    assert.equal(outcome.cause, undefined);
    assert.doesNotMatch(`${inspect(outcome)} ${JSON.stringify(outcome)}`, /response-secret-cleanup-sentinel|cause/);
  });
}

for (const body of [null, [], {}, { data: createData }, { ret: 0, data: createData },
  ...[undefined, false, null, 1, -1, '0', {}, []].map((ret) => ({ ...createData, ret })),
  ...[undefined, '', ' ', 123].map((qrcode) => ({ ...createData, qrcode })),
  ...[undefined, '', ' ', 123].map((qrcode_img_content) => ({ ...createData, qrcode_img_content })),
  '{"response-secret":']) {
  test(`create rejects malformed response ${JSON.stringify(body)?.slice(0, 35)}`, async () => {
    const { client } = fixture([{ body }]);

    await assert.rejects(client.createQr(), safeError('invalid_response'));
  });
}

const invalidPayloads = [
  'not a URL', payload.replace('https:', 'http:'), payload.replace('liteapp.weixin.qq.com', 'evil.test'),
  payload.replace('/q/synthetic-slug', '/other'), payload.replace(qrToken, 'other'),
  payload.replace(qrToken, ''), payload.replace('liteapp.weixin.qq.com', 'liteapp.weixin.qq.com:8443'),
  payload.replace('https://', 'https://user:password@'), `${payload}&qrcode=other`,
  payload.replace('https:', 'javascript:'),
  payload.replace('liteapp.weixin.qq.com', 'liteapp.weixin.qq.com.evil.test'),
  payload.replace('liteapp.weixin.qq.com', 'evil.liteapp.weixin.qq.com'),
  payload.replace('liteapp.weixin.qq.com', 'liteapp.weixin.qq.com:443'),
  payload.replace('/q/synthetic-slug', '/q/'),
  payload.replace('/q/synthetic-slug', '/q/synthetic-slug/extra'),
  payload.replace('/q/synthetic-slug', '/q/synthetic-slug/'),
  payload.replace('/q/synthetic-slug', '/q/../q/synthetic-slug'),
  payload.replace(`qrcode=${qrToken}&`, ''),
  payload.replace('&bot_type=3', ''),
  payload.replace('bot_type=3', 'bot_type=2'),
  payload.replace('bot_type=3', 'bot_type=03'),
  `${payload}&qrcode=${qrToken}`, `${payload}&bot_type=3`, `${payload}&bot_type=2`,
  `${payload}&extra=response-secret`, `${payload}&data=${encodeURIComponent(legacyPayload)}`,
  `${payload}#fragment`, `${payload}#`,
  ` ${payload}`, `${payload} `, `\t${payload}`, `${payload}\n`,
  payload.replace('liteapp', 'lite\tapp'), payload.replace('/q/', '/q/\n'),
  payload.replace(qrToken, `qr-secret-\runique`),
  legacyPayload, outerUrl, `https://image.example.test/qr.png`,
  `https://image.example.test/?data=${encodeURIComponent(payload)}`,
];
for (const [index, value] of invalidPayloads.entries()) {
  test(`create rejects unsafe or mismatched scan payload ${index}`, async () => {
    const { client } = fixture([{ body: { ...createData, qrcode_img_content: value } }]);

    await assert.rejects(client.createQr(), safeError('invalid_response'));
  });
}

for (const [index, value] of invalidPayloads.entries()) {
  test(`create rejects legacy nested scan payload ${index}`, async () => {
    const { client } = fixture([{ body: { ...createData,
      qrcode_img_content: `https://image.example.test/?data=${encodeURIComponent(value)}`,
    } }]);

    await assert.rejects(client.createQr(), safeError('invalid_response'));
  });
}

for (const qrcode_img_content of ['invalid', outerUrl.replace('https:', 'http:'), 'https://image.example.test/no-data']) {
  test(`create rejects an invalid outer QR URL ${qrcode_img_content.slice(0, 20)}`, async () => {
    const { client } = fixture([{ body: { ...createData, qrcode_img_content } }]);

    await assert.rejects(client.createQr(), safeError('invalid_response'));
  });
}

for (const ilink_user_id of [undefined, null, '', ' \t\n']) {
  for (const otherCredentialsValid of [true, false]) {
    test(`poll rejects missing identity ${JSON.stringify(ilink_user_id)} before other credentials ${otherCredentialsValid}`, async () => {
      const { client } = fixture([
        { body: observedResponse },
        { body: confirmedData({ ...credentials, ilink_user_id,
          bot_token: otherCredentialsValid ? botToken : '' }, otherCredentialsValid ? baseurl : 'invalid') },
      ]);
      const attempt = await client.createQr();

      await assert.rejects(attempt.pollStatus(), safeError('identity_missing'));
    });
  }
}

for (const [index, data] of [{ ret: 0, status: 'unknown' }, { ret: 0, status: 'scanned' }, { ret: 0 },
  { ret: 0, status: null }, { ret: 0, status: 123 },
  ...Object.keys(credentials).flatMap((field) => (field === 'ilink_user_id' ? [123] : [undefined, '', ' ', 123]).map((value) =>
    confirmedData({ ...credentials, [field]: value }))),
  ...['not-a-url', 'http://ilinkai.weixin.qq.com', 'https://user:pass@ilinkai.weixin.qq.com', '', 123]
    .map((url) => confirmedData(credentials, url))].entries()) {
  test(`poll rejects malformed status or credentials case ${index}`, async () => {
    const { client } = fixture([
      { body: createData }, { body: data },
    ]);
    const attempt = await client.createQr();

    await assert.rejects(attempt.pollStatus(), safeError('invalid_response'));
  });
}

for (const ret of [undefined, false, null, 1, -1, '0', {}, []]) {
test(`poll rejects ret ${JSON.stringify(ret)} even when confirmed credentials are present`, async () => {
  const { client } = fixture([
    { body: createData },
    { body: { ...confirmedData(), ret } },
  ]);
  const attempt = await client.createQr();

  await assert.rejects(attempt.pollStatus(), safeError('invalid_response'));
});
}

test('transport errors are sanitized rather than exposing the requester error cause', async () => {
  const client = new WechatClawbotClient(async () => { throw new Error(`${qrToken} ${botToken}`); });

  await assert.rejects(client.createQr(), safeError('request_failed'));
});

test('cancellation reaches the requester and its secret-bearing reason stays private', async () => {
  const controller = new AbortController();
  let captured: FetchOptions | undefined;
  let rawError: unknown;
  const client = new WechatClawbotClient(async (_url, options = {}) => {
    captured = options;
    try {
      options.signal?.throwIfAborted();
    } catch (error) {
      rawError = error;
      throw error;
    }
    throw new Error('request should have been aborted');
  });
  controller.abort(new Error(qrToken));

  await assert.rejects(client.createQr(controller.signal), safeError('request_failed'));

  assert.equal(captured?.timeoutMs, 15_000);
  assert.equal(captured?.signal, controller.signal);
  assert.equal(rawError, controller.signal.reason);
});

for (const phase of ['create', 'poll'] as const) {
  for (const name of ['TimeoutError', 'AbortError'] as const) {
    test(`${phase} sanitizes ${name} and preserves request limits and signal`, async (t) => {
      const warnings: unknown[][] = [];
      t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
      const signal = new AbortController().signal;
      let captured: FetchOptions | undefined;
      const client = new WechatClawbotClient(async (url, options = {}) => {
        if (phase === 'poll' && url === endpoint) {
          return new HttpResponse(200, new Headers(), Readable.from([JSON.stringify(createData)]));
        }
        captured = options;
        throw Object.assign(new Error(`${qrToken} ${botToken} response-secret`), { name });
      });
      const attempt = phase === 'poll' ? await client.createQr() : undefined;

      await assert.rejects(attempt ? attempt.pollStatus(signal) : client.createQr(signal), safeError('request_failed'));

      assert.equal(captured?.timeoutMs, phase === 'create' ? 15_000 : 120_000);
      assert.equal(captured?.signal, signal);
      assert.deepEqual(warnings, [[JSON.stringify({
        event: 'wechat_request_failed',
        endpoint: phase === 'create' ? '/ilink/bot/get_bot_qrcode' : '/ilink/bot/get_qrcode_status',
        method: phase === 'create' ? 'GET' : 'POST', status: 0,
        errorCode: name === 'TimeoutError' ? 'timeout' : 'aborted',
      })]]);
    });
  }
}

test('create rejects extra scan URL parameters', async () => {
  const { client } = fixture([{ body: { ...createData,
    qrcode_img_content: `${payload}&extra=response-secret`,
  } }]);

  await assert.rejects(client.createQr(), safeError('invalid_response'));
});

test('create rejects scan URL fragments', async () => {
  const { client } = fixture([{ body: { ...createData,
    qrcode_img_content: `${payload}#fragment`,
  } }]);

  await assert.rejects(client.createQr(), safeError('invalid_response'));
});

test('create preserves an encoded qrcode token in the validated QR payload', async () => {
  const encodedToken = 'qr%2Ftoken%2Bpart';
  const encodedPayload = `https://liteapp.weixin.qq.com/q/synthetic-slug?qrcode=${encodedToken}&bot_type=3`;
  const { client, calls } = fixture([{ body: { ret: 0,
    qrcode: 'qr/token+part',
    qrcode_img_content: encodedPayload,
  } }, { body: { ret: 0, status: 'wait' } }]);

  const attempt = await client.createQr();

  assert.equal(attempt.qrPayload, encodedPayload);
  assert.equal('qrcode' in attempt, false);
  await attempt.pollStatus();
  assert.equal(calls[1]?.options.body, 'qrcode=qr%2Ftoken%2Bpart');
});

test('create preserves the original QR URL when its exact query parameters are reordered', async () => {
  const reorderedPayload = `https://liteapp.weixin.qq.com/q/synthetic-slug?bot_type=3&qrcode=${qrToken}`;
  const { client } = fixture([{ body: { ...createData, qrcode_img_content: reorderedPayload } }]);

  const attempt = await client.createQr();

  assert.equal(attempt.qrPayload, reorderedPayload);
});

test('response stream failures do not leak transport details', async () => {
  const client = new WechatClawbotClient(async () => new HttpResponse(200, new Headers(),
    Readable.from((async function* () { throw new Error(botToken); })())));

  await assert.rejects(client.createQr(), safeError('request_failed'));
});

test('real HTTP authentication failure closes its stream without an unhandled abort error', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(401);
    response.end('response-secret');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = new WechatClawbotClient((_url, options) =>
    request(`http://127.0.0.1:${address.port}/`, options));

  try {
    await assert.rejects(client.createQr(), safeError('auth_required'));
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
});

for (const status of [301, 307, 308]) {
  for (const phase of ['create', 'status'] as const) {
    test(`real HTTP ${status} during QR ${phase} never contacts a redirected origin`, async (t) => {
      let redirectedRequests = 0;
      let redirectedBytes = 0;
      const target = createServer((incoming, response) => {
        redirectedRequests++;
        incoming.on('data', (chunk: Buffer) => { redirectedBytes += chunk.length; });
        incoming.on('end', () => response.end(JSON.stringify(
          phase === 'create' ? createData : confirmedData({ ...credentials, ilink_user_id: 'redirected-owner' }),
        )));
      });
      const source = createServer((incoming, response) => {
        incoming.resume();
        if (phase === 'status' && incoming.url === '/qrcode') {
          response.end(JSON.stringify(createData));
          return;
        }
        const address = target.address();
        assert.ok(address && typeof address !== 'string');
        response.writeHead(status, { location: `http://127.0.0.1:${address.port}/redirected` });
        response.end(JSON.stringify({ ...confirmedData(), message: 'response-secret' }));
      });
      t.after(async () => {
        await Promise.all([source, target].map((server) => new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => error ? reject(error) : resolve());
        })));
      });
      await Promise.all([source, target].map((server) => new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve))));
      const address = source.address();
      assert.ok(address && typeof address !== 'string');
      const client = new WechatClawbotClient((url, options) => request(
        `http://127.0.0.1:${address.port}${url === endpoint ? '/qrcode' : '/qrcode/status'}`, options));

      const result = phase === 'create' ? client.createQr() : (await client.createQr()).pollStatus();
      const outcome = await result.then(() => undefined, (error: unknown) => error);

      assert.equal(redirectedRequests, 0, 'redirected origin must receive no requests');
      assert.equal(redirectedBytes, 0, 'redirected origin must receive no body bytes');
      safeError('http_failure')(outcome);
      assert.ok(outcome instanceof WechatClawbotError);
      assert.equal(outcome.httpStatus, status);
    });
  }
}

test('creation, polling and rechecking need no system credential provider', async () => {
  const { client, calls } = fixture([
    { body: createData }, { body: confirmedData() }, { body: { ret: 0, status: 'expired' } },
  ]);
  const attempt = await client.createQr();
  assert.equal((await attempt.pollStatus()).status, 'confirmed');
  assert.deepEqual(await attempt.pollStatus(), { status: 'expired' });
  assert.equal(calls.length, 3);
});

test('form encoding preserves reserved characters without exposing the private QR capability', async () => {
  const qrcode = 'qr/+?&= %#中文';
  const qrPayload = `https://liteapp.weixin.qq.com/q/synthetic-slug?qrcode=${encodeURIComponent(qrcode)}&bot_type=3`;
  const { client, calls } = fixture([
    { body: { ret: 0, qrcode, qrcode_img_content: qrPayload } },
    { body: { ret: 0, status: 'wait' } }, { body: { ret: 0, status: 'scaned' } },
  ]);
  const attempt = await client.createQr();
  await attempt.pollStatus();
  await attempt.pollStatus();
  assert.deepEqual(Object.keys(attempt), ['qrPayload']);
  for (const { url, options } of calls.slice(1)) {
    assert.equal(url, statusEndpoint);
    assert.equal(options.body, 'qrcode=qr%2F%2B%3F%26%3D+%25%23%E4%B8%AD%E6%96%87');
    assert.equal(new URLSearchParams(String(options.body)).get('qrcode'), qrcode);
  }
});

for (const body of [null, [], {}, { data: confirmedData() }, { ret: 0, data: confirmedData() },
  { ret: 0, status: 'confirmed', credentials, baseurl }, '{"response-secret":']) {
  test(`poll rejects malformed direct response ${JSON.stringify(body)?.slice(0, 35)}`, async () => {
    const { client } = fixture([{ body: createData }, { body }]);
    const attempt = await client.createQr();
    await assert.rejects(attempt.pollStatus(), safeError(
      typeof body === 'object' && body !== null && 'status' in body ? 'identity_missing' : 'invalid_response',
    ));
  });
}

for (const phase of ['create', 'poll'] as const) {
  for (const [body, reason] of [
    ['{"response-secret":', 'invalid_json'],
    [{ data: null, message: 'response-secret' }, 'invalid_envelope'],
    [{ data: [], message: 'response-secret' }, 'invalid_envelope'],
    [{ ...createData, ret: 1 }, 'invalid_envelope'],
    [{ ret: 0, qrcode: qrToken, qrcode_img_content: `${payload}&extra=response-secret`,
      status: 'response-secret', ...credentials }, phase === 'create' ? 'invalid_qrcode' : 'invalid_status'],
    [{ ...confirmedData(), bot_token: '' },
      phase === 'create' ? 'invalid_qrcode' : 'invalid_status'],
  ] as const) {
    test(`safe protocol diagnostic identifies ${phase} ${reason} without wire metadata`, async (t) => {
      const warnings: unknown[][] = [];
      t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
      const reply = { status: 201, body };
      const { client } = fixture(phase === 'create' ? [reply] : [{ body: observedResponse }, reply]);
      const attempt = phase === 'poll' ? await client.createQr() : undefined;

      await assert.rejects(attempt ? attempt.pollStatus() : client.createQr(), safeError('invalid_response'));

      assert.equal(warnings.length, 1);
      assert.equal(warnings[0]?.length, 1);
      const message = warnings[0]?.[0];
      assert.ok(typeof message === 'string');
      const diagnostic: unknown = JSON.parse(message);
      assert.deepEqual(diagnostic, {
        event: 'wechat_protocol_failed',
        endpoint: phase === 'create' ? '/ilink/bot/get_bot_qrcode' : '/ilink/bot/get_qrcode_status',
        status: 201, reason,
      });
      for (const secret of [qrToken, botToken, payload, 'response-secret', 'X-Signature']) {
        assert.ok(secret && !message.includes(secret));
      }
    });
  }
}

test('safe protocol diagnostic logs a failed 2xx stream read without its arbitrary error', async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  const client = new WechatClawbotClient(async () => new HttpResponse(200, new Headers(),
    Readable.from((async function* () { throw new Error(botToken); })())));

  await assert.rejects(client.createQr(), safeError('request_failed'));

  assert.deepEqual(warnings, [[JSON.stringify({ event: 'wechat_protocol_failed',
    endpoint: '/ilink/bot/get_bot_qrcode', status: 200, reason: 'response_read_failed' })]]);
});

for (const failure of ['http', 'transport'] as const) {
  test(`safe protocol diagnostic does not duplicate existing ${failure} failure logs`, async (t) => {
    const warnings: unknown[][] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
    const client = new WechatClawbotClient(async () => {
      if (failure === 'transport') throw new Error(botToken);
      return new HttpResponse(503, new Headers(), Readable.from(['response-secret']));
    });

    await assert.rejects(client.createQr(), safeError(failure === 'http' ? 'http_failure' : 'request_failed'));

    assert.equal(warnings.length, 1);
    const message = warnings[0]?.[0];
    assert.ok(typeof message === 'string');
    const diagnostic: unknown = JSON.parse(message);
    assert.ok(typeof diagnostic === 'object' && diagnostic !== null && 'event' in diagnostic);
    assert.equal(diagnostic.event, 'wechat_request_failed');
    assert.doesNotMatch(message, /response-secret|bot-secret-unique|system-secret-sentinel/);
  });
}

test('safe protocol diagnostic stays silent when creation and polling succeed', async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  const { client } = fixture([{ body: observedResponse }, { body: confirmedData() }]);

  const attempt = await client.createQr();
  await attempt.pollStatus();

  assert.deepEqual(warnings, []);
});
