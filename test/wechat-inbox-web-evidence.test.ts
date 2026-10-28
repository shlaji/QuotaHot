import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { bindings, createInboxHarness, options, type InboxHarness } from './helpers/wechat-inbox-web.js';
import { waitForInboxMedia } from './helpers/wechat-inbox-media.js';
import { attachmentIds, mediaFixture } from './helpers/wechat-inbox-media.js';

let harness: InboxHarness;
before(async () => { if (!options.skip) harness = await createInboxHarness(); });
after(async () => { await harness?.browser.close(); });

for (const kind of ['image', 'video'] as const) {
  for (const width of [390, 1440]) {
    test(`delayed ${kind} decoding preserves the next message position at ${width}px`, options, async (context) => {
      const page = await harness.browser.newPage({ viewport: { width, height: 900 } });
      const pending = Promise.withResolvers<void>();
      const requested = Promise.withResolvers<void>();
      context.after(() => { pending.resolve(); return page.close(); });
      await harness.open(page, bindings, { select: false });
      await page.route('**/messages**', (route) => route.fulfill({ json: { items: [
        { id: '11111111-1111-4111-8111-111111111111', sequence: 1, direction: 'inbound', kind, state: 'received',
          createdAt: '2026-01-01T00:00:00Z', text: '', items: [{ kind, attachmentId: attachmentIds[kind] }] },
        { id: '22222222-2222-4222-8222-222222222222', sequence: 2, direction: 'inbound', kind: 'text', state: 'received',
          createdAt: '2026-01-01T00:00:00Z', text: '媒体后的消息', items: [] },
      ], nextCursor: null, hasMore: false } }));
      await page.route('**/attachments/**', async (route) => {
        requested.resolve();
        await pending.promise;
        return route.fulfill(mediaFixture(attachmentIds[kind]));
      });
      await page.getByRole('button', { name: /测试账号.*正在接收/ }).click();
      const media = page.locator(`.wechat-media ${kind === 'image' ? 'img' : 'video'}`);
      await media.evaluate((element) => {
        if (element instanceof HTMLImageElement) element.loading = 'eager';
        if (element instanceof HTMLVideoElement) { element.preload = 'auto'; element.load(); }
      });
      await requested.promise;
      const next = page.getByText('媒体后的消息', { exact: true });
      const before = await next.evaluate((element) => element.getBoundingClientRect().y + window.scrollY);

      pending.resolve();
      await waitForInboxMedia(page);

      assert.equal(await next.evaluate((element) => element.getBoundingClientRect().y + window.scrollY), before);
      assert.equal(await media.evaluate((element) => getComputedStyle(element).objectFit), 'contain');
      await media.scrollIntoViewIfNeeded();
      await harness.capture(page, `${width}-${kind}-decoded-stable`);
      context.diagnostic(`延迟媒体证据：${harness.evidence}`);
    });
  }
}

test('decodes every image and native media attachment before capturing evidence', options, async (context) => {
  const page = await harness.browser.newPage();
  context.after(() => page.close());
  await harness.open(page);

  const media = await page.locator('audio, video').evaluateAll(async (elements) => Promise.all(elements.map((element) => {
    if (!(element instanceof HTMLMediaElement)) throw new Error('Expected native media');
    return new Promise<boolean>((resolve) => {
      element.addEventListener('loadeddata', () => resolve(true), { once: true });
      element.addEventListener('error', () => resolve(false), { once: true });
      element.preload = 'auto';
      element.load();
    });
  })));

  assert.deepEqual(media, [true, true, true]);
  await waitForInboxMedia(page);
  assert.ok(await page.locator('video').first().evaluate((element: HTMLVideoElement) => Number.isFinite(element.duration) && element.duration > 0));
  assert.ok(await page.locator('video').first().evaluate(async (element: HTMLVideoElement) => {
    element.muted = true;
    await element.play();
    const playing = !element.paused;
    element.pause();
    return playing;
  }));
});

for (const scenario of ['empty-bindings', 'no-selection', 'empty-history'] as const) {
  test(`captures ${scenario} as a distinct accessible state`, options, async (context) => {
    for (const width of [390, 1440]) {
      for (const colorScheme of ['light', 'dark'] as const) {
        const page = await harness.browser.newPage({ viewport: { width, height: 900 }, colorScheme,
          isMobile: width === 390, hasTouch: width === 390, deviceScaleFactor: width === 390 ? 3 : 1 });
        context.after(() => page.close());
        if (scenario === 'empty-bindings') {
          await harness.open(page, [], { select: false });
          assert.equal(await page.getByRole('status').filter({ hasText: '暂无绑定用户' }).isVisible(), true);
          assert.equal(await page.getByRole('button', { name: '添加微信用户' }).isEnabled(), true);
        } else if (scenario === 'no-selection') {
          await harness.open(page, bindings, { select: false });
          assert.equal(await page.getByText('请选择绑定用户', { exact: true }).isVisible(), true);
          assert.equal(await page.getByLabel('手动发送消息').count(), 0);
        } else {
          await harness.open(page, bindings, { emptyHistory: true });
          assert.equal(await page.getByRole('status').filter({ hasText: '暂无已保存消息' }).isVisible(), true);
        }
        await harness.capture(page, `${width}-${colorScheme}-${scenario}`);
      }
    }
    context.diagnostic(`空态截图：${harness.evidence}`);
  });
}

test('reflows at 195px effective width without claiming native 200 percent browser zoom', options, async (context) => {
  for (const colorScheme of ['light', 'dark'] as const) {
    const page = await harness.browser.newPage({ viewport: { width: 195, height: 900 }, colorScheme });
    context.after(() => page.close());
    await harness.open(page);
    await waitForInboxMedia(page);

    const overflow = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));

    assert.ok(overflow.content <= overflow.width, JSON.stringify(overflow));
    await harness.capture(page, `195-${colorScheme}-effective-width-not-browser-zoom`);
    context.diagnostic(`195px 等效内容宽度压力截图（不是真实浏览器缩放）：${harness.evidence}`);
  }
});
