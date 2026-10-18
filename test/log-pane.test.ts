import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LogEntry } from '../src/shared/types.js';
import { filterLogsByDate, LogPane, recentLogDateRange } from '../src/web/components/LogPane.js';

test('account realtime logs include a zero-padded local calendar date', (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 0, 2, 12).getTime() });
  const log: LogEntry = {
    id: 1,
    ts: new Date(2026, 0, 2, 3, 4, 5).getTime(),
    level: 'info',
    accountId: 'account@example.com',
    message: '额度查询完成',
  };

  const html = renderToStaticMarkup(createElement(LogPane, { logs: [log] }));

  assert.match(html, /<time>2026-01-02 03:04:05<\/time>/);
  assert.match(html, /account@example\.com/);
  assert.match(html, /额度查询完成/);
});

for (const { today, start, end } of [
  { today: new Date(2026, 0, 1, 0, 30), start: '2025-12-30', end: '2026-01-01' },
  { today: new Date(2026, 4, 1, 23, 30), start: '2026-04-29', end: '2026-05-01' },
  { today: new Date(2024, 2, 1, 12), start: '2024-02-28', end: '2024-03-01' },
]) {
  test(`recent log range includes three calendar dates ending ${end}`, () => {
    const range = recentLogDateRange(today);

    assert.deepEqual(range, { start, end });
  });
}

test('recent log range stays calendar-based across spring and autumn DST changes', (context) => {
  const previousZone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  context.after(() => {
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
  });

  const ranges = [
    recentLogDateRange(new Date(2026, 2, 9, 0, 30)),
    recentLogDateRange(new Date(2026, 10, 2, 23, 30)),
  ];

  assert.deepEqual(ranges, [
    { start: '2026-03-07', end: '2026-03-09' },
    { start: '2026-10-31', end: '2026-11-02' },
  ]);
});

const boundaryLogs: LogEntry[] = [
  { id: 1, ts: new Date(2025, 11, 29, 23, 59, 59, 999).getTime(), accountId: '', level: 'info', message: 'before' },
  { id: 2, ts: new Date(2025, 11, 30, 0).getTime(), accountId: '', level: 'info', message: 'start' },
  { id: 3, ts: new Date(2025, 11, 31, 12).getTime(), accountId: '', level: 'warn', message: 'middle' },
  { id: 4, ts: new Date(2026, 0, 1, 23, 59, 59, 999).getTime(), accountId: '', level: 'error', message: 'end' },
  { id: 5, ts: new Date(2026, 0, 2, 0).getTime(), accountId: '', level: 'info', message: 'after' },
];

test('log range includes both complete endpoint dates and excludes adjacent dates', () => {
  const visible = filterLogsByDate(boundaryLogs, { start: '2025-12-30', end: '2026-01-01' });

  assert.deepEqual(visible.map((log) => log.id), [2, 3, 4]);
  assert.equal(visible[0], boundaryLogs[1]);
  assert.equal(boundaryLogs.length, 5);
});

for (const { start, end, ids } of [
  { start: '', end: '2025-12-30', ids: [1, 2] },
  { start: '2026-01-01', end: '', ids: [4, 5] },
  { start: '', end: '', ids: [1, 2, 3, 4, 5] },
  { start: '2025-12-31', end: '2025-12-31', ids: [3] },
  { start: '2026-01-01', end: '2025-12-30', ids: [] },
]) {
  test(`log range supports bounds ${start || 'open'} through ${end || 'open'}`, () => {
    const visible = filterLogsByDate(boundaryLogs, { start, end });

    assert.deepEqual(visible.map((log) => log.id), ids);
  });
}

test('filtering uses the local calendar date rather than the UTC date', (context) => {
  const previousZone = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
  context.after(() => {
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
  });
  const logs: LogEntry[] = [
    { id: 1, ts: Date.parse('2026-01-01T16:00:00Z'), accountId: '', level: 'info', message: 'local Jan 2' },
    { id: 2, ts: Date.parse('2026-01-02T16:00:00Z'), accountId: '', level: 'info', message: 'local Jan 3' },
  ];

  const visible = filterLogsByDate(logs, { start: '2026-01-02', end: '2026-01-02' });

  assert.deepEqual(visible.map((log) => log.id), [1]);
});

test('log panel defaults to three dates with labelled accessible native controls', (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 0, 1, 12).getTime() });

  const html = renderToStaticMarkup(createElement(LogPane, { logs: boundaryLogs }));

  assert.match(html, /<label class="field"><span>开始日期<\/span><input type="date"[^>]*value="2025-12-30"\/><\/label>/);
  assert.match(html, /<label class="field"><span>结束日期<\/span><input type="date"[^>]*value="2026-01-01"\/><\/label>/);
  const descriptionId = /<p id="([^"]+)"[^>]*>按本地日期/.exec(html)?.[1];
  assert.ok(descriptionId);
  assert.equal(html.split(`aria-describedby="${descriptionId}"`).length - 1, 2);
  assert.match(html, /<button type="button"[^>]*>最近 3 天<\/button>/);
  assert.match(html, /type="checkbox" checked=""/);
  assert.equal((html.match(/class="log-line /g) ?? []).length, 3);
  assert.doesNotMatch(html, />before<|>after</);
});

test('empty source and a range without loaded matches have distinct status messages', (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 5, 1, 12).getTime() });

  const emptyHtml = renderToStaticMarkup(createElement(LogPane, { logs: [] }));
  const unmatchedHtml = renderToStaticMarkup(createElement(LogPane, { logs: boundaryLogs }));

  assert.match(emptyHtml, /role="status">暂无日志<\/p>/);
  assert.match(unmatchedHtml, /role="status">所选日期范围内暂无日志<\/p>/);
  assert.doesNotMatch(unmatchedHtml, /class="log-line /);
});
