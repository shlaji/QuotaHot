/** 配置的读取、保存与校验。以 JSON 存储，界面保存后立即持久化。 */
import { readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { formatDailyTime, parseDailyTime } from '../shared/schedule.js';
import { DEFAULT_GATEWAY_CONFIG, type GatewayConfig } from '../shared/gateway.js';
import {
  CLIENT_PATH_FIELDS,
  CLIENT_PATH_KEYS,
  type ClientPaths,
} from '../shared/clientpaths.js';
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
  // 空表示每个客户端都用它在本机的默认位置，见 server/clientpaths.ts
  clientPaths: {},
  // 全新安装时不自动跑：用户还没点过一次启动，就不该替他开始发送
  autoStart: false,
  autoStartIds: [],
  gateway: { ...DEFAULT_GATEWAY_CONFIG },
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
    clientPaths: normalizeClientPaths(r.clientPaths),
    autoStart: Boolean(r.autoStart),
    autoStartIds: toStringArray(r.autoStartIds),
    gateway: normalizeGateway(r.gateway),
  };
}

/**
 * 把 `~` 开头的路径展开成绝对路径。
 * 界面上让人手敲完整的主目录很别扭，而这些路径本来就全在主目录下。
 */
function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

/**
 * 收敛客户端路径覆盖。
 *
 * 只认识已知来源，只留绝对路径：相对路径会跟着进程的工作目录跑，而这个服务既可能从
 * 终端启动也可能由 systemd 拉起，两处的工作目录不是一回事。不合格的项直接丢掉——
 * 丢掉意味着回退到内置默认位置，也就是没配过时的行为，不会让服务起不来。
 * 界面上那条「请填绝对路径」的提示由 validateClientPaths 在保存前给出。
 */
export function normalizeClientPaths(raw: unknown): ClientPaths {
  const r = (raw ?? {}) as Record<string, unknown>;
  const out: ClientPaths = {};
  for (const key of CLIENT_PATH_KEYS) {
    const value = r[key];
    if (typeof value !== 'string') continue;
    const path = expandHome(value.trim());
    if (path && isAbsolute(path)) out[key] = path;
  }
  return out;
}

/**
 * 在 *原始* 请求体上校验客户端路径，理由与 validateSchedule 相同：
 * normalize() 会把填错的路径悄悄丢掉，用户看到的就成了「保存成功但没生效」。
 * 合法时返回 null。
 */
export function validateClientPaths(raw: unknown): string | null {
  const r = ((raw ?? {}) as { clientPaths?: unknown }).clientPaths;
  if (r === undefined || r === null) return null;
  if (typeof r !== 'object') return '客户端路径需要是一组「来源: 路径」';
  const values = r as Record<string, unknown>;
  for (const field of CLIENT_PATH_FIELDS) {
    const value = values[field.key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string') return `${field.label} 的路径需要是一段文本`;
    const path = expandHome(value.trim());
    if (!path) continue;
    if (!isAbsolute(path)) return `${field.label} 需要填绝对路径，例如 /home/me/.codex/auth.json`;
  }
  return null;
}

/**
 * 收敛 API 服务的设置。
 *
 * 老配置文件里没有这一段，因此每一项都要能从 undefined 里长出默认值——升级上来的用户
 * 不该因为配置文件少了一段就启动失败，也不该因此稀里糊涂地把转发端点开起来。
 */
export function normalizeGateway(raw: unknown): GatewayConfig {
  const r = (raw ?? {}) as Partial<GatewayConfig>;
  const d = DEFAULT_GATEWAY_CONFIG;
  return {
    enabled: Boolean(r.enabled),
    // key 里的空白全部去掉：用户多半是从别处粘进来的，末尾一个空格会让校验永远不过
    apiKeys: toStringArray(r.apiKeys),
    strategy: r.strategy === 'round-robin' ? 'round-robin' : d.strategy,
    maxAttempts: clampNumber(r.maxAttempts, d.maxAttempts, 1, 10),
    maxConsecutiveFailures: clampNumber(r.maxConsecutiveFailures, d.maxConsecutiveFailures, 1, 20),
    cooldownSeconds: clampNumber(r.cooldownSeconds, d.cooldownSeconds, 0, 3600),
    exhaustedPercent: clampNumber(r.exhaustedPercent, d.exhaustedPercent, 1, 100),
    crossProvider: Boolean(r.crossProvider),
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
