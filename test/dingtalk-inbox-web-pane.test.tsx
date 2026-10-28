import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InboxView } from '../src/web/dingtalk-inbox/InboxPane.js';
import { createDingtalkInboxLoader, INITIAL_DINGTALK_INBOX_STATE, targetKey } from '../src/web/dingtalk-inbox/loader.js';
import type { Target } from '../src/web/dingtalk-inbox/api.js';

const people = [{ userId: 'first', displayName: '同名人员', department: '产品' }, { userId: 'second', displayName: '同名人员', department: '研发' }];
const emptyActive = { activeTarget: null, listeningDesired: false, subscriptionState: null };
const receipt = (target: Target) => ({ subscriptionId: 'generation-1', targetType: target.targetType, targetId: target.targetId, state: 'starting' });

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Deferred promise not initialized'); };
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function elements(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap((child: unknown) => elements(child));
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children)];
}

function harness(context: TestContext, handler?: (path: string, init?: RequestInit) => Promise<Response>) {
  const writes: Target[] = [];
  context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (handler) return handler(path, init);
    if (path.endsWith('/capability')) return Response.json({ available: true, reason: '' });
    if (path.endsWith('/active-target')) {
      if (init?.method !== 'PUT') return Response.json(emptyActive);
      const target: Target = JSON.parse(String(init.body));
      writes.push(target);
      return Response.json(receipt(target), { status: 202 });
    }
    return Response.json({ complete: true, items: path.includes('/groups/') ? [{ openConversationId: 'second', displayName: '项目群' }] : people });
  });
  let state = INITIAL_DINGTALK_INBOX_STATE;
  const loader = createDingtalkInboxLoader((next) => { state = next; });
  context.after(() => loader.setActive(false));
  const view = () => InboxView({ state, loader });
  return {
    loader, writes, state: () => state, html: () => renderToStaticMarkup(view()),
    control: (name: string, value: string) => {
      const element = elements(view()).find((item) => item.props[name] === value);
      assert.ok(element, `Missing rendered control ${name}=${value}`);
      return element;
    },
  };
}

async function dispatch(element: ReactElement<Record<string, unknown>>, event: string, value?: string) {
  const handler = element.props[event];
  assert.equal(typeof handler, 'function');
  if (typeof handler === 'function') await handler({ preventDefault() {}, currentTarget: { value } });
}

test('rendered search submits no selection and explicitly choosing the second person submits its stable ID', async (context) => {
  const rig = harness(context);
  await rig.loader.setActive(true);
  await dispatch(rig.control('name', 'query'), 'onChange', '同名');
  await dispatch(rig.control('aria-label', '搜索钉钉目标'), 'onSubmit');
  assert.equal(rig.writes.length, 0);
  assert.equal(rig.state().activeTarget, null);
  assert.match(rig.html(), /产品/);
  assert.match(rig.html(), /研发/);
  await dispatch(rig.control('data-target-key', targetKey({ targetType: 'person', targetId: 'second' })), 'onClick');
  assert.deepEqual(rig.writes, [{ targetType: 'person', targetId: 'second', displayName: '同名人员' }]);
  assert.match(rig.html(), /aria-pressed="true"/);
  assert.match(rig.html(), /正在启动/);
  assert.doesNotMatch(rig.html(), /监听状态：监听已就绪/);
});

test('rendered type control clears old candidates and distinguishes a group from a person with the same ID', async (context) => {
  const rig = harness(context);
  await rig.loader.setActive(true);
  rig.loader.setQuery('项目');
  await rig.loader.search();
  await rig.loader.select(targetKey({ targetType: 'person', targetId: 'second' }));
  await dispatch(rig.control('name', 'kind'), 'onChange', 'group');
  assert.equal(rig.state().items.length, 0);
  await rig.loader.search();
  const group = rig.control('data-target-key', targetKey({ targetType: 'group', targetId: 'second' }));
  assert.equal(group.props['aria-pressed'], false);
  assert.match(rig.html(), /群聊/);
  await dispatch(group, 'onClick');
  assert.equal(rig.writes[1]?.targetType, 'group');
});

test('a single incomplete candidate is visibly incomplete and cannot be selected even through the loader', async (context) => {
  let puts = 0;
  const rig = harness(context, async (path, init) => {
    if (init?.method === 'PUT') { puts++; return Response.json(receipt({ targetType: 'person', targetId: 'first', displayName: '同名人员' })); }
    return Response.json(path.endsWith('/capability') ? { available: true, reason: '' }
      : path.endsWith('/active-target') ? emptyActive : { complete: false, items: [people[0]] });
  });
  await rig.loader.setActive(true);
  rig.loader.setQuery('同名');
  await rig.loader.search();
  assert.equal(rig.state().searchStatus, 'incomplete');
  assert.match(rig.html(), /结果不完整/);
  assert.equal(rig.control('data-target-key', targetKey({ targetType: 'person', targetId: 'first' })).props.disabled, true);
  await rig.loader.select(targetKey({ targetType: 'person', targetId: 'first' }));
  assert.equal(puts, 0);
  assert.equal(rig.state().activeTarget, null);
});

test('latest search wins when an aborted fake transport still resolves with stale candidates', async (context) => {
  const older = deferred<Response>();
  let olderSignal: AbortSignal | null | undefined;
  const rig = harness(context, async (path, init) => {
    if (path.endsWith('/capability')) return Response.json({ available: true, reason: '' });
    if (path.endsWith('/active-target')) return Response.json(emptyActive);
    if (path.endsWith('query=old')) { olderSignal = init?.signal; return older.promise; }
    return Response.json({ complete: true, items: [people[1]] });
  });
  await rig.loader.setActive(true);
  rig.loader.setQuery('old');
  const pending = rig.loader.search();
  assert.match(rig.html(), /正在搜索/);
  rig.loader.setQuery('new');
  await rig.loader.search();
  assert.equal(olderSignal?.aborted, true);
  older.resolve(Response.json({ complete: true, items: [people[0]] }));
  await pending;
  assert.deepEqual(rig.state().items.map((item) => item.targetId), ['second']);
  assert.doesNotMatch(rig.html(), /产品/);
});

test('leaving the pane aborts requests, removes identity-scoped state and ignores late results', async (context) => {
  const pending = deferred<Response>();
  let searchSignal: AbortSignal | null | undefined;
  const rig = harness(context, async (path, init) => {
    if (path.endsWith('/capability')) return Response.json({ available: true, reason: '' });
    if (path.endsWith('/active-target')) return Response.json(emptyActive);
    searchSignal = init?.signal;
    return pending.promise;
  });
  await rig.loader.setActive(true);
  rig.loader.setQuery('同名');
  const searching = rig.loader.search();
  await rig.loader.setActive(false);
  pending.resolve(Response.json({ complete: true, items: people }));
  await searching;
  assert.equal(searchSignal?.aborted, true);
  assert.deepEqual(rig.state(), INITIAL_DINGTALK_INBOX_STATE);
});

test('empty results and search failures are distinct rendered states', async (context) => {
  let failure = false;
  const rig = harness(context, async (path) => {
    if (path.endsWith('/capability')) return Response.json({ available: true, reason: '' });
    if (path.endsWith('/active-target')) return Response.json(emptyActive);
    if (failure) throw new TypeError('Bearer private');
    return Response.json({ complete: true, items: [] });
  });
  await rig.loader.setActive(true);
  rig.loader.setQuery('名字');
  await rig.loader.search();
  assert.equal(rig.state().searchStatus, 'empty');
  assert.match(rig.html(), /未找到/);
  failure = true;
  await rig.loader.search();
  assert.equal(rig.state().searchStatus, 'error');
  assert.match(rig.html(), /role="alert"/);
  assert.doesNotMatch(rig.html(), /private|未找到/);
});

test('unavailable capability and absent optional proxy disable search with safe recovery feedback', async (context) => {
  let absent = false;
  const rig = harness(context, async () => absent ? new Response('private', { status: 404 }) : Response.json({ available: false, reason: 'private-profile' }));
  await rig.loader.setActive(true);
  assert.equal(rig.control('name', 'query').props.disabled, true);
  assert.match(rig.html(), /不可用/);
  assert.doesNotMatch(rig.html(), /private/);
  absent = true;
  await rig.loader.refresh();
  assert.match(rig.html(), /role="alert"/);
  assert.equal(rig.control('name', 'kind').props.disabled, true);
});

test('failed selection does not claim a target, and concurrent clicks cannot submit twice', async (context) => {
  const selection = deferred<Response>();
  let puts = 0;
  const rig = harness(context, async (path, init) => {
    if (path.endsWith('/capability')) return Response.json({ available: true, reason: '' });
    if (path.endsWith('/active-target')) {
      if (init?.method !== 'PUT') return Response.json(emptyActive);
      puts++;
      return selection.promise;
    }
    return Response.json({ complete: true, items: people });
  });
  await rig.loader.setActive(true);
  rig.loader.setQuery('名字');
  await rig.loader.search();
  const key = targetKey({ targetType: 'person', targetId: 'second' });
  const selecting = rig.loader.select(key);
  assert.equal(rig.control('data-target-key', key).props.disabled, true);
  assert.match(rig.html(), /正在选择/);
  await rig.loader.select(key);
  selection.resolve(new Response('private', { status: 400 }));
  await selecting;
  assert.equal(puts, 1);
  assert.equal(rig.state().activeTarget, null);
  assert.match(rig.html(), /role="alert"/);
  assert.doesNotMatch(rig.html(), /private|aria-pressed="true"/);
});

test('restores only the server-confirmed active target, never a search-order guess', async (context) => {
  const activeTarget = { targetType: 'group', targetId: 'saved', displayName: '<script>保存目标</script>' } as const;
  const rig = harness(context, async (path) => Response.json(path.endsWith('/capability') ? { available: true, reason: '' }
    : { activeTarget, listeningDesired: true, subscriptionState: { ...receipt(activeTarget), state: 'interrupted' } }));
  await rig.loader.setActive(true);
  assert.deepEqual(rig.state().activeTarget, activeTarget);
  assert.match(rig.html(), /已中断/);
  assert.match(rig.html(), /&lt;script&gt;/);
  assert.doesNotMatch(rig.html(), /<script>/);
});

test('empty queries and foreign candidate IDs never reach search or selection transport', async (context) => {
  const rig = harness(context);
  await rig.loader.setActive(true);
  rig.loader.setQuery('   ');
  await rig.loader.search();
  assert.equal(rig.state().searchStatus, 'idle');
  rig.loader.setQuery('同名');
  await rig.loader.search();
  await rig.loader.select(targetKey({ targetType: 'person', targetId: 'foreign-profile-user' }));
  assert.equal(rig.writes.length, 0);
  assert.equal(rig.state().activeTarget, null);
});

test('a late selection receipt from a previous activation cannot overwrite a different restored identity', async (context) => {
  const pending = deferred<Response>();
  const restored = { targetType: 'group', targetId: 'new-profile-group', displayName: '新身份群' } as const;
  let newProfile = false;
  let selectionSignal: AbortSignal | null | undefined;
  const rig = harness(context, async (path, init) => {
    if (path.endsWith('/capability')) return Response.json({ available: true, reason: '' });
    if (path.endsWith('/active-target')) {
      if (init?.method === 'PUT') { selectionSignal = init.signal; return pending.promise; }
      return Response.json(newProfile ? { activeTarget: restored, listeningDesired: true, subscriptionState: receipt(restored) } : emptyActive);
    }
    return Response.json({ complete: true, items: people });
  });
  await rig.loader.setActive(true);
  rig.loader.setQuery('同名');
  await rig.loader.search();
  const selecting = rig.loader.select(targetKey({ targetType: 'person', targetId: 'second' }));
  await rig.loader.setActive(false);
  newProfile = true;
  await rig.loader.setActive(true);
  pending.resolve(Response.json(receipt({ targetType: 'person', targetId: 'second', displayName: '同名人员' })));
  await selecting;
  assert.equal(selectionSignal?.aborted, true);
  assert.deepEqual(rig.state().activeTarget, restored);
  assert.equal(rig.state().items.length, 0);
  assert.equal(rig.state().selecting, false);
});
