/**
 * 内部的 Anthropic IR ⇄ Codex 的 Responses 方言。
 *
 * Codex 账户只有一个能用的推理端点：`chatgpt.com/backend-api/codex/responses`，它收的是
 * OpenAI Responses 格式，而且**只接受流式**（见 providers.ts 里保活发送的同一条注释）。
 * 所以出口这边没有「非流式直通」这种选项，非流式请求也得先流回来再攒。
 *
 * 两边最不像的是「一条消息里可以有什么」：Anthropic 把文本、思考、工具调用都当成同一条
 * assistant 消息里的内容块，Responses 则把它们摊平成一串 output item。于是转换的核心工作
 * 就是给 item 和块下标建一张对照表，而不是逐字段抄。
 */
import { blocksOf, event, systemText, type AnthropicRequest, type ContentBlock, type EventStream } from './anthropic.js';
import { parseSse, sseJson } from './sse.js';
import type { Readable } from 'node:stream';

type Json = Record<string, unknown>;

/** thinking 预算 → Responses 的推理档位。上游只认这三档，所以按预算折算。 */
function reasoningEffort(thinking: Json | undefined): string {
  if (!thinking || thinking.type !== 'enabled') return 'medium';
  const budget = Number(thinking.budget_tokens ?? 0);
  if (budget >= 16000) return 'high';
  if (budget > 0 && budget < 4000) return 'low';
  return 'medium';
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const p = (part ?? {}) as Json;
      return p.type === 'text' ? String(p.text ?? '') : '';
    })
    .join('');
}

/** 一条 Anthropic 消息 → 零个或多个 Responses 的 input item。 */
function inputItems(role: 'user' | 'assistant', blocks: ContentBlock[]): Json[] {
  const items: Json[] = [];
  const parts: Json[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: String(block.text ?? '') });
    } else if (block.type === 'image' && role === 'user') {
      const source = (block.source ?? {}) as Json;
      const url =
        source.type === 'base64'
          ? `data:${String(source.media_type ?? 'image/png')};base64,${String(source.data ?? '')}`
          : String(source.url ?? '');
      if (url) parts.push({ type: 'input_image', image_url: url });
    } else if (block.type === 'tool_use') {
      items.push({
        type: 'function_call',
        name: String(block.name ?? ''),
        arguments: JSON.stringify(block.input ?? {}),
        call_id: String(block.id ?? ''),
      });
    } else if (block.type === 'tool_result') {
      // 工具结果在 Responses 里是独立 item，不属于任何一条消息
      items.push({
        type: 'function_call_output',
        call_id: String(block.tool_use_id ?? ''),
        output: textFromContent(block.content),
      });
    }
    // thinking 块不回传：签名只对签发它的那家上游有意义，原样发给 Codex 只会被拒
  }
  // 消息 item 要排在它自己产生的 function_call 之前，顺序错了上游会认为工具调用凭空出现
  return parts.length > 0 ? [{ type: 'message', role, content: parts }, ...items] : items;
}

/** 内部 IR → Responses 请求体。 */
export function toCodexRequest(request: AnthropicRequest, model: string): Json {
  const input: Json[] = [];
  for (const message of request.messages) input.push(...inputItems(message.role, blocksOf(message.content)));

  const body: Json = {
    model,
    // Responses 把 system 叫 instructions；为空时也得给一句，上游不接受空指令
    instructions: systemText(request.system) || 'You are a helpful assistant.',
    input,
    stream: true,
    // 这个端点是给 CLI 用的，不做服务端会话留存；留存了反而会把用户的对话存在账户名下
    store: false,
    reasoning: { effort: reasoningEffort(request.thinking as Json | undefined), summary: 'auto' },
  };
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.input_schema ?? { type: 'object', properties: {} },
      strict: false,
    }));
    const choice = request.tool_choice;
    if (choice?.type === 'any') body.tool_choice = 'required';
    else if (choice?.type === 'none') body.tool_choice = 'none';
    else if (choice?.type === 'tool') body.tool_choice = { type: 'function', name: String(choice.name ?? '') };
    else body.tool_choice = 'auto';
  }
  // temperature / top_p / max_output_tokens 一律不转发：这个端点只认 Codex CLI 用得上的那几个字段，
  // 带上任何一个都会被上游用 400 "Unsupported parameter" 顶回来（三个都实测过）。
  // 客户端写了也只能丢掉——丢掉还能出结果，带上去就是整个请求失败。
  return body;
}

/**
 * Responses 事件流 → Anthropic 事件流。
 *
 * 块下标由我们自己发号：Responses 的 output_index 会把 reasoning、message、function_call
 * 排在同一个序列里，而 Anthropic 那边 thinking 和 text 是两种块，中途还可能整段没有内容。
 * 直接沿用上游的下标会在客户端那边留出空洞，有些 SDK 会因此报错。
 */
export async function* fromCodexStream(stream: Readable, fallbackModel: string): EventStream {
  /** Responses 的 output_index → 我们分配的 Anthropic 块下标。 */
  const slots = new Map<number, number>();
  let nextSlot = 0;
  let started = false;
  let model = fallbackModel;
  let stopReason = 'end_turn';
  let inputTokens = 0;
  let outputTokens = 0;

  const open = (outputIndex: number, block: ContentBlock): { index: number; frame: ReturnType<typeof event> } => {
    const index = nextSlot++;
    slots.set(outputIndex, index);
    return { index, frame: event('content_block_start', { index, content_block: block }) };
  };

  for await (const raw of parseSse(stream)) {
    const payload = sseJson(raw);
    if (!payload) continue;
    const type = String(payload.type ?? raw.event);

    if (type === 'response.created' || type === 'response.in_progress') {
      if (started) continue;
      const response = (payload.response ?? {}) as Json;
      model = String(response.model ?? fallbackModel) || fallbackModel;
      started = true;
      yield event('message_start', {
        message: {
          id: String(response.id ?? `msg_${Date.now().toString(36)}`),
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      continue;
    }

    // 上游偶尔会在 response.created 之前就推第一个 item；缺了 message_start 客户端无法开始
    if (!started && type.startsWith('response.')) {
      started = true;
      yield event('message_start', {
        message: {
          id: `msg_${Date.now().toString(36)}`,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    }

    if (type === 'response.output_item.added') {
      const item = (payload.item ?? {}) as Json;
      const outputIndex = Number(payload.output_index ?? 0);
      if (item.type === 'function_call') {
        const { frame } = open(outputIndex, {
          type: 'tool_use',
          id: String(item.call_id ?? item.id ?? ''),
          name: String(item.name ?? ''),
          input: {},
        });
        yield frame;
      } else if (item.type === 'reasoning') {
        const { frame } = open(outputIndex, { type: 'thinking', thinking: '' });
        yield frame;
      } else if (item.type === 'message') {
        const { frame } = open(outputIndex, { type: 'text', text: '' });
        yield frame;
      }
    } else if (type === 'response.output_text.delta') {
      const index = slots.get(Number(payload.output_index ?? 0));
      if (index !== undefined) {
        yield event('content_block_delta', { index, delta: { type: 'text_delta', text: String(payload.delta ?? '') } });
      }
    } else if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
      const index = slots.get(Number(payload.output_index ?? 0));
      if (index !== undefined) {
        yield event('content_block_delta', {
          index,
          delta: { type: 'thinking_delta', thinking: String(payload.delta ?? '') },
        });
      }
    } else if (type === 'response.function_call_arguments.delta') {
      const index = slots.get(Number(payload.output_index ?? 0));
      if (index !== undefined) {
        yield event('content_block_delta', {
          index,
          delta: { type: 'input_json_delta', partial_json: String(payload.delta ?? '') },
        });
      }
    } else if (type === 'response.output_item.done') {
      const outputIndex = Number(payload.output_index ?? 0);
      const index = slots.get(outputIndex);
      if (index !== undefined) {
        const item = (payload.item ?? {}) as Json;
        if (item.type === 'function_call') stopReason = 'tool_use';
        yield event('content_block_stop', { index });
        slots.delete(outputIndex);
      }
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      const response = (payload.response ?? {}) as Json;
      const usage = (response.usage ?? {}) as Json;
      inputTokens = Number(usage.input_tokens ?? 0) || 0;
      outputTokens = Number(usage.output_tokens ?? 0) || 0;
      const incomplete = (response.incomplete_details ?? {}) as Json;
      if (String(incomplete.reason ?? '') === 'max_output_tokens') stopReason = 'max_tokens';
    } else if (type === 'response.failed' || type === 'error') {
      const detail = ((payload.response ?? payload) as Json).error ?? payload;
      const message = String(((detail ?? {}) as Json).message ?? '上游返回了错误事件');
      yield event('error', { error: { type: 'upstream_error', message } });
      return;
    }
  }

  // 断流时可能还有没收尾的块；不补 stop 的话客户端会一直等着这个块结束
  for (const index of [...slots.values()].sort((a, b) => a - b)) yield event('content_block_stop', { index });
  yield event('message_delta', {
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  });
  yield event('message_stop', {});
}
