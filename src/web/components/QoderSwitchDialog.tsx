import { useEffect, useId, useRef, useState } from 'react';
import type { QoderClient, QoderClientTarget, QoderSwitchResult } from '../../shared/qoder.js';
import { api } from '../api.js';

interface Props {
  accountId: string;
  email: string;
  open: boolean;
  onClose: () => void;
  onSwitched: () => void;
}

const MANUAL_RESTART_MESSAGE = {
  'qoder-cli': 'Qoder CLI 不会自动重启，请启动新的 CLI 会话使用此账户。',
  'qoder-desktop': '客户端未自动重启，请手动重新打开。',
  'qoder-ide': '客户端未自动重启，请手动重新打开。',
} as const satisfies Readonly<Record<QoderClient, string>>;

export function QoderSwitchDialog({ accountId, email, open, onClose, onSwitched }: Props) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const submittingRef = useRef(false);
  const [targets, setTargets] = useState<QoderClientTarget[] | null>(null);
  const [selected, setSelected] = useState<QoderClient | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<QoderSwitchResult | null>(null);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    setTargets(null);
    setSelected(null);
    setAcknowledged(false);
    setLoading(true);
    setError('');
    setResult(null);
    let stale = false;
    api
      .qoderClients(accountId)
      .then((next) => {
        if (!stale) setTargets(next);
      })
      .catch((err: unknown) => {
        if (!stale) setError(String(err instanceof Error ? err.message : err));
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [accountId, open]);

  useEffect(() => {
    if (!open) return;

    const activeElement = document.activeElement;
    previousFocusRef.current = activeElement instanceof HTMLElement ? activeElement : null;
    dialogRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!submittingRef.current) onCloseRef.current();
        return;
      }

      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (dialog === null) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      const first = focusable.at(0);
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const focused = document.activeElement;
      if (!dialog.contains(focused) || focused === dialog) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && focused === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && focused === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      const previousFocus = previousFocusRef.current;
      previousFocusRef.current = null;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [open]);

  if (!open) return null;

  const selectedTarget = targets?.find((target) => target.client === selected);
  const submitDisabled =
    loading || submitting || selectedTarget === undefined || !selectedTarget.available || !acknowledged;

  const requestClose = () => {
    if (!submittingRef.current) onClose();
  };

  const submit = async () => {
    if (submittingRef.current || submitDisabled || selected === null) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError('');
    try {
      const switched = await api.qoderSwitch(accountId, selected);
      setResult(switched);
      onSwitched();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={requestClose}>
      <div
        ref={dialogRef}
        className="modal qoder-switch-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={loading || submitting}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <h2 id={titleId}>切换 Qoder 账户<span className="qoder-switch-email">{email}</span></h2>
          <button type="button" className="link" disabled={submitting} onClick={requestClose}>
            关闭
          </button>
        </header>
        <div className="modal-body">
          <p id={descriptionId} className="probe-meta">
            选择一个 Qoder 客户端，切换为账户「{email}」。
          </p>
          {loading && (
            <p className="empty" role="status">
              检查可用客户端…
            </p>
          )}
          {error && (
            <p className="probe-error" role="alert">
              {error}
            </p>
          )}
          {targets !== null && (
            <div className="qoder-targets" role="radiogroup" aria-label="Qoder 客户端">
              {targets.map((target) => (
                <label className={`qoder-target${target.available ? '' : ' unavailable'}`} key={target.client}>
                  <input
                    type="radio"
                    name="qoder-client"
                    value={target.client}
                    checked={selected === target.client}
                    disabled={!target.available || submitting}
                    onChange={() => {
                      setSelected(target.client);
                      setAcknowledged(false);
                    }}
                  />
                  <span>
                    <strong>
                      {target.label}
                      {target.current && <span className="qoder-current">当前</span>}
                    </strong>
                    <small>{target.path}</small>
                    {!target.available && <small className="bad">不可用：{target.reason}</small>}
                  </span>
                </label>
              ))}
            </div>
          )}
          <label className="qoder-ack">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={submitting}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span className="qoder-ack-copy">
              <span>我已保存工作并同意切换账户。</span>
              <span>GUI 将关闭并重启。</span>
              <span>CLI 已退出全部运行中的会话。</span>
            </span>
          </label>
          {result && (
            <section className="qoder-result" aria-live="polite">
              <strong>已切换到 {result.label}</strong>
              <p>{result.note}</p>
              <small>{result.restarted ? '客户端已请求重启。' : MANUAL_RESTART_MESSAGE[result.client]}</small>
              {result.backupPath && <small>备份：{result.backupPath}</small>}
            </section>
          )}
          <div className="modal-actions">
            {result ? (
              <button type="button" className="primary" onClick={requestClose}>
                完成
              </button>
            ) : (
              <button type="button" className="primary" disabled={submitDisabled} onClick={() => void submit()}>
                {submitting ? '切换中…' : '确认切换'}
              </button>
            )}
            {!result && (
              <button type="button" className="link" disabled={submitting} onClick={requestClose}>
                取消
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
