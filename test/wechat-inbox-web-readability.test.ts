import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { createInboxHarness, options, type InboxHarness } from './helpers/wechat-inbox-web.js';

let harness: InboxHarness;
before(async () => { if (!options.skip) harness = await createInboxHarness(); });
after(async () => { await harness?.browser.close(); });

test('attachment links show immediate pointer-down feedback and restore on release', options, async (context) => {
  for (const colorScheme of ['light', 'dark'] as const) {
    const page = await harness.browser.newPage({ viewport: { width: 390, height: 900 }, colorScheme });
    context.after(() => page.close());
    await harness.open(page);
    const link = page.locator('.wechat-media a').first();
    await link.hover();
    const before = await link.evaluate((element) => getComputedStyle(element).backgroundColor);

    await page.mouse.down();

    assert.equal(await link.evaluate((element) => element.matches(':active')), true);
    assert.notEqual(await link.evaluate((element) => getComputedStyle(element).backgroundColor), before);
    await harness.capture(page, `390-${colorScheme}-attachment-pressed`);
    await page.mouse.up();
    assert.equal(await link.evaluate((element) => getComputedStyle(element).backgroundColor), before);
    await harness.capture(page, `390-${colorScheme}-attachment-released`);
    context.diagnostic(`附件按下证据：${harness.evidence}`);
  }
});

test('keeps narrow binding header labels on one line when actions wrap', options, async (context) => {
  const page = await harness.browser.newPage({ viewport: { width: 195, height: 900 } });
  context.after(() => page.close());
  await harness.open(page);

  const heights = await page.locator('#wechat-inbox-bindings-title, .wechat-actions button').evaluateAll((elements) => elements.map((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return [...range.getClientRects()].map((rect) => rect.y);
  }));

  assert.ok(heights.every((lines) => new Set(lines).size === 1), JSON.stringify(heights));
});

test('keeps the upstream authorization phrase intact in narrow confirmation copy', options, async (context) => {
  for (const width of [390, 195]) {
    const page = await harness.browser.newPage({ viewport: { width, height: 900 } });
    context.after(() => page.close());
    await harness.open(page);
    await page.locator('.wechat-list li').first().getByRole('button', { name: '解除本地绑定', exact: true }).click();

    const textLines = await page.locator('.wechat-confirm p').evaluateAll((paragraphs) => paragraphs.flatMap((element) => {
      const lines = new Map<number, string>();
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        for (let index = 0; index < (node.textContent?.length ?? 0); index++) {
          const range = document.createRange();
          range.setStart(node, index); range.setEnd(node, index + 1);
          const top = Math.round(range.getBoundingClientRect().top);
          lines.set(top, (lines.get(top) ?? '') + node.textContent?.charAt(index));
        }
      }
      return [...lines.values()].map((line) => line.trim());
    }));
    const phraseLines = await page.locator('.wechat-confirm .wechat-phrase').evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return [...range.getClientRects()].map((rect) => rect.top);
    });

    assert.equal(new Set(phraseLines).size, 1, JSON.stringify({ width, phraseLines }));
    assert.equal(textLines.some((line) => /^[，。！？；：、]/u.test(line)), false, JSON.stringify({ width, textLines }));
    assert.equal(textLines.some((line) => line.replace(/[\s\p{P}]/gu, '').length === 1), false, JSON.stringify({ width, textLines }));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
    await harness.capture(page, `${width}-confirmation-phrase`);
    context.diagnostic(`确认短语证据：${harness.evidence}`);
  }
});

test('preserves selected wash without brightness filtering when hovered', options, async (context) => {
  const page = await harness.browser.newPage();
  context.after(() => page.close());
  await harness.open(page);
  const selected = page.locator('.wechat-list button[aria-current]');
  await page.mouse.move(0, 0);
  const resting = await selected.evaluate((element) => getComputedStyle(element).backgroundColor);

  await selected.hover();

  const hovered = await selected.evaluate((element) => ({ filter: getComputedStyle(element).filter, background: getComputedStyle(element).backgroundColor }));
  assert.equal(hovered.filter, 'none');
  assert.notEqual(hovered.background, resting);
  await harness.capture(page, 'selected-hover-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await harness.capture(page, 'selected-hover-dark');
  context.diagnostic(`选中行悬停截图：${harness.evidence}`);
});

test('provides readable message and note type with AA contrast in both themes', options, async (context) => {
  for (const colorScheme of ['light', 'dark'] as const) {
    const page = await harness.browser.newPage({ viewport: { width: 390, height: 900 }, colorScheme });
    context.after(() => page.close());
    await harness.open(page);

    const metrics = await page.locator('.wechat-messages li').first().evaluate((element) => {
      const canvas = document.createElement('canvas');
      const painter = canvas.getContext('2d');
      if (!painter) throw new Error('Canvas unavailable');
      return [...element.querySelectorAll('p, .wechat-note')].map((child) => {
        const style = getComputedStyle(child);
        const [ink = 0, paper = 0] = [style.color, getComputedStyle(element).backgroundColor].map((color) => {
          painter.fillStyle = color;
          painter.fillRect(0, 0, 1, 1);
          const [red = 0, green = 0, blue = 0] = painter.getImageData(0, 0, 1, 1).data;
          return [red, green, blue].map((value) => value / 255).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
            .reduce((sum, value, index) => sum + value * ([.2126, .7152, .0722][index] ?? 0), 0);
        });
        return { note: child.classList.contains('wechat-note'), size: parseFloat(style.fontSize), contrast: (Math.max(ink, paper) + .05) / (Math.min(ink, paper) + .05) };
      });
    });

    assert.ok(metrics.every((item) => item.size >= (item.note ? 15 : 17) && item.contrast >= 4.5), JSON.stringify({ colorScheme, metrics }));
  }
});

test('offers attachment links at least 44 by 44 CSS pixels when media is present', options, async (context) => {
  const page = await harness.browser.newPage({ viewport: { width: 390, height: 900 } });
  context.after(() => page.close());
  await harness.open(page);

  const targets = await page.locator('.wechat-media a').evaluateAll((elements) => elements.map((element) => {
    const { width, height } = element.getBoundingClientRect();
    return { width, height };
  }));

  assert.ok(targets.length > 0);
  assert.ok(targets.every(({ width, height }) => width >= 44 && height >= 44), JSON.stringify(targets));
});

test('uses the system theme for native media controls', options, async (context) => {
  for (const colorScheme of ['light', 'dark'] as const) {
    const page = await harness.browser.newPage({ colorScheme });
    context.after(() => page.close());
    await harness.open(page);

    const schemes = await page.locator('audio, video').evaluateAll((elements) => elements.map((element) => getComputedStyle(element).colorScheme));

    assert.ok(schemes.length > 0);
    assert.ok(schemes.every((scheme) => scheme.includes(colorScheme)), JSON.stringify(schemes));
  }
});

test('makes Add primary only when the selected binding cannot send', options, async (context) => {
  const page = await harness.browser.newPage();
  context.after(() => page.close());
  await harness.open(page);
  await page.getByLabel('消息正文').fill('可发送草稿');
  assert.equal(await page.locator('button.primary:enabled').innerText(), '发送文本');

  await page.getByRole('button', { name: /连续中文长名称.*只读/ }).click();

  assert.deepEqual(await page.locator('button.primary:enabled').allTextContents(), ['添加微信用户']);
});

test('renders relative QR expiry with the exact local instant in its title', options, async (context) => {
  const page = await harness.browser.newPage();
  context.after(() => page.close());
  await harness.open(page);
  await page.clock.setFixedTime(new Date('2026-10-25T12:00:00Z'));
  await page.route('**/api/wechat/qrcode**', (route) => route.fulfill({ json: route.request().method() === 'POST'
    ? { attemptId: 'expiry', qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"/>', expiresAt: Date.parse('2026-10-25T12:02:00Z') }
    : { status: 'waiting' } }));

  await page.getByRole('button', { name: '添加微信用户', exact: true }).click();
  const expiry = page.locator('.wechat-qr-expiry time');
  await expiry.waitFor({ timeout: 1500 });

  assert.equal(await expiry.innerText(), '2分钟后');
  assert.equal(await expiry.getAttribute('datetime'), '2026-10-25T12:02:00.000Z');
  assert.match(await expiry.getAttribute('title') ?? '', /2026\/10\/25.*\d{2}:\d{2}:\d{2}/);
});

test('keeps empty-state guidance readable on narrow screens', options, async (context) => {
  const page = await harness.browser.newPage({ viewport: { width: 390, height: 900 } });
  context.after(() => page.close());
  await harness.open(page, [], { select: false });

  const size = await page.locator('.wechat-pane .empty').evaluate((element) => parseFloat(getComputedStyle(element).fontSize));

  assert.ok(size >= 15, `Empty-state guidance is only ${size}px`);
});

test('avoids single-character CJK final lines in narrow guidance and message paragraphs', options, async (context) => {
  const page = await harness.browser.newPage({ viewport: { width: 390, height: 900 } });
  context.after(() => page.close());
  await harness.open(page);

  const orphans = await page.locator('.wechat-pane p, .wechat-list button span, .wechat-list button small').evaluateAll((elements) => elements.flatMap((element) => {
    const lines = new Map<number, string>();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      for (let index = 0; index < (node.textContent?.length ?? 0); index++) {
        const range = document.createRange();
        range.setStart(node, index); range.setEnd(node, index + 1);
        const top = range.getBoundingClientRect().top;
        lines.set(top, (lines.get(top) ?? '') + node.textContent?.charAt(index));
      }
    }
    const last = [...lines.values()].at(-1)?.replace(/[\s\p{P}]/gu, '') ?? '';
    return lines.size > 1 && /^\p{Script=Han}$/u.test(last) ? [element.textContent] : [];
  }));

  assert.deepEqual(orphans, []);
});
