import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WechatSessionStore } from '../src/server/wechat-session-store.js';

const now = Date.parse('2026-10-19T12:00:00Z');
const binding = { ownerIlinkUserId: 'ilink-user-one', botId: 'bot-one', botToken: 'test-secret-one', baseUrl: 'https://example.invalid' };

function databasePath(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-store-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'wechat', 'wechat.db');
}

for (const existing of [false, true]) {
  test(`makes the dedicated directory private when existing=${existing}`, (t) => {
    const path = databasePath(t);
    if (existing) {
      mkdirSync(dirname(path));
      chmodSync(dirname(path), 0o755);
    }
    const store = new WechatSessionStore(path);
    t.after(() => store.close());
    assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
  });
}

test('creates the feature schema with WAL', (t) => {
  const path = databasePath(t);
  const store = new WechatSessionStore(path);
  t.after(() => store.close());
  const db = new DatabaseSync(path);

  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all();

  assert.deepEqual(tables.map((row) => row.name), ['wechat_binding']);
  assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
  assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'users'").get(), undefined);
  db.close();
});

test('persists the verified identity binding across reopen', (t) => {
  const path = databasePath(t);
  const first = new WechatSessionStore(path);
  first.saveBinding(binding, now);
  first.close();
  const reopened = new WechatSessionStore(path);
  t.after(() => reopened.close());

  assert.deepEqual(reopened.getBinding(binding.ownerIlinkUserId), {
    ...binding, createdAt: now, updatedAt: now,
  });
});

test('isolates current bindings by verified ilink user ID', (t) => {
  const store = new WechatSessionStore(databasePath(t));
  t.after(() => store.close());
  store.saveBinding(binding, now);
  store.saveBinding({ ...binding, ownerIlinkUserId: 'ilink-user-two', botId: 'bot-two', botToken: 'other-secret' }, now);

  assert.equal(store.getBinding(binding.ownerIlinkUserId)?.botId, 'bot-one');
  assert.equal(store.getBinding('ilink-user-two')?.botToken, 'other-secret');
});

test('lists no bindings when none are persisted', (t) => {
  const store = new WechatSessionStore(databasePath(t));
  t.after(() => store.close());

  assert.deepEqual(store.listBindings(), []);
});

test('lists persisted owners by creation time then owner ID with isolated credentials', (t) => {
  const path = databasePath(t);
  const store = new WechatSessionStore(path);
  const second = { ownerIlinkUserId: 'ilink-user-two', botId: 'bot-two', botToken: 'secret-two', baseUrl: 'https://two.invalid' };
  const earlier = { ownerIlinkUserId: 'ilink-user-zero', botId: 'bot-zero', botToken: 'secret-zero', baseUrl: 'https://zero.invalid' };
  store.saveBinding(second, now);
  store.saveBinding(binding, now);
  store.saveBinding(earlier, now - 1);
  store.close();
  const reopened = new WechatSessionStore(path);
  t.after(() => reopened.close());

  const bindings = reopened.listBindings();

  assert.deepEqual(bindings, [
    { ...earlier, createdAt: now - 1, updatedAt: now - 1 },
    { ...binding, createdAt: now, updatedAt: now },
    { ...second, createdAt: now, updatedAt: now },
  ]);
});

test('lists a reconfirmed owner once with refreshed credentials without changing another owner', (t) => {
  const store = new WechatSessionStore(databasePath(t));
  t.after(() => store.close());
  const second = { ownerIlinkUserId: 'ilink-user-two', botId: 'bot-two', botToken: 'secret-two', baseUrl: 'https://two.invalid' };
  const confirmed = { ...binding, botId: 'renewed-bot', botToken: 'renewed-secret', baseUrl: 'https://renewed.invalid' };
  store.saveBinding(binding, now);
  store.saveBinding(second, now + 1);
  store.confirmBinding(confirmed, now + 2);

  const bindings = store.listBindings();

  assert.deepEqual(bindings, [
    { ...confirmed, createdAt: now, updatedAt: now + 2 },
    { ...second, createdAt: now + 1, updatedAt: now + 1 },
  ]);
});

test('allows exactly one current binding per owner and refreshes its credentials on reconfirmation', (t) => {
  const store = new WechatSessionStore(databasePath(t));
  t.after(() => store.close());
  store.saveBinding(binding, now);

  store.saveBinding({ ...binding, botId: 'bot-renewed', botToken: 'refreshed-secret', baseUrl: 'https://updated.invalid' }, now + 2);

  assert.deepEqual(store.getBinding(binding.ownerIlinkUserId), {
    ...binding, botId: 'bot-renewed', botToken: 'refreshed-secret', baseUrl: 'https://updated.invalid',
    createdAt: now, updatedAt: now + 2,
  });
});

test('returns a secret-free binding summary and lets only its owner delete the local binding', (t) => {
  const store = new WechatSessionStore(databasePath(t));
  t.after(() => store.close());
  store.saveBinding(binding, now);

  assert.deepEqual(store.getBindingSummary(binding.ownerIlinkUserId), {
    ownerIlinkUserId: binding.ownerIlinkUserId, botId: binding.botId, createdAt: now, updatedAt: now,
  });
  const summary = store.getBindingSummary(binding.ownerIlinkUserId);
  assert.ok(summary);
  assert.equal('botToken' in summary, false);
  assert.equal(store.removeBinding('ilink-user-two'), false);
  assert.equal(store.getBinding(binding.ownerIlinkUserId)?.botToken, binding.botToken);
  assert.equal(store.removeBinding(binding.ownerIlinkUserId), true);
  assert.equal(store.getBinding(binding.ownerIlinkUserId), null);
});

test('keeps existing legacy session rows inert through binding confirmation and unlink', (t) => {
  const path = databasePath(t);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  db.exec(`CREATE TABLE wechat_sessions (token_hash TEXT PRIMARY KEY, owner_ilink_user_id TEXT,
    created_at TEXT, expires_at TEXT);
    INSERT INTO wechat_sessions VALUES ('legacy-hash', 'legacy-owner', 'old', 'future');
    CREATE TRIGGER session_insert BEFORE INSERT ON wechat_sessions BEGIN SELECT RAISE(ABORT, 'inert'); END;
    CREATE TRIGGER session_read_delete BEFORE DELETE ON wechat_sessions BEGIN SELECT RAISE(ABORT, 'inert'); END;`);
  const rows = db.prepare('SELECT * FROM wechat_sessions').all();
  const store = new WechatSessionStore(path);
  store.confirmBinding(binding, now);
  store.removeBinding(binding.ownerIlinkUserId);
  store.close();
  const reopened = new WechatSessionStore(path);
  t.after(() => reopened.close());

  assert.deepEqual(db.prepare('SELECT * FROM wechat_sessions').all(), rows);
  assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'wechat_sessions_expiry'").get(), undefined);
});

test('confirmation resumes only its paused binding while ordinary refresh preserves pause', (t) => {
  const store = new WechatSessionStore(databasePath(t));
  t.after(() => store.close());
  store.saveBinding(binding, now);
  store.saveBinding({ ...binding, ownerIlinkUserId: 'other' }, now);
  store.pauseBinding(binding.ownerIlinkUserId);
  store.pauseBinding('other');
  store.saveBinding(binding, now + 1);
  assert.equal(store.isBindingPaused(binding.ownerIlinkUserId), true);

  store.confirmBinding({ ...binding, botToken: 'refreshed' }, now + 2);

  assert.equal(store.isBindingPaused(binding.ownerIlinkUserId), false);
  assert.equal(store.isBindingPaused('other'), true);
  assert.equal(store.getBinding(binding.ownerIlinkUserId)?.botToken, 'refreshed');
});

test('advances the binding revision for same-credential confirmation at the same timestamp', (t) => {
  const store = new WechatSessionStore(databasePath(t));
  t.after(() => store.close());
  store.confirmBinding(binding, now);
  const revision = store.getBindingRevision(binding.ownerIlinkUserId);

  store.confirmBinding(binding, now);

  assert.equal(store.getBindingRevision(binding.ownerIlinkUserId), revision + 1);
  assert.equal(store.getBindingRevision('other-owner'), 0);
});

for (const existingBinding of [false, true]) {
  test(`rolls back confirmation credentials and pause when resume fails, existing=${existingBinding}`, (t) => {
    const path = databasePath(t);
    const store = new WechatSessionStore(path);
    t.after(() => store.close());
    if (existingBinding) { store.saveBinding(binding, now); store.pauseBinding(binding.ownerIlinkUserId); }
    const previous = store.getBinding(binding.ownerIlinkUserId);
    const revision = store.getBindingRevision(binding.ownerIlinkUserId);
    const db = new DatabaseSync(path);
    t.after(() => db.close());
    db.exec(`CREATE TRIGGER fail_resume BEFORE UPDATE OF paused ON wechat_binding
      BEGIN SELECT RAISE(ABORT, 'resume failed'); END;`);

    assert.throws(() => store.confirmBinding({ ...binding, botToken: 'replacement' }, now + 1), /resume failed/);

    assert.deepEqual(store.getBinding(binding.ownerIlinkUserId), previous);
    assert.equal(store.isBindingPaused(binding.ownerIlinkUserId), existingBinding);
    assert.equal(store.getBindingRevision(binding.ownerIlinkUserId), revision);
  });
}
