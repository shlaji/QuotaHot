import { setTimeout as delay } from 'node:timers/promises';
import { IlinkClientError, type IlinkBinding, type IlinkBotClient, type IlinkUpdates } from './client.js';

export const INBOX_POLL_DEFAULT_TIMEOUT_MS = 35_000;
export const INBOX_POLL_BACKOFF_INITIAL_MS = 1_000;
export const INBOX_POLL_BACKOFF_MAX_MS = 30_000;
const MAX_TIMER_MS = 2_147_483_647;

export type InboxPollState = 'stopped' | 'starting' | 'polling' | 'backoff' | 'relogin_required';
export interface InboxPollerDependencies {
  readonly store: { getCursor(owner: string): string };
  readonly createClient: (owner: string, binding: IlinkBinding) => Pick<IlinkBotClient, 'getUpdates'>;
  readonly processUpdates: (owner: string, update: IlinkUpdates, options?: { readonly signal?: AbortSignal }) => Promise<void>;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly notifyStart?: (owner: string, binding: IlinkBinding) => void | Promise<void>;
  readonly notifyStop?: (owner: string, binding: IlinkBinding) => void | Promise<void>;
}

interface Worker {
  readonly controller: AbortController;
  done: Promise<void>;
  state: InboxPollState;
}

export class WechatInboxPoller {
  private readonly workers = new Map<string, Worker>();
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private closed = false;

  constructor(private readonly dependencies: InboxPollerDependencies) {
    this.sleep = dependencies.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
  }

  start(owner: string, binding: IlinkBinding): void {
    if (this.closed) return;
    const prior = this.workers.get(owner);
    if (prior && !prior.controller.signal.aborted) return;
    const worker: Worker = { controller: new AbortController(), done: Promise.resolve(), state: 'starting' };
    this.workers.set(owner, worker);
    worker.done = (prior?.done ?? Promise.resolve()).then(() => this.run(owner, binding, worker));
  }

  getState(owner: string): InboxPollState {
    return this.workers.get(owner)?.state ?? 'stopped';
  }

  async stop(owner: string): Promise<void> {
    const worker = this.workers.get(owner);
    if (!worker) return;
    worker.state = 'stopped';
    worker.controller.abort();
    await worker.done;
    if (this.workers.get(owner) === worker) this.workers.delete(owner);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.workers.keys()].map((owner) => this.stop(owner)));
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await this.stopAll();
  }

  private async run(owner: string, binding: IlinkBinding, worker: Worker): Promise<void> {
    const { signal } = worker.controller;
    if (signal.aborted) return;
    void this.notify(this.dependencies.notifyStart, owner, binding);
    let client: Pick<IlinkBotClient, 'getUpdates'> | undefined;
    let timeoutMs = INBOX_POLL_DEFAULT_TIMEOUT_MS;
    let backoffMs = 0;
    try {
      while (!signal.aborted) {
        try {
          if (backoffMs > 0) await this.sleep(backoffMs, signal);
          if (signal.aborted) return;
          client ??= this.dependencies.createClient(owner, binding);
          const cursor = this.dependencies.store.getCursor(owner);
          worker.state = 'polling';
          const update = await client.getUpdates(cursor, { timeoutMs, signal });
          if (signal.aborted) return;
          const timeout = update.longpolling_timeout_ms;
          if (timeout !== undefined && Number.isSafeInteger(timeout) && timeout > 0 && timeout <= MAX_TIMER_MS) {
            timeoutMs = timeout;
          }
          await this.dependencies.processUpdates(owner, update, { signal });
          backoffMs = 0;
        } catch (error) {
          if (signal.aborted) return;
          if (error instanceof IlinkClientError && error.code === 'auth_required') {
            worker.state = 'relogin_required';
            return;
          }
          backoffMs = Math.min(backoffMs === 0 ? INBOX_POLL_BACKOFF_INITIAL_MS : backoffMs * 2,
            INBOX_POLL_BACKOFF_MAX_MS);
          worker.state = 'backoff';
        }
      }
    } finally {
      void this.notify(this.dependencies.notifyStop, owner, binding);
    }
  }

  private async notify(hook: InboxPollerDependencies['notifyStart'], owner: string, binding: IlinkBinding): Promise<boolean> {
    try {
      await hook?.(owner, binding);
      return true;
    } catch {
      return false;
    }
  }
}
