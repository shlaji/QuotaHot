import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { bindings, createInboxHarness, options, type InboxHarness } from './helpers/wechat-inbox-web.js';

let harness: InboxHarness;
before(async () => { if (!options.skip) harness = await createInboxHarness(); });
after(async () => { await harness?.browser.close(); });

for (const width of [390, 1440]) {
  for (const layout of ['list', 'long-document']) {
    test(`QR arrival preserves the visible Cancel viewport position in ${layout} at ${width}px`, options, async (context) => {
      const page = await harness.browser.newPage({ viewport: { width, height: 900 } });
      const pending = Promise.withResolvers<void>();
      context.after(() => { pending.resolve(); return page.close(); });
      await harness.open(page);
      if (layout === 'long-document') await page.evaluate(() => {
        const spacer = document.createElement('div');
        spacer.style.height = '1200px';
        document.body.prepend(spacer);
      });
      await page.route('**/api/wechat/qrcode**', async (route) => {
        if (route.request().method() !== 'POST') return route.fulfill({ json: { status: 'waiting' } });
        await pending.promise;
        return route.fulfill({ json: { attemptId: 'stable', qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"/>', expiresAt: Date.now() + 60_000 } });
      });
      await page.getByRole('button', { name: '添加微信用户', exact: true }).click();
      const cancel = page.getByRole('button', { name: '取消扫码', exact: true });
      await cancel.waitFor();
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const revealed = await cancel.boundingBox();
      assert.ok(revealed && revealed.y >= 0 && revealed.y + revealed.height <= 900);
      await page.locator('.wechat-qr').evaluate((element) => window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top + 40));
      const before = await cancel.boundingBox();
      assert.ok(before && before.y >= 0 && before.y + before.height <= 900);

      pending.resolve();

      await page.getByAltText('微信添加用户二维码').waitFor();
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      assert.deepEqual(await cancel.boundingBox(), before);
      await harness.capture(page, `${width}-${layout}-qr-arrived`);
      context.diagnostic(`QR 视口证据：${harness.evidence}`);
    });
  }
}

for (const status of ['confirmed', 'expired', 'unavailable'] as const) {
  for (const focusTarget of ['qr', 'messages', 'bindings'] as const) {
    test(`QR ${status} preserves its control node and respects ${focusTarget === 'qr' ? 'QR' : focusTarget === 'messages' ? 'other' : 'binding-refresh'} focus on close`, options, async (context) => {
      const page = await harness.browser.newPage({ viewport: { width: 390, height: 900 } });
      const terminal = Promise.withResolvers<void>();
      const refreshing = Promise.withResolvers<void>();
      const refreshed = Promise.withResolvers<void>();
      context.after(() => { terminal.resolve(); refreshed.resolve(); return page.close(); });
      await harness.open(page);
      await page.route('**/api/wechat-inbox/bindings', async (route) => {
        refreshing.resolve();
        await refreshed.promise;
        return route.fulfill({ json: bindings });
      });
      await page.route('**/api/wechat/qrcode**', async (route) => {
        if (route.request().method() === 'POST') return route.fulfill({ json: {
          attemptId: 'terminal', qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"/>', expiresAt: Date.now() + 60_000,
        } });
        if (route.request().method() === 'DELETE') return route.fulfill({ json: { status: 'cancelled' } });
        await terminal.promise;
        return route.fulfill({ json: { status } });
      });
      const add = page.getByRole('button', { name: '添加微信用户', exact: true });
      await add.click();
      const cancel = page.getByRole('button', { name: '取消扫码', exact: true });
      await cancel.focus();
      const original = await cancel.elementHandle();
      assert.ok(original);
      const focused = focusTarget === 'qr' ? cancel : page.getByRole('button', { name: focusTarget === 'messages' ? '刷新消息' : '刷新绑定', exact: true });
      await focused.focus();
      await focused.evaluate((element) => element.addEventListener('blur', () => element.setAttribute('data-focus-lost', 'true')));

      terminal.resolve();

      const close = page.getByRole('button', { name: '关闭扫码提示', exact: true });
      await close.waitFor({ timeout: 5000 });
      if (status === 'confirmed') await refreshing.promise;
      assert.equal(await close.evaluate((element, original) => element === original, original), true);
      const terminalFocus = focusTarget === 'qr' ? close : focused;
      assert.equal(await terminalFocus.evaluate((element) => element === document.activeElement), true);
      assert.equal(await terminalFocus.getAttribute('data-focus-lost'), null);
      await harness.capture(page, `390-${status}-${focusTarget}-focus`);
      if (focusTarget !== 'qr') await close.evaluate((element: HTMLButtonElement) => element.click());
      else await page.keyboard.press('Enter');
      await close.waitFor({ state: 'detached' });
      const expected = focusTarget === 'qr' ? add : focused;
      assert.equal(await expected.evaluate((element) => element === document.activeElement), true);
      refreshed.resolve();
      await page.locator('[aria-labelledby="wechat-inbox-bindings-title"][aria-busy="false"]').waitFor();
      assert.equal(await expected.evaluate((element) => element === document.activeElement), true);
      if (focusTarget !== 'qr') assert.equal(await focused.getAttribute('data-focus-lost'), null);
    });
  }
}
