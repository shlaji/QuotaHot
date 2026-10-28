import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InboxMessages } from '../src/web/wechat-inbox/Messages.js';
import { formatMessageTime } from '../src/web/wechat-inbox/time.js';

const now = Date.parse('2026-10-25T12:00:00Z');

for (const [elapsed, expected] of [
  [0, '刚刚'], [1, '刚刚'], [59_999, '刚刚'],
  [60_000, '1分钟前'], [119_999, '1分钟前'], [3_599_999, '59分钟前'],
  [3_600_000, '1小时前'], [86_399_999, '23小时前'],
  [86_400_000, '1天前'], [29 * 86_400_000, '29天前'],
  [30 * 86_400_000, '1个月前'], [364 * 86_400_000, '12个月前'],
  [365 * 86_400_000, '1年前'], [730 * 86_400_000, '2年前'],
  [-1, '1秒后'], [-30_000, '30秒后'], [-60_000, '1分钟后'],
  [-3_600_000, '1小时后'], [-86_400_000, '1天后'],
  [-30 * 86_400_000, '1个月后'], [-365 * 86_400_000, '1年后'],
] as const) {
  test(`formats ${expected} when the elapsed time is ${elapsed} milliseconds`, () => {
    const timestamp = new Date(now - elapsed).toISOString();

    const result = formatMessageTime(timestamp, now);

    assert.equal(result.relative, expected);
  });
}

test('preserves local date, seconds and milliseconds in the absolute title', () => {
  const timestamp = '2026-01-01T08:09:10.123+08:00';
  const local = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');

  const result = formatMessageTime(timestamp, now);

  assert.ok(result.absolute.includes(`${local.getFullYear()}/${pad(local.getMonth() + 1)}/${pad(local.getDate())}`));
  assert.ok(result.absolute.includes(`${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}.123`));
});

for (const timestamp of ['', 'not-a-timestamp']) {
  test(`shows an unknown time without throwing when timestamp is ${JSON.stringify(timestamp)}`, () => {
    const result = formatMessageTime(timestamp, now);

    assert.deepEqual(result, { relative: '时间未知', absolute: timestamp });
  });
}

test('renders compact message time with the exact original datetime and a local absolute title', () => {
  const timestamp = '2026-01-01T08:09:10.123+08:00';

  const html = renderToStaticMarkup(createElement(InboxMessages, { messages: [{
    id: 'message', sequence: 1, createdAt: timestamp, direction: 'inbound',
    kind: 'text', state: 'received', text: '已保存的消息', items: [],
  }] }));

  assert.match(html, /<time[^>]*>\d+(?:秒|分钟|小时|天|个月|年)[前后]<\/time>/);
  assert.ok(html.includes(`dateTime="${timestamp}"`));
  assert.match(html, /<time[^>]*title="\d{4}\/\d{2}\/\d{2}[^"]*\d{2}:\d{2}:\d{2}\.123[^"]*"/);
  assert.match(html, /<time[^>]*title="([^"]+)" aria-label="\1"/);
});
