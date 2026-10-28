import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { saveNotificationConfig } from '../src/notification-config.js';
import { createNotificationCliFixture, runNotificationCli } from './notification-cli-fixture.js';

test('notify send-session skips without invoking DWS when disabled', async (context) => {
  const fixture = await createNotificationCliFixture(context);

  const output = JSON.parse(runNotificationCli(fixture, ['notify', 'send-session', '--json'], JSON.stringify({
    sessionId: 'session-1',
    messages: [
      { info: { id: 'user-1', sessionID: 'session-1', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'question' }] },
      { info: { id: 'message-1', sessionID: 'session-1', role: 'assistant', time: { created: 2, completed: 3 } }, parts: [{ type: 'text', text: 'final response' }] },
    ],
  })));

  assert.equal(output.state, 'skipped');
  assert.equal(existsSync(fixture.dwsArgsPath), false);
});

test('notify send-session records a verified delivery without storing the message body', async (context) => {
  const fixture = await createNotificationCliFixture(context);
  await saveNotificationConfig(fixture.dataDir, {
    version: 1,
    enabled: true,
    target: { openConversationId: 'conversation-1', displayName: 'Test group' },
    authorizedAt: '2026-10-22T10:00:00.000Z',
  });
  const content = 'final response text';

  const output = JSON.parse(runNotificationCli(fixture, ['notify', 'send-session', '--json'], JSON.stringify({
    sessionId: 'session-1',
    messages: [
      { info: { id: 'user-1', sessionID: 'session-1', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'question' }] },
      { info: { id: 'message-1', sessionID: 'session-1', role: 'assistant', time: { created: 2, completed: 3 } }, parts: [{ type: 'text', text: content }] },
    ],
  })));
  const invocations = (await readFile(fixture.dwsArgsPath, 'utf8')).trim().split('\n');
  const ledger = await readFile(join(fixture.dataDir, 'session-notify-ledger.json'), 'utf8');

  assert.equal(output.state, 'sent');
  assert.deepEqual(invocations.map((invocation) => invocation.split(' ')[1]), [
    '+conversation-info', '+send-to-group', '+messages-query-send-status',
  ]);
  assert.equal(ledger.includes(content), false);
});

test('notify send-session does not resubmit an already processed completion', async (context) => {
  const fixture = await createNotificationCliFixture(context);
  await saveNotificationConfig(fixture.dataDir, {
    version: 1,
    enabled: true,
    target: { openConversationId: 'conversation-1', displayName: 'Test group' },
    authorizedAt: '2026-10-22T10:00:00.000Z',
  });
  const input = JSON.stringify({
    sessionId: 'session-1',
    messages: [
      { info: { id: 'user-1', sessionID: 'session-1', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'question' }] },
      { info: { id: 'message-1', sessionID: 'session-1', role: 'assistant', time: { created: 2, completed: 3 } }, parts: [{ type: 'text', text: 'answer' }] },
    ],
  });

  const first = JSON.parse(runNotificationCli(fixture, ['notify', 'send-session', '--json'], input));
  const callsAfterFirst = (await readFile(fixture.dwsArgsPath, 'utf8')).trim().split('\n').length;
  const second = JSON.parse(runNotificationCli(fixture, ['notify', 'send-session', '--json'], input));
  const invocations = (await readFile(fixture.dwsArgsPath, 'utf8')).trim().split('\n');

  assert.equal(first.state, 'sent');
  assert.equal(second.state, 'sent');
  assert.equal(invocations.slice(0, callsAfterFirst).filter((line) => line.includes('+send-to-group')).length, 1);
  assert.equal(invocations.slice(callsAfterFirst).some((line) => line.includes('+send-to-group')), false);
});
