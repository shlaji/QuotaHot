import { useEffect, useRef } from 'react';
import type { WechatLoader, WechatState } from '../wechat-loader.js';
import type { WechatQrState } from '../wechat-qr-loader.js';
import { formatMessageTime } from './time.js';

export type BindingControls = { readonly state: WechatState; readonly loader: WechatLoader };
export type UnlinkConfirmation = { readonly bindingId: string; readonly trigger: HTMLButtonElement };
const QR_LABELS: Readonly<Record<WechatQrState['status'], string>> = {
  idle: '', loading: '正在生成二维码…', waiting: '请用微信扫码并确认', scanned: '已扫码，请在微信确认',
  confirmed: '扫码已确认', expired: '二维码已过期，请重新生成。', unavailable: '扫码已不可用，请重试。', unverified: '暂未核验，正在继续检查…',
};

export function BindingQr({ controls, onCancel }: { readonly controls: BindingControls; readonly onCancel: (restoreFocus: boolean) => void }) {
  const { state: { qr } } = controls;
  const expiry = qr.qr === null ? null : formatMessageTime(new Date(qr.qr.expiresAt).toISOString());
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (qr.status === 'loading') container.current?.scrollIntoView({ block: 'nearest' });
  }, [qr.status]);
  if (qr.status === 'idle') return null;
  return <div ref={container} className="wechat-qr" aria-live="polite" aria-busy={qr.status === 'loading'}>
    {(qr.status === 'loading' || qr.qr !== null) && <div className="wechat-qr-media">
      {qr.qr !== null && <img width={200} height={200} alt="微信添加用户二维码"
        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.qr.qrSvg)}`} />}
    </div>}
    <p role="status">{QR_LABELS[qr.status]}</p>
    {(qr.status === 'loading' || qr.qr !== null) && <p className="wechat-note wechat-qr-expiry">
      {qr.qr !== null && expiry !== null ? <><time dateTime={new Date(qr.qr.expiresAt).toISOString()} title={expiry.absolute}>{expiry.relative}</time>过期；切离本页会取消扫码。</>
        : '有效期将在二维码生成后显示；切离本页会取消扫码。'}</p>}
    <button type="button" onClick={(event) => onCancel(event.currentTarget === document.activeElement)}>
      {qr.status === 'loading' || qr.qr !== null ? '取消扫码' : '关闭扫码提示'}</button>
    {qr.error && <p role="alert">{qr.error}</p>}
  </div>;
}

export function BindingActions({ bindingId, active, linked, controls, confirmation, onConfirm, onCancel }: {
  readonly bindingId: string; readonly active: boolean; readonly controls: BindingControls;
  readonly linked: boolean;
  readonly confirmation: UnlinkConfirmation | null; readonly onConfirm: (value: UnlinkConfirmation) => void; readonly onCancel: () => void;
}) {
  const operation = controls.state.bindings[bindingId];
  const busy = Boolean(operation?.busy);
  return <div aria-busy={busy}>
    <div className="wechat-actions wechat-binding-actions">
      <button type="button" className="ghost" disabled={!active || busy || !linked}
        onClick={(event) => onConfirm({ bindingId, trigger: event.currentTarget })}>解除本地绑定</button>
    </div>
    {confirmation?.bindingId === bindingId && <div className="wechat-confirm" aria-label={`确认解除 ${bindingId}`}>
      <p>解除 {bindingId} 的本地绑定？</p>
      <p>不会撤销<span className="wechat-phrase">微信上游授权。</span></p>
      <p>已保存的消息历史会保留。</p>
      <div className="wechat-actions"><button type="button" onClick={onCancel}>取消</button>
        <button type="button" className="danger" disabled={!active || busy} onClick={(event) => {
          const selection = event.currentTarget.closest('li')?.querySelector('button');
          void controls.loader.unlink(confirmation.bindingId); onCancel(); selection?.focus();
        }}>确认解除</button></div>
    </div>}
    {busy && <p className="wechat-note" role="status">正在解除本地绑定…</p>}
    {operation?.status === 'unlinked' && <p className="wechat-note" role="status">已解除本地绑定，历史仍可查看</p>}
    {operation?.error && <p role="alert">{operation.error}</p>}
  </div>;
}
