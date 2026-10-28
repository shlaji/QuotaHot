import { createHash, randomBytes } from 'node:crypto';
import { WechatClawbotError, type QrLoginAttempt, type QrLoginStatus, type WechatClawbotClient } from './wechat-clawbot-client.js';
import type { ConfirmedWechatBinding, WechatSessionStore } from './wechat-session-store.js';

export type WechatLoginResult =
  | { readonly status: 'waiting' | 'scanned' | 'expired' | 'unavailable' | 'unverified' | 'identity_missing' }
  | { readonly status: 'confirmed' };
export interface WechatLoginOptions {
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Buffer;
  readonly beforeBindingChange?: (owner: string) => Promise<void>;
  readonly afterBindingChange?: (owner: string) => void;
}
type PollStatus = QrLoginStatus | { readonly status: 'identity_missing' };
type Capability = {
  readonly qr: QrLoginAttempt;
  readonly controller: AbortController;
  poll?: Promise<PollStatus | null>;
};
type PendingAttempt = Capability & {
  completing?: boolean;
  readonly flowTokenHash: string;
  readonly expiresAt: number;
  readonly unlinkedOwners: Set<string>;
};
type Creation = {
  readonly unlinkedOwners: Set<string>;
  readonly previousFlowHash?: string;
  readonly controller: AbortController;
};
const LIMIT = 128;
const ATTEMPT_LIFETIME = 600_000;
const digest = (token: string): string => createHash('sha256').update(token).digest('hex');

export class WechatLoginError extends Error {
  override readonly name = 'WechatLoginError';
  constructor(readonly code: 'capacity' | 'cancelled') { super(`WeChat login: ${code}`); }
}

export class WechatLoginService {
  readonly #store: WechatSessionStore;
  readonly #client: Pick<WechatClawbotClient, 'createQr'>;
  readonly #now: () => number;
  readonly #random: (size: number) => Buffer;
  readonly #attempts = new Map<string, PendingAttempt>();
  readonly #creations = new Map<string, Creation>();
  readonly #ownerChanges = new Map<string, Promise<unknown>>();
  readonly #ownerGenerations = new Map<string, number>();
  #closed = false;

  constructor(store: WechatSessionStore, client: Pick<WechatClawbotClient, 'createQr'>, private readonly options: WechatLoginOptions = {}) {
    this.#store = store;
    this.#client = client;
    this.#now = options.now ?? Date.now;
    this.#random = options.randomBytes ?? randomBytes;
  }

  async start(previousFlowToken?: string): Promise<{
    readonly attemptId: string; readonly qrPayload: string; readonly expiresAt: number; readonly flowToken: string;
  }> {
    if (this.#closed) throw new WechatLoginError('cancelled');
    for (const [id, attempt] of this.#attempts) {
      if (attempt.expiresAt <= this.#now()) this.#discard(id);
    }
    const previousFlowHash = previousFlowToken ? digest(previousFlowToken) : undefined;
    if (previousFlowHash) {
      for (const [id, creation] of this.#creations) {
        if (creation.previousFlowHash === previousFlowHash) {
          this.#creations.delete(id);
          creation.controller.abort();
        }
      }
      for (const [id, attempt] of this.#attempts) {
        if (attempt.flowTokenHash === previousFlowHash) this.#discard(id);
      }
    }
    if (this.#attempts.size + this.#creations.size >= LIMIT) throw new WechatLoginError('capacity');
    const attemptId = this.#random(32).toString('base64url');
    const flowToken = this.#random(32).toString('base64url');
    const controller = new AbortController();
    const creation: Creation = {
      controller, unlinkedOwners: new Set(),
      ...(previousFlowHash ? { previousFlowHash } : {}),
    };
    this.#creations.set(attemptId, creation);
    try {
      const qr = await this.#client.createQr(controller.signal);
      if (this.#creations.get(attemptId) !== creation) {
        throw new WechatLoginError('cancelled');
      }
      const expiresAt = this.#now() + ATTEMPT_LIFETIME;
      this.#attempts.set(attemptId, {
        qr, expiresAt, controller, flowTokenHash: digest(flowToken), unlinkedOwners: creation.unlinkedOwners,
      });
      return { attemptId, qrPayload: qr.qrPayload, expiresAt, flowToken };
    } finally {
      if (this.#creations.get(attemptId) === creation) this.#creations.delete(attemptId);
    }
  }

  cancel(attemptId: string, flowToken?: string): boolean {
    const attempt = this.#attempts.get(attemptId);
    if (!attempt || !flowToken || attempt.flowTokenHash !== digest(flowToken)) return false;
    this.#discard(attemptId);
    return true;
  }

  #discard(attemptId: string): void {
    const attempt = this.#attempts.get(attemptId);
    this.#attempts.delete(attemptId);
    attempt?.controller.abort();
  }

  async poll(attemptId: string, flowToken?: string): Promise<WechatLoginResult> {
    const attempt = this.#attempts.get(attemptId);
    if (!attempt || !flowToken || attempt.flowTokenHash !== digest(flowToken)) return { status: 'unavailable' };
    if (attempt.expiresAt <= this.#now()) {
      this.#discard(attemptId);
      return { status: 'expired' };
    }
    const status = await this.#poll(attempt);
    if (this.#attempts.get(attemptId) !== attempt || attempt.completing) return { status: 'unavailable' };
    if (attempt.expiresAt <= this.#now()) {
      this.#discard(attemptId);
      return { status: 'expired' };
    }
    if (status === null) return { status: 'unverified' };
    switch (status.status) {
      case 'waiting': case 'scanned': return { status: status.status };
      case 'expired': this.#discard(attemptId); return { status: 'expired' };
      case 'identity_missing': this.#discard(attemptId); return { status: 'identity_missing' };
      case 'confirmed': {
        attempt.completing = true;
        const binding = status.credentials;
        if (attempt.unlinkedOwners.has(binding.ownerIlinkUserId)) {
          this.#discard(attemptId);
          return { status: 'unavailable' };
        }
        const generation = this.#ownerGenerations.get(binding.ownerIlinkUserId);
        let previous: ConfirmedWechatBinding | null = null;
        let previousRevision = 0;
        let saved = false;
        return this.#changeOwner(binding.ownerIlinkUserId, async (): Promise<WechatLoginResult> => {
          previous = this.#store.getBinding(binding.ownerIlinkUserId);
          previousRevision = this.#store.getBindingRevision(binding.ownerIlinkUserId);
          await this.options.beforeBindingChange?.(binding.ownerIlinkUserId);
          if (attempt.expiresAt <= this.#now()) {
            this.#discard(attemptId);
            return { status: 'expired' };
          }
          if (generation !== this.#ownerGenerations.get(binding.ownerIlinkUserId)
            || attempt.controller.signal.aborted) return { status: 'unavailable' };
          this.#store.confirmBinding(binding, this.#now());
          saved = true;
          this.options.afterBindingChange?.(binding.ownerIlinkUserId);
          return { status: 'confirmed' };
        }).finally(async () => {
          this.#attempts.delete(attemptId);
          if (!saved) await this.#reconcileBinding(previous, generation, previousRevision);
        });
      }
      default: return assertNever(status);
    }
  }

  async unlink(owner: string): Promise<boolean> {
    const existed = this.#store.getBinding(owner) !== null;
    if (!existed) return false;
    this.#disableOwnerBinding(owner);
    await this.#changeOwner(owner, async () => {
      await this.options.beforeBindingChange?.(owner);
      this.#store.removeBinding(owner);
      this.options.afterBindingChange?.(owner);
    });
    return existed;
  }

  #disableOwnerBinding(owner: string): void {
    this.#store.pauseBinding(owner);
    this.#ownerGenerations.set(owner, (this.#ownerGenerations.get(owner) ?? 0) + 1);
    for (const [id, attempt] of this.#attempts) {
      attempt.unlinkedOwners.add(owner);
      if (attempt.unlinkedOwners.size >= LIMIT) this.#discard(id);
    }
    for (const [id, creation] of this.#creations) {
      creation.unlinkedOwners.add(owner);
      if (creation.unlinkedOwners.size >= LIMIT) {
        this.#creations.delete(id);
        creation.controller.abort();
      }
    }
  }

  async #changeOwner<Result>(owner: string, action: () => Promise<Result>): Promise<Result> {
    const prior = this.#ownerChanges.get(owner);
    const change = (prior ? prior.then(action, action) : action());
    this.#ownerChanges.set(owner, change);
    try { return await change; }
    finally { if (this.#ownerChanges.get(owner) === change) this.#ownerChanges.delete(owner); }
  }

  async #reconcileBinding(previous: ConfirmedWechatBinding | null, generation: number | undefined,
    revision: number): Promise<void> {
    if (!previous) return;
    const owner = previous.ownerIlinkUserId;
    await this.#changeOwner(owner, async () => {
      if (this.#closed || generation !== this.#ownerGenerations.get(owner)
        || this.#store.getBindingRevision(owner) !== revision
        || this.#store.isBindingPaused(owner)) return;
      const binding = this.#store.getBinding(owner);
      if (binding && binding.botId === previous.botId && binding.botToken === previous.botToken
        && binding.baseUrl === previous.baseUrl) this.options.afterBindingChange?.(owner);
    });
  }

  async shutdown(): Promise<void> {
    this.#closed = true;
    for (const id of this.#attempts.keys()) this.#discard(id);
    for (const creation of this.#creations.values()) creation.controller.abort();
    this.#creations.clear();
    await Promise.all(this.#ownerChanges.values());
  }

  #poll(capability: Capability): Promise<PollStatus | null> {
    if (capability.poll) return capability.poll;
    const polling = capability.qr.pollStatus(capability.controller.signal).catch((error: unknown): PollStatus | null => {
      if (error instanceof WechatClawbotError) {
        switch (error.code) {
          case 'auth_required': throw error;
          case 'identity_missing': return { status: 'identity_missing' };
          case 'http_failure': case 'invalid_response': case 'request_failed': return null;
          default: return assertNever(error.code);
        }
      }
      throw error;
    }).finally(() => { delete capability.poll; });
    capability.poll = polling;
    return polling;
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected QR status: ${String(value)}`);
}
