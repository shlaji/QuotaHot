import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Readable } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { HttpResponse } from '../src/server/http.js';
import { WechatClawbotClient } from '../src/server/wechat-clawbot-client.js';
import { WechatLoginService, type WechatLoginOptions } from '../src/server/wechat-login-service.js';
import { WechatSessionStore, type ConfirmedWechatBinding, type WechatBinding } from '../src/server/wechat-session-store.js';
import { WechatInboxService } from '../src/server/wechat-inbox/service.js';
import { WechatInboxStore } from '../src/server/wechat-inbox/store.js';
import { input } from './helpers/wechat-inbox-store.js';

const origin = Date.parse('2026-10-20T12:00:00Z');

function credentials(owner: string, revision = 0): ConfirmedWechatBinding {
  return { ownerIlinkUserId: owner, botId: `${owner}-bot-${revision}`,
    botToken: `${owner}-token-${revision}`, baseUrl: `https://${owner}-${revision}.invalid/` };
}

function response(value: unknown): HttpResponse {
  return new HttpResponse(200, new Headers(), Readable.from([JSON.stringify(value)]));
}

function confirmation(binding: ConfirmedWechatBinding) {
  return { ret: 0, status: 'confirmed', ilink_user_id: binding.ownerIlinkUserId,
    ilink_bot_id: binding.botId, bot_token: binding.botToken, baseurl: binding.baseUrl };
}

function fixture(t: TestContext, hooks: WechatLoginOptions = {}) {
  const sessions = new WechatSessionStore(':memory:');
  const store = new WechatInboxStore(':memory:');
  let now = origin;
  let sequence = 0;
  const upstream = new Map<string, ReturnType<typeof Promise.withResolvers<HttpResponse>>>();
  const inbox = new WechatInboxService(sessions, store, { now: () => now });
  const client = new WechatClawbotClient(async (_url, options) => {
    if (options?.method === 'GET') {
      const qrcode = `qr-${upstream.size}`;
      upstream.set(qrcode, Promise.withResolvers<HttpResponse>());
      return response({ ret: 0, qrcode,
        qrcode_img_content: `https://liteapp.weixin.qq.com/q/test?qrcode=${qrcode}&bot_type=3` });
    }
    assert.equal(typeof options?.body, 'string');
    const qrcode = new URLSearchParams(String(options?.body)).get('qrcode');
    assert.ok(qrcode);
    const pending = upstream.get(qrcode);
    assert.ok(pending);
    return pending.promise;
  });
  const login = new WechatLoginService(sessions, client, {
    ...hooks, now: () => now, randomBytes: (size) => {
      const bytes = Buffer.alloc(size);
      bytes.writeUInt32BE(++sequence);
      return bytes;
    },
    afterBindingChange: (owner) => { inbox.activateBinding(owner); hooks.afterBindingChange?.(owner); },
  });
  t.after(async () => { await login.shutdown(); store.close(); sessions.close(); });
  async function start() {
    const attempt = await login.start();
    const qrcode = new URL(attempt.qrPayload).searchParams.get('qrcode');
    assert.ok(qrcode);
    const pending = upstream.get(qrcode);
    assert.ok(pending);
    return { ...attempt, resolve: (value: unknown) => pending.resolve(response(value)) };
  }
  async function authorize(binding: ConfirmedWechatBinding) {
    const attempt = await start();
    attempt.resolve(confirmation(binding));
    const result = await login.poll(attempt.attemptId, attempt.flowToken);
    assert.ok(result.status === 'confirmed');
    return binding.ownerIlinkUserId;
  }
  return { sessions, store, inbox, login, start, authorize, time: (value: number) => { now = value; } };
}

test('keeps ten distinct QR identities with isolated complete credentials and inbox bindings', async (t) => {
  const f = fixture(t);
  const bindings = Array.from({ length: 10 }, (_, index) => credentials(`owner-${index}`));
  const tokens: string[] = [];

  for (const [index, binding] of bindings.entries()) {
    f.time(origin + index);
    tokens.push(await f.authorize(binding));
  }

  assert.deepEqual(f.sessions.listBindings(), bindings.map((binding, index) =>
    ({ ...binding, createdAt: origin + index, updatedAt: origin + index })));
  assert.deepEqual(f.inbox.listBindings().map(({ ownerIlinkUserId, botId }) => ({ ownerIlinkUserId, botId })),
    bindings.map(({ ownerIlinkUserId, botId }) => ({ ownerIlinkUserId, botId })));
  for (const [index, token] of tokens.entries()) {
    assert.equal(token, `owner-${index}`);
  }
});

test('keeps one binding and prior inbox history through ten same-owner QR reauthorizations', async (t) => {
  const f = fixture(t);
  const owner = 'repeated-owner';
  await f.authorize(credentials(owner));
  f.store.saveBatch(owner, { nextCursor: 'retained-cursor', messages: [input('retained-message')] });
  const history = f.inbox.listMessages(owner);

  for (let revision = 1; revision <= 10; revision++) {
    f.time(origin + revision * 1000);
    await f.authorize(credentials(owner, revision));
    assert.deepEqual(f.sessions.listBindings(), [{ ...credentials(owner, revision),
      createdAt: origin, updatedAt: origin + revision * 1000 }]);
    assert.deepEqual(f.store.listBindings(), [{ ownerIlinkUserId: owner, botId: `${owner}-bot-${revision}`,
      createdAt: new Date(origin).toISOString(), updatedAt: new Date(origin + revision * 1000).toISOString(), unlinkedAt: null }]);
    assert.deepEqual(f.inbox.listMessages(owner), history);
    assert.equal(f.store.getCursor(owner), 'retained-cursor');
  }
});

for (const firstConfirmed of [0, 1]) {
  test(`serializes independent same-owner QR confirmations without mixed credentials, first=${firstConfirmed}`, { timeout: 2000 }, async (t) => {
    const owner = 'concurrent-owner';
    const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const observed: WechatBinding[] = [];
    let hold = false;
    let drains = 0;
    const f = fixture(t, {
      beforeBindingChange: async (changingOwner) => {
        if (!hold || changingOwner !== owner) return;
        const index = drains++;
        entered[index].resolve();
        await release[index].promise;
      },
      afterBindingChange: (changingOwner) => {
        if (!hold || changingOwner !== owner) return;
        const binding = f.sessions.getBinding(changingOwner);
        assert.ok(binding);
        observed.push(binding);
      },
    });
    await f.authorize(credentials(owner));
    await f.authorize(credentials('other-owner'));
    const otherBinding = f.sessions.getBinding('other-owner');
    const otherInbox = f.store.getBinding('other-owner');
    const attempts = [await f.start(), await f.start()];
    assert.notEqual(attempts[0].attemptId, attempts[1].attemptId);
    assert.notEqual(attempts[0].flowToken, attempts[1].flowToken);
    assert.notEqual(attempts[0].qrPayload, attempts[1].qrPayload);
    const tuples = [credentials(owner, 1), credentials(owner, 2)];
    const nextConfirmed = 1 - firstConfirmed;
    hold = true;

    const polls = attempts.map((attempt) => f.login.poll(attempt.attemptId, attempt.flowToken));
    attempts[firstConfirmed].resolve(confirmation(tuples[firstConfirmed]));
    await entered[0].promise;
    attempts[nextConfirmed].resolve(confirmation(tuples[nextConfirmed]));
    await nextTurn();
    assert.equal(drains, 1);
    assert.deepEqual(f.sessions.getBinding(owner), { ...credentials(owner), createdAt: origin, updatedAt: origin });
    f.time(origin + 1000);
    release[0].resolve();
    await entered[1].promise;
    assert.deepEqual(observed, [{ ...tuples[firstConfirmed], createdAt: origin, updatedAt: origin + 1000 }]);
    assert.deepEqual(f.sessions.getBinding(owner), observed[0]);
    f.time(origin + 2000);
    release[1].resolve();
    const results = await Promise.all(polls);

    assert.deepEqual(results.map((result) => result.status), ['confirmed', 'confirmed']);
    assert.deepEqual(observed, [
      { ...tuples[firstConfirmed], createdAt: origin, updatedAt: origin + 1000 },
      { ...tuples[nextConfirmed], createdAt: origin, updatedAt: origin + 2000 },
    ]);
    assert.deepEqual(f.sessions.getBinding(owner), observed[1]);
    assert.equal(f.sessions.listBindings().filter((binding) => binding.ownerIlinkUserId === owner).length, 1);
    assert.equal(f.inbox.listBindings().filter((binding) => binding.ownerIlinkUserId === owner).length, 1);
    assert.equal(f.store.getBinding(owner)?.botId, tuples[nextConfirmed].botId);
    assert.deepEqual(f.sessions.getBinding('other-owner'), otherBinding);
    assert.deepEqual(f.store.getBinding('other-owner'), otherInbox);
    for (const result of results) {
      assert.ok(result.status === 'confirmed');
      assert.deepEqual(result, { status: 'confirmed' });
    }
  });
}

for (const identity of [undefined, null, '', ' \t\n']) {
  for (const existing of [false, true]) {
    test(`rejects real QR confirmation without binding mutation for identity=${JSON.stringify(identity)}, existing=${existing}`, async (t) => {
      const f = fixture(t);
      await f.authorize(credentials('other-owner'));
      if (existing) await f.authorize(credentials('target-owner'));
      const bindings = f.sessions.listBindings();
      const inboxBindings = f.store.listBindings();
      const attempt = await f.start();
      f.time(origin + 1000);
      attempt.resolve({ ...confirmation(credentials('target-owner', 99)), ilink_user_id: identity });

      const result = await f.login.poll(attempt.attemptId, attempt.flowToken);

      assert.deepEqual(result, { status: 'identity_missing' });
      assert.deepEqual(f.sessions.listBindings(), bindings);
      assert.deepEqual(f.store.listBindings(), inboxBindings);
      assert.deepEqual(await f.login.poll(attempt.attemptId, attempt.flowToken), { status: 'unavailable' });
    });
  }
}
