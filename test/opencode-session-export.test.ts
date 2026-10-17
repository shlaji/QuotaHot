import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { copyFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSession } from '../src/server/opencode-session-export.js';
import { parseSessionExport, SessionExportError } from '../src/server/opencode-export-payload.js';
import type { TaskSessionTranscript } from '../src/shared/tasks.js';

export const nativeExport = {
  info: { id: 'ses_root', title: 'Native session', directory: '/ignored', version: '1.19.3' },
  messages: [
    { info: { id: 'msg_user', sessionID: 'ses_root', role: 'user' }, parts: [
      { id: 'prt_user', sessionID: 'ses_root', messageID: 'msg_user', type: 'text', text: 'hello\n' },
    ] },
    { info: { id: 'msg_assistant', sessionID: 'ses_root', role: 'assistant' }, parts: [
      { id: 'prt_reason', sessionID: 'ses_root', messageID: 'msg_assistant', type: 'reasoning', text: 'Thinking' },
      { id: 'prt_tool', sessionID: 'ses_root', messageID: 'msg_assistant', type: 'tool', tool: 'task',
        state: { status: 'completed', input: { prompt: 'child work' }, output: 'child reference only', metadata: { sessionId: 'ses_child' } } },
      { id: 'prt_text', sessionID: 'ses_root', messageID: 'msg_assistant', type: 'text', text: 'answer\n' },
      { id: 'prt_step', sessionID: 'ses_root', messageID: 'msg_assistant', type: 'step-finish', tokens: { total: 12 } },
    ] },
  ],
};

const projected: TaskSessionTranscript = {
  sessionId: 'ses_root', title: 'Native session', scope: 'root-only', messages: [
    { id: 'msg_user', role: 'user', parts: [{ id: 'prt_user', type: 'text', text: 'hello\n' }] },
    { id: 'msg_assistant', role: 'assistant', parts: [
      { id: 'prt_reason', type: 'reasoning', text: 'Thinking' },
      { id: 'prt_tool', type: 'tool', tool: 'task', status: 'completed', input: '{"prompt":"child work"}', output: 'child reference only', error: '' },
      { id: 'prt_text', type: 'text', text: 'answer\n' },
      { id: 'prt_step', type: 'unsupported', originalType: 'step-finish' },
    ] },
  ],
};

function fixture(context: TestContext, mode = 'valid') {
  const directory = mkdtempSync(join(tmpdir(), 'session-export-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const executable = join(directory, 'fake opencode');
  copyFileSync(new URL('./fixtures/opencode-export.cjs', import.meta.url), executable);
  chmodSync(executable, 0o755);
  return {
    source: { sessionId: 'ses_root', directory },
    options: { executable, env: { EXPORT_MODE: mode, EXPORT_DIRECTORY: directory, EXPORT_PAYLOAD: JSON.stringify(nativeExport) } },
  };
}

test('projects native messages when stderr contains CLI progress', async (context) => {
  const { source, options } = fixture(context);

  const result = await exportSession(source, options);

  assert.deepEqual(result, projected);
});

for (const scenario of [
  { mode: 'invalid', code: 'invalid_output' },
  { mode: 'utf8', code: 'invalid_output' },
  { mode: 'missing', code: 'session_unavailable' },
  { mode: 'failed', code: 'export_failed' },
  { mode: 'timeout', code: 'timeout' },
  { mode: 'stdout-limit', code: 'limit_exceeded' },
  { mode: 'stderr-limit', code: 'limit_exceeded' },
]) {
  test(`rejects export when CLI reports ${scenario.mode}`, { timeout: 5000 }, async (context) => {
    const { source, options } = fixture(context, scenario.mode);

    const result = exportSession(source, { ...options, timeoutMs: 500, maxStdoutBytes: 2048, maxStderrBytes: 2048 });

    await assert.rejects(result, (error: unknown) => error instanceof SessionExportError && error.code === scenario.code);
  });
}

test('reports unavailable CLI when the executable does not exist', async (context) => {
  const { source } = fixture(context);

  const result = exportSession(source, { executable: join(source.directory, 'missing') });

  await assert.rejects(result, { code: 'cli_unavailable' });
});

for (const payload of [
  {}, { info: nativeExport.info, messages: {} },
  { ...nativeExport, info: { ...nativeExport.info, id: 'ses_other' } },
  { ...nativeExport, info: { ...nativeExport.info, parentID: 'ses_parent' } },
  { ...nativeExport, messages: [{ info: { id: 'msg', sessionID: 'ses_child', role: 'user' }, parts: [] }] },
  { ...nativeExport, messages: [{ info: { id: 'msg', sessionID: 'ses_root', role: 'system' }, parts: [] }] },
  { ...nativeExport, messages: [{ info: { id: 'msg', sessionID: 'ses_root', role: 'user' }, parts: [{ id: 'prt', sessionID: 'ses_root', messageID: 'wrong', type: 'text', text: 'x' }] }] },
  { ...nativeExport, messages: [{ info: { id: 'msg', sessionID: 'ses_root', role: 'user' }, parts: [{ id: 'prt', sessionID: 'ses_root', messageID: 'msg', type: 'text', text: 3 }] }] },
]) {
  test('rejects malformed or cross-session native structure', () => {
    const serialized = JSON.stringify(payload);

    const action = () => parseSessionExport(serialized, 'ses_root');

    assert.throws(action, { code: 'invalid_output' });
  });
}

test('rejects message count overflow rather than truncating the transcript', () => {
  const serialized = JSON.stringify({ ...nativeExport, messages: Array.from({ length: 2001 }, () => nativeExport.messages[0]) });

  const action = () => parseSessionExport(serialized, 'ses_root');

  assert.throws(action, { code: 'limit_exceeded' });
});

test('reports a typed limit when native tool input is too deeply nested to project', () => {
  const input = '{"nested":'.repeat(20000) + '{}' + '}'.repeat(20000);
  const serialized = `{"info":{"id":"ses_root","title":"Deep"},"messages":[{"info":{"id":"msg","sessionID":"ses_root","role":"assistant"},"parts":[{"id":"prt","sessionID":"ses_root","messageID":"msg","type":"tool","tool":"test","state":{"status":"running","input":${input}}}]}]}`;

  const action = () => parseSessionExport(serialized, 'ses_root');

  assert.throws(action, { code: 'limit_exceeded' });
});
