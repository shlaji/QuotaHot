/**
 * OpenAI Chat Completions 方言 ⇄ 内部的 Anthropic IR。
 *
 * 只做双向的形状翻译，不认识账户、上游和网络。两边对不上的地方按同一条原则处理：
 * **宁可少给一个字段，也不要编一个上游没说过的值**——例如 OpenAI 的 `finish_reason`
 * 只有那么几种，Anthropic 报了别的就落到 `stop`，而不是原样透出去让客户端崩在枚举上。
 */
import { blocksOf, event, type AnthropicMessage, type AnthropicRequest, type AnthropicResult, type ContentBlock, type EventStream } from './anthropic.js';
import { sseFrame, type SseEvent } from './sse.js';

/** 客户端没写 max_tokens 时给的值；Anthropic 这个字段是必填的，OpenAI 不是。 */
const DEFAULT_MAX_TOKENS = 8192;

type Json = Record<string, unknown>;

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * OpenAI 的一条消息内容：可能是字符串，也可能是 `{type:'text'|'image_url'}` 的数组。
 * 图片按 Anthropic 的 base64 image 块翻译；URL 形式的图片 Anthropic 也认，直接给 url 源。
 */
function contentBlocks(content: unknown): ContentBlock[] {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }];
  const out: ContentBlock[] = [];
  for (const part of asArray(content)) {
    const p = (part ?? {}) as Json;
    if (p.type === 'text' && typeof p.text === 'string') out.push({ type: 'text', text: p.text });
    else if (p.type === 'image_url') {
      const url = String(((p.image_url ?? {}) as Json).url ?? '');
      const match = /^data:([^;]+);base64,(.*)$/.exec(url);
      if (match) out.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
      else if (url) out.push({ type: 'image', source: { type: 'url', url } });
    }
  }
  return out;
}

/** assistant 消息里的 tool_calls → Anthropic 的 tool_use 块。 */
function toolUseBlocks(toolCalls: unknown): ContentBlock[] {
  return asArray(toolCalls).map((raw) => {
    const call = (raw ?? {}) as Json;
    const fn = (call.function ?? {}) as Json;
    let input: unknown = {};
    try {
      input = JSON.parse(String(fn.arguments ?? '{}'));
    } catch {
      // 参数不是合法 JSON 时保留原文，让模型自己看到它写坏了什么
      input = { _raw: String(fn.arguments ?? '') };
    }
    return { type: 'tool_use', id: String(call.id ?? ''), name: String(fn.name ?? ''), input };
  });
}

/**
 * OpenAI 的 messages 数组 → Anthropic 的 system + messages。
 *
 * 三处形状差异要在这里抹平：
 * 1. system 在 OpenAI 是消息，在 Anthropic 是顶层字段；
 * 2. 工具结果在 OpenAI 是 `role:'tool'` 的独立消息，在 Anthropic 是 user 消息里的 tool_result 块；
 * 3. Anthropic 要求 user / assistant 严格交替，所以相邻的同角色消息要并成一条。
 */
function convertMessages(raw: unknown[]): { system: string; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const messages: AnthropicMessage[] = [];

  const push = (role: 'user' | 'assistant', blocks: ContentBlock[]): void => {
    if (blocks.length === 0) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content = [...blocksOf(last.content), ...blocks];
    else messages.push({ role, content: blocks });
  };

  for (const item of raw) {
    const msg = (item ?? {}) as Json;
    const role = String(msg.role ?? 'user');
    if (role === 'system' || role === 'developer') {
      const text = contentBlocks(msg.content)
        .filter((b) => b.type === 'text')
        .map((b) => String(b.text ?? ''))
        .join('\n');
      if (text) systemParts.push(text);
    } else if (role === 'tool') {
      push('user', [
        {
          type: 'tool_result',
          tool_use_id: String(msg.tool_call_id ?? ''),
          content: typeof msg.content === 'string' ? msg.content : contentBlocks(msg.content),
        },
      ]);
    } else if (role === 'assistant') {
      push('assistant', [...contentBlocks(msg.content), ...toolUseBlocks(msg.tool_calls)]);
    } else {
      push('user', contentBlocks(msg.content));
    }
  }
  return { system: systemParts.join('\n\n'), messages };
}

function convertTools(raw: unknown): AnthropicRequest['tools'] {
  const tools = asArray(raw)
    .map((item) => {
      const fn = ((item ?? {}) as Json).function as Json | undefined;
      if (!fn || typeof fn.name !== 'string') return null;
      return {
        name: fn.name,
        description: typeof fn.description === 'string' ? fn.description : undefined,
        input_schema: (fn.parameters as Json | undefined) ?? { type: 'object', properties: {} },
      };
    })
    .filter((t): t is NonNullable<typeof t> => t !== null);
  return tools.length > 0 ? tools : undefined;
}

function convertToolChoice(raw: unknown): Json | undefined {
  if (raw === 'auto') return { type: 'auto' };
  if (raw === 'required') return { type: 'any' };
  if (raw === 'none') return { type: 'none' };
  const choice = (raw ?? {}) as Json;
  if (choice.type === 'function') {
    const name = String(((choice.function ?? {}) as Json).name ?? '');
    if (name) return { type: 'tool', name };
  }
  return undefined;
}

/** OpenAI 的请求体 → 内部 IR。 */
export function fromOpenAi(body: Json): AnthropicRequest {
  const { system, messages } = convertMessages(asArray(body.messages));
  const maxTokens = Number(body.max_completion_tokens ?? body.max_tokens ?? 0);
  const request: AnthropicRequest = {
    model: String(body.model ?? ''),
    messages,
    max_tokens: maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS,
    stream: Boolean(body.stream),
  };
  if (system) request.system = system;
  if (typeof body.temperature === 'number') request.temperature = body.temperature;
  if (typeof body.top_p === 'number') request.top_p = body.top_p;
  if (typeof body.stop === 'string') request.stop_sequences = [body.stop];
  else if (Array.isArray(body.stop)) request.stop_sequences = body.stop.map(String);
  const tools = convertTools(body.tools);
  if (tools) request.tools = tools;
  const toolChoice = convertToolChoice(body.tool_choice);
  if (toolChoice) request.tool_choice = toolChoice;
  return request;
}

/** Anthropic 的停止原因 → OpenAI 的 finish_reason；没有对应项时落到 stop。 */
function finishReason(stopReason: string): string {
  if (stopReason === 'max_tokens') return 'length';
  if (stopReason === 'tool_use') return 'tool_calls';
  return 'stop';
}

function toolCallsOf(content: ContentBlock[]): Json[] {
  return content
    .filter((b) => b.type === 'tool_use')
    .map((b, index) => ({
      index,
      id: String(b.id ?? ''),
      type: 'function',
      function: { name: String(b.name ?? ''), arguments: JSON.stringify(b.input ?? {}) },
    }));
}

/** 聚合结果 → OpenAI 的非流式响应体。 */
export function toChatCompletion(result: AnthropicResult, model: string, id: string): Json {
  const text = result.content
    .filter((b) => b.type === 'text')
    .map((b) => String(b.text ?? ''))
    .join('');
  const toolCalls = toolCallsOf(result.content);
  const message: Json = { role: 'assistant', content: text === '' && toolCalls.length > 0 ? null : text };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  // 思考过程用 reasoning_content 透出：这是 OpenAI 兼容生态里事实上的那个字段名
  const thinking = result.content
    .filter((b) => b.type === 'thinking')
    .map((b) => String(b.thinking ?? ''))
    .join('');
  if (thinking) message.reasoning_content = thinking;
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: result.model || model,
    choices: [{ index: 0, message, finish_reason: finishReason(result.stopReason) }],
    usage: {
      prompt_tokens: result.inputTokens,
      completion_tokens: result.outputTokens,
      total_tokens: result.inputTokens + result.outputTokens,
    },
  };
}

function chunk(id: string, model: string, delta: Json, finish: string | null = null): string {
  return sseFrame(
    '',
    JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    }),
  );
}

/**
 * Anthropic 事件流 → OpenAI 的流式分片。
 *
 * 工具调用这段是两边差得最远的地方：Anthropic 先用 content_block_start 交代 id 和函数名，
 * 之后的参数一片片流过来；OpenAI 则要求每个分片自带 `index`，靠它把片段归位。所以这里要
 * 记住每个块被分到了哪个 tool_call index，不能只顺着流往外抄。
 */
export async function* toChatStream(events: EventStream, model: string, id: string): AsyncGenerator<string> {
  /** 内容块下标 → 这个块是第几个 tool_call；不是工具块的不入表。 */
  const toolIndex = new Map<number, number>();
  let toolCount = 0;
  let finish = 'stop';
  let usage: Json | null = null;
  let started = false;

  for await (const evt of events) {
    let payload: Json;
    try {
      payload = JSON.parse(evt.data) as Json;
    } catch {
      continue;
    }
    const type = String(payload.type ?? evt.event);
    if (!started) {
      // 第一片只带 role，OpenAI 的客户端普遍靠它确认这是一条 assistant 回复
      yield chunk(id, model, { role: 'assistant' });
      started = true;
    }
    if (type === 'content_block_start') {
      const index = Number(payload.index ?? 0);
      const block = (payload.content_block ?? {}) as ContentBlock;
      if (block.type === 'tool_use') {
        const slot = toolCount++;
        toolIndex.set(index, slot);
        yield chunk(id, model, {
          tool_calls: [
            { index: slot, id: String(block.id ?? ''), type: 'function', function: { name: String(block.name ?? ''), arguments: '' } },
          ],
        });
      }
    } else if (type === 'content_block_delta') {
      const index = Number(payload.index ?? 0);
      const delta = (payload.delta ?? {}) as Json;
      if (delta.type === 'text_delta') yield chunk(id, model, { content: String(delta.text ?? '') });
      else if (delta.type === 'thinking_delta') yield chunk(id, model, { reasoning_content: String(delta.thinking ?? '') });
      else if (delta.type === 'input_json_delta') {
        const slot = toolIndex.get(index);
        if (slot !== undefined) {
          yield chunk(id, model, {
            tool_calls: [{ index: slot, function: { arguments: String(delta.partial_json ?? '') } }],
          });
        }
      }
    } else if (type === 'message_delta') {
      const delta = (payload.delta ?? {}) as Json;
      if (typeof delta.stop_reason === 'string' && delta.stop_reason) finish = finishReason(delta.stop_reason);
      const reported = (payload.usage ?? {}) as Json;
      if (reported.output_tokens !== undefined) {
        usage = {
          prompt_tokens: Number(reported.input_tokens ?? 0) || 0,
          completion_tokens: Number(reported.output_tokens ?? 0) || 0,
          total_tokens: (Number(reported.input_tokens ?? 0) || 0) + (Number(reported.output_tokens ?? 0) || 0),
        };
      }
    } else if (type === 'error') {
      const error = (payload.error ?? {}) as Json;
      throw new Error(String(error.message ?? '上游返回了错误事件'));
    }
  }

  if (!started) yield chunk(id, model, { role: 'assistant' });
  yield chunk(id, model, {}, finish);
  // usage 分片是 stream_options.include_usage 才该发的，但多发一片只带 usage 的分片
  // 对客户端是无害的：choices 为空，解析器会照常跳过
  if (usage) {
    yield sseFrame(
      '',
      JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [], usage }),
    );
  }
  yield sseFrame('', '[DONE]');
}

/** 出错时给客户端的那一帧；流已经开了就只能用事件把错误告诉它。 */
export function errorFrame(message: string, type = 'upstream_error'): SseEvent {
  return event('error', { error: { type, message } });
}
