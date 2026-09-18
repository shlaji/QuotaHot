import { useState } from 'react';
import type { AccountView, Window } from '../../shared/types.js';
import type { GatewayAccountState } from '../../shared/gateway.js';
import { amount, clock, countdown, day, daysUntil, percent, windowLabel } from '../format.js';
import { maskEmail } from '../account-email.js';
import { QoderSwitchDialog } from './QoderSwitchDialog.js';

/** 来源标识到展示名的映射；未知来源原样展示。 */
const SOURCE_LABEL: Record<string, string> = {
  'cli-proxy-api': '导入自 cli-proxy-api',
  'codex-cli': '导入自 Codex CLI',
  'claude-cli': '导入自 Claude Code',
  'qoder-cli': '导入自 Qoder CLI',
  'qoder-desktop': '导入自 Qoder Desktop',
  'qoder-ide': '导入自 Qoder IDE',
  oauth: '本程序登录',
};

/**
 * 账户在 API 服务里的状态。
 *
 * 和上面那份保活状态各说各的：一个账户完全可能「保活已停止」却正在替 API 服务干活，
 * 反过来也一样。两块状态在卡片上分处两处，就是为了不让人把它们当成同一件事。
 */
const GATEWAY_STATE: Record<GatewayAccountState, { label: string; hint: string }> = {
  off: { label: '未参与', hint: '这个账户的额度不会被 API 服务用掉' },
  ready: { label: '待命', hint: '随时可以接转发请求' },
  busy: { label: '转发中', hint: '正在处理转发请求（仍然可以再接新的）' },
  cooling: { label: '冷却中', hint: '连续失败太多，暂时不派活；可以点「立刻归队」提前结束' },
  exhausted: { label: '额度用尽', hint: '已用额度过了设定的阈值，剩下的留给你自己的客户端' },
  unusable: { label: '不可用', hint: '账户被禁用，或这家上游不支持转发' },
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
  route: 'M3.4 12.6h2.2a3 3 0 0 0 3-3v-3.2a3 3 0 0 1 3-3h1.4M3.4 10.9a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4ZM11.5 1.7 13.9 3.4l-2.4 1.7',
  eye: 'M1.7 8s2.3-3.5 6.3-3.5S14.3 8 14.3 8s-2.3 3.5-6.3 3.5S1.7 8 1.7 8ZM8 9.6A1.6 1.6 0 1 0 8 6.4a1.6 1.6 0 0 0 0 3.2Z',
  eyeOff: 'M2 2.2 14 13.8M6.1 5A7.4 7.4 0 0 1 8 4.5c4 0 6.3 3.5 6.3 3.5a12 12 0 0 1-2.1 2.4M4.1 4.9C2.6 6 1.7 8 1.7 8s2.3 3.5 6.3 3.5c.8 0 1.5-.1 2.1-.4',
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

/**
 * Qoder 账户的 PAT 那一行。
 *
 * PAT 和导入登录的令牌是两回事:它在 Qoder 账户页面单独申请,专供 API 转发。没有它,这个账户
 * 在 API 服务里恒为「不可用」,所以这一行只在 Qoder 卡片上出现,且贴在 API 服务开关下面——
 * 用户点开开关却发现不可用时,眼睛往下一挪就能看到该填什么。
 *
 * 输入框平时收起,只显示「已设置 / 未设置」;要改才点开。保存时服务端会真拿它去换一次令牌校验,
 * 所以这里的 saving 可能要转个一两秒。
 */
function QoderPatRow({
  id,
  hasPat,
  pending,
  onSetPat,
}: {
  id: string;
  hasPat: boolean;
  pending: boolean;
  onSetPat: (id: string, pat: string) => void;
}) {
  const [editing, setEditing] = useState(!hasPat);
  const [value, setValue] = useState('');

  const submit = () => {
    const pat = value.trim();
    if (pat === '') return;
    onSetPat(id, pat);
    setValue('');
    setEditing(false);
  };

  return (
    <div className="gateway-pat">
      <div className="gateway-pat-head">
        <span className={`gateway-pat-state ${hasPat ? 'set' : 'unset'}`} title="PAT 在 Qoder 账户页面单独申请，专供 API 转发用">
          {hasPat ? '已设置 PAT' : '未设置 PAT'}
        </span>
        <div className="spacer" />
        {hasPat && !editing && (
          <button className="link" disabled={pending} onClick={() => setEditing(true)}>
            更换
          </button>
        )}
        {hasPat && (
          <button
            className="link danger"
            disabled={pending}
            title="清除后这个账户在 API 服务里会变回不可用"
            onClick={() => {
              setValue('');
              setEditing(false);
              onSetPat(id, '');
            }}
          >
            清除
          </button>
        )}
      </div>
      {editing && (
        <div className="gateway-pat-edit">
          <input
            type="password"
            className="gateway-pat-input"
            placeholder="pt-… 粘贴 Qoder 账户页面的 PAT"
            value={value}
            disabled={pending}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
          <button className="act key" disabled={pending || value.trim() === ''} onClick={submit}>
            {pending ? '校验中…' : '保存并校验'}
          </button>
          {hasPat && (
            <button className="link" disabled={pending} onClick={() => { setValue(''); setEditing(false); }}>
              取消
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 卡片上的「API 服务」那一块：这个账户的额度给不给转发用。
 *
 * 放在额度条下面，是因为它说的正是同一件事的另一面——上面那几条讲这个账户还剩多少，
 * 这里讲这些额度愿不愿意分给 API 服务。两块贴在一起，用户才不必在卡片和设置页之间来回对。
 *
 * 整块只在 supported 的 provider 上出现（见 a.gateway.supported）；不支持转发的上游摆一个
 * 永远点不动的开关，比不摆更让人费解。Qoder 支持转发，但它靠账户页面单独申请的 PAT，
 * 所以开关下面多一行 PAT 设置（见 QoderPatRow）。
 */
function GatewayBlock({
  account: a,
  now,
  serviceOn,
  pending,
  onChange,
  onReset,
  patPending,
  onSetPat,
}: {
  account: AccountView;
  now: number;
  /** API 服务的全局开关。关着时这里的设置照样能改，只是暂时不会有请求进来。 */
  serviceOn: boolean;
  pending: boolean;
  onChange: (id: string, patch: { enabled?: boolean; priority?: number }) => void;
  onReset: (id: string) => void;
  /** 这张卡片的 PAT 正在提交校验。 */
  patPending: boolean;
  /** 设置或清空这个账户的 Qoder PAT；空串表示清除。 */
  onSetPat: (id: string, pat: string) => void;
}) {
  const g = a.gateway;
  const info = GATEWAY_STATE[g.state];
  const tokens = g.inputTokens + g.outputTokens;

  return (
    <section className={`gateway ${g.enabled ? 'on' : 'off'}`}>
      <div className="gateway-head">
        <button
          className={`gateway-toggle ${g.enabled ? 'on' : ''}`}
          disabled={pending}
          title={
            g.enabled
              ? '正在把这个账户的额度交给 API 服务。点一下停用：不影响已经在跑的请求，只是不再派新的给它'
              : 'API 服务不会用这个账户的额度。点一下启用，它就进入账号池'
          }
          onClick={() => onChange(a.id, { enabled: !g.enabled })}
          aria-pressed={g.enabled}
        >
          <Icon name="route" size={12} />
          API 服务
        </button>
        <span className={`gateway-state ${g.state}`} title={info.hint}>
          {/* 全局开关关着时，「待命」是句空话：没有请求会进来 */}
          {g.enabled && !serviceOn ? '服务未开启' : info.label}
          {g.state === 'busy' && g.inFlight > 0 && ` ${g.inFlight}`}
        </span>
        <div className="spacer" />
        {/*
          优先级只在参与转发时才有意义。数值越大越先被派活——默认的 fill-first 会把
          最高优先级那个用到耗尽再换下一个，所以这里调的其实是「先烧谁的额度」。
        */}
        {g.enabled && (
          <div
            className="gateway-prio"
            title="优先级：数值大的先被派活。fill-first 策略下，它决定额度按什么顺序一个个烧掉"
          >
            <button
              disabled={pending || g.priority <= -99}
              onClick={() => onChange(a.id, { priority: g.priority - 1 })}
              aria-label="降低优先级"
            >
              −
            </button>
            <span>{g.priority}</span>
            <button
              disabled={pending || g.priority >= 99}
              onClick={() => onChange(a.id, { priority: g.priority + 1 })}
              aria-label="提高优先级"
            >
              +
            </button>
          </div>
        )}
      </div>

      {/* Qoder 转发靠账户页面单独申请的 PAT；没有它这个账户恒为「不可用」，所以入口就摆在开关下面 */}
      {g.needsPat && (
        <QoderPatRow id={a.id} hasPat={g.hasPat} pending={patPending} onSetPat={onSetPat} />
      )}

      {g.enabled && (
        <div className="gateway-stats">
          <span title="累计转发过的请求数，含失败的那些">
            {g.requests} 次转发
            {g.failures > 0 && <em className="warn"> · {g.failures} 次失败</em>}
          </span>
          {tokens > 0 && (
            <span title={`输入 ${amount(g.inputTokens)} · 输出 ${amount(g.outputTokens)}`}>
              {amount(tokens)} tokens
            </span>
          )}
          {g.lastUsedAt > 0 && <span title="最近一次被派活的时刻">最近 {clock(g.lastUsedAt)}</span>}
        </div>
      )}

      {g.cooldownUntil !== null && (
        <p className="gateway-cool">
          {countdown(g.cooldownUntil, now)} 后自动归队
          <button className="link" disabled={pending} onClick={() => onReset(a.id)}>
            立刻归队
          </button>
        </p>
      )}

      {/* 转发失败的原因单独说：它和保活失败不是一回事，混在 card-error 里会让人找错地方 */}
      {g.lastError && (
        <p className="gateway-error" title={g.lastError}>
          {g.lastError}
        </p>
      )}
    </section>
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
  onQoderSwitched: () => void;
  /** API 服务的全局开关；卡片上要据此说明「打开了也暂时不会有请求进来」。 */
  gatewayEnabled: boolean;
  /** 改这个账户的转发设置：卡片上的开关和优先级都走它。 */
  onGatewayChange: (id: string, patch: { enabled?: boolean; priority?: number }) => void;
  /** 让这个账户立刻结束冷却。 */
  onGatewayReset: (id: string) => void;
  /** 这张卡片的转发设置正在提交。 */
  gatewayBusy: boolean;
  /** 设置或清空这个账户的 Qoder PAT；空串表示清除。只有 Qoder 卡片会用到。 */
  onSetPat: (id: string, pat: string) => void;
  /** 这张卡片的 PAT 正在提交校验。 */
  patBusy: boolean;
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
  onQoderSwitched,
  gatewayEnabled,
  onGatewayChange,
  onGatewayReset,
  gatewayBusy,
  onSetPat,
  patBusy,
}: Props) {
  const [qoderSwitchOpen, setQoderSwitchOpen] = useState(false);
  const [emailVisible, setEmailVisible] = useState(false);
  const displayedEmail = emailVisible ? a.email : maskEmail(a.email);
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
          aria-label={`选择 ${displayedEmail}`}
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
          <div className="card-email">
            <h3
              className={emailVisible ? 'email-visible' : undefined}
              title={[displayedEmail, a.userId && `用户 ID: ${a.userId}`].filter(Boolean).join('\n')}
            >
              {displayedEmail}
            </h3>
            <button
              className="email-visibility"
              type="button"
              aria-label={emailVisible ? '隐藏完整邮箱' : '查看完整邮箱'}
              aria-pressed={emailVisible}
              title={emailVisible ? '隐藏完整邮箱' : '查看完整邮箱'}
              onClick={() => setEmailVisible((visible) => !visible)}
            >
              <Icon name={emailVisible ? 'eyeOff' : 'eye'} size={13} />
            </button>
          </div>
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

      {/*
        这台电脑此刻用的是哪个账户：写在客户端自己的凭证文件里，服务端定时核对。
        它独占一行、紧贴卡头——一列账户里用户最先要找的就是「我现在用的是哪个」；
        挤进上面那排徽章则不行，客户端名比 plan 长得多，一挤就换行，把卡头拆散。
      */}
      {a.inUseBy.length > 0 && (
        <p
          className="card-inuse"
          title={[
            ...a.inUseBy.map((u) => `${u.label} 正在用这个账户（${u.path}）`),
            a.inUseCheckedAt ? `上次核对 ${clock(a.inUseCheckedAt)}` : '',
          ]
            .filter(Boolean)
            .join('\n')}
        >
          <span className="card-inuse-dot" aria-hidden="true" />
          本机在用 · {a.inUseBy.map((u) => u.label).join('、')}
        </p>
      )}

      <div className="usage">
        {windows.length === 0 ? (
          <span className="usage-text">用量未知，点「查看额度」拉一次</span>
        ) : (
          windows.map((w) => <UsageRow key={w.name} window={w} now={now} />)
        )}
      </div>

      {a.gateway.supported && (
        <GatewayBlock
          account={a}
          now={now}
          serviceOn={gatewayEnabled}
          pending={gatewayBusy}
          onChange={onGatewayChange}
          onReset={onGatewayReset}
          patPending={patBusy}
          onSetPat={onSetPat}
        />
      )}

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
            {a.provider === 'qoder' && (
              <button className="act key" onClick={() => setQoderSwitchOpen(true)}>
                切换账户
              </button>
            )}
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
      <QoderSwitchDialog
        accountId={a.id}
        email={a.email}
        open={qoderSwitchOpen}
        onClose={() => setQoderSwitchOpen(false)}
        onSwitched={onQoderSwitched}
      />
    </article>
  );
}
