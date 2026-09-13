import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AccountView,
  AppConfig,
  LogEntry,
  ModelCatalog,
  SchedulerStatus,
  UsageResult,
} from '../shared/types.js';
import { api, subscribeEvents } from './api.js';
import { useNow } from './useNow.js';
import { AccountCard } from './components/AccountCard.js';
import { AccountsDialog } from './components/AccountsDialog.js';
import { ControlPanel } from './components/ControlPanel.js';
import { LogPane } from './components/LogPane.js';
import { RunBar } from './components/RunBar.js';
import { SchedulePane } from './components/SchedulePane.js';
import { RequestLogDialog } from './components/RequestLogDialog.js';
import { UsageDialog } from './components/UsageDialog.js';

const MAX_LOGS = 500;

/**
 * 账户卡片按 provider 分组展示：同一家上游的账户，能做的操作和额度口径都一样，
 * 摆在一起才好横向比。这里定的是组的顺序和名字，没列到的 provider 按出现顺序排在最后。
 */
const PROVIDER_GROUPS: { provider: string; label: string; note?: string }[] = [
  { provider: 'claude', label: 'Claude', note: '5 小时滚动窗口' },
  { provider: 'codex', label: 'Codex', note: '5 小时滚动窗口' },
  { provider: 'qoder', label: 'Qoder', note: '按订阅周期发放，不参与保活调度' },
];

/**
 * 页面分成三页：账户（卡片和作用在卡片上的操作）、调度任务（起停、谁在跑、下次/上次发送）、
 * 配置（所有参数）。
 */
type Tab = 'accounts' | 'schedule' | 'config';
const TAB_KEY = 'quotahot.tab';
const TABS: Tab[] = ['accounts', 'schedule', 'config'];

export function App() {
  const now = useNow();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [version, setVersion] = useState('');
  const [status, setStatus] = useState<SchedulerStatus | null>(null);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);
  // 勾选为空表示“全部账户”，这样不想筛选的人可以完全无视勾选框
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [usage, setUsage] = useState<UsageResult[] | null>(null);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [requestsFor, setRequestsFor] = useState<string | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [accountsDir, setAccountsDir] = useState('');
  const [proxy, setProxy] = useState('');
  const [noProxy, setNoProxy] = useState<string[]>([]);
  const [toast, setToast] = useState('');
  // 刷新后停在原来那一页；用户多半是在同一件事上来回
  const [tab, setTab] = useState<Tab>(() => {
    const saved = localStorage.getItem(TAB_KEY);
    return TABS.find((t) => t === saved) ?? 'accounts';
  });
  const [configDirty, setConfigDirty] = useState(false);

  const openTab = useCallback((next: Tab) => {
    setTab(next);
    localStorage.setItem(TAB_KEY, next);
  }, []);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 5000);
  }, []);

  // 模型列表要向上游查，比首屏其他数据慢，因此单独拉，不拖住页面渲染
  const loadCatalog = useCallback(
    async (refresh = false) => {
      try {
        setCatalog(await api.models(refresh));
      } catch (err) {
        notify(`模型列表获取失败: ${String(err instanceof Error ? err.message : err)}`);
      }
    },
    [notify],
  );

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  // 挂载时先全量拉一次，之后依赖 SSE 增量更新
  useEffect(() => {
    void (async () => {
      try {
        const [state, history] = await Promise.all([api.state(), api.logs()]);
        setConfig(state.config);
        setVersion(state.version);
        setAccountsDir(state.accountsDir);
        setProxy(state.proxy);
        setNoProxy(state.noProxy);
        setStatus(state.scheduler);
        setAccounts(state.accounts);
        setLogs(history);
      } catch (err) {
        notify(`加载失败: ${String(err)}`);
      }
    })();
  }, [notify]);

  useEffect(
    () =>
      subscribeEvents((e) => {
        if (e.type === 'accounts') setAccounts(e.accounts);
        else if (e.type === 'scheduler') setStatus(e.status);
        else if (e.type === 'log') {
          // 只保留尾部日志，避免连续跑几天后把浏览器内存撑爆
          setLogs((prev) => [...prev, e.entry].slice(-MAX_LOGS));
        }
      }, setConnected),
    [],
  );

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      notify(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  const handleSave = (draft: AppConfig) =>
    guard(async () => {
      const saved = await api.saveConfig(draft);
      setConfig(saved);
      // 代理在服务端应用前已经校验过，因此保存成功就代表已生效
      setProxy(saved.proxy);
      setNoProxy(saved.noProxy);
      notify('配置已保存');
    });

  /** 启动定时任务；ids 为空表示纳入全部可保活账户。 */
  const handleStart = (ids: string[]) =>
    guard(async () => {
      setStatus(await api.start(ids));
    });

  const handleStop = () =>
    guard(async () => {
      setStatus(await api.stop());
    });

  /** 批量操作的目标：勾选了就只作用于勾选的，一个没勾就是全部。 */
  const targetIds = useMemo(
    () => accounts.filter((a) => selected.has(a.id)).map((a) => a.id),
    [accounts, selected],
  );

  /** 按 PROVIDER_GROUPS 的顺序切分账户；只保留有账户的组，未知 provider 原样成组排在最后。 */
  const groups = useMemo(() => {
    const byProvider = new Map<string, AccountView[]>();
    for (const a of accounts) {
      const list = byProvider.get(a.provider);
      if (list) list.push(a);
      else byProvider.set(a.provider, [a]);
    }
    const known = PROVIDER_GROUPS.filter((g) => byProvider.has(g.provider)).map((g) => ({
      ...g,
      accounts: byProvider.get(g.provider)!,
    }));
    const rest = [...byProvider.keys()]
      .filter((p) => !PROVIDER_GROUPS.some((g) => g.provider === p))
      .map((p) => ({ provider: p, label: p, note: undefined, accounts: byProvider.get(p)! }));
    return [...known, ...rest];
  }, [accounts]);

  const handleTestSelected = () => {
    const count = targetIds.length === 0 ? accounts.length : targetIds.length;
    // 每个账户都会因此打开一个 5 小时窗口，批量操作值得先问一句
    if (!confirm(`将对 ${count} 个账户各真发一条消息，每个账户都会打开一个 5 小时窗口。继续？`)) {
      return;
    }
    void guard(async () => {
      notify(`正在测试 ${count} 个账户，会真实发起请求…`);
      const results = await api.sendNowMany(targetIds);
      const failed = results.filter((r) => !r.ok);
      notify(
        failed.length === 0
          ? `${results.length} 个账户全部发送成功`
          : `${results.length} 个账户中 ${failed.length} 个失败 · ${failed[0].message}`,
      );
    });
  };

  const handleUsage = () =>
    guard(async () => {
      const results = await api.usage(targetIds);
      setUsage(results);
      const failed = results.filter((r) => !r.ok).length;
      notify(failed === 0 ? '额度已刷新' : `${results.length} 个账户中 ${failed} 个查询失败`);
    });

  const toggleSelected = useCallback((id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  /**
   * 单个账户的额度查询。
   * 复用整体查询的弹窗，只是结果里只有一条——省得为“一个账户”另做一套展示。
   */
  const handleAccountUsage = (id: string) => {
    setCheckingId(id);
    void guard(async () => {
      const result = await api.accountUsage(id);
      setUsage([result]);
      notify(result.ok ? `${result.email} 额度已刷新` : `查询失败: ${result.error}`);
    }).finally(() => setCheckingId(null));
  };

  /**
   * 切换续期方式。
   * 服务端两个方向都会先核对本机客户端登录的是不是同一个账户：改为跟随时对不上直接报错，
   * 改为自动刷新时对得上会回一句提醒（刷新会把客户端手里那份顶掉），都原样转给用户。
   */
  const handleAutoRefresh = (id: string, autoRefresh: boolean) => {
    setSwitchingId(id);
    void guard(async () => {
      const { note } = await api.setAutoRefresh(id, autoRefresh);
      const done = autoRefresh ? `${id} 改为由本程序刷新 token` : `${id} 改为跟随客户端，本程序只同步不刷新`;
      notify(note ? `${done}。${note}` : done);
    }).finally(() => setSwitchingId(null));
  };

  /**
   * 更新 token：不等到期，立刻换一份新的。
   * 换来的旧 refresh_token 会被上游作废，所以先问一句——尤其是同一个账户还在别处用着的时候。
   */
  const handleForceRefresh = (id: string) => {
    if (!confirm(`将立刻为 ${id} 换一份新 token，旧的 refresh_token 会被上游作废。继续？`)) return;
    setRefreshingId(id);
    void guard(async () => {
      const { expiresAt } = await api.forceRefresh(id);
      notify(`${id} 已换到新 token，有效期至 ${new Date(expiresAt).toLocaleString()}`);
    }).finally(() => setRefreshingId(null));
  };

  /**
   * 把当前 token 写回客户端的配置文件。
   * 改的是用户自己的文件，因此先把目标路径逐个摆出来问一句——Codex 一次会动两个文件；
   * 改了哪几处由服务端写进日志面板，这里只给每个文件一句结论。
   */
  const handleSyncToClient = (id: string, targets: string[]) => {
    if (targets.length === 0) return;
    if (!confirm(`将把 ${id} 当前的 token 写入以下文件，原文件会先备份一份：\n${targets.join('\n')}\n继续？`))
      return;
    setSyncingId(id);
    void guard(async () => {
      const results = await api.syncToClient(id);
      const parts = results.map((r) =>
        r.error
          ? `${r.label} 写入失败`
          : r.changes.length === 0
            ? `${r.label} 无改动`
            : `${r.label} ${r.changes.length} 处改动`,
      );
      notify(`${id}：${parts.join('；')}，详情见日志`);
    }).finally(() => setSyncingId(null));
  };

  const handleRemove = (id: string) =>
    guard(async () => {
      const { removed } = await api.removeAccount(id);
      notify(`已移除 ${removed}`);
    });

  const handleSendNow = (id: string) => {
    setSendingId(id);
    void guard(async () => {
      const { message } = await api.sendNow(id);
      notify(message);
    }).finally(() => setSendingId(null));
  };

  if (!config || !status) {
    return <div className="loading">加载中…</div>;
  }

  const running = status.running;
  const active = accounts.filter((a) => a.state === 'waiting' || a.state === 'sending').length;

  return (
    <div className="app">
      <header className="topbar">
        <h1>
          QuotaHot
          {version && <small className="app-version">v{version}</small>}
          <small>多账户 5 小时窗口保活</small>
        </h1>
        <div className="topbar-status">
          <span className={`pill ${running ? 'on' : 'off'}`}>{running ? '调度运行中' : '已停止'}</span>
          <span className="pill muted">
            {accounts.length} 个账户{running && ` · ${active} 个在计时`}
          </span>
          <span
            className={`pill ${status.withinWindow ? 'on' : 'muted'}`}
            title={status.withinWindow ? '当前在每日发送窗口内' : '当前不在每日发送窗口内'}
          >
            {status.dailyStart === status.dailyEnd
              ? '全天窗口'
              : `每天 ${status.dailyStart}–${status.dailyEnd}`}
          </span>
          <span className={`pill ${connected ? 'on' : 'warn'}`}>
            {connected ? '实时已连接' : '连接中断'}
          </span>
          <span
            className="pill muted"
            title={
              proxy
                ? `经 ${proxy} 出站${noProxy.length ? `，忽略 ${noProxy.join(', ')}` : ''}`
                : '所有出站请求直连上游'
            }
          >
            {proxy ? `代理 ${proxy}` : '直连'}
            {proxy && noProxy.length > 0 && ` · 忽略 ${noProxy.length}`}
          </span>
        </div>
      </header>

      <nav className="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'accounts'}
          className={tab === 'accounts' ? 'tab on' : 'tab'}
          onClick={() => openTab('accounts')}
        >
          账户
        </button>
        <button
          role="tab"
          aria-selected={tab === 'schedule'}
          className={tab === 'schedule' ? 'tab on' : 'tab'}
          onClick={() => openTab('schedule')}
        >
          调度任务
          {/* 有几个账户在跑，切到别的页也该看得见 */}
          {running && <span className="tab-count">{status.accountIds.length}</span>}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'config'}
          className={tab === 'config' ? 'tab on' : 'tab'}
          onClick={() => openTab('config')}
        >
          配置
          {/* 这一页被藏起来时也要看得出有没改完 */}
          {configDirty && <span className="tab-dot" title="有未保存的改动" />}
        </button>
      </nav>

      {/* 两页都保持挂载、只切显示：否则一离开配置页，没保存的草稿就没了 */}
      <div className="tab-panel" hidden={tab !== 'accounts'}>
        <RunBar
          busy={busy}
          total={accounts.length}
          selected={targetIds.length}
          onSelectAll={() => setSelected(new Set(accounts.map((a) => a.id)))}
          onClearSelection={() => setSelected(new Set())}
          onTestSelected={handleTestSelected}
          onUsage={handleUsage}
          onAccounts={() => setAccountsOpen(true)}
        />

        <main className="accounts">
          {accounts.length === 0 ? (
            <p className="empty big">
              <code>{accountsDir}</code> 下还没有账户。
              <button className="link" onClick={() => setAccountsOpen(true)}>
                导入或登录一个
              </button>
            </p>
          ) : (
            groups.map((g) => (
              <section className="account-group" key={g.provider}>
                {/* 组头只说明这一组是谁、有几个、额度按什么节奏走；具体到账户的事都在卡片里 */}
                <header className={`group-bar provider-${g.provider}`}>
                  <h2>{g.label}</h2>
                  <span className="group-count">{g.accounts.length}</span>
                  {g.note && <span className="group-note">{g.note}</span>}
                </header>
                <div className="grid">
                  {g.accounts.map((a) => (
                    <AccountCard
                      key={a.id}
                      account={a}
                      now={now}
                      busy={sendingId === a.id}
                      onSendNow={handleSendNow}
                      onRemove={(id) => void handleRemove(id)}
                      onAutoRefreshChange={handleAutoRefresh}
                      onForceRefresh={handleForceRefresh}
                      onSyncToClient={(id) => handleSyncToClient(id, a.syncTargets)}
                      refreshing={refreshingId === a.id}
                      syncing={syncingId === a.id}
                      switching={switchingId === a.id}
                      onRequests={setRequestsFor}
                      onUsage={handleAccountUsage}
                      checking={checkingId === a.id}
                      selected={selected.has(a.id)}
                      onSelectChange={toggleSelected}
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </main>

        <LogPane logs={logs} />
      </div>

      <div className="tab-panel" hidden={tab !== 'schedule'}>
        <SchedulePane
          accounts={accounts}
          status={status}
          now={now}
          busy={busy}
          selected={selected}
          onSelectChange={toggleSelected}
          onSelectAll={(ids) => setSelected(new Set(ids))}
          onClearSelection={() => setSelected(new Set())}
          onStart={(ids) => void handleStart(ids)}
          onStop={handleStop}
        />
        <LogPane logs={logs} />
      </div>

      <div className="tab-panel" hidden={tab !== 'config'}>
        <ControlPanel
          config={config}
          busy={busy}
          proxy={proxy}
          onSave={handleSave}
          catalog={catalog}
          onRefreshModels={() => void loadCatalog(true)}
          onDirtyChange={setConfigDirty}
        />
      </div>

      {toast && <div className="toast">{toast}</div>}
      <RequestLogDialog accountId={requestsFor} onClose={() => setRequestsFor(null)} />
      <UsageDialog results={usage} now={now} onClose={() => setUsage(null)} />
      <AccountsDialog
        open={accountsOpen}
        accountsDir={accountsDir}
        onClose={() => setAccountsOpen(false)}
        onNotify={notify}
      />
    </div>
  );
}
