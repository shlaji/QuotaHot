import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { request as httpRequest } from 'undici';
import { HttpResponse, type request } from '../src/server/http.js';
import { WechatSessionStore } from '../src/server/wechat-session-store.js';
import { WechatInboxStore } from '../src/server/wechat-inbox/store.js';
import { WechatInboxService } from '../src/server/wechat-inbox/service.js';
import { WechatInboxSender, type InboxSendCommand } from '../src/server/wechat-inbox/sender.js';
import { WechatInboxTyping } from '../src/server/wechat-inbox/typing.js';
import { IlinkBotClient } from '../src/server/wechat-inbox/client.js';
import { wechatInboxRoutes } from '../src/server/wechat-inbox/routes.js';
import { input } from './helpers/wechat-inbox-store.js';
import { readFileSync } from 'node:fs';
import { accessGuard } from '../src/server/access.js';
import { WechatClawbotClient } from '../src/server/wechat-clawbot-client.js';
import { WechatLoginService } from '../src/server/wechat-login-service.js';
import { wechatRoutes } from '../src/server/wechat-routes.js';
import { assertContractResponse, contract, operation, record, schemaCheck } from './helpers/wechat-inbox-contract.js';

function setup(t: TestContext, mode = 'accepted', contextOwners: readonly string[] = ['owner', 'other']) {
  const store = new WechatInboxStore(':memory:');
  const sessions = new WechatSessionStore(':memory:');
  t.after(() => { store.close(); sessions.close(); });
  const calls: string[] = [];
  const transport: typeof request = async (url, options = {}) => {
    calls.push(options.body ?? '');
    if (mode === 'unknown') throw new Error('secret-token secret-context https://secret.test');
    const body = url.includes('getconfig') ? '{"ret":0,"typing_ticket":"secret-ticket"}'
      : mode === 'rejected' ? '{"ret":9,"errmsg":"secret-token"}' : '{"ret":0}';
    return new HttpResponse(200, new Headers(), Readable.from([body]));
  };
  const options = { getPollState: () => mode === 'relogin' ? 'relogin_required' as const : 'polling' as const,
    createClient: (binding: ConstructorParameters<typeof IlinkBotClient>[0]) => new IlinkBotClient(binding, transport) };
  for (const owner of ['owner', 'other']) {
    sessions.saveBinding({ ownerIlinkUserId: owner, botId: 'bot', botToken: 'secret-token', baseUrl: 'https://secret.test' }, 0);
    store.saveBinding({ ownerIlinkUserId: owner, botId: 'bot' }, new Date(0).toISOString());
    store.saveBatch(owner, { nextCursor: '', messages: [
      ...(contextOwners.includes(owner) ? [{ ...input('remote-1'), contextToken: 'secret-context' }] : []), input('remote-2'),
      { ...input('remote-file'), kind: 'file', items: [{ kind: 'file', attachment: {
        fileName: '../../附件\r\n".txt', mediaType: 'text/plain', bytes: Buffer.alloc(150000, 65) } }] },
    ] });
  }
  const service = new WechatInboxService(sessions, store, options);
  const sender = new WechatInboxSender(sessions, store, options);
  const typing = new WechatInboxTyping(sessions, store, options);
  const app = new Hono().route('/api/wechat-inbox', wechatInboxRoutes({ service, sender, typing }));
  const id = 'owner';
  const base = `/api/wechat-inbox/bindings/${id}`;
  return { app, store, sessions, service, sender, typing, calls, id, base };
}
function json(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
function media(): FormData {
  const form = new FormData();
  form.set('kind', 'file'); form.set('file', new File(['payload'], 'file.txt'));
  return form;
}
function safe(response: Response) { assert.equal(response.headers.get('cache-control'), 'no-store'); }

test('serializes the binding-only message page without secrets', async (t) => {
  const { app } = setup(t);
  const response = await app.request('/api/wechat-inbox/bindings/owner/messages');
  assert.equal(response.status, 200); safe(response);
  const body = await response.json();
  assert.equal(body.items.length, 3);
  assert.equal(body.hasMore, false);
  assert.doesNotMatch(JSON.stringify(body), /secret|contextToken|fingerprint|baseUrl|botToken|contactUserId|conversationId/);
});

for (const path of ['/bindings', '/bindings/owner/messages']) {
  test(`serializes safe DTOs when reading ${path}`, async (t) => {
    const { app } = setup(t);
    const response = await app.request(`/api/wechat-inbox${path}`);
    assert.equal(response.status, 200); safe(response);
    const body: unknown = await response.json();
    assert.ok(body && typeof body === 'object');
    assert.doesNotMatch(JSON.stringify(body), /secret|contextToken|fingerprint|baseUrl|botToken|contactUserId|unlinkedAt/);
    if (path === '/bindings') {
      assert.ok(Array.isArray(body));
      assert.deepEqual(Object.keys(body[0] ?? {}).sort(), ['ownerIlinkUserId', 'botId', 'createdAt', 'updatedAt', 'connectionState', 'canSend', 'replyContextState'].sort());
      assert.equal(Object.hasOwn(body[0] ?? {}, 'messagingReadiness'), false);
      assert.equal(body[0]?.replyContextState, 'ready');
    }
  });
}
test('paginates messages when using the local UUID and opaque cursor', async (t) => {
  const { app, base } = setup(t);
  const response = await app.request(`${base}/messages?limit=1`);
  const page = await response.json();
  assert.equal(response.status, 200); safe(response);
  assert.equal(page.items.length, 1); assert.equal(page.hasMore, true);
  assert.doesNotMatch(JSON.stringify(page), /context|fingerprint|runId|conversationId|messageType|sha256/);
  const older = await app.request(`${base}/messages?limit=1&before=${page.nextCursor}`);
  assert.equal((await older.json()).items[0].remoteMessageId, 'remote-2');
});
for (const path of ['/bindings/missing/messages', '/bindings/owner/contacts/remote-contact/messages',
  '/bindings/missing/typing', '/bindings/missing/messages', '/attachments/missing']) {
  test(`returns 404 when the local resource is absent: ${path}`, async (t) => {
    const { app, id } = setup(t);
    const response = await app.request(`/api/wechat-inbox${path.replace('LOCAL', id)}`);
    assert.equal(response.status, 404); safe(response);
  });
}
for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'limit=', 'limit=1e1', 'before=foreign', 'limit=1&limit=2']) {
  test(`rejects invalid pagination when ${query}`, async (t) => {
    const { app, base } = setup(t);
    assert.equal((await app.request(`${base}/messages?${query}`)).status, 400);
  });
}
test('streams plaintext chunks with safe headers when attachment ID exists', async (t) => {
  const { app, store, id } = setup(t);
  const attachmentId = store.listMessages('owner').items.at(-1)?.items[0]?.attachmentId;
  assert.ok(attachmentId);
  const response = await app.request(`/api/wechat-inbox/attachments/${attachmentId}`);
  assert.equal(response.status, 200); safe(response);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-type'), 'text/plain');
  assert.match(response.headers.get('content-disposition') ?? '', /^attachment; filename=/);
  assert.doesNotMatch(response.headers.get('content-disposition') ?? '', /\.\.\/|\r|\n/);
  const reader = response.body?.getReader(); assert.ok(reader);
  let size = 0; let chunks = 0;
  for (;;) { const next = await reader.read(); if (next.done) break; chunks++; size += next.value.length; assert.ok(next.value.every((byte) => byte === 65)); }
  assert.equal(size, 150000); assert.ok(chunks > 1);
});
for (const field of ['owner', 'ownerIlinkUserId', 'from_user_id', 'to_user_id', 'context_token', 'token', 'context', 'from', 'to']) {
  for (const format of ['json', 'multipart']) test(`rejects caller ${field} when using ${format}`, async (t) => {
    const { app, base, calls } = setup(t);
    const form = media(); form.set(field, 'secret');
    const response = await app.request(`${base}/messages`, format === 'json'
      ? json({ kind: 'text', text: 'hello', [field]: 'secret' }) : { method: 'POST', body: form });
    assert.equal(response.status, 400); safe(response); assert.equal(calls.length, 0);
  });
}
for (const body of [null, [], {}, { kind: 'text', text: '' }, { kind: 'text', text: 7 }, { kind: 'file', text: 'x' }]) {
  test(`rejects malformed JSON when body is ${JSON.stringify(body)}`, async (t) => {
    const { app, base } = setup(t);
    assert.equal((await app.request(`${base}/messages`, json(body))).status, 400);
  });
}
for (const invalid of ['duplicate-kind', 'duplicate-file', 'duplicate-fileName', 'duplicate-mediaType', 'missing-file', 'string-file', 'file-kind', 'bad-kind', 'bad-mime']) {
  test(`rejects malformed multipart when ${invalid}`, async (t) => {
    const { app, base, calls } = setup(t); const form = media();
    if (invalid.startsWith('duplicate-')) { const field = invalid.slice(10); form.append(field, field === 'file' ? new File(['x'], 'x') : 'file'); if (field === 'fileName' || field === 'mediaType') form.append(field, 'file'); }
    if (invalid === 'missing-file') form.delete('file');
    if (invalid === 'string-file') form.set('file', 'text');
    if (invalid === 'file-kind') form.set('kind', new File(['file'], 'kind'));
    if (invalid === 'bad-kind') form.set('kind', 'text');
    if (invalid === 'bad-mime') form.set('mediaType', 'text/html\r\nX-Evil: yes');
    const response = await app.request(`${base}/messages`, { method: 'POST', body: form });
    assert.equal(response.status, 400); assert.equal(calls.length, 0);
  });
}
for (const init of [{ method: 'POST', body: 'hello', headers: { 'Content-Type': 'text/plain' } },
  { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } },
  { method: 'POST', body: 'bad', headers: { 'Content-Type': 'multipart/form-data; boundary=x' } }]) {
  test(`rejects malformed request when content is ${init.body}`, async (t) => {
    const { app, base } = setup(t); assert.equal((await app.request(`${base}/messages`, init)).status, 400);
  });
}
for (const mode of ['accepted', 'rejected', 'unknown']) {
  test(`maps ${mode} without retry when sending text`, async (t) => {
    const { app, base, calls } = setup(t, mode);
    const response = await app.request(`${base}/messages`, json({ kind: 'text', text: 'hello' }));
    assert.equal(response.status, mode === 'accepted' ? 202 : mode === 'rejected' ? 502 : 504); safe(response);
    const body = await response.json();
    if (mode === 'rejected') assert.deepEqual(body, { error: 'wechat_inbox_send_rejected' });
    else { assert.equal(body.state, mode); assert.match(body.messageId, /^[0-9a-f-]{36}$/); }
    assert.equal(calls.length, 1); assert.doesNotMatch(JSON.stringify(body), /secret|context|client_id/);
  });
}
test('requires an owner inbound context before accepting messages or typing', async (t) => {
  const fixture = setup(t, 'accepted', ['other']);
  for (const [path, body] of [['messages', { kind: 'text', text: 'hello' }], ['typing', { status: 'typing' }]] as const) {
    const response = await fixture.app.request(`${fixture.base}/${path}`, json(body));
    assert.equal(response.status, 409); safe(response);
    await assertContractResponse(response.clone(), ['POST', `/bindings/{bindingId}/${path}`]);
    assert.deepEqual(await response.json(), { error: 'wechat_inbox_context_required' });
  }
  const malformedMultipart = await fixture.app.request(`${fixture.base}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=x' }, body: 'not multipart',
  });
  assert.equal(malformedMultipart.status, 409);
  assert.deepEqual(await malformedMultipart.json(), { error: 'wechat_inbox_context_required' });
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(fixture.store.listMessages('owner').items.map(({ remoteMessageId }) => remoteMessageId), ['remote-2', 'remote-file']);
  assert.equal(fixture.service.listBindings().find(({ ownerIlinkUserId }) => ownerIlinkUserId === 'owner')?.replyContextState,
    'waiting_for_inbound');
  const voiceFixture = setup(t);
  const voice = media(); voice.set('kind', 'voice');
  const voiceResponse = await voiceFixture.app.request(`${voiceFixture.base}/messages`, { method: 'POST', body: voice });
  assert.equal(voiceResponse.status, 400);
  assert.deepEqual(await voiceResponse.json(), { error: 'wechat_inbox_voice_outbound_disabled' });
  assert.deepEqual(voiceFixture.calls, []);
});

for (const mode of ['unlinked', 'relogin']) for (const action of ['messages', 'typing']) {
  test(`rejects ${action} before upstream calls when target is ${mode}`, async (t) => {
    const fixture = setup(t, mode); const { base } = fixture;
    if (mode === 'unlinked') fixture.sessions.removeBinding('owner');
    const response = await fixture.app.request(`${base}/${action}`, json(action === 'typing' ? { status: 'typing' } : { kind: 'text', text: 'hello' }));
    assert.equal(response.status, 409); assert.deepEqual(await response.json(), { error: 'wechat_inbox_binding_read_only' });
    assert.equal(fixture.calls.length, 0); safe(response);
  });
}
for (const status of ['typing', 'cancel']) test(`maps ${status} when typing is requested`, async (t) => {
  const { app, base, calls } = setup(t);
  const response = await app.request(`${base}/typing`, json({ status }));
  assert.equal(response.status, 204); safe(response);
  assert.equal(JSON.parse(calls.at(-1) ?? '{}').status, status === 'typing' ? 1 : 2);
});
test('returns nonfatal 204 when typing transport fails', async (t) => {
  const { app, base } = setup(t, 'unknown');
  assert.equal((await app.request(`${base}/typing`, json({ status: 'typing' }))).status, 204);
});
for (const body of [{ status: 'bad' }, { status: 'typing', owner: 'other' }]) test('rejects invalid typing body', async (t) => {
  const { app, base, calls } = setup(t);
  assert.equal((await app.request(`${base}/typing`, json(body))).status, 400); assert.equal(calls.length, 0);
});
for (const mediaType of [undefined, '', 'application/pdf']) test(`passes stream to sender when mediaType is ${mediaType}`, async (t) => {
  const { app, base, sender } = setup(t); let command: InboxSendCommand | undefined; let bytes = '';
  t.mock.method(sender, 'send', async (value: InboxSendCommand) => { command = value; if (value.kind !== 'text') for await (const chunk of value.source) bytes += new TextDecoder().decode(chunk); return { messageId: 'local', state: 'accepted' }; });
  const form = media(); if (mediaType !== undefined) form.set('mediaType', mediaType);
  const response = await app.request(`${base}/messages`, { method: 'POST', body: form });
  assert.equal(response.status, 202); assert.ok(command && command.kind !== 'text');
  assert.equal(command.mediaType, mediaType || 'application/octet-stream'); assert.equal(bytes, 'payload');
});
test('hides exception details when service fails', async (t) => {
  const { app, service } = setup(t);
  t.mock.method(service, 'listBindings', () => { throw new Error('secret-token database/path context'); });
  const response = await app.request('/api/wechat-inbox/bindings');
  assert.equal(response.status, 500); safe(response);
  assert.deepEqual(await response.json(), { error: 'wechat_inbox_internal_error' });
});
for (const action of ['messages', 'typing']) test(`returns 404 when ${action} uses an unknown binding`, async (t) => {
  const { app, base, calls } = setup(t);
  const response = await app.request(`${base.replace('/bindings/owner', '/bindings/missing')}/${action}`, json(action === 'typing' ? { status: 'typing' } : { kind: 'text', text: 'hello' }));
  assert.equal(response.status, 404); assert.equal(calls.length, 0);
});
test('keeps attachment reads owner-scoped when resolving a global local ID', async (t) => {
  const { store, service, id } = setup(t);
  const attachmentId = store.listMessages('owner').items.at(-1)?.items[0]?.attachmentId; assert.ok(attachmentId);
  const result = service.getAttachmentById(attachmentId); assert.ok(result);
  assert.equal(result.attachment.id, attachmentId);
  assert.equal(store.getAttachment('other', attachmentId), null);
  assert.deepEqual([...store.readAttachmentChunks('other', attachmentId)], []);
});
test('serves bindings and rejects bad input when mounted on a real HTTP listener', async (t) => {
  const { app, base } = setup(t);
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const response = await httpRequest(`${origin}/api/wechat-inbox/bindings`);
  assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store');
  assert.doesNotMatch(await response.body.text(), /secret|contextToken/);
  const invalid = await httpRequest(`${origin}${base}/messages`, { method: 'POST', body: 'invalid', headers: { 'content-type': 'application/json' } });
  assert.equal(invalid.statusCode, 400); assert.deepEqual(await invalid.body.json(), { error: 'wechat_inbox_invalid_request' });
});

test('matches declared OpenAPI methods and paths to actual mounted inbox routes', (t) => {
  const { app } = setup(t);
  const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);
  const declared = Object.entries(record(contract.paths)).flatMap(([path, entry]) => {
    const item = record(entry);
    const servers = item.servers ?? contract.servers;
    assert.ok(Array.isArray(servers) && servers.length > 0);
    const prefix = record(servers[0]).url;
    assert.equal(typeof prefix, 'string');
    if (prefix !== '/api/wechat-inbox') return [];
    return Object.keys(item).filter((method) => methods.has(method)).map((method) =>
      `${method.toUpperCase()} ${prefix}${path.replace(/\{([^}]+)\}/g, ':$1')}`);
  });
  const actual = app.routes.filter((route) => route.method !== 'ALL').map((route) => `${route.method} ${route.path}`);
  assert.deepEqual([...new Set(actual)].sort(), declared.sort());
  for (const schema of Object.values(record(record(contract.components).schemas))) schemaCheck(schema);
});
test('fails closed when a schema keyword or reference is unsupported', () => {
  for (const schema of [{ type: 'string', pattern: '^x' }, { $ref: '#/unknown' },
    { oneOf: [{ const: 'x' }, { type: 'string', pattern: '^x' }] }]) assert.throws(() => schemaCheck(schema));
  const check = schemaCheck({ type: 'object', additionalProperties: false, required: ['id'], properties: {
    id: { type: 'string', format: 'uuid' }, count: { type: 'integer', minimum: 1 },
  } });
  for (const value of [{}, { id: 'bad' }, { id: '00000000-0000-0000-0000-000000000000', count: 0 },
    { id: '00000000-0000-0000-0000-000000000000', token: 'extra' }]) assert.equal(check(value), false);
});
test('declares yaml only as an exact test dependency', () => {
  const manifest = record(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')));
  const lock = record(JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')));
  assert.equal(record(manifest.devDependencies).yaml, '2.9.1');
  assert.equal(record(manifest.dependencies).yaml, undefined);
  assert.equal(record(record(record(lock.packages)['']).devDependencies).yaml, '2.9.1');
});
for (const [mode, action, status] of [
  ['accepted', 'bindings', 200], ['accepted', 'history', 200],
  ['accepted', 'pagination', 400], ['accepted', 'missing', 404], ['relogin', 'send', 409],
  ['rejected', 'send', 502], ['unknown', 'send', 504], ['accepted', 'send', 202],
  ['accepted', 'typing', 204], ['accepted', 'bad-typing', 400], ['accepted', 'voice', 400], ['accepted', 'internal', 500],
] as const) test(`validates runtime ${status} ${action}/${mode} against parsed OpenAPI`, async (t) => {
  const { app, base, calls, service } = setup(t, mode);
  let path = `${base}/messages`; let method = 'GET'; let init: RequestInit = {};
  let declared = '/bindings/{bindingId}/messages';
  switch (action) {
    case 'bindings': path = '/api/wechat-inbox/bindings'; declared = '/bindings'; break;
    case 'history': break;
    case 'internal': path = '/api/wechat-inbox/bindings'; declared = '/bindings';
      t.mock.method(service, 'listBindings', () => { throw new Error('secret database/path'); }); break;
    case 'pagination': path += '?limit=0'; break;
    case 'missing': path = path.replace('/owner/', '/missing/'); break;
    case 'send': method = 'POST'; init = json({ kind: 'text', text: 'hello' }); break;
    case 'typing': case 'bad-typing': method = 'POST'; path = `${base}/typing`;
      declared = '/bindings/{bindingId}/typing'; init = json({ status: action === 'typing' ? 'typing' : 'bad' }); break;
    case 'voice': { method = 'POST'; const form = media(); form.set('kind', 'voice'); init = { method, body: form }; break; }
  }
  const response = await app.request(path, init);
  assert.equal(response.status, status);
  if (action === 'voice') {
    assert.deepEqual(await response.clone().json(), { error: 'wechat_inbox_voice_outbound_disabled' });
    assert.equal(calls.length, 0);
    const schema = record(record(record(operation(method, declared).requestBody).content)['multipart/form-data']).schema;
    assert.equal(schemaCheck(schema)({ kind: 'voice', file: 'bytes' }), true);
  }
  await assertContractResponse(response, [method, declared]);
});
test('matches the stored attachment MIME to the declared response content', async (t) => {
  const { app, store, id } = setup(t);
  const attachment = store.listMessages('owner').items.at(-1)?.items[0]?.attachmentId; assert.ok(attachment);
  const response = await app.request(`/api/wechat-inbox/attachments/${attachment}`);
  assert.equal(response.headers.get('content-type'), 'text/plain');
  await assertContractResponse(response, ['GET', '/attachments/{attachmentId}']);
});
for (const scenario of ['allowed', 'missing-auth', 'wrong-auth', 'cross-site', 'foreign-origin'] as const) {
  test(`enforces real mounted accessGuard for inbox when ${scenario}`, async (t) => {
    const fixture = setup(t);
    const app = new Hono().use('*', accessGuard({ username: 'operator', password: 'synthetic-password' })).route('/', fixture.app);
    const headers = new Headers({ host: 'local.test', origin: 'http://local.test', 'sec-fetch-site': 'same-origin' });
    if (scenario !== 'missing-auth') headers.set('authorization', `Basic ${Buffer.from(`operator:${scenario === 'wrong-auth' ? 'wrong' : 'synthetic-password'}`).toString('base64')}`);
    if (scenario === 'cross-site') headers.set('sec-fetch-site', 'cross-site');
    if (scenario === 'foreign-origin') headers.set('origin', 'https://foreign.invalid');
    const response = await app.request('http://local.test/api/wechat-inbox/bindings', { headers });
    assert.equal(response.status, scenario === 'allowed' ? 200 : scenario.endsWith('auth') ? 401 : 403);
    safe(response); assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); assert.equal(response.headers.get('x-frame-options'), 'DENY');
    if (scenario === 'allowed') await assertContractResponse(response, ['GET', '/bindings']);
    else {
      assert.match(response.headers.get('content-type') ?? '', /^text\/plain/);
      assert.equal(await response.clone().text(), scenario.endsWith('auth') ? 'Unauthorized' : 'Forbidden');
      if (scenario.endsWith('auth')) assert.match(response.headers.get('www-authenticate') ?? '', /^Basic/);
      await assertContractResponse(response, ['GET', '/bindings']);
    }
  });
}
for (const failure of ['identity-missing', 'identity-null', 'save-existing', 'save-new'] as const) {
  test(`preserves bindings without success or secrets when QR ${failure}`, async (t) => {
    const { sessions } = setup(t);
    const now = 1000; const token = 'synthetic-prior-browser-token';
    const db = sessions['db'];
    const bindings = sessions.listBindings();
    let calls = 0;
    const client = new WechatClawbotClient(async () => {
      calls++;
      const qrcode = 'secret-qr';
      const body = calls === 1 ? { ret: 0, qrcode, qrcode_img_content: `https://liteapp.weixin.qq.com/q/test?qrcode=${qrcode}&bot_type=3` }
        : { ret: 0, status: 'confirmed', ilink_user_id: failure === 'identity-missing' ? ''
          : failure === 'identity-null' ? null : failure === 'save-new' ? 'new-owner' : 'owner',
          ilink_bot_id: 'replacement-bot', bot_token: 'replacement-secret-token', baseurl: 'https://secret.invalid' };
      return new HttpResponse(200, new Headers(), Readable.from([JSON.stringify(body)]));
    });
    const login = new WechatLoginService(sessions, client, { now: () => now });
    t.after(() => login.shutdown());
    const app = new Hono().route('/api', wechatRoutes({ login, qrSvg: () => '<svg/>' }));
    if (failure !== 'identity-missing' && failure !== 'identity-null') db.exec("CREATE TRIGGER fail_binding BEFORE INSERT ON wechat_binding BEGIN SELECT RAISE(ABORT, 'replacement-secret-token https://secret.invalid upstream-body'); END");
    const prior = `quotahot_wechat=${token}`;
    const start = await app.request('/api/wechat/qrcode', { method: 'POST', headers: { cookie: prior } });
    assert.equal(start.status, 201);
    const attempt = record(await start.json()); assert.equal(typeof attempt.attemptId, 'string');
    const flow = start.headers.get('set-cookie')?.split(';')[0]; assert.ok(flow);

    const response = await app.request(`/api/wechat/qrcode/${attempt.attemptId}`, { headers: { cookie: `${prior}; ${flow}` } });

    assert.equal(response.status, failure === 'identity-missing' || failure === 'identity-null' ? 502 : 500); safe(response);
    const body: unknown = await response.json();
    assert.deepEqual(body, { error: failure === 'identity-missing' || failure === 'identity-null'
      ? 'wechat_identity_missing' : 'wechat_internal_error' });
    assert.doesNotMatch(JSON.stringify(body), /secret|token|upstream|baseurl|browserToken|flowToken|confirmed/);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(sessions.listBindings(), bindings);
    assert.equal((await app.request('/api/wechat/session', { headers: { cookie: prior } })).status, 404);
    assert.equal((await app.request('/api/wechat/session', { headers: { cookie: 'quotahot_wechat=synthetic-sibling-token' } })).status, 404);
    assert.equal((await app.request('/api/wechat/session')).status, 404);
    const repeated = await app.request(`/api/wechat/qrcode/${attempt.attemptId}`, { headers: { cookie: flow } });
    assert.equal(repeated.status, 404); assert.equal(repeated.headers.get('set-cookie'), null); assert.equal(calls, 2);
  });
}
