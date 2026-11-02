import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { bindings, createInboxHarness, options, type InboxHarness } from './helpers/wechat-inbox-web.js';

let harness: InboxHarness;
before(async () => { if (!options.skip) harness = await createInboxHarness(); });
after(async () => { await harness?.browser.close(); });

for (const width of [390, 1440, 1920]) {
test(`history scrolling loads older messages and preserves the visible message anchor at ${width}px`, options, async (context) => {
  const page = await harness.browser.newPage({ viewport: { width, height: 900 } });
  context.after(() => page.close());
  const errors: string[] = [];
  const requests = await harness.open(page);
  page.on('pageerror', (error) => errors.push(error.message));
  const history = page.getByLabel('消息历史，向上滚动加载更早消息');
  assert.equal(await history.evaluate((element) => getComputedStyle(element).overflowY), 'auto');
  assert.equal(requests.filter((path) => path.includes('before=')).length, 0);
  await history.evaluate((element) => new Promise<void>((resolve) => {
    element.addEventListener('scroll', () => resolve(), { once: true });
    element.scrollTop = element.scrollHeight;
  }));
  const video = history.locator('video').last();
  assert.equal(await video.count(), 1);
  const firstMessage = page.locator('.wechat-messages > li').first();
  const response = Promise.withResolvers<void>();
  context.after(() => response.resolve());
  await page.route((url) => url.pathname.endsWith('/messages') && url.searchParams.get('before') === 'older',
    async (route) => { await response.promise; return route.fallback(); });
  const requested = page.waitForRequest((request) => request.url().includes('before=older'));
  await history.evaluate((element) => { element.scrollTop = 0; });
  await requested;
  await page.getByText('正在加载消息…', { exact: true }).waitFor();
  const anchorTop = await firstMessage.evaluate((element) => element.getBoundingClientRect().top - (element.closest('.wechat-history')?.getBoundingClientRect().top ?? 0));
  response.resolve();
  await page.getByText('更早消息 1', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('已保存的绑定消息').locator(':scope > li').count(), 21);
  await page.getByText('正在加载消息…', { exact: true }).waitFor({ state: 'detached' });
  const retained = page.getByText('<script>上游内容只能作为文本显示</script>', { exact: true }).locator('..');
  assert.ok(Math.abs(await retained.evaluate((element) => element.getBoundingClientRect().top - (element.closest('.wechat-history')?.getBoundingClientRect().top ?? 0)) - anchorTop) < 2,
    'prepending older items must preserve the visible message position, including loading feedback removal');
  for (const [index, expectedCount] of [[2, 22], [3, 23]] as const) {
    await history.evaluate((element) => new Promise<void>((resolve) => {
      element.addEventListener('scroll', () => resolve(), { once: true });
      element.scrollTop = element.scrollHeight;
    }));
    await history.evaluate((element) => { element.scrollTop = 0; });
    await page.getByText(`更早消息 ${index}`, { exact: true }).waitFor();
    await page.getByText('正在加载消息…', { exact: true }).waitFor({ state: 'detached' });
    assert.ok(requests.some((path) => path.includes(`before=older-${index}`)), `missing page ${index}: ${JSON.stringify(requests)}`);
    assert.equal(await page.getByLabel('已保存的绑定消息').locator(':scope > li').count(), expectedCount);
  }
  await page.getByRole('button', { name: /另一绑定.*另一机器人/ }).click();
  await page.getByRole('button', { name: /另一绑定.*另一机器人/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: /另一绑定.*另一机器人/ }).getAttribute('aria-current'), 'true');
  assert.equal(requests.some((path) => path.includes('/contacts') || path.includes('/conversations')), false);
  assert.doesNotMatch(await page.locator('body').innerText(), /本地对话|联系人消息/);
  assert.deepEqual(errors, []);
});
}

for (const editPending of ['none', 'different', 'same'] as const) {
  test(`accepted send handles pending draft edit: ${editPending}`, options, async (context) => {
    const page = await harness.browser.newPage();
    context.after(() => page.close());
    await harness.open(page, bindings, { emptyHistory: true });
    const response = Promise.withResolvers<void>();
    context.after(() => response.resolve());
    await page.route('**/api/wechat-inbox/**/messages', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await response.promise;
      return route.fulfill({ status: 202, json: { messageId: harness.first, state: 'accepted' } });
    });
    const input = page.getByLabel('消息正文');
    await input.fill('原消息');
    const request = page.waitForRequest((item) => item.method() === 'POST' && item.url().endsWith('/messages'));
    await page.getByRole('button', { name: '发送文本' }).click();
    await request;
    if (editPending !== 'none') {
      assert.equal(await input.isEnabled(), true);
      await input.fill('发送期间的新草稿');
      if (editPending === 'same') await input.fill('原消息');
    }
    response.resolve();
    await page.getByRole('status').filter({ hasText: '请求已接受' }).waitFor();
    assert.equal(await input.inputValue(), editPending === 'none' ? '' : editPending === 'same' ? '原消息' : '发送期间的新草稿');
  });
}

test('sends manually, keeps unknown for user checking and cancels typing', options, async (context) => {
  const page = await harness.browser.newPage();
  context.after(() => page.close());
  const posts: { path: string; body: string | null }[] = [];
  await harness.open(page);
  await page.route('**/api/wechat-inbox/**/typing', (route) => {
    posts.push({ path: 'typing', body: route.request().postData() });
    return route.fulfill({ status: 204 });
  });
  await page.route('**/api/wechat-inbox/**/messages', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    posts.push({ path: 'messages', body: route.request().postData() });
    return route.fulfill({ status: 504, json: { messageId: harness.first, state: 'unknown' } });
  });
  await page.getByLabel('消息正文').fill('手动文本');
  await page.getByRole('button', { name: '开始输入状态' }).click();
  await page.getByText('已请求显示正在输入').waitFor();
  await page.getByRole('button', { name: '取消输入状态' }).click();
  await page.getByRole('button', { name: '开始输入状态' }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '发送文本', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '结果未知' }).waitFor();
  assert.equal(await page.getByLabel('消息正文').inputValue(), '手动文本');
  assert.equal(posts.filter((item) => item.path === 'messages').length, 1);
  assert.deepEqual(posts.filter((item) => item.path === 'typing').map((item) => JSON.parse(item.body ?? '{}').status), ['typing', 'cancel']);
});

test('preserves the composer after a confirmed send failure', options, async (context) => {
  const page = await harness.browser.newPage();
  context.after(() => page.close());
  await harness.open(page, bindings, { emptyHistory: true });
  await page.route('**/api/wechat-inbox/**/messages', (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 502, json: { error: 'send_failed' } }) : route.fallback());
  const input = page.getByLabel('消息正文');
  await input.fill('发送失败保留');
  await page.getByRole('button', { name: '发送文本' }).click();
  await page.getByRole('alert').filter({ hasText: '发送失败' }).waitFor();
  assert.equal(await input.inputValue(), '发送失败保留');
});

test('refreshes reply readiness after an inbound message without enabling another waiting binding', options, async (context) => {
  const page = await harness.browser.newPage();
  context.after(() => page.close());
  await page.clock.install();
  const summaries = bindings.map((binding, index) => ({ ...binding,
    replyContextState: index < 2 ? 'waiting_for_inbound' : binding.replyContextState }));
  await harness.open(page, summaries, { emptyHistory: true });
  assert.equal(await page.getByLabel('消息正文').isDisabled(), true);

  const selected = summaries[0];
  assert.ok(selected);
  selected.replyContextState = 'ready';
  const refreshed = page.waitForResponse((response) => response.url().endsWith('/api/wechat-inbox/bindings'), { timeout: 2_000 });
  await page.clock.fastForward(5_000);
  await refreshed;
  await page.locator('textarea:enabled').waitFor({ timeout: 2_000 });
  assert.equal(await page.getByLabel('消息正文').isEnabled(), true);
  await page.getByRole('button', { name: /另一绑定.*正在接收/ }).click();
  assert.equal(await page.getByLabel('消息正文').isDisabled(), true);
});

for (const waitingIndex of [0, 1]) {
  test(`binding ${waitingIndex} waits independently, preserves drafts and disables media and typing until ready`, options, async (context) => {
    const page = await harness.browser.newPage();
    context.after(() => page.close());
    const summaries = bindings.map((binding) => ({ ...binding }));
    const waiting = summaries[waitingIndex];
    const ready = summaries[1 - waitingIndex];
    assert.ok(waiting && ready);
    const requests = await harness.open(page, summaries);
    const choose = (owner: string) => page.getByRole('button', { name: new RegExp(`${owner}.*正在接收`) }).click();
    await choose(waiting.ownerIlinkUserId);
    await page.getByLabel('消息正文').fill('当前绑定草稿');
    for (const kind of ['image', 'file', 'video']) {
      await page.getByLabel('发送类型').selectOption(kind);
      await page.locator('input[type=file]').setInputFiles({ name: 'draft.dat', mimeType: 'application/octet-stream', buffer: Buffer.from('draft') });
      waiting.replyContextState = 'waiting_for_inbound';
      await page.getByRole('button', { name: '刷新绑定', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '请让当前绑定用户先在微信中向本平台发送一条消息' }).waitFor();
      for (const control of [page.getByLabel('发送类型'), page.locator('input[type=file]'), page.getByRole('button', { name: '上传并发送' }),
        page.getByRole('button', { name: '开始输入状态' }), page.getByRole('button', { name: '取消输入状态' })]) {
        assert.equal(await control.isDisabled(), true);
      }
      assert.equal(await page.locator('input[type=file]').evaluate((input: HTMLInputElement) => input.files?.[0]?.name), 'draft.dat');
      waiting.replyContextState = 'ready';
      await page.getByRole('button', { name: '刷新绑定', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('select')?.disabled);
      assert.equal(await page.getByRole('button', { name: '上传并发送' }).isEnabled(), true);
    }
    await page.getByLabel('发送类型').selectOption('text');
    waiting.replyContextState = 'waiting_for_inbound';
    await page.getByRole('button', { name: '刷新绑定', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '请让当前绑定用户' }).waitFor();
    assert.equal(await page.getByLabel('消息正文').isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '发送文本', exact: true }).isDisabled(), true);
    await choose(ready.ownerIlinkUserId);
    assert.equal(await page.getByLabel('消息正文').isEnabled(), true);
    await page.getByLabel('消息正文').fill('另一绑定草稿');
    assert.equal(await page.getByRole('button', { name: '发送文本', exact: true }).isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: '开始输入状态' }).isEnabled(), true);
    assert.equal(await page.getByRole('status').filter({ hasText: '请让当前绑定用户' }).count(), 0);
    await choose(waiting.ownerIlinkUserId);
    assert.equal(await page.getByLabel('消息正文').inputValue(), '当前绑定草稿');
    assert.equal(await page.getByLabel('消息正文').isDisabled(), true);
    waiting.replyContextState = 'ready';
    await page.getByRole('button', { name: '刷新绑定', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('textarea')?.disabled);
    assert.equal(await page.getByRole('button', { name: '发送文本', exact: true }).isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: '开始输入状态' }).isEnabled(), true);
    assert.equal(await page.locator('option[value=voice]').evaluate((option: HTMLOptionElement) => option.disabled), true);
    assert.equal(requests.some((request) => request.startsWith('POST')), false);
    assert.doesNotMatch(await page.locator('body').innerText(), /context_token|waiting_for_inbound/);
  });
}
