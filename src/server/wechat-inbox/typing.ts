import type { WechatSessionStore } from '../wechat-session-store.js';
import type { WechatInboxStore } from './store.js';
import { InboxSendAccess, type InboxSenderOptions, type InboxTarget } from './sender.js';
import { IlinkBotClient } from './client.js';

interface Ticket { readonly ticket: string; readonly context: string | null; readonly expiresAt: number; readonly revision: number }
export type InboxTypingResult = { readonly ok: true; readonly errorCode: null }
  | { readonly ok: false; readonly errorCode: 'typing_unavailable' | 'typing_failed' };

export class WechatInboxTyping {
  readonly #tickets = new Map<string, Ticket>();
  private readonly access: InboxSendAccess;
  constructor(sessions: WechatSessionStore, private readonly store: WechatInboxStore,
    private readonly options: InboxSenderOptions = {}) { this.access = new InboxSendAccess(sessions, store, options); }
  async send(command: InboxTarget & { readonly status: 1 | 2 }): Promise<InboxTypingResult> {
    const { binding, revision } = this.access.resolve(command);
    const key = command.owner;
    try {
      const now = (this.options.now ?? Date.now)();
      for (const [cachedKey, entry] of this.#tickets) if (entry.expiresAt <= now) this.#tickets.delete(cachedKey);
      const context = this.store.getLatestContextToken(command.owner);
      const client = this.options.createClient?.(binding) ?? new IlinkBotClient(binding);
      let cached = this.#tickets.get(key);
      if (!cached || cached.context !== context || cached.revision !== revision) {
        this.#tickets.delete(key);
        const config = await client.getConfig(command.owner, context ?? undefined);
        this.access.assertCurrent(command, revision);
        if (!config.typingTicket) return { ok: false, errorCode: 'typing_unavailable' };
        cached = { ticket: config.typingTicket, context, expiresAt: now + 86400000, revision };
        this.#tickets.set(key, cached);
      }
      this.access.assertCurrent(command, revision);
      await client.sendTyping(command.owner, cached.ticket, command.status);
      return { ok: true, errorCode: null };
    } catch {
      this.#tickets.delete(key);
      return { ok: false, errorCode: 'typing_failed' };
    }
  }
}
