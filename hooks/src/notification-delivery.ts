import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  DwsSendResponseSchema,
  DwsSendStatusResponseSchema,
  DwsToolValidationErrorResponseSchema,
  OpenConversationIdSchema,
  type DwsCommandInvoker,
  type NotificationChunkResultValue,
  type NotificationTarget,
} from './notification-schema.js';

export type { DwsCommandInvoker } from './notification-schema.js';

const execFileAsync = promisify(execFile);
const MAX_CHUNK_BYTES = 1024;

type NotificationChunkRequest = {
  readonly target: NotificationTarget;
  readonly content: string;
  readonly invokeDws?: DwsCommandInvoker;
};

export type NotificationChunkResult = NotificationChunkResultValue;

export class DwsInvocationError extends Error {
  constructor() {
    super('DWS 命令未返回可确认的 JSON 结果');
    this.name = 'DwsInvocationError';
  }
}

function splitAtByteLimit(content: string, byteLimit: number): string[] {
  const parts: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const codePoint of content) {
    const codePointBytes = Buffer.byteLength(codePoint, 'utf8');
    if (currentBytes + codePointBytes > byteLimit && current.length > 0) {
      parts.push(current);
      current = '';
      currentBytes = 0;
    }
    current += codePoint;
    currentBytes += codePointBytes;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

export function splitNotificationContent(content: string): readonly string[] {
  if (!content.trim()) return [];

  let expectedCount = 1;
  for (;;) {
    const prefixBytes = Buffer.byteLength(`${expectedCount}/${expectedCount} `, 'utf8');
    const bodies = splitAtByteLimit(content, MAX_CHUNK_BYTES - prefixBytes);
    if (bodies.length === expectedCount) {
      return bodies.map((body, index) => `${index + 1}/${bodies.length} ${body}`);
    }
    expectedCount = bodies.length;
  }
}

async function invokeDws(arguments_: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('dws', [...arguments_, '--format', 'json'], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    });
    if (typeof stdout !== 'string') throw new DwsInvocationError();
    return stdout;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if ('stdout' in error) {
      const output = error.stdout;
      if (typeof output === 'string' && output.length > 0) return output;
      if (Buffer.isBuffer(output) && output.length > 0) return output.toString('utf8');
    }
    throw new DwsInvocationError();
  }
}

function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function incompleteResult(sentParts: number[], reason: string): NotificationChunkResult {
  return sentParts.length === 0
    ? { state: 'unknown', sentParts, reason }
    : { state: 'partial', sentParts, reason };
}

export async function sendNotificationChunks(request: NotificationChunkRequest): Promise<NotificationChunkResult> {
  const targetId = OpenConversationIdSchema.safeParse(request.target.openConversationId);
  if (!targetId.success) return { state: 'failed', sentParts: [], reason: '通知群 ID 无效' };

  const chunks = splitNotificationContent(request.content);
  if (chunks.length === 0) return { state: 'skipped', sentParts: [], reason: '最终消息没有可发送文本' };
  const runDws = request.invokeDws ?? invokeDws;
  const sentParts: number[] = [];

  for (const [index, chunk] of chunks.entries()) {
    let sendOutput: string;
    try {
      sendOutput = await runDws([
        'chat', '+send-to-group', '--group', targetId.data, '--content', chunk, '--yes', '--format', 'json',
      ]);
    } catch (error) {
      if (error instanceof DwsInvocationError) return incompleteResult(sentParts, error.message);
      throw error;
    }

    const sendResponse = DwsSendResponseSchema.safeParse(parseJson(sendOutput));
    if (!sendResponse.success) {
      const validationError = DwsToolValidationErrorResponseSchema.safeParse(parseJson(sendOutput));
      if (validationError.success) {
        const reason = 'DWS 在发送前拒绝了消息';
        return sentParts.length === 0
          ? { state: 'failed', sentParts, reason }
          : { state: 'partial', sentParts, reason };
      }
      return incompleteResult(sentParts, 'DWS 未返回明确的发送受理结果');
    }

    let statusOutput: string;
    try {
      statusOutput = await runDws([
        'chat', '+messages-query-send-status', '--open-task-id', sendResponse.data.result.openTaskId,
      ]);
    } catch (error) {
      if (error instanceof DwsInvocationError) return incompleteResult(sentParts, error.message);
      throw error;
    }

    const statusResponse = DwsSendStatusResponseSchema.safeParse(parseJson(statusOutput));
    if (!statusResponse.success || statusResponse.data.result.openConversationId !== targetId.data ||
        statusResponse.data.result.sendStatus !== 'SUCCESS') {
      return incompleteResult(sentParts, 'DWS 投递状态未知或目标不匹配');
    }
    sentParts.push(index + 1);
  }

  return { state: 'sent', sentParts };
}
