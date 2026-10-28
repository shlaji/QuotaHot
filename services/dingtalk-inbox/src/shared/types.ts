export const targetTypes = ['person', 'group'] as const;
export type TargetType = typeof targetTypes[number];
export const subscriptionStates = ['starting', 'ready', 'stopping', 'stopped', 'failed', 'interrupted'] as const;
export type SubscriptionState = typeof subscriptionStates[number];
export const eventKeys = ['user_im_message_receive_o2o', 'user_im_message_receive_group'] as const;
export const sendStates = ['not_applicable', 'pending', 'accepted', 'failed', 'unknown'] as const;
export type SendState = typeof sendStates[number];

export interface TargetIdentity {
  readonly profileKey: string;
  readonly targetType: TargetType;
  readonly targetId: string;
}

export interface DingtalkTarget extends TargetIdentity {
  readonly displayName: string;
  readonly listeningDesired: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PersonCandidate {
  readonly userId: string;
  readonly displayName: string;
  readonly department?: string;
}

export interface GroupCandidate {
  readonly openConversationId: string;
  readonly displayName: string;
}

export interface DingtalkSubscription extends TargetIdentity {
  readonly subscriptionId: string;
  readonly eventKey: typeof eventKeys[number];
  readonly state: SubscriptionState;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
}

export interface DingtalkMessage extends TargetIdentity {
  readonly localId: string;
  readonly conversationId: string | null;
  readonly eventId: string | null;
  readonly messageId: string | null;
  readonly senderId: string | null;
  readonly senderName: string | null;
  readonly direction: 'inbound' | 'outbound';
  readonly contentType: 'text';
  readonly content: string;
  readonly sourceTime: string | null;
  readonly receivedAt: string | null;
  readonly storedAt: string;
  readonly sendState: SendState;
}

export interface Capability {
  readonly available: boolean;
  readonly reason: string;
  readonly dwsVersion?: string;
}

export interface ErrorDto {
  readonly code: string;
  readonly message: string;
}

export interface StoredMessage extends DingtalkMessage {
  readonly sequence: number;
}

export interface MessageCursor {
  readonly storedAt: string;
  readonly sequence: number;
}

export interface MessagePage {
  readonly limit?: number;
  readonly before?: MessageCursor;
}

export interface TargetPage {
  readonly limit?: number;
  readonly offset?: number;
}

export interface AppendMessageResult {
  readonly inserted: boolean;
  readonly message: StoredMessage;
  readonly deduplication: 'message' | 'event' | 'unavailable';
}

export type SubscriptionUpdate = Pick<DingtalkSubscription, 'state'> &
  Partial<Pick<DingtalkSubscription, 'endedAt' | 'failureCode' | 'failureMessage'>>;
