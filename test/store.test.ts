import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/server/store.js';

function tempStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'quotahot-')), 'state.db');
}

function tempStore(): Store {
  return new Store(tempStorePath());
}

const REQ = {
  method: 'POST',
  url: 'https://api.anthropic.com/v1/messages',
  headers: { authorization: 'Bearer $QUOTAHOT_TOKEN', 'content-type': 'application/json' },
  body: '{"model":"claude-sonnet-5"}',
};

test('请求日志按账户隔离，最新的排在前面', () => {
  const store = tempStore();
  store.recordRequest('a@x.com', 1000, REQ, 200, 120, '');
  store.recordRequest('a@x.com', 2000, { ...REQ, body: '{"n":2}' }, 429, 90, 'rate limited');
  store.recordRequest('b@x.com', 3000, REQ, 200, 80, '');

  const rows = store.accountRequests('a@x.com');
  assert.equal(rows.length, 2, '不能串到别的账户');
  assert.equal(rows[0].sentAt, 2000, '最新的排最前');
  assert.equal(rows[0].status, 429);
  assert.equal(rows[0].error, 'rate limited');
  assert.equal(rows[0].body, '{"n":2}');
  assert.deepEqual(rows[1].headers, REQ.headers, '请求头要能原样取回');
  assert.equal(rows[1].durationMs, 120);
  store.close();
});

test('响应体后补进同一行，不新开一条日志', () => {
  const store = tempStore();
  const rowId = store.recordRequest('a@x.com', 1000, REQ, 429, 120, '');
  // 落行时正文还没读完，所以先是空的
  assert.equal(store.accountRequests('a@x.com')[0].response, '');

  store.updateRequestResponse(rowId, '{"error":{"message":"rate limit"}}');
  const rows = store.accountRequests('a@x.com');
  assert.equal(rows.length, 1, '补写不该多出一行');
  assert.equal(rows[0].response, '{"error":{"message":"rate limit"}}');
  store.close();
});

test('网关请求写入临时表并支持补写响应', () => {
  const path = tempStorePath();
  const store = new Store(path);
  const rowId = store.recordGatewayRequest('a@x.com', 1000, REQ, 429, 120, 'rate limited');

  const raw = new DatabaseSync(path);
  assert.equal((raw.prepare('SELECT count(*) AS n FROM request_log').get() as { n: number }).n, 0);
  assert.equal((raw.prepare('SELECT count(*) AS n FROM gateway_request_log').get() as { n: number }).n, 1);
  store.updateGatewayRequestResponse(rowId, '{"error":"rate limit"}');
  assert.equal(
    (raw.prepare('SELECT response FROM gateway_request_log WHERE id = ?').get(rowId) as { response: string }).response,
    '{"error":"rate limit"}',
  );
  raw.close();
  store.close();
});

test('网关临时记录只保留 TTL 内的数据', () => {
  const path = tempStorePath();
  const store = new Store(path);
  store.recordGatewayRequest('a@x.com', 1000, REQ, 200, 10, '');
  store.recordGatewayRequest('a@x.com', 86_401_000, REQ, 200, 10, '');
  store.cleanupGatewayRequests(86_401_000);

  const raw = new DatabaseSync(path);
  const rows = raw.prepare('SELECT sent_at FROM gateway_request_log ORDER BY id').all();
  assert.equal(String((rows[0] as Record<string, unknown> | undefined)?.sent_at), '1970-01-02T00:00:01.000Z');
  raw.close();
  store.close();
});

test('启动时清理临时日志失败也不阻止 Store 启动', () => {
  const path = tempStorePath();
  const cleanup = Store.prototype.cleanupGatewayRequests;
  let calls = 0;
  Store.prototype.cleanupGatewayRequests = function (now) {
    calls += 1;
    if (calls === 1) throw new Error('temporary cleanup failure');
    return cleanup.call(this, now);
  };

  try {
    const store = new Store(path);
    store.close();
  } finally {
    Store.prototype.cleanupGatewayRequests = cleanup;
  }

  assert.equal(calls, 1);
});

test('每账户只保留最近 200 条，不会无限长', () => {
  const store = tempStore();
  for (let i = 0; i < 205; i++) store.recordRequest('a@x.com', i, REQ, 200, 10, '');
  const rows = store.accountRequests('a@x.com', 1000);
  assert.equal(rows.length, 200);
  assert.equal(rows[0].sentAt, 204, '保留的是最新的那一批');
  assert.equal(rows[199].sentAt, 5);
  store.close();
});

test('limit 只影响读取条数', () => {
  const store = tempStore();
  for (let i = 0; i < 10; i++) store.recordRequest('a@x.com', i, REQ, 200, 10, '');
  assert.equal(store.accountRequests('a@x.com', 3).length, 3);
  assert.equal(store.accountRequests('没发过的账户').length, 0);
  store.close();
});

test('窗口查询不覆盖重置明细，完整查询可以清空明细', () => {
  const store = tempStore();
  const snapshot = { windows: [], plan: 'plus', subscriptionEndsAt: null, checkedAt: Date.now() };
  store.recordUsage('a', { ...snapshot, resetCredits: 2, resetCreditsExpiresAt: 12345 }, null);
  store.recordUsage('a', snapshot, null);
  assert.equal(store.getState('a')?.resetCredits, 2);
  assert.equal(store.getState('a')?.resetCreditsExpiresAt, 12345);
  store.recordUsage('a', { ...snapshot, resetCredits: null, resetCreditsExpiresAt: null }, null);
  assert.equal(store.getState('a')?.resetCredits, null);
  store.close();
});

/** 库里那三个时刻是日期文本，但对上层仍然是毫秒——两头都要钉住。 */
test('next_due_at / last_sent_at / last_reset_at 以 ISO 文本落库，读出来还是毫秒', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quotahot-'));
  const path = join(dir, 'state.db');
  const store = new Store(path);
  const due = Date.parse('2026-09-12T08:30:00.000Z');
  const sentAt = Date.parse('2026-09-12T03:30:00.000Z');
  const resetAt = Date.parse('2026-09-12T08:00:00.000Z');

  store.setNextDue('a', due);
  store.recordSend({
    accountId: 'a', sentAt, ok: true,
    resetAt, source: 'header:x', usedPercent: 12, error: '',
  });

  const st = store.getState('a')!;
  assert.equal(st.nextDueAt, due);
  assert.equal(st.lastSentAt, sentAt);
  assert.equal(st.lastResetAt, resetAt);
  store.close();

  const raw = new DatabaseSync(path);
  const row = raw.prepare('SELECT * FROM account_state WHERE account_id = ?').get('a') as Record<string, unknown>;
  assert.equal(row.next_due_at, '2026-09-12T08:30:00.000Z');
  assert.equal(row.last_sent_at, '2026-09-12T03:30:00.000Z');
  assert.equal(row.last_reset_at, '2026-09-12T08:00:00.000Z');
  // 字典序即时序，SQL 侧照样能比大小、能按本地时区读
  const later = raw
    .prepare("SELECT account_id FROM account_state WHERE next_due_at > '2026-09-12T00:00:00.000Z'")
    .all();
  assert.equal(later.length, 1, '日期文本要能直接参与比较');
  raw.close();
});

test('没排期 / 没发过存成 NULL，而不是 1970 年', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quotahot-'));
  const path = join(dir, 'state.db');
  const store = new Store(path);
  store.setNextDue('a', 0);
  const st = store.getState('a')!;
  assert.equal(st.nextDueAt, 0, '上层看到的仍是 0');
  assert.equal(st.lastSentAt, 0);
  store.close();

  const raw = new DatabaseSync(path);
  const row = raw.prepare('SELECT * FROM account_state WHERE account_id = ?').get('a') as Record<string, unknown>;
  assert.equal(row.next_due_at, null);
  assert.equal(row.last_sent_at, null);
  raw.close();
});
