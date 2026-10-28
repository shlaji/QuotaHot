import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import QRCode from 'qrcode';
import { WechatPane } from '../src/web/components/WechatPane.js';
import { InboxView } from '../src/web/wechat-inbox/InboxPane.js';
import { createInboxLoader, INITIAL_INBOX_STATE } from '../src/web/wechat-inbox/loader.js';
import { createWechatLoader, INITIAL_WECHAT_STATE } from '../src/web/wechat-loader.js';

test('the page renders binding list and inbox directly without a single-session surface', () => {
  const html = renderToStaticMarkup(createElement(WechatPane, { active: true }));
  assert.match(html, /添加微信用户|绑定消息/);
  assert.doesNotMatch(html, /微信连接|微信身份|会话有效至|退出微信会话|切换当前会话|微信扫码登录|浏览器会话/);
});

for (const status of ['loading', 'waiting', 'scanned', 'unverified'] as const) {
  test(`list-local QR ${status} prevents duplicates and allows cancellation`, async () => {
    const qrSvg = await QRCode.toString('synthetic-wechat-user', { type: 'svg' });
    const controls = { state: { ...INITIAL_WECHAT_STATE, qr: { status, error: '', qr: status === 'loading' ? null
      : { attemptId: 'a1', qrSvg, expiresAt: 9000 } } }, loader: createWechatLoader(() => {}) };
    const html = renderToStaticMarkup(createElement(InboxView, { active: true, state: INITIAL_INBOX_STATE,
      loader: createInboxLoader(() => {}), controls }));
    assert.match(html, /<button[^>]*disabled=""[^>]*>添加微信用户<\/button>/);
    assert.match(html, /取消扫码/);
    if (status !== 'loading') assert.match(html, /<img[^>]*src="data:image\/svg\+xml/);
    assert.doesNotMatch(html, /<svg|<script|qrcode_url/);
  });
}
