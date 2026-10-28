export const kinds = ['text', 'image', 'voice', 'file', 'video', 'protocol_event'] as const;
export const outboundStates = ['queued', 'uploading', 'sending', 'accepted', 'failed', 'unknown'] as const;
export const states = ['received', ...outboundStates] as const;
export type InboxOutboundState = typeof outboundStates[number];
type Kind = typeof kinds[number];
type State = typeof states[number];

export interface InboxBindingInput {
  readonly ownerIlinkUserId: string;
  readonly botId: string;
  readonly unlinkedAt?: string | null;
}
export interface InboxBinding extends InboxBindingInput {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly unlinkedAt: string | null;
}
export type InboxAttachmentInput = {
  readonly fileName: string;
  readonly mediaType: string;
} & (
  | { readonly bytes: Uint8Array; readonly stagedFile?: never }
  | { readonly stagedFile: string; readonly bytes?: never }
);
export class InboxAttachmentSourceError extends Error {
  override readonly name = 'InboxAttachmentSourceError';
  readonly code = 'staged_file_unavailable';
  constructor() { super('Inbox staged attachment unavailable'); }
}
export interface InboxItemInput {
  readonly kind: Kind;
  readonly text?: string | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly durationMs?: number | null;
  readonly codec?: string | null;
  readonly safeSummary?: string | null;
  readonly attachment?: InboxAttachmentInput;
}
export interface InboxItem extends Omit<InboxItemInput, 'attachment'> {
  readonly attachmentId: string | null;
  readonly fileName: string | null;
  readonly mediaType: string | null;
  readonly sizeBytes: number | null;
}
export interface InboxMessageInput {
  readonly remoteMessageId: string | null;
  readonly clientId: string | null;
  readonly direction: 'inbound' | 'outbound';
  readonly messageType: number;
  readonly kind: Kind;
  readonly state: State;
  readonly createdAt: string;
  readonly runId: string | null;
  readonly items: readonly InboxItemInput[];
  readonly contextToken?: string | null;
  readonly fingerprint?: string | null;
}
export interface InboxMessage extends Omit<InboxMessageInput, 'items' | 'contextToken' | 'fingerprint'> {
  readonly id: string;
  readonly ownerIlinkUserId: string;
  readonly sequence: number;
  readonly text: string | null;
  readonly items: readonly InboxItem[];
}
export interface InboxAttachment {
  readonly id: string;
  readonly messageId: string;
  readonly ownerIlinkUserId: string;
  readonly direction: 'inbound' | 'outbound';
  readonly kind: Kind;
  readonly fileName: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly chunkCount: number;
  readonly createdAt: string;
}
export interface InboxMessagePage {
  readonly items: readonly InboxMessage[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}
