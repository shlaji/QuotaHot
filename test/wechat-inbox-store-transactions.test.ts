import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { input, owner, other, placeholder, setup } from './helpers/wechat-inbox-store.js';

test('rolls back binding history, private context, attachment bytes and cursor when batch commit fails', (t) => {
  const { store, path } = setup(t);
  store.saveBatch(owner, { nextCursor: 'retained', messages: [{ ...input(), contextToken: 'retained-context' }] });
  const before = store.listMessages(owner);
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  db.exec("CREATE TRIGGER reject_cursor BEFORE UPDATE OF cursor ON inbox_cursors BEGIN SELECT RAISE(ABORT, 'test cursor failure'); END;");

  assert.throws(() => store.saveBatch(owner, { nextCursor: 'lost', messages: [{ ...input('new'), contextToken: 'new-context',
    items: [{ kind: 'file', attachment: { fileName: 'new.txt', mediaType: 'text/plain', bytes: Buffer.from('bytes') } }] }] }));
  assert.deepEqual(store.listMessages(owner), before);
  assert.equal(store.getCursor(owner), 'retained');
  assert.equal(store.getLatestContextToken(owner), 'retained-context');
  assert.deepEqual(store.listMessages(other).items, []);
});

test('stores duplicate malformed-message fingerprints once within the binding only', (t) => {
  const { store } = setup(t);
  const value = placeholder();
  store.saveBatch(owner, { nextCursor: 'one', messages: [value] });
  store.saveBatch(owner, { nextCursor: 'two', messages: [value] });
  store.saveBatch(other, { nextCursor: 'other', messages: [value] });
  assert.equal(store.listMessages(owner).items.length, 1);
  assert.equal(store.listMessages(other).items.length, 1);
  assert.equal(store.getCursor(owner), 'two');
});

test('rejects a client ID claimed by two outbound messages inside one binding without corrupting prior history', (t) => {
  const { store } = setup(t);
  store.saveBatch(owner, { nextCursor: 'before', messages: [{ ...input(null), direction: 'outbound', messageType: 2,
    clientId: 'same-client', state: 'sending' }] });
  const before = store.listMessages(owner);
  assert.throws(() => store.saveBatch(owner, { nextCursor: 'lost', messages: [{ ...input(null), direction: 'outbound',
    messageType: 2, clientId: 'same-client', state: 'sending', items: [{ kind: 'text', text: 'different message' }] }] }));
  assert.deepEqual(store.listMessages(owner), before);
  assert.equal(store.getCursor(owner), 'before');
});

test('prevents a foreign binding cursor from reading or advancing another binding history', (t) => {
  const { store } = setup(t);
  store.saveBatch(owner, { nextCursor: 'owner-cursor', messages: [input('owner-remote')] });
  store.saveBatch(other, { nextCursor: 'other-cursor', messages: [input('other-remote')] });
  const cursor = store.listMessages(owner, { limit: 1 }).nextCursor;
  assert.equal(cursor, null);
  assert.throws(() => store.listMessages(other, { before: store.listMessages(owner, { limit: 1 }).items[0]?.id }));
  assert.deepEqual(store.listMessages(owner).items.map((message) => message.remoteMessageId), ['owner-remote']);
  assert.deepEqual(store.listMessages(other).items.map((message) => message.remoteMessageId), ['other-remote']);
});
