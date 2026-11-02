import type { WechatBindingSummary, WechatMessage } from '../../shared/wechat-inbox.js';
import { inboxApi, InboxApiError, type InboxSend, type InboxTarget } from './api.js';
import type { SendOutcome } from './errors.js';

interface TargetState {
  readonly draft: string;
  readonly sending: '' | 'text' | 'media';
  readonly outcome: SendOutcome | null;
  readonly sendError: string;
  readonly typing: boolean;
  readonly typingBusy: boolean;
  readonly typingError: string;
}
const EMPTY_TARGET: TargetState = { draft: '', sending: '', outcome: null, sendError: '', typing: false, typingBusy: false, typingError: '' };
export interface InboxState extends TargetState {
  readonly bindings: readonly WechatBindingSummary[];
  readonly bindingId: string;
  readonly messages: readonly WechatMessage[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly bindingsLoading: boolean;
  readonly messagesLoading: boolean;
  readonly bindingsError: string;
  readonly messagesError: string;
}
export const INITIAL_INBOX_STATE: InboxState = { ...EMPTY_TARGET, bindings: [], bindingId: '', messages: [],
  nextCursor: null, hasMore: false, bindingsLoading: false, messagesLoading: false, bindingsError: '', messagesError: '' };
const safeError = (error: unknown) => error instanceof InboxApiError ? error.message : '无法连接服务，请检查网络后刷新。';

export function createInboxLoader(onChange: (state: InboxState) => void) {
  let state = INITIAL_INBOX_STATE;
  let active = false;
  let bindingRequest: AbortController | undefined;
  let messageRequest: AbortController | undefined;
  const targets = new Map<string, TargetState>();
  const draftRevisions = new Map<string, number>();
  const sends = new Map<string, AbortController>();
  const typingChains = new Map<string, Promise<void>>();
  const update = (patch: Partial<InboxState>) => { state = { ...state, ...patch }; onChange(state); };
  const target = (): InboxTarget => state.bindingId;
  const patchTarget = (value: InboxTarget, patch: Partial<TargetState>) => {
    const next = { ...(targets.get(value) ?? EMPTY_TARGET), ...patch };
    targets.set(value, next);
    if (value === target()) update(next);
  };
  const canSend = () => active && !state.bindingsError && state.bindings.some((item) =>
    item.ownerIlinkUserId === state.bindingId && item.canSend && item.replyContextState === 'ready');
  const canTypeFor = (value: InboxTarget) => active && !state.bindingsError && state.bindings.some((item) =>
    item.ownerIlinkUserId === value && item.canSend && item.replyContextState === 'ready');
  const typingFor = (value: InboxTarget, status: 'typing' | 'cancel') => {
    patchTarget(value, { typing: status === 'typing', typingBusy: true, typingError: '' });
    const previous = typingChains.get(value) ?? Promise.resolve();
    const operation = previous.then(async () => {
      if (!canTypeFor(value)) { patchTarget(value, { typing: false }); return; }
      try { await inboxApi.typing(value, status, AbortSignal.timeout(10_000)); }
      catch (error) { if (typingChains.get(value) === operation) patchTarget(value, { typing: false, typingError: safeError(error) }); }
    }).finally(() => {
      if (typingChains.get(value) === operation) { typingChains.delete(value); patchTarget(value, { typingBusy: false }); }
    });
    typingChains.set(value, operation);
    return operation;
  };
  const cancelTyping = () => { if (state.typing && state.bindingId) void typingFor(target(), 'cancel'); };
  const selectBinding = async (bindingId: string) => {
    if (!active) return;
    cancelTyping();
    messageRequest?.abort();
    update({ ...(targets.get(bindingId) ?? EMPTY_TARGET), bindingId, messages: [], nextCursor: null, hasMore: false,
      messagesLoading: false, messagesError: '' });
    await readMessages();
  };
  const refresh = async () => {
    if (!active) return;
    bindingRequest?.abort();
    const current = new AbortController();
    bindingRequest = current;
    update({ bindingsLoading: true, bindingsError: '' });
    try {
      const bindings = await inboxApi.bindings(current.signal);
      if (!active || current.signal.aborted || bindingRequest !== current) return;
      update({ bindings });
      if (!canSend()) cancelTyping();
    } catch (error) {
      if (active && !current.signal.aborted && bindingRequest === current) update({ bindingsError: safeError(error) });
    } finally {
      if (active && !current.signal.aborted && bindingRequest === current) update({ bindingsLoading: false });
    }
  };
  const readMessages = async (older = false) => {
    if (!active || !state.bindingId || (older && (!state.hasMore || state.messagesLoading))) return;
    messageRequest?.abort();
    const current = new AbortController();
    messageRequest = current;
    const bindingId = state.bindingId;
    update({ messagesLoading: true, messagesError: '' });
    try {
      const page = await inboxApi.messages(bindingId, { before: older ? state.nextCursor : null }, current.signal);
      if (!active || current.signal.aborted || messageRequest !== current || bindingId !== state.bindingId) return;
      const merged = new Map((older ? state.messages : []).map((item) => [item.id, item]));
      for (const item of page.items) merged.set(item.id, item);
      update({ messages: [...merged.values()].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id)),
        nextCursor: page.nextCursor, hasMore: page.hasMore });
    } catch (error) {
      if (active && !current.signal.aborted && messageRequest === current) update({ messagesError: safeError(error) });
    } finally {
      if (active && !current.signal.aborted && messageRequest === current) update({ messagesLoading: false });
    }
  };
  return {
    getState: () => state,
    setActive(value: boolean) {
      if (active === value) return;
      active = value;
      if (value) { void refresh(); if (state.bindingId) void readMessages(); return; }
      cancelTyping();
      bindingRequest?.abort(); messageRequest?.abort();
      for (const [key, controller] of sends) {
        controller.abort();
        targets.set(key, { ...(targets.get(key) ?? EMPTY_TARGET), sending: '', outcome: 'unknown' });
      }
      sends.clear();
      update({ ...(targets.get(target()) ?? EMPTY_TARGET), bindingsLoading: false, messagesLoading: false });
    },
    refresh,
    selectBinding,
    refreshMessages: () => readMessages(),
    loadMore: () => readMessages(true),
    setDraft: (draft: string) => { if (state.bindingId) { const value = target(); draftRevisions.set(value, (draftRevisions.get(value) ?? 0) + 1); patchTarget(value, { draft }); } },
    typing: (status: 'typing' | 'cancel') => canSend() ? typingFor(target(), status) : Promise.resolve(),
    async send(input: InboxSend) {
      if (!canSend() || !state.bindingId || (input.kind === 'text' && !input.text.trim()) || input.kind === 'voice') return;
      const value = target();
      if (sends.has(value)) return;
      const draftRevision = draftRevisions.get(value);
      const current = new AbortController();
      sends.set(value, current);
      cancelTyping();
      patchTarget(value, { sending: input.kind === 'text' ? 'text' : 'media', outcome: null, sendError: '' });
      try {
        const result = await inboxApi.send(value, input, current.signal);
        if (current.signal.aborted || sends.get(value) !== current) return;
        const draft = targets.get(value)?.draft ?? '';
        patchTarget(value, { outcome: result.state, ...(result.state === 'accepted' && input.kind === 'text' && draft === input.text && draftRevisions.get(value) === draftRevision ? { draft: '' } : {}) });
        if (value === state.bindingId) void readMessages();
      } catch (error) {
        if (!current.signal.aborted && sends.get(value) === current) patchTarget(value, {
          outcome: error instanceof InboxApiError ? error.outcome : 'unknown', sendError: safeError(error),
        });
      } finally {
        if (sends.get(value) === current) { sends.delete(value); patchTarget(value, { sending: '' }); }
      }
    },
  };
}
export type InboxLoader = ReturnType<typeof createInboxLoader>;
