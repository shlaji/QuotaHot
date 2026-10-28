import {
  AssistantMessageIdSchema,
  NotificationSendInputSchema,
  OpenCodeSessionIdSchema,
  OpenCodeSessionMessagesResponseSchema,
  type OpenCodeSessionMessage,
  type NotificationSendInput,
} from './notification-schema.js';

export type FinalMessageSelection =
  | { readonly kind: 'message'; readonly payload: NotificationSendInput }
  | {
    readonly kind: 'skipped';
    readonly reason: 'invalid_session' | 'messages_invalid' | 'no_user_message' | 'no_completed_assistant' | 'empty_response';
  };

export function selectFinalAssistantMessage(sessionIdInput: string, response: unknown): FinalMessageSelection {
  const parsedSessionId = OpenCodeSessionIdSchema.safeParse(sessionIdInput);
  if (!parsedSessionId.success) return { kind: 'skipped', reason: 'invalid_session' };

  const parsedResponse = OpenCodeSessionMessagesResponseSchema.safeParse(response);
  if (!parsedResponse.success) return { kind: 'skipped', reason: 'messages_invalid' };

  const responseData = parsedResponse.data;
  let messages: readonly OpenCodeSessionMessage[];
  if (Array.isArray(responseData)) {
    messages = responseData;
  } else {
    if (responseData.error !== undefined && responseData.error !== null) {
      return { kind: 'skipped', reason: 'messages_invalid' };
    }
    messages = responseData.data;
  }

  let latestUserIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.info.sessionID === parsedSessionId.data && message.info.role === 'user') latestUserIndex = index;
  }
  if (latestUserIndex < 0) return { kind: 'skipped', reason: 'no_user_message' };

  let finalAssistant: (typeof messages)[number] | undefined;
  for (let index = latestUserIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.info.sessionID === parsedSessionId.data && message.info.role === 'assistant') finalAssistant = message;
  }
  if (!finalAssistant || finalAssistant.info.time.completed === undefined ||
      (finalAssistant.info.error !== undefined && finalAssistant.info.error !== null)) {
    return { kind: 'skipped', reason: 'no_completed_assistant' };
  }

  const content = finalAssistant.parts
    .flatMap((part) => part.type === 'text' && typeof part.text === 'string' && !part.synthetic && !part.ignored ? [part.text] : [])
    .join('');
  if (!content.trim()) return { kind: 'skipped', reason: 'empty_response' };

  const payload = NotificationSendInputSchema.parse({
    sessionId: parsedSessionId.data,
    assistantMessageId: AssistantMessageIdSchema.parse(finalAssistant.info.id),
    content,
  });
  return { kind: 'message', payload };
}
