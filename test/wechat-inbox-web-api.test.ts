import assert from 'node:assert/strict';
import test from 'node:test';
import { inboxApi, InboxApiError, attachmentUrl } from '../src/web/wechat-inbox/api.js';

const messageId = '11111111-1111-4111-8111-111111111111';
const target = 'owner /?#';
const base = '/api/wechat-inbox/bindings/owner%20%2F%3F%23';
const signal = new AbortController().signal;
const binding = { ownerIlinkUserId: target, botId: 'bot', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', connectionState: 'polling', canSend: true, replyContextState: 'ready' };

test('projects safe binding fields using the protected same-origin endpoint', async (context) => {
  context.mock.method(globalThis, 'fetch', async (path: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(path, '/api/wechat-inbox/bindings');
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(init?.cache, 'no-store');
    assert.equal(init?.signal, signal);
    return Response.json([{ ...binding, botToken: 'private', context_token: 'private' }]);
  });
  assert.deepEqual(await inboxApi.bindings(signal), [binding]);
});

for (const replyContextState of ['waiting_for_inbound', 'ready']) {
  test(`parses the required ${replyContextState} reply context independently of lifecycle permission`, async (context) => {
    const summary = { ...binding, canSend: false, replyContextState };
    context.mock.method(globalThis, 'fetch', async () => Response.json([summary]));
    assert.deepEqual(await inboxApi.bindings(signal), [summary]);
  });
}

for (const replyContextState of [undefined, null, '', 'waiting', 'READY', true, 1, {}]) {
  test(`rejects missing or invalid reply context ${JSON.stringify(replyContextState)}`, async (context) => {
    context.mock.method(globalThis, 'fetch', async () => Response.json([{ ...binding, replyContextState }]));
    await assert.rejects(inboxApi.bindings(signal), InboxApiError);
  });
}

test('reports missing binding context for both sending and typing', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'wechat_inbox_context_required' }, { status: 409 }));

  for (const operation of [() => inboxApi.send(target, { kind: 'text', text: 'hello' }, signal),
    () => inboxApi.typing(target, 'typing', signal), () => inboxApi.typing(target, 'cancel', signal)]) {
    await assert.rejects(operation(), (error: unknown) => {
      assert.ok(error instanceof InboxApiError);
      assert.equal(error.status, 409);
      assert.equal(error.outcome, 'failed');
      assert.equal(error.code, 'wechat_inbox_context_required');
      assert.match(error.message, /当前绑定尚无自己的入站消息上下文/);
      return true;
    });
  }
});

test('uses the binding-only path and opaque encoded before pagination', async (context) => {
  const paths: string[] = [];
  context.mock.method(globalThis, 'fetch', async (path: RequestInfo | URL) => {
    paths.push(String(path));
    return Response.json({ items: [], nextCursor: null, hasMore: false });
  });
  await inboxApi.messages(target, { before: 'cursor /?&', limit: 25 }, signal);
  assert.deepEqual(paths, [`${base}/messages?limit=25&before=cursor+%2F%3F%26`]);
});

test('sends text without raw target identifiers and preserves unknown 504 outcomes', async (context) => {
  context.mock.method(globalThis, 'fetch', async (path: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(path, `${base}/messages`);
    assert.equal(init?.body, JSON.stringify({ kind: 'text', text: '原文' }));
    assert.equal(init?.method, 'POST');
    return Response.json({ messageId, state: 'unknown', errorCode: 'send_unknown', token: 'private' }, { status: 504 });
  });
  assert.deepEqual(await inboxApi.send(target, { kind: 'text', text: '原文' }, signal), { messageId, state: 'unknown' });
});

test('uploads real multipart fields without a manufactured content-type or progress', async (context) => {
  const file = new File(['contents'], '报告.txt', { type: 'text/plain' });
  context.mock.method(globalThis, 'fetch', async (_path: RequestInfo | URL, init?: RequestInit) => {
    assert.ok(init?.body instanceof FormData);
    assert.deepEqual([...init.body.keys()], ['kind', 'file', 'fileName', 'mediaType']);
    assert.equal(init.body.get('kind'), 'file');
    assert.equal(init.body.get('fileName'), file.name);
    assert.equal(new Headers(init.headers).has('content-type'), false);
    return Response.json({ messageId, state: 'accepted' }, { status: 202 });
  });
  assert.equal((await inboxApi.send(target, { kind: 'file', file }, signal)).state, 'accepted');
});

test('keeps voice outbound disabled before transport', async (context) => {
  const fetch = context.mock.method(globalThis, 'fetch', async () => Response.json({}));
  await assert.rejects(inboxApi.send(target, { kind: 'voice', file: new File(['voice'], 'voice.wav') }, signal), InboxApiError);
  assert.equal(fetch.mock.callCount(), 0);
});

test('typing handles empty 204 and only sends status', async (context) => {
  context.mock.method(globalThis, 'fetch', async (path: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(path, `${base}/typing`);
    assert.equal(init?.body, '{"status":"cancel"}');
    return new Response(null, { status: 204 });
  });
  await inboxApi.typing(target, 'cancel', signal);
});

test('never reflects raw upstream errors and distinguishes definite rejection from uncertainty', async (context) => {
  for (const [status, outcome] of [[409, 'failed'], [502, 'failed'], [500, 'unknown']] as const) {
    context.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'private-token=https://cdn.example' }, { status }));
    await assert.rejects(inboxApi.send(target, { kind: 'text', text: 'hello' }, signal), (error: unknown) => {
      assert.ok(error instanceof InboxApiError);
      assert.equal(error.outcome, outcome);
      assert.doesNotMatch(error.message, /private|cdn/);
      return true;
    });
  }
});

test('rejects malformed media attachment identifiers instead of rendering external locations', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => Response.json({ items: [{ id: messageId, kind: 'voice', direction: 'inbound', state: 'received', sequence: 1,
    createdAt: binding.createdAt, items: [{ kind: 'voice', attachmentId: 'https://cdn.example/private' }] }], nextCursor: null, hasMore: false }));
  await assert.rejects(inboxApi.messages(target, {}, signal), InboxApiError);
  assert.equal(attachmentUrl(messageId), `/api/wechat-inbox/attachments/${messageId}`);
  assert.throws(() => attachmentUrl('//cdn.example'), InboxApiError);
});

test('treats an unreadable successful send receipt as unknown, never a definite failure', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => Response.json({ state: 'accepted' }, { status: 202 }));
  await assert.rejects(inboxApi.send(target, { kind: 'text', text: 'hello' }, signal), (error: unknown) =>
    error instanceof InboxApiError && error.outcome === 'unknown');
});
