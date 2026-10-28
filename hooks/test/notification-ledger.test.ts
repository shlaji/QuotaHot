import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { NotificationCompletionLedgerSchema } from '../src/notification-schema.js';
import { claimNotification, saveNotificationRecord } from '../src/notification-ledger.js';

function record(overrides: Readonly<Record<string, unknown>> = {}) {
  return NotificationCompletionLedgerSchema.parse({
    sessionId: 'session-1',
    assistantMessageId: 'message-1',
    completionKey: 'session-1:message-1',
    messageDigest: 'digest-1',
    ownerPid: process.pid,
    partCount: 1,
    state: 'in_progress',
    sentParts: [],
    updatedAt: '2026-10-22T10:00:00.000Z',
    ...overrides,
  });
}

test('claims a new completion once and suppresses its duplicate', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-notification-ledger-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const candidate = record();

  const first = await claimNotification(dataDir, candidate);
  const duplicate = await claimNotification(dataDir, candidate);

  assert.equal(first.kind, 'claimed');
  assert.equal(duplicate.kind, 'existing');
  if (duplicate.kind === 'existing') assert.equal(duplicate.record.state, 'in_progress');
});

test('serializes concurrent claims for the same completion key', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-notification-ledger-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));

  const claims = await Promise.all([
    claimNotification(dataDir, record()),
    claimNotification(dataDir, record()),
  ]);

  assert.equal(claims.filter((claim) => claim.kind === 'claimed').length, 1);
  assert.equal(claims.filter((claim) => claim.kind === 'existing').length, 1);
});

test('does not reclaim a completion after its record is sent', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-notification-ledger-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const candidate = record();
  await claimNotification(dataDir, candidate);

  const sent = record({ state: 'sent', sentParts: [1] });
  await saveNotificationRecord(dataDir, sent);
  const duplicate = await claimNotification(dataDir, candidate);

  assert.equal(duplicate.kind, 'existing');
  if (duplicate.kind === 'existing') assert.equal(duplicate.record.state, 'sent');
});

test('converts orphaned in-progress records to unknown without resending', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-notification-ledger-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const orphaned = record({ ownerPid: 2_147_483_647 });
  await writeFile(join(dataDir, 'session-notify-ledger.json'), JSON.stringify({ version: 1, records: [orphaned] }));

  const result = await claimNotification(dataDir, record());

  assert.equal(result.kind, 'existing');
  if (result.kind === 'existing') assert.equal(result.record.state, 'unknown');
});
