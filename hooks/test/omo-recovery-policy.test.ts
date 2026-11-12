import assert from 'node:assert/strict';
import { test } from 'node:test';
import { omoRecoveryFixture } from './omo-recovery-fixture.js';

test('OmO waits for the earliest reset plus the OpenCode one-minute buffer', async (t) => {
  const state = omoRecoveryFixture(t);
  const session = state.session('deadline');
  state.setState({ accounts: { early: { usedPercent: 100, resetAt: 120_100, blockedUntil: 120_100 } } });
  await session.fail({ outcome: 'no_candidate', latestData: true, waitUntil: 240_100 });

  await state.advance(179_999);
  assert.equal(state.children.length, 1);
  await state.advance(1);
  assert.equal(state.children.length, 2);
  state.children.at(-1)?.finish({ outcome: 'available', resume: true, latestData: true });
  await state.flush();
  assert.deepEqual(state.messages, ['deadline']);
});

test('OmO with fresh quota and no future reset waits for a real state change', async (t) => {
  const state = omoRecoveryFixture(t);
  await state.session('fresh').fail({ outcome: 'no_candidate', latestData: true });
  await state.advance(86_400_000);
  state.emitState(); await state.flush(); await state.advance(0);
  assert.equal(state.children.length, 1);

  state.setState({ accounts: { recovered: { usedPercent: 10, resetAt: 0, blockedUntil: 0 } } });
  state.emitState(); await state.flush(); await state.advance(0);
  assert.equal(state.children.length, 2);
  state.children.at(-1)?.finish({ outcome: 'available', resume: true, latestData: true });
  await state.flush();
  assert.deepEqual(state.messages, ['fresh']);
});

for (const [outcome, delays] of [
  ['network_error', [5_000, 10_000, 20_000, 40_000]],
  ['check_failed', [600_000, 1_200_000, 2_400_000, 4_800_000]],
] as const) {
  test(`OmO bounds ${outcome} retries to five checks and wakes only for changed quota`, async (t) => {
    const state = omoRecoveryFixture(t);
    await state.session('bounded').fail({ outcome, latestData: false });
    for (const [index, delay] of delays.entries()) {
      await state.advance(delay - 1);
      assert.equal(state.children.length, index + 1);
      await state.advance(1);
      assert.equal(state.children.length, index + 2);
      state.children.at(-1)?.finish({ outcome, latestData: false });
      await state.flush();
    }
    await state.advance(86_400_000);
    state.emitState(); await state.flush(); await state.advance(0);
    assert.equal(state.children.length, 5);

    state.setState({ accounts: { recovered: { usedPercent: 0, resetAt: 0, blockedUntil: 0 } } });
    state.emitState(); await state.flush(); await state.advance(0);
    assert.equal(state.children.length, 6);
    state.children.at(-1)?.finish({ outcome: 'available', resume: true, latestData: true });
    await state.flush();
    assert.deepEqual(state.messages, ['bounded']);
  });
}

test('OmO retries a contended lock after one second and keeps its query baseline', async (t) => {
  const state = omoRecoveryFixture(t);
  const deadline = state.now() + 604_800_000;
  await state.session('lock').fail({ outcome: 'lock_contended', waitUntil: deadline, latestData: false });
  const initial = state.payloads[0]?.quotaCheckAfter;
  assert.equal(typeof initial, 'number');
  await state.advance(999);
  assert.equal(state.children.length, 1);
  await state.advance(1);
  assert.equal(state.children.length, 2);
  assert.equal(state.payloads[1]?.quotaCheckAfter, initial);
});

for (const cancelFirst of [false, true]) {
  test(`OmO shares one quota check across waiting sessions with owner cancellation=${cancelFirst}`, async (t) => {
    const state = omoRecoveryFixture(t);
    const first = state.session('one');
    const second = state.session('two');
    const firstRun = await first.begin();
    const secondRun = await second.begin();
    assert.equal(state.children.length, 1);
    if (cancelFirst) {
      await first.input();
      assert.equal(state.children[0]?.killed(), false);
    }
    state.children[0]?.finish({ outcome: 'network_error', latestData: false });
    await Promise.all([firstRun.pending, secondRun.pending]);
    await state.flush();
    await state.advance(5_000);
    assert.equal(state.children.length, 2);
    state.children[1]?.finish({ outcome: 'available', resume: true, latestData: true });
    await state.flush();
    assert.deepEqual(state.messages.sort(), cancelFirst ? ['two'] : ['one', 'two']);
  });
}

test('OmO cancellation removes polling and state watchers without another API call', async (t) => {
  const state = omoRecoveryFixture(t);
  const session = state.session('cancel');
  await session.fail({ outcome: 'network_error', latestData: false });
  await session.input();
  await state.advance(86_400_000);
  assert.equal(state.children.length, 1);
  assert.equal(state.watchers.size, 0);
  assert.equal(state.timers.size, 0);
  assert.deepEqual(state.messages, []);
});

test('OmO defers a due check while busy and resumes once after becoming idle', async (t) => {
  const state = omoRecoveryFixture(t);
  const session = state.session('busy');
  await session.fail({ outcome: 'network_error', latestData: false });
  session.setIdle(false);
  await state.advance(5_000);
  assert.equal(state.children.length, 1);
  session.setIdle(true);
  await state.advance(1_000);
  assert.equal(state.children.length, 2);
  state.children[1]?.finish({ outcome: 'available', resume: true, latestData: true });
  await state.flush();
  await state.advance(60_000);
  assert.deepEqual(state.messages, ['busy']);
});

test('OmO resumes a ready session after transient busy status without querying quota again', async (t) => {
  const state = omoRecoveryFixture(t);
  const session = state.session('ready');
  await session.fail({ outcome: 'network_error', latestData: false });
  await state.advance(5_000);
  session.setIdle(false);
  state.children[1]?.finish({ outcome: 'available', resume: true, latestData: true });
  await state.flush();
  assert.deepEqual(state.messages, []);
  session.setIdle(true);
  await state.advance(1_000);
  assert.deepEqual(state.messages, ['ready']);
  assert.equal(state.children.length, 2);
});

test('OmO wall-clock recovery still works after suspension with the new reset buffer', async (t) => {
  const state = omoRecoveryFixture(t);
  const reset = state.now() + 3_600_000;
  await state.session('suspended').fail({ outcome: 'no_candidate', latestData: true, waitUntil: reset });
  state.jumpWallClock(3_660_000);
  await state.advance(60_000);
  assert.equal(state.children.length, 2);
  state.children[1]?.finish({ outcome: 'available', resume: true, latestData: true });
  await state.flush();
  assert.deepEqual(state.messages, ['suspended']);
});

test('OmO watcher errors retry local observation without polling the API on unchanged state', async (t) => {
  const state = omoRecoveryFixture(t);
  await state.session('watch').fail({ outcome: 'no_candidate', latestData: true });
  state.failWatch();
  for (const watcher of state.watchers) watcher.emit('error', new Error('watch disconnected'));
  await state.advance(1_000);
  await state.advance(1_000);
  assert.equal(state.children.length, 1);
  state.setState({ accounts: { available: { usedPercent: 0, resetAt: 0, blockedUntil: 0 } } });
  state.emitState(); await state.flush(); await state.advance(0);
  assert.equal(state.children.length, 2);
});

for (const inFlight of [false, true]) {
  test(`OmO joins an existing recovery with inFlight=${inFlight} without duplicate checks or continuation`, async (t) => {
    const state = omoRecoveryFixture(t);
    await state.session('waiting').fail({ outcome: 'network_error', latestData: false });
    if (inFlight) await state.advance(5_000);
    const other = state.session('new');
    const { pending } = await other.begin();
    assert.equal(state.children.length, 2);
    state.children[1]?.finish({ outcome: 'available', resume: true, latestData: true });
    const boundary = await pending;
    await state.flush();
    assert.partialDeepStrictEqual(boundary, { continue: true });
    await state.advance(60_000);
    assert.deepEqual(state.messages, ['waiting']);
    assert.equal(state.children.length, 2);
  });
}

for (const stopReason of ['stop', 'length', 'aborted']) {
  test(`OmO cancels quota recovery when an internal turn ends with ${stopReason}`, async (t) => {
    const state = omoRecoveryFixture(t);
    const session = state.session('finished');
    await session.fail({ outcome: 'network_error', latestData: false });
    await session.end(stopReason);
    await state.advance(86_400_000);
    assert.equal(state.children.length, 1);
    assert.equal(state.timers.size, 0);
    assert.equal(state.watchers.size, 0);
    assert.deepEqual(state.messages, []);
  });
}

for (const source of ['matching', 'other_login', 'opencode']) {
  test(`OmO consumes only its own matching receipt when source=${source}`, async (t) => {
    const state = omoRecoveryFixture(t);
    await state.session('receipt').fail({ outcome: 'no_candidate', latestData: true });
    const completedAt = state.now() + 1;
    state.setState({
      [source === 'opencode' ? 'lastQuotaCheck' : 'lastOmoQuotaCheck']: {
        provider: 'codex', completedAt, outcome: 'available', switched: false, latestData: true, waitUntil: 0,
        omoRequest: { accountId: 'account', email: 'test@example.invalid', loginId: source === 'other_login' ? 'other' : 'login' },
      },
    });
    state.emitState(); await state.flush(); await state.advance(0);
    assert.equal(state.children.length, source === 'matching' ? 2 : 1);
    if (source === 'matching') assert.equal(state.payloads[1]?.quotaCheckAfter, completedAt);
  });
}

test('OmO state changes during a failed check preserve its network retry delay', async (t) => {
  const state = omoRecoveryFixture(t);
  await state.session('in-flight').fail({ outcome: 'network_error', latestData: false });
  await state.advance(5_000);
  state.setState({ accounts: { changed: { usedPercent: 100, resetAt: 1_000_000, blockedUntil: 1_000_000 } } });
  state.emitState(); await state.flush();
  state.children[1]?.finish({ outcome: 'network_error', latestData: false });
  await state.flush();
  await state.advance(9_999);
  assert.equal(state.children.length, 2);
  await state.advance(1);
  assert.equal(state.children.length, 3);
});
