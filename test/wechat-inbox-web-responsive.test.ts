import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import QRCode from 'qrcode';
import { bindings, createInboxHarness, options, type InboxHarness } from './helpers/wechat-inbox-web.js';
import { waitForInboxMedia } from './helpers/wechat-inbox-media.js';

let harness: InboxHarness;
before(async () => { if (!options.skip) harness = await createInboxHarness(); });
after(async () => { await harness?.browser.close(); });

for (const width of [390, 1440]) {
  test(`keeps a long unbroken ASCII message within the inbox pane at ${width}px`, options, async (context) => {
    const page = await harness.browser.newPage({ viewport: { width, height: 900 },
      isMobile: width === 390, hasTouch: width === 390, deviceScaleFactor: width === 390 ? 3 : 1, reducedMotion: 'reduce' });
    context.after(() => page.close());
    const text = 'x'.repeat(1000);
    await harness.open(page, bindings, { select: false });
    await page.route('**/api/wechat-inbox/**/messages?**', (route) => route.fulfill({ json: {
      items: [{ id: harness.first, kind: 'text', direction: 'inbound', state: 'received', sequence: 1,
        createdAt: '2026-01-01T00:00:00Z', text, items: [] }], nextCursor: null, hasMore: false,
    } }));

    await page.getByRole('button', { name: /测试账号.*正在接收/ }).click();
    await page.getByText(text, { exact: true }).waitFor();
    const pane = page.locator('section[aria-labelledby="wechat-inbox-messages-title"][aria-busy="false"]');
    await pane.waitFor();
    const message = page.getByLabel('已保存的绑定消息').locator(':scope > li');
    assert.equal(await message.count(), 1);
    const documentWidth = await page.evaluate(() => ({ client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth }));
    const paneBounds = await pane.boundingBox();
    const messageBounds = await message.boundingBox();
    assert.ok(paneBounds && messageBounds);
    assert.deepEqual({
      documentFits: documentWidth.scroll <= documentWidth.client,
      messageFits: messageBounds.x >= paneBounds.x && messageBounds.x + messageBounds.width <= paneBounds.x + paneBounds.width,
    }, { documentFits: true, messageFits: true },
    `Long unbroken message overflow at ${width}px: ${JSON.stringify({ documentWidth, paneBounds, messageBounds })}`);
    await harness.captureElement(page, pane, `long-ascii-${width}`);
    context.diagnostic(`Long ASCII screenshot: ${harness.evidence}/long-ascii-${width}.png`);
  });
}

test('captures responsive light and dark inbox evidence without horizontal or unexpected nested scrolling', options, async (context) => {
  const qrSvg = await QRCode.toString('synthetic-responsive-user', { type: 'svg' });
  for (const width of [390, 1440, 1920]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      const browserContext = await harness.browser.newContext({ viewport: { width, height: 900 }, colorScheme,
        isMobile: width === 390, hasTouch: width === 390, deviceScaleFactor: width === 390 ? 3 : 1, reducedMotion: 'reduce' });
      const page = await browserContext.newPage();
      try {
        const requests = await harness.open(page);
        await waitForInboxMedia(page);
        const overflow = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
          nested: [...document.querySelectorAll('.wechat-pane *')].filter((element) => ['auto', 'scroll'].includes(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight).length }));
        assert.ok(overflow.scroll <= overflow.width, JSON.stringify(overflow));
        assert.equal(overflow.nested, 0);
        await harness.capture(page, `${width}-${colorScheme}-top`);
        await harness.captureElement(page, page.locator('.wechat-inbox'), `${width}-${colorScheme}-inbox`);
        const history = page.getByLabel('消息历史，向上滚动加载更早消息');
        await history.locator('video').last().scrollIntoViewIfNeeded();
        const video = history.locator('video').last();
        assert.equal(await video.count(), 1);
        const videoBox = await video.boundingBox();
        assert.ok(videoBox);
        assert.ok(videoBox.y >= 0 && videoBox.y + videoBox.height <= 900,
          `video controls must remain visible at ${width}px ${colorScheme}: ${JSON.stringify(videoBox)}`);
        await harness.capture(page, `${width}-${colorScheme}-history-bottom`);
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await harness.capture(page, `${width}-${colorScheme}-end`);
        await page.route('**/api/wechat-inbox/bindings', (route) => route.fulfill({ json: bindings.map((binding, index) =>
          ({ ...binding, replyContextState: index === 0 ? 'waiting_for_inbound' : 'ready' })) }));
        await page.getByRole('button', { name: '刷新绑定', exact: true }).click();
        await page.getByRole('status').filter({ hasText: '请让当前绑定用户' }).waitFor();
        assert.equal(await page.getByLabel('消息正文').isDisabled(), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
        await harness.captureElement(page, page.locator('.wechat-inbox'), `${width}-${colorScheme}-waiting-inbox`);
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await harness.capture(page, `${width}-${colorScheme}-waiting-end`);
        for (const name of ['发送文本', '开始输入状态', '取消输入状态']) assert.equal(await page.getByRole('button', { name, exact: true }).isDisabled(), true);
        assert.equal(await page.getByRole('button', { name: '刷新消息', exact: true }).isEnabled(), true);
        await page.getByRole('button', { name: '刷新消息', exact: true }).click();
        await page.getByText('<script>上游内容只能作为文本显示</script>', { exact: true }).waitFor();
        await page.getByRole('button', { name: /另一绑定.*正在接收/ }).click();
        await page.getByLabel('消息正文').fill('独立上下文草稿');
        await waitForInboxMedia(page);
        assert.equal(await page.getByRole('button', { name: '发送文本', exact: true }).isEnabled(), true);
        assert.equal(await page.getByRole('button', { name: '开始输入状态' }).isEnabled(), true);
        assert.equal(await page.getByRole('status').filter({ hasText: '请让当前绑定用户' }).count(), 0);
        assert.equal(requests.some((request) => request.startsWith('POST')), false);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
        await harness.captureElement(page, page.locator('.wechat-inbox'), `${width}-${colorScheme}-ready-sibling-inbox`);
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await harness.capture(page, `${width}-${colorScheme}-ready-sibling-end`);
        await page.getByRole('button', { name: /连续中文长名称.*只读/ }).click();
        await page.getByLabel('消息正文').waitFor();
        await page.locator('section[aria-labelledby="wechat-inbox-messages-title"][aria-busy="false"]').waitFor();
        await waitForInboxMedia(page);
        for (const name of ['发送文本', '开始输入状态', '取消输入状态']) {
          assert.equal(await page.getByRole('button', { name, exact: true }).isDisabled(), true);
        }
        assert.equal(await page.getByLabel('消息正文').isDisabled(), true);
        assert.equal(await page.getByRole('button', { name: /连续中文长名称.*只读/ }).count(), 1);
        await harness.captureElement(page, page.locator('.wechat-inbox'), `${width}-${colorScheme}-long-readonly-inbox`);
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await harness.capture(page, `${width}-${colorScheme}-long-readonly-end`);
        const response = Promise.withResolvers<void>();
        await page.route('**/api/wechat/qrcode**', async (route) => {
          if (route.request().method() === 'POST') {
            await response.promise;
            return route.fulfill({ json: { attemptId: 'responsive', qrSvg, expiresAt: Date.now() + 60_000 } });
          }
          return route.fulfill({ json: { status: route.request().method() === 'DELETE' ? 'cancelled' : 'waiting' } });
        });
        await page.getByRole('button', { name: '添加微信用户', exact: true }).click();
        await page.getByText('正在生成二维码…', { exact: true }).waitFor();
        await harness.capture(page, `${width}-${colorScheme}-qr-loading`);
        response.resolve();
        await page.getByAltText('微信添加用户二维码', { exact: true }).waitFor();
        await harness.capture(page, `${width}-${colorScheme}-qr-active`);
        await page.getByRole('button', { name: '取消扫码', exact: true }).click();
        assert.equal(await page.getByRole('button', { name: '添加微信用户', exact: true }).isEnabled(), true);
      } finally { await browserContext.close(); }
    }
  }
  context.diagnostic(`Fresh inbox screenshots: ${harness.evidence}`);
});
