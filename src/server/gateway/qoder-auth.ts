/**
 * Qoder 转发的凭证链:PAT →(exchange)→ job token(jt)→(userinfo)→ uid。
 *
 * 这条链和导入登录那套(OAuth access_token)是**两回事**:转发用的是账户页面单独设的 PAT,
 * 换来的 jt 是短时令牌(约 24h),uid 是账户的稳定标识。三者都缓存:
 *
 * - jt 按到期时间缓存,提前一点过期,免得卡在边界上用一个刚失效的令牌;
 * - uid 按 PAT 长期缓存,它不会变。
 *
 * 缓存 key 用 PAT 本身——一个账户一份 PAT,天然隔离。PAT 变了(用户重设)就自然落到新 key,
 * 旧条目留着无害,过期即弃。
 */
import { request } from '../http.js';
import { cosyVersion } from './qoder-version.js';
import { randomUUID } from 'node:crypto';

const OPENAPI_BASE = 'https://openapi.qoder.sh';
const EXCHANGE_PATH = '/api/v1/jobToken/exchange';
const USERINFO_PATH = '/api/v1/userinfo';

/** jt 缓存:提前这么多毫秒判过期,给转发留出富余。 */
const JT_EXPIRY_MARGIN_MS = 5 * 60_000;
/** exchange 没给 expires_in 时的兜底 TTL。 */
const JT_DEFAULT_TTL_MS = 12 * 3600_000;

interface JobToken {
  token: string;
  expiresAt: number;
}

const jtCache = new Map<string, JobToken>();
const uidCache = new Map<string, string>();

/** OpenAPI 通用请求头。machineOS 固定成官方 CLI 用的那串,和签名器里的一致。 */
function baseHeaders(): Record<string, string> {
  const version = cosyVersion();
  return {
    'User-Agent': `qoder/${version}`,
    Accept: 'application/json',
    'X-Request-ID': randomUUID().toUpperCase(),
    'Cosy-Version': version,
    'Cosy-ClientType': '5',
    'Cosy-MachineOS': 'x86_64_linux',
  };
}

export class QoderAuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'QoderAuthError';
  }
}

/**
 * 拿一个可用的 job token,缓存命中就直接返回。
 *
 * exchange 失败按状态码抛 QoderAuthError:401/403 是 PAT 本身的问题(该记到账户头上),
 * 其余(5xx / 网络)是基础设施抖动。上层据此决定要不要让账户进冷却。
 */
export async function getJobToken(pat: string): Promise<string> {
  const cached = jtCache.get(pat);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const resp = await request(`${OPENAPI_BASE}${EXCHANGE_PATH}`, {
    method: 'POST',
    headers: { ...baseHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ personal_token: pat }),
    timeoutMs: 20_000,
  });
  if (!resp.ok) {
    throw new QoderAuthError(resp.status, `Qoder PAT 换取 job token 失败(${resp.status}): ${(await resp.text()).slice(0, 200)}`);
  }
  const data = (await resp.json()) as { token?: unknown; expires_in?: unknown };
  const token = typeof data.token === 'string' ? data.token : '';
  if (!token) throw new QoderAuthError(resp.status, 'Qoder job token 响应缺少 token 字段');
  // expires_in 是毫秒(实测 86400000),不是秒
  const ttl = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : JT_DEFAULT_TTL_MS;
  jtCache.set(pat, { token, expiresAt: Date.now() + ttl - JT_EXPIRY_MARGIN_MS });
  return token;
}

/**
 * 拿账户 uid,长期缓存。
 *
 * userinfo 用 Bearer jt 鉴权,所以要先有 jt。id / user_id / uid 三个字段名按顺序取第一个有值的。
 */
export async function getUid(pat: string): Promise<string> {
  const cached = uidCache.get(pat);
  if (cached) return cached;

  const jt = await getJobToken(pat);
  const resp = await request(`${OPENAPI_BASE}${USERINFO_PATH}`, {
    method: 'GET',
    headers: { ...baseHeaders(), Authorization: `Bearer ${jt}` },
    timeoutMs: 20_000,
  });
  if (!resp.ok) {
    throw new QoderAuthError(resp.status, `Qoder userinfo 获取失败(${resp.status}): ${(await resp.text()).slice(0, 200)}`);
  }
  const data = (await resp.json()) as { id?: unknown; user_id?: unknown; uid?: unknown };
  const uid = [data.id, data.user_id, data.uid].map((v) => (typeof v === 'string' ? v : '')).find((v) => v) ?? '';
  if (!uid) throw new QoderAuthError(resp.status, 'Qoder userinfo 响应缺少 uid');
  uidCache.set(pat, uid);
  return uid;
}

/** 用户重设 PAT 时清掉旧缓存,别让下一次转发拿着上一份 PAT 的 jt/uid。 */
export function forgetQoderAuth(pat: string): void {
  jtCache.delete(pat);
  uidCache.delete(pat);
}
