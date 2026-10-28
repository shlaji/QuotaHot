import { dingtalkInboxApi, DingtalkInboxApiError, type Candidate, type Capability, type DingtalkInboxApi, type SubscriptionState, type Target, type TargetType } from './api.js';

export interface DingtalkInboxState {
  readonly active: boolean;
  readonly connection: 'idle' | 'loading' | 'ready' | 'error';
  readonly capability: Capability | null;
  readonly connectionError: string;
  readonly kind: TargetType;
  readonly query: string;
  readonly searchStatus: 'idle' | 'loading' | 'ready' | 'empty' | 'incomplete' | 'error';
  readonly items: readonly Candidate[];
  readonly searchError: string;
  readonly activeTarget: Target | null;
  readonly subscriptionState: SubscriptionState | null;
  readonly listeningDesired: boolean;
  readonly selecting: boolean;
  readonly selectionError: string;
}
export const INITIAL_DINGTALK_INBOX_STATE: DingtalkInboxState = {
  active: false, connection: 'idle', capability: null, connectionError: '', kind: 'person', query: '',
  searchStatus: 'idle', items: [], searchError: '', activeTarget: null, subscriptionState: null,
  listeningDesired: false, selecting: false, selectionError: '',
};
export function targetKey(target: Pick<Target, 'targetType' | 'targetId'>): string {
  return JSON.stringify([target.targetType, target.targetId]);
}
function errorMessage(error: unknown): string {
  return error instanceof DingtalkInboxApiError ? error.message : new DingtalkInboxApiError('network').message;
}
export function createDingtalkInboxLoader(onState: (state: DingtalkInboxState) => void, api: DingtalkInboxApi = dingtalkInboxApi) {
  let state = INITIAL_DINGTALK_INBOX_STATE;
  let connectionRequest: AbortController | undefined;
  let searchRequest: AbortController | undefined;
  let selectionRequest: AbortController | undefined;
  const update = (patch: Partial<DingtalkInboxState>) => { state = { ...state, ...patch }; onState(state); };
  const clearSearch = () => {
    searchRequest?.abort();
    searchRequest = undefined;
    update({ items: [], searchStatus: 'idle', searchError: '' });
  };
  async function refresh(): Promise<void> {
    if (!state.active || state.selecting) return;
    connectionRequest?.abort();
    clearSearch();
    const request = new AbortController();
    connectionRequest = request;
    update({ connection: 'loading', capability: null, connectionError: '', activeTarget: null,
      subscriptionState: null, listeningDesired: false, selectionError: '' });
    try {
      const capability = await api.capability(request.signal);
      if (request.signal.aborted || connectionRequest !== request) return;
      if (!capability.available) { update({ capability, connection: 'ready' }); return; }
      const active = await api.activeTarget(request.signal);
      if (request.signal.aborted || connectionRequest !== request) return;
      update({ capability, connection: 'ready', ...active });
    } catch (error: unknown) {
      if (request.signal.aborted || connectionRequest !== request) return;
      update({ connection: 'error', capability: null, connectionError: errorMessage(error) });
    }
  }
  async function setActive(active: boolean): Promise<void> {
    if (state.active === active) return;
    if (active) { update({ active }); await refresh(); return; }
    connectionRequest?.abort();
    searchRequest?.abort();
    selectionRequest?.abort();
    connectionRequest = undefined;
    searchRequest = undefined;
    selectionRequest = undefined;
    state = INITIAL_DINGTALK_INBOX_STATE;
    onState(state);
  }
  function setQuery(query: string): void {
    if (state.selecting) return;
    clearSearch();
    update({ query });
  }
  function setKind(kind: TargetType): void {
    if (state.selecting) return;
    clearSearch();
    update({ kind });
  }
  async function search(): Promise<void> {
    if (!state.active || state.connection !== 'ready' || !state.capability?.available || state.selecting) return;
    clearSearch();
    const query = state.query.trim();
    if (!query) return;
    const request = new AbortController();
    searchRequest = request;
    update({ searchStatus: 'loading', selectionError: '' });
    try {
      const result = await api.search(state.kind, query, request.signal);
      if (request.signal.aborted || searchRequest !== request) return;
      update({ items: result.items, searchStatus: !result.complete ? 'incomplete' : result.items.length === 0 ? 'empty' : 'ready' });
    } catch (error: unknown) {
      if (request.signal.aborted || searchRequest !== request) return;
      update({ items: [], searchStatus: 'error', searchError: errorMessage(error) });
    }
  }
  async function select(key: string): Promise<void> {
    if (!state.active || state.connection !== 'ready' || !state.capability?.available || state.searchStatus !== 'ready' || state.selecting) return;
    const candidate = state.items.find((item) => targetKey(item) === key);
    if (candidate === undefined) return;
    const selected: Target = { targetType: candidate.targetType, targetId: candidate.targetId, displayName: candidate.displayName };
    const request = new AbortController();
    selectionRequest = request;
    update({ selecting: true, selectionError: '' });
    try {
      const subscriptionState = await api.select(selected, request.signal);
      if (request.signal.aborted || selectionRequest !== request) return;
      update({ activeTarget: selected, subscriptionState, listeningDesired: true });
    } catch (error: unknown) {
      if (request.signal.aborted || selectionRequest !== request) return;
      clearSearch();
      update({ activeTarget: null, subscriptionState: null, listeningDesired: false,
        selectionError: `${errorMessage(error)} 选择结果未确认，请重新检查连接。` });
    } finally {
      if (selectionRequest === request && !request.signal.aborted) { selectionRequest = undefined; update({ selecting: false }); }
    }
  }
  return { setActive, refresh, setQuery, setKind, search, select };
}
export type DingtalkInboxLoader = ReturnType<typeof createDingtalkInboxLoader>;
