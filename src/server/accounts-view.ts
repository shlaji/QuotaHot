/**
 * 账户的挑选与展示。
 *
 * 这两件事都不属于调度循环，只是恰好被它用到：调度器要知道该给哪些账户起 worker，
 * 界面要一份把磁盘凭证、库里状态和运行时状态并在一起的列表。放在调度器里的代价是
 * refresh.ts 为了一个 selectAccounts 就得反过来 import 整个 scheduler——那条依赖
 * 方向是错的，只读的额度刷新不该认识调度循环。
 */
import { syncTargetsOfMany } from './clientsync.js';
import { clientsUsing, lastCheckedAt } from './inuse.js';
import type { Account } from './creds.js';
import type { AccountState } from './store.js';
import type { AccountView, AppConfig } from '../shared/types.js';
import type { GatewayAccountView } from '../shared/gateway.js';

/**
 * 参与调度与保活发送的账户。
 *
 * 在 selectAccounts 之上再去掉 Qoder：它按订阅周期发放 credits，没有会自己重置的
 * 窗口，保活发一条只是纯消耗。这类账户仍然出现在界面和额度查询里。
 */
export function selectSchedulable(accounts: Account[], cfg: AppConfig): Account[] {
  return selectAccounts(accounts, cfg).filter((a) => a.provider !== 'qoder');
}

export function selectAccounts(accounts: Account[], cfg: AppConfig): Account[] {
  return accounts.filter((a) => {
    if (a.disabled) return false;
    if (cfg.include.length > 0 && !cfg.include.some((k) => a.email.includes(k))) return false;
    if (cfg.exclude.some((k) => a.email.includes(k))) return false;
    return true;
  });
}

/** 某个账户此刻在调度器里的运行时状态；没被纳入本轮调度时为 null。 */
export interface RunInfo {
  state: AccountView['state'];
  lastError: string;
}

/**
 * 组装面向前端的账户视图，把磁盘凭证、库里状态与运行时状态合并起来。
 *
 * 运行时状态由调用方按账户 id 查出来，而不是把整个 Scheduler 传进来：这里要拼的是
 * 一份 JSON，没有理由认识 worker、AbortSignal 或者那条循环。
 */
export async function buildAccountViews(
  accounts: readonly Account[],
  states: Map<string, AccountState>,
  runInfoOf: (accountId: string) => RunInfo | null,
  gatewayOf: (account: Account, state: AccountState | undefined) => GatewayAccountView,
): Promise<AccountView[]> {
  const targets = await syncTargetsOfMany(accounts);
  return accounts.map((a) => {
    const st = states.get(a.id);
    const run = runInfoOf(a.id);
    return {
      id: a.id,
      provider: a.provider,
      email: a.email,
      disabled: a.disabled,
      // 额度查询结果通常比 token 自带声明更新，因此优先采用它
      plan: st?.plan || a.plan,
      subscriptionEndsAt: st?.subscriptionEndsAt || a.subscriptionEndsAt || null,
      userId: a.userId,
      loginMethod: a.loginMethod,
      tokenExpiresAt: a.expiresAt,
      windowResetAt: st && st.lastResetAt > 0 ? st.lastResetAt : null,
      nextDueAt: st && st.nextDueAt > 0 ? st.nextDueAt : null,
      lastSentAt: st && st.lastSentAt > 0 ? st.lastSentAt : null,
      usedPercent: st?.usedPercent ?? null,
      windowSource: st?.lastSource ?? '',
      windows: st?.windows ?? [],
      usageCheckedAt: st && st.usageCheckedAt > 0 ? st.usageCheckedAt : null,
      resetCredits: st?.resetCredits ?? null,
      resetCreditsExpiresAt: st?.resetCreditsExpiresAt ?? null,
      source: a.source,
      autoRefresh: a.autoRefresh,
      syncPath: a.syncPath,
      // 界面上要先告诉用户这次会写哪些文件，才谈得上让他决定点不点
      syncTargets: (targets.get(a.id) ?? []).map((t) => t.path),
      // 读的是内存里那份核对结果，不在这条热路径上再去翻一遍客户端的凭证文件
      inUseBy: clientsUsing(a.id),
      inUseCheckedAt: lastCheckedAt(),
      consecutiveFailures: st?.consecutiveFailures ?? 0,
      // 没进本次调度的账户（没被勾中，或者本来就是 Qoder）不在跑，即使调度器开着
      state: run?.state ?? 'stopped',
      lastError: run?.lastError ?? st?.lastError ?? '',
      gateway: gatewayOf(a, st),
    };
  });
}
