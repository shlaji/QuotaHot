import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import QRCode from 'qrcode';

const browserPath = process.env.QUOTAHOT_TEST_BROWSER ?? '/usr/bin/google-chrome';
const options = { skip: existsSync(browserPath) ? false : 'Set QUOTAHOT_TEST_BROWSER to run binding visual tests' };
const date = '2026-01-01T00:00:00Z';
const owners = ['测试账号', '另一绑定'];

test('binding controls render all operation states in mobile and desktop light and dark while retaining the selected conversation', options, async (context) => {
  const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { createElement } from 'react';
    import { createRoot } from 'react-dom/client';
    import { WechatPane } from './src/web/components/WechatPane.tsx';
    createRoot(document.getElementById('root')).render(createElement(WechatPane, { active: true }));
  ` }, bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  const script = bundle.outputFiles[0]?.text;
  assert.ok(script);
  const css = (await Promise.all(['styles.css', 'task-styles.css', 'wechat-styles.css'].map((name) => readFile(`src/web/${name}`, 'utf8')))).join('\n');
  const qrSvg = await QRCode.toString('synthetic-wechat-add-user-visual', { type: 'svg' });
  assert.match(qrSvg, /<path/);
  const evidence = await mkdtemp('/tmp/opencode/quotahot-bindings-');
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  context.after(() => browser.close());
  for (const width of [390, 1440, 1920]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      const browserContext = await browser.newContext({ viewport: { width, height: 900 }, colorScheme,
        isMobile: width === 390, hasTouch: width === 390, deviceScaleFactor: width === 390 ? 3 : 1, reducedMotion: 'reduce' });
      const page = await browserContext.newPage();
      const qrReady = Promise.withResolvers<void>();
      const unlinkErrorReady = Promise.withResolvers<void>();
      const unlinkReady = Promise.withResolvers<void>();
      const errors: string[] = [];
      const requests: string[] = [];
      let linked = true;
      let unlinkAttempts = 0;
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await page.route('http://binding.test/', (route) => route.fulfill({ contentType: 'text/html', body:
          '<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root" class="app"></div></html>' }));
        await page.route('**/api/**', async (route) => {
          const path = decodeURIComponent(new URL(route.request().url()).pathname);
          const method = route.request().method();
          requests.push(`${method} ${path}`);
          if (path === '/api/wechat-inbox/bindings') return route.fulfill({ json: owners.map((ownerIlinkUserId) => ({ ownerIlinkUserId,
            botId: '本地机器人', createdAt: date, updatedAt: date, connectionState: linked || ownerIlinkUserId === owners[0] ? 'polling' : 'unlinked',
            canSend: linked || ownerIlinkUserId === owners[0], replyContextState: 'ready' })) });
          if (path.includes('/messages')) return route.fulfill({ json: { items: [{ id: '11111111-1111-4111-8111-111111111111',
            sequence: 1, createdAt: date, direction: 'inbound', kind: 'text', state: 'received', text: '已经保存的绑定消息，不应被扫码或解绑清空。', items: [] }], nextCursor: null, hasMore: false } });
          if (path === '/api/wechat/qrcode' && method === 'POST') {
            await qrReady.promise;
            return route.fulfill({ json: { attemptId: 'visual', qrSvg, expiresAt: Date.now() + 60_000 } });
          }
          if (path === '/api/wechat/qrcode/visual') return route.fulfill({ json: { status: method === 'DELETE' ? 'cancelled' : 'waiting' } });
          if (path === '/api/wechat/bindings/另一绑定' && method === 'DELETE') {
            unlinkAttempts++;
            if (unlinkAttempts === 1) {
              await unlinkErrorReady.promise;
              return route.fulfill({ status: 503, json: { error: 'wechat_upstream_unavailable', message: 'private-upstream-detail' } });
            }
            await unlinkReady.promise;
            linked = false;
            return route.fulfill({ json: { status: 'unlinked' } });
          }
          return route.fulfill({ status: 404, json: { error: 'unexpected_request' } });
        });
        await page.goto('http://binding.test/');
        await page.addStyleTag({ content: css });
        await page.addScriptTag({ content: script });
        const rows = page.getByRole('list', { name: '绑定用户', exact: true }).locator(':scope > li');
        await rows.nth(0).locator(':scope > button').click();
        await page.getByLabel('消息正文').fill('当前绑定的独立草稿');
        assert.equal(await page.getByRole('button', { name: /核验/ }).count(), 0);
        assert.doesNotMatch((await rows.allTextContents()).join('\n'), /尚未核验|需要重新扫码|绑定已变更/);
        const take = async (state: string) => {
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
          const capturedAt = new Date().toISOString();
          const image = await page.screenshot({ path: `${evidence}/${width}-${colorScheme}-${state}.png` });
          const density = width === 390 ? 3 : 1;
          assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
          assert.equal(image.readUInt32BE(16), width * density);
          assert.equal(image.readUInt32BE(20), 900 * density);
          await writeFile(`${evidence}/${width}-${colorScheme}-${state}.json`, JSON.stringify({
            viewport: { width, height: 900 }, deviceScaleFactor: density, colorScheme, captureLabel: state, capturedAt,
          }));
          assert.deepEqual(JSON.parse(await readFile(`${evidence}/${width}-${colorScheme}-${state}.json`, 'utf8')),
            { viewport: { width, height: 900 }, deviceScaleFactor: density, colorScheme, captureLabel: state, capturedAt });
        };
        await take('rest');
        const add = page.getByRole('button', { name: '添加微信用户', exact: true });
        await add.focus();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Shift+Tab');
        assert.equal(await add.evaluate((element) => element.matches(':focus-visible')), true);
        await take('keyboard-focus');
        await add.click();
        await page.getByRole('status').filter({ hasText: '正在生成二维码' }).waitFor();
        const cancelQr = page.getByRole('button', { name: '取消扫码', exact: true });
        assert.equal(await cancelQr.isEnabled(), true);
        const loadingCancelBox = await cancelQr.boundingBox();
        assert.ok(loadingCancelBox);
        await take('qr-loading');
        qrReady.resolve();
        await page.getByAltText('微信添加用户二维码', { exact: true }).waitFor();
        assert.deepEqual(await cancelQr.boundingBox(), loadingCancelBox, `${width}-${colorScheme}: Cancel moved`);
        await take('qr-active');
        await cancelQr.focus();
        await page.keyboard.press('Enter');
        await page.getByAltText('微信添加用户二维码', { exact: true }).waitFor({ state: 'detached' });
        assert.equal(await add.isEnabled(), true);
        assert.equal(await add.evaluate((element) => element === document.activeElement), true);
        await take('qr-cancelled');
        const unlink = rows.nth(1).getByRole('button', { name: '解除本地绑定', exact: true });
        await unlink.click();
        await take('unlink-confirm');
        await rows.nth(1).getByRole('button', { name: '取消', exact: true }).focus();
        await page.keyboard.press('Escape');
        assert.equal(await unlink.evaluate((element) => element === document.activeElement), true);
        await take('unlink-cancelled');
        await unlink.click();
        await rows.nth(1).getByRole('button', { name: '确认解除', exact: true }).click();
        await rows.nth(1).locator('[aria-busy="true"]').waitFor();
        assert.equal(await rows.nth(1).getByRole('status').filter({ hasText: '正在解除本地绑定' }).isVisible(), true);
        assert.equal(await rows.nth(0).getByRole('button', { name: '解除本地绑定', exact: true }).isEnabled(), true);
        await take('unlink-error-busy');
        unlinkErrorReady.resolve();
        await rows.nth(1).getByRole('alert').waitFor();
        await take('unlink-error');
        await unlink.click();
        await rows.nth(1).getByRole('button', { name: '确认解除', exact: true }).click();
        await rows.nth(1).locator('[aria-busy="true"]').waitFor();
        await take('unlink-busy');
        unlinkReady.resolve();
        await rows.nth(1).getByRole('status').filter({ hasText: '已解除本地绑定' }).waitFor();
        assert.equal(await rows.nth(1).locator(':scope > button').evaluate((element) => element === document.activeElement), true);
        await take('unlink-success');
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await take('scrolled-end');
        assert.equal(await page.getByLabel('消息正文').inputValue(), '当前绑定的独立草稿');
        assert.equal(await rows.nth(0).locator(':scope > button').getAttribute('aria-current'), 'true');
        assert.equal(await page.getByText('已经保存的绑定消息，不应被扫码或解绑清空。', { exact: true }).count(), 1);
        assert.equal(await page.locator('button button').count(), 0);
        assert.equal(requests.some((path) => /\/wechat\/(session|binding)(\/|$)/.test(path)), false);
        assert.equal(requests.some((path) => path.endsWith('/check')), false);
        assert.doesNotMatch(await page.locator('body').innerText(), /private-upstream-detail/);
        assert.deepEqual(errors, []);
      } finally {
        qrReady.resolve(); unlinkErrorReady.resolve(); unlinkReady.resolve();
        await browserContext.close();
      }
    }
  }
  context.diagnostic(`Fresh binding controls screenshots (72 PNGs): ${evidence}`);
});
