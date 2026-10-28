import assert from 'node:assert/strict';
import { createHash, createDecipheriv } from 'node:crypto';
import { access } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { HttpResponse, type request } from '../src/server/http.js';
import { IlinkBotClient, type IlinkJsonObject } from '../src/server/wechat-inbox/client.js';
import { WechatSessionStore } from '../src/server/wechat-session-store.js';
import { WechatInboxStore } from '../src/server/wechat-inbox/store.js';
import { InboxSendError, WechatInboxSender, type InboxSenderOptions } from '../src/server/wechat-inbox/sender.js';
import { WechatInboxTyping } from '../src/server/wechat-inbox/typing.js';
import { IlinkMediaError } from '../src/server/wechat-inbox/media.js';
import { input } from './helpers/wechat-inbox-store.js';

function reply(body = '{"ret":0}', status = 200, headers = {}) {
  return new HttpResponse(status, new Headers(headers), Readable.from([body]));
}
function gate() {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return { entered: entered.promise, release: () => released.resolve(), wait: () => {
    entered.resolve(); return released.promise;
  } };
}
function invalidate(sessions: WechatSessionStore, mode: string) {
  const binding = sessions.getBinding('owner');
  assert.ok(binding);
  switch (mode) {
    case 'pause': sessions.pauseBinding('owner'); break;
    case 'remove': sessions.removeBinding('owner'); break;
    case 'replace': sessions.saveBinding({ ...binding, botToken: 'replacement-secret' }, 0); break;
    case 'resume':
      sessions.pauseBinding('owner');
      sessions.confirmBinding(binding, 0);
      break;
    default: assert.fail('invalid test mode');
  }
}
function setup(t: TestContext, transport: typeof request, options: InboxSenderOptions = {}, contextOwners = ['owner', 'other']) {
  const store = new WechatInboxStore(':memory:');
  const sessions = new WechatSessionStore(':memory:');
  t.after(() => { store.close(); sessions.close(); });
  for (const owner of ['owner', 'other']) {
    sessions.saveBinding({ ownerIlinkUserId: owner, botId: 'bot', botToken: 'secret-token', baseUrl: 'https://api.test' }, 0);
    store.saveBinding({ ownerIlinkUserId: owner, botId: 'bot' }, new Date(0).toISOString());
    if (contextOwners.includes(owner)) {
      store.saveBatch(owner, { nextCursor: '', messages: [{ ...input('1'), contextToken: 'secret-context' }] });
    }
  }
  const target = { owner: 'owner' };
  const dependencies = { now: () => 0, createClient: (binding: ConstructorParameters<typeof IlinkBotClient>[0]) =>
    new IlinkBotClient(binding, transport), transport, ...options };
  return { store, sessions, target, sender: new WechatInboxSender(sessions, store, dependencies),
    typing: new WechatInboxTyping(sessions, store, dependencies) };
}

test('requires the selected binding inbound context before persisting or sending text and media', async (t) => {
  for (const kind of ['text', 'image', 'video', 'file'] as const) {
    const calls: string[] = [];
    const fixture = setup(t, async (url) => { calls.push(url); return reply(); }, {}, []);
    let consumed = false;
    const command = kind === 'text' ? { ...fixture.target, kind, text: 'first outbound' } as const
      : { ...fixture.target, kind, source: (async function* () { consumed = true; yield Buffer.from('media'); })(),
        fileName: 'first.bin', mediaType: 'application/octet-stream' } as const;

    await assert.rejects(fixture.sender.send(command), (error: unknown) => {
      assert.ok(error instanceof InboxSendError);
      assert.equal(error.code, 'context_required');
      return true;
    });
    assert.deepEqual(calls, []);
    assert.deepEqual(fixture.store.listMessages('owner').items, []);
    assert.equal(consumed, false);
  }
});

test('uses only each binding owner context when another binding is still waiting', async (t) => {
  const sent: IlinkJsonObject[] = [];
  const fixture = setup(t, async (_url, options = {}) => {
    const body: { msg: IlinkJsonObject } = JSON.parse(options.body ?? '{}');
    sent.push(body.msg);
    return reply();
  }, {}, ['other']);
  await assert.rejects(fixture.sender.send({ owner: 'owner', kind: 'text', text: 'must wait' }),
    new InboxSendError('context_required'));
  assert.equal(fixture.store.listMessages('owner').items.length, 0);
  assert.equal((await fixture.sender.send({ owner: 'other', kind: 'text', text: 'reply own user' })).state, 'accepted');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.to_user_id, 'other');
  assert.equal(sent[0]?.context_token, 'secret-context');
  assert.deepEqual(fixture.store.listMessages('owner').items, []);
});

for (const contextToken of ['', ' \t\n']) {
  test(`rejects a blank selected-binding context before persisting or sending: ${JSON.stringify(contextToken)}`, async (t) => {
    const calls: string[] = [];
    const fixture = setup(t, async (url) => { calls.push(url); return reply(); }, {}, []);
    fixture.store.saveBatch('owner', { nextCursor: '', messages: [{ ...input('empty-context'), contextToken }] });
    await assert.rejects(fixture.sender.send({ ...fixture.target, kind: 'text', text: 'must wait' }),
      new InboxSendError('context_required'));
    assert.deepEqual(calls, []);
    assert.deepEqual(fixture.store.listMessages('owner').items.map(({ remoteMessageId }) => remoteMessageId), ['empty-context']);
  });
}

test('persists sending before one text request when the target is local', async (t) => {
  const sent: IlinkJsonObject[] = [];
  const fixture = setup(t, async (_url, options = {}) => {
    const body: { msg: IlinkJsonObject } = JSON.parse(options.body ?? '{}');
    sent.push(body.msg);
    assert.equal(fixture.store.listMessages('owner').items.at(-1)?.state, 'sending');
    return reply();
  });
  const result = await fixture.sender.send({ ...fixture.target, kind: 'text', text: 'private text' });
  assert.equal(result.state, 'accepted');
  assert.match(result.messageId, /^[0-9a-f-]{36}$/);
  assert.equal(result.errorCode, null);
  assert.deepEqual(sent[0], { from_user_id: '', to_user_id: 'owner', client_id: sent[0]?.client_id,
    message_type: 2, message_state: 2, context_token: 'secret-context', item_list: [{ type: 1, text_item: { text: 'private text' } }] });
  assert.notEqual(sent[0]?.client_id, result.messageId);
  await fixture.sender.send({ ...fixture.target, kind: 'text', text: 'second' });
  assert.notEqual(sent[0]?.client_id, sent[1]?.client_id);
});

for (const [status, body, state] of [[200, '{"ret":9,"errmsg":"secret"}', 'failed'], [400, '', 'failed'],
  [401, '', 'failed'], [403, '', 'failed'], [408, '', 'unknown'], [425, '', 'unknown'], [500, '', 'unknown'],
  [200, 'invalid secret', 'unknown'], [0, '', 'unknown'], [-1, '', 'unknown']] as const) {
  test(`classifies ${status}/${body} without retry when send fails`, async (t) => {
    let calls = 0;
    const fixture = setup(t, async () => { calls++; if (status === -1) throw new DOMException('secret', 'TimeoutError'); if (!status) throw new Error('secret transport'); return reply(body, status); });
    const result = await fixture.sender.send({ ...fixture.target, kind: 'text', text: 'secret text' });
    assert.equal(result.state, state);
    assert.equal(result.errorCode, state === 'failed' ? 'send_rejected' : 'send_unknown');
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(result), /secret|client_id|context/);
  });
}

test('returns accepted when BOT echo precedes a rejected HTTP completion', async (t) => {
  const fixture = setup(t, async (_url, options = {}) => {
    const body: { msg: { client_id: string } } = JSON.parse(options.body ?? '{}');
    fixture.store.saveBatch('owner', { nextCursor: 'echo', messages: [{ ...input('echo', 'contact'),
      direction: 'outbound', messageType: 2, state: 'accepted', clientId: body.msg.client_id }] });
    return reply('{"ret":9}');
  });
  const result = await fixture.sender.send({ ...fixture.target, kind: 'text', text: 'hello' });
  assert.deepEqual(result, { messageId: result.messageId, state: 'accepted', errorCode: null });
  assert.equal(fixture.store.listMessages('owner').items.length, 2);
});

for (const scenario of ['missing', 'unlinked', 'relogin', 'paused'] as const) {
  test(`rejects ${scenario} target before upstream effects`, async (t) => {
    const fixture = setup(t, async () => assert.fail('unexpected network'), { getPollState: () => scenario === 'relogin' ? 'relogin_required' : 'polling' });
    let target = fixture.target;
    if (scenario === 'missing') target = { ...target, owner: 'missing' };
    if (scenario === 'unlinked') fixture.sessions.removeBinding('owner');
    if (scenario === 'paused') fixture.sessions.pauseBinding('owner');
    const code = scenario === 'missing' || scenario === 'unlinked' ? 'not_found' : 'binding_read_only';
    await assert.rejects(fixture.sender.send({ ...target, kind: 'text', text: 'secret' }), new InboxSendError(code));
    let consumed = false;
    const source = (async function* () { consumed = true; yield Buffer.from('voice'); })();
    await assert.rejects(fixture.sender.send({ ...target, kind: 'voice', source, fileName: 'voice', mediaType: 'audio/ogg' }), new InboxSendError(code));
    assert.equal(consumed, false);
    await assert.rejects(fixture.typing.send({ ...target, status: 1 }), new InboxSendError(code));
  });
}

test('does not contact upstream when insertion fails', async (t) => {
  const fixture = setup(t, async () => assert.fail('unexpected network'));
  t.mock.method(fixture.store, 'saveBatch', () => { throw new Error('secret database path'); });
  await assert.rejects(fixture.sender.send({ ...fixture.target, kind: 'text', text: 'secret' }), new InboxSendError('storage_failed'));
});

for (const kind of ['image', 'video', 'file'] as const) {
  test(`streams staged ${kind} with pinned metadata when upload succeeds`, async (t) => {
    const size = 4 * 1024 * 1024 + 17;
    let rawsize = 0;
    let ciphertext = 0;
    let key = '';
    let stagedFile = '';
    let sent: IlinkJsonObject | undefined;
    const fixture = setup(t, async (url, options = {}) => {
      if (url.includes('getuploadurl')) {
        const body: { rawsize: number; filesize: number; rawfilemd5: string; aeskey: string; media_type: number } = JSON.parse(options.body ?? '{}');
        const local = fixture.store.listMessages('owner').items.at(-1);
        assert.equal(local?.state, 'uploading'); assert.ok(local?.items[0]?.attachmentId);
        let persisted = 0;
        for (const chunk of fixture.store.readAttachmentChunks('owner', local.items[0].attachmentId)) {
          persisted += chunk.length; assert.ok(chunk.every((byte) => byte === 42));
        }
        assert.equal(persisted, size);
        assert.equal(body.rawsize, size); assert.equal(body.filesize, 16 * (Math.floor(size / 16) + 1));
        const hash = createHash('md5'); for (let count = 0; count < size; count += 65536) hash.update(Buffer.alloc(Math.min(65536, size - count), 42));
        assert.equal(body.rawfilemd5, hash.digest('hex'));
        assert.equal(body.media_type, { image: 1, video: 2, file: 3 }[kind]); key = body.aeskey;
        return reply('{"ret":0,"upload_full_url":"https://cdn.test/full","upload_param":"unused"}');
      }
      if (url === 'https://cdn.test/full') {
        assert.ok(options.bodyStream); assert.equal(options.bodyBytes, undefined); assert.equal(options.body, undefined);
        const decipher = createDecipheriv('aes-128-ecb', Buffer.from(key, 'hex'), null);
        for await (const chunk of options.bodyStream) {
          assert.ok(chunk.byteLength <= 65536); ciphertext += chunk.byteLength;
          const plain = decipher.update(chunk); rawsize += plain.length; assert.ok(plain.every((byte) => byte === 42));
        }
        rawsize += decipher.final().length;
        return reply('', 200, { 'x-encrypted-param': 'download-ref' });
      }
      const body: { msg: IlinkJsonObject } = JSON.parse(options.body ?? '{}'); sent = body.msg;
      assert.equal(fixture.store.listMessages('owner').items.at(-1)?.state, 'sending');
      return reply();
    });
    const original = fixture.store.saveBatch.bind(fixture.store);
    t.mock.method(fixture.store, 'saveBatch', (...args: Parameters<typeof original>) => {
      stagedFile = args[1].messages[0]?.items[0]?.attachment?.stagedFile ?? ''; original(...args);
    });
    const source = (async function* () { for (let offset = 0; offset < size; offset += 65536) yield Buffer.alloc(Math.min(65536, size - offset), 42); })();
    const result = await fixture.sender.send({ ...fixture.target, kind, source, fileName: '../unsafe?.bin', mediaType: 'application/octet-stream' });
    assert.equal(result.state, 'accepted'); assert.equal(rawsize, size);
    const media = { encrypt_query_param: 'download-ref', aes_key: Buffer.from(key).toString('base64'), encrypt_type: 1 };
    const item = kind === 'image' ? { type: 2, image_item: { media, mid_size: ciphertext } }
      : kind === 'video' ? { type: 5, video_item: { media, video_size: ciphertext } }
        : { type: 4, file_item: { media, file_name: 'unsafe_.bin', len: String(size) } };
    assert.deepEqual(sent?.item_list, [item]); assert.ok(stagedFile); await assert.rejects(access(stagedFile));
  });
}

test('retains failed local attachment and disposes staging when CDN fails', async (t) => {
  let calls = 0;
  let stagedFile = '';
  const fixture = setup(t, async () => { calls++; return calls === 1 ? reply('{"ret":0,"upload_full_url":"https://cdn.test/full"}') : reply('', 500); });
  const original = fixture.store.saveBatch.bind(fixture.store);
  t.mock.method(fixture.store, 'saveBatch', (...args: Parameters<typeof original>) => { stagedFile = args[1].messages[0]?.items[0]?.attachment?.stagedFile ?? ''; original(...args); });
  const result = await fixture.sender.send({ ...fixture.target, kind: 'file', source: Readable.from([Buffer.from('data')]), fileName: 'file', mediaType: 'application/octet-stream' });
  assert.equal(result.state, 'failed'); assert.equal(result.errorCode, 'upload_failed'); assert.equal(calls, 2);
  assert.equal(fixture.store.listMessages('owner').items.at(-1)?.items[0]?.sizeBytes, 4);
  await assert.rejects(access(stagedFile));
});

test('rejects voice before consuming source', async (t) => {
  const fixture = setup(t, async () => assert.fail('unexpected network'));
  const source = (async function* () { yield Buffer.from(assert.fail('source consumed')); })();
  await assert.rejects(fixture.sender.send({ ...fixture.target, kind: 'voice', source, fileName: 'voice', mediaType: 'audio/ogg' }), new InboxSendError('voice_outbound_disabled'));
});

for (const field of ['fileName', 'mediaType'] as const) {
  test(`rejects invalid ${field} before consuming media source`, async (t) => {
    const fixture = setup(t, async () => assert.fail('unexpected network'));
    let consumed = false;
    const source = (async function* () { consumed = true; yield Buffer.from('private media'); })();
    const command = { ...fixture.target, kind: 'file' as const, source, fileName: 'file', mediaType: 'application/octet-stream' };
    Reflect.set(command, field, field === 'fileName' ? null : 'invalid secret MIME');
    await assert.rejects(fixture.sender.send(command), new IlinkMediaError('invalid_metadata'));
    assert.equal(consumed, false);
    assert.equal(fixture.store.listMessages('owner').items.length, 1);
  });
}

test('refreshes typing by TTL, owner and context without exposing ticket', async (t) => {
  let now = 0;
  const configs: unknown[] = [];
  const statuses: number[] = [];
  const fixture = setup(t, async (url, options = {}) => {
    const body = JSON.parse(options.body ?? '{}');
    if (url.includes('getconfig')) { configs.push(body); return reply('{"ret":0,"typing_ticket":"secret-ticket"}'); }
    statuses.push(body.status); assert.equal(body.ilink_user_id, 'owner'); return reply();
  }, { now: () => now });
  assert.deepEqual(await fixture.typing.send({ ...fixture.target, status: 1 }), { ok: true, errorCode: null });
  await fixture.typing.send({ ...fixture.target, status: 2 }); assert.equal(configs.length, 1);
  now = 86400000; await fixture.typing.send({ ...fixture.target, status: 1 }); assert.equal(configs.length, 2);
  fixture.store.saveBatch('owner', { nextCursor: '', messages: [{ ...input('2'), contextToken: 'new-context' }] });
  await fixture.typing.send({ ...fixture.target, status: 1 }); assert.equal(configs.length, 3);
  await fixture.typing.send({ owner: 'other', status: 1 }); assert.equal(configs.length, 4);
  assert.deepEqual(statuses, [1, 2, 1, 1, 1]);
  assert.equal(JSON.stringify(configs).includes('new-context'), true);
  assert.doesNotMatch(JSON.stringify(fixture.store.listMessages('owner')), /secret-ticket/);
});

for (const mode of ['missing', 'config-failure', 'typing-failure'] as const) {
  test(`typing ${mode} remains safe and independent of message sending`, async (t) => {
    const fixture = setup(t, async (url) => {
      if (url.includes('sendmessage')) return reply();
      if (mode === 'config-failure' || (mode === 'typing-failure' && url.includes('sendtyping'))) throw new Error('secret-ticket context path');
      return reply(mode === 'missing' ? '{"ret":0}' : '{"ret":0,"typing_ticket":"secret-ticket"}');
    });
    assert.deepEqual(await fixture.typing.send({ ...fixture.target, status: 1 }),
      { ok: false, errorCode: mode === 'missing' ? 'typing_unavailable' : 'typing_failed' });
    assert.equal((await fixture.sender.send({ ...fixture.target, kind: 'text', text: 'hello' })).state, 'accepted');
  });
}

for (const failure of ['insert', 'upload-url', 'send', 'echo'] as const) {
  test(`disposes media snapshot when ${failure} interrupts the pipeline`, async (t) => {
    let stagedFile = '';
    let calls = 0;
    const fixture = setup(t, async (url, options = {}) => {
      calls++;
      if (url.includes('getuploadurl')) return failure === 'upload-url' ? reply('', 500) : reply('{"ret":0,"upload_full_url":"https://cdn.test/full"}');
      if (url.includes('cdn.test')) { assert.ok(options.bodyStream); for await (const chunk of options.bodyStream) assert.ok(chunk.length > 0); return reply('', 200, { 'x-encrypted-param': 'ref' }); }
      const body: { msg: { client_id: string } } = JSON.parse(options.body ?? '{}');
      if (failure === 'echo') fixture.store.saveBatch('owner', { nextCursor: '', messages: [{ ...input('echo', 'contact'), direction: 'outbound', messageType: 2, state: 'accepted', clientId: body.msg.client_id }] });
      throw new Error('secret network');
    });
    const original = fixture.store.saveBatch.bind(fixture.store);
    t.mock.method(fixture.store, 'saveBatch', (...args: Parameters<typeof original>) => {
      stagedFile = args[1].messages[0]?.items[0]?.attachment?.stagedFile ?? stagedFile;
      if (failure === 'insert') throw new Error('secret path'); original(...args);
    });
    const operation = fixture.sender.send({ ...fixture.target, kind: 'file', source: Readable.from([Buffer.from('data')]), fileName: 'file', mediaType: 'application/octet-stream' });
    if (failure === 'insert') { await assert.rejects(operation, new InboxSendError('storage_failed')); assert.equal(calls, 0); }
    else { const result = await operation; assert.equal(result.state, failure === 'echo' ? 'accepted' : failure === 'send' ? 'unknown' : 'failed'); assert.equal(calls, failure === 'upload-url' ? 1 : 3); }
    assert.ok(stagedFile); await assert.rejects(access(stagedFile));
  });
}

for (const stage of ['prepare', 'upload-url', 'cdn'] as const) {
  for (const mode of ['pause', 'remove', 'replace', 'resume']) {
    test(`fences media after ${stage} when owner ${mode}`, async (t) => {
      const deferred = gate();
      const effects: string[] = [];
      let stagedFile = '';
      const fixture = setup(t, async (url, options = {}) => {
        if (url.includes('getuploadurl')) {
          effects.push('upload-url');
          if (stage === 'upload-url') await deferred.wait();
          return reply('{"ret":0,"upload_full_url":"https://cdn.test/full"}');
        }
        if (url.includes('cdn.test')) {
          effects.push('cdn');
          assert.ok(options.bodyStream);
          for await (const chunk of options.bodyStream) assert.ok(chunk.length > 0);
          if (stage === 'cdn') await deferred.wait();
          return reply('', 200, { 'x-encrypted-param': 'ref' });
        }
        effects.push('send'); return reply();
      });
      const original = fixture.store.saveBatch.bind(fixture.store);
      t.mock.method(fixture.store, 'saveBatch', (...args: Parameters<typeof original>) => {
        stagedFile = args[1].messages[0]?.items[0]?.attachment?.stagedFile ?? stagedFile;
        original(...args);
      });
      const source = (async function* () {
        yield Buffer.from('data');
        if (stage === 'prepare') await deferred.wait();
      })();
      const operation = fixture.sender.send({ ...fixture.target, kind: 'file', source,
        fileName: 'file', mediaType: 'application/octet-stream' });
      const expectedCode = mode === 'remove' ? 'not_found' : 'binding_read_only';
      const outcome = assert.rejects(operation, new InboxSendError(expectedCode));
      await deferred.entered;
      invalidate(fixture.sessions, mode);
      deferred.release();
      await outcome;
      assert.deepEqual(effects, stage === 'prepare' ? [] : stage === 'upload-url' ? ['upload-url'] : ['upload-url', 'cdn']);
      const local = fixture.store.listMessages('owner').items.at(-1);
      assert.equal(local?.state, 'failed');
      assert.equal(local?.items[0]?.sizeBytes, 4);
      assert.ok(local?.items[0]?.attachmentId);
      assert.equal(Buffer.concat([...fixture.store.readAttachmentChunks('owner', local.items[0].attachmentId)]).toString(), 'data');
      assert.ok(stagedFile); await assert.rejects(access(stagedFile));
      assert.equal((await fixture.sender.send({ owner: 'other', kind: 'text', text: 'ok' })).state, 'accepted');
    });
  }
}

for (const mode of ['pause', 'remove', 'replace', 'resume']) {
  test(`fences typing after config when owner ${mode}`, async (t) => {
    const deferred = gate();
    let typingCalls = 0;
    const fixture = setup(t, async (url) => {
      if (url.includes('getconfig')) { await deferred.wait(); return reply('{"ret":0,"typing_ticket":"secret-ticket"}'); }
      typingCalls++; return reply();
    });
    const operation = fixture.typing.send({ ...fixture.target, status: 1 });
    await deferred.entered;
    invalidate(fixture.sessions, mode);
    deferred.release();
    assert.deepEqual(await operation, { ok: false, errorCode: 'typing_failed' });
    assert.equal(typingCalls, 0);
  });
}

test('refreshes cached typing ticket after credential replacement', async (t) => {
  let configs = 0;
  const tickets: string[] = [];
  const fixture = setup(t, async (url, options = {}) => {
    if (url.includes('getconfig')) { configs++; return reply(JSON.stringify({ ret: 0, typing_ticket: `ticket-${configs}` })); }
    tickets.push(JSON.parse(options.body ?? '{}').typing_ticket); return reply();
  });
  await fixture.typing.send({ ...fixture.target, status: 1 });
  invalidate(fixture.sessions, 'replace');
  await fixture.typing.send({ ...fixture.target, status: 1 });
  assert.equal(configs, 2);
  assert.deepEqual(tickets, ['ticket-1', 'ticket-2']);
});

test('keeps issued media send unknown without retry after owner pause', async (t) => {
  const deferred = gate();
  let sends = 0;
  const fixture = setup(t, async (url, options = {}) => {
    if (url.includes('getuploadurl')) return reply('{"ret":0,"upload_full_url":"https://cdn.test/full"}');
    if (url.includes('cdn.test')) {
      assert.ok(options.bodyStream);
      for await (const chunk of options.bodyStream) assert.ok(chunk.length > 0);
      return reply('', 200, { 'x-encrypted-param': 'ref' });
    }
    sends++; await deferred.wait(); throw new Error('secret uncertain send');
  });
  const operation = fixture.sender.send({ ...fixture.target, kind: 'file', source: Readable.from([Buffer.from('data')]), fileName: 'file', mediaType: 'application/octet-stream' });
  await deferred.entered;
  fixture.sessions.pauseBinding('owner');
  deferred.release();
  const result = await operation;
  assert.equal(result.state, 'unknown'); assert.equal(result.errorCode, 'send_unknown');
  assert.equal(sends, 1);
  assert.equal(fixture.store.listMessages('owner').items.at(-1)?.state, 'unknown');
});
