import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDailyTime,
  isWithinDailyWindow,
  nextWindowClose,
  nextWindowOpen,
  parseDailyTime,
} from '../src/shared/schedule.js';

/** Build a local-time instant today, so the tests do not depend on the machine's timezone. */
function at(hours: number, minutes = 0, dayOffset = 0): number {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hours, minutes, 0, 0);
  return d.getTime();
}

test('解析每日时刻，容忍半角与全角冒号', () => {
  assert.equal(parseDailyTime('06:00'), 360);
  assert.equal(parseDailyTime('6:00'), 360);
  assert.equal(parseDailyTime('6：00'), 360, '中文输入法的全角冒号也应认');
  assert.equal(parseDailyTime('23:59'), 1439);
  assert.equal(parseDailyTime('12:30:45'), 750);

  for (const bad of ['', '24:00', '12:60', 'abc', '1200', null, 6]) {
    assert.equal(parseDailyTime(bad), null, `${String(bad)} 不该被接受`);
  }
});

test('格式化回 HH:MM', () => {
  assert.equal(formatDailyTime(360), '06:00');
  assert.equal(formatDailyTime(0), '00:00');
  assert.equal(formatDailyTime(1439), '23:59');
});

test('普通窗口按当天区间判断，右端开区间', () => {
  const [s, e] = [360, 720]; // 06:00 - 12:00
  assert.equal(isWithinDailyWindow(at(5, 59), s, e), false);
  assert.equal(isWithinDailyWindow(at(6, 0), s, e), true);
  assert.equal(isWithinDailyWindow(at(11, 59), s, e), true);
  assert.equal(isWithinDailyWindow(at(12, 0), s, e), false, '到点即关，不含右端');
});

test('结束早于开始视为跨零点', () => {
  const [s, e] = [1320, 360]; // 22:00 - 次日 06:00
  assert.equal(isWithinDailyWindow(at(23, 0), s, e), true);
  assert.equal(isWithinDailyWindow(at(2, 0), s, e), true, '零点后仍在同一段窗口里');
  assert.equal(isWithinDailyWindow(at(12, 0), s, e), false);
});

test('两端相同表示全天', () => {
  assert.equal(isWithinDailyWindow(at(3, 0), 360, 360), true);
  assert.equal(nextWindowOpen(at(3, 0), 360, 360), at(3, 0), '全天时不需要等待');
  assert.equal(nextWindowClose(at(3, 0), 360, 360), Number.POSITIVE_INFINITY);
});

test('窗口内的时刻原样返回，窗口外顺延到下一次开窗', () => {
  const [s, e] = [360, 720];
  assert.equal(nextWindowOpen(at(8, 0), s, e), at(8, 0), '已在窗口内不该改动');
  assert.equal(nextWindowOpen(at(3, 0), s, e), at(6, 0), '开窗前等到今天 06:00');
  assert.equal(nextWindowOpen(at(15, 0), s, e), at(6, 0, 1), '关窗后等到明天 06:00');
});

test('给出当前窗口的关闭时刻', () => {
  const [s, e] = [360, 720];
  assert.equal(nextWindowClose(at(8, 0), s, e), at(12, 0));
  assert.equal(nextWindowClose(at(15, 0), s, e), at(12, 0, 1), '已关窗则指向下一次关闭');
});
