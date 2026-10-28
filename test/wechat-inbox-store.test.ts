import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as config from '../src/server/config.js';
import { WechatInboxStore, WECHAT_INBOX_DB_PATH } from '../src/server/wechat-inbox/store.js';
import { input, later, now, other, owner, pathFor, remoteId, setup } from './helpers/wechat-inbox-store.js';

test('defaults to an independent inbox database in the private WeChat directory', () => {
  assert.equal(WECHAT_INBOX_DB_PATH, join(dirname(config.WECHAT_DB_PATH), 'inbox.db'));
  assert.notEqual(WECHAT_INBOX_DB_PATH, config.WECHAT_DB_PATH);
  assert.notEqual(WECHAT_INBOX_DB_PATH, join(dirname(config.WECHAT_DB_PATH), 'conversations.db'));
  assert.equal(Object.hasOwn(config, 'WECHAT_CONVERSATIONS_DB_PATH'), false);
});

for (const existing of [false, true]) {
  test(`enforces owner-only directory, database and WAL permissions, existing=${existing}`, (t) => {
    const path = pathFor(t);
    if (existing) {
      mkdirSync(dirname(path), { mode: 0o755 });
      const db = new DatabaseSync(path);
      db.close();
      chmodSync(path, 0o666);
      chmodSync(dirname(path), 0o755);
    }
    const store = new WechatInboxStore(path);
    t.after(() => store.close());
    store.saveBinding({ ownerIlinkUserId: owner, botId: 'bot' }, now);
    assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
    for (const file of [path, `${path}-wal`, `${path}-shm`]) assert.equal(statSync(file).mode & 0o777, 0o600);
    const db = new DatabaseSync(path);
    t.after(() => db.close());
    assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const schema = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table'").all();
    assert.doesNotMatch(JSON.stringify(schema), /bot_token|baseurl|expires_at|inbox_contacts|conversation_id/);
  });
}

test('preserves bindings, creation time and the inbound cursor after reauthorization', (t) => {
  const { store } = setup(t);
  store.saveBatch(owner, { nextCursor: 'opaque-first', messages: [input()] });
  store.saveBinding({ ownerIlinkUserId: owner, botId: 'renewed', unlinkedAt: later }, later);
  assert.deepEqual(store.getBinding(owner), { ownerIlinkUserId: owner, botId: 'renewed',
    createdAt: now, updatedAt: later, unlinkedAt: later });
  assert.equal(store.listBindings().length, 2);
  assert.equal(store.getBinding('missing'), null);
  assert.equal(store.getCursor(owner), 'opaque-first');
  assert.equal(store.listMessages(owner).items.length, 1);
});

test('coordinates message sequence and remote-message deduplication across store handles', (t) => {
  const { store, path } = setup(t);
  const second = new WechatInboxStore(path);
  t.after(() => second.close());
  store.saveBatch(owner, { nextCursor: 'first', messages: [input()] });
  second.saveBatch(owner, { nextCursor: 'second', messages: [input(), input('2')] });
  assert.deepEqual(store.listMessages(owner).items.map((message) => message.sequence), [1, 2]);
  assert.equal(store.getCursor(owner), 'second');
});

test('rejects numeric remote IDs without advancing the cursor or storing a message', (t) => {
  const { store } = setup(t);
  const messages = [{ ...input(), remoteMessageId: 123 }];
  assert.throws(() => Reflect.apply(store.saveBatch, store, [owner, { nextCursor: 'lost', messages }]), TypeError);
  assert.equal(store.getCursor(owner), '');
  assert.deepEqual(store.listMessages(owner).items, []);
});

test('isolates each binding history and deduplicates remote IDs only within that binding', (t) => {
  const { store } = setup(t);
  store.saveBatch(owner, { nextCursor: 'a', messages: [input(), input(), input('other-id')] });
  store.saveBatch(other, { nextCursor: 'b', messages: [input()] });
  store.saveBatch(owner, { nextCursor: 'c', messages: [input('2')] });
  assert.equal(store.listMessages(owner).items.length, 3);
  assert.equal(store.listMessages(owner).items[0]?.remoteMessageId, remoteId);
  assert.equal(store.listMessages(other).items.length, 1);
  assert.equal(store.listMessages(other).items[0]?.remoteMessageId, remoteId);
  assert.deepEqual(store.listMessages('missing').items, []);
  assert.equal(store.getCursor(owner), 'c');
  assert.equal(store.getCursor(other), 'b');
});

test('pages each binding in stable sequence order despite tied timestamps and concurrent arrivals', (t) => {
  const { store } = setup(t);
  store.saveBatch(owner, { nextCursor: 'first', messages: Array.from({ length: 6 }, (_, index) =>
    ({ ...input(String(index)), createdAt: index % 2 ? later : now })) });
  const newest = store.listMessages(owner, { limit: 2 });
  assert.deepEqual(newest.items.map((message) => message.sequence), [5, 6]);
  assert.equal(newest.hasMore, true);
  assert.ok(newest.nextCursor);
  store.saveBatch(owner, { nextCursor: 'second', messages: [input('6')] });
  const middle = store.listMessages(owner, { limit: 2, before: newest.nextCursor });
  assert.deepEqual(middle.items.map((message) => message.sequence), [3, 4]);
  const oldest = store.listMessages(owner, { limit: 2, before: middle.nextCursor });
  assert.deepEqual(oldest.items.map((message) => message.sequence), [1, 2]);
  assert.equal(oldest.hasMore, false);
  assert.equal(oldest.nextCursor, null);
});

test('validates pagination limits and rejects malformed or foreign binding cursors', (t) => {
  const { store } = setup(t);
  store.saveBatch(owner, { nextCursor: 'next', messages: [input(), input('2')] });
  const page = store.listMessages(owner, { limit: 1 });
  assert.ok(page.nextCursor);
  for (const limit of [0, -1, 101, 1.5, NaN, Infinity]) assert.throws(() => store.listMessages(owner, { limit }), RangeError);
  for (const before of ['', '1', 'broken', '00000000-0000-4000-8000-000000000000']) {
    assert.throws(() => store.listMessages(owner, { before }), RangeError);
  }
  assert.throws(() => store.listMessages(other, { before: page.nextCursor }), RangeError);
});

test('keeps prior polling cursor for empty next cursors and accepts cursor-only batches', (t) => {
  const { store } = setup(t);
  store.saveBatch(owner, { nextCursor: 'opaque\u0000cursor', messages: [] });
  store.saveBatch(owner, { nextCursor: '', messages: [input()] });
  assert.equal(store.getCursor(owner), 'opaque\u0000cursor');
  assert.equal(store.listMessages(owner).items.length, 1);
  assert.throws(() => store.saveBatch('missing', { nextCursor: 'x', messages: [input()] }));
});
