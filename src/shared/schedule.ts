/**
 * 每日窗口相关的时间计算。
 *
 * 这里的调度配置表示“每天的某个时间段”，而不是具体日期：例如 “06:00–12:00” 指的是
 * 服务端本地时区下每天都会重复的这个区间。结束早于开始表示跨零点（22:00–06:00），
 * 开始等于结束则表示全天。
 *
 * 这些函数刻意保持纯函数形式，这样浏览器展示的窗口边界就能和调度器真实等待的边界一致。
 */

/** 把 'H:MM'、'HH:MM' 或 'HH:MM:SS' 转成本地零点后的分钟数；无法解析时返回 null。 */
export function parseDailyTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  // 中文输入法默认会产出全角冒号，因此这里也接受它
  const m = /^\s*(\d{1,2})\s*[:：]\s*(\d{1,2})\s*(?::\s*\d{1,2}\s*)?$/.exec(value);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** 规范化成 'HH:MM'；这也是 <input type="time"> 期望的格式。 */
export function formatDailyTime(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 计算 `ref` 所在那一天里“本地零点后 `minutes` 分钟”的绝对时刻。 */
function atMinutes(ref: number, minutes: number, dayOffset = 0): number {
  const d = new Date(ref);
  // 先改日期再改时间，能保证 DST 切换时结果仍然正确
  if (dayOffset !== 0) d.setDate(d.getDate() + dayOffset);
  d.setHours(0, minutes, 0, 0);
  return d.getTime();
}

export function isWithinDailyWindow(ts: number, startMin: number, endMin: number): boolean {
  if (startMin === endMin) return true;
  const start = atMinutes(ts, startMin);
  const end = atMinutes(ts, endMin);
  return startMin < endMin ? ts >= start && ts < end : ts >= start || ts < end;
}

/** 计算从 `from` 开始往后，第一个落在窗口内的时刻。 */
export function nextWindowOpen(from: number, startMin: number, endMin: number): number {
  if (isWithinDailyWindow(from, startMin, endMin)) return from;
  const today = atMinutes(from, startMin);
  return today > from ? today : atMinutes(from, startMin, 1);
}

/** 计算覆盖 `ts` 的那个窗口何时关闭；全天窗口时返回 Infinity。 */
export function nextWindowClose(ts: number, startMin: number, endMin: number): number {
  if (startMin === endMin) return Number.POSITIVE_INFINITY;
  const end = atMinutes(ts, endMin);
  return end > ts ? end : atMinutes(ts, endMin, 1);
}
