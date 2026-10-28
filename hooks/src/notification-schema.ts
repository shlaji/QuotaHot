import { z } from 'zod';

export const OpenConversationIdSchema = z.string().min(1).brand<'OpenConversationId'>();
export const OpenCodeSessionIdSchema = z.string().min(1).brand<'OpenCodeSessionId'>();
export const OpenCodeMessageIdSchema = z.string().min(1).brand<'OpenCodeMessageId'>();
export const AssistantMessageIdSchema = z.string().min(1).brand<'AssistantMessageId'>();
export const CompletionKeySchema = z.string().min(1).brand<'CompletionKey'>();
export const NotificationDigestSchema = z.string().min(1).brand<'NotificationDigest'>();
export const IsoTimestampSchema = z.iso.datetime().brand<'IsoTimestamp'>();

export const NotificationTargetSchema = z.object({
  openConversationId: OpenConversationIdSchema,
  displayName: z.string().min(1),
});

const DisabledNotificationConfigSchema = z.strictObject({
  version: z.literal(1),
  enabled: z.literal(false),
  target: NotificationTargetSchema.nullable(),
  authorizedAt: IsoTimestampSchema.nullable(),
});

const EnabledNotificationConfigSchema = z.strictObject({
  version: z.literal(1),
  enabled: z.literal(true),
  target: NotificationTargetSchema,
  authorizedAt: IsoTimestampSchema,
});

export const NotificationConfigSchema = z.discriminatedUnion('enabled', [
  DisabledNotificationConfigSchema,
  EnabledNotificationConfigSchema,
]);

export const NotificationDeliveryState = {
  inProgress: 'in_progress',
  sent: 'sent',
  partial: 'partial',
  failed: 'failed',
  unknown: 'unknown',
} as const;

export const NotificationCompletionLedgerSchema = z.strictObject({
  sessionId: OpenCodeSessionIdSchema,
  assistantMessageId: AssistantMessageIdSchema,
  completionKey: CompletionKeySchema,
  messageDigest: NotificationDigestSchema,
  ownerPid: z.number().int().positive(),
  partCount: z.number().int().positive(),
  state: z.enum([
    NotificationDeliveryState.inProgress,
    NotificationDeliveryState.sent,
    NotificationDeliveryState.partial,
    NotificationDeliveryState.failed,
    NotificationDeliveryState.unknown,
  ]),
  sentParts: z.array(z.number().int().positive()),
  updatedAt: IsoTimestampSchema,
  reason: z.string().optional(),
});

export const NotificationLedgerFileSchema = z.strictObject({
  version: z.literal(1),
  records: z.array(NotificationCompletionLedgerSchema),
});

export const DwsConversationInfoResponseSchema = z.object({
  success: z.literal(true),
  result: z.object({
    conversationInfo: z.object({
      openConversationId: OpenConversationIdSchema,
      title: z.string().min(1),
      singleChat: z.boolean(),
    }),
  }),
});

export const DwsSendResponseSchema = z.object({
  success: z.literal(true),
  result: z.object({ openTaskId: z.string().min(1) }),
});

export const DwsSendStatusResponseSchema = z.object({
  success: z.literal(true),
  openTaskId: z.string().min(1),
  result: z.object({
    openConversationId: OpenConversationIdSchema,
    openMessageId: z.string().min(1),
    sendStatus: z.string().min(1),
  }),
});

export const DwsToolValidationErrorResponseSchema = z.object({
  error: z.object({
    stage: z.literal('tool_validation'),
    reason: z.string().optional(),
  }),
});

export const NotificationSendInputSchema = z.strictObject({
  sessionId: OpenCodeSessionIdSchema,
  assistantMessageId: AssistantMessageIdSchema,
  content: z.string().min(1),
});

const NotificationPartNumbersSchema = z.array(z.number().int().positive());

export const NotificationChunkResultSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('sent'), sentParts: NotificationPartNumbersSchema }),
  z.strictObject({ state: z.literal('skipped'), sentParts: NotificationPartNumbersSchema, reason: z.string() }),
  z.strictObject({ state: z.literal('failed'), sentParts: NotificationPartNumbersSchema, reason: z.string() }),
  z.strictObject({ state: z.literal('partial'), sentParts: NotificationPartNumbersSchema, reason: z.string() }),
  z.strictObject({ state: z.literal('unknown'), sentParts: NotificationPartNumbersSchema, reason: z.string() }),
]);

const OpenCodeMessagePartSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  synthetic: z.boolean().optional(),
  ignored: z.boolean().optional(),
});

const OpenCodeSessionMessageSchema = z.object({
  info: z.object({
    id: OpenCodeMessageIdSchema,
    sessionID: OpenCodeSessionIdSchema,
    role: z.enum(['user', 'assistant']),
    time: z.object({
      created: z.number(),
      completed: z.number().optional(),
    }),
    error: z.unknown().optional(),
  }),
  parts: z.array(OpenCodeMessagePartSchema),
});

const OpenCodeSessionMessageArraySchema = z.array(OpenCodeSessionMessageSchema);

export const OpenCodeSessionMessagesResponseSchema = z.union([
  OpenCodeSessionMessageArraySchema,
  z.object({
    data: OpenCodeSessionMessageArraySchema,
    error: z.unknown().optional(),
  }),
]);

export const NotificationSessionSendInputSchema = z.strictObject({
  sessionId: OpenCodeSessionIdSchema,
  messages: OpenCodeSessionMessagesResponseSchema,
});

export const OpenCodePluginEventSchema = z.object({
  type: z.string(),
  properties: z.object({
    sessionID: z.string().optional(),
    info: z.object({ id: z.string().optional(), sessionID: z.string().optional() }).optional(),
  }).optional(),
});

export type OpenConversationId = z.infer<typeof OpenConversationIdSchema>;
export type OpenCodeSessionId = z.infer<typeof OpenCodeSessionIdSchema>;
export type OpenCodeMessageId = z.infer<typeof OpenCodeMessageIdSchema>;
export type AssistantMessageId = z.infer<typeof AssistantMessageIdSchema>;
export type NotificationTarget = z.infer<typeof NotificationTargetSchema>;
export type NotificationConfig = z.infer<typeof NotificationConfigSchema>;
export type NotificationDeliveryStateValue = (typeof NotificationDeliveryState)[keyof typeof NotificationDeliveryState];
export type NotificationCompletionLedgerRecord = z.infer<typeof NotificationCompletionLedgerSchema>;
export type NotificationLedgerFile = z.infer<typeof NotificationLedgerFileSchema>;
export type NotificationSendInput = z.infer<typeof NotificationSendInputSchema>;
export type NotificationSessionSendInput = z.infer<typeof NotificationSessionSendInputSchema>;
export type NotificationChunkResultValue = z.infer<typeof NotificationChunkResultSchema>;
export type OpenCodeSessionMessage = z.infer<typeof OpenCodeSessionMessageSchema>;
export type DwsCommandInvoker = (arguments_: readonly string[]) => Promise<string>;
