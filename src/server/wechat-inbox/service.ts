import type { WechatBindingSummary, WechatMessage, WechatMessagePage } from '../../shared/wechat-inbox.js';
import type { WechatSessionStore } from '../wechat-session-store.js';
import type { InboxItemInput, InboxMessageInput, WechatInboxStore } from './store.js';
import type { IlinkItemResult, IlinkJsonObject, IlinkUpdates } from './client.js';
import type { InboxPollState } from './poller.js';
import { downloadMedia, downloadPlainMedia, IlinkMediaError, messageItemKind, parseMediaKey, parseMediaMetadata } from './media.js';
import { InboxMediaStaging } from './media-staging.js';

export interface WechatInboxServiceOptions {
  readonly now?: () => number;
  readonly getPollState?: (owner: string) => InboxPollState;
  readonly cdnBaseUrl?: (owner: string) => string | undefined;
}
function unreachable(value: never): never { throw new TypeError(`Invalid inbox variant: ${typeof value}`); }
function object(value: unknown): value is IlinkJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function placeholder(reason: string): InboxItemInput {
  return { kind: 'protocol_event', text: '暂不支持或无法读取的消息内容', safeSummary: reason };
}
function optionalNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new IlinkMediaError('invalid_metadata');
  return value;
}
function cdnKey(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new IlinkMediaError('invalid_key');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new IlinkMediaError('invalid_key');
  return decoded.length === 32
    ? parseMediaKey({ encoding: 'hex', value: decoded.toString('utf8') }) : parseMediaKey(decoded);
}

export class WechatInboxService {
  private readonly now: () => number;
  constructor(private readonly sessions: WechatSessionStore, private readonly store: WechatInboxStore,
    private readonly options: WechatInboxServiceOptions = {}) { this.now = options.now ?? Date.now; }

  activateBinding(owner: string): void {
    const current = this.sessions.getBindingSummary(owner);
    if (!current) throw new RangeError('Unknown WeChat binding');
    const prior = this.store.getBinding(owner);
    if (!prior) this.store.saveBinding(current, new Date(current.createdAt).toISOString());
    if (!prior || prior.botId !== current.botId || prior.unlinkedAt !== null
      || prior.updatedAt !== new Date(current.updatedAt).toISOString()) {
      this.store.saveBinding(current, new Date(current.updatedAt).toISOString());
    }
  }

  deactivateBinding(owner: string): void {
    if (this.sessions.getBindingSummary(owner)) this.activateBinding(owner);
    this.sessions.removeBinding(owner);
    const binding = this.store.getBinding(owner);
    if (binding && binding.unlinkedAt === null) {
      const time = new Date(this.now()).toISOString();
      this.store.saveBinding({ ...binding, unlinkedAt: time }, time);
    }
  }

  listBindings(): WechatBindingSummary[] {
    for (const binding of this.sessions.listBindings()) this.activateBinding(binding.ownerIlinkUserId);
    for (const binding of this.store.listBindings()) {
      if (!this.sessions.getBindingSummary(binding.ownerIlinkUserId) && binding.unlinkedAt === null) {
        const time = new Date(this.now()).toISOString();
        this.store.saveBinding({ ...binding, unlinkedAt: time }, time);
      }
    }
    return this.store.listBindings().map((binding) => {
      const active = this.sessions.getBindingSummary(binding.ownerIlinkUserId) !== null;
      const paused = this.sessions.isBindingPaused(binding.ownerIlinkUserId);
      const connectionState = !active ? 'unlinked' : paused ? 'stopped'
        : this.options.getPollState?.(binding.ownerIlinkUserId) ?? 'stopped';
      const contextToken = this.store.getLatestContextToken(binding.ownerIlinkUserId);
      return { ownerIlinkUserId: binding.ownerIlinkUserId, botId: binding.botId,
        createdAt: binding.createdAt, updatedAt: binding.updatedAt, connectionState,
        canSend: active && !paused && connectionState !== 'relogin_required',
        replyContextState: contextToken?.trim() ? 'ready' : 'waiting_for_inbound' };
    });
  }

  getAttachmentById(id: string) { return this.store.getAttachmentById(id); }

  listMessages(owner: string, page: { readonly limit?: number; readonly before?: string | null } = {}): WechatMessagePage {
    const result = this.store.listMessages(owner, page);
    return { ...result, items: result.items.map((message): WechatMessage => ({
      id: message.id, remoteMessageId: message.remoteMessageId, clientId: message.clientId,
      direction: message.direction, kind: message.kind, state: message.state, sequence: message.sequence,
      createdAt: message.createdAt, text: message.text, items: message.items.map((item) => ({
        kind: item.kind, text: item.text, attachmentId: item.attachmentId, fileName: item.fileName,
        mediaType: item.mediaType, sizeBytes: item.sizeBytes,
      })),
    })) };
  }

  async processUpdates(owner: string, update: IlinkUpdates, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    const staging = new InboxMediaStaging();
    try {
      options.signal?.throwIfAborted();
      const messages: InboxMessageInput[] = [];
      for (const entry of update.msgs) {
        switch (entry.kind) {
          case 'malformed_message':
            messages.push({ remoteMessageId: entry.message_id ?? null,
              fingerprint: entry.message_id === undefined ? entry.fingerprint : null, clientId: null,
              direction: 'inbound', messageType: 0, kind: 'protocol_event', state: 'received',
              createdAt: new Date(this.now()).toISOString(), runId: null, items: [placeholder('invalid_message')] });
            break;
          case 'message': {
            const message = entry.message;
            if (message.direction === 'inbound' && message.from_user_id !== owner) {
              messages.push({ remoteMessageId: message.message_id, clientId: null, direction: 'inbound',
                messageType: message.message_type, kind: 'protocol_event', state: 'received',
                createdAt: new Date(this.now()).toISOString(), runId: null, items: [placeholder('unverified_sender')] });
              break;
            }
            const items: InboxItemInput[] = [];
            for (const item of message.item_list ?? []) items.push(await this.parseItem(owner, item, { staging, signal: options.signal }));
            if (items.length === 0) items.push(placeholder('invalid_item'));
            const epoch = message.create_time_ms;
            const createdAt = typeof epoch === 'number' && Number.isSafeInteger(epoch) && epoch >= 0 && epoch <= 253402300799999
              ? epoch : this.now();
            messages.push({ remoteMessageId: message.message_id, clientId: message.client_id ?? null, direction: message.direction,
              messageType: message.message_type, kind: items[0].kind,
              state: message.direction === 'inbound' ? 'received' : 'accepted', createdAt: new Date(createdAt).toISOString(),
              runId: null, items, ...(message.direction === 'inbound' && message.context_token !== undefined
                ? { contextToken: message.context_token } : {}) });
            break;
          }
          default: unreachable(entry);
        }
      }
      options.signal?.throwIfAborted();
      await Promise.resolve(this.store.saveBatch(owner, { messages, nextCursor: update.get_updates_buf ?? '' }));
    } finally { await staging.dispose(); }
  }

  private async parseItem(owner: string, entry: IlinkItemResult,
    context: { readonly staging: InboxMediaStaging; readonly signal?: AbortSignal }): Promise<InboxItemInput> {
    switch (entry.kind) {
      case 'malformed_item': return placeholder('invalid_item');
      case 'item': break;
      default: return unreachable(entry);
    }
    const item = entry.item;
    const kind = messageItemKind(item.type);
    switch (kind) {
      case 'protocol_event': return placeholder('unsupported_item');
      case 'text': return object(item.text_item) && typeof item.text_item.text === 'string'
        ? { kind, text: item.text_item.text } : placeholder('invalid_item');
      case 'image': case 'voice': case 'file': case 'video': {
        try {
          const data = item[`${kind}_item`];
          if (!object(data) || !object(data.media)) throw new IlinkMediaError('invalid_metadata');
          const reference = data.media;
          const base = this.options.cdnBaseUrl?.(owner);
          const url = typeof reference.full_url === 'string' && reference.full_url !== '' ? reference.full_url
            : base && typeof reference.encrypt_query_param === 'string' && reference.encrypt_query_param !== ''
              ? `${base.replace(/\/+$/, '')}/download?encrypted_query_param=${encodeURIComponent(reference.encrypt_query_param)}` : undefined;
          if (!url) throw new IlinkMediaError('invalid_metadata');
          const aesKey = kind === 'image' && data.aeskey !== undefined
            ? parseMediaKey({ encoding: 'hex', value: data.aeskey })
            : reference.aes_key !== undefined ? cdnKey(reference.aes_key) : undefined;
          if (kind !== 'image' && aesKey === undefined) throw new IlinkMediaError('invalid_key');
          let text: string | null = null;
          let fileName: string = kind;
          let durationMs: number | undefined;
          let codec: string | null = null;
          switch (kind) {
            case 'image':
              for (const field of ['mid_size', 'thumb_size', 'hd_size', 'thumb_width', 'thumb_height']) optionalNumber(data[field]);
              break;
            case 'voice': {
              if (data.text !== undefined && typeof data.text !== 'string') throw new IlinkMediaError('invalid_metadata');
              text = typeof data.text === 'string' ? data.text : null;
              durationMs = optionalNumber(data.playtime);
              const encoding = optionalNumber(data.encode_type);
              codec = encoding === undefined ? null : String(encoding);
              break;
            }
            case 'file':
              if (data.file_name !== undefined && typeof data.file_name !== 'string') throw new IlinkMediaError('invalid_metadata');
              if (data.len !== undefined && (typeof data.len !== 'string' || !/^[0-9]+$/.test(data.len)
                || !Number.isSafeInteger(Number(data.len)))) throw new IlinkMediaError('invalid_metadata');
              fileName = typeof data.file_name === 'string' ? data.file_name : kind;
              break;
            case 'video': optionalNumber(data.video_size); optionalNumber(data.play_length); break;
            default: unreachable(kind);
          }
          const metadata = parseMediaMetadata({ kind, fileName,
            mediaType: 'application/octet-stream', sizeBytes: 0, durationMs });
          const source = aesKey === undefined ? downloadPlainMedia({ url, signal: context.signal })
            : downloadMedia({ url, key: aesKey, signal: context.signal });
          const stagedFile = await context.staging.stage(source, context.signal);
          return { kind, text, durationMs, codec,
            attachment: { fileName: metadata.fileName, mediaType: metadata.mediaType, stagedFile } };
        } catch (error) {
          context.signal?.throwIfAborted();
          if (!(error instanceof IlinkMediaError) || error.code === 'aborted') throw error;
          return placeholder(error.code);
        }
      }
      default: return unreachable(kind);
    }
  }
}
