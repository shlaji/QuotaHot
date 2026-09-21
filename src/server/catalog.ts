/**
 * 可选模型列表：向上游要这个账户真正能用的模型，而不是硬编码一份清单。
 *
 * Claude/Codex 的目录接口各自复用 headers.ts 里的既有调用方身份，查不到时退回
 * shared/models.ts 的内置清单。Qoder Cloud Mode 使用账户网关 PAT；查不到时返回空列表，
 * 由调用方省略该 provider 的模型。
 *
 * 结果按 provider 缓存一段时间：模型目录一天也变不了几次，而配置面板每次打开都会问一遍。
 */
import { request } from './http.js';
import { CODEX_CLIENT_VERSION, claudeModelsHeaders, codexModelsHeaders, diagnose } from './headers.js';
import { MODEL_OPTIONS } from '../shared/models.js';
import { GATEWAY_TOKEN_PLACEHOLDER } from '../shared/curl.js';
import { auditOf, type Account } from './creds.js';
import type { ModelOption, Provider } from '../shared/types.js';

const CLAUDE_MODELS_URL = 'https://api.anthropic.com/v1/models?limit=100';
const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models';
const QODER_MODELS_URL = 'https://api.qoder.com/api/v1/cloud/models';
const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 30 * 60 * 1000;

function toText(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Codex：`{ models: [{ slug, display_name, visibility, priority }] }`。
 * `visibility: "hide"` 是上游给自己留的内部模型（如 codex-auto-review），不该出现在下拉框里。
 */
export function parseCodexModels(payload: unknown): ModelOption[] {
  const root = (payload ?? {}) as Record<string, unknown>;
  const list = Array.isArray(root.models) ? root.models : [];
  const items = list
    .filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object')
    .filter((m) => toText(m.visibility) !== 'hide')
    .filter((m) => m.supported_in_api !== false)
    .map((m) => ({
      id: toText(m.slug),
      label: toText(m.display_name) || toText(m.slug),
      // priority 是上游自己的推荐次序，缺失的排到最后而不是排到最前
      priority: Number.isFinite(Number(m.priority)) ? Number(m.priority) : Number.MAX_SAFE_INTEGER,
    }))
    .filter((m) => m.id !== '');

  items.sort((a, b) => a.priority - b.priority);
  return items.map(({ id, label }) => ({ id, label }));
}

/** Claude：`{ data: [{ id, display_name }] }`，顺序已经是上游给的从新到旧。 */
export function parseClaudeModels(payload: unknown): ModelOption[] {
  const root = (payload ?? {}) as Record<string, unknown>;
  const list = Array.isArray(root.data) ? root.data : [];
  return list
    .filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object')
    .map((m) => ({ id: toText(m.id), label: toText(m.display_name) || toText(m.id) }))
    .filter((m) => m.id !== '');
}

export function parseQoderModels(payload: unknown): ModelOption[] {
  const root = (payload ?? {}) as Record<string, unknown>;
  const list = Array.isArray(root.models) ? root.models : Array.isArray(root.data) ? root.data : [];
  return list
    .filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object')
    .filter((model) => model.is_enabled !== false)
    .map((model) => ({ id: toText(model.id), label: toText(model.display_name) || toText(model.id) }))
    .filter((model) => model.id !== '');
}

async function fetchCodex(acct: Account): Promise<ModelOption[]> {
  const url = `${CODEX_MODELS_URL}?client_version=${encodeURIComponent(CODEX_CLIENT_VERSION)}`;
  const resp = await request(url, {
    headers: codexModelsHeaders(acct.accessToken, acct.accountId),
    timeoutMs: FETCH_TIMEOUT_MS,
    audit: auditOf(acct),
  });
  const body = await resp.text();
  if (resp.status !== 200) {
    throw new Error(`HTTP ${resp.status}${diagnose(resp.headers, body)}`);
  }
  return parseCodexModels(JSON.parse(body));
}

async function fetchClaude(acct: Account): Promise<ModelOption[]> {
  const resp = await request(CLAUDE_MODELS_URL, {
    headers: claudeModelsHeaders(acct.accessToken),
    timeoutMs: FETCH_TIMEOUT_MS,
    audit: auditOf(acct),
  });
  const body = await resp.text();
  if (resp.status !== 200) {
    throw new Error(`HTTP ${resp.status}${diagnose(resp.headers, body)}`);
  }
  return parseClaudeModels(JSON.parse(body));
}

async function fetchQoder(acct: Account, pat: string): Promise<ModelOption[]> {
  const resp = await request(QODER_MODELS_URL, {
    headers: { authorization: `Bearer ${pat}`, accept: 'application/json' },
    timeoutMs: FETCH_TIMEOUT_MS,
    audit: { accountId: acct.id, secrets: { accessToken: pat, accessTokenPlaceholder: GATEWAY_TOKEN_PLACEHOLDER } },
  });
  const body = await resp.text();
  if (resp.status !== 200) {
    throw new Error(`HTTP ${resp.status}${diagnose(resp.headers, body)}`);
  }
  return parseQoderModels(JSON.parse(body));
}

interface Entry {
  options: ModelOption[];
  fetchedAt: number;
}

const cache = new Map<Provider, Entry>();

export function clearCatalogCache(): void {
  cache.clear();
}

function fallbackOptions(provider: Provider): ModelOption[] {
  switch (provider) {
    case 'claude':
      return MODEL_OPTIONS.claude;
    case 'codex':
      return MODEL_OPTIONS.codex;
    case 'qoder':
      return [];
    default:
      return unexpectedProvider(provider);
  }
}

function unexpectedProvider(provider: never): never {
  throw new Error(`未知 provider: ${provider}`);
}

/**
 * 取某个 provider 的模型列表。account 为 null 表示这类账户一个都没有，
 * Claude/Codex 此时给内置清单；Qoder 则返回空列表，由调用方省略。
 */
export async function catalogFor(
  provider: Provider,
  account: Account | null,
  qoderPat = '',
  now = Date.now(),
): Promise<{ options: ModelOption[]; fromUpstream: boolean; error: string }> {
  const cached = cache.get(provider);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return { options: cached.options, fromUpstream: true, error: '' };
  }
  if (!account) return { options: fallbackOptions(provider), fromUpstream: false, error: '' };

  if (provider === 'qoder' && qoderPat === '') {
    return { options: [], fromUpstream: false, error: '未设置 Qoder PAT' };
  }

  try {
    let options: ModelOption[];
    switch (provider) {
      case 'claude':
        options = await fetchClaude(account);
        break;
      case 'codex':
        options = await fetchCodex(account);
        break;
      case 'qoder':
        options = await fetchQoder(account, qoderPat);
        break;
      default:
        return unexpectedProvider(provider);
    }
    if (options.length === 0) throw new Error('上游返回了空列表');
    cache.set(provider, { options, fetchedAt: now });
    return { options, fromUpstream: true, error: '' };
  } catch (err) {
    // 查不到不是致命问题：Claude/Codex 可退回内置清单，Qoder 则省略。
    return {
      options: fallbackOptions(provider),
      fromUpstream: false,
      error: String(err instanceof Error ? err.message : err),
    };
  }
}
