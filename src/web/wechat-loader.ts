import { WechatApiError, wechatApi } from './wechat-api.js';
import { createWechatQrLoader, EMPTY_QR, type WechatQrState } from './wechat-qr-loader.js';

export type BindingOperation = {
  readonly busy: '' | 'unlink';
  readonly status: 'unlinked' | null;
  readonly error: string;
};
export interface WechatState {
  readonly bindings: Readonly<Record<string, BindingOperation>>;
  readonly revision: number;
  readonly qr: WechatQrState;
}
export const INITIAL_WECHAT_STATE: WechatState = { bindings: {}, revision: 0, qr: EMPTY_QR };
const EMPTY_BINDING: BindingOperation = { busy: '', status: null, error: '' };

export function createWechatLoader(onChange: (state: WechatState) => void) {
  let state = INITIAL_WECHAT_STATE;
  let active = false;
  const requests = new Map<string, AbortController>();
  const update = (patch: Partial<WechatState>) => { state = { ...state, ...patch }; onChange(state); };
  const patchBinding = (id: string, patch: Partial<BindingOperation>) => update({
    bindings: { ...state.bindings, [id]: { ...(state.bindings[id] ?? EMPTY_BINDING), ...patch } },
  });
  const qr = createWechatQrLoader((value) => update({ qr: value }), () => update({ revision: state.revision + 1,
    bindings: Object.fromEntries(Object.entries(state.bindings).map(([id, operation]) => [id, { ...operation, status: null }])),
  }));
  const unlink = async (id: string) => {
    if (!active || requests.has(id)) return;
    const current = new AbortController();
    requests.set(id, current);
    const valid = () => active && requests.get(id) === current && !current.signal.aborted;
    patchBinding(id, { busy: 'unlink', error: '' });
    try {
      const result = await wechatApi.unlink(id, current.signal);
      if (valid()) {
        patchBinding(id, { status: result.status });
        update({ revision: state.revision + 1 });
      }
    } catch (error) {
      if (valid()) patchBinding(id, { error: error instanceof WechatApiError ? error.message : '无法连接服务，请检查网络后重试。' });
    } finally {
      if (requests.get(id) === current) { requests.delete(id); patchBinding(id, { busy: '' }); }
    }
  };
  return {
    getState: () => state,
    setActive(value: boolean) {
      if (active === value) return;
      active = value;
      if (value) return;
      qr.stop();
      for (const [id, current] of requests) { current.abort(); patchBinding(id, { busy: '' }); }
      requests.clear();
    },
    startQr: () => { if (active && state.qr.status !== 'loading' && state.qr.qr === null) qr.start(); },
    cancelQr: qr.stop,
    unlink,
  };
}
export type WechatLoader = ReturnType<typeof createWechatLoader>;
