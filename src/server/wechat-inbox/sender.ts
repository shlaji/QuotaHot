import type { WechatConnectionState, WechatSendResult } from '../../shared/wechat-inbox.js';
import type { WechatSessionStore } from '../wechat-session-store.js';
import { randomBytes, randomUUID } from 'node:crypto';
import type { request } from '../http.js';
import { IlinkBotClient, IlinkClientError, type IlinkBinding, type IlinkJsonObject } from './client.js';
import type { InboxItemInput, InboxOutboundState, WechatInboxStore } from './store.js';
import { mediaType, parseMediaMetadata } from './media.js';
import { prepareMediaUpload, type PreparedMediaUpload } from './media-upload-source.js';
import { resolveMediaUploadUrl, uploadPreparedMedia } from './media-upload.js';

export interface InboxTarget { readonly owner: string }
export type InboxSendCommand = InboxTarget & (
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'image' | 'video' | 'file' | 'voice'; readonly source: AsyncIterable<Uint8Array>;
      readonly fileName: string; readonly mediaType: string; readonly signal?: AbortSignal }
);
export interface InboxSenderOptions {
  readonly now?: () => number;
  readonly getPollState?: (owner: string) => WechatConnectionState;
  readonly createClient?: (binding: IlinkBinding) => IlinkBotClient;
  readonly transport?: typeof request;
  readonly cdnBaseUrl?: (owner: string) => string | undefined;
}
export type InboxSendErrorCode = 'not_found' | 'binding_read_only' | 'voice_outbound_disabled'
  | 'context_required' | 'storage_failed' | 'upload_failed' | 'send_rejected' | 'send_unknown';
export class InboxSendError extends Error {
  override readonly name = 'InboxSendError';
  constructor(readonly code: InboxSendErrorCode) { super(`Inbox send: ${code}`); }
}
export class InboxSendAccess {
  constructor(private readonly sessions: WechatSessionStore, private readonly store: WechatInboxStore,
    private readonly options: InboxSenderOptions = {}) {}
  resolve(target: InboxTarget, requireContext = true) {
    try {
      const binding = this.sessions.getBinding(target.owner);
      if (!binding || !this.store.getBinding(target.owner)) throw new InboxSendError('not_found');
      if (this.sessions.isBindingPaused(target.owner)
        || this.store.getBinding(target.owner)?.unlinkedAt !== null
        || this.options.getPollState?.(target.owner) === 'relogin_required') throw new InboxSendError('binding_read_only');
      const contextToken = requireContext ? this.store.getLatestContextToken(target.owner) : null;
      if (requireContext && !contextToken?.trim()) throw new InboxSendError('context_required');
      return { binding, revision: this.sessions.getBindingRevision(target.owner), contextToken };
    } catch (error) {
      if (error instanceof InboxSendError) throw error;
      throw new InboxSendError('storage_failed');
    }
  }
  assertCurrent(target: InboxTarget, revision: number): void {
    if (this.resolve(target, false).revision !== revision) throw new InboxSendError('binding_read_only');
  }
}
interface PendingSend extends InboxTarget { readonly clientId: string; readonly messageId: string }
function unreachable(value: never): never { throw new TypeError(`Invalid inbox variant: ${typeof value}`); }
function rejected(error: unknown): boolean {
  if (!(error instanceof IlinkClientError)) return false;
  switch (error.code) {
    case 'upstream_failure': case 'auth_required': return true;
    case 'http_failure': return error.httpStatus !== undefined && error.httpStatus >= 400 && error.httpStatus < 500
      && error.httpStatus !== 408 && error.httpStatus !== 425;
    case 'invalid_binding': case 'invalid_request': case 'invalid_response': case 'timeout':
    case 'aborted': case 'transport_failed': return false;
    default: return unreachable(error.code);
  }
}
export class WechatInboxSender {
  private readonly access: InboxSendAccess;
  constructor(sessions: WechatSessionStore, private readonly store: WechatInboxStore,
    private readonly options: InboxSenderOptions = {}) { this.access = new InboxSendAccess(sessions, store, options); }
  async send(command: InboxSendCommand): Promise<WechatSendResult> {
    switch (command.kind) {
      case 'voice':
        this.access.resolve(command, false);
        throw new InboxSendError('voice_outbound_disabled');
      case 'text': {
        const { binding, contextToken } = this.access.resolve(command);
        if (!contextToken) throw new InboxSendError('context_required');
        const pending = this.persist(command, { kind: 'text', text: command.text });
        return this.transmit(pending, binding, contextToken, { type: 1, text_item: { text: command.text } });
      }
      case 'image': case 'video': case 'file': return this.sendMedia(command);
      default: return unreachable(command);
    }
  }
  private persist(command: InboxSendCommand, item: InboxItemInput): PendingSend {
    const clientId = randomUUID();
    try {
      this.store.saveBatch(command.owner, { nextCursor: '', messages: [{
        remoteMessageId: null, clientId, direction: 'outbound', messageType: 2, kind: item.kind,
        state: item.attachment ? 'uploading' : 'sending', createdAt: new Date((this.options.now ?? Date.now)()).toISOString(),
        runId: null, items: [item] }] });
      const messageId = this.store.findOutboundMessageId(command.owner, clientId);
      if (!messageId) throw new InboxSendError('storage_failed');
      return { owner: command.owner, clientId, messageId };
    } catch { throw new InboxSendError('storage_failed'); }
  }
  private transition(pending: PendingSend, state: InboxOutboundState): InboxOutboundState {
    try {
      const effective = this.store.updateOutboundState(pending.owner, pending.messageId, state);
      if (effective === null) throw new InboxSendError('storage_failed');
      return effective;
    } catch { throw new InboxSendError('storage_failed'); }
  }
  private finish(pending: PendingSend, outcome: { readonly state: 'accepted' | 'failed' | 'unknown'; readonly errorCode: InboxSendErrorCode | null }): WechatSendResult {
    const effective = this.transition(pending, outcome.state);
    switch (effective) {
      case 'accepted': return { messageId: pending.messageId, state: 'accepted', errorCode: null };
      case 'failed': case 'unknown': return { messageId: pending.messageId, state: effective, errorCode: outcome.errorCode };
      case 'sending': case 'uploading': case 'queued': throw new InboxSendError('storage_failed');
      default: throw new TypeError(`Unexpected outbound state: ${String(effective)}`);
    }
  }
  private async transmit(pending: PendingSend, binding: IlinkBinding, contextToken: string, item: IlinkJsonObject): Promise<WechatSendResult> {
    try {
      const client = this.options.createClient?.(binding) ?? new IlinkBotClient(binding);
      await client.sendMessage({ from_user_id: '', to_user_id: pending.owner, client_id: pending.clientId,
        message_type: 2, message_state: 2, item_list: [item], context_token: contextToken });
    } catch (error) {
      return this.finish(pending, rejected(error) ? { state: 'failed', errorCode: 'send_rejected' }
        : { state: 'unknown', errorCode: 'send_unknown' });
    }
    return this.finish(pending, { state: 'accepted', errorCode: null });
  }
  private async sendMedia(command: Exclude<InboxSendCommand, { readonly kind: 'text' }>): Promise<WechatSendResult> {
    const { binding, revision, contextToken } = this.access.resolve(command);
    if (!contextToken) throw new InboxSendError('context_required');
    const metadata = parseMediaMetadata({ ...command, sizeBytes: 0 });
    let prepared: PreparedMediaUpload;
    try { prepared = await prepareMediaUpload(command.source, command.signal); }
    catch { throw new InboxSendError('upload_failed'); }
    let pending: PendingSend | undefined;
    try {
      pending = this.persist(command, { kind: command.kind,
        attachment: { stagedFile: prepared.stagedFile, fileName: metadata.fileName, mediaType: metadata.mediaType } });
      this.access.assertCurrent(command, revision);
      const aeskey = randomBytes(16).toString('hex');
      const filekey = randomUUID();
      let param: string;
      try {
        const client = this.options.createClient?.(binding) ?? new IlinkBotClient(binding);
        const upload = await client.getUploadUrl({ filekey, media_type: mediaType(command.kind), to_user_id: command.owner,
          rawsize: prepared.rawsize, rawfilemd5: prepared.rawfilemd5, filesize: prepared.filesize, aeskey, no_need_thumb: true },
          { signal: command.signal });
        this.access.assertCurrent(command, revision);
        const url = resolveMediaUploadUrl(upload, { filekey, cdnBaseUrl: this.options.cdnBaseUrl?.(command.owner) });
        param = await uploadPreparedMedia(prepared, { url, key: { encoding: 'hex', value: aeskey }, signal: command.signal }, this.options.transport);
      } catch (error) {
        if (error instanceof InboxSendError) throw error;
        return this.finish(pending, { state: 'failed', errorCode: 'upload_failed' });
      }
      this.access.assertCurrent(command, revision);
      if (this.transition(pending, 'sending') === 'accepted') return { messageId: pending.messageId, state: 'accepted', errorCode: null };
      const media = { encrypt_query_param: param, aes_key: Buffer.from(aeskey).toString('base64'), encrypt_type: 1 };
      let item: IlinkJsonObject;
      switch (command.kind) {
        case 'image': item = { type: 2, image_item: { media, mid_size: prepared.filesize } }; break;
        case 'video': item = { type: 5, video_item: { media, video_size: prepared.filesize } }; break;
        case 'file': item = { type: 4, file_item: { media, file_name: metadata.fileName, len: String(prepared.rawsize) } }; break;
        case 'voice': throw new InboxSendError('voice_outbound_disabled');
        default: return unreachable(command.kind);
      }
      this.access.assertCurrent(command, revision);
       return await this.transmit(pending, binding, contextToken, item);
    } catch (error) {
      if (pending && error instanceof InboxSendError && (error.code === 'binding_read_only' || error.code === 'not_found')) {
        this.finish(pending, { state: 'failed', errorCode: error.code });
      }
      if (error instanceof InboxSendError) throw error;
      throw new InboxSendError('upload_failed');
    } finally {
      try { await prepared.dispose(); }
      catch { throw new InboxSendError('upload_failed'); }
    }
  }
}
