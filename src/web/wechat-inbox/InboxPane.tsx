import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WechatConnectionState } from '../../shared/wechat-inbox.js';
import { createInboxLoader, INITIAL_INBOX_STATE, type InboxLoader, type InboxState } from './loader.js';
import { InboxComposer } from './Composer.js';
import { InboxMessages } from './Messages.js';
import { createWechatLoader, INITIAL_WECHAT_STATE } from '../wechat-loader.js';
import { BindingActions, BindingQr, type BindingControls, type UnlinkConfirmation } from './BindingControls.js';

const CONNECTION_LABELS: Readonly<Record<WechatConnectionState, string>> = {
  starting: '正在连接', polling: '正在接收', backoff: '连接退避中', relogin_required: '需要重新扫码', stopped: '连接已停止', unlinked: '已解除绑定',
};
function SelectionMark() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>;
}

export function InboxView({ active, state, loader, controls }: { readonly controls: BindingControls; readonly active: boolean; readonly state: InboxState; readonly loader: InboxLoader }) {
  const [confirmation, setConfirmation] = useState<UnlinkConfirmation | null>(null);
  const cancelConfirmation = () => { setConfirmation(null); confirmation?.trigger.focus(); };
  const qrDisabled = controls.state.qr.status === 'loading' || controls.state.qr.qr !== null;
  const addTrigger = useRef<HTMLButtonElement>(null);
  const restoreQrFocus = useRef(false);
  useLayoutEffect(() => {
    if (!active) { restoreQrFocus.current = false; return; }
    if (restoreQrFocus.current && controls.state.qr.status === 'idle') {
      restoreQrFocus.current = false;
      addTrigger.current?.focus();
    }
  }, [active, controls.state.qr.status]);
  const binding = state.bindings.find((item) => item.ownerIlinkUserId === state.bindingId);
  const waitingForInbound = binding?.replyContextState === 'waiting_for_inbound';
  const canSend = active && binding?.canSend === true && binding.replyContextState === 'ready' && !state.bindingsError;
  const historyRef = useRef<HTMLDivElement>(null);
  const olderSentinel = useRef<HTMLDivElement>(null);
  const armed = useRef(false);
  const lastScrollTop = useRef(0);
  const prependAnchor = useRef<{ readonly bindingId: string; readonly element: Element; readonly top: number; readonly count: number } | null>(null);

  useEffect(() => {
    const sentinel = olderSentinel.current;
    const history = historyRef.current;
    if (!active || !sentinel || !history || !state.bindingId || !state.hasMore) return;
    const loadOlder = () => {
      const bounds = sentinel.getBoundingClientRect();
      const viewport = history.getBoundingClientRect();
      if (state.messagesLoading || !armed.current || bounds.bottom < viewport.top || bounds.top > viewport.bottom) return;
      armed.current = false;
      const element = [...history.querySelectorAll('.wechat-messages > li')].find((message) => {
        const rect = message.getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < viewport.bottom;
      });
      if (element) prependAnchor.current = { bindingId: state.bindingId, element, top: element.getBoundingClientRect().top - viewport.top, count: state.messages.length };
      void loader.loadMore();
    };
    const onScroll = () => {
      const next = history.scrollTop;
      if (next < lastScrollTop.current) armed.current = true;
      lastScrollTop.current = next;
      loadOlder();
    };
    lastScrollTop.current = history.scrollTop;
    const observer = new IntersectionObserver(loadOlder, { root: history });
    observer.observe(sentinel);
    history.addEventListener('scroll', onScroll, { passive: true });
    return () => { observer.disconnect(); history.removeEventListener('scroll', onScroll); };
  }, [active, loader, state.bindingId, state.hasMore, state.messages.length, state.messagesLoading]);

  useLayoutEffect(() => {
    const anchor = prependAnchor.current;
    const history = historyRef.current;
    if (!anchor || !history || anchor.bindingId !== state.bindingId || state.messagesLoading || state.messages.length <= anchor.count) return;
    history.scrollTop += anchor.element.getBoundingClientRect().top - history.getBoundingClientRect().top - anchor.top;
    lastScrollTop.current = history.scrollTop;
    prependAnchor.current = null;
  }, [state.bindingId, state.messages.length, state.messagesLoading]);

  useEffect(() => { armed.current = false; prependAnchor.current = null; }, [state.bindingId]);

  useEffect(() => { if (!active) setConfirmation(null); }, [active]);

  return <section aria-labelledby="wechat-inbox-title" className="wechat-inbox" onKeyDown={(event) => {
    if (event.key === 'Escape' && confirmation !== null) { event.preventDefault(); cancelConfirmation(); }
  }}>
    <header className="task-section-head"><div><h2 id="wechat-inbox-title">微信消息</h2><p>选择绑定用户查看历史；收到该用户的消息后才能手动回复。</p></div></header>
    <div className="wechat-columns">
      <section className="panel" aria-labelledby="wechat-inbox-bindings-title" aria-busy={state.bindingsLoading}>
        <header className="task-section-head"><h3 id="wechat-inbox-bindings-title">绑定用户</h3><div className="wechat-actions">
          <button ref={addTrigger} type="button" className={canSend ? undefined : 'primary'} disabled={!active || qrDisabled} onClick={controls.loader.startQr}>添加微信用户</button>
          <button type="button" aria-disabled={state.bindingsLoading} onClick={() => { if (!state.bindingsLoading) void loader.refresh(); }}>刷新绑定</button>
        </div></header>
        <BindingQr controls={controls} onCancel={(restoreFocus) => { restoreQrFocus.current = restoreFocus; controls.loader.cancelQr(); }} />
        <p className="wechat-note">解除本地绑定不会撤销<span className="wechat-phrase">微信上游授权。</span></p>
        {state.bindingsLoading && <p role="status">正在加载绑定用户…</p>}
        {state.bindingsError && <p role="alert">{state.bindingsError}</p>}
        {!state.bindingsLoading && !state.bindingsError && state.bindings.length === 0 && <p className="empty" role="status">暂无绑定用户。点击“添加微信用户”扫码绑定。</p>}
        <ul className="wechat-list" aria-label="绑定用户">{state.bindings.map((item) => <li key={item.ownerIlinkUserId}>
          <button type="button" aria-current={item.ownerIlinkUserId === state.bindingId ? 'true' : undefined} onClick={() => void loader.selectBinding(item.ownerIlinkUserId)}>
            <span>{item.ownerIlinkUserId}</span>{item.ownerIlinkUserId === state.bindingId && <SelectionMark />}
            <small>{CONNECTION_LABELS[item.connectionState]} · {item.canSend ? item.replyContextState === 'ready' ? '允许手动发送' : '等待用户首条消息' : '只读'} · {item.botId}</small>
          </button><BindingActions bindingId={item.ownerIlinkUserId} active={active} linked={item.connectionState !== 'unlinked'} controls={controls} confirmation={confirmation}
            onConfirm={setConfirmation} onCancel={cancelConfirmation} /></li>)}</ul>
      </section>
      <section className="panel" aria-labelledby="wechat-inbox-messages-title" aria-busy={state.messagesLoading}>
        <header className="task-section-head"><div><h3 id="wechat-inbox-messages-title">绑定消息</h3><p>{state.bindingId || '请选择绑定用户'}</p></div>
          {state.bindingId && <button type="button" aria-disabled={state.messagesLoading} onClick={() => { if (!state.messagesLoading) void loader.refreshMessages(); }}>刷新消息</button>}</header>
        {state.messagesError && <p role="alert">{state.messagesError} 请刷新消息。</p>}
        {state.messagesLoading && <p role="status">正在加载消息…</p>}
        {state.bindingId && <>
          <div ref={historyRef} className="wechat-history" role="region" tabIndex={0} aria-label="消息历史，向上滚动加载更早消息">
            {state.hasMore && <div ref={olderSentinel} className="wechat-history-sentinel" aria-hidden="true" />}
            {!state.messagesLoading && !state.messagesError && state.messages.length === 0 && <p className="empty" role="status">{canSend ? '暂无已保存消息。可手动发送文本，或稍后刷新。' : '暂无已保存消息，请稍后刷新。'}</p>}
            <InboxMessages messages={state.messages} />
          </div>
          <p className="wechat-history-hint" role="status">{state.hasMore ? '向上滚动到历史顶部可加载更早消息。' : '已加载当前绑定的全部消息。'}</p>
          <InboxComposer key={state.bindingId} state={state} loader={loader} canSend={canSend} waitingForInbound={waitingForInbound} />
        </>}
      </section>
    </div>
  </section>;
}

export function InboxPane({ active }: { readonly active: boolean }) {
  const [state, setState] = useState(INITIAL_INBOX_STATE);
  const [loader] = useState(() => createInboxLoader(setState));
  const [controlState, setControlState] = useState(INITIAL_WECHAT_STATE);
  const [controls] = useState(() => createWechatLoader(setControlState));
  useEffect(() => { loader.setActive(active); return () => loader.setActive(false); }, [active, loader]);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      const current = loader.getState();
      if (!current.bindingsLoading) void loader.refresh();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [active, loader]);
  useEffect(() => { controls.setActive(active); return () => controls.setActive(false); }, [active, controls]);
  useEffect(() => { if (active && controlState.revision > 0) void loader.refresh(); }, [active, controlState.revision, loader]);
  return <InboxView active={active} state={state} loader={loader} controls={{ state: controlState, loader: controls }} />;
}
