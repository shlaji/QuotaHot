import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  DwsConversationInfoResponseSchema,
  OpenConversationIdSchema,
  type DwsCommandInvoker,
  type NotificationTarget,
} from './notification-schema.js';

const execFileAsync = promisify(execFile);

export type DwsInvoker = DwsCommandInvoker;

export type NotificationTargetResolution =
  | { readonly kind: 'verified'; readonly target: NotificationTarget }
  | { readonly kind: 'not_verified'; readonly reason: string };

export async function resolveNotificationTarget(
  configuredId: string,
  invokeDws: DwsInvoker = async (arguments_) => {
    const { stdout } = await execFileAsync('dws', [...arguments_], {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    });
    return stdout;
  },
): Promise<NotificationTargetResolution> {
  const parsedId = OpenConversationIdSchema.safeParse(configuredId);
  if (!parsedId.success) return { kind: 'not_verified', reason: '群标识无效' };

  const output = await invokeDws([
    'chat',
    '+conversation-info',
    '--group',
    parsedId.data,
    '--format',
    'json',
  ]);
  let response: unknown;
  try {
    response = JSON.parse(output);
  } catch (error) {
    if (error instanceof SyntaxError) return { kind: 'not_verified', reason: 'DWS 群资料响应无法解析' };
    throw error;
  }

  const parsedResponse = DwsConversationInfoResponseSchema.safeParse(response);
  if (!parsedResponse.success) return { kind: 'not_verified', reason: 'DWS 群资料响应结构无效' };
  const conversation = parsedResponse.data.result.conversationInfo;
  if (conversation.singleChat || conversation.openConversationId !== parsedId.data) {
    return { kind: 'not_verified', reason: 'DWS 返回的群身份与配置目标不匹配' };
  }

  return {
    kind: 'verified',
    target: { openConversationId: parsedId.data, displayName: conversation.title },
  };
}
