export type WechatConnectionState =
  | 'starting'
  | 'polling'
  | 'backoff'
  | 'relogin_required'
  | 'stopped'
  | 'unlinked';

export interface WechatBindingSummary {
  ownerIlinkUserId: string;
  botId: string;
  createdAt: string;
  updatedAt: string;
  connectionState: WechatConnectionState;
  canSend: boolean;
  replyContextState: 'waiting_for_inbound' | 'ready';
  lastInboundAt?: string | null;
}

export type WechatMessageKind = 'text' | 'image' | 'voice' | 'file' | 'video' | 'protocol_event';

export type WechatMessageState = 'received' | 'queued' | 'uploading' | 'sending' | 'accepted' | 'failed' | 'unknown';

export interface WechatMessage {
  id: string;
  remoteMessageId?: string | null;
  clientId?: string | null;
  direction: 'inbound' | 'outbound';
  kind: WechatMessageKind;
  state: WechatMessageState;
  sequence: number;
  createdAt: string;
  text?: string | null;
  items: WechatMessageItem[];
}

export type WechatMessageItem =
  | { kind: 'text'; text?: string | null; attachmentId?: string | null; fileName?: string | null; mediaType?: string | null; sizeBytes?: number | null }
  | { kind: 'image'; text?: string | null; attachmentId?: string | null; fileName?: string | null; mediaType?: string | null; sizeBytes?: number | null }
  | { kind: 'voice'; text?: string | null; attachmentId?: string | null; fileName?: string | null; mediaType?: string | null; sizeBytes?: number | null }
  | { kind: 'file'; text?: string | null; attachmentId?: string | null; fileName?: string | null; mediaType?: string | null; sizeBytes?: number | null }
  | { kind: 'video'; text?: string | null; attachmentId?: string | null; fileName?: string | null; mediaType?: string | null; sizeBytes?: number | null }
  | { kind: 'protocol_event'; text?: string | null; attachmentId?: string | null; fileName?: string | null; mediaType?: string | null; sizeBytes?: number | null };

export interface WechatMessagePage {
  items: WechatMessage[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface WechatTextSend {
  kind: 'text';
  text: string;
}

export type WechatMediaKind = 'image' | 'voice' | 'file' | 'video';

export type WechatMediaSend =
  | { kind: 'image'; file: File; fileName?: string; mediaType?: string }
  | { kind: 'voice'; file: File; fileName?: string; mediaType?: string }
  | { kind: 'file'; file: File; fileName?: string; mediaType?: string }
  | { kind: 'video'; file: File; fileName?: string; mediaType?: string };

export type WechatSendResult =
  | { messageId: string; state: 'accepted'; errorCode?: string | null }
  | { messageId: string; state: 'failed'; errorCode?: string | null }
  | { messageId: string; state: 'unknown'; errorCode?: string | null };

export interface WechatInboxError {
  error: string;
}
