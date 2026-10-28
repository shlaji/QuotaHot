import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium, type Locator, type Page } from 'playwright-core';
import { attachmentIds, mediaFixture } from './wechat-inbox-media.js';

const browserPath = process.env.QUOTAHOT_TEST_BROWSER ?? '/usr/bin/google-chrome';
export const options = { skip: existsSync(browserPath) ? false : 'Set QUOTAHOT_TEST_BROWSER to run inbox browser tests' };
const date = '2026-01-01T00:00:00Z';
const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const olderPages = ['33333333-3333-4333-8333-333333333333', '55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666'];
export const bindings = [
  { ownerIlinkUserId: '测试账号', botId: '本地机器人', connectionState: 'polling', canSend: true, replyContextState: 'ready', createdAt: date, updatedAt: date },
  { ownerIlinkUserId: '另一绑定', botId: '另一机器人', connectionState: 'polling', canSend: true, replyContextState: 'ready', createdAt: date, updatedAt: date },
  { ownerIlinkUserId: '连续中文长名称用于窄屏状态标签换行检查且没有空格分隔测试用户', botId: '只读机器人', connectionState: 'polling', canSend: false, replyContextState: 'ready', createdAt: date, updatedAt: date },
];
const messages = Array.from({ length: 20 }, (_, index) => ({
  id: index === 0 ? first : index === 1 ? second : `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`,
  kind: index === 1 ? 'image' : index === 19 ? 'video' : 'text', direction: 'inbound', state: 'received', sequence: index + 2, createdAt: date,
  text: index === 0 ? '<script>上游内容只能作为文本显示</script>' : `历史测试消息 ${index} ${'绑定历史内容'.repeat(12)}`,
  items: index === 1 ? (['image', 'voice', 'file', 'video', 'protocol_event'] as const).map((kind) =>
    ({ kind, attachmentId: kind === 'protocol_event' ? null : attachmentIds[kind], fileName: '测试附件', text: kind === 'protocol_event' ? '暂不支持的协议内容' : null }))
    : index === 19 ? [{ kind: 'video', attachmentId: attachmentIds.video, fileName: '末尾视频' }] : [],
}));

export async function createInboxHarness() {
  const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { createElement } from 'react';
    import { createRoot } from 'react-dom/client';
    import { WechatPane } from './src/web/components/WechatPane.tsx';
    const root = createRoot(document.getElementById('root'));
    root.render(createElement(WechatPane, { active: true }));
    window.addEventListener('wechat-active', (event) => root.render(createElement(WechatPane, { active: event.detail })));
  ` }, bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  const script = bundle.outputFiles[0].text;
  const css = (await Promise.all(['styles.css', 'task-styles.css', 'wechat-styles.css'].map((name) => readFile(`src/web/${name}`, 'utf8')))).join('\n');
  const evidence = await mkdtemp('/tmp/opencode/quotahot-inbox-');
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  async function open(page: Page, summaries = bindings, scenario: { readonly select?: boolean; readonly emptyHistory?: boolean } = {}) {
    const requests: string[] = [];
    await page.route('http://inbox.test/', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width, initial-scale=1"><title>微信消息</title><div id="root" class="app"></div></html>' }));
    await page.route('**/api/wechat/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      requests.push(`${route.request().method()} ${path}`);
      return route.fulfill({ status: 404, json: { error: 'unexpected_route' } });
    });
    await page.route('**/api/wechat-inbox/**', (route) => {
      const url = new URL(route.request().url());
      requests.push(`${route.request().method()} ${url.pathname}${url.search}`);
      if (url.pathname.includes('/attachments/')) return route.fulfill(mediaFixture(url.pathname.split('/').at(-1) ?? ''));
      const before = url.searchParams.get('before');
      const pageIndex = before === null ? 0 : before === 'older' ? 1 : Number(before.slice('older-'.length));
      const data = url.pathname.endsWith('/bindings') ? summaries
        : scenario.emptyHistory ? { items: [], nextCursor: null, hasMore: false }
        : { items: pageIndex === 0 ? messages : [{ id: olderPages[pageIndex - 1], kind: 'text', direction: 'inbound', state: 'received',
          sequence: pageIndex, createdAt: date, text: `更早消息 ${pageIndex}`, items: [] }, ...(pageIndex === 1 ? messages : [])],
        nextCursor: pageIndex === 0 ? 'older' : pageIndex < olderPages.length ? `older-${pageIndex + 1}` : null,
        hasMore: pageIndex === 0 || pageIndex < olderPages.length };
      return route.fulfill({ json: data });
    });
    await page.goto('http://inbox.test/');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: script });
    await page.locator('section[aria-labelledby="wechat-inbox-bindings-title"][aria-busy="false"]').waitFor();
    if (scenario.select !== false) {
      await page.getByRole('button', { name: /测试账号.*正在接收/ }).click();
      await page.getByLabel('消息正文').waitFor();
      await page.locator('section[aria-labelledby="wechat-inbox-messages-title"][aria-busy="false"]').waitFor();
      if (!scenario.emptyHistory) await page.getByText('<script>上游内容只能作为文本显示</script>', { exact: true }).waitFor();
    }
    assert.equal(requests.some((path) => path.includes('/contacts') || path.includes('/conversations')), false);
    assert.equal(requests.some((path) => /\/api\/wechat\/(session|binding)(?:$|\/)/.test(path)), false);
    return requests;
  }
  async function capture(page: Page, name: string) {
    const viewport = page.viewportSize();
    assert.ok(viewport);
    const settings = await page.evaluate(() => ({ density: window.devicePixelRatio, dark: matchMedia('(prefers-color-scheme: dark)').matches,
      scrollOwner: { document: 'vertical', innerVerticalContainers: [...document.querySelectorAll('.wechat-pane *')]
        .filter((element) => ['auto', 'scroll'].includes(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight).length } }));
    const image = await page.screenshot({ path: `${evidence}/${name}.png` });
    assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(image.readUInt32BE(16), viewport.width * settings.density);
    assert.equal(image.readUInt32BE(20), viewport.height * settings.density);
    await writeFile(`${evidence}/${name}.json`, JSON.stringify({ viewport, ...settings, capturedAt: new Date().toISOString(),
      safeArea: 'N/A：微信页无 fixed/sticky 边缘控件；未模拟物理刘海。',
      zoom: viewport.width === 195 ? '195px 等效重排压力，不是真实浏览器缩放。' : '未启用浏览器缩放。' }));
  }
  async function captureElement(page: Page, locator: Locator, name: string) {
    const viewport = page.viewportSize();
    assert.ok(viewport);
    const settings = await page.evaluate(() => ({ deviceScaleFactor: window.devicePixelRatio,
      colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' }));
    const bounds = await locator.boundingBox();
    assert.ok(bounds);
    const image = await locator.screenshot({ path: `${evidence}/${name}.png` });
    assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    await writeFile(`${evidence}/${name}.json`, JSON.stringify({ captureKind: 'element', viewport, elementBounds: bounds,
      image: { width: image.readUInt32BE(16), height: image.readUInt32BE(20) }, ...settings, capturedAt: new Date().toISOString() }));
  }
  return { browser, open, capture, captureElement, evidence, first };
}
export type InboxHarness = Awaited<ReturnType<typeof createInboxHarness>>;
