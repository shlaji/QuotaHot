import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseResponsesRequest, ResponsesInputError } from '../src/server/gateway/responses-input.js';

test('converts a string input without changing the requested model', () => {
  const request = parseResponsesRequest({ model: 'qoder/efficient', input: 'hello', stream: true });
  assert.equal(request.model, 'qoder/efficient');
  assert.equal(request.stream, true);
  assert.equal(request.max_tokens, 8192);
  assert.deepEqual(request.messages, [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
});

test('preserves ordered input items, call IDs and outputs in the internal representation', () => {
  const request = parseResponsesRequest({
    model: 'gpt-5-codex',
    instructions: 'Be concise',
    max_output_tokens: 200,
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'checking' }] },
      { type: 'function_call', name: 'calc', arguments: '{"n":2}', call_id: 'call_1' },
      { type: 'function_call_output', call_id: 'call_1', output: '4' },
      { role: 'user', content: 'thanks' },
    ],
  });
  assert.equal(request.system, 'Be concise');
  assert.equal(request.max_tokens, 200);
  assert.deepEqual(request.messages, [
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
    { role: 'assistant', content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'call_1', name: 'calc', input: { n: 2 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '4' }, { type: 'text', text: 'thanks' }] },
  ]);
});

test('translates tool definitions, selection and reasoning effort', () => {
  const request = parseResponsesRequest({
    model: 'claude-sonnet-5', input: [],
    tools: [{ type: 'function', name: 'calc', description: 'calculate', parameters: { type: 'object', properties: {} } }],
    tool_choice: { type: 'function', name: 'calc' },
    reasoning: { effort: 'high' },
  });
  assert.deepEqual(request.tools, [{ name: 'calc', description: 'calculate', input_schema: { type: 'object', properties: {} } }]);
  assert.deepEqual(request.tool_choice, { type: 'tool', name: 'calc' });
  assert.deepEqual(request.thinking, { type: 'enabled', budget_tokens: 16000 });
  assert.deepEqual(parseResponsesRequest({ model: 'm', input: [], tool_choice: 'required' }).tool_choice, { type: 'any' });
});

test('rejects explicit reasoning effort none with a typed field error', () => {
  assert.throws(() => parseResponsesRequest({ model: 'm', input: 'hello', reasoning: { effort: 'none' } }),
    (error: unknown) => error instanceof ResponsesInputError && error.path === 'reasoning.effort');
});

test('merges adjacent roles and retains instructions alongside system messages', () => {
  const request = parseResponsesRequest({ model: 'm', instructions: 'policy', input: [
    { role: 'system', content: 'rules' },
    { role: 'developer', content: [{ type: 'input_text', text: 'format' }] },
    { role: 'user', content: 'one' }, { role: 'user', content: 'two' },
  ] });
  assert.equal(request.system, 'policy\n\nrules\n\nformat');
  assert.deepEqual(request.messages, [{ role: 'user', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }]);
});

test('rejects unsupported stateful options with a typed error and field path', () => {
  for (const [field, value] of [
    ['previous_response_id', 'resp_1'], ['conversation', 'conv_1'], ['background', true], ['store', true],
    ['metadata', { tag: 'important' }],
  ] as const) {
    assert.throws(() => parseResponsesRequest({ model: 'm', input: 'hi', [field]: value }),
      (error: unknown) => error instanceof ResponsesInputError && error.path === field);
  }
});

test('rejects unsupported or malformed input instead of silently dropping content', () => {
  for (const [input, path] of [
    [[{ type: 'file', file_id: 'file_1' }], 'input[0].type'],
    [[{ role: 'user', content: [{ type: 'input_audio', data: 'abc' }] }], 'input[0].content[0].type'],
    [[{ type: 'function_call', name: 'calc', call_id: 'c', arguments: '{broken' }], 'input[0].arguments'],
    [[{ type: 'function_call_output', call_id: 'c', output: [{ type: 'input_image', image_url: 'https://example.com/a.png' }] }], 'input[0].output'],
    [[{ role: 'visitor', content: 'text' }], 'input[0].role'],
  ] as const) {
    assert.throws(() => parseResponsesRequest({ model: 'm', input }),
      (error: unknown) => error instanceof ResponsesInputError && error.path === path);
  }
});

test('rejects invalid required and optional fields rather than coercing them', () => {
  for (const [body, path] of [
    [{ model: 7, input: 'hello' }, 'model'],
    [{ model: 'm', input: null }, 'input'],
    [{ model: 'm', input: 'hello', stream: 'false' }, 'stream'],
    [{ model: 'm', input: 'hello', max_output_tokens: -1 }, 'max_output_tokens'],
    [{ model: 'm', input: 'hello', reasoning: { effort: 'xhigh' } }, 'reasoning.effort'],
    [{ model: 'm', input: 'hello', tools: [{ type: 'web_search' }] }, 'tools[0].type'],
  ] as const) {
    assert.throws(() => parseResponsesRequest(body),
      (error: unknown) => error instanceof ResponsesInputError && error.path === path);
  }
});
