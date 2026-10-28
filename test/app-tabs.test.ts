import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { DEFAULT_CONFIG } from '../src/server/config.js';

const browserPath = process.env.QUOTAHOT_TEST_BROWSER ?? '/usr/bin/google-chrome';
const browserOptions = { skip: existsSync(browserPath) ? false : 'Set QUOTAHOT_TEST_BROWSER to run DOM interaction tests' };
let browser: Browser;
let fixtureScript = '';
const state = { config: DEFAULT_CONFIG, version: 'test', accounts: [], accountsDir: '/synthetic', proxy: '', noProxy: [], gateway: null,
  scheduler: { running: false, accountIds: [], withinWindow: true, dailyStart: '06:00', dailyEnd: '23:00' } };

before(async () => {
  if (browserOptions.skip) return;
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      import { createElement } from 'react';
      import { createRoot } from 'react-dom/client';
      import { App } from './src/web/App.tsx';
      createRoot(document.getElementById('root')).render(createElement(App));
    ` },
    bundle: true, write: false, outdir: '/tmp/quotahot-tab-test', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' },
  });
  fixtureScript = bundle.outputFiles.find((file) => file.path.endsWith('.js'))?.text ?? '';
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
});
after(async () => { await browser?.close(); });

async function openApp(page: Page) {
  await page.route('http://quotahot.test/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    const body = path === '/api/state' ? state
      : path === '/api/tasks/summary' ? { tasks: [], defaultDirectory: '/synthetic' }
      : path === '/api/wechat/session' ? { error: 'wechat_session_required' }
      : path === '/api/models' ? { claude: { options: [], fromUpstream: false }, codex: { options: [], fromUpstream: false } } : [];
    await route.fulfill({ status: path === '/api/wechat/session' ? 401 : 200, json: body });
  });
  await page.goto('http://quotahot.test');
  await page.evaluate(() => localStorage.setItem('quotahot.tab', 'wechat'));
  await page.addStyleTag({ content: readFileSync('src/web/styles.css', 'utf8') });
  await page.addStyleTag({ content: readFileSync('src/web/task-styles.css', 'utf8') + readFileSync('src/web/wechat-styles.css', 'utf8') });
  await page.addScriptTag({ content: fixtureScript });
  await page.getByRole('tab', { name: '微信对话' }).waitFor();
}

test('gives only the persisted selected tab a tab stop and wires every panel', browserOptions, async (context) => {
  const page = await browser.newPage();
  context.after(() => page.close());
  await openApp(page);

  const tabs = await page.getByRole('tab').evaluateAll((elements) => elements.map((element) => ({
    selected: element.getAttribute('aria-selected'), tabIndex: element.tabIndex,
    labelled: document.getElementById(element.getAttribute('aria-controls') ?? '')?.getAttribute('aria-labelledby') === element.id,
  })));

  assert.equal(tabs.filter((tab) => tab.tabIndex === 0).length, 1);
  assert.ok(tabs.every((tab) => tab.tabIndex === (tab.selected === 'true' ? 0 : -1) && tab.labelled));
});

for (const [start, key, target] of [
  ['账户', 'ArrowLeft', '配置'], ['配置', 'ArrowRight', '账户'],
  ['微信对话', 'ArrowRight', '配置'], ['微信对话', 'ArrowLeft', '任务管理'],
  ['微信对话', 'Home', '账户'], ['微信对话', 'End', '配置'],
] as const) {
  test(`activates and focuses ${target} when ${key} is pressed on ${start}`, browserOptions, async (context) => {
    const page = await browser.newPage();
    context.after(() => page.close());
    await openApp(page);
    const initial = page.getByRole('tab', { name: start, exact: true });
    await initial.click();

    await initial.press(key);

    const destination = page.getByRole('tab', { name: target, exact: true });
    assert.equal(await destination.getAttribute('aria-selected'), 'true');
    assert.equal(await destination.evaluate((element) => element === document.activeElement), true);
    assert.equal(await page.getByRole('tab').evaluateAll((elements) => elements.filter((element) => element.tabIndex === 0).length), 1);
  });
}

test('activates a tab on focus while retaining mounted panel drafts', browserOptions, async (context) => {
  const page = await browser.newPage();
  context.after(() => page.close());
  await openApp(page);
  const config = page.locator('#config-tab');

  await config.focus();

  assert.equal(await config.getAttribute('aria-selected'), 'true');
  assert.equal(await page.evaluate(() => localStorage.getItem('quotahot.tab')), 'config');
  const text = page.getByLabel('提示词', { exact: true });
  await text.fill('draft preserved');
  const panel = page.getByRole('tabpanel');
  await panel.evaluate((element) => { element.dataset.mountMarker = 'same'; });
  await page.getByRole('tab', { name: '账户', exact: true }).click();
  await config.click();
  assert.equal(await text.inputValue(), 'draft preserved');
  assert.equal(await page.getByRole('tabpanel').getAttribute('data-mount-marker'), 'same');
});

for (const width of [375, 390, 1440]) {
  test(`keeps every tab at least 44px high without horizontal overflow at ${width}px`, browserOptions, async (context) => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    context.after(() => page.close());
    await openApp(page);

    const heights = await page.getByRole('tab').evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));

    assert.ok(heights.every((height) => height >= 44), JSON.stringify(heights));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  });
}
