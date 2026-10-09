import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toCodexRequest } from '../src/server/gateway/codex.js';
import { parseResponsesRequest } from '../src/server/gateway/responses-input.js';

test('preserves call, output, then user text when Responses input joins adjacent user items', () => {
  const request = parseResponsesRequest({
    model: 'gpt-5-codex',
    input: [
      { type: 'function_call', call_id: 'call_1', name: 'calc', arguments: '{"n":2}' },
      { type: 'function_call_output', call_id: 'call_1', output: '4' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Now explain it' }] },
    ],
  });

  const { input } = toCodexRequest(request, 'gpt-5-codex');

  assert.deepEqual(input, [
    { type: 'function_call', call_id: 'call_1', name: 'calc', arguments: '{"n":2}' },
    { type: 'function_call_output', call_id: 'call_1', output: '4' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Now explain it' }] },
  ]);
});
