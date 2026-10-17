import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskOutput, TASK_OUTPUT_LIMIT, TASK_OUTPUT_OMISSION } from '../src/server/task-output.js';
import { TaskOutputLines } from '../src/server/task-output-lines.js';

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

  assert.ok(snapshot.startsWith('x'.repeat(16384)));
  assert.ok(snapshot.includes(TASK_OUTPUT_OMISSION));
  assert.ok(snapshot.endsWith('\u732b'));
  assert.ok(Buffer.byteLength(snapshot) <= TASK_OUTPUT_LIMIT);
  assert.equal(output.finish(), snapshot);
});

test('retains the beginning and latest UTF-8 sentinel after repeated overflow', () => {
  const output = new TaskOutput();
  output.append(Buffer.from('BEGIN\n'), true);
  for (let index = 0; index < 100; index++) output.append(Buffer.from('猫🙂'.repeat(1000)), index % 2 === 0);
  const sentinel = Buffer.from('\nFINAL 猫🙂');
  for (const byte of sentinel) output.append(Buffer.from([byte]), true);

  const result = output.finish();

  assert.ok(result.startsWith('BEGIN\n'));
  assert.ok(result.endsWith('\nFINAL 猫🙂'));
  assert.equal(result.split(TASK_OUTPUT_OMISSION).length, 2);
  assert.ok(Buffer.byteLength(result) <= TASK_OUTPUT_LIMIT);
  assert.ok(!result.includes('\ufffd'));
});

test('preserves output exactly at the cap', () => {
  const output = new TaskOutput();
  const text = 'x'.repeat(TASK_OUTPUT_LIMIT);

  output.append(Buffer.from(text), false);

  assert.equal(output.finish(), text);
});

test('keeps the exact rolling suffix across wraparound and oversized chunks', () => {
  const output = new TaskOutput();
  const chunks = [
    'start\n', 'a'.repeat(TASK_OUTPUT_LIMIT - 8), 'boundary',
    '0123456789'.repeat(3000), 'oversized'.repeat(TASK_OUTPUT_LIMIT), 'FINAL',
  ];
  let complete = '';
  const tailBytes = TASK_OUTPUT_LIMIT - 16384 - Buffer.byteLength(TASK_OUTPUT_OMISSION);

  for (const chunk of chunks) {
    complete += chunk;
    output.append(Buffer.from(chunk), false);

    const expected = complete.length <= TASK_OUTPUT_LIMIT ? complete
      : complete.slice(0, 16384) + TASK_OUTPUT_OMISSION + complete.slice(-tailBytes);
    assert.equal(output.snapshot(), expected);
  }
});

test('preserves short interleaved stdout and stderr unchanged', () => {
  const output = new TaskOutput();

  output.append(Buffer.from('stdout 猫\n'), true);
  output.append(Buffer.from('stderr 🙂\n'), false);

  assert.equal(output.finish(), 'stdout 猫\nstderr 🙂\n');
});

test('discards oversized partial lines through the delimiter and recovers', () => {
  const parser = new TaskOutputLines();
  const lines: string[] = [];
  const consume = (line: string) => lines.push(line);

  for (let index = 0; index < 100; index++) parser.append(Buffer.alloc(4096, 120), consume);
  parser.append(Buffer.from('{"sessionID":"wrong"}\n{"sessionID":"猫"}\n'), consume);

  assert.deepEqual(lines, ['{"sessionID":"猫"}']);
  assert.equal(parser['buffer'].length, TASK_OUTPUT_LIMIT);
  assert.equal(parser['length'], 0);
});

test('accepts bounded lines and split UTF-8 bytes', () => {
  const parser = new TaskOutputLines();
  const lines: string[] = [];
  const consume = (line: string) => lines.push(line);
  const character = Buffer.from('猫');

  parser.append(Buffer.alloc(TASK_OUTPUT_LIMIT, 120), consume);
  parser.append(Buffer.from('\n'), consume);
  for (const byte of character) parser.append(Buffer.from([byte]), consume);
  parser.append(Buffer.from('\n'), consume);

  assert.deepEqual(lines, ['x'.repeat(TASK_OUTPUT_LIMIT), '猫']);
});

test('snapshots keep the byte limit when malformed UTF-8 expands into replacement characters', () => {
  const output = new TaskOutput();
  output.append(Buffer.alloc(TASK_OUTPUT_LIMIT, 0xff), false);

  const snapshot = output.snapshot();

  assert.ok(Buffer.byteLength(snapshot) <= TASK_OUTPUT_LIMIT);
  assert.equal(snapshot, '\ufffd'.repeat(Math.floor(TASK_OUTPUT_LIMIT / 3)));
});

test('final previews retain the latest tail when malformed UTF-8 expands', () => {
  const output = new TaskOutput();
  output.append(Buffer.concat([
    Buffer.from('BEGIN\n'),
    Buffer.alloc(TASK_OUTPUT_LIMIT, 0xff),
    Buffer.from('\nfinal output'),
  ]), false);

  const snapshot = output.finish();

  assert.ok(snapshot.startsWith('BEGIN\n'));
  assert.ok(snapshot.includes(TASK_OUTPUT_OMISSION));
  assert.ok(snapshot.endsWith('\nfinal output'));
  assert.ok(Buffer.byteLength(snapshot) <= TASK_OUTPUT_LIMIT);
});
