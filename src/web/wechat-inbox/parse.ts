import type { WechatBindingSummary, WechatMessage, WechatMessageItem, WechatMessagePage, WechatSendResult } from '../../shared/wechat-inbox.js';
import { InboxApiError } from './errors.js';

function invalid(): never { throw new InboxApiError(200); }
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid();
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string { return typeof value === 'string' ? value : invalid(); }
function optionalText(value: unknown): string | null { return value == null ? null : text(value); }
function bool(value: unknown): boolean { return typeof value === 'boolean' ? value : invalid(); }
function date(value: unknown): string {
  const result = text(value);
  return Number.isFinite(Date.parse(result)) ? result : invalid();
}
function integer(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid();
}
export function localId(value: unknown): string {
  const result = text(value);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result) ? result : invalid();
}
function variant<const T extends string>(value: unknown, choices: readonly T[]): T {
  return choices.find((choice) => choice === value) ?? invalid();
}
export function list<T>(value: unknown, parse: (item: unknown) => T): T[] {
  return Array.isArray(value) ? value.map(parse) : invalid();
}
export function parseBinding(value: unknown): WechatBindingSummary {
  const body = record(value);
  return { ownerIlinkUserId: text(body.ownerIlinkUserId), botId: text(body.botId), createdAt: date(body.createdAt), updatedAt: date(body.updatedAt),
    connectionState: variant(body.connectionState, ['starting', 'polling', 'backoff', 'relogin_required', 'stopped', 'unlinked']), canSend: bool(body.canSend),
    replyContextState: variant(body.replyContextState, ['waiting_for_inbound', 'ready']),
    ...(body.lastInboundAt === undefined ? {} : { lastInboundAt: body.lastInboundAt === null ? null : date(body.lastInboundAt) }) };
}
const kinds = ['text', 'image', 'voice', 'file', 'video', 'protocol_event'] as const;
function parseItem(value: unknown): WechatMessageItem {
  const body = record(value);
  return { kind: variant(body.kind, kinds),
    ...(body.text === undefined ? {} : { text: optionalText(body.text) }),
    ...(body.attachmentId == null ? {} : { attachmentId: localId(body.attachmentId) }),
    ...(body.fileName === undefined ? {} : { fileName: optionalText(body.fileName) }),
    ...(body.mediaType === undefined ? {} : { mediaType: optionalText(body.mediaType) }),
    ...(body.sizeBytes == null ? {} : { sizeBytes: integer(body.sizeBytes) }) };
}
function parseMessage(value: unknown): WechatMessage {
  const body = record(value);
  return { id: localId(body.id), sequence: integer(body.sequence), createdAt: date(body.createdAt),
    direction: variant(body.direction, ['inbound', 'outbound']), kind: variant(body.kind, kinds),
    state: variant(body.state, ['received', 'queued', 'uploading', 'sending', 'accepted', 'failed', 'unknown']),
    ...(body.text === undefined ? {} : { text: optionalText(body.text) }), items: list(body.items, parseItem) };
}
export function parsePage(value: unknown): WechatMessagePage {
  const body = record(value);
  const nextCursor = optionalText(body.nextCursor);
  const hasMore = bool(body.hasMore);
  if (hasMore && !nextCursor) return invalid();
  return { items: list(body.items, parseMessage), nextCursor, hasMore };
}
export function parseSend(value: unknown): WechatSendResult {
  const body = record(value);
  return { messageId: localId(body.messageId), state: variant(body.state, ['accepted', 'failed', 'unknown']) };
}
