import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { IlinkClientError, type IlinkUpdates } from '../../src/server/wechat-inbox/client.js';
import { WechatInboxPoller, type InboxPollerDependencies } from '../../src/server/wechat-inbox/poller.js';

export const binding = { baseUrl: 'https://example.invalid/', botToken: 'private-token' };
export const update: IlinkUpdates = { kind: 'updates', msgs: [{ kind: 'message', message: {
  message_id: '18446744073709551615', message_type: 1, from_user_id: 'contact',
  direction: 'inbound', contactUserId: 'contact',
} }], get_updates_buf: 'opaque-next' };
export function deferred<Value>() {
  let resolve: (value: Value) => void = () => assert.fail('uninitialized resolver');
  let reject: (error: unknown) => void = () => assert.fail('uninitialized rejecter');
  const promise = new Promise<Value>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function fixture(t: TestContext, overrides: Partial<InboxPollerDependencies> = {}) {
  const requests: { owner: string; cursor: string; timeoutMs?: number; signal?: AbortSignal;
    reply: ReturnType<typeof deferred<IlinkUpdates>> }[] = [];
  const waits: { ms: number; signal: AbortSignal; gate: ReturnType<typeof deferred<void>> }[] = [];
  const processed: IlinkUpdates[] = [];
  const cursors = new Map([['owner', 'persisted-cursor']]);
  const dependencies: InboxPollerDependencies = {
    store: { getCursor: (owner) => cursors.get(owner) ?? '' },
    createClient: (owner) => ({ getUpdates: (cursor = '', options = {}) => {
      const reply = deferred<IlinkUpdates>();
      requests.push({ owner, cursor, ...options, reply });
      options.signal?.addEventListener('abort', () => reply.reject(new IlinkClientError('aborted')), { once: true });
      return reply.promise;
    } }),
    processUpdates: async (owner, batch) => {
      processed.push(batch);
      if (batch.get_updates_buf) cursors.set(owner, batch.get_updates_buf);
    },
    sleep: (ms, signal) => {
      const gate = deferred<void>();
      waits.push({ ms, signal, gate });
      signal.addEventListener('abort', () => gate.reject(new IlinkClientError('aborted')), { once: true });
      return gate.promise;
    },
    ...overrides,
  };
  const poller = new WechatInboxPoller(dependencies);
  t.after(() => poller.shutdown());
  return { poller, requests, waits, processed, cursors };
}
