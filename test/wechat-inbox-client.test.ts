import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { HttpResponse, request, type FetchOptions } from '../src/server/http.js';
import { IlinkBotClient, IlinkClientError, type IlinkRequestOptions, type IlinkSendMessage,
  type IlinkUploadUrlRequest } from '../src/server/wechat-inbox/client.js';

const binding = { baseUrl: 'https://first.example.test/', botToken: 'bot-secret-sentinel' };
const secrets = ['bot-secret-sentinel', 'context-secret', 'cdn-secret', 'upload-secret', 'raw-secret', 'typing-secret'];
const empty = '{"ret":0,"msgs":[],"get_updates_buf":"next"}';
const outgoing: IlinkSendMessage = { from_user_id: '', to_user_id: 'contact', client_id: 'client-1',
  message_type: 2, message_state: 2, context_token: 'context-secret', item_list: [{ type: 1, text_item: { text: 'hello' } }] };
const upload: IlinkUploadUrlRequest = { filekey: 'file-key', media_type: 1, to_user_id: 'contact', rawsize: 15,
  rawfilemd5: 'md5', filesize: 16, aeskey: 'cdn-secret', no_need_thumb: false,
  thumb_rawsize: 3, thumb_rawfilemd5: 'thumb-md5', thumb_filesize: 16 };
const operations = [
  { path: 'getuploadurl', body: upload, invoke: (client: IlinkBotClient, options?: IlinkRequestOptions) => client.getUploadUrl(upload, options) },
  { path: 'sendmessage', body: { msg: outgoing }, invoke: (client: IlinkBotClient, options?: IlinkRequestOptions) => client.sendMessage(outgoing, options) },
  { path: 'getconfig', body: { ilink_user_id: 'owner', context_token: 'context-secret' },
    invoke: (client: IlinkBotClient, options?: IlinkRequestOptions) => client.getConfig('owner', 'context-secret', options) },
  { path: 'sendtyping', body: { ilink_user_id: 'owner', typing_ticket: 'typing-secret', status: 1 },
    invoke: (client: IlinkBotClient, options?: IlinkRequestOptions) => client.sendTyping('owner', 'typing-secret', 1, options) },
  { path: 'msg/notifystart', body: {}, invoke: (client: IlinkBotClient, options?: IlinkRequestOptions) => client.notifyStart(options) },
  { path: 'msg/notifystop', body: {}, invoke: (client: IlinkBotClient, options?: IlinkRequestOptions) => client.notifyStop(options) },
] as const;

for (const operation of operations) {
  test(`${operation.path} uses exact authenticated binding-scoped POST without redirects or audit`, async () => {
    const { client, calls, transport } = fixture('{"ret":0}');
    const other = new IlinkBotClient({ baseUrl: 'https://other.test/prefix', botToken: 'other-token' }, transport);
    const signal = new AbortController().signal;
    await Promise.all([operation.invoke(client, { timeoutMs: 1234, signal }), operation.invoke(other)]);
    assert.deepEqual(calls.map(({ url }) => url), [`${binding.baseUrl}ilink/bot/${operation.path}`,
      `https://other.test/prefix/ilink/bot/${operation.path}`]);
    for (const [index, call] of calls.entries()) {
      assert.deepEqual(JSON.parse(String(call.options.body)), { ...operation.body, base_info: { channel_version: '2.2.0' } });
      assert.equal(call.options.method, 'POST');
      assert.equal(call.options.followRedirects, false);
      assert.equal(call.options.audit, undefined);
      const headers = new Headers(call.options.headers);
      assert.equal(headers.get('Authorization'), `Bearer ${index === 0 ? binding.botToken : 'other-token'}`);
      assert.equal(headers.get('AuthorizationType'), 'ilink_bot_token');
      assert.equal(headers.get('Content-Type'), 'application/json');
      assert.equal(headers.get('iLink-App-Id'), 'bot');
      assert.equal(headers.get('iLink-App-ClientVersion'), '131584');
      assert.match(Buffer.from(headers.get('X-WECHAT-UIN') ?? '', 'base64').toString(), /^\d+$/);
      assert.match(headers.get('X-Request-ID') ?? '', /^[0-9a-f-]{36}$/);
      assert.equal(headers.has('X-Signature'), false);
    }
    assert.equal(calls[0]?.options.timeoutMs, 1234);
    assert.equal(calls[0]?.options.signal, signal);
  });

  test(`${operation.path} validates timeout and pre-aborted signals before transport`, async () => {
    const { client, calls } = fixture('{"ret":0}');
    for (const timeoutMs of [0, -1, NaN, Infinity, 1.5, 2_147_483_648]) {
      await assert.rejects(operation.invoke(client, { timeoutMs }), safeError('invalid_request'));
    }
    await assert.rejects(operation.invoke(client, { signal: AbortSignal.abort('raw-secret') }), safeError('aborted'));
    assert.equal(calls.length, 0);
  });

  for (const [body, code] of [['null', 'invalid_response'], ['{', 'invalid_response'], ['[]', 'invalid_response'],
    ['{"ret":"0"}', 'invalid_response'], ['{"ret":null}', 'invalid_response'],
    ['{"ret":9,"errmsg":"raw-secret"}', 'upstream_failure']] as const) {
    if (operation.path === 'sendmessage' && body.startsWith('{"ret"')) continue;
    test(`${operation.path} sanitizes invalid or rejected response ${body}`, async () => {
      const { client, calls } = fixture(body);
      await assert.rejects(operation.invoke(client), safeError(code));
      assert.equal(calls.length, 1);
    });
  }

  for (const status of [307, 401, 503]) {
    test(`${operation.path} safely rejects HTTP ${status} without retry`, async () => {
      const { client, calls } = fixture('raw-secret', status);
      await assert.rejects(operation.invoke(client), safeError(status === 401 ? 'auth_required' : 'http_failure'));
      assert.equal(calls.length, 1);
    });
  }

  for (const [name, code] of [['TimeoutError', 'timeout'], ['AbortError', 'aborted'], ['Error', 'transport_failed']] as const) {
    test(`${operation.path} sanitizes transport ${name} without retry`, async () => {
      let attempts = 0;
      const client = new IlinkBotClient(binding, async () => {
        attempts++;
        throw Object.assign(new Error(secrets.join(' '), { cause: 'raw-secret' }), { name });
      });
      await assert.rejects(operation.invoke(client), safeError(code));
      assert.equal(attempts, 1);
    });
  }

  test(`${operation.path} sanitizes response stream failures and never logs private data`, async (context) => {
    const logs = [context.mock.method(console, 'log'), context.mock.method(console, 'warn'),
      context.mock.method(console, 'error'), context.mock.method(console, 'debug')];
    const stream = Readable.from((async function* () { yield '{'; throw new Error(secrets.join(' ')); })());
    const client = new IlinkBotClient(binding, async () => new HttpResponse(200, new Headers(), stream));
    await assert.rejects(operation.invoke(client), safeError('transport_failed'));
    if (operation.path !== 'sendmessage') {
      await assert.rejects(operation.invoke(fixture(JSON.stringify({ ret: 5, errmsg: secrets.join(' ') })).client), safeError('upstream_failure'));
    }
    for (const log of logs) assert.equal(log.mock.callCount(), 0);
  });
}

test('sendMessage uses HTTP status rather than response ret and never returns a server message ID', async () => {
  assert.equal(await fixture('{"ret":0,"message_id":"9","errmsg":"raw-secret"}').client.sendMessage(outgoing), undefined);
  for (const body of ['{}', '{"message_id":"9"}']) {
    assert.equal(await fixture(body).client.sendMessage(outgoing), undefined);
  }
  assert.equal(await fixture('{"ret":-14,"errmsg":"raw-secret"}').client.sendMessage(outgoing), undefined);
});

test('sendMessage accepts the actual no-ret response without exposing its uint64 ID', async () => {
  assert.equal(await fixture('{"message_id":7518649076676660872}').client.sendMessage(outgoing), undefined);
});

for (const status of [201, 204, 400, 503]) {
  test(`sendMessage rejects HTTP ${status}`, async () => {
    await assert.rejects(fixture('{"message_id":7518649076676660872}', status).client.sendMessage(outgoing), safeError('http_failure'));
  });
}

test('upload and config responses expose only validated optional DTO fields', async () => {
  assert.deepEqual(await fixture('{"upload_param":"upload-secret","thumb_upload_param":"thumb","upload_full_url":"https://cdn.test/path","errmsg":"raw-secret","extra":{}}')
    .client.getUploadUrl(upload), { upload_param: 'upload-secret', thumb_upload_param: 'thumb', upload_full_url: 'https://cdn.test/path' });
  assert.deepEqual(await fixture('{"typing_ticket":"ticket","context_token":"context-secret","errmsg":"raw-secret"}').client.getConfig('owner'), { typingTicket: 'ticket' });
  assert.deepEqual(await fixture('{}').client.getUploadUrl(upload), {});
  assert.deepEqual(await fixture('{}').client.getConfig('owner'), {});
  for (const field of ['upload_param', 'thumb_upload_param', 'upload_full_url']) {
    await assert.rejects(fixture(JSON.stringify({ [field]: { secret: 'raw-secret' } })).client.getUploadUrl(upload), safeError('invalid_response'));
  }
  await assert.rejects(fixture('{"typing_ticket":null}').client.getConfig('owner'), safeError('invalid_response'));
});

test('config omits absent context and typing sends cancel status unchanged', async () => {
  const { client, calls } = fixture('{"ret":0}');
  await client.getConfig('owner');
  await client.sendTyping('owner', 'ticket', 2);
  assert.deepEqual(JSON.parse(String(calls[0]?.options.body)), { ilink_user_id: 'owner', base_info: { channel_version: '2.2.0' } });
  assert.equal(JSON.parse(String(calls[1]?.options.body)).status, 2);
});

test('all added operations complete over the real HTTP transport without following a redirect', async (context) => {
  const paths: string[] = [];
  const server = createServer(async (req, res) => {
    paths.push(req.url ?? '');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
    assert.ok(typeof body === 'object' && body !== null && 'base_info' in body);
    assert.deepEqual(body.base_info, { channel_version: '2.2.0' });
    assert.equal(req.headers.authorization, `Bearer ${binding.botToken}`);
    if (req.url === '/ilink/bot/sendmessage') {
      res.writeHead(307, { Location: '/must-not-follow' });
      res.end('raw-secret');
      return;
    }
    res.end('{"ret":0,"typing_ticket":"ticket","upload_param":"upload-secret","errmsg":"raw-secret"}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const client = new IlinkBotClient(binding, (url, options) => request(
    `http://127.0.0.1:${address.port}${new URL(url).pathname}`, options));
  for (const operation of operations) {
    if (operation.path === 'sendmessage') await assert.rejects(operation.invoke(client), safeError('http_failure'));
    else await operation.invoke(client);
  }
  assert.deepEqual(paths, operations.map(({ path }) => `/ilink/bot/${path}`));
});

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
