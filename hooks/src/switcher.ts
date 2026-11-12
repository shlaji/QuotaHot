import { existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { ACCOUNTS_DIR, loadConfig } from './config.js';
import { accountIdOf, emailOf, loadAccounts } from './account-files.js';
import { clientPath, readClientTokens, syncToClients } from './client-auth.js';
import { ensureFresh } from './credentials.js';
import type { NetworkConfig } from './network.js';
import { queryHookUsage } from './usage.js';
import { readState, STATE_PATH, waitForSwitchLock, withSwitchLock, writeState, type AccountMemo, type QuotaCheckOutcome, type QuotaCheckReceipt, type SwitchState } from './state.js';
import { readOmoIdentity, type OmoIdentity } from './omo-auth.js';
import type { Account, Provider, SyncResult, UsageResult, Window } from './types.js';

export { STATE_PATH };
export const DEFAULT_THRESHOLD = 80;
export const DEFAULT_CACHE_MS = 5 * 60_000;
export const DEFAULT_MIN_INTERVAL_MS = 60_000;
const FALLBACK_COOLDOWN_MS = 30 * 60_000;
export const CLIENTS: Readonly<Record<string, string>> = {
  'codex-cli': 'Codex CLI', opencode: 'OpenCode', 'claude-cli': 'Claude Code',
  'pi-claude': 'Pi Claude', 'pi-codex': 'Pi Codex', 'omo-agent': 'OmO Native',
};

export type AccountStatus = {
  readonly id: string;
  readonly email: string;
  readonly usable: boolean;
  readonly usedPercent: number | null;
  readonly resetAt: number;
  readonly source: 'cache' | 'live' | 'cooldown' | 'error' | 'skipped';
  readonly error: string;
};

export type UsageQuery = (account: Account, network: NetworkConfig) => Promise<UsageResult>;

export type SwitchOptions = {
  readonly provider: Provider;
  readonly clients: readonly string[];
  readonly triggerClient?: string;
  readonly reason: string;
  readonly exhausted: boolean;
  readonly recover: boolean;
  readonly threshold: number;
  readonly cacheMs: number;
  readonly minIntervalMs: number;
  readonly check: boolean;
  readonly dryRun: boolean;
  readonly usageQuery?: UsageQuery;
  readonly quotaCheckAfter?: number;
  readonly omoRequest?: OmoIdentity;
};

export type SwitchResult = {
  readonly switched: boolean;
  readonly lockContended?: true;
  readonly message: string;
  readonly reason: string;
  readonly from: string;
  readonly to: string;
  readonly written: readonly SyncResult[];
  readonly waitUntil: number;
  readonly checked: readonly AccountStatus[];
  readonly quotaCheck?: QuotaCheckReceipt;
};

export function exhaustionOf(windows: readonly Window[], threshold: number, nowMs: number): { readonly exhausted: boolean; readonly resetAt: number } {
  let resetAt = 0;
  for (const window of windows) {
    if (window.usedPercent !== null && window.usedPercent >= threshold && window.resetAt > nowMs) resetAt = Math.max(resetAt, window.resetAt);
  }
  return { exhausted: resetAt > 0, resetAt };
}

function result(message: string, reason: string, partial: Partial<SwitchResult> = {}): SwitchResult {
  return { switched: false, message, reason, from: '', to: '', written: [], waitUntil: 0, checked: [], ...partial };
}

function options(partial: Partial<SwitchOptions>): SwitchOptions {
  return {
    provider: 'codex', clients: [], reason: '手动触发', exhausted: false, recover: false,
    threshold: DEFAULT_THRESHOLD, cacheMs: DEFAULT_CACHE_MS,
    minIntervalMs: DEFAULT_MIN_INTERVAL_MS, check: true, dryRun: false,
    ...partial,
  };
}

function clientsOf(provider: Provider): readonly string[] {
  if (provider === 'codex') return ['codex-cli', 'opencode', 'pi-codex', 'omo-agent'];
  if (provider === 'claude') return ['claude-cli', 'pi-claude'];
  return [];
}

export async function currentAccount(source: string, accounts: readonly Account[]): Promise<Account | null> {
  const path = clientPath(source);
  if (!path) return null;
  const tokens = await readClientTokens(source, path);
  if (!tokens) return null;
  const id = tokens.accountId || accountIdOf(tokens.idToken || tokens.accessToken);
  if (source === 'omo-agent') {
    const email = tokens.email.toLowerCase();
    const sameId = accounts.filter((account) => account.accountId === id);
    const matches = email ? sameId.filter((account) => account.email.toLowerCase() === email)
      : sameId.length === 1 ? sameId : sameId.filter((account) => account.accessToken === tokens.accessToken);
    return matches.length === 1 ? matches[0] ?? null : null;
  }
  const byToken = accounts.find((account) => account.accessToken && account.accessToken === tokens.accessToken);
  if (byToken) return byToken;
  const byId = id ? accounts.find((account) => account.accountId === id) : undefined;
  if (byId) return byId;
  const email = (tokens.email || emailOf(tokens.idToken || tokens.accessToken)).toLowerCase();
  return email.includes('@') ? accounts.find((account) => account.email.toLowerCase() === email) ?? null : null;
}

function status(account: Account, memo: AccountMemo, source: AccountStatus['source']): AccountStatus {
  return { id: account.id, email: account.email, usable: memo.blockedUntil <= Date.now(), usedPercent: memo.usedPercent, resetAt: memo.resetAt, source, error: '' };
}

async function assess(account: Account, state: SwitchState, config: SwitchOptions, network: NetworkConfig): Promise<AccountStatus> {
  const now = Date.now();
  const memo = state.accounts[account.id];
  if (memo && memo.blockedUntil > now && config.cacheMs > 0) return status(account, memo, 'cooldown');
  if (!config.check) return memo ? status(account, memo, 'cache') : { id: account.id, email: account.email, usable: true, usedPercent: null, resetAt: 0, source: 'skipped', error: '' };
  if (memo && now - memo.checkedAt < config.cacheMs) return status(account, memo, 'cache');
  const fresh = config.dryRun ? account.expiresAt > now : await ensureFresh(account, network);
  if (!fresh) return { id: account.id, email: account.email, usable: false, usedPercent: memo?.usedPercent ?? null, resetAt: 0, source: 'error', error: config.dryRun ? '只读预览不能刷新过期或有效期未知的令牌' : '令牌已过期且续期失败' };
  const usage = await (config.usageQuery ?? queryHookUsage)(account, network);
  if (!usage.ok) return { id: account.id, email: account.email, usable: false, usedPercent: memo?.usedPercent ?? null, resetAt: 0, source: 'error', error: usage.error || `额度查询返回 HTTP ${usage.status}` };
  const threshold = exhaustionOf(usage.windows, config.threshold, now);
  const exhausted = usage.quotaAvailable === null ? threshold.exhausted : !usage.quotaAvailable;
  const latestReset = usage.windows.reduce((latest, window) => window.resetAt > now ? Math.max(latest, window.resetAt) : latest, 0);
  const resetAt = exhausted ? threshold.resetAt || latestReset || now + FALLBACK_COOLDOWN_MS : 0;
  const primary = usage.windows.find((window) => window.windowMinutes === null
    ? window.name === '5h' || window.name === 'primary'
    : window.windowMinutes >= 240 && window.windowMinutes <= 360);
  const known = usage.windows.flatMap((window) => window.usedPercent === null ? [] : [window.usedPercent]);
  const next = { usedPercent: primary?.usedPercent ?? (known.length > 0 ? Math.max(...known) : null), resetAt, checkedAt: now, blockedUntil: exhausted ? resetAt : 0 };
  state.accounts[account.id] = next;
  return { ...status(account, next, 'live'), usable: !exhausted };
}

export async function switchAccount(partial: Partial<SwitchOptions> = {}): Promise<SwitchResult> {
  const config = options(partial);
  if (config.triggerClient === 'opencode' && (config.provider === 'codex' || config.provider === 'claude') &&
      Number.isFinite(config.quotaCheckAfter)) {
    const receipt = (await readState()).lastQuotaCheck;
    if (receipt?.provider === config.provider && receipt.completedAt >= (config.quotaCheckAfter ?? Infinity)) {
      return result('复用最近一次额度查询结果', config.reason, {
        switched: receipt.switched, waitUntil: receipt.waitUntil, quotaCheck: receipt,
      });
    }
  }
  const appConfig = loadConfig();
  const network = { proxy: appConfig.proxy, noProxy: appConfig.noProxy };
  const recordCheck = !config.dryRun && config.check &&
    (config.triggerClient === 'opencode' || config.triggerClient === 'omo-agent'
      && config.omoRequest !== undefined && Number.isFinite(config.quotaCheckAfter)) &&
    (config.provider === 'codex' || config.provider === 'claude');
  const acquire = config.triggerClient === 'omo-agent' && config.omoRequest ? waitForSwitchLock : withSwitchLock;
  const locked = config.dryRun ? await switchLocked(config, network, appConfig.accountOrder) : await acquire(async () => {
    const result = await switchLocked(config, network, appConfig.accountOrder);
    if (!recordCheck || result.quotaCheck || config.triggerClient === 'omo-agent' && result.checked.length === 0) return result;
    const state = await readState();
    const outcome = quotaCheckOutcome(result, config.recover || config.triggerClient === 'omo-agent');
    const receipt: QuotaCheckReceipt = {
      provider: config.provider, completedAt: Date.now(), outcome,
      switched: result.switched, latestData: result.checked.some((account) => account.source === 'live'),
      waitUntil: result.waitUntil,
      ...(config.triggerClient === 'omo-agent' && config.omoRequest ? { omoRequest: config.omoRequest } : {}),
    };
    await writeState({ ...state, [config.triggerClient === 'omo-agent' ? 'lastOmoQuotaCheck' : 'lastQuotaCheck']: receipt });
    return result;
  });
  return locked ?? result('另一处正在切换账户，这次跳过', config.reason, { lockContended: true });
}

export function quotaCheckOutcome(result: SwitchResult, recover: boolean): QuotaCheckOutcome {
  if (result.switched) return 'switched';
  const writeFailed = result.written.some((write) => write.error);
  const networkFailed = result.checked.some((account) => account.error === 'usage_network_error' || account.error === 'usage_timeout');
  const checkFailed = result.checked.some((account) => account.source === 'error');
  if (recover && result.checked[0]?.usable) return 'available';
  return writeFailed ? 'check_failed' : networkFailed ? 'network_error' : checkFailed ? 'check_failed' : 'no_candidate';
}

export async function surveyAccounts(
  provider: Provider,
  config: Pick<SwitchOptions, 'threshold' | 'cacheMs' | 'check'>,
): Promise<{ readonly statuses: readonly AccountStatus[]; readonly active: Readonly<Record<string, string>> }> {
  const appConfig = loadConfig();
  const network = { proxy: appConfig.proxy, noProxy: appConfig.noProxy };
  const state = await readState();
  const originalMemos = { ...state.accounts };
  const pool = (await loadAccounts(ACCOUNTS_DIR)).filter((account) => account.provider === provider && !account.disabled);
  const statuses: AccountStatus[] = [];
  for (const account of pool) statuses.push(await assess(account, state, options(config), network));
  const active: Record<string, string> = {};
  for (const client of clientsOf(provider)) {
    const account = await currentAccount(client, pool);
    if (account) active[client] = account.email;
  }
  await withSwitchLock(async () => {
    const latest = await readState();
    for (const [id, memo] of Object.entries(state.accounts)) {
      if (memo !== originalMemos[id] && isDeepStrictEqual(latest.accounts[id], originalMemos[id])) {
        latest.accounts[id] = memo;
      }
    }
    await writeState(latest);
  });
  return { statuses, active };
}

async function switchLocked(config: SwitchOptions, network: NetworkConfig, accountOrder: Readonly<Record<string, readonly string[]>>): Promise<SwitchResult> {
  const state = await readState();
  const clients = config.clients.length > 0 ? config.clients : clientsOf(config.provider).filter((client) =>
    (!client.startsWith('pi-') && client !== 'omo-agent') || client === config.triggerClient || existsSync(clientPath(client)));
  if (clients.length === 0) return result(`${config.provider} 没有可切换的客户端`, config.reason);
  const trigger = config.triggerClient && clients.includes(config.triggerClient) ? config.triggerClient : clients[0];
  if (trigger === undefined) return result('没有可切换的客户端', config.reason);
  if (trigger === 'omo-agent' && !(await readClientTokens(trigger, clientPath(trigger)))) {
    return result('OmO 没有可管理的单账户 OAuth 凭证；多账户请使用 OmO 自带的切换', config.reason);
  }
  const pool = (await loadAccounts(ACCOUNTS_DIR)).filter((account) => account.provider === config.provider && !account.disabled);
  if (pool.length < (config.recover ? 1 : 2)) return result(`账户目录里只有 ${pool.length} 个可用的 ${config.provider} 账户，没有可切换的对象`, config.reason);
  const current = await currentAccount(trigger, pool);
  if (trigger === 'omo-agent' && config.omoRequest) {
    if (!current) return result('无法确认 OmO 当前账户', config.reason);
    const identity = await readOmoIdentity(clientPath(trigger));
    if (!identity) return result('OmO 凭证不可管理，未复用切换', config.reason);
    const request = config.omoRequest;
    if (!isDeepStrictEqual(identity, request)) {
      const previous = state.clients['omo-agent'];
      if (current && previous?.accountId === current.id && isDeepStrictEqual(previous.omoChange?.from, request)
          && isDeepStrictEqual(previous.omoChange?.to, identity)) {
        return result('复用另一会话完成的 OmO 账户切换', config.reason, { switched: true });
      }
      return result('OmO 凭证已变化，无法确认切换来源', config.reason);
    }
    const receipt = state.lastOmoQuotaCheck;
    if (receipt?.provider === config.provider && !receipt.switched && Number.isFinite(config.quotaCheckAfter)
        && receipt.completedAt >= (config.quotaCheckAfter ?? Infinity)
        && isDeepStrictEqual(receipt.omoRequest, request)) {
      return result('复用同一 OmO 请求账户的额度查询结果', config.reason, {
        waitUntil: receipt.waitUntil, quotaCheck: receipt,
      });
    }
  }
  const now = Date.now();
  const last = state.clients[trigger]?.switchedAt ?? 0;
  if (!config.dryRun && now - last < config.minIntervalMs) return result(`${Math.round((now - last) / 1000)} 秒前刚切换过，这次跳过`, config.reason, { from: current?.email ?? '' });
  const previousMemo = current ? state.accounts[current.id] : undefined;
  if (current && config.exhausted) {
    const resetAt = previousMemo?.resetAt && previousMemo.resetAt > now ? previousMemo.resetAt : now + FALLBACK_COOLDOWN_MS;
    state.accounts[current.id] = { usedPercent: previousMemo?.usedPercent ?? 100, resetAt, checkedAt: now, blockedUntil: resetAt };
  }
  const checked: AccountStatus[] = [];
  if (current) checked.push(config.exhausted ? status(current, state.accounts[current.id], 'live') : await assess(current, state, config, network));
  if (trigger === 'omo-agent' && config.omoRequest && checked[0]?.source === 'error') {
    return result('无法核实 OmO 当前账户额度', config.reason, { from: current?.email ?? '', checked });
  }
  if (current && checked[0]?.usable) {
    if (!config.dryRun) await writeState(state);
    return result(`${current.email} 仍有额度，不切换`, config.reason, { from: current.email, checked });
  }
  let waitUntil = checked[0]?.resetAt && checked[0].resetAt > now ? checked[0].resetAt : 0;
  const order = accountOrder[config.provider] ?? [];
  const ranks = new Map<string, number>();
  for (const id of order) if (!ranks.has(id)) ranks.set(id, ranks.size);
  const candidates = [...pool].sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity));
  for (const candidate of candidates) {
    if (candidate.id === current?.id) continue;
    const candidateStatus = await assess(candidate, state, config, network);
    checked.push(candidateStatus);
    if (!candidateStatus.usable) {
      if (candidateStatus.resetAt > now) waitUntil = waitUntil === 0 ? candidateStatus.resetAt : Math.min(waitUntil, candidateStatus.resetAt);
      continue;
    }
    if (config.dryRun) return result(`将切换到 ${candidate.email}，未写入任何文件`, config.reason, { from: current?.email ?? '', to: candidate.email, checked });
    if (!(await ensureFresh(candidate, network))) {
      checked[checked.length - 1] = { ...candidateStatus, usable: false, source: 'error', error: '令牌续期失败' };
      continue;
    }
    const omoBefore = clients.includes('omo-agent') ? await readOmoIdentity(clientPath('omo-agent')) : null;
    if (config.omoRequest && !isDeepStrictEqual(omoBefore, config.omoRequest)) {
      return result('额度查询期间 OmO 凭证已变化，未切换', config.reason, { checked });
    }
    const written = await syncToClients(candidate, clients, config.omoRequest);
    const omoAfter = omoBefore && written.some((entry) => entry.source === 'omo-agent' && !entry.error)
      ? await readOmoIdentity(clientPath('omo-agent')) : null;
    for (const write of written.filter((entry) => !entry.error)) state.clients[write.source] = {
      accountId: candidate.id, email: candidate.email, switchedAt: now,
      ...(write.source === 'omo-agent' && omoBefore && omoAfter && !isDeepStrictEqual(omoBefore, omoAfter)
        ? { omoChange: { from: omoBefore, to: omoAfter } } : {}),
    };
    await writeState(state);
    const triggerWrite = written.find((write) => write.source === trigger);
    if (!triggerWrite || triggerWrite.error) {
      checked[checked.length - 1] = { ...candidateStatus, usable: false, source: 'error', error: triggerWrite?.error || '触发客户端未写入' };
      return result(`写入触发客户端 ${CLIENTS[trigger] ?? trigger} 失败，未完成切换`, config.reason, { from: current?.email ?? '', written, checked });
    }
    return { switched: true, message: `已切换到 ${candidate.email}`, reason: config.reason, from: current?.email ?? '', to: candidate.email, written, waitUntil: 0, checked };
  }
  if (!config.dryRun) await writeState(state);
  return result(waitUntil > 0 ? `所有 ${config.provider} 账户都已用尽，最早 ${new Date(waitUntil).toLocaleString()} 恢复` : `没有找到可用的 ${config.provider} 账户`, config.reason, { from: current?.email ?? '', waitUntil, checked });
}
