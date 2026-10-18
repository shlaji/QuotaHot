import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readRecoveryStatus } from '../src/recovery-status.js';

function fixture(context: { after: (callback: () => void) => void }): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'quotahot-recovery-reader-'));
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));
  mkdirSync(join(dataDir, 'recovery-status'));
  return dataDir;
}

function snapshot(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    id,
    pid: 12345,
    updatedAt: Date.now(),
    phase: 'waiting',
    waitingCount: 2,
    sessions: [{ sessionID: 'session-1', phase: 'waiting' }],
    nextCheckAt: null,
    lastCheckedAt: null,
    lastOutcome: null,
    ...overrides,
  };
}

function writeSnapshot(dataDir: string, filename: string, value: unknown): void {
  writeFileSync(join(dataDir, 'recovery-status', filename), JSON.stringify(value));
}

test('aggregates separate instances and exposes only allowed fields when snapshots contain secrets', (context) => {
  const dataDir = fixture(context);
  const updatedAt = Date.now();
  writeSnapshot(dataDir, 'a.json', snapshot('a', {
    updatedAt,
    token: 'secret-token',
    sessions: [{ sessionID: 's1', phase: 'waiting', credential: 'secret-credential' }],
  }));
  writeSnapshot(dataDir, 'b.json', snapshot('b', { updatedAt, waitingCount: 1, phase: 'checking' }));

  const result = readRecoveryStatus(dataDir);

  assert.equal(result.totalWaiting, 3);
  assert.deepEqual(result.instances, [
    {
      version: 1, id: 'a', pid: 12345, updatedAt,
      phase: 'waiting', waitingCount: 2,
      sessions: [{ sessionID: 's1', phase: 'waiting' }],
      nextCheckAt: null, lastCheckedAt: null, lastOutcome: null, stale: false,
    },
    {
      version: 1, id: 'b', pid: 12345, updatedAt,
      phase: 'checking', waitingCount: 1,
      sessions: [{ sessionID: 'session-1', phase: 'waiting' }],
      nextCheckAt: null, lastCheckedAt: null, lastOutcome: null, stale: false,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /secret-token|secret-credential/);
});

test('marks and removes an old snapshot without probing its process', (context) => {
  const dataDir = fixture(context);
  writeSnapshot(dataDir, 'old.json', snapshot('old', { updatedAt: Date.now() - 180_001 }));

  const result = readRecoveryStatus(dataDir);

  assert.equal(result.instances[0]?.stale, true);
  assert.equal(result.totalWaiting, 0);
  assert.deepEqual(readdirSync(join(dataDir, 'recovery-status')), []);
});

test('ignores malformed, unknown-version, and invalid-shape snapshots', (context) => {
  const dataDir = fixture(context);
  const directory = join(dataDir, 'recovery-status');
  writeFileSync(join(directory, 'broken.json'), '{oops');
  writeSnapshot(dataDir, 'version.json', snapshot('version', { version: 2 }));
  writeSnapshot(dataDir, 'shape.json', snapshot('shape', { sessions: [{ sessionID: 3, phase: 'ready' }] }));
  writeSnapshot(dataDir, 'negative.json', snapshot('negative', { waitingCount: -1 }));
  writeSnapshot(dataDir, 'valid.json', snapshot('valid', { waitingCount: 1 }));

  const result = readRecoveryStatus(dataDir);

  assert.deepEqual(result.instances.map((instance) => instance.id), ['valid']);
  assert.equal(result.totalWaiting, 1);
});

test('ignores symlinks, directories, unrelated files, and oversized snapshots', (context) => {
  const dataDir = fixture(context);
  const directory = join(dataDir, 'recovery-status');
  writeSnapshot(dataDir, 'target.json', snapshot('target'));
  symlinkSync(join(directory, 'target.json'), join(directory, 'link.json'));
  mkdirSync(join(directory, 'folder.json'));
  writeFileSync(join(directory, 'ignored.txt'), JSON.stringify(snapshot('ignored')));
  writeSnapshot(dataDir, 'large.json', snapshot('large', { padding: 'x'.repeat(65_536) }));

  const result = readRecoveryStatus(dataDir);

  assert.deepEqual(result.instances.map((instance) => instance.id), ['target']);
});

test('reads all JSON snapshots beyond the former 128-file cap', (context) => {
  const dataDir = fixture(context);
  for (let index = 0; index < 130; index += 1) {
    writeSnapshot(dataDir, `${String(index).padStart(3, '0')}.json`, snapshot(`instance-${index}`));
  }

  const result = readRecoveryStatus(dataDir);

  assert.equal(result.instances.length, 130);
  assert.equal(result.totalWaiting, 260);
});

test('finds a live snapshot after stale files and removes the stale files', (context) => {
  const dataDir = fixture(context);
  const directory = join(dataDir, 'recovery-status');
  const staleUpdatedAt = Date.now() - 180_001;
  for (let index = 0; index < 129; index += 1) {
    writeSnapshot(dataDir, `stale-${String(index).padStart(3, '0')}.json`, snapshot(`stale-${index}`, {
      updatedAt: staleUpdatedAt,
    }));
  }
  writeSnapshot(dataDir, 'zzz-live.json', snapshot('live', { waitingCount: 1 }));

  const result = readRecoveryStatus(dataDir);

  assert.equal(result.totalWaiting, 1);
  assert.equal(result.instances.some((instance) => instance.id === 'live'), true);
  assert.deepEqual(readdirSync(directory), ['zzz-live.json']);
});

test('missing snapshot directory returns an empty status without creating it', (context) => {
  const dataDir = fixture(context);
  rmSync(join(dataDir, 'recovery-status'), { recursive: true });

  const result = readRecoveryStatus(dataDir);

  assert.deepEqual(result, { instances: [], totalWaiting: 0 });
});

test('does not follow a symlinked snapshot directory', (context) => {
  const dataDir = fixture(context);
  const external = mkdtempSync(join(tmpdir(), 'quotahot-recovery-external-'));
  context.after(() => rmSync(external, { recursive: true, force: true }));
  writeFileSync(join(external, 'external.json'), JSON.stringify(snapshot('external')));
  rmSync(join(dataDir, 'recovery-status'), { recursive: true });
  symlinkSync(external, join(dataDir, 'recovery-status'));

  const result = readRecoveryStatus(dataDir);

  assert.deepEqual(result, { instances: [], totalWaiting: 0 });
});
