import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import QRCode from 'qrcode';
import { bindings, createInboxHarness, options, type InboxHarness } from './helpers/wechat-inbox-web.js';

let harness: InboxHarness;
before(async () => { if (!options.skip) harness = await createInboxHarness(); });
after(async () => { await harness?.browser.close(); });

test('unlink displays visible progress only in the pending binding row', options, async (context) => {
  const page = await harness.browser.newPage();
  const pending = Promise.withResolvers<void>();
  context.after(() => { pending.resolve(); return page.close(); });
  await harness.open(page);
  await page.route('**/api/wechat/bindings/**', async (route) => {
    await pending.promise;
    return route.fulfill({ json: { status: 'unlinked' } });
  });
  const rows = page.getByRole('list', { name: '绑定用户', exact: true }).locator('li');
  await rows.nth(0).getByRole('button', { name: '解除本地绑定', exact: true }).click();

  await rows.nth(0).getByRole('button', { name: '确认解除', exact: true }).click();

  await rows.nth(0).locator('[aria-busy="true"]').waitFor();
  assert.equal(await rows.nth(0).getByRole('status').filter({ hasText: '正在解除本地绑定' }).isVisible(), true);
  assert.equal(await rows.nth(1).getByRole('status').filter({ hasText: '正在解除本地绑定' }).count(), 0);
  assert.equal(await rows.nth(1).getByRole('button', { name: '解除本地绑定', exact: true }).isEnabled(), true);
});

test('QR payload arrival keeps the Cancel target in its loading position', options, async (context) => {
  const qrSvg = await QRCode.toString('synthetic-stable-qr', { type: 'svg' });
  for (const width of [390, 1440]) {
    const page = await harness.browser.newPage({ viewport: { width, height: 900 } });
    const pending = Promise.withResolvers<void>();
    context.after(() => { pending.resolve(); return page.close(); });
    await harness.open(page);
    await page.route('**/api/wechat/qrcode**', async (route) => {
      if (route.request().method() !== 'POST') return route.fulfill({ json: { status: 'waiting' } });
      await pending.promise;
      return route.fulfill({ json: { attemptId: 'stable', qrSvg, expiresAt: Date.now() + 60_000 } });
    });
    await page.getByRole('button', { name: '添加微信用户', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '正在生成二维码' }).waitFor();
    const cancel = page.getByRole('button', { name: '取消扫码', exact: true });
    assert.equal(await cancel.isEnabled(), true);
    const before = await cancel.boundingBox();
    assert.ok(before);

    pending.resolve();

    await page.getByAltText('微信添加用户二维码', { exact: true }).waitFor();
    assert.deepEqual(await cancel.boundingBox(), before, `Cancel moved at ${width}px`);
    await page.close();
  }
});

test('keyboard QR cancellation restores focus to the enabled add trigger', options, async (context) => {
  const page = await harness.browser.newPage();
  context.after(() => page.close());
  await harness.open(page);
  const qrSvg = await QRCode.toString('synthetic-focus-qr', { type: 'svg' });
  await page.route('**/api/wechat/qrcode**', (route) => route.fulfill({ json: route.request().method() === 'POST'
    ? { attemptId: 'focus', qrSvg, expiresAt: Date.now() + 60_000 } : { status: 'cancelled' } }));
  const add = page.getByRole('button', { name: '添加微信用户', exact: true });
  await add.click();
  await page.getByAltText('微信添加用户二维码', { exact: true }).waitFor();
  await page.getByRole('button', { name: '取消扫码', exact: true }).focus();

  await page.keyboard.press('Enter');

  await page.getByRole('button', { name: '取消扫码', exact: true }).waitFor({ state: 'detached' });
  assert.equal(await add.isEnabled(), true);
  assert.equal(await add.evaluate((element) => document.activeElement === element), true);
});

test('list QR loading and cancellation preserve selection and only use the short flow cookie', options, async (context) => {
  const page = await harness.browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  const response = Promise.withResolvers<void>();
  context.after(() => { response.resolve(); return page.close(); });
  await harness.open(page);
  const selected = page.getByRole('button', { name: /另一绑定.*另一机器人/ });
  await selected.click();
  const qrSvg = await QRCode.toString('synthetic-wechat-payload', { type: 'svg' });
  assert.match(qrSvg, /<path/);
  const list = page.getByRole('region', { name: '绑定用户', exact: true });
  const action = list.locator('header').getByRole('button', { name: '添加微信用户', exact: true });
  assert.equal(await page.getByRole('region', { name: '微信连接', exact: true }).count(), 0);
  const requests: string[] = [];
  await page.route('**/api/wechat/qrcode**', async (route) => {
    const method = route.request().method();
    const path = new URL(route.request().url()).pathname;
    requests.push(`${method} ${path}`);
    if (method === 'POST' && path === '/api/wechat/qrcode') {
      await response.promise;
      return route.fulfill({ headers: { 'set-cookie': 'quotahot_wechat_flow=synthetic-flow; HttpOnly; SameSite=Strict; Path=/api/wechat; Max-Age=600' },
        json: { attemptId: 'add-user', qrSvg, expiresAt: Date.now() + 60_000 } });
    }
    assert.match(route.request().headers().cookie ?? '', /quotahot_wechat_flow=synthetic-flow/);
    return route.fulfill({ json: { status: method === 'DELETE' ? 'cancelled' : 'waiting' } });
  });

  await action.click();

  const loading = list.getByRole('status').filter({ hasText: '正在生成二维码' });
  await loading.waitFor();
  const loadingBox = await loading.boundingBox();
  assert.ok(loadingBox && loadingBox.y >= 0 && loadingBox.y < 844);
  await page.screenshot({ path: `${harness.evidence}/binding-list-qr-loading-mobile.png` });
  assert.equal(await action.isDisabled(), true);
  await action.evaluate((button: HTMLButtonElement) => button.click());
  assert.equal(await selected.getAttribute('aria-current'), 'true');
  response.resolve();
  const image = list.getByAltText('微信添加用户二维码', { exact: true });
  await image.waitFor();
  const box = await image.boundingBox();
  assert.ok(box && box.y >= 0 && box.y + box.height <= 844);
  await page.screenshot({ path: `${harness.evidence}/binding-list-qr-active-mobile.png` });
  assert.equal(await list.locator('.wechat-qr').count(), 1);
  assert.equal(await action.isDisabled(), true);
  await action.evaluate((button: HTMLButtonElement) => button.click());
  const cancellation = page.waitForResponse((result) => result.url().endsWith('/api/wechat/qrcode/add-user') && result.request().method() === 'DELETE');
  await list.getByRole('button', { name: '取消扫码', exact: true }).click();
  await cancellation;
  await image.waitFor({ state: 'detached' });
  assert.equal(await action.isEnabled(), true);
  assert.equal(await selected.getAttribute('aria-current'), 'true');
  assert.equal(requests.filter((request) => request === 'POST /api/wechat/qrcode').length, 1);
  assert.equal(requests.filter((request) => request === 'DELETE /api/wechat/qrcode/add-user').length, 1);
  assert.deepEqual((await page.context().cookies()).map((cookie) => cookie.name), ['quotahot_wechat_flow']);
  context.diagnostic(`Fresh binding screenshots: ${harness.evidence}`);
});

test('row confirmation locks its binding, cancellation restores focus, and unlink preserves history and drafts', options, async (context) => {
  const page = await harness.browser.newPage({ viewport: { width: 390, height: 844 } });
  context.after(() => page.close());
  const summaries = bindings.map((binding) => ({ ...binding }));
  await harness.open(page, summaries);
  assert.equal(await page.getByRole('button', { name: /核验/ }).count(), 0);
  const checks: string[] = [];
  page.on('request', (request) => { if (new URL(request.url()).pathname.endsWith('/check')) checks.push(request.url()); });
  const mutations: string[] = [];
  await page.route('**/api/wechat/bindings/**', (route) => {
    mutations.push(`${route.request().method()} ${decodeURIComponent(new URL(route.request().url()).pathname)}`);
    summaries[0].connectionState = 'unlinked';
    summaries[0].canSend = false;
    return route.fulfill({ json: { status: 'unlinked' } });
  });
  const row = page.getByRole('list', { name: '绑定用户', exact: true }).locator('li').first();
  const trigger = row.getByRole('button', { name: '解除本地绑定', exact: true });
  await page.getByLabel('消息正文').fill('保留草稿');
  await trigger.click();
  await page.screenshot({ path: `${harness.evidence}/row-confirm-mobile.png` });
  await page.keyboard.press('Escape');
  assert.equal(await trigger.evaluate((element) => document.activeElement === element), true);
  assert.deepEqual(mutations, []);
  await trigger.click();
  await page.getByRole('button', { name: /另一绑定.*另一机器人/ }).click();
  await row.getByRole('button', { name: '确认解除', exact: true }).click();
  await row.getByRole('status').filter({ hasText: '已解除本地绑定' }).waitFor();
  assert.deepEqual(mutations, ['DELETE /api/wechat/bindings/测试账号']);
  await page.getByRole('button', { name: /测试账号.*本地机器人/ }).click();
  assert.equal(await page.getByLabel('消息正文').inputValue(), '保留草稿');
  assert.equal(await page.getByLabel('消息正文').isDisabled(), true);
  await page.getByText('<script>上游内容只能作为文本显示</script>', { exact: true }).waitFor();
  assert.equal(await page.locator('button button').count(), 0);
  assert.deepEqual(checks, []);
});

test('page inactivity cancels the QR flow and restores the add action on return', options, async (context) => {
  const page = await harness.browser.newPage();
  context.after(() => page.close());
  await harness.open(page);
  const qrSvg = await QRCode.toString('synthetic-inactive-owner', { type: 'svg' });
  await page.route('**/api/wechat/qrcode**', (route) => route.fulfill({ json: route.request().method() === 'POST'
    ? { attemptId: 'inactive', qrSvg, expiresAt: Date.now() + 60_000 } : { status: 'cancelled' } }));
  await page.getByRole('button', { name: '添加微信用户', exact: true }).click();
  await page.getByAltText('微信添加用户二维码', { exact: true }).waitFor();
  const cancellation = page.waitForRequest((request) => request.url().endsWith('/qrcode/inactive') && request.method() === 'DELETE');
  const refresh = page.getByRole('button', { name: '刷新绑定', exact: true });
  await refresh.focus();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('wechat-active', { detail: false })));
  await cancellation;
  await page.getByAltText('微信添加用户二维码', { exact: true }).waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('button', { name: '添加微信用户', exact: true }).isDisabled(), true);
  assert.equal(await refresh.evaluate((element) => document.activeElement === element), true);
  await page.evaluate(() => {
    const tab = document.createElement('button');
    tab.textContent = '其他页面';
    document.body.prepend(tab);
    tab.focus();
  });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('wechat-active', { detail: true })));
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find((button) => button.textContent === '添加微信用户')?.disabled);
  assert.equal(await page.getByRole('button', { name: '其他页面', exact: true }).evaluate((element) => document.activeElement === element), true);
  assert.equal(await page.getByRole('button', { name: /测试账号.*正在接收/ }).getAttribute('aria-current'), 'true');
});

test('confirmed list QR refreshes bindings without remounting selected history or composer', options, async (context) => {
  const page = await harness.browser.newPage();
  context.after(() => page.close());
  const requests = await harness.open(page);
  const qrSvg = await QRCode.toString('synthetic-confirmed-owner', { type: 'svg' });
  const confirmed = Promise.withResolvers<void>();
  context.after(() => confirmed.resolve());
  await page.route('**/api/wechat/qrcode**', async (route) => {
    if (route.request().method() === 'POST') return route.fulfill({ json: { attemptId: 'confirmed-owner', qrSvg, expiresAt: Date.now() + 60_000 } });
    await confirmed.promise;
    return route.fulfill({ json: { status: 'confirmed' } });
  });
  await page.getByLabel('消息正文').fill('扫码前的草稿');
  const history = page.getByLabel('消息历史，向上滚动加载更早消息');
  await history.evaluate((element) => { element.setAttribute('data-preserved', 'yes'); });
  const beforeCount = requests.filter((path) => path.endsWith('/bindings')).length;
  await page.getByRole('button', { name: '添加微信用户', exact: true }).click();
  await page.getByAltText('微信添加用户二维码', { exact: true }).waitFor();
  await history.evaluate((element) => { element.scrollTop = 500; });
  const historyScroll = await history.evaluate((element) => element.scrollTop);
  assert.ok(historyScroll > 0);
  confirmed.resolve();
  await page.getByText('扫码已确认', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-labelledby="wechat-inbox-bindings-title"]')?.getAttribute('aria-busy') === 'false');
  assert.ok(requests.filter((path) => path.endsWith('/bindings')).length > beforeCount);
  assert.equal(await page.getByLabel('消息正文').inputValue(), '扫码前的草稿');
  assert.equal(await history.getAttribute('data-preserved'), 'yes');
  assert.equal(await history.evaluate((element) => getComputedStyle(element).overflowY), 'auto');
  assert.equal(await history.evaluate((element) => element.scrollTop), historyScroll);
  assert.equal(await page.getByRole('button', { name: /测试账号.*正在接收/ }).getAttribute('aria-current'), 'true');
});

test('row unlinks stay independently busy and safe errors remain beside their target', options, async (context) => {
  const page = await harness.browser.newPage({ viewport: { width: 390, height: 844 } });
  const pending = Promise.withResolvers<void>();
  context.after(() => { pending.resolve(); return page.close(); });
  await harness.open(page);
  const requests: string[] = [];
  await page.route('**/api/wechat/bindings/**', async (route) => {
    requests.push(`${route.request().method()} ${decodeURIComponent(new URL(route.request().url()).pathname)}`);
    if (decodeURIComponent(route.request().url()).includes('测试账号')) {
      await pending.promise;
      return route.fulfill({ status: 503, json: { error: 'private-upstream-detail' } });
    }
    return route.fulfill({ json: { status: 'unlinked' } });
  });
  const rows = page.getByRole('list', { name: '绑定用户', exact: true }).locator('li');
  await rows.nth(0).getByRole('button', { name: '解除本地绑定', exact: true }).click();
  await rows.nth(0).getByRole('button', { name: '确认解除', exact: true }).click();
  await rows.nth(0).locator('[aria-busy="true"]').waitFor();
  assert.equal(await rows.nth(0).getByRole('button', { name: '解除本地绑定', exact: true }).isDisabled(), true);
  await rows.nth(1).getByRole('button', { name: '解除本地绑定', exact: true }).click();
  await rows.nth(1).getByRole('button', { name: '确认解除', exact: true }).click();
  await rows.nth(1).getByRole('status').filter({ hasText: '已解除本地绑定' }).waitFor();
  pending.resolve();
  await rows.nth(0).getByRole('alert').waitFor();
  assert.doesNotMatch(await rows.nth(0).innerText(), /private-upstream-detail/);
  assert.equal(await rows.nth(0).getByRole('button', { name: '解除本地绑定', exact: true }).isEnabled(), true);
  assert.deepEqual(requests, ['DELETE /api/wechat/bindings/测试账号', 'DELETE /api/wechat/bindings/另一绑定']);
  await page.screenshot({ path: `${harness.evidence}/row-unlink-error-mobile.png` });
});
