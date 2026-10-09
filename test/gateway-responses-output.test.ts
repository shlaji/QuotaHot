import assert from 'node:assert/strict';
import { test } from 'node:test';
import { event, type AnthropicResult, type EventStream } from '../src/server/gateway/anthropic.js';
import { toResponsesResult, toResponsesStream } from '../src/server/gateway/responses-output.js';

async function* source(...events: ReturnType<typeof event>[]): EventStream {
  for (const item of events) yield item;
}

async function frames(events: EventStream): Promise<Record<string, unknown>[]> {
  const output: Record<string, unknown>[] = [];
  for await (const frame of toResponsesStream(events, 'requested-model', 'resp_test')) {
    const match = /^event: ([^\n]+)\ndata: (.+)\n\n$/.exec(frame);
    assert.ok(match, `invalid SSE frame: ${frame}`);
    const payload: unknown = JSON.parse(match[2]);
    assert.ok(payload !== null && typeof payload === 'object');
    assert.equal(Reflect.get(payload, 'type'), match[1]);
    output.push(Object.fromEntries(Object.entries(payload)));
  }
  return output;
}

const start = event('message_start', { message: { model: 'actual-model', usage: { input_tokens: 7 } } });

test('non-stream response maps ordered text, reasoning and calls with unique item IDs', () => {
  const result: AnthropicResult = {
    id: 'msg_1', model: 'actual-model', stopReason: 'tool_use', stopSequence: null,
    inputTokens: 7, outputTokens: 4,
    content: [
      { type: 'thinking', thinking: 'consider' },
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 'call_1', name: 'lookup', input: { term: 'x' } },
      { type: 'text', text: 'world' },
      { type: 'tool_use', id: 'call_2', name: 'save', input: {} },
    ],
  };

  const response = toResponsesResult(result, 'requested-model', 'resp_test');

  assert.equal(response.id, 'resp_test');
  assert.equal(response.model, 'actual-model');
  assert.equal(response.status, 'completed');
  assert.deepEqual(response.usage, { input_tokens: 7, output_tokens: 4, total_tokens: 11,
    input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } });
  const output = response.output;
  assert.deepEqual(output.map((item) => item.type), ['reasoning', 'message', 'function_call', 'message', 'function_call']);
  assert.equal(new Set(output.map((item) => item.id)).size, 5);
  assert.deepEqual(output[0].summary, [{ type: 'summary_text', text: 'consider' }]);
  assert.deepEqual(output[1].content, [{ type: 'output_text', text: 'hello', annotations: [] }]);
  assert.deepEqual(output[2], { type: 'function_call', id: output[2].id, call_id: 'call_1', name: 'lookup', arguments: '{"term":"x"}', status: 'completed' });
  assert.deepEqual(output[3].content, [{ type: 'output_text', text: 'world', annotations: [] }]);
  assert.equal(output[4].call_id, 'call_2');
});

test('non-stream max tokens reports incomplete instead of completed', () => {
  const response = toResponsesResult({ id: '', model: '', content: [], stopReason: 'max_tokens', stopSequence: null,
    inputTokens: 0, outputTokens: 2 }, 'requested-model', 'resp_test');

  assert.equal(response.status, 'incomplete');
  assert.deepEqual(response.incomplete_details, { reason: 'max_output_tokens' });
  assert.equal(response.model, 'requested-model');
});

test('stream emits ordered text lifecycle, contiguous indexes and terminal usage without DONE marker', async () => {
  const output = await frames(source(start,
    event('content_block_start', { index: 3, content_block: { type: 'text', text: '' } }),
    event('content_block_delta', { index: 3, delta: { type: 'text_delta', text: 'hello' } }),
    event('content_block_delta', { index: 3, delta: { type: 'text_delta', text: ' world' } }),
    event('content_block_stop', { index: 3 }),
    event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }),
    event('message_stop', {}),
  ));

  assert.deepEqual(output.map((item) => item.type), [
    'response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added',
    'response.output_text.delta', 'response.output_text.delta', 'response.output_text.done',
    'response.content_part.done', 'response.output_item.done', 'response.completed',
  ]);
  assert.deepEqual(output.map((item) => item.sequence_number), output.map((_, index) => index + 1));
  assert.equal(output[2].output_index, 0);
  assert.equal(output[3].content_index, 0);
  assert.equal(output[4].item_id, output[2].item?.id);
  assert.equal(output[6].text, 'hello world');
  assert.deepEqual(output[7].part, { type: 'output_text', text: 'hello world', annotations: [] });
  const completed = output[9].response;
  assert.ok(completed !== null && typeof completed === 'object');
  assert.equal(Reflect.get(completed, 'status'), 'completed');
  assert.equal(Reflect.get(Reflect.get(completed, 'usage') ?? {}, 'total_tokens'), 11);
});

test('stream keeps tool argument fragments assigned to their own output items', async () => {
  const output = await frames(source(start,
    event('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'call_A', name: 'alpha', input: {} } }),
    event('content_block_start', { index: 5, content_block: { type: 'tool_use', id: 'call_B', name: 'beta', input: {} } }),
    event('content_block_delta', { index: 5, delta: { type: 'input_json_delta', partial_json: '{"b":1}' } }),
    event('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"a":2}' } }),
    event('content_block_stop', { index: 5 }),
    event('content_block_stop', { index: 2 }),
    event('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }),
  ));

  const added = output.filter((item) => item.type === 'response.output_item.added');
  assert.deepEqual(added.map((item) => item.output_index), [0, 1]);
  assert.deepEqual(added.map((item) => Reflect.get(item.item ?? {}, 'arguments')), ['', '']);
  assert.equal(new Set(added.map((item) => Reflect.get(item.item ?? {}, 'id'))).size, 2);
  const deltas = output.filter((item) => item.type === 'response.function_call_arguments.delta');
  assert.deepEqual(deltas.map((item) => [item.output_index, item.delta]), [[1, '{"b":1}'], [0, '{"a":2}']]);
  const done = output.filter((item) => item.type === 'response.function_call_arguments.done');
  assert.deepEqual(done.map((item) => [item.output_index, item.arguments]), [[1, '{"b":1}'], [0, '{"a":2}']]);
  assert.equal(output.at(-1)?.type, 'response.completed');
});

test('stream reasoning uses summary events and incomplete terminal state', async () => {
  const output = await frames(source(start,
    event('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
    event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'first' } }),
    event('content_block_stop', { index: 0 }),
    event('message_delta', { delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 2 } }),
  ));

  assert.deepEqual(output.filter((item) => String(item.type).startsWith('response.reasoning_')).map((item) => item.type),
    ['response.reasoning_summary_part.added', 'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.done', 'response.reasoning_summary_part.done']);
  assert.equal(output.at(-1)?.type, 'response.incomplete');
  assert.deepEqual(Reflect.get(output.at(-1)?.response ?? {}, 'incomplete_details'), { reason: 'max_output_tokens' });
});

test('stream preserves completed tool input when no argument deltas arrive', async () => {
  const output = await frames(source(start,
    event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'lookup', input: { query: 'x' } } }),
    event('content_block_stop', { index: 0 }),
    event('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }),
  ));

  const done = output.find((item) => item.type === 'response.function_call_arguments.done');
  assert.equal(done?.arguments, '{"query":"x"}');
});

test('stream error emits response.failed instead of response.completed', async () => {
  const output = await frames(source(start,
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    event('error', { error: { type: 'upstream_error', message: 'disconnected' } }),
  ));

  assert.equal(output.at(-1)?.type, 'response.failed');
  assert.deepEqual(Reflect.get(output.at(-1)?.response ?? {}, 'error'),
    { code: 'upstream_error', message: 'disconnected' });
  assert.equal(output.some((item) => item.type === 'response.completed'), false);
});

test('stream emits one complete response.failed when upstream generator throws after message_start', async () => {
  async function* broken(): EventStream {
    yield start;
    throw new Error('upstream disconnected');
  }

  const output = await frames(broken());

  assert.deepEqual(output.map((item) => item.type), ['response.created', 'response.in_progress', 'response.failed']);
  assert.deepEqual(output.map((item) => item.sequence_number), [1, 2, 3]);
  assert.deepEqual(output[2].response, {
    id: 'resp_test', object: 'response', created_at: Reflect.get(output[0].response ?? {}, 'created_at'),
    model: 'actual-model', status: 'failed', output: [],
    error: { code: 'upstream_error', message: 'upstream disconnected' },
    incomplete_details: null,
    usage: { input_tokens: 7, output_tokens: 0, total_tokens: 7,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
  });
});
