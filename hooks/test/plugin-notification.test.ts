import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { opencodeNotificationPlugin } from '../src/opencode-plugin.js';
import { selfInvocation } from '../src/install.js';
import { saveNotificationConfig } from '../src/notification-config.js';
import { createNotificationCliFixture } from './notification-cli-fixture.js';
import { selectFinalAssistantMessage } from '../src/notification-message.js';
import { createSessionNotificationPlugin } from '../src/opencode-notification-plugin-template.js';
import type { NotificationSendInput } from '../src/notification-schema.js';

function userMessage(id: string, sessionID = 'session-1') {
  return {
    info: { id, sessionID, role: 'user', time: { created: 1 } },
    parts: [{ type: 'text', text: 'question' }],
  };
}

type AssistantMessageInput = {
  readonly id: string;
  readonly parts: readonly object[];
  readonly time: { readonly created: number; readonly completed?: number };
  readonly error?: unknown;
  readonly sessionID?: string;
};

function assistantMessage(input: AssistantMessageInput) {
  return {
    info: {
      id: input.id,
      sessionID: input.sessionID ?? 'session-1',
      role: 'assistant',
      time: input.time,
      ...(input.error === undefined ? {} : { error: input.error }),
    },
    parts: input.parts,
  };
}

test('selects only completed user-visible text after the latest user message', () => {
  const result = selectFinalAssistantMessage('session-1', [
    assistantMessage({ id: 'old-answer', parts: [{ type: 'text', text: 'stale' }], time: { created: 1, completed: 2 } }),
    userMessage('user-2'),
    assistantMessage({ id: 'tool-progress', parts: [{ type: 'tool', callID: 'tool-1' }], time: { created: 3, completed: 4 } }),
    assistantMessage({ id: 'final-answer', parts: [
      { type: 'text', text: 'final ' },
      { type: 'reasoning', text: 'private reasoning' },
      { type: 'text', text: 'answer' },
      { type: 'text', text: 'synthetic', synthetic: true },
      { type: 'text', text: 'ignored', ignored: true },
    ], time: { created: 5, completed: 6 } }),
  ]);

  assert.deepEqual(result, {
    kind: 'message',
    payload: { sessionId: 'session-1', assistantMessageId: 'final-answer', content: 'final answer' },
  });
});

test('does not select a previous assistant answer after a newer user message', () => {
  const result = selectFinalAssistantMessage('session-1', [
    assistantMessage({ id: 'answer', parts: [{ type: 'text', text: 'done' }], time: { created: 2, completed: 3 } }),
    userMessage('new-question'),
  ]);

  assert.equal(result.kind, 'skipped');
});

test('does not select an incomplete final assistant message', () => {
  const result = selectFinalAssistantMessage('session-1', [
    userMessage('question'),
    assistantMessage({ id: 'incomplete', parts: [{ type: 'text', text: 'partial' }], time: { created: 2 } }),
  ]);

  assert.equal(result.kind, 'skipped');
});

test('does not select an errored final assistant message', () => {
  const result = selectFinalAssistantMessage('session-1', [
    userMessage('question'),
    assistantMessage({ id: 'errored', parts: [{ type: 'text', text: 'partial' }], time: { created: 2, completed: 3 }, error: { name: 'MessageAbortedError' } }),
  ]);

  assert.equal(result.kind, 'skipped');
});

test('does not select an assistant message without user-visible text', () => {
  const result = selectFinalAssistantMessage('session-1', [
    userMessage('question'),
    assistantMessage({
      id: 'empty-answer',
      parts: [{ type: 'text', text: 'hidden', synthetic: true }, { type: 'reasoning', text: 'reasoning' }],
      time: { created: 2, completed: 3 },
    }),
  ]);

  assert.deepEqual(result, { kind: 'skipped', reason: 'empty_response' });
});

test('does not select messages belonging to another session', () => {
  const result = selectFinalAssistantMessage('session-1', [
    userMessage('question', 'other-session'),
    assistantMessage({ id: 'answer', parts: [{ type: 'text', text: 'wrong' }], time: { created: 2, completed: 3 }, sessionID: 'other-session' }),
  ]);

  assert.equal(result.kind, 'skipped');
});

test('rejects malformed session-message responses', () => {
  const result = selectFinalAssistantMessage('session-1', { error: 'unavailable' });

  assert.equal(result.kind, 'skipped');
});

function sessionMessages(sessionID: string, messageID: string, content: string) {
  return [
    userMessage(`user-${sessionID}`, sessionID),
    assistantMessage({
      id: messageID,
      sessionID,
      parts: [{ type: 'text', text: content }],
      time: { created: 2, completed: 3 },
    }),
  ];
}

test('session idle dispatches only the selected final message and reports success', async () => {
  const deliveries: NotificationSendInput[] = [];
  const notifications: { readonly message: string; readonly variant: string }[] = [];
  const plugin = createSessionNotificationPlugin({
    client: {
      session: { messages: async ({ path }) => sessionMessages(path.id, 'message-1', 'final answer') },
      tui: { showToast: async ({ body }) => { notifications.push(body); } },
    },
    send: async (payload) => { deliveries.push(payload); return { state: 'sent', sentParts: [1] }; },
  });

  await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'session-1' } } });

  assert.deepEqual(deliveries, [{ sessionId: 'session-1', messages: sessionMessages('session-1', 'message-1', 'final answer') }]);
  assert.equal(notifications[0]?.variant, 'success');
  await plugin.dispose();
});

test('non-idle events never dispatch a group notification', async () => {
  let messageReads = 0;
  const deliveries: NotificationSendInput[] = [];
  const plugin = createSessionNotificationPlugin({
    client: { session: { messages: async () => { messageReads += 1; return []; } } },
    send: async (payload) => { deliveries.push(payload); return { state: 'sent', sentParts: [1] }; },
  });

  await plugin.event({ event: { type: 'session.error', properties: { sessionID: 'session-1' } } });

  assert.equal(messageReads, 0);
  assert.deepEqual(deliveries, []);
  await plugin.dispose();
});

test('deleted sessions cannot dispatch a later idle notification', async () => {
  let messageReads = 0;
  const deliveries: NotificationSendInput[] = [];
  const plugin = createSessionNotificationPlugin({
    client: { session: { messages: async () => { messageReads += 1; return sessionMessages('session-1', 'message-1', 'answer'); } } },
    send: async (payload) => { deliveries.push(payload); return { state: 'sent', sentParts: [1] }; },
  });

  await plugin.event({ event: { type: 'session.deleted', properties: { sessionID: 'session-1' } } });
  await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'session-1' } } });

  assert.equal(messageReads, 0);
  assert.deepEqual(deliveries, []);
  await plugin.dispose();
});

test('concurrent idle events keep session messages isolated', async () => {
  const deliveries: NotificationSendInput[] = [];
  const plugin = createSessionNotificationPlugin({
    client: {
      session: {
        messages: async ({ path }) => sessionMessages(path.id, `message-${path.id}`, `answer-${path.id}`),
      },
    },
    send: async (payload) => { deliveries.push(payload); return { state: 'sent', sentParts: [1] }; },
  });

  await Promise.all([
    plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'one' } } }),
    plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'two' } } }),
  ]);

  assert.deepEqual(deliveries.sort((left, right) => left.sessionId.localeCompare(right.sessionId)), [
    { sessionId: 'one', messages: sessionMessages('one', 'message-one', 'answer-one') },
    { sessionId: 'two', messages: sessionMessages('two', 'message-two', 'answer-two') },
  ]);
  await plugin.dispose();
});

test('generated notification plugin forwards the session response to the hook CLI over stdin', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'quotahot-notification-plugin-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const hookPath = join(directory, 'fake-hook');
  const payloadPath = join(directory, 'payload.json');
  const argsPath = join(directory, 'args.txt');
  await writeFile(hookPath, `#!/bin/sh
printf '%s' "$*" > ${JSON.stringify(argsPath)}
cat > ${JSON.stringify(payloadPath)}
printf '%s' '{"state":"sent","sentParts":[1]}'
`);
  await chmod(hookPath, 0o700);
  const pluginPath = join(directory, 'plugin.mjs');
  await writeFile(pluginPath, opencodeNotificationPlugin(hookPath));
  const installedPlugin = await import(pathToFileURL(pluginPath).href);
  const plugin = installedPlugin.createSessionNotificationPlugin({
    client: { session: { messages: async () => sessionMessages('session-1', 'message-1', 'answer') } },
  });

  await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'session-1' } } });

  assert.equal(await readFile(argsPath, 'utf8'), 'notify send-session --json');
  assert.deepEqual(JSON.parse(await readFile(payloadPath, 'utf8')), {
    sessionId: 'session-1',
    messages: sessionMessages('session-1', 'message-1', 'answer'),
  });
  await plugin.dispose();
});

test('generated plugin sends a session through the hook CLI and fake DWS receipt', async (context) => {
  const fixture = await createNotificationCliFixture(context);
  await saveNotificationConfig(fixture.dataDir, {
    version: 1,
    enabled: true,
    target: { openConversationId: 'conversation-1', displayName: 'Test group' },
    authorizedAt: '2026-10-22T10:00:00.000Z',
  });
  const wrapper = join(fixture.home, 'hook-wrapper');
  const shellArg = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const originalArgv = process.argv[1];
  process.argv[1] = resolve('src/index.ts');
  const invocation = selfInvocation();
  if (originalArgv === undefined) delete process.argv[1];
  else process.argv[1] = originalArgv;
  await writeFile(wrapper, `#!/bin/sh
export QUOTAHOT_DATA_DIR=${shellArg(fixture.dataDir)}
export PATH=${shellArg(fixture.binDir)}:"$PATH"
exec ${invocation.map(shellArg).join(' ')} "$@"
`);
  await chmod(wrapper, 0o700);
  const pluginPath = join(fixture.home, 'installed-plugin.mjs');
  await writeFile(pluginPath, opencodeNotificationPlugin(wrapper));
  const installedPlugin = await import(pathToFileURL(pluginPath).href);
  const notifications: { readonly message: string; readonly variant: string }[] = [];
  const plugin = installedPlugin.createSessionNotificationPlugin({
    client: {
      session: { messages: async () => ({ data: sessionMessages('session-1', 'message-1', 'final answer') }) },
      tui: { showToast: async ({ body }: { body: { message: string; variant: string } }) => { notifications.push(body); } },
    },
  });

  await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'session-1' } } });

  const calls = (await readFile(fixture.dwsArgsPath, 'utf8')).trim().split('\n');
  assert.deepEqual(calls.map((call) => call.split(' ')[1]), [
    '+conversation-info', '+send-to-group', '+messages-query-send-status',
  ]);
  assert.equal(notifications[0]?.variant, 'success');
  assert.match(notifications[0]?.message ?? '', /sent/);
  await plugin.dispose();
});
