import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InboxView } from '../src/web/wechat-inbox/InboxPane.js';
import { createInboxLoader, INITIAL_INBOX_STATE, type InboxState } from '../src/web/wechat-inbox/loader.js';
import { createWechatLoader, INITIAL_WECHAT_STATE } from '../src/web/wechat-loader.js';
import type { WechatMessageItem } from '../src/shared/wechat-inbox.js';

const messageId = '11111111-1111-4111-8111-111111111111';
const date = '2026-01-01T00:00:00Z';
const selected: InboxState = { ...INITIAL_INBOX_STATE, bindingId: 'owner',
  bindings: [{ ownerIlinkUserId: 'owner', botId: 'bot', createdAt: date, updatedAt: date, connectionState: 'polling', canSend: true, replyContextState: 'ready' }],
};
const render = (patch: Partial<InboxState> = {}, active = true, qrDisabled = false) => renderToStaticMarkup(createElement(InboxView, {
  active, state: { ...selected, ...patch }, loader: createInboxLoader(() => {}),
  controls: { state: { ...INITIAL_WECHAT_STATE, qr: { ...INITIAL_WECHAT_STATE.qr, status: qrDisabled ? 'loading' : 'idle' } }, loader: createWechatLoader(() => {}) },
}));

for (const bindings of [[], selected.bindings]) {
  test(`shows an enabled add-user QR button in the binding header when ${bindings.length === 0 ? 'empty' : 'populated'}`, () => {
    const html = render({ bindings });

    assert.match(html, /<header[^>]*><h3 id="wechat-inbox-bindings-title">绑定用户<\/h3>.*?<button type="button"(?![^>]*disabled)[^>]*>添加微信用户<\/button>.*?刷新绑定<\/button>.*?<\/header>/);
  });
}

for (const scenario of [
  { name: 'inactive', active: false, qrDisabled: false },
  { name: 'QR pending', active: true, qrDisabled: true },
]) {
  test(`disables the binding-list QR action when ${scenario.name}`, () => {
    const html = render({}, scenario.active, scenario.qrDisabled);

    assert.match(html, /<button type="button"[^>]*disabled=""[^>]*>添加微信用户<\/button>/);
  });
}

test('shows binding choices directly above the selected binding history and manual composer', () => {
  const html = render();
  assert.ok(html.indexOf('绑定用户') < html.indexOf('绑定消息'));
  assert.match(html, /aria-label="已保存的绑定消息"/);
  assert.doesNotMatch(html, /联系人|本地对话|Conversation/);
  assert.match(html, /<form/);
  assert.match(html, /<textarea[^>]*aria-describedby=/);
  assert.match(html, /仅手动发送/);
  assert.match(html, /<option[^>]*disabled=""[^>]*value="voice"/);
  assert.match(html, /本次范围内保持禁用/);
  assert.doesNotMatch(html, /需先完成外部非生产验收/);
});

test('renders saved media only from local attachment IDs and escapes upstream markup', () => {
  const html = render({ messages: [{ id: messageId, sequence: 1, createdAt: date, direction: 'inbound', kind: 'image', state: 'received', text: '<script>unsafe</script>',
    items: (['image', 'voice', 'file', 'video', 'protocol_event'] as const).map((kind): WechatMessageItem => ({ kind, attachmentId: messageId, fileName: '附件' })) }] });
  assert.match(html, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script|<iframe/);
  assert.match(html, /<audio[^>]*controls=""[^>]*src="\/api\/wechat-inbox\/attachments\//);
  assert.match(html, /<video[^>]*controls=""/);
  assert.match(html, /<img[^>]*alt="微信图片附件"/);
  assert.match(html, /download=""/);
  assert.match(html, /协议消息/);
});

for (const state of ['accepted', 'failed', 'unknown'] as const) {
  test(`shows fixed ${state} feedback without automatic resend controls`, () => {
    const html = render({ outcome: state });
    assert.match(html, state === 'accepted' ? /不代表已送达或已读/ : state === 'unknown' ? /人工核对.*不会自动重试/ : /发送失败/);
    assert.doesNotMatch(html, /自动重发|<button[^>]*>重试发送/);
  });
}

test('disconnected bindings cannot send or type', () => {
  for (const patch of [
    { bindings: selected.bindings.map((binding) => ({ ...binding, canSend: false, connectionState: 'unlinked' as const })) },
  ]) {
    const html = render(patch);
    assert.match(html, /只读/);
    assert.match(html, /<textarea[^>]*disabled=""/);
    assert.match(html, /<button[^>]*disabled=""[^>]*>开始输入状态/);
  }
});

test('waiting selected binding explains the first inbound requirement and disables composing and typing', () => {
  const html = render({ draft: '保留草稿', typing: true,
    messages: [{ id: messageId, sequence: 1, createdAt: date, direction: 'inbound', kind: 'text', state: 'received', text: '已保存的历史', items: [] }],
    bindings: selected.bindings.map((binding) => ({ ...binding, replyContextState: 'waiting_for_inbound' })) });
  assert.match(html, /等待用户首条消息/);
  assert.match(html, /role="status"[^>]*>请让当前绑定用户先在微信中向本平台发送一条消息/);
  assert.match(html, /<select[^>]*disabled=""/);
  assert.match(html, /<textarea[^>]*disabled=""[^>]*>保留草稿/);
  assert.match(html, /已保存的历史/);
  for (const label of ['发送文本', '开始输入状态', '取消输入状态']) {
    assert.match(html, new RegExp(`<button[^>]*disabled=""[^>]*>${label}`));
  }
  assert.doesNotMatch(html, /允许手动发送|可手动发送文本|context_token|waiting_for_inbound/);
});

test('inactive inbox disables composing and both typing actions', () => {
  const html = render({ draft: '保留草稿', typing: true }, false);
  assert.match(html, /<textarea[^>]*disabled=""[^>]*>保留草稿/);
  for (const label of ['发送文本', '开始输入状态', '取消输入状态']) {
    assert.match(html, new RegExp(`<button[^>]*disabled=""[^>]*>${label}`));
  }
});

test('binding list errors disable composing and both typing actions', () => {
  const html = render({ draft: '保留草稿', typing: true, bindingsError: '绑定状态不可用' });
  assert.match(html, /<textarea[^>]*disabled=""[^>]*>保留草稿/);
  for (const label of ['发送文本', '开始输入状态', '取消输入状态']) {
    assert.match(html, new RegExp(`<button[^>]*disabled=""[^>]*>${label}`));
  }
});

test('a waiting binding does not disable an independently ready selected binding', () => {
  const html = render({ bindingId: 'ready-owner', draft: '可发送', bindings: [
    ...selected.bindings.map((binding) => ({ ...binding, replyContextState: 'waiting_for_inbound' as const })),
    ...selected.bindings.map((binding) => ({ ...binding, ownerIlinkUserId: 'ready-owner' })),
  ] });
  assert.match(html, /<textarea(?![^>]*disabled)/);
  assert.match(html, /<button(?![^>]*disabled)[^>]*>发送文本/);
  assert.match(html, /<button(?![^>]*disabled)[^>]*>开始输入状态/);
  assert.doesNotMatch(html, /请让当前绑定用户/);
});

test('exposes loading, empty, errors and scroll-pagination state without hiding messages', () => {
  assert.match(render({ messagesLoading: true }), /正在加载消息/);
  assert.match(render(), /暂无已保存消息/);
  assert.match(render({ messagesError: '消息暂不可用' }), /role="alert"/);
  assert.match(render({ hasMore: true, nextCursor: 'older' }), /wechat-history-sentinel/);
  assert.match(render({ sending: 'media' }), /正在上传/);
  assert.doesNotMatch(render({ sending: 'media' }), /[0-9]+%/);
});

test('does not render standalone local Conversation UI or a fake disabled local-chat composer', () => {
  const html = render();
  assert.doesNotMatch(html, /本地对话|创建本地对话|wechat-send-blocked/);
  assert.doesNotMatch(html, /联系人消息/);
});

test('binding rows expose unlink without check controls or transient check labels', () => {
  const html = render();
  assert.doesNotMatch(html, /核验|本地校验|尚未核验|需要重新扫码|绑定已变更/);
  assert.match(html, /<button type="button" class="ghost">解除本地绑定<\/button>/);
  assert.doesNotMatch(html, /<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/);
});

test('actual relogin connection state remains visible with saved history and a read-only draft', () => {
  const html = render({ draft: '保留草稿', bindings: selected.bindings.map((binding) => ({ ...binding,
    connectionState: 'relogin_required', canSend: false })), messages: [
    { id: messageId, sequence: 1, createdAt: date, direction: 'inbound', kind: 'text', state: 'received', text: '仍可查看的历史', items: [] },
  ] });

  assert.match(html, /需要重新扫码 · 只读/);
  assert.match(html, /仍可查看的历史/);
  assert.match(html, /<textarea[^>]*disabled=""[^>]*>保留草稿/);
});

test('missing selected summary keeps saved messages and draft visible as read-only', () => {
  const html = render({ bindings: [], draft: '保留所选绑定草稿', messages: [
    { id: messageId, sequence: 1, createdAt: date, direction: 'inbound', kind: 'text', state: 'received', text: '仍可查看的历史', items: [] },
  ] });

  assert.match(html, /仍可查看的历史/);
  assert.match(html, /<textarea[^>]*disabled=""[^>]*>保留所选绑定草稿/);
  assert.match(html, /当前绑定为只读状态/);
});
