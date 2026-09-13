/**
 * 刷新账户的额度信息，并把结果写回 store。
 *
 * 这段逻辑同时被 /api/usage 按钮和后台定时器复用，因此手动刷新和自动刷新会产出完全一致的状态；
 * 挑跟踪窗口也和调度器共用 nextSendWindow，三条写入路径（手动、后台、发送后）记下的是同一个窗口。
 * 整个过程始终只读：不调模型、不消耗 token、也不会打开 5 小时窗口。
 */
import { ACCOUNTS_DIR } from './config.js';
import { loadAccounts, ensureFresh, type Account } from './creds.js';
import { queryUsage } from './usage.js';
import { nextSendWindow } from './ratelimit.js';
import { selectAccounts } from './scheduler.js';
import type { Store } from './store.js';
import type { AppConfig, UsageResult } from '../shared/types.js';

function unavailable(acct: Account, error: string): UsageResult {
  return {
    accountId: acct.id,
    provider: acct.provider,
    email: acct.email,
    ok: false,
    status: 0,
    error,
    plan: acct.plan,
    subscriptionEndsAt: acct.subscriptionEndsAt || null,
    userId: acct.userId,
    resetCredits: null,
    resetCreditsExpiresAt: null,
    orgType: '',
    quotaAvailable: null,
    windows: [],
    endpoint: '',
    raw: '',
  };
}

/** 刷新单个账户；卡片上的按钮和整体刷新走的是同一条路径。 */
export async function refreshOne(
  store: Store,
  account: Account,
): Promise<UsageResult> {
  if (!(await ensureFresh(account, () => {}))) return unavailable(account, 'token 不可用');

  const r = await queryUsage(account);
  // 查询失败时不能把上一次成功记录下来的数据清空
  if (r.ok) {
    const checkedAt = Date.now();
    store.recordUsage(
      account.id,
      {
        windows: r.windows,
        plan: r.plan,
        subscriptionEndsAt: r.subscriptionEndsAt,
        resetCredits: r.resetCredits,
        resetCreditsExpiresAt: r.resetCreditsExpiresAt,
        checkedAt,
      },
      // 跟踪哪个窗口，必须和调度器排下一拍用的是同一个判断：否则卡片上写着一个重置
      // 时刻，调度器却在等另一个。nextSendWindow 顺带会滤掉已经到点的窗口，返回 null
      // 时 recordUsage 保留上一次的记录，不会把一个过去的时刻当成当前窗口写进库。
      nextSendWindow(r.windows, checkedAt),
    );
  }
  return r;
}

/**
 * 刷新额度。
 * `accountIds` 为空表示“全部账户”；给了就只刷这几个，界面上的勾选走的就是这条路。
 */
export async function refreshUsage(
  store: Store,
  cfg: AppConfig,
  accountIds?: string[],
): Promise<UsageResult[]> {
  const wanted = accountIds && accountIds.length > 0 ? new Set(accountIds) : null;
  const accounts = selectAccounts(await loadAccounts(ACCOUNTS_DIR), cfg).filter(
    (a) => wanted === null || wanted.has(a.id),
  );
  const results: UsageResult[] = [];
  for (const account of accounts) results.push(await refreshOne(store, account));
  return results;
}

/** 按 ID 找账户再刷新；找不到时返回 null，由调用方给出 404。 */
export async function refreshAccountUsage(
  store: Store,
  accountId: string,
): Promise<UsageResult | null> {
  const account = (await loadAccounts(ACCOUNTS_DIR)).find((a) => a.id === accountId);
  return account ? refreshOne(store, account) : null;
}
