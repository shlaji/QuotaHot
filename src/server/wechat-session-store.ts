import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { WECHAT_DB_PATH } from './config.js';

export interface ConfirmedWechatBinding {
  readonly ownerIlinkUserId: string;
  readonly botId: string;
  readonly botToken: string;
  readonly baseUrl: string;
}

export interface WechatBindingSummary {
  readonly ownerIlinkUserId: string;
  readonly botId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface WechatBinding extends WechatBindingSummary {
  readonly botToken: string;
  readonly baseUrl: string;
}

function text(value: SQLOutputValue): string {
  if (typeof value !== 'string') throw new TypeError('Invalid WeChat database text');
  return value;
}

function bindingSummary(row: Record<string, SQLOutputValue>): WechatBindingSummary {
  return {
    ownerIlinkUserId: text(row.owner_ilink_user_id),
    botId: text(row.ilink_bot_id),
    createdAt: Date.parse(text(row.created_at)),
    updatedAt: Date.parse(text(row.updated_at)),
  };
}

function binding(row: Record<string, SQLOutputValue>): WechatBinding {
  return {
    ...bindingSummary(row),
    botToken: text(row.bot_token),
    baseUrl: text(row.baseurl),
  };
}

export class WechatSessionStore {
  private readonly db: DatabaseSync;
  private readonly bindingRevisions = new Map<string, number>();

  constructor(path: string = WECHAT_DB_PATH) {
    if (path !== ':memory:') {
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
      this.transaction(() => this.db.exec(`
        CREATE TABLE IF NOT EXISTS wechat_binding (
          owner_ilink_user_id TEXT PRIMARY KEY NOT NULL,
          ilink_bot_id TEXT NOT NULL,
          bot_token TEXT NOT NULL,
          baseurl TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          paused INTEGER NOT NULL DEFAULT 0
        ) STRICT;
      `));
      if (!this.db.prepare('PRAGMA table_info(wechat_binding)').all().some((column) => column.name === 'paused')) {
        this.db.exec('ALTER TABLE wechat_binding ADD COLUMN paused INTEGER NOT NULL DEFAULT 0');
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private transaction<Result>(action: () => Result): Result {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  saveBinding(input: ConfirmedWechatBinding, now: number): void {
    this.transaction(() => this.upsertBinding(input, now));
    this.invalidateBinding(input.ownerIlinkUserId);
  }

  confirmBinding(input: ConfirmedWechatBinding, now: number): void {
    this.transaction(() => {
      this.upsertBinding(input, now);
      this.db.prepare('UPDATE wechat_binding SET paused = 0 WHERE owner_ilink_user_id = ?').run(input.ownerIlinkUserId);
    });
    this.invalidateBinding(input.ownerIlinkUserId);
  }

  getBindingRevision(owner: string): number {
    return this.bindingRevisions.get(owner) ?? 0;
  }

  private invalidateBinding(owner: string): void {
    this.bindingRevisions.set(owner, this.getBindingRevision(owner) + 1);
  }

  private upsertBinding(input: ConfirmedWechatBinding, now: number): void {
    const time = new Date(now).toISOString();
    this.db.prepare(`INSERT INTO wechat_binding
      (owner_ilink_user_id, ilink_bot_id, bot_token, baseurl, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_ilink_user_id) DO UPDATE SET
        ilink_bot_id = excluded.ilink_bot_id, bot_token = excluded.bot_token,
        baseurl = excluded.baseurl, updated_at = excluded.updated_at`)
      .run(input.ownerIlinkUserId, input.botId, input.botToken, input.baseUrl, time, time);
  }

  getBinding(ownerIlinkUserId: string): WechatBinding | null {
    const row = this.db.prepare('SELECT * FROM wechat_binding WHERE owner_ilink_user_id = ?')
      .get(ownerIlinkUserId);
    return row ? binding(row) : null;
  }

  listBindings(): WechatBinding[] {
    return this.db.prepare('SELECT * FROM wechat_binding ORDER BY created_at, owner_ilink_user_id')
      .all().map(binding);
  }

  pauseBinding(owner: string): void {
    this.db.prepare('UPDATE wechat_binding SET paused = 1 WHERE owner_ilink_user_id = ?').run(owner);
    this.invalidateBinding(owner);
  }

  isBindingPaused(owner: string): boolean {
    return this.db.prepare('SELECT paused FROM wechat_binding WHERE owner_ilink_user_id = ?').get(owner)?.paused === 1;
  }

  getBindingSummary(ownerIlinkUserId: string): WechatBindingSummary | null {
    const row = this.db.prepare(`SELECT owner_ilink_user_id, ilink_bot_id, created_at, updated_at
      FROM wechat_binding WHERE owner_ilink_user_id = ?`).get(ownerIlinkUserId);
    return row ? bindingSummary(row) : null;
  }

  removeBinding(ownerIlinkUserId: string): boolean {
    const removed = this.db.prepare('DELETE FROM wechat_binding WHERE owner_ilink_user_id = ?')
      .run(ownerIlinkUserId).changes > 0;
    this.invalidateBinding(ownerIlinkUserId);
    return removed;
  }

  close(): void { this.db.close(); }
}
