import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { mock, test, type TestContext } from 'node:test';
import { HttpResponse, type request } from '../src/server/http.js';
import { WechatSessionStore } from '../src/server/wechat-session-store.js';
import { WechatInboxStore } from '../src/server/wechat-inbox/store.js';
import type { IlinkJsonObject, IlinkMessage, IlinkMessageResult, IlinkUpdates } from '../src/server/wechat-inbox/client.js';
import { InboxMediaStaging, InboxStagingError } from '../src/server/wechat-inbox/media-staging.js';
import { InboxAttachmentSourceError } from '../src/server/wechat-inbox/store-types.js';

let transport: typeof request = async () => { assert.fail('unexpected CDN request'); };
let stagingRoot = '';
mock.module('../src/server/wechat-inbox/media-staging.js', { exports: { InboxStagingError,
  InboxMediaStaging: class extends InboxMediaStaging { constructor() { super(stagingRoot); } } } });
mock.module('../src/server/http.js', { exports: { HttpResponse, request: (...args: Parameters<typeof request>) => transport(...args) } });
const { WechatInboxService } = await import('../src/server/wechat-inbox/service.js');
const { IlinkMediaError } = await import('../src/server/wechat-inbox/media.js');
const now = Date.parse('2026-10-20T12:00:00.000Z');
const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
function message(id: string, items: readonly IlinkJsonObject[] = [{ type: 1, text_item: { text: 'hello' } }],
  extra: Partial<IlinkMessage> = {}): IlinkMessageResult {
  return { kind: 'message', message: { message_id: id, message_type: 1, direction: 'inbound',
    from_user_id: 'owner', item_list: items.map((item) => ({ kind: 'item', item })), ...extra } };
}
function updates(msgs: readonly IlinkMessageResult[], cursor = 'next'): IlinkUpdates {
  return { kind: 'updates', msgs, get_updates_buf: cursor };
}
function setup(t: TestContext) {
  stagingRoot = mkdtempSync(join(tmpdir(), 'inbox-service-test-'));
  const root = stagingRoot;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessions = new WechatSessionStore(':memory:');
  const store = new WechatInboxStore(':memory:');
  t.after(() => { store.close(); sessions.close(); });
  sessions.saveBinding({ ownerIlinkUserId: 'owner', botId: 'bot', botToken: 'secret-token', baseUrl: 'https://secret-api.test' }, now);
  const service = new WechatInboxService(sessions, store, { now: () => now, getPollState: () => 'polling' });
  service.activateBinding('owner');
  return { sessions, store, service, root };
}
function encrypted(bytes: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}

for (const kind of ['image', 'voice', 'file', 'video'] as const) {
  test(`buffers and persists known ${kind} media only after successful AES completion`, async (t) => {
    const { store, service, root } = setup(t);
    const paths: string[] = [];
    const saveBatch = store.saveBatch.bind(store);
    const save = t.mock.method(store, 'saveBatch', (...[owner, batch]: Parameters<WechatInboxStore['saveBatch']>) => {
      for (const input of batch.messages) for (const item of input.items) {
        const attachment = item.attachment;
        assert.ok(attachment && 'stagedFile' in attachment);
        assert.ok(attachment.stagedFile);
        assert.equal('bytes' in attachment, false);
        assert.equal(statSync(attachment.stagedFile).size, plain.length);
        paths.push(attachment.stagedFile);
      }
      saveBatch(owner, batch);
    });
    const plain = Buffer.from(`complete ${kind}`);
    transport = async (url) => {
      assert.equal(url, 'https://cdn.test/secret-url');
      return new HttpResponse(200, new Headers(), Readable.from([encrypted(plain)]));
    };
    const media = { full_url: 'https://cdn.test/secret-url', aes_key: Buffer.from(key.toString('hex')).toString('base64') };
    const items = { image: { type: 2, image_item: { media: { ...media, aes_key: 'invalid-secondary-key' }, aeskey: key.toString('hex'), thumb_width: 10, thumb_height: 20 } },
      voice: { type: 3, voice_item: { media, text: 'transcript', encode_type: 6, playtime: 120 } },
      file: { type: 4, file_item: { media, file_name: '../report.bin', len: String(plain.length) } },
      video: { type: 5, video_item: { media, video_size: plain.length, play_length: 3 } } };
    await service.processUpdates('owner', updates([message('1', [items[kind]])]));
    assert.equal(save.mock.callCount(), 1);
    assert.equal(paths.length, 1);
    assert.equal(existsSync(paths[0]), false);
    assert.deepEqual(readdirSync(root), []);
    const item = service.listMessages('owner').items[0]?.items[0];
    assert.equal(item?.kind, kind);
    assert.ok(item?.attachmentId);
    assert.deepEqual(Buffer.concat([...store.readAttachmentChunks('owner', item.attachmentId)]), plain);
    assert.equal(item.sizeBytes, plain.length);
    assert.doesNotMatch(JSON.stringify(item), /secret|aes|full_url/);
    if (kind === 'file') assert.equal(item.fileName, 'report.bin');
    if (kind === 'voice') assert.equal(item.text, 'transcript');
  });
}

test('uses image media raw-base64 key and configured query fallback without guessing hosts', async (t) => {
  const { sessions, store } = setup(t);
  const service = new WechatInboxService(sessions, store, { now: () => now, cdnBaseUrl: () => 'https://configured.test/cdn/' });
  transport = async (url) => {
    assert.equal(url, 'https://configured.test/cdn/download?encrypted_query_param=a%2B%2F%3D');
    return new HttpResponse(200, new Headers(), Readable.from([encrypted(Buffer.from('image'))]));
  };
  await service.processUpdates('owner', updates([message('1', [{ type: 2, image_item: {
    media: { encrypt_query_param: 'a+/=', aes_key: key.toString('base64') } } }])]));
  assert.equal(service.listMessages('owner').items[0]?.items[0]?.kind, 'image');
});

test('downloads plain IMAGE without a key using the verified CDN reference', async (t) => {
  const { store, service } = setup(t);
  transport = async () => new HttpResponse(200, new Headers(), Readable.from([Buffer.from('plain image')]));
  await service.processUpdates('owner', updates([message('1', [{ type: 2, image_item: {
    media: { full_url: 'https://cdn.test/plain' } } }])]));
  const item = service.listMessages('owner').items[0]?.items[0];
  assert.ok(item?.attachmentId);
  assert.deepEqual(Buffer.concat([...store.readAttachmentChunks('owner', item.attachmentId)]), Buffer.from('plain image'));
});

test('padding and stream failures discard partial plaintext and continue the batch', async (t) => {
  const { store, service, root } = setup(t);
  const cipher = encrypted(Buffer.alloc(65536, 1));
  transport = async () => new HttpResponse(200, new Headers(), Readable.from([cipher.subarray(0, cipher.length - 1)]));
  await service.processUpdates('owner', updates([message('1', [{ type: 4, file_item: {
    media: { full_url: 'https://cdn.test/secret', aes_key: key.toString('base64') } } }]), message('2')]));
  const page = service.listMessages('owner');
  assert.equal(page.items[0]?.items[0]?.kind, 'protocol_event');
  assert.equal(page.items[0]?.items[0]?.attachmentId, null);
  assert.equal(page.items[1]?.text, 'hello');
  assert.equal(store.getCursor('owner'), 'next');
  assert.deepEqual(readdirSync(root), []);
});

for (const failure of ['sql', 'source', 'staging', 'service'] as const) {
  test(`cleans staged media and preserves the cursor when ${failure} fails`, async (t) => {
    const { sessions, store, service: regularService, root } = setup(t);
    const service = failure === 'service' ? new WechatInboxService(sessions, store, { now: () => { throw new RangeError('service failure'); } }) : regularService;
    transport = async () => new HttpResponse(200, new Headers(), Readable.from([Buffer.alloc(131073, 7)]));
    const saveBatch = store.saveBatch.bind(store);
    const stage = InboxMediaStaging.prototype.stage;
    if (failure === 'sql') store['db'].exec("CREATE TEMP TRIGGER fail_chunk BEFORE INSERT ON inbox_binding_chunks BEGIN SELECT RAISE(ABORT, 'sql failure'); END");
    if (failure === 'staging') t.mock.method(InboxMediaStaging.prototype, 'stage', async function(this: InboxMediaStaging,
      ...[source, signal]: Parameters<InboxMediaStaging['stage']>) {
      await stage.call(this, source, signal); throw new InboxStagingError('write_failed');
    });
    const save = t.mock.method(store, 'saveBatch', (...[owner, batch]: Parameters<WechatInboxStore['saveBatch']>) => {
      const attachment = batch.messages[0]?.items[0]?.attachment;
      assert.ok(attachment && 'stagedFile' in attachment);
      assert.ok(attachment.stagedFile);
      if (failure === 'source') rmSync(attachment.stagedFile);
      saveBatch(owner, batch);
    });
    const media = message('1', [{ type: 2, image_item: { media: { full_url: 'https://cdn.test/plain' } } }]);
    await assert.rejects(service.processUpdates('owner', updates([media])), (error: unknown) => {
      switch (failure) {
        case 'sql': return error instanceof Error && error.message === 'sql failure';
        case 'source': return error instanceof InboxAttachmentSourceError;
        case 'staging': return error instanceof InboxStagingError && error.code === 'write_failed';
        case 'service': return error instanceof RangeError && error.message === 'service failure';
      }
    });
    assert.equal(save.mock.callCount(), failure === 'staging' || failure === 'service' ? 0 : 1);
    assert.equal(store.getCursor('owner'), '');
    assert.deepEqual(store.listMessages('owner').items, []);
    assert.deepEqual(readdirSync(root), []);
  });
}

test('aborted media rejects the batch before saving any messages or cursor', async (t) => {
  const { store, service } = setup(t);
  transport = async () => { throw new IlinkMediaError('aborted'); };
  const save = mock.method(store, 'saveBatch');
  await assert.rejects(service.processUpdates('owner', updates([message('1'), message('2', [{ type: 2, image_item: {
    media: { full_url: 'https://cdn.test/secret' } } }])])), (error: unknown) => error instanceof IlinkMediaError && error.code === 'aborted');
  assert.equal(save.mock.callCount(), 0);
  assert.equal(store.getCursor('owner'), '');
  assert.deepEqual(store.listMessages('owner').items, []);
});

test('ignores unverified cross-kind metadata instead of echoing unexpected media fields', async (t) => {
  const { store, service } = setup(t);
  transport = async () => new HttpResponse(200, new Headers(), Readable.from([Buffer.from('plain')]));
  await service.processUpdates('owner', updates([message('1', [{ type: 2, image_item: {
    media: { full_url: 'https://cdn.test/plain' }, text: 'secret-unverified', file_name: 'secret-unverified', encode_type: 42,
  } }])]));
  assert.doesNotMatch(JSON.stringify(service.listMessages('owner')), /secret-unverified/);
});

test('rejects non-ASCII base64 key bytes instead of masking them into a hex key', async (t) => {
  const { store, service } = setup(t);
  const masked = Buffer.from([...Buffer.from(key.toString('hex'))].map((byte) => byte | 128)).toString('base64');
  let calls = 0;
  transport = async () => { calls++; return new HttpResponse(403, new Headers(), Readable.from([])); };
  await service.processUpdates('owner', updates([message('1', [{ type: 4, file_item: {
    media: { full_url: 'https://cdn.test/secret', aes_key: masked },
  } }])]));
  assert.equal(service.listMessages('owner').items[0]?.items[0]?.kind, 'protocol_event');
  assert.equal(calls, 0);
});

const invalidMediaItems: readonly IlinkJsonObject[] = [
  { type: 2, image_item: { mid_size: 'secret' } }, { type: 3, voice_item: { text: { secret: true } } },
  { type: 3, voice_item: { playtime: -1 } }, { type: 3, voice_item: { encode_type: 1.5 } },
  { type: 4, file_item: { file_name: { secret: true } } }, { type: 4, file_item: { len: 'secret' } },
  { type: 5, video_item: { video_size: -1 } }, { type: 5, video_item: { play_length: 'secret' } },
];
for (const item of invalidMediaItems) {
  test('replaces malformed known media metadata before downloading and commits following text', async (t) => {
    const { store, service } = setup(t);
    const media = { full_url: 'https://cdn.test/secret', aes_key: key.toString('base64') };
    const field = Object.keys(item).find((name) => name.endsWith('_item'));
    assert.ok(field);
    const data = item[field];
    assert.ok(typeof data === 'object' && data !== null && !Array.isArray(data));
    let calls = 0;
    transport = async () => { calls++; return new HttpResponse(403, new Headers(), Readable.from([])); };
    await service.processUpdates('owner', updates([message('1', [{ ...item, [field]: { ...data, media } }]), message('2')]));
    assert.equal(calls, 0);
    const page = service.listMessages('owner');
    assert.equal(page.items[0]?.items[0]?.kind, 'protocol_event');
    assert.equal(page.items[1]?.text, 'hello');
    assert.doesNotMatch(JSON.stringify(page), /secret/);
    assert.equal(store.getCursor('owner'), 'next');
  });
}
