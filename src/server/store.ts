/**
 * 使用 Node 内置的 node:sqlite 做状态持久化（无额外原生依赖）。
 *
 * 它存在的核心原因只有一个：当进程被杀或机器重启后，任务能够沿用原本窗口节奏继续，
 * 而不是重新打开新的 5 小时窗口。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LogEntry, RequestLogRow, RequestRecord, Window } from '../shared/types.js';

/**
 * 库里所有时刻一律存 ISO-8601 UTC 文本（见 toDateText），不存毫秒数：直接查库时能读，
 * 也能用 `datetime(next_due_at, 'localtime')` 这类写法过滤。NULL 表示“还没有这件事”。
 *
 * 时刻列一律可空：写入端遇到 0 或读不出的值就写 NULL（见 toDateText），加了 NOT NULL
 * 反而要在库里塞一个 1970-01-01 之类的假时刻来顶位。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS account_state (
  account_id TEXT PRIMARY KEY,
  next_due_at TEXT,
  last_sent_at TEXT,
  last_reset_at TEXT,
  last_source TEXT NOT NULL DEFAULT '',
  used_percent REAL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS request_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  sent_at TEXT,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  headers_json TEXT NOT NULL DEFAULT '{}',
  body TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 0,
  duration_ms REAL NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_request_log_acct ON request_log(account_id, id DESC);
CREATE TABLE IF NOT EXISTS app_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT,
  level TEXT NOT NULL,
  account_id TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_log_ts ON app_log(ts DESC);
`;

/**
 * 首次发布后新增的列。
 * 这里通过 ALTER TABLE 追加，而不是直接并入上面的 SCHEMA，
 * 因为 CREATE TABLE IF NOT EXISTS 对已存在表不会补列，只会悄悄跳过。
 */
const ADDED_COLUMNS: Record<string, [string, string][]> = {
  account_state: [
    ['plan', "TEXT NOT NULL DEFAULT ''"],
    ['subscription_ends_at', 'TEXT'],
    ['usage_checked_at', 'TEXT'],
    // 这个是张数，不是时刻
    ['reset_credits', 'REAL'],
    ['reset_credits_expires_at', 'TEXT'],
    // 完整窗口列表以 JSON 形式保存；每账户一行比拆侧表更简单
    ['windows_json', "TEXT NOT NULL DEFAULT ''"],
  ],
  request_log: [
    // 响应体后补：只有状态码时，看不出上游到底在抱怨什么
    ['response', "TEXT NOT NULL DEFAULT ''"],
  ],
};

/** 每个账户在 request_log 里保留的条数。 */
const REQUEST_LOG_KEEP = 200;

/** 一次真实发送的结果，只用来推进 account_state。 */
export interface SendRecord {
  accountId: string;
  sentAt: number;
  ok: boolean;
  resetAt: number | null;
  source: string;
  usedPercent: number | null;
  error: string;
}

export interface AccountState {
  accountId: string;
  nextDueAt: number;
  lastSentAt: number;
  lastResetAt: number;
  lastSource: string;
  usedPercent: number | null;
  consecutiveFailures: number;
  lastError: string;
  plan: string;
  subscriptionEndsAt: number;
  usageCheckedAt: number;
  resetCredits: number | null;
  resetCreditsExpiresAt: number | null;
  windows: Window[];
}

/** 一次额度查询从单个账户读到的信息；所有字段都允许缺失。 */
export interface UsageSnapshot {
  windows: Window[];
  plan: string;
  subscriptionEndsAt: number | null;
  resetCredits?: number | null;
  resetCreditsExpiresAt?: number | null;
  checkedAt: number;
}

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** 给已存在的旧数据库补上后续版本新增的列。 */
  private migrate(): void {
    for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
      const existing = new Set(
        (this.db.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[]).map(
          (r) => String(r.name),
        ),
      );
      for (const [name, decl] of columns) {
        if (!existing.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
      }
    }
  }

  getState(accountId: string): AccountState | null {
    const row = this.db
      .prepare('SELECT * FROM account_state WHERE account_id = ?')
      .get(accountId) as Record<string, unknown> | undefined;
    return row ? mapState(row) : null;
  }

  allStates(): Map<string, AccountState> {
    const rows = this.db.prepare('SELECT * FROM account_state').all() as Record<string, unknown>[];
    return new Map(rows.map((r) => [String(r.account_id), mapState(r)]));
  }

  setNextDue(accountId: string, ts: number): void {
    this.db
      .prepare(
        `INSERT INTO account_state (account_id, next_due_at) VALUES (?, ?)
         ON CONFLICT(account_id) DO UPDATE SET next_due_at = excluded.next_due_at`,
      )
      .run(accountId, toDateText(ts));
  }

  /**
   * 把连续失败计数清零。
   *
   * 「额度还没重置」不是失败：上游拒绝这一发完全正常，记进计数器只会让一个健康的账户
   * 在几轮之后被判成“连续失败过多”而停掉。
   */
  clearFailures(accountId: string): void {
    this.db
      .prepare("UPDATE account_state SET consecutive_failures = 0, last_error = '' WHERE account_id = ?")
      .run(accountId);
  }

  /**
   * 把一次真实发送的结果并进 account_state。
   *
   * 只留当前状态，不留流水：这一发的完整请求在 request_log 里，那句人话在 app_log 里，
   * 界面上也没有第三个地方去读一张发送流水表。
   */
  recordSend(row: SendRecord): void {
    this.db
      .prepare(
        `INSERT INTO account_state
           (account_id, last_sent_at, last_reset_at, last_source, used_percent,
            consecutive_failures, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           last_sent_at = excluded.last_sent_at,
            -- 如果这一轮没拿到新的重置时间，就保留旧值，不要清成 0
           last_reset_at = CASE WHEN excluded.last_reset_at IS NOT NULL
                                THEN excluded.last_reset_at
                                ELSE account_state.last_reset_at END,
           last_source = excluded.last_source,
           used_percent = excluded.used_percent,
           consecutive_failures = CASE WHEN ? = 1 THEN 0
                                  ELSE account_state.consecutive_failures + 1 END,
           last_error = excluded.last_error`,
      )
      .run(
        row.accountId,
        toDateText(row.sentAt),
        toDateText(row.resetAt),
        row.source,
        row.usedPercent,
        row.ok ? 0 : 1,
        row.error.slice(0, 500),
        row.ok ? 1 : 0,
      );
  }

  /**
   * 合并一次只读额度查询结果。它比 recordSend 更收敛：
   * 因为这里没有真实发送，所以 lastSentAt 和失败计数器都保持不动。
   *
   * 被跟踪的那个窗口（通常是 5 小时窗口）会写入与真实发送相同的列，
   * 这样调度器从额度查询恢复时也能延续节奏；其余窗口仅以 JSON 附带保存，供界面展示。
   */
  recordUsage(accountId: string, snap: UsageSnapshot, tracked: Window | null): void {
    this.db
      .prepare(
        `INSERT INTO account_state
           (account_id, plan, subscription_ends_at, usage_checked_at, reset_credits,
            reset_credits_expires_at, windows_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
            -- 如果这次查询没给值，就保留旧值
           plan = CASE WHEN excluded.plan <> '' THEN excluded.plan ELSE account_state.plan END,
           subscription_ends_at = CASE WHEN excluded.subscription_ends_at IS NOT NULL
                                       THEN excluded.subscription_ends_at
                                       ELSE account_state.subscription_ends_at END,
           usage_checked_at = excluded.usage_checked_at,
            reset_credits = CASE WHEN ? THEN excluded.reset_credits ELSE account_state.reset_credits END,
            reset_credits_expires_at = CASE WHEN ? THEN excluded.reset_credits_expires_at ELSE account_state.reset_credits_expires_at END,
           windows_json = excluded.windows_json`,
      )
      .run(
        accountId,
        snap.plan,
        toDateText(snap.subscriptionEndsAt),
        toDateText(snap.checkedAt),
        snap.resetCredits ?? null,
        toDateText(snap.resetCreditsExpiresAt),
        JSON.stringify(snap.windows),
        snap.resetCredits === undefined ? 0 : 1,
        snap.resetCreditsExpiresAt === undefined ? 0 : 1,
      );

    if (!tracked) return;
    this.db
      .prepare(
        `UPDATE account_state
            SET last_reset_at = ?, used_percent = ?, last_source = ?
          WHERE account_id = ?`,
      )
      .run(toDateText(tracked.resetAt), tracked.usedPercent, tracked.source, accountId);
  }

  /**
   * 记下一次真实发出的请求。
   *
   * 每账户只保留最近 REQUEST_LOG_KEEP 条：这张表是给人翻的，不是审计账本，
   * 而请求头加起来有一两 KB，无限增长没有意义。
   */
  recordRequest(
    accountId: string,
    sentAt: number,
    req: RequestRecord,
    status: number,
    durationMs: number,
    error: string,
  ): number {
    const inserted = this.db
      .prepare(
        `INSERT INTO request_log
           (account_id, sent_at, method, url, headers_json, body, status, duration_ms, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        accountId,
        toDateText(sentAt),
        req.method,
        req.url,
        JSON.stringify(req.headers),
        req.body,
        status,
        durationMs,
        error.slice(0, 500),
      );

    this.db
      .prepare(
        `DELETE FROM request_log
          WHERE account_id = ?
            AND id NOT IN (SELECT id FROM request_log WHERE account_id = ? ORDER BY id DESC LIMIT ?)`,
      )
      .run(accountId, accountId, REQUEST_LOG_KEEP);

    return Number(inserted.lastInsertRowid);
  }

  /**
   * 补写某条请求的错误详情。
   *
   * 落行发生在拿到响应头的那一刻，而“错在哪”要等调用方读完响应体才知道；
   * 分成两步，日志里才既有准确的耗时，又有可读的失败原因。
   */
  updateRequestError(rowId: number, error: string): void {
    this.db
      .prepare('UPDATE request_log SET error = ? WHERE id = ?')
      .run(error.slice(0, 500), rowId);
  }

  /**
   * 补写上游返回的正文。
   *
   * 单独一步是因为落行时正文还没读完——它由出站层边流边攒，
   * 流结束（或被提前掐断）时才有内容。
   */
  updateRequestResponse(rowId: number, response: string): void {
    this.db.prepare('UPDATE request_log SET response = ? WHERE id = ?').run(response, rowId);
  }

  accountRequests(accountId: string, limit = 50): RequestLogRow[] {
    const rows = this.db
      .prepare('SELECT * FROM request_log WHERE account_id = ? ORDER BY id DESC LIMIT ?')
      .all(accountId, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      accountId: String(r.account_id),
      sentAt: toMs(r.sent_at),
      method: String(r.method),
      url: String(r.url),
      headers: parseHeaders(r.headers_json),
      body: String(r.body),
      status: Number(r.status),
      durationMs: Number(r.duration_ms),
      error: String(r.error),
      response: String(r.response ?? ''),
    }));
  }

  appendLog(entry: Omit<LogEntry, 'id'>): LogEntry {
    const info = this.db
      .prepare('INSERT INTO app_log (ts, level, account_id, message) VALUES (?, ?, ?, ?)')
      .run(toDateText(entry.ts), entry.level, entry.accountId, entry.message);
    return { ...entry, id: Number(info.lastInsertRowid) };
  }

  recentLogs(limit = 200): LogEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM app_log ORDER BY id DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[];
    return rows
      .map((r) => ({
        id: Number(r.id),
        ts: toMs(r.ts),
        level: String(r.level) as LogEntry['level'],
        accountId: String(r.account_id),
        message: String(r.message),
      }))
      .reverse();
  }

  close(): void {
    this.db.close();
  }
}

/**
 * 毫秒时间戳 → 库里存的日期文本。
 *
 * 统一存 UTC（`2026-09-12T08:30:00.000Z`）：字典序就是时序，`ORDER BY` 和 `<` 照常用，
 * 换台机器换个时区也不会读出别的意思。0 和空值一律存 NULL，表示“还没有这件事”——
 * 上层判断的是 `nextDueAt > 0`，读回来的 0 与写进去的 NULL 正好对上。
 */
function toDateText(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

/** 库里的日期文本 → 毫秒时间戳。认不出来就当没有，绝不返回 NaN 让它往上游荡。 */
function toMs(raw: unknown): number {
  if (raw === null || raw === undefined || raw === '') return 0;
  // 1.0.1 及更早的库里这一列是毫秒数，手工接着用时还认得出来
  if (typeof raw === 'number') return raw;
  const ms = Date.parse(String(raw));
  return Number.isNaN(ms) ? 0 : ms;
}

/** 同 toMs，但把“没有”留成 null：有些字段要区分“没查到”和“查到了，是 0”。 */
function toMsOrNull(raw: unknown): number | null {
  const ms = toMs(raw);
  return ms === 0 ? null : ms;
}

function parseHeaders(raw: unknown): Record<string, string> {
  if (typeof raw !== 'string' || raw === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
    );
  } catch {
    return {};
  }
}

function parseWindows(raw: unknown): Window[] {
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Window[]) : [];
  } catch {
    return [];
  }
}

function mapState(r: Record<string, unknown>): AccountState {
  return {
    accountId: String(r.account_id),
    nextDueAt: toMs(r.next_due_at),
    lastSentAt: toMs(r.last_sent_at),
    lastResetAt: toMs(r.last_reset_at),
    lastSource: String(r.last_source),
    usedPercent: r.used_percent === null ? null : Number(r.used_percent),
    consecutiveFailures: Number(r.consecutive_failures),
    lastError: String(r.last_error ?? ''),
    plan: String(r.plan ?? ''),
    subscriptionEndsAt: toMs(r.subscription_ends_at),
    usageCheckedAt: toMs(r.usage_checked_at),
    resetCredits: r.reset_credits === null || r.reset_credits === undefined
      ? null
      : Number(r.reset_credits),
    resetCreditsExpiresAt: toMsOrNull(r.reset_credits_expires_at),
    windows: parseWindows(r.windows_json),
  };
}
