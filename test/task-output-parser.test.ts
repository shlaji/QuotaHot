import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskLogPageResponse } from '../src/shared/tasks.js';
import { projectTextEvents, TASK_TEXT_PREVIEW_LIMIT } from '../src/web/task-output-parser.js';
import { projectTaskLogPage } from '../src/web/task-log-page.js';

function page(data: Buffer, options: Partial<TaskLogPageResponse> = {}): TaskLogPageResponse {
  return {
    runId: 'run', encoding: 'base64', archiveState: 'complete',
    chunks: [{ sequence: 0, byteOffset: 0, stream: 'stdout', data: data.toString('base64') }],
    nextCursor: { runId: 'run', sequence: 1, byteOffset: data.length },
    totalBytes: data.length, totalChunks: 1, hasEarlier: false, hasMore: false, ...options,
  };
}

test('projects only stdout text event part.text strings and preserves whitespace', () => {
  const input = [
    { sessionID: 'root', text: 'metadata' }, { type: 'step_start', part: { text: 'step' } },
    { type: 'tool_use', part: { text: 'tool' } }, { type: 'step_finish', text: 'done' },
    { type: 'text', text: 'wrong field', part: { text: '  中文\n\t' } },
    { type: 'text', part: { text: 42 } }, { type: 'text', part: { other: 'hidden' } },
    { part: { text: '继续 ' }, type: 'text' }, { type: 'other', nested: { type: 'text', part: { text: 'hidden' } } },
  ].map((event) => JSON.stringify(event)).join('\r\n');

  const result = projectTextEvents(input, { final: true });

  assert.equal(result.text, '  中文\n\t继续 ');
  assert.equal(result.invalidLines, 0);
});

test('reassembles JSON tokens and UTF-8 split across every possible page boundary', () => {
  const raw = Buffer.from('{"sessionID":"root"}\r\n{"type":"text","part":{"text":"中文😀\\n\\u4e2d\\u6587"}}');
  for (let offset = 1; offset < raw.length; offset += 1) {
    const first = projectTaskLogPage(page(raw.subarray(0, offset), { hasMore: true }));
    const last = projectTaskLogPage(page(raw.subarray(offset), { hasEarlier: true }), first.checkpoint);

    assert.equal(first.messages + last.messages, '中文😀\n中文', `byte ${offset}`);
    assert.equal(first.invalidLines + last.invalidLines, 0, `byte ${offset}`);
  }
});

test('keeps stderr and legacy separate even while stdout JSON spans chunks', () => {
  const chunks = [
    { stream: 'stdout', data: '{"type":"text","part":{"text":"开始' },
    { stream: 'stderr', data: '{"type":"text","part":{"text":"diagnostic only"}}\n' },
    { stream: 'legacy', data: 'unknown source' },
    { stream: 'stdout', data: '结束"}}\n' },
  ] as const;

  const result = projectTaskLogPage(page(Buffer.alloc(0), {
    chunks: chunks.map((chunk, sequence) => ({ ...chunk, sequence, byteOffset: 0, data: Buffer.from(chunk.data).toString('base64') })),
  }));

  assert.equal(result.messages, '开始结束');
  assert.equal(result.diagnostics, chunks[1].data);
  assert.equal(result.legacy, chunks[2].data);
});

test('skips a tail partial line with an explicit notice and resumes at the next complete event', () => {
  const result = projectTaskLogPage(page(Buffer.from('middle of a message"}}\n{"type":"text","part":{"text":"完整消息"}}\n'), { hasEarlier: true }));

  assert.equal(result.messages, '完整消息');
  assert.equal(result.partial, true);
  assert.equal(result.invalidLines, 0);
});

test('counts invalid lines without dumping them into text and resumes at the next line', () => {
  const result = projectTextEvents('not JSON\n{"type":"text","part":{"text":"bad"},}\n{"type":"text","part":{"text":"good"}}\n', { final: true });

  assert.equal(result.text, 'good');
  assert.equal(result.invalidLines, 2);
});

test('does not expose a text event before its JSON line validates', () => {
  const first = projectTextEvents('{"type":"text","part":{"text":"do not show yet"}', {});
  assert.equal(first.text, '');
  assert.equal(first.pending, true);

  const second = projectTextEvents('}}}\n', { checkpoint: first.checkpoint, final: true });

  assert.equal(second.text, '');
  assert.equal(second.invalidLines, 1);
});

test('does not split a JSON-escaped surrogate pair at the preview boundary', () => {
  const prefix = '{"type":"text","part":{"text":"' + 'a'.repeat(TASK_TEXT_PREVIEW_LIMIT - 1);
  const first = projectTextEvents(prefix + '\\ud83d', {});
  assert.equal(first.text, '');

  const second = projectTextEvents('\\ude00"}}\n', { checkpoint: first.checkpoint, final: true });

  assert.equal(second.text, 'a'.repeat(TASK_TEXT_PREVIEW_LIMIT - 1));
  assert.equal(second.textTruncated, true);
  assert.doesNotMatch(second.text, /[\uD800-\uDBFF]$/);
});

test('bounds the visible text preview but recognizes huge events when part precedes type', () => {
  const text = '长消息😀\n'.repeat(30_000);
  const raw = Buffer.from(JSON.stringify({ part: { text }, type: 'text' }));
  let checkpoint;
  const output: string[] = [];
  let largestPendingText = 0;
  let pendingTextWasTruncated = false;
  let outputWasTruncated = false;
  for (let offset = 0; offset < raw.length; offset += 65_536) {
    const result = projectTaskLogPage(page(raw.subarray(offset, offset + 65_536), {
      hasEarlier: offset > 0, hasMore: offset + 65_536 < raw.length,
    }), checkpoint);
    checkpoint = result.checkpoint;
    largestPendingText = Math.max(largestPendingText, checkpoint.events.text.length);
    pendingTextWasTruncated ||= checkpoint.events.textTruncated;
    outputWasTruncated ||= result.textTruncated;
    output.push(result.messages);
  }

  let expected = '';
  let expectedBytes = 0;
  for (const character of text) {
    const bytes = Buffer.byteLength(character);
    if (expectedBytes + bytes > TASK_TEXT_PREVIEW_LIMIT) break;
    expected += character;
    expectedBytes += bytes;
  }
  const preview = output.join('');
  assert.equal(preview, expected);
  assert.equal(Buffer.byteLength(preview), expectedBytes);
  assert.ok(largestPendingText <= TASK_TEXT_PREVIEW_LIMIT);
  assert.equal(pendingTextWasTruncated, true);
  assert.equal(outputWasTruncated, true);
  assert.doesNotMatch(preview, /[\uD800-\uDBFF]$/);
});

test('bounds warning counts for a page of invalid lines', () => {
  const result = projectTextEvents('invalid\n'.repeat(10_000), { final: true });

  assert.equal(result.invalidLines, 999);
  assert.equal(result.text, '');
});
