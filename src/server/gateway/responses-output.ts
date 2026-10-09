import type { AnthropicResult, ContentBlock, EventStream } from './anthropic.js';
import { sseFrame, sseJson } from './sse.js';

type Json = Record<string, unknown>;

type OutputItem = Json & { type: string; id: string };
type ResponseBody = Json & { id: string; model: string; status: string; output: OutputItem[] };

function record(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value)) : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function usage(inputTokens: number, outputTokens: number): Json {
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
}

function itemOf(block: ContentBlock, id: string): OutputItem | null {
  switch (block.type) {
    case 'text':
      return { id, type: 'message', status: 'completed', role: 'assistant',
        content: [{ type: 'output_text', text: text(block.text), annotations: [] }] };
    case 'thinking':
      return { id, type: 'reasoning', summary: [{ type: 'summary_text', text: text(block.thinking) }] };
    case 'tool_use':
      return { id, type: 'function_call', status: 'completed', call_id: text(block.id),
        name: text(block.name), arguments: JSON.stringify(block.input ?? {}) };
    default:
      return null;
  }
}

function statusOf(stopReason: string): 'completed' | 'incomplete' {
  return stopReason === 'max_tokens' ? 'incomplete' : 'completed';
}

export function toResponsesResult(result: AnthropicResult, model: string, id: string): ResponseBody {
  const output = result.content.flatMap((block, index) => {
    const item = itemOf(block, `${id}_item_${index}`);
    return item ? [item] : [];
  });
  const status = statusOf(result.stopReason);
  return {
    id, object: 'response', created_at: Math.floor(Date.now() / 1000),
    status, model: result.model || model, output,
    error: null, incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    usage: usage(result.inputTokens, result.outputTokens),
  };
}

type Active = {
  readonly index: number;
  readonly item: OutputItem;
  text: string;
  argumentDeltas: boolean;
};

export async function* toResponsesStream(events: EventStream, model: string, id: string): AsyncGenerator<string> {
  const createdAt = Math.floor(Date.now() / 1000);
  const output: OutputItem[] = [];
  const active = new Map<number, Active>();
  let sequence = 0;
  let started = false;
  let terminated = false;
  let responseModel = model;
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = 'end_turn';
  let hasTerminalDelta = false;

  const frame = (type: string, fields: Json): string => sseFrame(type, JSON.stringify({ type, ...fields, sequence_number: ++sequence }));
  const response = (status: string): ResponseBody => ({
    id, object: 'response', created_at: createdAt, model: responseModel, status,
    output: [...output], error: null, incomplete_details: null,
    usage: status === 'in_progress' ? null : usage(inputTokens, outputTokens),
  });
  function* open(): Generator<string> {
    if (started) return;
    started = true;
    yield frame('response.created', { response: response('in_progress') });
    yield frame('response.in_progress', { response: response('in_progress') });
  }
  function* close(slot: number): Generator<string> {
    const current = active.get(slot);
    if (!current) return;
    const { item, index } = current;
    switch (item.type) {
      case 'message': {
        const part = { type: 'output_text', text: current.text, annotations: [] };
        item.content = [part];
        yield frame('response.output_text.done', { item_id: item.id, output_index: index, content_index: 0, text: current.text });
        yield frame('response.content_part.done', { item_id: item.id, output_index: index, content_index: 0, part });
        break;
      }
      case 'reasoning': {
        const part = { type: 'summary_text', text: current.text };
        item.summary = [part];
        yield frame('response.reasoning_summary_text.done', { item_id: item.id, output_index: index, summary_index: 0, text: current.text });
        yield frame('response.reasoning_summary_part.done', { item_id: item.id, output_index: index, summary_index: 0, part });
        break;
      }
      case 'function_call':
        item.arguments = current.text;
        yield frame('response.function_call_arguments.done', { item_id: item.id, output_index: index, arguments: item.arguments });
        break;
    }
    item.status = 'completed';
    yield frame('response.output_item.done', { output_index: index, item });
    active.delete(slot);
  }

  try {
  for await (const event of events) {
    const payload = sseJson(event);
    if (!payload) continue;
    const kind = text(payload.type) || event.event;
    if (kind === 'message_start') {
      const message = record(payload.message);
      responseModel = text(message.model) || model;
      inputTokens = Number(record(message.usage).input_tokens ?? 0) || 0;
    }
    yield* open();
    if (kind === 'content_block_start') {
      const slot = Number(payload.index ?? 0);
      const block = record(payload.content_block);
      const item = itemOf({ ...block, type: text(block.type) }, `${id}_item_${output.length}`);
      if (!item) continue;
      const index = output.length;
      const initial = item.type === 'message' ? text(block.text) : item.type === 'reasoning' ? text(block.thinking)
        : JSON.stringify(block.input ?? {});
      const current: Active = { index, item, text: initial, argumentDeltas: false };
      output.push(item);
      active.set(slot, current);
      if (item.type === 'message') item.content = [];
      if (item.type === 'reasoning') item.summary = [];
      if (item.type === 'function_call') item.arguments = '';
      item.status = 'in_progress';
      yield frame('response.output_item.added', { output_index: index, item: { ...item } });
      if (item.type === 'message') {
        yield frame('response.content_part.added', { item_id: item.id, output_index: index, content_index: 0,
          part: { type: 'output_text', text: initial, annotations: [] } });
      } else if (item.type === 'reasoning') {
        yield frame('response.reasoning_summary_part.added', { item_id: item.id, output_index: index, summary_index: 0,
          part: { type: 'summary_text', text: initial } });
      }
    } else if (kind === 'content_block_delta') {
      const current = active.get(Number(payload.index ?? 0));
      if (!current) continue;
      const delta = record(payload.delta);
      if (current.item.type === 'message' && delta.type === 'text_delta') {
        const fragment = text(delta.text);
        current.text += fragment;
        yield frame('response.output_text.delta', { item_id: current.item.id, output_index: current.index, content_index: 0, delta: fragment });
      } else if (current.item.type === 'reasoning' && delta.type === 'thinking_delta') {
        const fragment = text(delta.thinking);
        current.text += fragment;
        yield frame('response.reasoning_summary_text.delta', { item_id: current.item.id, output_index: current.index, summary_index: 0, delta: fragment });
      } else if (current.item.type === 'function_call' && delta.type === 'input_json_delta') {
        const fragment = text(delta.partial_json);
        current.text = current.argumentDeltas ? current.text + fragment : fragment;
        current.argumentDeltas = true;
        yield frame('response.function_call_arguments.delta', { item_id: current.item.id, output_index: current.index, delta: fragment });
      }
    } else if (kind === 'content_block_stop') {
      yield* close(Number(payload.index ?? 0));
    } else if (kind === 'message_delta') {
      hasTerminalDelta = true;
      const delta = record(payload.delta);
      if (typeof delta.stop_reason === 'string') stopReason = delta.stop_reason;
      const reported = record(payload.usage);
      if (reported.input_tokens !== undefined) inputTokens = Number(reported.input_tokens) || 0;
      if (reported.output_tokens !== undefined) outputTokens = Number(reported.output_tokens) || 0;
    } else if (kind === 'error') {
      const error = record(payload.error);
      const failed = { ...response('failed'), error: { code: text(error.type) || 'upstream_error', message: text(error.message) || 'Upstream error' } };
      yield frame('response.failed', { response: failed });
      terminated = true;
      break;
    }
  }
  } catch (error) {
    yield* open();
    yield frame('response.failed', { response: { ...response('failed'), error: {
      code: 'upstream_error', message: error instanceof Error ? error.message : 'Upstream error',
    } } });
    return;
  }

  if (terminated) return;
  yield* open();
  for (const slot of active.keys()) yield* close(slot);
  if (!hasTerminalDelta) {
    yield frame('response.failed', { response: { ...response('failed'), error: { code: 'incomplete_stream', message: 'Upstream stream ended before completion' } } });
    return;
  }
  const status = statusOf(stopReason);
  const finished = response(status);
  finished.incomplete_details = status === 'incomplete' ? { reason: 'max_output_tokens' } : null;
  finished.completed_at = Math.floor(Date.now() / 1000);
  yield frame(`response.${status}`, { response: finished });
}
