import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { input, other, owner, remoteId, setup } from './helpers/wechat-inbox-store.js';

test('isolates the latest private context token by binding owner only', (t) => {
  const { store } = setup(t);
  store.saveBatch(owner, { nextCursor: 'a', messages: [
    { ...input(), contextToken: 'secret-owner-contact' },
    { ...input('2', 'second'), contextToken: 'secret-owner-second' },
  ] });
  store.saveBatch(other, { nextCursor: 'b', messages: [{ ...input(), contextToken: 'secret-other-contact' }] });

  assert.equal(store.getLatestContextToken(owner), 'secret-owner-second');
  assert.equal(store.getLatestContextToken(other), 'secret-other-contact');
  assert.equal(store.getLatestContextToken('missing'), null);
});

for (const update of ['new-secret', null, undefined]) {
  test(`updates inbound context with explicit values and preserves it on omission: ${update}`, (t) => {
    const { store } = setup(t);
    store.saveBatch(owner, { nextCursor: 'old', messages: [{ ...input(), contextToken: 'old-secret' }] });
    const message = update === undefined ? input('2') : { ...input('2'), contextToken: update };

    store.saveBatch(owner, { nextCursor: 'new', messages: [message] });

    assert.equal(store.getLatestContextToken(owner), update === undefined ? 'old-secret' : update);
    assert.equal(store.getCursor(owner), 'new');
  });
}

test('does not replace inbound context with a duplicate message or outbound context', (t) => {
  const { store } = setup(t);
  store.saveBatch(owner, { nextCursor: 'old', messages: [{ ...input(), contextToken: 'retained-secret' }] });

  store.saveBatch(owner, { nextCursor: 'new', messages: [
    { ...input(), contextToken: 'duplicate-secret' },
    { ...input('2'), direction: 'outbound', contextToken: 'outbound-secret' },
  ] });

  assert.equal(store.getLatestContextToken(owner), 'retained-secret');
  assert.deepEqual(store.listMessages(owner).items.map((message) => message.sequence), [1, 2]);
});

test('restores an existing context token when the cursor write rejects its replacement', (t) => {
  const { store, path } = setup(t);
  store.saveBatch(owner, { nextCursor: 'old', messages: [{ ...input(), contextToken: 'retained-secret' }] });
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  db.exec(`CREATE TRIGGER reject_cursor BEFORE UPDATE OF cursor ON inbox_cursors
    BEGIN SELECT RAISE(ABORT, 'test cursor failure'); END;`);

  assert.throws(() => store.saveBatch(owner, { nextCursor: 'new', messages: [
    { ...input('2'), contextToken: 'rejected-secret' },
  ] }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /test cursor failure/);
    assert.ok(!String(error).includes('rejected-secret'));
    return true;
  });

  assert.equal(store.getLatestContextToken(owner), 'retained-secret');
  assert.equal(store.getCursor(owner), 'old');
  assert.deepEqual(store.listMessages(owner).items.map((message) => message.remoteMessageId), [remoteId]);
});
