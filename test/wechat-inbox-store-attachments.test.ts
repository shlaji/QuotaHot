import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { WechatInboxStore } from '../src/server/wechat-inbox/store.js';
import { InboxAttachmentSourceError } from '../src/server/wechat-inbox/store-types.js';
import { input, localId, now, other, owner, pathFor, placeholder, remoteId, setup } from './helpers/wechat-inbox-store.js';

test('retains ordered message items and 64 KiB BLOB chunks across restart without TTL', (t) => {
  const path = pathFor(t);
  const first = new WechatInboxStore(path);
  first.saveBinding({ ownerIlinkUserId: owner, botId: 'bot' }, now);
  const bytes = Buffer.from(Array.from({ length: 131073 }, (_, index) => index % 251));
  const contextToken = 'private-context-survives-restart';
  first.saveBatch(owner, { nextCursor: 'saved', messages: [{ ...input(), contextToken, items: [
    { kind: 'text', text: 'prefix\n' },
    { kind: 'file', attachment: { fileName: 'safe.bin', mediaType: 'application/octet-stream', bytes } },
    { kind: 'voice', text: 'transcript', codec: 'silk', durationMs: 1200 },
    { kind: 'protocol_event', safeSummary: 'unsupported:99' },
  ] }] });
  const id = localId(first);
  const saved = first.listMessages(owner);
  first.close();
  const reopened = new WechatInboxStore(path);
  t.after(() => reopened.close());
  const page = reopened.listMessages(owner);
  assert.equal(reopened.getLatestContextToken(owner), contextToken);
  assert.deepEqual(page, saved);
  assert.equal(page.items.length, 1);
  const message = page.items[0];
  assert.ok(message);
  assert.equal(message.remoteMessageId, remoteId);
  assert.equal(message.direction, 'inbound');
  assert.equal(message.messageType, 1);
  assert.equal(message.kind, 'text');
  assert.equal(message.state, 'received');
  assert.equal(message.sequence, 1);
  assert.equal(message.createdAt, now);
  assert.equal(message.text, 'prefix\n');
  assert.deepEqual(message.items.map((item) => item.kind), ['text', 'file', 'voice', 'protocol_event']);
  assert.equal(message.items[0]?.text, 'prefix\n');
  assert.equal(message.items[1]?.fileName, 'safe.bin');
  assert.equal(message.items[1]?.mediaType, 'application/octet-stream');
  assert.equal(message.items[1]?.sizeBytes, bytes.length);
  assert.equal(message.items[2]?.text, 'transcript');
  assert.equal(message.items[2]?.codec, 'silk');
  assert.equal(message.items[2]?.durationMs, 1200);
  assert.equal(message.items[3]?.safeSummary, 'unsupported:99');
  assert.equal(reopened.getCursor(owner), 'saved');
  const attachmentId = page.items[0]?.items[1]?.attachmentId;
  assert.ok(attachmentId);
  const attachment = reopened.getAttachment(owner, attachmentId);
  assert.equal(attachment?.sizeBytes, bytes.length);
  assert.equal(attachment?.chunkCount, 3);
  assert.equal(attachment?.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(attachment?.messageId, message.id);
  assert.equal(attachment?.direction, 'inbound');
  assert.equal(attachment?.kind, 'file');
  assert.equal(attachment?.fileName, 'safe.bin');
  assert.equal(attachment?.mediaType, 'application/octet-stream');
  assert.equal(attachment?.createdAt, now);
  for (const dto of [page, message, attachment]) {
    const serialized = JSON.stringify(dto);
    assert.ok(!serialized.includes(contextToken));
    assert.doesNotMatch(serialized, /contextToken|latestContextToken|context_token/);
  }
  const chunks = [...reopened.readAttachmentChunks(owner, attachmentId)];
  assert.deepEqual(chunks.map((chunk) => chunk.length), [65536, 65536, 1]);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  assert.equal(reopened.getAttachment(other, attachmentId), null);
  assert.deepEqual([...reopened.readAttachmentChunks(other, attachmentId)], []);
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  assert.deepEqual(db.prepare('SELECT length(data) AS size FROM inbox_binding_chunks ORDER BY chunk_index')
    .all().map((row) => row.size), [65536, 65536, 1]);
});

for (const size of [0, 1, 65536, 65537]) {
  test(`staged files match bytes metadata and exact chunks when size is ${size}`, (t) => {
    const { store, path } = setup(t);
    const stagedFile = join(dirname(path), 'plaintext');
    const bytes = Buffer.from(Array.from({ length: size }, (_, index) => index % 251));
    fs.writeFileSync(stagedFile, bytes, { mode: 0o600 });
    store.saveBatch(owner, { nextCursor: 'saved', messages: [{ ...input(), items: [
      { kind: 'file', attachment: { fileName: 'safe.bin', mediaType: 'application/octet-stream', bytes } },
      { kind: 'file', attachment: { fileName: 'safe.bin', mediaType: 'application/octet-stream', stagedFile } },
    ] }] });
    const conversationId = localId(store);
    const page = store.listMessages(owner);
    const attachments = page.items[0]?.items.map((item) => {
      assert.ok(item.attachmentId);
      const attachment = store.getAttachment(owner, item.attachmentId);
      assert.ok(attachment);
      const chunks = [...store.readAttachmentChunks(owner, item.attachmentId)];
      assert.deepEqual(Buffer.concat(chunks), bytes);
      assert.equal(attachment.sizeBytes, size);
      assert.equal(attachment.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(attachment.chunkCount, Math.ceil(size / 65536));
      assert.ok(!JSON.stringify(attachment).includes(stagedFile));
      return { size: attachment.sizeBytes, hash: attachment.sha256, chunks };
    });
    assert.deepEqual(attachments?.[0], attachments?.[1]);
    assert.ok(!JSON.stringify(page).includes(stagedFile));
    const db = new DatabaseSync(path);
    t.after(() => db.close());
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM inbox_binding_attachments').all()).includes(stagedFile));
  });
}

test('streams a large staged file with a reused bounded buffer even when reads are short', (t) => {
  const { store, path } = setup(t);
  const stagedFile = join(dirname(path), 'large-plaintext');
  const block = Buffer.alloc(65536);
  const digest = createHash('sha256');
  const descriptor = fs.openSync(stagedFile, 'wx', 0o600);
  try {
    for (let index = 0; index < 257; index++) {
      block.fill(index % 251);
      fs.writeSync(descriptor, block);
      digest.update(block);
    }
  } finally { fs.closeSync(descriptor); }
  const read = fs.readSync;
  const close = fs.closeSync;
  let bufferSeen: NodeJS.ArrayBufferView | undefined;
  let closed = 0;
  t.mock.method(fs, 'readSync', (fd: number, buffer: NodeJS.ArrayBufferView, options: fs.ReadOptions = {}) => {
    assert.ok(buffer.byteLength <= 65536);
    bufferSeen ??= buffer;
    assert.equal(buffer, bufferSeen);
    return read(fd, buffer, { ...options, length: Math.min(options.length ?? buffer.byteLength, 997) });
  });
  t.mock.method(fs, 'closeSync', (fd: number) => { closed++; close(fd); });
  t.mock.method(fs, 'readFileSync', () => { assert.fail('full-file reads are forbidden'); });
  store.saveBatch(owner, { nextCursor: 'large', messages: [{ ...input(), items: [
    { kind: 'file', attachment: { fileName: 'large.bin', mediaType: 'application/octet-stream', stagedFile } },
  ] }] });
  assert.equal(closed, 1);
  assert.ok(bufferSeen);
  const conversationId = localId(store);
  const attachmentId = store.listMessages(owner).items[0]?.items[0]?.attachmentId;
  assert.ok(attachmentId);
  const attachment = store.getAttachment(owner, attachmentId);
  assert.equal(attachment?.sizeBytes, 257 * 65536);
  assert.equal(attachment?.chunkCount, 257);
  assert.equal(attachment?.sha256, digest.digest('hex'));
  let index = 0;
  for (const chunk of store.readAttachmentChunks(owner, attachmentId)) {
    block.fill(index++ % 251);
    assert.deepEqual(Buffer.from(chunk), block);
  }
  assert.equal(index, 257);
});

for (const source of ['missing', 'directory', 'symlink', 'nul', 'empty', 'relative', 'number', 'both']) {
  test(`rejects an invalid staged source safely when source is ${source}`, (t) => {
    const { store, path } = setup(t);
    const file = join(dirname(path), 'plaintext');
    fs.writeFileSync(file, 'private', { mode: 0o600 });
    const link = `${file}.link`;
    fs.symlinkSync(file, link);
    const paths: Record<string, unknown> = { missing: `${file}.missing`, directory: dirname(path), symlink: link,
      nul: `${file}\0`, empty: '', relative: 'plaintext', number: 123, both: file };
    const attachment = { fileName: 'safe.bin', mediaType: 'application/octet-stream', stagedFile: paths[source],
      ...(source === 'both' ? { bytes: Buffer.from('private') } : {}) };
    assert.throws(() => Reflect.apply(store.saveBatch, store, [owner, { nextCursor: 'lost', messages: [
      { ...input(), items: [{ kind: 'file', attachment }] },
    ] }]), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'InboxAttachmentSourceError');
      assert.equal(error.message, 'Inbox staged attachment unavailable');
      assert.equal(error.cause, undefined);
      assert.ok(!String(error.stack).includes(file));
      return true;
    });
    assert.deepEqual(store.listMessages(owner).items, []);
    assert.equal(store.getCursor(owner), '');
  });
}

for (const failure of ['metadata', 'chunk', 'cursor', 'open', 'stat', 'read', 'truncated']) {
  test(`rolls back the complete staged batch and closes the file when ${failure} fails`, (t) => {
    const { store, path } = setup(t);
    store.saveBatch(owner, { nextCursor: 'retained', messages: [] });
    const stagedFile = join(dirname(path), 'plaintext');
    fs.writeFileSync(stagedFile, Buffer.alloc(131073, 7), { mode: 0o600 });
    const db = new DatabaseSync(path);
    t.after(() => db.close());
    const triggers: Record<string, string> = {
      metadata: "BEFORE UPDATE ON inbox_binding_attachments",
      chunk: "BEFORE INSERT ON inbox_binding_chunks WHEN NEW.chunk_index = 1",
      cursor: "BEFORE UPDATE ON inbox_cursors",
    };
    if (triggers[failure]) db.exec(`CREATE TRIGGER reject_staged ${triggers[failure]}
      BEGIN SELECT RAISE(ABORT, 'staged database failure'); END;`);
    const read = fs.readSync;
    const close = fs.closeSync;
    let reads = 0;
    let closed = 0;
    t.mock.method(fs, 'closeSync', (fd: number) => { closed++; close(fd); });
    if (failure === 'open') t.mock.method(fs, 'openSync', () => { throw new Error(`private open: ${stagedFile}`); });
    if (failure === 'stat') t.mock.method(fs, 'fstatSync', () => { throw new Error(`private stat: ${stagedFile}`); });
    if (failure === 'read' || failure === 'truncated') {
      t.mock.method(fs, 'readSync', (fd: number, buffer: NodeJS.ArrayBufferView, options?: fs.ReadOptions) => {
        if (reads++ > 0) {
          if (failure === 'read') throw new Error(`private cause: ${stagedFile}`);
          return 0;
        }
        return read(fd, buffer, options);
      });
    }
    assert.throws(() => store.saveBatch(owner, { nextCursor: 'lost', messages: [placeholder(),
      { ...input(), contextToken: 'secret-context', items: [{ kind: 'file', attachment: {
        fileName: 'safe.bin', mediaType: 'application/octet-stream', stagedFile,
      } }] },
    ] }), (error: unknown) => {
      assert.ok(error instanceof Error);
      if (triggers[failure]) assert.match(error.message, /staged database failure/);
      else {
        assert.ok(error instanceof InboxAttachmentSourceError);
        assert.equal(error.code, 'staged_file_unavailable');
        assert.equal(error.cause, undefined);
        assert.ok(!String(error.stack).includes(stagedFile));
      }
      return true;
    });
    assert.equal(closed, failure === 'open' ? 0 : 1);
    assert.equal(store.getCursor(owner), 'retained');
    assert.deepEqual(store.listMessages(owner).items, []);
    assert.equal(store.getLatestContextToken(owner), null);
    for (const table of ['inbox_binding_messages', 'inbox_binding_items', 'inbox_binding_contexts', 'inbox_binding_attachments', 'inbox_binding_chunks']) {
      assert.equal(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count, 0);
    }
  });
}
