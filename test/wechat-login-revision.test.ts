import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { WechatLoginService } from '../src/server/wechat-login-service.js';
import { WechatSessionStore, type ConfirmedWechatBinding } from '../src/server/wechat-session-store.js';

const credentials = { ownerIlinkUserId: 'owner', botId: 'bot', botToken: 'prior', baseUrl: 'https://example.invalid/' };

test('exposes no retained QR binding check methods', () => {
  assert.equal('getBindingStatus' in WechatLoginService.prototype, false);
  assert.equal('recheckAfterChatError' in WechatLoginService.prototype, false);
});

for (const mutation of ['none', 'replacement', 'same-credentials', 'pause', 'remove'] as const) {
  test(`failed QR persistence restores the drained worker only without a newer ${mutation} mutation`, async (t) => {
    const store = new WechatSessionStore(':memory:');
    t.after(() => store.close());
    store.confirmBinding(credentials, 0);
    const starts: string[] = [];
    let worker: string | null = credentials.botToken;
    const failure = new Error('confirmation persistence failed');
    const service = new WechatLoginService(store, { createQr: async () => ({
      qrPayload: 'qr', pollStatus: async () => ({ status: 'confirmed', credentials: { ...credentials, botToken: 'failed' } }),
    }) }, {
      beforeBindingChange: async () => {
        worker = null;
        switch (mutation) {
          case 'none': break;
          case 'replacement': store.confirmBinding({ ...credentials, botToken: 'newer' }, 0); break;
          case 'same-credentials': store.confirmBinding(credentials, 0); break;
          case 'pause': store.pauseBinding(credentials.ownerIlinkUserId); break;
          case 'remove': store.removeBinding(credentials.ownerIlinkUserId); break;
        }
      },
      afterBindingChange: (owner) => {
        const binding = store.getBinding(owner);
        assert.ok(binding);
        worker = binding.botToken;
        starts.push(binding.botToken);
      },
    });
    const attempt = await service.start();
    const confirm = store.confirmBinding.bind(store);
    t.mock.method(store, 'confirmBinding', (binding: ConfirmedWechatBinding, now: number) => {
      if (binding.botToken === 'failed') throw failure;
      return confirm(binding, now);
    });

    await assert.rejects(service.poll(attempt.attemptId, attempt.flowToken), (error: unknown) => error === failure);

    assert.deepEqual(starts, mutation === 'none' ? [credentials.botToken] : []);
    assert.equal(worker, mutation === 'none' ? credentials.botToken : null);
  });
}

for (const botToken of ['newer', credentials.botToken]) {
  test(`failed replacement cannot restore over a queued QR confirmation with token ${botToken}`, async (t) => {
    const store = new WechatSessionStore(':memory:');
    t.after(() => store.close());
    store.confirmBinding(credentials, 0);
    const entered = Promise.withResolvers<void>();
    const drained = Promise.withResolvers<void>();
    const starts: string[] = [];
    let nextToken = 'failed';
    let drains = 0;
    const service = new WechatLoginService(store, { createQr: async () => {
      const binding = { ...credentials, botToken: nextToken };
      return { qrPayload: 'qr', pollStatus: async () => ({ status: 'confirmed', credentials: binding }) };
    } }, {
      beforeBindingChange: async () => {
        if (++drains === 1) { entered.resolve(); await drained.promise; }
      },
      afterBindingChange: (owner) => {
        const binding = store.getBinding(owner);
        assert.ok(binding);
        starts.push(binding.botToken);
      },
    });
    const confirm = store.confirmBinding.bind(store);
    t.mock.method(store, 'confirmBinding', (binding: ConfirmedWechatBinding, now: number) => {
      if (binding.botToken === 'failed') throw new Error('persistence failed');
      confirm(binding, now);
    });
    const first = await service.start();
    const failed = assert.rejects(service.poll(first.attemptId, first.flowToken), /persistence failed/);
    await entered.promise;
    nextToken = botToken;
    const latest = await service.start();
    const confirming = service.poll(latest.attemptId, latest.flowToken);
    await nextTurn();
    drained.resolve();

    await failed;
    assert.deepEqual(await confirming, { status: 'confirmed' });

    assert.deepEqual(starts, [botToken]);
  });
}
