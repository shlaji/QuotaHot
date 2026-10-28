import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createInboxLoader } from '../src/web/wechat-inbox/loader.js';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const date = '2026-01-01T00:00:00Z';
const bindings = ['owner-a', 'owner-b'].map((ownerIlinkUserId) => ({ ownerIlinkUserId, botId: 'bot', createdAt: date,
  updatedAt: date, connectionState: 'polling', canSend: true, replyContextState: 'ready' }));
const message = (id: string, sequence: number) => ({ id, sequence, direction: 'inbound', kind: 'text', state: 'received', createdAt: date, text: '原文', items: [] });
const page = (items: object[] = [], nextCursor: string | null = null) => Response.json({ items, nextCursor, hasMore: nextCursor !== null });
function deferred() {
  let resolve: (value: Response) => void = () => { throw new Error('not ready'); };
  const promise = new Promise<Response>((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}
function setup(context: test.TestContext, reply?: (path: string, init?: RequestInit) => Response | Promise<Response>) {
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/bindings')) return Response.json(bindings);
    return reply?.(path, init) ?? page();
  });
  const loader = createInboxLoader(() => {});
  context.after(() => loader.setActive(false));
  return loader;
}
async function select(loader: ReturnType<typeof createInboxLoader>, bindingId = 'owner-a') {
  loader.setActive(true);
  await setImmediate();
  await loader.selectBinding(bindingId);
}

test('selecting a binding directly requests its history and drops stale results after switching', async (context) => {
  const pending = deferred();
  let firstSignal: AbortSignal | null | undefined;
  const loader = setup(context, (path, init) => {
    if (path.includes('/bindings/owner-a/messages')) { firstSignal = init?.signal; return pending.promise; }
    if (path.includes('/bindings/owner-b/messages')) return page([message(second, 2)]);
    return page();
  });
  loader.setActive(true);
  await setImmediate();
  const old = loader.selectBinding('owner-a');
  await loader.selectBinding('owner-b');
  pending.resolve(page([message(first, 1)]));
  await old;
  assert.equal(firstSignal?.aborted, true);
  assert.equal(loader.getState().bindingId, 'owner-b');
  assert.deepEqual(loader.getState().messages.map((item) => item.id), [second]);
});

test('merges older binding history by sequence without duplicates', async (context) => {
  const loader = setup(context, (path) => path.includes('before=older')
    ? page([message(first, 1), message(second, 2)]) : page([message(second, 2)], 'older'));
  await select(loader);
  await loader.loadMore();
  assert.deepEqual(loader.getState().messages.map((item) => item.sequence), [1, 2]);
  assert.equal(loader.getState().hasMore, false);
});

test('keeps drafts scoped to QR binding and does not invent outbound history', async (context) => {
  const loader = setup(context, (_path, init) => init?.method === 'POST'
    ? Response.json({ messageId: first, state: 'accepted' }, { status: 202 }) : page());
  await select(loader, 'owner-a');
  loader.setDraft('甲草稿');
  await loader.selectBinding('owner-b');
  assert.equal(loader.getState().draft, '');
  loader.setDraft('乙草稿');
  await loader.selectBinding('owner-a');
  assert.equal(loader.getState().draft, '甲草稿');
  await loader.send({ kind: 'text', text: '甲草稿' });
  assert.equal(loader.getState().outcome, 'accepted');
  assert.equal(loader.getState().draft, '');
  assert.deepEqual(loader.getState().messages, []);
});

test('blocks duplicate in-flight sends and keeps unknown drafts for human checking', async (context) => {
  const pending = deferred();
  let posts = 0;
  const loader = setup(context, (_path, init) => {
    if (init?.method === 'POST') { posts++; return pending.promise; }
    return page();
  });
  await select(loader);
  loader.setDraft('待核对');
  const sending = loader.send({ kind: 'text', text: '待核对' });
  await loader.send({ kind: 'text', text: '待核对' });
  pending.resolve(Response.json({ messageId: first, state: 'unknown' }, { status: 504 }));
  await sending;
  assert.equal(posts, 1);
  assert.equal(loader.getState().outcome, 'unknown');
  assert.equal(loader.getState().draft, '待核对');
});

test('deactivation aborts pending sends and prevents late status overwrite', async (context) => {
  const pending = deferred();
  let sendSignal: AbortSignal | null | undefined;
  const loader = setup(context, (_path, init) => {
    if (init?.method === 'POST') { sendSignal = init.signal; return pending.promise; }
    return page();
  });
  await select(loader);
  const sending = loader.send({ kind: 'text', text: 'hello' });
  loader.setActive(false);
  assert.equal(sendSignal?.aborted, true);
  assert.equal(loader.getState().outcome, 'unknown');
  pending.resolve(Response.json({ messageId: first, state: 'accepted' }, { status: 202 }));
  await sending;
  assert.equal(loader.getState().outcome, 'unknown');
});

test('retains binding draft after reactivating the same selection', async (context) => {
  const loader = setup(context);
  await select(loader);
  loader.setDraft('未提交草稿');
  loader.setActive(false);
  loader.setActive(true);
  await setImmediate();
  assert.equal(loader.getState().bindingId, 'owner-a');
  assert.equal(loader.getState().draft, '未提交草稿');
});

test('refresh after unlink preserves selected history and draft even when its summary disappears', async (context) => {
  const loader = setup(context, () => page([message(first, 1)]));
  await select(loader);
  loader.setDraft('解绑后保留');
  context.mock.method(globalThis, 'fetch', async () => Response.json([]));

  await loader.refresh();

  assert.equal(loader.getState().bindingId, 'owner-a');
  assert.equal(loader.getState().draft, '解绑后保留');
  assert.deepEqual(loader.getState().messages.map((item) => item.id), [first]);
});

test('does not send local conversation requests while refreshing and changing bindings', async (context) => {
  const requests: string[] = [];
  const loader = setup(context, (path) => { requests.push(path); return page(); });
  await select(loader, 'owner-a');
  await loader.selectBinding('owner-b');
  assert.ok(requests.some((path) => path.includes('/bindings/owner-a/messages')));
  assert.ok(requests.some((path) => path.includes('/bindings/owner-b/messages')));
  assert.equal(requests.some((path) => path.includes('/contacts') || path.includes('/conversations')), false);
});

test('keeps history and draft without sending or typing when selected binding lacks context', async (context) => {
  const posts: string[] = [];
  const loader = setup(context);
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') posts.push(String(input));
    return String(input).endsWith('/bindings') ? Response.json(bindings.map((binding, index) =>
      ({ ...binding, replyContextState: index === 0 ? 'waiting_for_inbound' : 'ready' }))) : page([message(first, 1)]);
  });
  await select(loader);
  loader.setDraft('保留草稿');

  await loader.send({ kind: 'text', text: '保留草稿' });
  for (const kind of ['image', 'file', 'video', 'voice'] as const) await loader.send({ kind, file: new File(['draft'], 'draft.dat') });
  await loader.typing('typing');
  await loader.typing('cancel');

  assert.deepEqual(posts, []);
  assert.equal(loader.getState().draft, '保留草稿');
  assert.equal(loader.getState().messages[0]?.id, first);
});

test('sends and updates typing for a ready selection independently of a waiting sibling', async (context) => {
  const posts: { path: string; body: BodyInit | null | undefined }[] = [];
  const loader = setup(context);
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/bindings')) return Response.json(bindings.map((binding, index) =>
      ({ ...binding, replyContextState: index === 0 ? 'waiting_for_inbound' : 'ready' })));
    if (init?.method === 'POST') {
      posts.push({ path, body: init.body });
      return path.endsWith('/typing') ? new Response(null, { status: 204 })
        : Response.json({ messageId: second, state: 'accepted' }, { status: 202 });
    }
    return page();
  });
  await select(loader, 'owner-b');
  loader.setDraft('可发送草稿');

  await loader.typing('typing');
  assert.equal(loader.getState().typing, true);
  await loader.typing('cancel');
  assert.equal(loader.getState().typing, false);
  await loader.send({ kind: 'text', text: '可发送草稿' });

  assert.deepEqual(posts, [
    { path: '/api/wechat-inbox/bindings/owner-b/typing', body: '{"status":"typing"}' },
    { path: '/api/wechat-inbox/bindings/owner-b/typing', body: '{"status":"cancel"}' },
    { path: '/api/wechat-inbox/bindings/owner-b/messages', body: '{"kind":"text","text":"可发送草稿"}' },
  ]);
  assert.equal(loader.getState().outcome, 'accepted');
  assert.equal(loader.getState().draft, '');
});

test('does not send a queued typing cancellation after selected binding loses its context', async (context) => {
  const pendingTyping = deferred();
  let contextReady = true;
  const posts: string[] = [];
  const loader = setup(context);
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/bindings')) return Response.json(bindings.map((binding) => ({ ...binding,
      replyContextState: contextReady ? 'ready' : 'waiting_for_inbound' })));
    if (init?.method === 'POST') {
      posts.push(String(init.body));
      return String(init.body) === '{"status":"typing"}' ? pendingTyping.promise : new Response(null, { status: 204 });
    }
    return page();
  });
  await select(loader);

  const typing = loader.typing('typing');
  await setImmediate();
  assert.deepEqual(posts, ['{"status":"typing"}']);
  const cancel = loader.typing('cancel');

  contextReady = false;
  await loader.refresh();
  assert.equal(loader.getState().bindings.find((binding) => binding.ownerIlinkUserId === 'owner-a')?.replyContextState,
    'waiting_for_inbound');
  pendingTyping.resolve(new Response(null, { status: 204 }));
  await Promise.all([typing, cancel]);

  assert.deepEqual(posts, ['{"status":"typing"}']);
  assert.equal(loader.getState().typing, false);
});
