import type { AccountView, Window } from '../../shared/types.js';
import { amount, clock, countdown, day, daysUntil, percent, windowLabel } from '../format.js';

/** 来源标识到展示名的映射；未知来源原样展示。 */
const SOURCE_LABEL: Record<string, string> = {
  'cli-proxy-api': '导入自 cli-proxy-api',
  'codex-cli': '导入自 Codex CLI',
  'claude-cli': '导入自 Claude Code',
  'qoder-ide': '导入自 Qoder IDE',
  oauth: '本程序登录',
};

const STATE_LABEL: Record<AccountView['state'], string> = {
  idle: '就绪',
  waiting: '等待窗口',
  sending: '发送中',
  stopped: '已停止',
  error: '异常',
};

/*
  图标用内联 SVG，避免为这几个图标引入一整个图标库。
  统一 16 格画布、只描边不填充、同一线宽：几枚图标并排时粗细才对得齐。
*/
const ICON = {
  send: 'M14.5 1.5 1.8 6.1l5.3 2.7 2.6 5.4 4.8-12.7ZM14.5 1.5 7.1 8.8',
  usage: 'M8 2.2a5.8 5.8 0 1 0 5.8 5.8H8Z',
  log: 'M3.2 2h6.3L13 5.5V14H3.2V2ZM9.4 2v3.6H13M5.6 8.6h4.8M5.6 11.1h4.8',
  refresh: 'M2.6 8a5.4 5.4 0 0 1 9.3-3.8M13.4 8a5.4 5.4 0 0 1-9.3 3.8M12.4 1.7v3h-3M3.6 14.3v-3h3',
  sync: 'M8 2.2v7.4M5.2 6.8 8 9.6l2.8-2.8M2.8 12v1.1a.9.9 0 0 0 .9.9h8.6a.9.9 0 0 0 .9-.9V12',
  remove: 'M2.8 4.3h10.4M6.1 4.3V3a1 1 0 0 1 1-1h1.8a1 1 0 0 1 1 1v1.3M4.4 4.3l.6 9.1a1 1 0 0 0 1 .9h4a1 1 0 0 0 1-.9l.6-9.1',
  swap: 'M2.5 5.5h11M10.8 2.8 13.5 5.5l-2.7 2.7M13.5 10.5h-11M5.2 7.8 2.5 10.5l2.7 2.7',
} as const;

function Icon({ name, size = 14 }: { name: keyof typeof ICON; size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={ICON[name]} />
    </svg>
  );
}

/** 按窗口长度从短到长排序，让 5 小时窗口排在周窗口前面。 */
function byLength(a: Window, b: Window): number {
  return (a.windowMinutes ?? Number.MAX_SAFE_INTEGER) - (b.windowMinutes ?? Number.MAX_SAFE_INTEGER);
}

function UsageRow({ window: w, now }: { window: Window; now: number }) {
  const used = w.usedPercent ?? 0;
  // Qoder 这类按 credits 计费的上游会报绝对数量；只给百分比看不出还剩多少可用
  const quantity =
    w.used === undefined && w.total === undefined
      ? ''
      : `${w.used === undefined ? '?' : amount(w.used)} / ${
          w.total === undefined ? '?' : amount(w.total)
        }${w.unit ? ` ${w.unit}` : ''}`;
  return (
    <div className="usage-row">
      <div className="usage-row-head">
        <span className="usage-name">{windowLabel(w.name)}</span>
        <span
          className={`usage-pct ${used >= 90 ? 'danger' : used >= 70 ? 'warn' : ''}`}
          title="上游报的是已用比例，不是剩余"
        >
          {w.usedPercent === null ? '用量未知' : `已用 ${percent(w.usedPercent)}`}
        </span>
      </div>
      <div className="usage-bar">
        <div
          className={`usage-fill ${used >= 90 ? 'danger' : used >= 70 ? 'warn' : ''}`}
          style={{ width: `${Math.min(100, Math.max(0, used))}%` }}
        />
      </div>
      <span className="usage-text">
        {[
          quantity,
          // resetAt 为 0 表示这一档根本不会自己重置（例如 Qoder 的加油包），
          // 此时显示倒计时只会误导人
          w.resetAt > 0 ? `${countdown(w.resetAt, now)} 后重置 · ${clock(w.resetAt)}` : '无重置窗口',
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
    </div>
  );
}

interface Props {
  account: AccountView;
  now: number;
  busy: boolean;
  onSendNow: (id: string) => void;
  onRemove: (id: string) => void;
  onRequests: (id: string) => void;
  onUsage: (id: string) => void;
  /** 这张卡片的额度正在查询中。 */
  checking: boolean;
  /** 是否被勾选进顶部动作条的批量操作。 */
  selected: boolean;
  onSelectChange: (id: string, selected: boolean) => void;
  /** 切换续期方式；autoRefresh 是切换之后要生效的那个模式。 */
  onAutoRefreshChange: (id: string, autoRefresh: boolean) => void;
  /** 无条件换一份新 token；只有自动刷新模式的账户会看到这个入口。 */
  onForceRefresh: (id: string) => void;
  /** 把当前 token 写回原客户端的配置文件。 */
  onSyncToClient: (id: string) => void;
  /** 这张卡片正在更新 token。 */
  refreshing: boolean;
  /** 这张卡片正在写回客户端配置文件。 */
  syncing: boolean;
  /** 这张卡片正在切换续期方式。 */
  switching: boolean;
}

export function AccountCard({
  account: a,
  now,
  busy,
  onSendNow,
  onRemove,
  onRequests,
  onUsage,
  checking,
  selected,
  onSelectChange,
  onAutoRefreshChange,
  onForceRefresh,
  onSyncToClient,
  refreshing,
  syncing,
  switching,
}: Props) {
  // 如果还没做过额度查询，就退回到单个已跟踪窗口的信息
  const windows =
    a.windows.length > 0
      ? [...a.windows].sort(byLength)
      : a.windowResetAt !== null
        ? [
            {
              name: '5h',
              resetAt: a.windowResetAt,
              usedPercent: a.usedPercent,
              windowMinutes: 300,
              source: a.windowSource,
            },
          ]
        : [];
  const subDays = daysUntil(a.subscriptionEndsAt, now);
  // Qoder 没有会自己重置的窗口，保活对它毫无意义，因此它不进调度器，
  // 与“发送”有关的按钮和字段对它都不成立
  const schedulable = a.provider !== 'qoder';
  /*
    Qoder 没有 refresh 端点（creds.ensureFresh 对它一律回 IDE 的库里重读），IDE 也不往库里
    写到期时间，令牌本身又不是 JWT——它的 expiresAt 常年为 0。于是“续期方式”和
    “Token 有效期”这两处对它都填不出真东西：一个只剩单向的切换按钮，一个永远显示“—”。
    与其摆着误导人，不如整块不出现；要把本程序登录的账户接到 IDE 上，走账户弹窗里的
    「从 Qoder IDE 导入」，那条路本来就会重新核对身份。
  */
  const renewable = a.provider !== 'qoder';

  /*
    续期方式只用一个按钮表达：按钮上写的是此刻用的哪一种，点它就换另一种。
    切换要不要放行由服务端说了算——它会先核对本机那个客户端现在登录的还是不是这个账户。
  */
  const forceRefreshable = a.autoRefresh && renewable;
  const modeLabel = a.autoRefresh ? '自动刷新' : '跟随客户端';
  const modeTitle = a.autoRefresh
    ? '当前由本程序刷新 token。点一下改为跟随客户端：先核对本机客户端登录的还是不是这个账户，一致才切，之后只同步不刷新'
    : `当前跟随 ${a.syncPath || '原客户端'} 续期。点一下改为由本程序刷新：会用 refresh_token 换新 token，可能把原客户端手里那份顶掉`;

  return (
    <article className={`card state-${a.state}${selected ? ' selected' : ''}`}>
      <header className="card-head">
        <input
          type="checkbox"
          className="card-check"
          checked={selected}
          onChange={(e) => onSelectChange(a.id, e.target.checked)}
          aria-label={`选择 ${a.email}`}
          title="勾选后可用顶部的批量按钮一起操作"
        />
        <div>
          {/*
            provider 不在这里出现：卡片已经按 provider 分组，组头说过一遍了，
            每张卡再重复一次，一组里就是同一枚徽章连着抄好几遍。
          */}
          {(a.plan || renewable) && (
            <div className="card-tags">
              {a.plan && <span className="badge plan">{a.plan}</span>}
              {/*
                续期方式是账户的状态，不是一次动作，所以跟 plan 徽章站在一起。
                但它旁边就是一枚纯展示的标签，光有边框还是会被当成标签看，
                所以补一枚 ⇄：图标说明这里能换一种模式，不是在陈述事实。
              */}
              {renewable && (
                <button
                  className={`mode ${a.autoRefresh ? 'auto' : 'follow'}`}
                  disabled={busy || switching}
                  title={modeTitle}
                  onClick={() => onAutoRefreshChange(a.id, !a.autoRefresh)}
                >
                  <Icon name="swap" size={11} />
                  {switching ? '核对中…' : modeLabel}
                </button>
              )}
            </div>
          )}
          <h3 title={[a.email, a.userId && `用户 ID: ${a.userId}`].filter(Boolean).join('\n')}>
            {a.email}
          </h3>
          {(a.loginMethod || a.source) && (
            <span className="card-sub">
              {[a.loginMethod && `使用 ${a.loginMethod} 登录`, SOURCE_LABEL[a.source] ?? a.source]
                .filter(Boolean)
                .join(' · ')}
            </span>
          )}
        </div>
        <span className={`state-dot state-${a.state}`} title={STATE_LABEL[a.state]}>
          {STATE_LABEL[a.state]}
        </span>
      </header>

      <div className="usage">
        {windows.length === 0 ? (
          <span className="usage-text">用量未知，点「查看额度」拉一次</span>
        ) : (
          windows.map((w) => <UsageRow key={w.name} window={w} now={now} />)
        )}
      </div>

      {a.subscriptionEndsAt !== null && (
        <p className="subscription">
          订阅有效期 <strong>{subDays !== null && subDays > 0 ? `${subDays} 天` : '已到期'}</strong>
          <span>{day(a.subscriptionEndsAt)}</span>
        </p>
      )}

      {/* 下次/上次发送不在这里：那是调度的节奏，不是账户的属性，都在「调度任务」页 */}
      <dl className="facts">
        {renewable && (
          <div>
            <dt>Token 有效期</dt>
            <dd>
              <strong>{countdown(a.tokenExpiresAt, now)}</strong>
              {/*
                这里只说这份令牌怎么续，不掺发送的战绩：连续失败数来自保活/测试文本，
                跟令牌好不好使是两回事，摆在这一格里会让人以为是刷新在失败。它在「调度任务」页。
              */}
              <small>{a.autoRefresh ? '到期前自动刷新' : '到期前从客户端同步'}</small>
            </dd>
          </div>
        )}
        <div>
          <dt>额度快照</dt>
          <dd>
            <strong>{a.usageCheckedAt ? clock(a.usageCheckedAt) : '未查询'}</strong>
            <small>
              {!schedulable
                ? '按订阅周期发放，只读展示'
                : a.resetCredits === null
                ? '无重置次数信息'
                : `可用重置次数 ${a.resetCredits}${
                    // 重置次数是会过期的，只报总数会让人误以为它一直都在
                    a.resetCreditsExpiresAt === null
                      ? ''
                      : `（最近一张 ${countdown(a.resetCreditsExpiresAt, now)}后过期）`
                  }`}
            </small>
          </dd>
        </div>
      </dl>

      {a.lastError && <p className="card-error" title={a.lastError}>{a.lastError}</p>}

      {/*
        底部按钮都用同一族 .act：同样的高度、字号和图标尺寸，只靠颜色分层——
        测试文本是唯一会真发请求的动作，用主色；其余常规动作用中性色；
        只读的请求日志和危险的移除压成图标。

        分行是写死的，不是让它们自己折：这一排的按钮会随续期方式增减，
        交给 flex 折行的话，一开自动刷新，「更新 token」挤进来就把同步账户顶到下一行、
        把角落那两枚图标也带着走一遍——每切一次模式，整排按钮就重新洗一次牌。
        现在第一行固定是「拿这个账户做事」，第二行固定是「管这个账户的令牌」，
        图标又单占一列，所以切模式只会让「更新 token」在第二行末尾出现或消失，别的都不动。
      */}
      <footer className="card-acts">
        <div className="act-rows">
          <div className="act-row">
            {schedulable && (
              <button
                className="act key"
                disabled={busy}
                title="用当前配置的发送文本和模型真发一次，会打开 5 小时窗口"
                onClick={() => onSendNow(a.id)}
              >
                <Icon name="send" />
                {busy ? '发送中…' : '测试文本'}
              </button>
            )}
            <button
              className="act"
              disabled={checking}
              title="只查这个账户的额度，只读，不消耗配额"
              onClick={() => onUsage(a.id)}
            >
              <Icon name="usage" />
              {checking ? '查询中…' : '查看额度'}
            </button>
          </div>
          {(a.syncTargets.length > 0 || forceRefreshable) && (
            <div className="act-row">
              {a.syncTargets.length > 0 && (
                <button
                  className="act"
                  disabled={syncing}
                  title={`把当前 token 写回 ${a.syncTargets.join('、')}，覆盖前会先备份，改了哪些内容会记进日志`}
                  onClick={() => onSyncToClient(a.id)}
                >
                  <Icon name="sync" />
                  {syncing ? '同步中…' : '同步账户'}
                </button>
              )}
              {/*
                强制刷新只对自动刷新的账户成立：跟随客户端的账户在这里换了令牌，
                原客户端手里那份立刻作废，用户下次打开它就得重新登录。
                它排在同步账户后面，出现和消失都只动这一行的尾巴。
              */}
              {forceRefreshable && (
                <button
                  className="act"
                  disabled={refreshing}
                  title="立刻用 refresh_token 换一份新 token，不等到期。请求过程可在「请求日志」里看到"
                  onClick={() => onForceRefresh(a.id)}
                >
                  <Icon name="refresh" />
                  {refreshing ? '刷新中…' : '更新 token'}
                </button>
              )}
            </div>
          )}
        </div>
        <div className="act-icons">
          <button
            className="act only-icon"
            title="查看这个账户最近真实发出的上游请求，可复制成 curl"
            onClick={() => onRequests(a.id)}
          >
            <Icon name="log" />
            <span className="sr-only">请求日志</span>
          </button>
          <button
            className="act only-icon danger"
            disabled={busy}
            title="移除账户：只从本程序的账户目录里删除，不影响原始凭证"
            onClick={() => onRemove(a.id)}
          >
            <Icon name="remove" />
            <span className="sr-only">移除</span>
          </button>
        </div>
      </footer>
    </article>
  );
}
