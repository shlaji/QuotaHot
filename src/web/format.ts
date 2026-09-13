/** 时间和数字的展示格式化。 */
import { CLI_SCHEME, isCliRecord } from '../shared/curl.js';

export function clock(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** 把毫秒差值转成倒计时文本，例如“2天11小时”或“13分05秒”。 */
export function countdown(target: number | null, now: number): string {
  if (!target) return '—';
  const diff = target - now;
  if (diff <= 0) return '已到期';

  const totalSeconds = Math.floor(diff / 1000);
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;

  // 周窗口会持续很多天，因此只展示两个最大的时间单位即可
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${String(m).padStart(2, '0')}分`;
  if (m > 0) return `${m}分${String(s).padStart(2, '0')}秒`;
  return `${s}秒`;
}

/** 计算从现在到 `target` 还剩多少整天，向上取整；null 原样透传。 */
export function daysUntil(target: number | null, now: number): number | null {
  if (!target) return null;
  return Math.ceil((target - now) / 86_400_000);
}

/** 不带秒的日期时间，适合展示距离现在还有几天的时刻。 */
export function day(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function percent(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(0)}%`;
}

/** 额度的绝对数量：加千分位，小数最多两位（credits 常带小数）。 */
export function amount(v: number): string {
  return v.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

/**
 * 限额窗口的展示名称。两家上游的命名方式不同：
 * Claude 按时长命名，Codex 按主次命名；遇到未知名称时保持原样展示，而不是直接隐藏。
 */
const WINDOW_LABEL: Record<string, string> = {
  '5h': '5 小时',
  primary: '5 小时',
  secondary: '每周',
  seven_day: '7 天',
  seven_day_opus: '7 天 · Opus',
  seven_day_sonnet: '7 天 · Sonnet',
  seven_day_overage_included: '7 天 · 含超额',
  unified: '总限额',
  // Qoder 卖的是按订阅周期发放的额度，不是滚动窗口
  credits: '额度',
  credits_addon: '加油包',
};

export function windowLabel(name: string): string {
  return WINDOW_LABEL[name] ?? name;
}

/**
 * 请求打的是哪个上游接口。
 *
 * 一个账户的日志里混着好几路请求——发送、查额度、拉模型、刷令牌——光看时间和
 * 状态码分不出是哪一路出的问题，所以按地址归类，给出一眼能认的名字。
 * 认不出来的地址退回显示路径本身，而不是笼统的“其他”：至少还能看出打到了哪儿。
 */
const ENDPOINT_LABELS: Array<[RegExp, string]> = [
  [/\/v1\/messages$/, '发送消息'],
  [/\/codex\/responses$/, '发送消息'],
  [/\/api\/oauth\/usage$/, '查询额度'],
  [/\/(wham|api\/codex)\/usage$/, '查询额度'],
  [/\/rate-limit-reset-credits$/, '查询积分'],
  [/\/api\/oauth\/profile$/, '账户信息'],
  [/\/oauth\/token$/, '刷新令牌'],
  [/\/models$/, '模型列表'],
  [/\/api\/v2\/quota\/usage$/, '查询额度'],
  [/\/api\/v2\/user\/plan$/, '账户信息'],
];

export function endpointLabel(url: string): string {
  // 本机 CLI 那条路没有地址可归类，只有一个可执行文件名
  if (isCliRecord({ url })) return `本机 CLI · ${url.slice(CLI_SCHEME.length)}`;
  const path = urlPath(url);
  for (const [re, label] of ENDPOINT_LABELS) if (re.test(path)) return label;
  return path;
}

/** 取地址里的路径部分；地址不合法时原样返回，日志宁可难看也不该空着。 */
function urlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** 耗时：秒级以上换算成秒，省得盯着五位数毫秒去数位数。 */
export function duration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}
