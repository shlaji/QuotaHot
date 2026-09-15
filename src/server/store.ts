/**
 * 使用 Node 内置的 node:sqlite 做状态持久化（无额外原生依赖）。
 *
 * 它存在的核心原因只有一个：当进程被杀或机器重启后，任务能够沿用原本窗口节奏继续，
 * 而不是重新打开新的 5 小时窗口。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { LogEntry, RequestLogRow, RequestRecord, Window } from '../shared/types.js';
import type { GatewayAccountSetting, GatewayAccountStat } from '../shared/gateway.js';

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
  -- next_due_at 是照哪个重置时刻排出来的；重启续跑时要拿它接回排期依据，
  -- 不能借用 last_reset_at——那一列会被后台额度刷新覆盖成「当前跟踪窗口」
  planned_reset_at TEXT,
  last_sent_at TEXT,
  last_reset_at TEXT,
  last_source TEXT NOT NULL DEFAULT '',
  used_percent REAL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL DEFAULT '',
  subscription_ends_at TEXT,
  usage_checked_at TEXT,
  -- 这个是张数，不是时刻
  reset_credits REAL,
  reset_credits_expires_at TEXT,
  -- 完整窗口列表以 JSON 形式保存；每账户一行比拆侧表更简单
  windows_json TEXT NOT NULL DEFAULT ''
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
  error TEXT NOT NULL DEFAULT '',
  -- 只有状态码时，看不出上游到底在抱怨什么
  response TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_request_log_acct ON request_log(account_id, id DESC);
-- API 服务（转发路由）里每个账户的设置与累计战绩。
-- 不写进账户文件：重新导入同一个账户会按固定字段集重写那个文件，写在那里的开关会被悄悄抹掉。
CREATE TABLE IF NOT EXISTS gateway_account (
  account_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  -- Qoder 转发用的 PAT 与本账户固定的 machine_id：都只对 Qoder 账户有意义，别的
  -- provider 用导入登录的令牌就能转发，这两列留空。machine_id 在第一次设 PAT 时随机生成
  -- 并固定下来，Qoder 的反作弊要求同一账户每次请求带同一个机器标识。
  pat TEXT NOT NULL DEFAULT '',
  machine_id TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS app_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT,
  level TEXT NOT NULL,
  account_id TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_log_ts ON app_log(ts DESC);
`;

/** 每个账户在 request_log 里保留的条数。 */
const REQUEST_LOG_KEEP = 200;

/** app_log 里保留的总条数；界面一次最多取 1000 条，再往前的翻不到。 */
const APP_LOG_KEEP = 2000;

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
  /** nextDueAt 是照哪个重置时刻排出来的；0 表示这一拍不是照窗口排的。 */
  plannedResetAt: number;
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

  /**
   * 补齐旧库缺的列。
   *
   * schema 用的都是 `CREATE TABLE IF NOT EXISTS`：表已经存在时，后加进 schema 的列不会被
   * 自动补上。这里按 `table_info` 挨个查一遍，缺哪列补哪列——`ADD COLUMN` 带默认值，旧行
   * 读出来就是默认值，不必回填。
   */
  private migrate(): void {
    const columnsOf = (table: string): Set<string> =>
      new Set(
        (this.db.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[]).map((r) => String(r.name)),
      );
    const gateway = columnsOf('gateway_account');
    if (!gateway.has('pat')) this.db.exec("ALTER TABLE gateway_account ADD COLUMN pat TEXT NOT NULL DEFAULT ''");
    if (!gateway.has('machine_id')) this.db.exec("ALTER TABLE gateway_account ADD COLUMN machine_id TEXT NOT NULL DEFAULT ''");
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

  /**
   * 记下这一拍排在什么时候，以及它是照哪个重置时刻排出来的。
   *
   * 两列一起写：分开写的话，进程恰好死在中间时，恢复出来的排期和它的依据对不上，
   * 等待期第一次核对就会白改一次期。
   */
  setNextDue(accountId: string, ts: number, plannedResetAt = 0): void {
    this.db
      .prepare(
        `INSERT INTO account_state (account_id, next_due_at, planned_reset_at) VALUES (?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           next_due_at = excluded.next_due_at,
           planned_reset_at = excluded.planned_reset_at`,
      )
      .run(accountId, toDateText(ts), toDateText(plannedResetAt));
  }

  /**
   * 把连续失败计数清零。
   *
   * 「额度还没重置」不是失败：上游拒绝这一发完全正常，记进计数器只会让一个健康的账户
   * 在界面上挂着一串“连续失败”，真出故障时反倒看不出来。
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
      response: String(r.response),
    }));
  }

  /**
   * 记一条给人看的日志。
   *
   * 和 request_log 一样是滚动的，只留最近 APP_LOG_KEEP 条：这是个常驻服务，不裁就一直长，
   * 而超出界面取数上限的那些行谁也翻不到。
   */
  appendLog(entry: Omit<LogEntry, 'id'>): LogEntry {
    const info = this.db
      .prepare('INSERT INTO app_log (ts, level, account_id, message) VALUES (?, ?, ?, ?)')
      .run(toDateText(entry.ts), entry.level, entry.accountId, entry.message);
    this.db
      .prepare(
        'DELETE FROM app_log WHERE id NOT IN (SELECT id FROM app_log ORDER BY id DESC LIMIT ?)',
      )
      .run(APP_LOG_KEEP);
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

  /* ── API 服务 ─────────────────────────────────────────────────────────── */

  /** 全部账户的网关设置与统计；没有行的账户按默认值处理，不在这里补行。 */
  gatewayAccounts(): Map<string, GatewayAccountRow> {
    const rows = this.db.prepare('SELECT * FROM gateway_account').all() as Record<string, unknown>[];
    return new Map(
      rows.map((r) => [
        String(r.account_id),
        {
          enabled: Number(r.enabled) === 1,
          priority: Number(r.priority) || 0,
          requests: Number(r.requests) || 0,
          failures: Number(r.failures) || 0,
          inputTokens: Number(r.input_tokens) || 0,
          outputTokens: Number(r.output_tokens) || 0,
          lastUsedAt: toMs(r.last_used_at),
          pat: String(r.pat ?? ''),
          machineId: String(r.machine_id ?? ''),
        },
      ]),
    );
  }

  /** 单个账户那一行；没有行时返回 null，由调用方按默认值处理。 */
  gatewayAccount(accountId: string): GatewayAccountRow | null {
    const row = this.db
      .prepare('SELECT * FROM gateway_account WHERE account_id = ?')
      .get(accountId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      enabled: Number(row.enabled) === 1,
      priority: Number(row.priority) || 0,
      requests: Number(row.requests) || 0,
      failures: Number(row.failures) || 0,
      inputTokens: Number(row.input_tokens) || 0,
      outputTokens: Number(row.output_tokens) || 0,
      lastUsedAt: toMs(row.last_used_at),
      pat: String(row.pat ?? ''),
      machineId: String(row.machine_id ?? ''),
    };
  }

  /**
   * 改某个账户的网关设置；只动传进来的那几项，统计不受影响。
   *
   * pat 一旦设成非空且这个账户还没有 machine_id，就随机生成一个并固定下来：Qoder 的反作弊
   * 认的是「同一账户每次都用同一台机器」，machine_id 每次换会被判成异常。清空 PAT 时保留
   * machine_id——用户过一会儿再把 PAT 填回来，身份不该跟着变。
   */
  setGatewayAccount(accountId: string, patch: Partial<GatewayAccountSetting> & { pat?: string }): void {
    this.db
      .prepare('INSERT OR IGNORE INTO gateway_account (account_id) VALUES (?)')
      .run(accountId);
    if (patch.enabled !== undefined) {
      this.db
        .prepare('UPDATE gateway_account SET enabled = ? WHERE account_id = ?')
        .run(patch.enabled ? 1 : 0, accountId);
    }
    if (patch.priority !== undefined) {
      this.db
        .prepare('UPDATE gateway_account SET priority = ? WHERE account_id = ?')
        .run(Math.trunc(patch.priority), accountId);
    }
    if (patch.pat !== undefined) {
      const pat = patch.pat.trim();
      this.db.prepare('UPDATE gateway_account SET pat = ? WHERE account_id = ?').run(pat, accountId);
      if (pat) {
        this.db
          .prepare("UPDATE gateway_account SET machine_id = ? WHERE account_id = ? AND (machine_id IS NULL OR machine_id = '')")
          .run(randomUUID(), accountId);
      }
    }
  }

  /**
   * 记一次转发的结果。
   *
   * token 数是上游报的，可能一个都没报（流被客户端中途掐断时就是这样），此时只累计次数。
   * 失败也要落账：卡片上「这个账户替我挡了多少次失败」和「用掉了多少 token」同样重要。
   */
  recordGatewayUse(
    accountId: string,
    ok: boolean,
    inputTokens: number,
    outputTokens: number,
    usedAt = Date.now(),
  ): void {
    this.db.prepare('INSERT OR IGNORE INTO gateway_account (account_id) VALUES (?)').run(accountId);
    this.db
      .prepare(
        `UPDATE gateway_account SET
           requests = requests + 1,
           failures = failures + ?,
           input_tokens = input_tokens + ?,
           output_tokens = output_tokens + ?,
           last_used_at = ?
         WHERE account_id = ?`,
      )
      .run(ok ? 0 : 1, Math.max(0, Math.trunc(inputTokens)), Math.max(0, Math.trunc(outputTokens)), toDateText(usedAt), accountId);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * 库里那一行网关数据：设置与统计并在一起，读的时候本来就是一起读。
 *
 * pat / machineId 只服务端用，不进 GatewayAccountView，也就不会随卡片下发到浏览器——
 * PAT 是密钥，界面只需要知道「设没设」，不需要拿到原文。
 */
export interface GatewayAccountRow extends GatewayAccountSetting, GatewayAccountStat {
  /** Qoder 转发用的 PAT；非 Qoder 账户或未设置时为空串。 */
  pat: string;
  /** 本账户固定的 machine_id；设 PAT 时随机生成一次，之后不变。 */
  machineId: string;
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
  if (raw === null || raw === '') return 0;
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
    lastError: String(r.last_error),
    plannedResetAt: toMs(r.planned_reset_at),
    plan: String(r.plan),
    subscriptionEndsAt: toMs(r.subscription_ends_at),
    usageCheckedAt: toMs(r.usage_checked_at),
    resetCredits: r.reset_credits === null ? null : Number(r.reset_credits),
    resetCreditsExpiresAt: toMsOrNull(r.reset_credits_expires_at),
    windows: parseWindows(r.windows_json),
  };
}
