/**
 * 内部的 Anthropic IR ⇄ Qoder 的推理方言。
 *
 * Qoder 的推理端点(`/algo/api/v2/service/pro/sse/agent_chat_generation`)收的既不是 Anthropic
 * 也不是标准 OpenAI:请求体是一大包 Qoder 自己的字段(chat_context / business / model_config …),
 * 而且整个请求必须由那份 WASM 原生签名器签过名才收(见 qoder-signer.ts)。响应是 OpenAI 风格的
 * chat.completion.chunk,但**加了密**(URL 带 Encode=1),每条 data 行要先过 decrypt 才是明文。
 *
 * 这份文件负责两件事:
 *   1. 把 Anthropic 请求摊成 Qoder 的 body(含 OpenAI 风格的 messages/tools);
 *   2. 把解密后的 OpenAI 分块流翻回 Anthropic 事件流。
 *
 * 请求体结构照搬 qoder-route 的 direct_client._build_body,只保留本网关真正会用到的字段。
 */
import { blocksOf, event, systemText, type AnthropicMessage, type AnthropicRequest, type ContentBlock, type EventStream } from './anthropic.js';
import { parseSse } from './sse.js';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

type Json = Record<string, unknown>;

/** Qoder 的一个模型档位的静态信息。 */
interface QoderTier {
  key: string;
  name: string;
  isReasoning: boolean;
  isVision: boolean;
  maxInputTokens: number;
  /** 默认上下文窗口;取目录里最大的那个。 */
  contextWindow: number;
}

/**
 * 本网关会用到的 Qoder 档位。
 *
 * 只列转发实际会落到的这几个:Anthropic 的 opus/sonnet/haiku 分别映射到 ultimate/performance/
 * efficient,外加 auto 兜底、lite 备用。字段取值对齐 qoder-route 的 MODEL_CATALOG。
 */
const TIERS: Record<string, QoderTier> = {
  auto: { key: 'auto', name: 'Auto', isReasoning: false, isVision: true, maxInputTokens: 180_000, contextWindow: 180_000 },
  ultimate: { key: 'ultimate', name: 'Ultimate', isReasoning: true, isVision: true, maxInputTokens: 1_000_000, contextWindow: 1_000_000 },
  performance: { key: 'performance', name: 'Performance', isReasoning: false, isVision: true, maxInputTokens: 1_000_000, contextWindow: 1_000_000 },
  efficient: { key: 'efficient', name: 'Efficient', isReasoning: false, isVision: true, maxInputTokens: 180_000, contextWindow: 180_000 },
  lite: { key: 'lite', name: 'Lite', isReasoning: false, isVision: false, maxInputTokens: 180_000, contextWindow: 180_000 },
};

const DEFAULT_TIER = TIERS.efficient;
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

/**
 * Anthropic 模型名 → Qoder 档位。
 *
 * 客户端发的是 Anthropic 命名(claude-opus-… / claude-sonnet-… / claude-haiku-…),按能力档次
 * 对到 Qoder 的三档;也允许直接写 Qoder 档位名(auto/ultimate/performance/efficient/lite)或带
 * `qoder/` 前缀。认不出来就用默认档(efficient),它便宜、什么请求都能接。
 */
export function qoderTierFor(model: string): QoderTier {
  let name = model.trim().toLowerCase();
  const slash = name.lastIndexOf('/');
  if (slash !== -1) name = name.slice(slash + 1).trim();
  // 去掉 Claude Code 会加的 [1m] / [200k] 之类窗口后缀
  name = name.replace(/\[[^\]]*\]/g, '').trim();

  if (TIERS[name]) return TIERS[name];
  if (name.includes('opus')) return TIERS.ultimate;
  if (name.includes('sonnet')) return TIERS.performance;
  if (name.includes('haiku')) return TIERS.efficient;
  return DEFAULT_TIER;
}

/** thinking 预算 → Qoder 的推理档位。上游认 none/low/medium/high/xhigh/max。 */
function reasoningEffort(thinking: Json | undefined): string {
  if (!thinking || thinking.type !== 'enabled') return 'max';
  const budget = Number(thinking.budget_tokens ?? 0);
  if (budget <= 0) return 'none';
  if (budget < 4000) return 'low';
  if (budget < 16000) return 'medium';
  if (budget < 32000) return 'high';
  return 'max';
}

/** 把 Anthropic 内容块收成一段纯文本,tool_result 里也可能嵌着文本。 */
function textOfBlocks(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('');
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => (p && typeof p === 'object' && (p as Json).type === 'text' ? String((p as Json).text ?? '') : '')).join('');
}

/** 一个用户/助手内容块 → OpenAI 风格 message 的 content part(文本或图片)。 */
function contentParts(blocks: ContentBlock[]): Json[] | string {
  const parts: Json[] = [];
  let onlyText = true;
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: String(block.text ?? '') });
    } else if (block.type === 'image') {
      onlyText = false;
      const source = (block.source ?? {}) as Json;
      const url =
        source.type === 'base64'
          ? `data:${String(source.media_type ?? 'image/png')};base64,${String(source.data ?? '')}`
          : String(source.url ?? '');
      if (url) parts.push({ type: 'image_url', image_url: { url } });
    }
  }
  // 纯文本时直接给字符串:多数模型对 [{type:text}] 也认,但字符串更贴近原生 CLI 的形状
  if (onlyText) return textOfBlocks(blocks);
  return parts;
}

/**
 * Anthropic messages → OpenAI 风格 messages。
 *
 * Anthropic 把文本、工具调用、工具结果都塞在同一条消息的内容块里;OpenAI 则摊成
 * assistant.tool_calls 和独立的 tool 消息。这里按块类型分派:
 *   - tool_use  → assistant 消息的 tool_calls 项
 *   - tool_result → 一条独立的 role:"tool" 消息
 *   - thinking  → 丢弃(签名只对签发它的上游有效,原样带过去只会被拒)
 */
function toOpenAiMessages(messages: AnthropicMessage[]): Json[] {
  const out: Json[] = [];
  for (const message of messages) {
    const blocks = blocksOf(message.content);
    if (message.role === 'user') {
      // 工具结果要拆成独立的 tool 消息,排在其余用户内容之前
      const toolResults = blocks.filter((b) => b.type === 'tool_result');
      for (const tr of toolResults) {
        out.push({ role: 'tool', tool_call_id: String(tr.tool_use_id ?? ''), content: toolResultText(tr.content) });
      }
      const rest = blocks.filter((b) => b.type !== 'tool_result');
      if (rest.length > 0) out.push({ role: 'user', content: contentParts(rest) });
      continue;
    }
    // assistant
    const toolCalls = blocks.filter((b) => b.type === 'tool_use');
    const textBlocks = blocks.filter((b) => b.type === 'text' || b.type === 'image');
    const msg: Json = { role: 'assistant', content: textBlocks.length > 0 ? contentParts(textBlocks) : '' };
    if (toolCalls.length > 0) {
      msg.tool_calls = toolCalls.map((tc, i) => ({
        index: i,
        id: String(tc.id ?? ''),
        type: 'function',
        function: { name: String(tc.name ?? ''), arguments: JSON.stringify(tc.input ?? {}) },
      }));
    }
    out.push(msg);
  }
  return out;
}

/** 请求里最后一条用户消息的纯文本;chat_context 与 business.name 都要它。 */
function lastUserText(messages: AnthropicMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue;
    const text = textOfBlocks(blocksOf(messages[i].content).filter((b) => b.type === 'text'));
    if (text) return text;
  }
  return '';
}

/** business.name 是一段短标签,不是提示词副本;取最后一句用户话的前 64 字。 */
function businessName(text: string): string {
  const collapsed = text.split(/\s+/).filter(Boolean).join(' ');
  return collapsed ? collapsed.slice(0, 64) : 'QuotaHot chat';
}

export interface QoderBodyOptions {
  cosyVersion: string;
  sessionId?: string;
  maxTokens?: number;
}

/**
 * Anthropic 请求 → Qoder 推理请求体(JSON 字符串)。
 *
 * 结构对齐 qoder-route direct_client._build_body:三个 id 同值、chat_context 带最后一句用户话、
 * business 信封每次都带(Qwen 那条 provider 路由缺了它会直接失败)。
 */
export function toQoderBody(request: AnthropicRequest, tier: QoderTier, opts: QoderBodyOptions): string {
  const reqId = randomUUID();
  const sessionId = opts.sessionId || randomUUID();
  const effort = reasoningEffort(request.thinking as Json | undefined);
  const thinkingEnabled = effort !== 'none';
  const isReasoning = tier.isReasoning && thinkingEnabled;
  const system = systemText(request.system);
  const last = lastUserText(request.messages);

  const messages = toOpenAiMessages(request.messages);
  if (system) messages.unshift({ role: 'system', content: system });

  const modelConfig: Json = {
    key: tier.key,
    display_name: tier.name,
    model: '',
    format: 'openai',
    is_vl: tier.isVision,
    api_key: '',
    url: '',
    max_input_tokens: tier.maxInputTokens,
    source: 'system',
    is_reasoning: isReasoning,
  };

  const tools = (request.tools ?? []).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.input_schema ?? { type: 'object', properties: {} },
    },
  }));

  const body: Json = {
    request_id: reqId,
    request_set_id: reqId,
    chat_record_id: reqId,
    session_id: sessionId,
    stream: true,
    chat_task: 'FREE_INPUT',
    chat_context: {
      text: last,
      features: [],
      extra: {
        context: [],
        modelConfig: { key: tier.key, is_reasoning: isReasoning },
        originalContent: last,
      },
      chatPrompt: '',
      imageUrls: null,
    },
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    agent_id: 'agent_common',
    task_id: 'common',
    session_type: 'qodercli',
    aliyun_user_type: '',
    model_config: modelConfig,
    system,
    messages,
    tools,
    parameters: {
      max_tokens: opts.maxTokens && opts.maxTokens > 0 ? opts.maxTokens : DEFAULT_MAX_OUTPUT_TOKENS,
      context_length: tier.contextWindow,
      reasoning_effort: effort,
      enable_thinking: thinkingEnabled,
    },
    business: {
      product: 'cli',
      version: opts.cosyVersion,
      type: 'agent',
      id: randomUUID(),
      name: businessName(last),
      begin_at: Date.now(),
      stage: 'start',
    },
  };
  return JSON.stringify(body);
}

/** 一次 SSE 载荷解出来的 OpenAI 分块;可能被包一层 {body, statusCodeValue}。 */
type Decrypt = (payload: string) => string | null;

function tryJson(text: string): Json | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? (v as Json) : null;
  } catch {
    return null;
  }
}

/**
 * Qoder 的加密 SSE 流 → Anthropic 事件流。
 *
 * 每条 `data:` 行先按明文 JSON 试;试不动就交给 WASM 解密再解析(响应带 Encode=1 时是这样)。
 * 拿到的是 OpenAI 的 chat.completion.chunk,delta 里可能有:
 *   - content            → 文本块
 *   - reasoning_content  → thinking 块
 *   - tool_calls[]       → tool_use 块(参数是流式拼出来的 JSON 片段)
 * 块下标由我们自己发号,Anthropic 那边 thinking / text / tool_use 是并列的块,不能沿用上游下标。
 */
export async function* fromQoderStream(stream: Readable, decrypt: Decrypt, fallbackModel: string): EventStream {
  let model = fallbackModel;
  let stopReason = 'end_turn';
  let inputTokens = 0;
  let outputTokens = 0;

  /** 三种块各自的下标;-1 表示还没开。tool_calls 按上游的 index 各占一个。 */
  let textIndex = -1;
  let thinkingIndex = -1;
  const toolSlots = new Map<number, { index: number; id: string; name: string }>();
  let nextIndex = 0;

  const messageStart = (id: string) =>
    event('message_start', {
      message: {
        id: id || `msg_${Date.now().toString(36)}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });

  // 先把 message_start 攒着,等第一条真正有内容的分块到了再发——那时候 model/id 才确定
  let pendingStartId = '';
  let emittedStart = false;
  const flushStart = function* () {
    if (emittedStart) return;
    emittedStart = true;
    yield messageStart(pendingStartId);
  };

  for await (const raw of parseSse(stream)) {
    if (!raw.data) continue;
    let payload = raw.data.trim();
    if (!payload || payload === '[DONE]') continue;

    let data = tryJson(payload);
    if (data === null) {
      const plain = decrypt(payload);
      if (plain) data = tryJson(plain);
    }
    if (data === null) continue;

    // Qoder 有时把真正的 chunk 包一层 {body, statusCodeValue}
    const wrapperStatus = data.statusCodeValue;
    let inner: unknown = data.body;
    if (typeof wrapperStatus === 'number' && wrapperStatus !== 200) {
      const innerObj = typeof inner === 'string' ? tryJson(inner) : (inner as Json | null);
      const message =
        (innerObj && (innerObj.message as string)) ||
        (typeof inner === 'string' ? inner : '') ||
        String(data.message ?? `上游返回 ${wrapperStatus}`);
      yield* flushStart();
      yield event('error', { error: { type: 'upstream_error', message: String(message).slice(0, 512) } });
      return;
    }
    if (typeof inner === 'string') data = tryJson(inner) ?? data;
    else if (inner && typeof inner === 'object') data = inner as Json;

    const upstreamError = data.error;
    if (upstreamError !== undefined && upstreamError !== null) {
      const message =
        typeof upstreamError === 'object'
          ? String((upstreamError as Json).message ?? (upstreamError as Json).code ?? JSON.stringify(upstreamError))
          : String(upstreamError);
      yield* flushStart();
      yield event('error', { error: { type: 'upstream_error', message: message.slice(0, 512) } });
      return;
    }

    if (typeof data.model === 'string' && data.model) model = data.model;
    if (!emittedStart && (data.id || data.model)) pendingStartId = String(data.id ?? pendingStartId);

    const usage = data.usage as Json | undefined;
    if (usage) {
      if (usage.prompt_tokens !== undefined) inputTokens = Number(usage.prompt_tokens) || inputTokens;
      if (usage.input_tokens !== undefined) inputTokens = Number(usage.input_tokens) || inputTokens;
      if (usage.completion_tokens !== undefined) outputTokens = Number(usage.completion_tokens) || outputTokens;
      if (usage.output_tokens !== undefined) outputTokens = Number(usage.output_tokens) || outputTokens;
    }

    const choices = data.choices;
    if (!Array.isArray(choices)) continue;

    for (const choice of choices) {
      if (!choice || typeof choice !== 'object') continue;
      const c = choice as Json;
      const delta = (c.delta ?? {}) as Json;

      const reasoning = delta.reasoning_content;
      if (typeof reasoning === 'string' && reasoning) {
        yield* flushStart();
        if (thinkingIndex === -1) {
          thinkingIndex = nextIndex++;
          yield event('content_block_start', { index: thinkingIndex, content_block: { type: 'thinking', thinking: '' } });
        }
        yield event('content_block_delta', { index: thinkingIndex, delta: { type: 'thinking_delta', thinking: reasoning } });
      }

      const content = delta.content;
      if (typeof content === 'string' && content) {
        yield* flushStart();
        // thinking 块要先收尾,再开文本块——Anthropic 一条消息里两种块不能交错着开
        if (thinkingIndex !== -1 && textIndex === -1) {
          yield event('content_block_stop', { index: thinkingIndex });
          thinkingIndex = -2; // -2:已收尾,不再复用
        }
        if (textIndex === -1) {
          textIndex = nextIndex++;
          yield event('content_block_start', { index: textIndex, content_block: { type: 'text', text: '' } });
        }
        yield event('content_block_delta', { index: textIndex, delta: { type: 'text_delta', text: content } });
      }

      const toolCalls = delta.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tcRaw of toolCalls) {
          const tc = (tcRaw ?? {}) as Json;
          const upstreamIndex = Number(tc.index ?? 0);
          const fn = (tc.function ?? {}) as Json;
          let slot = toolSlots.get(upstreamIndex);
          if (!slot) {
            yield* flushStart();
            const index = nextIndex++;
            slot = { index, id: String(tc.id ?? `call_${index}`), name: String(fn.name ?? '') };
            toolSlots.set(upstreamIndex, slot);
            yield event('content_block_start', {
              index,
              content_block: { type: 'tool_use', id: slot.id, name: slot.name, input: {} },
            });
            stopReason = 'tool_use';
          }
          const args = fn.arguments;
          if (typeof args === 'string' && args) {
            yield event('content_block_delta', { index: slot.index, delta: { type: 'input_json_delta', partial_json: args } });
          }
        }
      }

      const finish = c.finish_reason;
      if (typeof finish === 'string' && finish) {
        if (finish === 'length') stopReason = 'max_tokens';
        else if (finish === 'tool_calls') stopReason = 'tool_use';
        else if (finish === 'stop' && stopReason !== 'tool_use') stopReason = 'end_turn';
      }
    }
  }

  // 断流/正常收尾:补齐所有还开着的块,再发结束事件
  yield* flushStart();
  if (thinkingIndex >= 0) yield event('content_block_stop', { index: thinkingIndex });
  if (textIndex >= 0) yield event('content_block_stop', { index: textIndex });
  for (const slot of [...toolSlots.values()].sort((a, b) => a.index - b.index)) {
    yield event('content_block_stop', { index: slot.index });
  }
  yield event('message_delta', {
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  });
  yield event('message_stop', {});
}
