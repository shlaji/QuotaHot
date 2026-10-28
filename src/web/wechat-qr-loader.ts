import { wechatApi, type WechatQr, type WechatQrStatus } from './wechat-api.js';

export interface WechatQrState {
  readonly qr: WechatQr | null;
  readonly status: WechatQrStatus | 'idle' | 'loading';
  readonly error: string;
}
export const EMPTY_QR: WechatQrState = { qr: null, status: 'idle', error: '' };

export function createWechatQrLoader(onChange: (state: WechatQrState) => void, onConfirmed: () => void) {
  let request: AbortController | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let qr: WechatQr | null = null;

  const cancel = (id: string) => {
    void wechatApi.cancelQr(id, AbortSignal.timeout(5000)).catch((error: unknown) => {
      if (error instanceof Error) return;
      throw error;
    });
  };
  const clearTimers = () => {
    clearTimeout(pollTimer);
    clearTimeout(deadlineTimer);
    pollTimer = undefined;
    deadlineTimer = undefined;
  };
  const stop = () => {
    request?.abort();
    request = null;
    clearTimers();
    if (qr !== null) cancel(qr.attemptId);
    qr = null;
    onChange(EMPTY_QR);
  };
  const start = async () => {
    stop();
    const current = new AbortController();
    request = current;
    onChange({ qr: null, status: 'loading', error: '' });
    try {
      const created = await wechatApi.startQr(current.signal);
      if (request !== current || current.signal.aborted) { cancel(created.attemptId); return; }
      qr = created;
      const finish = (status: 'confirmed' | 'expired' | 'unavailable', error = '') => {
        if (request !== current || current.signal.aborted) return;
        clearTimers();
        request = null;
        qr = null;
        current.abort();
        if (status !== 'confirmed') cancel(created.attemptId);
        onChange({ qr: null, status, error });
      };
      const expired = () => {
        if (request !== current || current.signal.aborted) return true;
        if (Date.now() < created.expiresAt) return false;
        finish('expired');
        return true;
      };
      const poll = async (): Promise<void> => {
        if (expired()) return;
        try {
          const result = await wechatApi.pollQr(created.attemptId, current.signal);
          if (expired()) return;
          switch (result.status) {
            case 'waiting': case 'scanned': case 'unverified':
              pollTimer = setTimeout(() => void poll(), 2000);
              onChange({ qr: created, status: result.status, error: '' });
              break;
            case 'confirmed': finish('confirmed'); onConfirmed(); break;
            case 'expired': case 'unavailable': finish(result.status); break;
            default: result.status satisfies never;
          }
        } catch (error) {
          if (expired()) return;
          finish('unavailable', error instanceof Error ? error.message : String(error));
        }
      };
      if (expired()) return;
      deadlineTimer = setTimeout(() => { expired(); }, created.expiresAt - Date.now());
      pollTimer = setTimeout(() => void poll(), 2000);
      onChange({ qr: created, status: 'waiting', error: '' });
    } catch (error) {
      if (request === current && !current.signal.aborted) onChange({ qr: null, status: 'unavailable', error: error instanceof Error ? error.message : String(error) });
    }
  };
  return { start: () => { void start(); }, stop };
}
