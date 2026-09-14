/** 配置的读取、保存与校验。以 JSON 存储，界面保存后立即持久化。 */
import { readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { formatDailyTime, parseDailyTime } from '../shared/schedule.js';
import type { AppConfig } from '../shared/types.js';

/**
 * 数据目录默认在用户主目录下，而不是当前工作目录：
 * 从哪个路径启动都读到同一份配置和账户，systemd 单元也不必再指定 WorkingDirectory。
 */
export const DATA_DIR = process.env.QUOTAHOT_DATA_DIR ?? join(homedir(), '.quotahot');
const CONFIG_PATH = join(DATA_DIR, 'config.json');
export const DB_PATH = join(DATA_DIR, 'state.db');
/** 程序自己的账户目录；凭证从别处导入后就只在这里读写。 */
export const ACCOUNTS_DIR = join(DATA_DIR, 'accounts');
/**
 * cli-proxy-api 的认证目录。
 * 和其余导入来源一样是各客户端的固定位置，不再作为配置项，见 server/import.ts。
 */
export const CLI_PROXY_API_DIR = join(homedir(), '.cli-proxy-api');

export const DEFAULT_CONFIG: AppConfig = {
  text: 'hi',
  dailyStart: '06:00',
  dailyEnd: '23:00',
  bufferSeconds: 60,
  jitterSeconds: 120,
  maxRetries: 3,
  retryBackoffSeconds: 30,
  models: { claude: 'claude-sonnet-5', codex: 'gpt-5.6-luna' },
  usageRefreshMinutes: 10,
  clientCheckMinutes: 5,
  include: [],
  exclude: [],
  proxy: 'http://127.0.0.1:7897',
  noProxy: [
    'localhost',
    '127.0.0.1',
    '::1',
    '10.10.0.79',
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '169.254.0.0/16',
    '100.64.0.0/10',
  ],
  // 全新安装时不自动跑：用户还没点过一次启动，就不该替他开始发送
  autoStart: false,
  autoStartIds: [],
};

function clampNumber(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean);
}

/** 把任意输入收敛成合法配置，避免界面脏数据直接把调度器弄坏。 */
export function normalize(raw: unknown): AppConfig {
  const r = (raw ?? {}) as Partial<AppConfig>;
  const d = DEFAULT_CONFIG;

  /**
   * 读取每天重复的 `HH:MM` 时间。
   * 在窗口从“具体日期时间”迁移为“每日时刻”之前的旧配置，会在 startAt/endAt
   * 里保存 ISO 时间戳；这里保留它的时分信息，丢掉日期部分。
   */
  const dailyTime = (v: unknown, legacy: unknown, fallback: string): string => {
    const minutes = parseDailyTime(v);
    if (minutes !== null) return formatDailyTime(minutes);
    if (typeof legacy === 'string') {
      const t = Date.parse(legacy);
      if (!Number.isNaN(t)) {
        const d = new Date(t);
        return formatDailyTime(d.getHours() * 60 + d.getMinutes());
      }
    }
    return fallback;
  };
  const legacy = (raw ?? {}) as { startAt?: unknown; endAt?: unknown };

  return {
    text: typeof r.text === 'string' && r.text.length > 0 ? r.text.slice(0, 4000) : d.text,
    dailyStart: dailyTime(r.dailyStart, legacy.startAt, d.dailyStart),
    dailyEnd: dailyTime(r.dailyEnd, legacy.endAt, d.dailyEnd),
    bufferSeconds: clampNumber(r.bufferSeconds, d.bufferSeconds, 0, 3600),
    jitterSeconds: clampNumber(r.jitterSeconds, d.jitterSeconds, 0, 3600),
    maxRetries: clampNumber(r.maxRetries, d.maxRetries, 1, 10),
    retryBackoffSeconds: clampNumber(r.retryBackoffSeconds, d.retryBackoffSeconds, 1, 3600),
    models: {
      claude: String(r.models?.claude ?? d.models.claude).trim() || d.models.claude,
      codex: String(r.models?.codex ?? d.models.codex).trim() || d.models.codex,
    },
    usageRefreshMinutes: clampNumber(r.usageRefreshMinutes, d.usageRefreshMinutes, 0, 1440),
    clientCheckMinutes: clampNumber(r.clientCheckMinutes, d.clientCheckMinutes, 0, 1440),
    include: toStringArray(r.include),
    exclude: toStringArray(r.exclude),
    proxy: typeof r.proxy === 'string' ? r.proxy.trim() : d.proxy,
    noProxy: toStringArray(r.noProxy),
    autoStart: Boolean(r.autoStart),
    autoStartIds: toStringArray(r.autoStartIds),
  };
}

/**
 * 同步读取：这是启动路径上的第一件事，同步做省掉了顶层 await——
 * 而顶层 await 会让服务端没法打成 CommonJS，单文件可执行就无从谈起。
 * 读的是本地一个几百字节的 JSON，代价可以忽略。
 */
export function loadConfig(): AppConfig {
  try {
    return normalize(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(cfg: AppConfig): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

/**
 * 在 *原始* 请求体上校验每日窗口，避免 normalize() 把拼错的时间悄悄替换成默认值。
 * 合法时返回 null，否则返回错误信息。
 */
export function validateSchedule(raw: unknown): string | null {
  const r = (raw ?? {}) as { dailyStart?: unknown; dailyEnd?: unknown };
  for (const [key, label] of [['dailyStart', '开始时间'], ['dailyEnd', '结束时间']] as const) {
    const v = r[key];
    if (v === undefined || v === null || v === '') continue;
    if (parseDailyTime(v) === null) return `${label}需要是每天的时刻，格式 HH:MM，例如 06:00`;
  }
  return null;
}
