import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Readable } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { HttpResponse } from '../src/server/http.js';
import { WechatSessionStore } from '../src/server/wechat-session-store.js';
import { WechatClawbotClient, WechatClawbotError, type QrLoginStatus } from '../src/server/wechat-clawbot-client.js';
import { WechatLoginService } from '../src/server/wechat-login-service.js';

const origin = Date.parse('2026-10-19T12:00:00Z');
const credentials = { ownerIlinkUserId: 'trusted-owner', botId: 'bot-one', botToken: 'private-bot', baseUrl: 'https://example.invalid/' };
const confirmed = { status: 'confirmed', credentials } as const;

function fixture(t: TestContext) {
  const store = new WechatSessionStore(':memory:');
  t.after(() => store.close());
  let now = origin;
  let sequence = 0;
  let calls = 0;
  const signals: AbortSignal[] = [];
  let reply: () => Promise<QrLoginStatus> = async () => confirmed;
  const client = { createQr: async () => ({ qrPayload: 'scan-payload', pollStatus: async (signal?: AbortSignal) => {
    assert.ok(signal); signals.push(signal); calls++; return reply();
  } }) };
  const options = { now: () => now, randomBytes: (size: number) => {
    const bytes = Buffer.alloc(size); bytes.writeUInt32BE(++sequence); return bytes;
  } };
  const service = new WechatLoginService(store, client, options);
  return { store, service, client, options, signals, calls: () => calls, time: (value: number) => { now = value; },
    reply: (value: () => Promise<QrLoginStatus>) => { reply = value; } };
}

function deferred<Value>() {
  let settle: (value: Value) => void = () => { throw new Error('Deferred resolver not initialized'); };
  const promise = new Promise<Value>((resolve) => { settle = resolve; });
  return { promise, resolve: (value: Value) => settle(value) };
}

function drainingFixture(t: TestContext) {
  const f = fixture(t);
  const entered = deferred<void>();
  const drained = deferred<void>();
  const workers = new Map<string, string>();
  const starts: string[] = [];
  let hold = false;
  const service = new WechatLoginService(f.store, f.client, { ...f.options,
    beforeBindingChange: async (owner) => {
      workers.delete(owner);
      if (hold) { entered.resolve(); await drained.promise; }
    },
    afterBindingChange: (owner) => {
      const binding = f.store.getBinding(owner);
      if (binding && !f.store.isBindingPaused(owner)) {
        assert.equal(workers.has(owner), false);
        workers.set(owner, binding.botToken);
        starts.push(binding.botToken);
      }
    },
  });
  return { ...f, service, entered, drained, workers, starts, hold: () => { hold = true; } };
}

for (const failure of ['cancel', 'confirmation-save'] as const) {
  test(`resumes exactly one persisted active worker after drained ${failure}`, { timeout: 2000 }, async (t) => {
    const f = drainingFixture(t);
    await login(f.service);
    const previous = f.store.getBinding(credentials.ownerIlinkUserId);
    f.reply(async () => ({ status: 'confirmed', credentials: { ...credentials, botToken: 'must-not-persist' } }));
    const attempt = await f.service.start();
    const error = new Error('persistence failed');
    const saveConfirmation = t.mock.method(f.store, 'confirmBinding', () => { throw error; });
    f.hold();
    const pending = f.service.poll(attempt.attemptId, attempt.flowToken);
    const result = failure === 'cancel' ? pending : assert.rejects(pending, (actual: unknown) => actual === error);
    await f.entered.promise;
    assert.equal(f.workers.size, 0);
    if (failure === 'cancel') assert.equal(f.service.cancel(attempt.attemptId, attempt.flowToken), true);
    f.drained.resolve();
    if (failure === 'cancel') assert.deepEqual(await result, { status: 'unavailable' });
    else await result;
    assert.deepEqual(f.store.getBinding(credentials.ownerIlinkUserId), previous);
    assert.equal(f.store.isBindingPaused(credentials.ownerIlinkUserId), false);
    assert.equal(saveConfirmation.mock.callCount(), failure === 'confirmation-save' ? 1 : 0);
    assert.deepEqual([...f.workers.values()], [credentials.botToken]);
    assert.deepEqual(f.starts, [credentials.botToken, credentials.botToken]);
  });
}

test('does not confirm a QR attempt that expires while draining the prior binding worker', { timeout: 2000 }, async (t) => {
  const f = drainingFixture(t);
  const attempt = await f.service.start();
  const saveBindingAndSession = t.mock.method(f.store, 'confirmBinding');
  f.hold();

  const polling = f.service.poll(attempt.attemptId, attempt.flowToken);
  await f.entered.promise;
  f.time(origin + 600_000);
  f.drained.resolve();

  assert.deepEqual(await polling, { status: 'expired' });
  assert.equal(saveBindingAndSession.mock.callCount(), 0);
  assert.equal(f.store.getBinding(credentials.ownerIlinkUserId), null);
  assert.deepEqual(f.store.listBindings(), []);
});

for (const action of ['unlink', 'shutdown', 'newer-confirmation', 'newer-same-credentials', 'persisted-replacement'] as const) {
  for (const phase of ['poll'] as const) {
    test(`does not resurrect drained ${phase} worker over ${action}`, { timeout: 2000 }, async (t) => {
      const f = drainingFixture(t);
      await login(f.service);
      const attempt = await f.service.start();
      const newerConfirmation = action === 'newer-confirmation' || action === 'newer-same-credentials';
      f.hold();
      const settled = f.service.poll(attempt.attemptId, attempt.flowToken);
      await f.entered.promise;
      let mutation: Promise<unknown> = Promise.resolve();
      if (action === 'unlink') mutation = f.service.unlink(credentials.ownerIlinkUserId);
      else if (action === 'shutdown') mutation = f.service.shutdown();
      else if (action === 'persisted-replacement') {
        f.service.cancel(attempt.attemptId, attempt.flowToken);
        f.store.saveBinding({ ...credentials, botToken: 'external-newer' }, origin);
      } else {
        f.reply(async () => ({ status: 'confirmed', credentials: { ...credentials,
          botToken: action === 'newer-same-credentials' ? credentials.botToken : 'newer' } }));
        const latest = await f.service.start(attempt.flowToken);
        mutation = f.service.poll(latest.attemptId, latest.flowToken);
        await nextTurn();
      }
      f.drained.resolve();
      await settled;
      await mutation;
      const latestToken = action === 'newer-same-credentials' ? credentials.botToken : 'newer';
      assert.deepEqual(f.starts, newerConfirmation
        ? [credentials.botToken, latestToken] : [credentials.botToken]);
      assert.deepEqual([...f.workers.values()], newerConfirmation ? [latestToken] : []);
    });
  }
}

test('preserves persisted pause until QR reauthorization resumes the binding', async (t) => {
  const f = fixture(t);
  await login(f.service);
  f.store.pauseBinding(credentials.ownerIlinkUserId);

  assert.equal(f.store.getBinding(credentials.ownerIlinkUserId)?.botToken, credentials.botToken);
  assert.equal(f.store.isBindingPaused(credentials.ownerIlinkUserId), true);
  const restarted = new WechatLoginService(f.store, f.client, f.options);
  f.reply(async () => ({ status: 'confirmed', credentials: { ...credentials, botToken: 'latest' } }));
  await login(restarted);
  assert.equal(f.store.isBindingPaused(credentials.ownerIlinkUserId), false);
  assert.equal(f.store.getBinding(credentials.ownerIlinkUserId)?.botToken, 'latest');
});

test('serializes owner replacement behind drain and rejects confirmation invalidated during drain', { timeout: 2000 }, async (t) => {
  const f = fixture(t);
  const gate = deferred<void>();
  const entered = deferred<void>();
  let hold = false;
  const started: string[] = [];
  const service = new WechatLoginService(f.store, f.client, { ...f.options,
    beforeBindingChange: async () => { if (hold) { entered.resolve(); await gate.promise; } },
    afterBindingChange: (owner) => { started.push(owner); },
  });
  await login(service);
  hold = true;
  const attempt = await service.start();
  const polling = service.poll(attempt.attemptId, attempt.flowToken);
  await entered.promise;
  const unlink = service.unlink(credentials.ownerIlinkUserId);
  gate.resolve();

  assert.equal((await polling).status, 'unavailable');
  await unlink;
  assert.equal(f.store.getBinding(credentials.ownerIlinkUserId), null);
  assert.equal(started.length, 2);
});

for (const action of ['cancel', 'shutdown'] as const) {
  test(`rejects QR confirmation during worker drain after ${action}`, { timeout: 2000 }, async (t) => {
    const f = fixture(t);
    const gate = deferred<void>();
    const entered = deferred<void>();
    const service = new WechatLoginService(f.store, f.client, { ...f.options,
      beforeBindingChange: async () => { entered.resolve(); await gate.promise; },
    });
    const attempt = await service.start();
    const polling = service.poll(attempt.attemptId, attempt.flowToken);
    await entered.promise;

    if (action === 'cancel') assert.equal(service.cancel(attempt.attemptId, attempt.flowToken), true);
    const shutdown = action === 'shutdown' ? service.shutdown() : Promise.resolve();
    gate.resolve();

    assert.equal((await polling).status, 'unavailable');
    await shutdown;
    assert.equal(f.store.getBinding(credentials.ownerIlinkUserId), null);
  });
}

async function login(service: WechatLoginService, previousFlow?: string) {
  const attempt = await service.start(previousFlow);
  const result = await service.poll(attempt.attemptId, attempt.flowToken);
  assert.equal(result.status, 'confirmed');
  if (result.status !== 'confirmed') assert.fail('expected a confirmed browser login');
  return { ...result, attemptId: attempt.attemptId, flowToken: attempt.flowToken };
}

test('saves verified binding without a browser secret or session expiry after trusted confirmation', async (t) => {
  const f = fixture(t);
  const attempt = await f.service.start();
  f.reply(async () => ({ status: 'scanned' }));
  assert.deepEqual(await f.service.poll(attempt.attemptId, attempt.flowToken), { status: 'scanned' });
  assert.equal(f.store.getBinding(credentials.ownerIlinkUserId), null);
  f.reply(async () => confirmed);

  const result = await f.service.poll(attempt.attemptId, attempt.flowToken);

  assert.equal(result.status, 'confirmed');
  if (result.status !== 'confirmed') assert.fail();
  assert.deepEqual(result, { status: 'confirmed' });
  assert.equal(Buffer.from(attempt.attemptId, 'base64url').length, 32);
  assert.deepEqual(f.store.getBinding(credentials.ownerIlinkUserId), { ...credentials, createdAt: origin, updatedAt: origin });
  assert.equal(JSON.stringify(result).includes(credentials.botToken), false);
  assert.equal((await f.service.poll(attempt.attemptId, attempt.flowToken)).status, 'unavailable');
});

for (const ilink_user_id of [undefined, null, '', ' \t\n']) {
  test(`discards confirmed QR with missing identity ${JSON.stringify(ilink_user_id)} without binding or session writes`, async (t) => {
    const f = fixture(t);
    const prior = await login(f.service);
    await login(f.service);
    f.reply(async () => ({ status: 'confirmed', credentials: { ...credentials, ownerIlinkUserId: 'other-owner' } }));
    await login(f.service);
    const bindings = f.store.listBindings();
    let calls = 0;
    let pollSignal: AbortSignal | undefined;
    const client = new WechatClawbotClient(async (_url, options) => {
        calls++;
        const qrcode = 'missing-identity';
        if (calls > 1) pollSignal = options?.signal;
        return new HttpResponse(200, new Headers(), Readable.from([JSON.stringify(calls === 1
          ? { ret: 0, qrcode, qrcode_img_content: `https://liteapp.weixin.qq.com/q/test?qrcode=${qrcode}&bot_type=3` }
          : { ret: 0, status: 'confirmed', ilink_user_id, ilink_bot_id: 'bot-one', bot_token: 'new-private-bot',
            baseurl: credentials.baseUrl })]));
      });
    const service = new WechatLoginService(f.store, client, f.options);
    const attempt = await service.start(prior.flowToken);
    const saveBinding = t.mock.method(f.store, 'saveBinding');
    const saveConfirmation = t.mock.method(f.store, 'confirmBinding');
    const removeBinding = t.mock.method(f.store, 'removeBinding');

    const result = await service.poll(attempt.attemptId, attempt.flowToken);

    assert.deepEqual(result, { status: 'identity_missing' });
    assert.equal(pollSignal?.aborted, true);
    assert.deepEqual(f.store.listBindings(), bindings);
    for (const spy of [saveBinding, saveConfirmation, removeBinding]) assert.equal(spy.mock.callCount(), 0);
    assert.deepEqual(await service.poll(attempt.attemptId, attempt.flowToken), { status: 'unavailable' });
    assert.equal(service.cancel(attempt.attemptId, attempt.flowToken), false);
    assert.equal(calls, 2);
  });
}

for (const offset of [599_999, 600_000, 600_001]) {
  test(`enforces ten minute attempt expiry at ${offset}`, async (t) => {
    const f = fixture(t);
    const attempt = await f.service.start();
    f.time(origin + offset);

    const result = await f.service.poll(attempt.attemptId, attempt.flowToken);

    assert.equal(result.status, offset < 600_000 ? 'confirmed' : 'expired');
    assert.equal(f.calls(), offset < 600_000 ? 1 : 0);
  });
}

test('coalesces concurrent polls but confirms the binding exactly once', async (t) => {
  const f = fixture(t);
  const pending = deferred<QrLoginStatus>();
  f.reply(() => pending.promise);
  const attempt = await f.service.start();
  const first = f.service.poll(attempt.attemptId, attempt.flowToken);
  const second = f.service.poll(attempt.attemptId, attempt.flowToken);

  pending.resolve(confirmed);
  const results = await Promise.all([first, second]);

  assert.equal(f.calls(), 1);
  assert.deepEqual(results.map((result) => result.status), ['confirmed', 'unavailable']);
});

test('a newer login attempt for the same browser invalidates the older attempt', async (t) => {
  const f = fixture(t);
  const older = await f.service.start();
  const newer = await f.service.start(older.flowToken);

  assert.equal((await f.service.poll(older.attemptId, older.flowToken)).status, 'unavailable');
  const current = await f.service.poll(newer.attemptId, newer.flowToken);

  assert.equal(current.status, 'confirmed');
  if (current.status !== 'confirmed') assert.fail();
  assert.deepEqual(current, { status: 'confirmed' });
});

test('unlink disables its owner and rejects that owner pending QR confirmation', async (t) => {
  const f = fixture(t);
  const prior = await login(f.service);
  const attempt = await f.service.start(prior.flowToken);

  assert.equal(await f.service.unlink(credentials.ownerIlinkUserId), true);

  assert.equal((await f.service.poll(attempt.attemptId, attempt.flowToken)).status, 'unavailable');
  assert.equal(f.store.getBinding(credentials.ownerIlinkUserId), null);
});

test('unlink leaves other owners usable until same-owner QR reauthorization', async (t) => {
  const f = fixture(t);
  await login(f.service);
  f.reply(async () => ({ status: 'confirmed', credentials: { ...credentials, ownerIlinkUserId: 'other-owner' } }));
  await login(f.service);
  const otherBinding = f.store.getBinding('other-owner');

  assert.equal(await f.service.unlink(credentials.ownerIlinkUserId), true);

  assert.equal(f.store.getBinding(credentials.ownerIlinkUserId), null);
  assert.deepEqual(f.store.getBinding('other-owner'), otherBinding);
  f.reply(async () => confirmed);
  await login(f.service);
  assert.ok(f.store.getBinding(credentials.ownerIlinkUserId));
  assert.equal(await f.service.unlink('unknown-owner'), false);
  assert.ok(f.store.getBinding(credentials.ownerIlinkUserId));
});

test('unlink discards an in-flight confirmation for its owner', async (t) => {
  const f = fixture(t);
  const session = await login(f.service);
  const attempt = await f.service.start(session.flowToken);
  const pending = deferred<QrLoginStatus>();
  f.reply(() => pending.promise);
  const polling = f.service.poll(attempt.attemptId, attempt.flowToken);

  await f.service.unlink(credentials.ownerIlinkUserId);
  pending.resolve(confirmed);

  assert.equal((await polling).status, 'unavailable');
  assert.equal(f.store.getBinding(credentials.ownerIlinkUserId), null);
});

test('replacing a flow during QR creation rejects its late creation', async (t) => {
  const f = fixture(t);
  const prior = await f.service.start();
  const pending = deferred<Awaited<ReturnType<typeof f.client.createQr>>>();
  f.client.createQr = () => pending.promise;
  const starting = f.service.start(prior.flowToken);
  const rejected = assert.rejects(starting, { code: 'cancelled' });

  const replacement = f.service.start(prior.flowToken);
  pending.resolve({ qrPayload: 'late-payload', pollStatus: async () => confirmed });

  await rejected;
  assert.ok(await replacement);
});

for (const action of ['cancel', 'expire'] as const) {
  test(`discards an in-flight confirmation after ${action}`, async (t) => {
    const f = fixture(t);
    const pending = deferred<QrLoginStatus>();
    f.reply(() => pending.promise);
    const attempt = await f.service.start();
    const polling = f.service.poll(attempt.attemptId, attempt.flowToken);
    if (action === 'cancel') f.service.cancel(attempt.attemptId, attempt.flowToken);
    else f.time(origin + 600_000);

    pending.resolve(confirmed);
    const result = await polling;

    assert.equal(result.status, action === 'cancel' ? 'unavailable' : 'expired');
    assert.equal(f.store.getBinding(credentials.ownerIlinkUserId), null);
  });
}

test('independent QR confirmations preserve other owner bindings without browser sessions', async (t) => {
  const f = fixture(t);
  await login(f.service);
  const previous = f.store.getBinding(credentials.ownerIlinkUserId);
  f.time(origin + 1000);

  f.reply(async () => ({ status: 'confirmed', credentials: { ...credentials, ownerIlinkUserId: 'other-owner' } }));
  const current = await login(f.service);

  assert.deepEqual(current.status, 'confirmed');
  assert.deepEqual(f.store.getBinding(credentials.ownerIlinkUserId), previous);
  assert.ok(f.store.getBinding('other-owner'));
});

for (const error of [new WechatClawbotError('auth_required', 401), new WechatClawbotError('auth_required', 403)]) {
  for (const phase of ['poll'] as const) {
    test(`propagates actionable ${error.name}/${error.code}/${error instanceof WechatClawbotError ? error.httpStatus : ''} during ${phase}`, async (t) => {
      const f = fixture(t);
      const attempt = await f.service.start();
      f.reply(async () => { throw error; });

      const result = f.service.poll(attempt.attemptId, attempt.flowToken);

      await assert.rejects(result, (actual: unknown) => actual === error);
      assert.equal(f.store.getBinding(credentials.ownerIlinkUserId), null);
      f.reply(async () => confirmed);
      assert.equal((await f.service.poll(attempt.attemptId, attempt.flowToken)).status, 'confirmed');
    });
  }
}

for (const error of [new WechatClawbotError('request_failed'), new WechatClawbotError('http_failure', 503),
  new WechatClawbotError('invalid_response')]) {
  test(`keeps initial polling unverified after transient ${error.code}`, async (t) => {
    const f = fixture(t);
    const attempt = await f.service.start();
    f.reply(async () => { throw error; });

    const result = await f.service.poll(attempt.attemptId, attempt.flowToken);

    assert.deepEqual(result, { status: 'unverified' });
    assert.equal(f.store.getBinding(credentials.ownerIlinkUserId), null);
  });
}

test('refreshes same-owner same-bot credentials on a later confirmation without issuing a session', async (t) => {
  const f = fixture(t);
  await login(f.service);
  f.reply(async () => ({ status: 'confirmed', credentials: { ...credentials, botToken: 'renewed' } }));

  await login(f.service);

  assert.equal(f.store.getBinding(credentials.ownerIlinkUserId)?.botToken, 'renewed');
});

test('restart loses pending QR capabilities but preserves confirmed bindings', async (t) => {
  const f = fixture(t);
  await login(f.service);
  const pending = await f.service.start();
  const restarted = new WechatLoginService(f.store, f.client, f.options);

  assert.ok(f.store.getBinding(credentials.ownerIlinkUserId));
  assert.equal((await restarted.poll(pending.attemptId, pending.flowToken)).status, 'unavailable');
  assert.equal(f.calls(), 1);
});

test('preserves prior binding credentials when confirmation persistence fails', async (t) => {
  const f = fixture(t);
  await login(f.service);
  const attempt = await f.service.start();
  t.mock.method(f.store, 'confirmBinding', () => { throw new Error('persistence failed'); });
  f.reply(async () => ({ status: 'confirmed', credentials: { ...credentials, botToken: 'should-rollback' } }));

  await assert.rejects(f.service.poll(attempt.attemptId, attempt.flowToken), /persistence failed/);

  assert.equal(f.store.getBinding(credentials.ownerIlinkUserId)?.botToken, credentials.botToken);
});

test('bounds pending attempts and recovers capacity when their lifetime ends', async (t) => {
  const f = fixture(t);
  for (let count = 0; count < 128; count++) await f.service.start();

  await assert.rejects(f.service.start(), { code: 'capacity' });

  f.time(origin + 600_000);
  assert.ok(await f.service.start());
});

test('uses independent 256-bit platform secrets by default', async (t) => {
  const f = fixture(t);
  const service = new WechatLoginService(f.store, f.client);

  const first = await login(service);
  const second = await login(service);

  assert.equal(new Set([first.attemptId, first.flowToken, second.attemptId, second.flowToken]).size, 4);
  for (const token of [first.attemptId, first.flowToken, second.attemptId, second.flowToken]) {
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  }
});

for (const action of ['unlink'] as const) {
  test(`prevents an anonymous pending login from undoing ${action}`, async (t) => {
    const f = fixture(t);
    await login(f.service);
    const attempt = await f.service.start();
    const pending = deferred<QrLoginStatus>();
    f.reply(() => pending.promise);
    const polling = f.service.poll(attempt.attemptId, attempt.flowToken);
    await f.service[action](credentials.ownerIlinkUserId);

    pending.resolve(confirmed);

    assert.equal((await polling).status, 'unavailable');
    assert.equal(f.store.getBinding(credentials.ownerIlinkUserId), null);
  });
}

test('requires the initiating flow secret before polling or cancelling an attempt', async (t) => {
  const f = fixture(t);
  const attempt = await f.service.start();

  for (const token of [undefined, 'foreign', attempt.attemptId]) {
    assert.equal((await f.service.poll(attempt.attemptId, token)).status, 'unavailable');
    assert.equal(f.service.cancel(attempt.attemptId, token), false);
  }

  assert.equal(f.calls(), 0);
  assert.equal((await f.service.poll(attempt.attemptId, attempt.flowToken)).status, 'confirmed');
});

test('replaces an anonymous flow without affecting another browser', async (t) => {
  const f = fixture(t);
  const older = await f.service.start();
  const other = await f.service.start();

  const newer = await f.service.start(older.flowToken);

  assert.notEqual(newer.flowToken, older.flowToken);
  assert.equal((await f.service.poll(older.attemptId, older.flowToken)).status, 'unavailable');
  assert.equal((await f.service.poll(newer.attemptId, older.flowToken)).status, 'unavailable');
  assert.equal((await f.service.poll(newer.attemptId, newer.flowToken)).status, 'confirmed');
  assert.equal((await f.service.poll(other.attemptId, other.flowToken)).status, 'confirmed');
});

test('a replaced anonymous creation cannot resurrect from its finally block', async (t) => {
  const f = fixture(t);
  const older = await f.service.start();
  const pending = deferred<Awaited<ReturnType<typeof f.client.createQr>>>();
  f.client.createQr = () => pending.promise;
  const first = f.service.start(older.flowToken);
  const second = f.service.start(older.flowToken);

  pending.resolve({ qrPayload: 'replacement', pollStatus: async () => confirmed });

  await assert.rejects(first, { code: 'cancelled' });
  const latest = await second;
  assert.equal((await f.service.poll(latest.attemptId, latest.flowToken)).status, 'confirmed');
});

for (const action of ['unlink'] as const) {
  for (const owner of ['trusted-owner', 'unrelated-owner']) {
    test(`${action} during anonymous QR creation rejects only the disabled owner: ${owner}`, async (t) => {
      const f = fixture(t);
      await login(f.service);
      const pending = deferred<Awaited<ReturnType<typeof f.client.createQr>>>();
      f.client.createQr = () => pending.promise;
      const starting = f.service.start();
      await f.service[action](credentials.ownerIlinkUserId);
      pending.resolve({ qrPayload: 'late-qr', pollStatus: async () => ({
        status: 'confirmed', credentials: { ...credentials, ownerIlinkUserId: owner },
      }) });

      const attempt = await starting;
      const result = await f.service.poll(attempt.attemptId, attempt.flowToken);

      assert.equal(result.status, owner === 'trusted-owner' ? 'unavailable' : 'confirmed');
      assert.equal(f.store.getBinding(credentials.ownerIlinkUserId), null);
    });
  }
}

test('retains confirmed bindings beyond the pending QR capacity limit', async (t) => {
  const f = fixture(t);
  await login(f.service);
  for (let count = 0; count < 128; count++) {
    f.reply(async () => ({ status: 'confirmed', credentials: { ...credentials, ownerIlinkUserId: `owner-${count}` } }));
    await login(f.service);
  }

  assert.ok(f.store.getBinding(credentials.ownerIlinkUserId));
  assert.equal(f.calls(), 129);
});
