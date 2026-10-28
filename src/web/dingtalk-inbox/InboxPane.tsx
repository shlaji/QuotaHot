import { useEffect, useId, useState } from 'react';
import { createDingtalkInboxLoader, INITIAL_DINGTALK_INBOX_STATE, targetKey, type DingtalkInboxLoader, type DingtalkInboxState } from './loader.js';
import type { SubscriptionState, TargetType } from './api.js';

const TYPE_LABELS: Readonly<Record<TargetType, string>> = { person: '人员单聊', group: '群聊' };
const SUBSCRIPTION_LABELS: Readonly<Record<SubscriptionState['state'], string>> = {
  starting: '正在启动', ready: '监听已就绪', stopping: '正在停止', stopped: '已停止', failed: '启动失败', interrupted: '已中断',
};
const CONTROL_STYLE = { minHeight: 'calc(var(--task-space-10) + var(--task-space-1))' } as const;
const WRAP_STYLE = { minWidth: 0, overflowWrap: 'anywhere' } as const;
interface ViewProps {
  readonly state: DingtalkInboxState;
  readonly loader: DingtalkInboxLoader;
  readonly idPrefix?: string;
}

export function InboxView({ state, loader, idPrefix = 'dingtalk-inbox' }: ViewProps) {
  const available = state.connection === 'ready' && state.capability?.available === true;
  const blocked = !available || state.selecting;
  const connectionLabel = state.connection === 'loading' ? '正在检查连接' : available ? '服务可用' : '服务不可用';
  return <div className="task-pane dingtalk-inbox" style={WRAP_STYLE}>
    <section className="panel task-create task-list-section" aria-labelledby={`${idPrefix}-connection`} aria-busy={state.connection === 'loading'}>
      <header className="task-section-head panel-row">
        <div style={WRAP_STYLE}><h2 id={`${idPrefix}-connection`}>钉钉连接</h2><p>通过 QuotaHot 同源代理连接可选服务。</p></div>
        <span className="pill" role="status">{connectionLabel}</span>
      </header>
      <div className="task-form">
        <p className="task-submit-hint">仅使用服务当前 profile 返回的身份；搜索不会自动选择目标。</p>
        {state.connectionError && <p className="task-feedback task-feedback-error" role="alert">{state.connectionError}</p>}
        {state.connection === 'ready' && !available && <p className="task-feedback" role="status">钉钉运行时不可用。请检查服务端运行时、profile 和授权后重新检查连接。</p>}
        <div className="panel-row actions"><button type="button" style={CONTROL_STYLE} disabled={!state.active || state.connection === 'loading' || state.selecting}
          onClick={() => loader.refresh()}>重新检查连接</button></div>
      </div>
    </section>
    <section className="panel task-create task-list-section" aria-labelledby={`${idPrefix}-search`} aria-busy={state.searchStatus === 'loading'}>
      <header className="task-section-head"><div><h2 id={`${idPrefix}-search`}>搜索目标</h2><p>核对类型、姓名和稳定身份标识，再明确选择。</p></div></header>
      <form className="task-form" aria-label="搜索钉钉目标" onSubmit={(event) => { event.preventDefault(); return loader.search(); }}>
        <div className="task-form-grid">
          <label className="field task-field"><span>搜索类型</span><select name="kind" style={CONTROL_STYLE} value={state.kind} disabled={blocked}
            onChange={(event) => { const kind = event.currentTarget.value; if (kind === 'person' || kind === 'group') loader.setKind(kind); }}>
            <option value="person">人员单聊</option><option value="group">群聊</option>
          </select></label>
          <label className="field task-field"><span>{state.kind === 'person' ? '人员姓名' : '群名称关键词'}</span><input name="query" style={CONTROL_STYLE} required
            value={state.query} disabled={blocked} placeholder={state.kind === 'person' ? '输入姓名' : '输入群名称关键词'}
            aria-describedby={`${idPrefix}-search-hint`} onChange={(event) => loader.setQuery(event.currentTarget.value)} /></label>
        </div>
        <div className="panel-row actions"><button type="submit" style={CONTROL_STYLE} disabled={blocked || !state.query.trim()}>
          {state.searchStatus === 'loading' ? '重新搜索' : '搜索候选'}</button></div>
        <p id={`${idPrefix}-search-hint`} className="task-submit-hint">即使只返回一位人员，也不代表全局唯一。结果不完整时不可选择。</p>
        {state.searchStatus === 'idle' && <p className="empty" role="status">输入关键词搜索人员或群，再从候选中选择。</p>}
        {state.searchStatus === 'loading' && <p role="status">正在搜索{TYPE_LABELS[state.kind]}…</p>}
        {state.searchStatus === 'empty' && <p className="empty" role="status">未找到匹配候选，请调整关键词后搜索。</p>}
        {state.searchStatus === 'incomplete' && <p className="task-feedback" role="status" id={`${idPrefix}-incomplete`}>结果不完整，所有候选均不可选择。请检查服务端搜索完整性或调整关键词后重试。</p>}
        {state.searchError && <p className="task-feedback task-feedback-error" role="alert">{state.searchError}</p>}
        {state.items.length > 0 && <div className="task-form" role="list" aria-label="搜索候选">
          {state.items.map((candidate) => {
            const key = targetKey(candidate);
            const selected = state.activeTarget !== null && targetKey(state.activeTarget) === key;
            return <div role="listitem" key={key} style={WRAP_STYLE}>
              <button type="button" className="task-model-trigger" data-target-key={key} aria-pressed={selected}
                aria-describedby={state.searchStatus === 'incomplete' ? `${idPrefix}-incomplete` : undefined}
                disabled={blocked || state.searchStatus !== 'ready' || selected}
                style={{ ...CONTROL_STYLE, ...(selected ? { background: 'color-mix(in srgb, var(--text) 8%, var(--panel))' } : {}) }}
                onClick={() => loader.select(key)}>
                <span className="task-form" style={WRAP_STYLE}>
                  <strong>{TYPE_LABELS[candidate.targetType]}：{candidate.displayName}</strong>
                  <span className="task-submit-hint">{candidate.targetType === 'person' ? 'userId' : 'openConversationId'}：<code>{candidate.targetId}</code></span>
                  {candidate.department !== undefined && <span className="task-submit-hint">部门：{candidate.department}</span>}
                  <span>{selected ? '已选择' : '选择此目标'}</span>
                </span>
                {selected && <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>}
              </button>
            </div>;
          })}
        </div>}
      </form>
    </section>
    <section className="panel task-create task-list-section" aria-labelledby={`${idPrefix}-selected`} aria-busy={state.selecting}>
      <header className="task-section-head"><div><h2 id={`${idPrefix}-selected`}>当前目标</h2><p>仅显示服务已确认的目标，不按搜索顺序推测。</p></div></header>
      <div className="task-form">
        {state.selecting && <p role="status">正在选择目标，等待服务确认…</p>}
        {state.selectionError && <p className="task-feedback task-feedback-error" role="alert">{state.selectionError}</p>}
        {state.activeTarget === null ? <p className="empty" role="status">尚未选择目标。请先搜索并明确选择一项。</p> : <>
          <dl className="task-meta">
            <div><dt>目标类型</dt><dd>{TYPE_LABELS[state.activeTarget.targetType]}</dd></div>
            <div><dt>显示名称</dt><dd>{state.activeTarget.displayName}</dd></div>
            <div className="task-meta-wide"><dt>稳定身份标识</dt><dd><code>{state.activeTarget.targetId}</code></dd></div>
          </dl>
          <p role="status">监听状态：{state.subscriptionState === null ? '尚未取得状态' : SUBSCRIPTION_LABELS[state.subscriptionState.state]}</p>
          <p className="task-submit-hint">选择请求被接受不等于监听已就绪；此面板不连接实时事件。</p>
        </>}
      </div>
    </section>
  </div>;
}

export function InboxPane({ active }: { readonly active: boolean }) {
  const [state, setState] = useState(INITIAL_DINGTALK_INBOX_STATE);
  const [loader] = useState(() => createDingtalkInboxLoader(setState));
  const idPrefix = useId();
  useEffect(() => { void loader.setActive(active); return () => { void loader.setActive(false); }; }, [active, loader]);
  return <InboxView state={state} loader={loader} idPrefix={idPrefix} />;
}
