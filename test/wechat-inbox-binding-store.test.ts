import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-binding-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { inboxPath: join(directory, 'inbox.db'), conversationsPath: join(directory, 'conversations.db'), wechatPath: join(directory, 'wechat.db') };
}

function seedInbox(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE inbox_bindings (owner TEXT PRIMARY KEY NOT NULL, bot_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, unlinked_at TEXT) STRICT;
      CREATE TABLE inbox_cursors (owner TEXT PRIMARY KEY NOT NULL REFERENCES inbox_bindings(owner), cursor TEXT NOT NULL) STRICT;
      CREATE TABLE inbox_contacts (
        id TEXT PRIMARY KEY NOT NULL, owner TEXT NOT NULL REFERENCES inbox_bindings(owner),
        kind TEXT NOT NULL CHECK(kind IN ('contact','system_error')), contact TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_message_at TEXT NOT NULL,
        CHECK((kind='contact' AND contact IS NOT NULL) OR (kind='system_error' AND contact IS NULL)),
        UNIQUE(owner, contact), UNIQUE(owner, id)
      ) STRICT;
      CREATE UNIQUE INDEX inbox_system_error_contact ON inbox_contacts(owner) WHERE kind='system_error';
      CREATE TABLE inbox_messages (
        id TEXT PRIMARY KEY NOT NULL, owner TEXT NOT NULL, conversation_id TEXT NOT NULL, remote_message_id TEXT,
        client_id TEXT, direction TEXT NOT NULL, message_type INTEGER NOT NULL, kind TEXT NOT NULL,
        state TEXT NOT NULL, sequence INTEGER NOT NULL, created_at TEXT NOT NULL, run_id TEXT, fingerprint TEXT,
        UNIQUE(conversation_id, sequence), FOREIGN KEY(owner, conversation_id) REFERENCES inbox_contacts(owner,id)
      ) STRICT;
      CREATE TABLE inbox_contexts (owner TEXT NOT NULL, contact TEXT NOT NULL, context_token TEXT, PRIMARY KEY(owner,contact), FOREIGN KEY(owner,contact) REFERENCES inbox_contacts(owner,contact)) STRICT;
      CREATE TABLE inbox_attachments (id TEXT PRIMARY KEY NOT NULL, message_id TEXT NOT NULL REFERENCES inbox_messages(id), direction TEXT NOT NULL, kind TEXT NOT NULL, file_name TEXT NOT NULL, media_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, chunk_count INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(message_id,id)) STRICT;
      CREATE TABLE inbox_items (message_id TEXT NOT NULL REFERENCES inbox_messages(id), item_index INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT, attachment_id TEXT, width INTEGER, height INTEGER, duration_ms INTEGER, codec TEXT, safe_summary TEXT, PRIMARY KEY(message_id,item_index), FOREIGN KEY(message_id,attachment_id) REFERENCES inbox_attachments(message_id,id)) STRICT;
      CREATE TABLE inbox_chunks (attachment_id TEXT NOT NULL REFERENCES inbox_attachments(id), chunk_index INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(attachment_id,chunk_index)) STRICT;
      INSERT INTO inbox_bindings VALUES ('owner-a','bot-a','2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z',NULL);
      INSERT INTO inbox_bindings VALUES ('owner-b','bot-b','2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z',NULL);
      INSERT INTO inbox_cursors VALUES ('owner-a','cursor-a');
      INSERT INTO inbox_cursors VALUES ('owner-b','cursor-b');
      INSERT INTO inbox_contacts VALUES ('contact-a','owner-a','contact','wx-a','2000','2000','2000');
      INSERT INTO inbox_messages VALUES ('message-a','owner-a','contact-a','1',NULL,'inbound',1,'text','received',1,'2000',NULL,NULL);
      INSERT INTO inbox_contexts VALUES ('owner-a','wx-a','legacy-context');
      INSERT INTO inbox_attachments VALUES ('attachment-a','message-a','inbound','image','legacy.png','image/png',1,'sha',1,'2000');
      INSERT INTO inbox_items VALUES ('message-a',0,'image',NULL,'attachment-a',NULL,NULL,NULL,NULL,NULL);
      INSERT INTO inbox_chunks VALUES ('attachment-a',0,X'41');
    `);
  } finally {
    db.close();
  }
}

function seedConversationDatabase(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE wechat_conversations (id TEXT PRIMARY KEY NOT NULL, owner_ilink_user_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(owner_ilink_user_id,id)) STRICT;
      CREATE TABLE wechat_messages (id TEXT PRIMARY KEY NOT NULL, owner_ilink_user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, sequence INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(owner_ilink_user_id,conversation_id) REFERENCES wechat_conversations(owner_ilink_user_id,id) ON DELETE CASCADE) STRICT;
      INSERT INTO wechat_conversations VALUES ('local-a','owner-a','legacy','2000','2000');
      INSERT INTO wechat_messages VALUES ('local-msg-a','owner-a','local-a',1,'user','legacy text','2000');
    `);
  } finally {
    db.close();
  }
}

test('one-time migration clears only legacy conversations and contact inbox while retaining QR bindings and cursors', async (t) => {
  const { inboxPath, conversationsPath, wechatPath } = fixture(t);
  seedInbox(inboxPath);
  seedConversationDatabase(conversationsPath);
  const auth = new DatabaseSync(wechatPath);
  auth.exec(`CREATE TABLE wechat_binding (owner_ilink_user_id TEXT PRIMARY KEY NOT NULL, bot_token TEXT NOT NULL);
    CREATE TABLE wechat_sessions (token_hash TEXT PRIMARY KEY NOT NULL, owner_ilink_user_id TEXT NOT NULL);
    INSERT INTO wechat_binding VALUES ('owner-a','credential-stays-private');
    INSERT INTO wechat_sessions VALUES ('hash-a','owner-a');`);
  auth.close();

  const { migrateWechatLocalData } = await import('../src/server/wechat-inbox/migrate.js');
  migrateWechatLocalData({ inboxPath, conversationsPath });

  const inbox = new DatabaseSync(inboxPath);
  const conversations = new DatabaseSync(conversationsPath);
  t.after(() => { inbox.close(); conversations.close(); });
  assert.deepEqual(inbox.prepare('SELECT owner, bot_id FROM inbox_bindings ORDER BY owner').all().map((row) => ({ ...row })), [
    { owner: 'owner-a', bot_id: 'bot-a' }, { owner: 'owner-b', bot_id: 'bot-b' },
  ]);
  assert.deepEqual(inbox.prepare('SELECT owner, cursor FROM inbox_cursors ORDER BY owner').all().map((row) => ({ ...row })), [
    { owner: 'owner-a', cursor: 'cursor-a' }, { owner: 'owner-b', cursor: 'cursor-b' },
  ]);
  for (const table of ['inbox_contacts', 'inbox_messages', 'inbox_contexts', 'inbox_attachments', 'inbox_items', 'inbox_chunks']) {
    assert.equal(inbox.prepare('SELECT name FROM sqlite_schema WHERE type = \'table\' AND name = ?').get(table), undefined);
  }
  assert.equal(conversations.prepare('SELECT name FROM sqlite_schema WHERE type = \'table\' AND name = \'wechat_conversations\'').get(), undefined);
  assert.equal(conversations.prepare('SELECT name FROM sqlite_schema WHERE type = \'table\' AND name = \'wechat_messages\'').get(), undefined);
  assert.ok(inbox.prepare('SELECT name FROM sqlite_schema WHERE type = \'table\' AND name = \'wechat_inbox_migrations\'').get());
  assert.ok(conversations.prepare('SELECT name FROM sqlite_schema WHERE type = \'table\' AND name = \'wechat_local_migrations\'').get());
  const reopenedAuth = new DatabaseSync(wechatPath);
  t.after(() => reopenedAuth.close());
  assert.deepEqual(reopenedAuth.prepare('SELECT owner_ilink_user_id, bot_token FROM wechat_binding').all().map((row) => ({ ...row })),
    [{ owner_ilink_user_id: 'owner-a', bot_token: 'credential-stays-private' }]);
  assert.deepEqual(reopenedAuth.prepare('SELECT token_hash, owner_ilink_user_id FROM wechat_sessions').all().map((row) => ({ ...row })),
    [{ token_hash: 'hash-a', owner_ilink_user_id: 'owner-a' }]);
});

for (const target of ['inbox_contacts', 'inbox_messages', 'inbox_contexts', 'inbox_attachments',
  'inbox_items', 'inbox_chunks', 'wechat_conversations', 'wechat_messages']) {
  test(`migration drops partial legacy ${target} with unrecognized columns and preserves unrelated rows`, async (t) => {
    const paths = fixture(t);
    const path = target.startsWith('inbox_') ? paths.inboxPath : paths.conversationsPath;
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE "${target}" (unknown_column BLOB); INSERT INTO "${target}" VALUES (X'41');
      CREATE TABLE inbox_unrelated (value TEXT); INSERT INTO inbox_unrelated VALUES ('keep');`);
    db.close();
    const { migrateWechatLocalData } = await import('../src/server/wechat-inbox/migrate.js');

    migrateWechatLocalData(paths);

    const reopened = new DatabaseSync(path);
    t.after(() => reopened.close());
    assert.equal(reopened.prepare('SELECT name FROM sqlite_schema WHERE name = ?').get(target), undefined);
    assert.deepEqual(reopened.prepare('SELECT value FROM inbox_unrelated').all().map((row) => ({ ...row })), [{ value: 'keep' }]);
    const marker = target.startsWith('inbox_') ? 'wechat_inbox_migrations' : 'wechat_local_migrations';
    assert.equal(reopened.prepare(`SELECT version FROM ${marker}`).get()?.version, 1);
  });
}

test('first migration preserves every current binding table and its data alongside legacy history', async (t) => {
  const paths = fixture(t);
  seedInbox(paths.inboxPath);
  const { INBOX_SCHEMA } = await import('../src/server/wechat-inbox/store-schema.js');
  const db = new DatabaseSync(paths.inboxPath);
  db.exec(INBOX_SCHEMA);
  db.exec(`INSERT INTO inbox_binding_contexts VALUES ('owner-a','current-context');
    INSERT INTO inbox_binding_messages VALUES ('current-message','owner-a','remote',NULL,'inbound',1,'image','received',1,'2000',NULL,NULL);
    INSERT INTO inbox_binding_attachments VALUES ('current-attachment','owner-a','current-message','inbound','image','current.png','image/png',1,'sha',1,'2000');
    INSERT INTO inbox_binding_items VALUES ('current-message',0,'image',NULL,'current-attachment',NULL,NULL,NULL,NULL,NULL);
    INSERT INTO inbox_binding_chunks VALUES ('owner-a','current-attachment',0,X'42');
    CREATE TABLE inbox_binding_extension (value TEXT); INSERT INTO inbox_binding_extension VALUES ('extension');`);
  const tables = ['inbox_bindings', 'inbox_cursors', 'inbox_binding_contexts', 'inbox_binding_messages',
    'inbox_binding_attachments', 'inbox_binding_items', 'inbox_binding_chunks', 'inbox_binding_extension'];
  const expected = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
  db.close();
  const { migrateWechatLocalData } = await import('../src/server/wechat-inbox/migrate.js');

  migrateWechatLocalData(paths);

  const reopened = new DatabaseSync(paths.inboxPath);
  t.after(() => reopened.close());
  assert.deepEqual(tables.map((table) => reopened.prepare(`SELECT * FROM ${table}`).all()), expected);
});

for (const database of ['inbox', 'conversations']) {
  for (const action of ['NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT']) {
    test(`${database} migration rolls back without a completion marker when protected rows reference a target with ${action}`, async (t) => {
      const paths = fixture(t);
      const path = database === 'inbox' ? paths.inboxPath : paths.conversationsPath;
      const parent = database === 'inbox' ? 'inbox_contacts' : 'wechat_conversations';
      const child = database === 'inbox' ? 'inbox_chunks' : 'wechat_messages';
      const marker = database === 'inbox' ? 'wechat_inbox_migrations' : 'wechat_local_migrations';
      const db = new DatabaseSync(path);
      db.exec(`PRAGMA foreign_keys = ON;
        CREATE TABLE ${parent} (id TEXT PRIMARY KEY); INSERT INTO ${parent} VALUES ('legacy');
        CREATE TABLE ${child} (value TEXT); INSERT INTO ${child} VALUES ('rollback');
        CREATE TABLE protected_rows (target TEXT REFERENCES ${parent}(id) ON DELETE ${action});
        INSERT INTO protected_rows VALUES ('legacy');
        CREATE TABLE ${marker} (version INTEGER PRIMARY KEY); INSERT INTO ${marker} VALUES (0);`);
      db.close();
      const { migrateWechatLocalData } = await import('../src/server/wechat-inbox/migrate.js');

      assert.throws(() => migrateWechatLocalData(paths), /FOREIGN KEY|protected/i);

      const reopened = new DatabaseSync(path);
      t.after(() => reopened.close());
      assert.deepEqual(reopened.prepare(`SELECT id FROM ${parent}`).all().map((row) => ({ ...row })), [{ id: 'legacy' }]);
      assert.deepEqual(reopened.prepare(`SELECT value FROM ${child}`).all().map((row) => ({ ...row })), [{ value: 'rollback' }]);
      assert.deepEqual(reopened.prepare('SELECT target FROM protected_rows').all().map((row) => ({ ...row })), [{ target: 'legacy' }]);
      assert.deepEqual(reopened.prepare(`SELECT version FROM ${marker}`).all().map((row) => ({ ...row })), [{ version: 0 }]);
    });
  }
}

for (const database of ['inbox', 'conversations']) {
  for (const scenario of ['mixed-case reference', 'sqliteXarchive table']) {
    test(`${database} migration rejects before mutation when a CASCADE uses a ${scenario}`, async (t) => {
      const paths = fixture(t);
      const path = database === 'inbox' ? paths.inboxPath : paths.conversationsPath;
      const parent = database === 'inbox' ? 'inbox_contacts' : 'wechat_conversations';
      const child = database === 'inbox' ? 'inbox_chunks' : 'wechat_messages';
      const marker = database === 'inbox' ? 'wechat_inbox_migrations' : 'wechat_local_migrations';
      const protectedTable = scenario === 'sqliteXarchive table' ? 'sqliteXarchive' : 'protected_rows';
      const reference = scenario === 'mixed-case reference' ? parent.toUpperCase() : parent;
      const db = new DatabaseSync(path);
      t.after(() => db.close());
      db.exec(`PRAGMA foreign_keys = ON;
        CREATE TABLE ${parent} (id TEXT PRIMARY KEY); INSERT INTO ${parent} VALUES ('legacy');
        CREATE TABLE ${child} (value TEXT); INSERT INTO ${child} VALUES ('rollback');
        CREATE TABLE ${protectedTable} (target TEXT REFERENCES ${reference}(id) ON DELETE CASCADE);
        INSERT INTO ${protectedTable} VALUES ('legacy');
        CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('keep');
        CREATE TABLE ${marker} (version INTEGER PRIMARY KEY); INSERT INTO ${marker} VALUES (0);`);
      const tables = [parent, child, protectedTable, 'unrelated', marker];
      const expectedRows = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
      const expectedSchema = db.prepare('SELECT * FROM sqlite_schema ORDER BY type, name').all();
      const { migrateWechatLocalData } = await import('../src/server/wechat-inbox/migrate.js');

      assert.throws(() => migrateWechatLocalData(paths), /protected/i);

      assert.deepEqual(db.prepare('SELECT * FROM sqlite_schema ORDER BY type, name').all(), expectedSchema);
      assert.deepEqual(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()), expectedRows);
      assert.equal(db.prepare(`SELECT version FROM ${marker}`).get()?.version, 0);
    });
  }
}

test('store initialization creates missing current tables after a partial legacy reset', async (t) => {
  const { inboxPath } = fixture(t);
  const db = new DatabaseSync(inboxPath);
  db.exec('CREATE TABLE inbox_contexts (legacy TEXT); INSERT INTO inbox_contexts VALUES (\'discard\');');
  db.close();
  const { WechatInboxStore } = await import('../src/server/wechat-inbox/store.js');

  const store = new WechatInboxStore(inboxPath);
  t.after(() => store.close());

  store.saveBinding({ ownerIlinkUserId: 'new-owner', botId: 'new-bot' }, '2000');
  assert.equal(store.getBinding('new-owner')?.botId, 'new-bot');
  const reopened = new DatabaseSync(inboxPath);
  t.after(() => reopened.close());
  for (const table of ['inbox_binding_contexts', 'inbox_binding_messages', 'inbox_binding_items', 'inbox_binding_attachments', 'inbox_binding_chunks']) {
    assert.deepEqual(reopened.prepare(`SELECT * FROM ${table}`).all(), []);
  }
});

test('creates missing inbox tables before marking the reset complete', async (t) => {
  const { inboxPath, conversationsPath } = fixture(t);
  const db = new DatabaseSync(inboxPath);
  db.exec(`CREATE TABLE inbox_contexts (legacy TEXT);
    CREATE TABLE wechat_inbox_migrations (version INTEGER PRIMARY KEY NOT NULL) STRICT;
    CREATE TRIGGER require_current_inbox_schema BEFORE INSERT ON wechat_inbox_migrations
      WHEN NOT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'inbox_binding_contexts')
      BEGIN SELECT RAISE(ABORT, 'current inbox schema missing'); END;`);
  db.close();
  const { migrateWechatLocalData } = await import('../src/server/wechat-inbox/migrate.js');

  assert.doesNotThrow(() => migrateWechatLocalData({ inboxPath, conversationsPath }));

  const reopened = new DatabaseSync(inboxPath);
  t.after(() => reopened.close());
  assert.equal(reopened.prepare('SELECT version FROM wechat_inbox_migrations').get()?.version, 1);
  for (const table of ['inbox_bindings', 'inbox_cursors', 'inbox_binding_contexts', 'inbox_binding_messages',
    'inbox_binding_items', 'inbox_binding_attachments', 'inbox_binding_chunks']) {
    assert.equal(reopened.prepare('SELECT name FROM sqlite_schema WHERE type = \'table\' AND name = ?').get(table)?.name, table);
  }
});

test('existing version 1 markers skip reset even when legacy tables and unknown tables remain', async (t) => {
  const paths = fixture(t);
  seedInbox(paths.inboxPath);
  seedConversationDatabase(paths.conversationsPath);
  for (const [path, marker] of [[paths.inboxPath, 'wechat_inbox_migrations'], [paths.conversationsPath, 'wechat_local_migrations']]) {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE ${marker} (version INTEGER PRIMARY KEY); INSERT INTO ${marker} VALUES (1);
      CREATE TABLE unknown_table (value TEXT); INSERT INTO unknown_table VALUES ('keep');`);
    db.close();
  }
  const { migrateWechatLocalData } = await import('../src/server/wechat-inbox/migrate.js');

  migrateWechatLocalData(paths);

  for (const [path, table] of [[paths.inboxPath, 'inbox_messages'], [paths.conversationsPath, 'wechat_messages']]) {
    const db = new DatabaseSync(path);
    t.after(() => db.close());
    assert.equal(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count, 1);
    assert.equal(db.prepare('SELECT value FROM unknown_table').get()?.value, 'keep');
  }
});

test('repeating the completed migration preserves newly inserted binding history', async (t) => {
  const { inboxPath, conversationsPath } = fixture(t);
  seedInbox(inboxPath);
  seedConversationDatabase(conversationsPath);
  const { migrateWechatLocalData } = await import('../src/server/wechat-inbox/migrate.js');
  migrateWechatLocalData({ inboxPath, conversationsPath });
  const db = new DatabaseSync(inboxPath);
  db.exec(`INSERT INTO inbox_binding_messages (id, owner, remote_message_id, direction, message_type, kind, state, sequence, created_at)
    VALUES ('new-a','owner-a','remote-new','inbound',1,'text','received',1,'2000');`);
  db.close();

  migrateWechatLocalData({ inboxPath, conversationsPath });

  const reopened = new DatabaseSync(inboxPath);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.prepare('SELECT id, owner, remote_message_id FROM inbox_binding_messages').all().map((row) => ({ ...row })), [
    { id: 'new-a', owner: 'owner-a', remote_message_id: 'remote-new' },
  ]);
});
