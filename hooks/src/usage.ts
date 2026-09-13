import { fetch } from 'undici';
import { claudeHeaders, codexHeaders } from './headers.js';
import { dispatcherFor, proxyError, type NetworkConfig } from './network.js';
import { epochMs, findKey, mergeWindows, parseCodexUsage, parseHeaders } from './rate-limit.js';
import type { Account, UsageResult, Window } from './types.js';

const CODEX_URLS = ['https://chatgpt.com/backend-api/wham/usage', 'https://chatgpt.com/backend-api/api/codex/usage'] as const;
const CLAUDE_URL = 'https://api.anthropic.com/api/oauth/usage';

function base(account: Account): UsageResult {
  return {
    accountId: account.id, provider: account.provider, email: account.email,
    ok: false, status: 0, error: '', plan: account.plan,
    subscriptionEndsAt: account.subscriptionEndsAt || null, userId: account.userId,
    quotaAvailable: null, windows: [], endpoint: '',
  };
}

function claudeWindows(payload: unknown, nowMs: number): Window[] {
  const wrapped = findKey(payload, 'rate_limits');
  const limits = wrapped !== null && typeof wrapped === 'object' && !Array.isArray(wrapped) ? wrapped : payload;
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) return [];
  const windows: Window[] = [];
  for (const [name, node] of Object.entries(limits as Record<string, unknown>)) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) continue;
    const record = node as Record<string, unknown>;
    const resetAt = epochMs(String(record.resets_at ?? record.reset_at ?? ''), nowMs);
    const usedPercent = Number(record.utilization ?? record.used_percent ?? record.used_percentage ?? record.percent);
    if (resetAt === null) continue;
    windows.push({
      name: name === 'five_hour' ? '5h' : name, resetAt,
      usedPercent: Number.isFinite(usedPercent) ? usedPercent : null,
      windowMinutes: name === 'five_hour' ? 300 : name.startsWith('seven_day') ? 10080 : null,
      source: `usage:${name}`,
    });
  }
  return windows;
}

function quotaAvailable(payload: unknown): boolean | null {
  const node = findKey(payload, 'rate_limit');
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return null;
  const record = node as Record<string, unknown>;
  if (record.allowed === false || record.limit_reached === true) return false;
  if (record.allowed === true || record.limit_reached === false) return true;
  return null;
}

export async function queryHookUsage(account: Account, network: NetworkConfig): Promise<UsageResult> {
  const initial = base(account);
  if (proxyError(network.proxy)) return { ...initial, error: 'invalid_proxy' };
  if (account.provider === 'qoder') return { ...initial, error: 'unsupported_provider' };
  const urls = account.provider === 'codex' ? CODEX_URLS : [CLAUDE_URL];
  const signal = AbortSignal.timeout(15_000);
  const dispatcher = dispatcherFor(urls[0], network);
  try {
    for (const url of urls) {
      const response = await fetch(url, {
        headers: account.provider === 'codex' ? codexHeaders(account.accessToken, account.accountId) : claudeHeaders(account.accessToken),
        dispatcher, signal, redirect: 'error',
      });
      const body = await response.text();
      const result = { ...initial, status: response.status, endpoint: url };
      if (account.provider === 'codex' && (response.status === 404 || response.status === 405 || (response.status === 403 && /^\s*</.test(body)))) continue;
      if (response.status !== 200) return { ...result, error: `usage_http_${response.status}` };
      const payload: unknown = JSON.parse(body);
      const now = Date.now();
      const windows = account.provider === 'codex'
        ? mergeWindows(parseCodexUsage(payload, now), parseHeaders(response.headers, now))
        : claudeWindows(payload, now);
      const available = account.provider === 'codex' ? quotaAvailable(payload) : null;
      if (available === null && windows.length === 0) return { ...result, error: 'missing_quota_data' };
      return { ...result, ok: true, quotaAvailable: available, windows };
    }
    return { ...initial, error: 'usage_endpoint_unavailable' };
  } catch (error) {
    return { ...initial, error: error instanceof SyntaxError ? 'invalid_usage_json' : signal.aborted ? 'usage_timeout' : 'usage_network_error' };
  } finally {
    await dispatcher.destroy();
  }
}
