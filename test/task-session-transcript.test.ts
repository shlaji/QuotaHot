import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskSessionMessage, TaskSessionPart, TaskSessionTranscript } from '../src/shared/tasks.js';
import { DEFAULT_TASK_TRANSCRIPT_OPTIONS, formatTaskSessionTranscript, type TaskTranscriptOptions } from '../src/shared/task-session-transcript.js';
import { parseSessionExport } from '../src/server/opencode-export-payload.js';

const session: TaskSessionTranscript = {
  sessionId: 'ses_root', title: 'Native transcript', scope: 'root-only',
  time: { created: 1700000000000, updated: 1700000010000 }, messages: [],
};
const assistant: TaskSessionMessage = {
  id: 'assistant', role: 'assistant', time: { created: 1000, completed: 2567 },
  agent: 'code-review_agent', providerID: 'openai', modelID: 'test-model', parts: [],
};

function body(parts: readonly TaskSessionPart[], options: TaskTranscriptOptions = DEFAULT_TASK_TRANSCRIPT_OPTIONS): string {
  return formatTaskSessionTranscript({ ...session, messages: [{ ...assistant, parts }] }, options).split('---\n\n').slice(1).join('---\n\n');
}

test('includes the session header and locale timestamps when there are no messages', (context) => {
  context.mock.method(Date.prototype, 'toLocaleString', function (this: Date) { return this.toISOString(); });

  const result = formatTaskSessionTranscript(session);

  assert.equal(result, '# Native transcript\n\n**Session ID:** ses_root\n**Created:** 2023-11-14T22:13:20.000Z\n**Updated:** 2023-11-14T22:13:30.000Z\n\n---\n\n');
});

test('sorts messages by creation time then locale ID without mutating the source', () => {
  const messages: readonly TaskSessionMessage[] = Object.freeze([
    { ...assistant, id: '0-late', time: { created: 2000 }, parts: [] },
    { id: 'b', role: 'user', time: { created: 1000 }, parts: [{ id: 'part-b', type: 'text', text: 'second' }] },
    { id: 'A', role: 'user', time: { created: 1000 }, parts: [{ id: 'part-a', type: 'text', text: 'first' }] },
  ]);

  const result = formatTaskSessionTranscript({ ...session, messages }, { ...DEFAULT_TASK_TRANSCRIPT_OPTIONS, assistantMetadata: false });

  assert.equal(result.slice(result.indexOf('## User')), '## User\n\nfirst\n\n---\n\n## User\n\nsecond\n\n---\n\n## Assistant\n\n---\n\n');
  assert.deepEqual(messages.map((message) => message.id), ['0-late', 'b', 'A']);
});

test('preserves part order and whitespace but omits synthetic text and unsupported types', () => {
  const parts: readonly TaskSessionPart[] = [
    { id: 'z', type: 'text', text: '  first\n' },
    { id: 'internal', type: 'text', text: 'internal', synthetic: true },
    { id: 'step', type: 'unsupported', originalType: 'step-finish' },
    { id: 'a', type: 'text', text: 'last', synthetic: false },
  ];

  const result = body(parts);

  assert.equal(result, '## Assistant (Code-Review_agent · test-model · 1.6s)\n\n  first\n\n\nlast\n\n---\n\n');
});

for (const thinking of [true, false]) {
  test(`includes reasoning only when thinking is ${thinking}`, () => {
    const parts: readonly TaskSessionPart[] = [{ id: 'reason', type: 'reasoning', text: 'Plan\nnext' }];

    const result = body(parts, { ...DEFAULT_TASK_TRANSCRIPT_OPTIONS, thinking });

    assert.equal(result, '## Assistant (Code-Review_agent · test-model · 1.6s)\n\n' + (thinking ? '_Thinking:_\n\nPlan\nnext\n\n' : '') + '---\n\n');
  });
}

test('omits assistant metadata when it is disabled', () => {
  const result = body([], { ...DEFAULT_TASK_TRANSCRIPT_OPTIONS, assistantMetadata: false });

  assert.equal(result, '## Assistant\n\n---\n\n');
});

for (const time of [{ created: 1000 }, { created: 0, completed: 1000 }, { created: 1000, completed: 0 }]) {
  test(`omits duration when a native timestamp is absent or zero: ${JSON.stringify(time)}`, () => {
    const transcript = { ...session, messages: [{ ...assistant, time }] };

    const result = formatTaskSessionTranscript(transcript);

    assert.ok(result.endsWith('## Assistant (Code-Review_agent · test-model)\n\n---\n\n'));
  });
}

for (const status of ['pending', 'running', 'completed', 'error'] as const) {
  for (const toolDetails of [true, false]) {
    test(`formats ${status} tools when toolDetails is ${toolDetails}`, () => {
      const part: TaskSessionPart = { id: 'tool', type: 'tool', tool: 'bash', status, input: '{"command":"ls"}', output: 'stdout\n', error: 'failed' };

      const result = body([part], { ...DEFAULT_TASK_TRANSCRIPT_OPTIONS, toolDetails, assistantMetadata: false });

      const input = toolDetails ? '\n**Input:**\n```json\n{\n  "command": "ls"\n}\n```\n' : '';
      const output = toolDetails && status === 'completed' ? '\n**Output:**\n```\nstdout\n\n```\n' : '';
      const error = toolDetails && status === 'error' ? '\n**Error:**\n```\nfailed\n```\n' : '';
      assert.equal(result, `## Assistant\n\n**Tool: bash**\n${input}${output}${error}\n---\n\n`);
    });
  }
}

for (const status of ['completed', 'error'] as const) {
  test(`omits empty ${status} tool results while retaining empty-object input`, () => {
    const part: TaskSessionPart = { id: 'tool', type: 'tool', tool: 'read', status, input: '{}', output: '', error: '' };

    const result = body([part], { ...DEFAULT_TASK_TRANSCRIPT_OPTIONS, assistantMetadata: false });

    assert.equal(result, '## Assistant\n\n**Tool: read**\n\n**Input:**\n```json\n{}\n```\n\n---\n\n');
  });
}

for (const parts of [[], [{ id: 'file', type: 'unsupported', originalType: 'file' }]] satisfies (readonly TaskSessionPart[])[]) {
  test(`keeps the message header and separator when parts are empty or unsupported (${parts.length})`, () => {
    const result = body(parts, { ...DEFAULT_TASK_TRANSCRIPT_OPTIONS, assistantMetadata: false });

    assert.equal(result, '## Assistant\n\n---\n\n');
  });
}

test('formats nested native tool input with two-space indentation after parsing', () => {
  const payload = {
    info: { id: session.sessionId, title: session.title, time: session.time }, messages: [
      { info: { id: 'user', role: 'user', sessionID: session.sessionId, time: { created: 1000 } }, parts: [
        { id: 'tool', messageID: 'user', sessionID: session.sessionId, type: 'tool', tool: 'test',
          state: { status: 'running', input: { nested: { values: [1, true] } } } },
      ] },
    ],
  };

  const result = formatTaskSessionTranscript(parseSessionExport(JSON.stringify(payload), session.sessionId));

  assert.ok(result.endsWith('## User\n\n**Tool: test**\n\n**Input:**\n```json\n{\n  "nested": {\n    "values": [\n      1,\n      true\n    ]\n  }\n}\n```\n\n---\n\n'));
});
