/**
 * 刷新账户的额度信息，并把结果写回 store。
 *
 * 界面上的「查询额度」按钮和后台定时刷新走的都是这里，因此手动刷新和自动刷新会产出完全一致的
 * 状态；挑跟踪窗口也和调度器共用 nextSendWindow，三条写入路径（手动、后台、发送前后）记下的
 * 是同一个窗口。
 * 整个过程始终只读：不调模型、不消耗 token、也不会打开 5 小时窗口。
 */
import { ACCOUNTS_DIR } from './config.js';
import { isWithinDailyWindow, nextWindowOpen, parseDailyTime } from '../shared/schedule.js';
import { loadAccounts, ensureFresh, type Account } from './creds.js';
import { queryUsage } from './usage.js';
import { nextSendWindow } from './ratelimit.js';
import { selectAccounts } from './accounts-view.js';
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

/** 配置里那个每日时段，解析成零点后的分钟数。 */
function dailyWindow(cfg: AppConfig): { startMin: number; endMin: number } {
  return {
    startMin: parseDailyTime(cfg.dailyStart) ?? 0,
    endMin: parseDailyTime(cfg.dailyEnd) ?? 0,
  };
}

/**
 * 这一刻后台该不该刷。
 *
 * 周期为 0 是用户明说的“只在点按钮时查”。每日时段外则是另一回事：那段时间没有账户会发送，
 * 卡片上的数字也没人在看，整夜去打上游的额度接口只会给它自己的限流计数加数——而那个计数
 * 和发送共用，凌晨白加的每一笔，都可能让天亮后第一拍的窗口查询撞上 429。
 */
export function shouldRefreshUsage(cfg: AppConfig, now = Date.now()): boolean {
  if (cfg.usageRefreshMinutes <= 0) return false;
  const { startMin, endMin } = dailyWindow(cfg);
  return isWithinDailyWindow(now, startMin, endMin);
}

/**
 * 后台刷新下一轮隔多久醒。
 *
 * 时段内就是一个周期。时段外睡到开窗那一刻，省掉整夜的空转；但仍以一个周期封顶，好让时段
 * 被改宽时最迟下一轮就跟上，而不是傻等到按旧时段算出来的那个开窗时刻。周期为 0（只手动）
 * 时不必醒得勤，但也不能永不再醒——用户随时可能把它改回去，因此按 10 分钟回来看一眼。
 */
export function nextRefreshDelay(cfg: AppConfig, now = Date.now()): number {
  const period = Math.max(1, cfg.usageRefreshMinutes || 10) * 60_000;
  const { startMin, endMin } = dailyWindow(cfg);
  if (cfg.usageRefreshMinutes <= 0 || isWithinDailyWindow(now, startMin, endMin)) return period;
  return Math.max(1000, Math.min(period, nextWindowOpen(now, startMin, endMin) - now));
}

/** 按 ID 找账户再刷新；找不到时返回 null，由调用方给出 404。 */
export async function refreshAccountUsage(
  store: Store,
  accountId: string,
): Promise<UsageResult | null> {
  const account = (await loadAccounts(ACCOUNTS_DIR)).find((a) => a.id === accountId);
  return account ? refreshOne(store, account) : null;
}
