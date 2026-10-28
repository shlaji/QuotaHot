import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { WECHAT_DB_PATH } from '../config.js';
import { dirname, join } from 'node:path';
import { INBOX_SCHEMA } from './store-schema.js';

const INBOX_RESET_TABLES = [
  'inbox_chunks', 'inbox_items', 'inbox_attachments', 'inbox_contexts', 'inbox_messages', 'inbox_contacts',
] as const;
const CONVERSATION_RESET_TABLES = ['wechat_messages', 'wechat_conversations'] as const;

function migrationApplied(db: DatabaseSync, table: string): boolean {
  return db.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?`).get(table) !== undefined
    && db.prepare(`SELECT version FROM "${table}" WHERE version = 1`).get() !== undefined;
}

function resetLegacyTables(path: string, targets: readonly string[], marker: string, schema?: string): void {
  if (!existsSync(path)) return;
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (migrationApplied(db, marker)) {
        db.exec('COMMIT');
        return;
      }
      const tables = new Set(db.prepare(`SELECT lower(name) AS name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*'`)
        .all().map((row) => String(row.name)));
      for (const table of tables) {
        if (targets.includes(table)) continue;
        const references = db.prepare('SELECT lower("table") AS "table", on_delete FROM pragma_foreign_key_list(?)').all(table);
        if (references.some((reference) => targets.includes(String(reference.table)) && tables.has(String(reference.table))
          && ['CASCADE', 'SET NULL', 'SET DEFAULT'].includes(String(reference.on_delete)))) {
          throw new RangeError('Cannot reset legacy history referenced by protected tables');
        }
      }
      db.exec(`CREATE TABLE IF NOT EXISTS "${marker}" (version INTEGER PRIMARY KEY NOT NULL) STRICT`);
      for (const table of targets) db.exec(`DROP TABLE IF EXISTS "${table}"`);
      if (schema !== undefined) db.exec(schema);
      db.prepare(`INSERT INTO "${marker}"(version) VALUES (1)`).run();
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}

export function migrateWechatLocalData(options: { readonly inboxPath?: string; readonly conversationsPath?: string } = {}): void {
  migrateWechatInboxData(options.inboxPath);
  resetLegacyTables(options.conversationsPath ?? join(dirname(WECHAT_DB_PATH), 'conversations.db'),
    CONVERSATION_RESET_TABLES, 'wechat_local_migrations');
}

export function migrateWechatInboxData(path = join(dirname(WECHAT_DB_PATH), 'inbox.db')): void {
  resetLegacyTables(path, INBOX_RESET_TABLES, 'wechat_inbox_migrations', INBOX_SCHEMA);
}
