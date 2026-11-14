import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { omoRecoveryFixture } from './omo-recovery-fixture.js';

test('OmO publishes shared waiting sessions, check deadlines, heartbeat and cancellation', async (t) => {
  const state = omoRecoveryFixture(t);
  const first = state.session('first');
  const second = state.session('second');
  const one = await first.begin();
  const two = await second.begin();
  const snapshot = () => {
    const values = [...state.files].filter(([path]) => path.endsWith('.json'));
    assert.equal(values.length, 1);
    return JSON.parse(values[0]?.[1] ?? '');
  };
  assert.partialDeepStrictEqual(snapshot(), {
    source: 'omo', phase: 'checking', waitingCount: 2,
    sessions: [{ sessionID: 'first', phase: 'checking' }, { sessionID: 'second', phase: 'checking' }],
    nextCheckAt: null,
  });
  state.children[0]?.finish({ outcome: 'no_candidate', latestData: true, waitUntil: 120_100 });
  await Promise.all([one.pending, two.pending]);
  await state.flush();
  assert.partialDeepStrictEqual(snapshot(), {
    phase: 'waiting', nextCheckAt: 180_100, lastCheckedAt: 100, lastOutcome: 'no_candidate',
  });
  await state.advance(60_000);
  assert.equal(snapshot().updatedAt, 60_100);
  await first.input();
  assert.deepEqual(snapshot().sessions, [{ sessionID: 'second', phase: 'waiting' }]);
  await state.advance(120_000);
  assert.partialDeepStrictEqual(snapshot(), { phase: 'checking', nextCheckAt: null });
  second.setIdle(false);
  state.children[1]?.finish({ outcome: 'available', resume: true, latestData: true });
  await state.flush();
  assert.partialDeepStrictEqual(snapshot(), {
    phase: 'ready', lastOutcome: 'available', nextCheckAt: 181_100,
  });
  second.setIdle(true);
  await state.advance(1_000);
  assert.deepEqual(state.messages, ['second']);
  assert.equal(state.files.size, 0);
  assert.equal(state.timers.size, 0);
});

test('OmO exposes state-change-only waits without inventing a polling deadline', async (t) => {
  const state = omoRecoveryFixture(t);
  const session = state.session('state-only');
  await session.fail({ outcome: 'no_candidate', latestData: true });
  const text = [...state.files.values()][0];
  assert.ok(text);
  assert.partialDeepStrictEqual(JSON.parse(text), {
    source: 'omo', phase: 'waiting', nextCheckAt: null, lastOutcome: 'no_candidate',
  });
  await session.shutdown();
  assert.equal(state.files.size, 0);
});

test('recovery CLI reads an OmO-produced snapshot alongside legacy OpenCode snapshots', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'quotahot-omo-status-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const state = omoRecoveryFixture(t);
  state.jumpWallClock(Date.now() - state.now());
  await state.session('omo-session').fail({ outcome: 'no_candidate', latestData: true });
  const data = join(home, 'data');
  const directory = join(data, 'recovery-status');
  await mkdir(directory, { recursive: true });
  for (const [path, contents] of state.files) await writeFile(join(directory, basename(path)), contents);
  await writeFile(join(directory, 'legacy.json'), JSON.stringify({
    version: 1, id: 'legacy', pid: 123, updatedAt: Date.now(), phase: 'waiting', waitingCount: 1,
    sessions: [{ sessionID: 'opencode-session', phase: 'waiting' }],
    nextCheckAt: null, lastCheckedAt: null, lastOutcome: null,
  }));
  const env = {
    ...process.env, HOME: home, QUOTAHOT_DATA_DIR: data,
    OMO_CODING_AGENT_DIR: join(home, 'omo'), PI_CODING_AGENT_DIR: join(home, 'pi'),
    XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'share'),
  };
  const invoke = promisify(execFile);
  const args = ['--import', import.meta.resolve('tsx'), resolve('src/index.ts'), 'recovery'];
  const json = await invoke(process.execPath, [...args, '--json'], { env });
  const result = JSON.parse(json.stdout);
  assert.equal(result.totalWaiting, 2);
  assert.deepEqual(result.instances.map((item: { source: string }) => item.source).sort(), ['omo', 'opencode']);
  assert.match(json.stdout, /omo-session/);
  assert.doesNotMatch(json.stdout, /test@example|accountId|loginId/);
  const text = await invoke(process.execPath, args, { env });
  assert.match(text.stdout, /OmO · 进程/);
  assert.match(text.stdout, /OpenCode · 进程/);
  assert.match(text.stdout, /omo-session: waiting/);
  assert.match(text.stdout, /opencode-session: waiting/);
});
