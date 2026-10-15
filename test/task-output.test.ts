import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskOutput, TASK_OUTPUT_LIMIT } from '../src/server/task-output.js';

test('snapshots preserve an incomplete UTF-8 character until its remaining bytes arrive', () => {
  const output = new TaskOutput();
  const character = Buffer.from('\u732b');
  output.append(character.subarray(0, 2), true);

  const partial = output.snapshot();
  output.append(character.subarray(2), true);

  assert.equal(partial, '');
  assert.equal(output.finish(), '\u732b');
});

test('snapshots leave partial JSON error parsing intact', () => {
  const output = new TaskOutput();
  output.append(Buffer.from('{"type":"error","error":'), true);

  const partial = output.snapshot();
  output.append(Buffer.from('"denied"}'), true);
  output.finish();

  assert.equal(partial, '{"type":"error","error":');
  assert.equal(output.error, '"denied"');
});

test('snapshots bound combined stdout and stderr at the same byte limit', () => {
  const output = new TaskOutput();
  output.append(Buffer.from('x'.repeat(TASK_OUTPUT_LIMIT - 1)), true);
  output.append(Buffer.from('\u732b'), false);

  const snapshot = output.snapshot();

  assert.equal(snapshot, 'x'.repeat(TASK_OUTPUT_LIMIT - 1));
  assert.equal(output.finish(), snapshot);
});

test('snapshots keep the byte limit when malformed UTF-8 expands into replacement characters', () => {
  const output = new TaskOutput();
  output.append(Buffer.alloc(TASK_OUTPUT_LIMIT, 0xff), false);

  const snapshot = output.snapshot();

  assert.ok(Buffer.byteLength(snapshot) <= TASK_OUTPUT_LIMIT);
  assert.equal(snapshot, '\ufffd'.repeat(Math.floor(TASK_OUTPUT_LIMIT / 3)));
});
