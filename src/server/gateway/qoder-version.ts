/**
 * Qoder 的 Cosy/CLI 版本号,转发时要塞进 User-Agent / Cosy-Version / business.version。
 *
 * 手工跟着 Qoder 每次发版改这个常量是纯体力活。这里从 npm 上的 `@qoder-ai/qodercli` 拉
 * published latest,按 TTL 惰性刷新;npm 拉不到就一直用上一次的好值(或内置兜底)。做法照搬
 * 了 qoder-route 的 qoder_version 服务,只是把它的后台循环改成「按需 + TTL」——转发路径本来
 * 就会频繁调 get(),不必再单起一个定时器。
 */
import { request } from '../http.js';

const NPM_LATEST_URL = 'https://registry.npmjs.org/@qoder-ai/qodercli/latest';
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** 第一次成功拉到 npm 之前用它。探针实测这个版本的签名被上游接受。 */
const FALLBACK_VERSION = '1.1.36';
const REFRESH_INTERVAL_MS = 6 * 3600_000;

let cached = FALLBACK_VERSION;
let fetchedAt = 0;
let inflight: Promise<string> | null = null;

/** 当前版本号,同步返回;第一次调用时顺手在后台触发一次刷新。 */
export function cosyVersion(): string {
  if (Date.now() - fetchedAt >= REFRESH_INTERVAL_MS) void refreshCosyVersion();
  return cached;
}

/** 主动刷新(带 TTL 去重);拉不到就保持原值。返回当前值。 */
export function refreshCosyVersion(force = false): Promise<string> {
  if (!force && Date.now() - fetchedAt < REFRESH_INTERVAL_MS) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = fetchNpmVersion()
    .then((version) => {
      if (version) {
        cached = version;
        fetchedAt = Date.now();
      } else if (fetchedAt === 0) {
        // 一次都没成功过:标记一下时间,免得每次 get() 都去打 npm
        fetchedAt = Date.now() - REFRESH_INTERVAL_MS + 60_000;
      }
      return cached;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

async function fetchNpmVersion(): Promise<string | null> {
  try {
    const resp = await request(NPM_LATEST_URL, { method: 'GET', timeoutMs: 8000 });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { version?: unknown };
    const version = typeof data.version === 'string' ? data.version.trim() : '';
    return VERSION_RE.test(version) ? version : null;
  } catch {
    return null;
  }
}
