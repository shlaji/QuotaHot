import { selectAccounts } from './accounts-view.js';
import { loadAccounts } from './creds.js';
import { refreshOne } from './refresh.js';
import type { Store } from './store.js';
import type { AppConfig, UsageResult } from '../shared/types.js';

export function hasTaskQuota(result: UsageResult, model: string, now: number): boolean {
  if (!result.ok || result.quotaAvailable === false) return false;
  const windows = result.windows.filter((window) => {
    const name = window.name.toLowerCase();
    if (name.includes('overage') || /_oi$/.test(name)) return false;
    const family = /_(opus|sonnet)$/.exec(name)?.[1];
    return !family || model.toLowerCase().includes(family);
  });
  const current = windows.filter((window) => window.resetAt === 0 || window.resetAt > now);
  const known = current.filter((window) => window.usedPercent !== null
    && Number.isFinite(window.usedPercent) && window.usedPercent >= 0);
  if (result.provider === 'qoder') {
    return known.some((window) => (window.usedPercent ?? 100) < 99 && (window.total === undefined || window.total > 0));
  }
  if (known.some((window) => (window.usedPercent ?? 0) >= 99)) return false;
  if (result.quotaAvailable === true) return true;
  return current.length > 0 && known.length === current.length;
}

export function taskQuotaSource(deps: {
  readonly store: Store;
  readonly accountsDir: string;
  readonly config: () => AppConfig;
}): () => Promise<UsageResult[]> {
  return async () => {
    const accounts = selectAccounts(await loadAccounts(deps.accountsDir), deps.config());
    const results = await Promise.all(accounts.map(async (account) => {
      try {
        return await refreshOne(deps.store, account);
      } catch (error) {
        console.error('Task quota query failed:', account.id, error instanceof Error ? error.message : String(error));
        return null;
      }
    }));
    return results.filter((result): result is UsageResult => result !== null);
  };
}
