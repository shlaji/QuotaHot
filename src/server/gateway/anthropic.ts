/**
 * 网关内部的中间表示：**Anthropic Messages 格式**。
 *
 * 选它当 IR 不是偏心，是因为它的信息量最大——thinking 块、tool_use 的流式 JSON 片段、
 * 分块的 system prompt，这些在 OpenAI 的 chat 格式里没有等价物。拿信息少的那种当中枢，
 * 每过一道转换都要丢一点东西；拿信息多的当中枢，只在出口按目标能表达的部分裁剪。
 *
 * 于是转换器只有两类而不是四类：入口把请求归一成这里的形状，出口按上游的方言发出去；
 * 响应反过来，上游事件先归一成 Anthropic 事件流，再按入口协议序列化。
 */
import type { SseEvent } from './sse.js';

/** 内容块。字段按需读取，未知类型原样透传。 */
export type ContentBlock = Record<string, unknown> & { type: string };

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * 一次转发请求的归一形态。
 *
 * 保留 `[key: string]: unknown`：Anthropic 客户端发来的请求原样落在这里，出口是 claude 时
 * 整体透传，上游新增的字段不必等我们跟进就能用。
 */
export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | ContentBlock[];
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: Record<string, unknown>;
  thinking?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 聚合完成的一条回复，非流式响应由它序列化而来。 */
export interface AnthropicResult {
  id: string;
  model: string;
  content: ContentBlock[];
  stopReason: string;
  stopSequence: string | null;
  inputTokens: number;
  outputTokens: number;
}

export type EventStream = AsyncGenerator<SseEvent>;

/** 造一帧 Anthropic 事件；事件名要同时出现在 `event:` 和 data 的 `type` 里。 */
export function event(type: string, payload: Record<string, unknown>): SseEvent {
  return { event: type, data: JSON.stringify({ type, ...payload }) };
}

function textOf(block: ContentBlock): string {
  return typeof block.text === 'string' ? block.text : '';
}

/** 把 system 字段收敛成一段纯文本；分块形式只取文本块。 */
export function systemText(system: AnthropicRequest['system']): string {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system
    .filter((b) => b.type === 'text')
    .map(textOf)
    .join('\n\n');
}

/** 内容统一成块数组，省得每个转换器都先判一次 string。 */
export function blocksOf(content: AnthropicMessage['content']): ContentBlock[] {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

/**
 * 把 Anthropic 事件流聚合成一条完整回复。
 *
 * 非流式请求走的也是流式上游（Codex 那边根本不接受非流式），因此「攒完再回」这件事
 * 必须在我们这一侧做。顺带把 usage 一起收下来——记账要用，而它分散在 message_start
 * 和 message_delta 两个事件里。
 */
export async function collect(events: EventStream): Promise<AnthropicResult> {
  const result: AnthropicResult = {
    id: '',
    model: '',
    content: [],
    stopReason: 'end_turn',
    stopSequence: null,
    inputTokens: 0,
    outputTokens: 0,
  };
  /** 正在累积的 tool_use 参数 JSON 片段，按块下标存。 */
  const partialJson = new Map<number, string>();

  for await (const evt of events) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(evt.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = String(payload.type ?? evt.event);
    if (type === 'message_start') {
      const message = (payload.message ?? {}) as Record<string, unknown>;
      result.id = String(message.id ?? '');
      result.model = String(message.model ?? '');
      const usage = (message.usage ?? {}) as Record<string, unknown>;
      result.inputTokens = Number(usage.input_tokens ?? 0) || 0;
      result.outputTokens = Number(usage.output_tokens ?? 0) || 0;
    } else if (type === 'content_block_start') {
      const index = Number(payload.index ?? 0);
      const block = { ...((payload.content_block ?? {}) as ContentBlock) };
      result.content[index] = block;
      if (block.type === 'tool_use') partialJson.set(index, '');
    } else if (type === 'content_block_delta') {
      const index = Number(payload.index ?? 0);
      const delta = (payload.delta ?? {}) as Record<string, unknown>;
      const block = result.content[index] ?? { type: 'text', text: '' };
      if (delta.type === 'text_delta') block.text = `${textOf(block)}${String(delta.text ?? '')}`;
      else if (delta.type === 'thinking_delta')
        block.thinking = `${typeof block.thinking === 'string' ? block.thinking : ''}${String(delta.thinking ?? '')}`;
      else if (delta.type === 'signature_delta') block.signature = String(delta.signature ?? '');
      else if (delta.type === 'input_json_delta')
        partialJson.set(index, `${partialJson.get(index) ?? ''}${String(delta.partial_json ?? '')}`);
      result.content[index] = block;
    } else if (type === 'content_block_stop') {
      const index = Number(payload.index ?? 0);
      const raw = partialJson.get(index);
      if (raw !== undefined && result.content[index]) {
        // 参数是一段一段拼出来的，拼到一半断流时宁可给个空对象，也不要抛异常把整次请求作废
        try {
          result.content[index].input = raw === '' ? {} : JSON.parse(raw);
        } catch {
          result.content[index].input = {};
        }
      }
    } else if (type === 'message_delta') {
      const delta = (payload.delta ?? {}) as Record<string, unknown>;
      if (typeof delta.stop_reason === 'string' && delta.stop_reason) result.stopReason = delta.stop_reason;
      if (typeof delta.stop_sequence === 'string') result.stopSequence = delta.stop_sequence;
      const usage = (payload.usage ?? {}) as Record<string, unknown>;
      if (usage.output_tokens !== undefined) result.outputTokens = Number(usage.output_tokens) || 0;
      if (usage.input_tokens !== undefined) result.inputTokens = Number(usage.input_tokens) || 0;
    } else if (type === 'error') {
      const error = (payload.error ?? {}) as Record<string, unknown>;
      throw new Error(String(error.message ?? '上游返回了错误事件'));
    }
  }
  result.content = result.content.filter(Boolean);
  return result;
}

/** 聚合结果序列化成 Anthropic 的非流式响应体。 */
export function toMessageResponse(result: AnthropicResult, model: string): Record<string, unknown> {
  return {
    id: result.id || `msg_${Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    model: result.model || model,
    content: result.content,
    stop_reason: result.stopReason,
    stop_sequence: result.stopSequence,
    usage: { input_tokens: result.inputTokens, output_tokens: result.outputTokens },
  };
}
