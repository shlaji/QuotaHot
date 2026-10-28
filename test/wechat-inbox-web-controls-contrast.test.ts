import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { bindings, createInboxHarness, options, type InboxHarness } from './helpers/wechat-inbox-web.js';

let harness: InboxHarness;
before(async () => { if (!options.skip) harness = await createInboxHarness(); });
after(async () => { await harness?.browser.close(); });
function luminance(color: string): number {
  const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  assert.ok(channels?.length === 3);
  const normalized = color.startsWith('color(srgb');
  const [red = 0, green = 0, blue = 0] = channels.map((value) => normalized ? value : value / 255)
    .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return red * .2126 + green * .7152 + blue * .0722;
}
function contrast(foreground: string, background: string): number {
  const [first, second] = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return (first + .05) / ((second ?? 0) + .05);
}

for (const colorScheme of ['light', 'dark'] as const) {
  for (const disabled of [false, true]) {
    for (const kind of ['text', 'file']) {
      test(`${colorScheme} ${disabled ? 'disabled' : 'enabled'} ${kind} controls retain contrasting edges and text`, options, async (context) => {
        const page = await harness.browser.newPage({ colorScheme, viewport: { width: 390, height: 900 } });
        context.after(() => page.close());
        const summaries = bindings.map((binding) => ({ ...binding }));
        await harness.open(page, summaries);
        await page.getByLabel('发送类型').selectOption(kind);
        if (disabled) {
          for (const binding of summaries) binding.canSend = false;
          await page.getByRole('button', { name: '刷新绑定', exact: true }).click();
          await page.locator('.wechat-composer select:disabled').waitFor();
        }

        const metrics = await page.locator('.wechat-pane button, .wechat-pane select, .wechat-pane textarea, .wechat-pane input').evaluateAll((elements) => {
          const canvas = document.createElement('canvas');
          const painter = canvas.getContext('2d');
          if (!painter) throw new Error('Canvas unavailable');
          const colors = { luminance() {
            const [red = 0, green = 0, blue = 0] = painter.getImageData(0, 0, 1, 1).data;
            return [red, green, blue].map((value) => value / 255).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
              .reduce((sum, value, index) => sum + value * ([.2126, .7152, .0722][index] ?? 0), 0);
          }, contrast(first: number, second: number) { return (Math.max(first, second) + .05) / (Math.min(first, second) + .05); } };
          return elements.map((element) => {
            const style = getComputedStyle(element);
            const ancestors: Element[] = [];
            for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) ancestors.unshift(ancestor);
            painter.clearRect(0, 0, 1, 1);
            for (const ancestor of ancestors) { painter.fillStyle = getComputedStyle(ancestor).backgroundColor; painter.fillRect(0, 0, 1, 1); }
            const outer = colors.luminance();
            painter.save();
            painter.fillStyle = style.borderTopColor; painter.fillRect(0, 0, 1, 1);
            const edge = colors.luminance();
            painter.restore();
            painter.clearRect(0, 0, 1, 1);
            for (const ancestor of ancestors) { painter.fillStyle = getComputedStyle(ancestor).backgroundColor; painter.fillRect(0, 0, 1, 1); }
            painter.fillStyle = style.backgroundColor; painter.fillRect(0, 0, 1, 1);
            const paper = colors.luminance();
            painter.fillStyle = style.color; painter.fillRect(0, 0, 1, 1);
            return { control: element.tagName, label: element.textContent?.trim(), edge: colors.contrast(edge, outer), text: colors.contrast(colors.luminance(), paper), opacity: style.opacity };
          });
        });

        assert.ok(metrics.length > 0);
        assert.ok(metrics.every((item) => item.edge >= 3 && item.text >= 4.5 && item.opacity === '1'), JSON.stringify({ colorScheme, disabled, kind, metrics }));
        await page.getByLabel(kind === 'text' ? '消息正文' : '选择文件').scrollIntoViewIfNeeded();
        await harness.capture(page, `390-${colorScheme}-${disabled ? 'disabled' : 'enabled'}-${kind}-contrast`);
        context.diagnostic(`控件证据：${harness.evidence}`);
      });
    }
  }

  test(`${colorScheme} keyboard control focus rings contrast with adjacent surfaces`, options, async (context) => {
    const page = await harness.browser.newPage({ colorScheme });
    context.after(() => page.close());
    await harness.open(page);
    await page.keyboard.press('Tab');
    const controls = page.locator('.wechat-pane button:enabled, .wechat-pane select:enabled, .wechat-pane textarea:enabled');
    for (const control of await controls.all()) {
      await control.focus();

      const metrics = await control.evaluate((element) => {
        const style = getComputedStyle(element);
        const canvas = document.createElement('canvas');
        const painter = canvas.getContext('2d');
        if (!painter) throw new Error('Canvas unavailable');
        const ancestors: Element[] = [];
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) ancestors.unshift(ancestor);
        for (const ancestor of ancestors) { painter.fillStyle = getComputedStyle(ancestor).backgroundColor; painter.fillRect(0, 0, 1, 1); }
        const colors = { luminance() {
          const [red = 0, green = 0, blue = 0] = painter.getImageData(0, 0, 1, 1).data;
          return [red, green, blue].map((value) => value / 255).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
            .reduce((sum, value, index) => sum + value * ([.2126, .7152, .0722][index] ?? 0), 0);
        } };
        const paper = colors.luminance();
        painter.fillStyle = style.outlineColor; painter.fillRect(0, 0, 1, 1);
        const ink = colors.luminance();
        return { tag: element.tagName, visible: element.matches(':focus-visible'), width: parseFloat(style.outlineWidth),
          contrast: (Math.max(ink, paper) + .05) / (Math.min(ink, paper) + .05) };
      });

      assert.ok(metrics.visible && metrics.width >= 2 && metrics.contrast >= 3, JSON.stringify(metrics));
    }
  });

  test(`${colorScheme} file selector button retains readable native disabled state`, options, async (context) => {
    const page = await harness.browser.newPage({ colorScheme, viewport: { width: 390, height: 900 } });
    context.after(() => page.close());
    const summaries = bindings.map((binding) => ({ ...binding }));
    await harness.open(page, summaries);
    await page.getByLabel('发送类型').selectOption('file');
    summaries.forEach((binding) => { binding.canSend = false; });
    await page.route('**/api/wechat-inbox/bindings', (route) => route.fulfill({ json: summaries }));
    await page.getByRole('button', { name: '刷新绑定', exact: true }).click();
    await page.locator('.wechat-composer select:disabled').waitFor();

    const style = await page.locator('.wechat-composer input[type=file]').evaluate((input) => {
      const style = getComputedStyle(input, '::file-selector-button');
      const parent = getComputedStyle(input);
      return { color: style.color, background: style.backgroundColor, border: style.borderTopColor,
        parent: parent.backgroundColor, opacity: style.opacity };
    });

    assert.ok(contrast(style.color, style.background) >= 4.5 && contrast(style.border, style.parent) >= 3 && style.opacity === '1',
      JSON.stringify({ colorScheme, style }));
  });
}

test('ordinary WeChat button hover and press do not filter contrast-bearing foreground or border', options, async (context) => {
  const page = await harness.browser.newPage({ colorScheme: 'light' });
  context.after(() => page.close());
  await harness.open(page);
  const button = page.getByRole('button', { name: '刷新绑定', exact: true });

  await button.hover();
  await page.waitForFunction(() => {
    const refresh = [...document.querySelectorAll('button')].find((element) => element.textContent === '刷新绑定');
    return refresh !== undefined && getComputedStyle(refresh).filter === 'none';
  });
  assert.equal(await button.evaluate((element) => getComputedStyle(element).filter), 'none');
  await page.mouse.down();
  assert.equal(await button.evaluate((element) => getComputedStyle(element).opacity), '1');
  assert.equal(await button.evaluate((element) => getComputedStyle(element).filter), 'none');
  await page.mouse.up();
  await harness.capture(page, 'ordinary-button-hover-and-press');
});
