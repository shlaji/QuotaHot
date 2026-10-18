import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TaskSummary } from '../src/shared/tasks.js';
import { TaskCard } from '../src/web/components/TaskCard.js';
import { TaskSessionPanel, TaskSessionView } from '../src/web/components/TaskSessionPanel.js';
import type { TaskSessionLoadState } from '../src/web/task-session-loader.js';

const task: TaskSummary = {
  id: 'task-1', description: 'Run tests', model: 'openai/test', directory: '/work/project',
  trigger: { type: 'quota' }, status: 'succeeded', sessionId: 'ses_root', sessionTitle: null,
  createdAt: 1000, startedAt: 2000, finishedAt: 3000, hasOutput: true, error: '',
};
const ready: Extract<TaskSessionLoadState, { status: 'ready' }> = {
  status: 'ready', fetchedAt: 1_700_000_000_000, taskStatus: 'succeeded',
  transcript: {
    sessionId: 'ses_root', title: '<Root session>', time: { created: 1000, updated: 5000 }, scope: 'root-only',
    messages: [
      { id: 'z-user', role: 'user', time: { created: 2000 }, parts: [
        { id: 'z-text', type: 'text', text: '  用户正文\n<script>literal</script>  ' },
        { id: 'synthetic', type: 'text', text: '内部合成消息', synthetic: true },
      ] },
      { id: 'a-assistant', role: 'assistant', time: { created: 3000, completed: 4500 }, agent: 'build', providerID: 'openai', modelID: 'test-model', parts: [
        { id: 'z-reason', type: 'reasoning', text: '<reasoning>private</reasoning>' },
        { id: 'm-tool', type: 'tool', tool: '<bash>', status: 'error', input: '{\n  "command": "<input>"\n}', output: '', error: '<error>failure</error>' },
        { id: 'a-text', type: 'text', text: '助手正文' },
        { id: 'unsupported', type: 'unsupported', originalType: '<file>' },
      ] },
    ],
  },
};

function renderView(state: TaskSessionLoadState): string {
  return renderToStaticMarkup(createElement(TaskSessionView, { state, onRefresh: () => {} }));
}

function renderCard(selected: TaskSummary): string {
  return renderToStaticMarkup(createElement(TaskCard, {
    task: selected, tasks: [], active: true, busyAction: null, actionError: '',
    onSendMessage: async () => false, onCancel: () => {}, onDelete: () => {},
  }));
}

for (const active of [true, false]) {
  test(`does not fetch or mount transcript content when collapsed and active is ${active}`, (context) => {
    const fetch = context.mock.method(globalThis, 'fetch', async () => { throw new Error('Collapsed session must not fetch'); });

    const html = renderToStaticMarkup(createElement(TaskSessionPanel, { task, active }));

    assert.match(html, /^<details class="task-output task-session"><summary>会话内容<\/summary><\/details>$/);
    assert.equal(fetch.mock.callCount(), 0);
  });
}

for (const status of ['pending', 'running', 'succeeded', 'failed', 'cancelled'] as const) {
  test(`keeps native session and per-run output separate when a ${status} task has a session`, () => {
    const html = renderCard({ ...task, status });

    assert.match(html, /<details class="task-output task-session"><summary>会话内容<\/summary><\/details>/);
    assert.match(html, /<details class="task-output"><summary>查看输出<\/summary><\/details>/);
    assert.doesNotMatch(html, /<pre|会话消息/);
  });
}

for (const sessionId of [null, '', '   ']) {
  test(`omits the session disclosure but preserves output when sessionId is ${JSON.stringify(sessionId)}`, () => {
    const html = renderCard({ ...task, sessionId });

    assert.doesNotMatch(html, /task-session/);
    assert.match(html, /<summary>查看输出<\/summary>/);
  });
}

test('renders one Markdown source surface with chronological messages and native part order', () => {
  const html = renderView(ready);

  const ordered = ['# &lt;Root session&gt;', '**Session ID:** ses_root', '## User', '用户正文', '## Assistant (Build · test-model · 1.5s)', '_Thinking:_', '**Tool:', '**Input:**', '**Error:**', '助手正文', '暂不支持的内容类型'];
  assert.ok(ordered.every((text) => html.includes(text)));
  assert.deepEqual(ordered.map((text) => html.indexOf(text)), ordered.map((text) => html.indexOf(text)).sort((first, second) => first - second));
  assert.equal((html.match(/<pre /g) ?? []).length, 1);
  assert.match(html, /<button[^>]*>复制会话内容<\/button>/);
  assert.doesNotMatch(html, /内部合成消息|role="listitem"|download|<a /);
});

test('escapes all transcript strings when text resembles HTML', () => {
  const html = renderView(ready);

  assert.match(html, /<pre tabindex="0" aria-label="会话 Markdown"># /);
  assert.ok(html.includes('  用户正文\n&lt;script&gt;literal&lt;/script&gt;  \n\n'));
  for (const escaped of ['&lt;reasoning&gt;', '&lt;bash&gt;', '&lt;input&gt;', '&lt;error&gt;', '&lt;file&gt;', '&lt;Root session&gt;']) {
    assert.ok(html.includes(escaped));
  }
  assert.doesNotMatch(html, /<script|<img|<reasoning|<input|<error|<file/);
});

test('includes default reasoning, tool details and metadata while keeping unsupported notices outside Markdown', () => {
  const html = renderView(ready);

  assert.ok(html.includes('## Assistant (Build · test-model · 1.5s)\n\n_Thinking:_\n\n&lt;reasoning&gt;private&lt;/reasoning&gt;\n\n'));
  assert.ok(html.includes('**Input:**\n```json\n{\n  &quot;command&quot;: &quot;&lt;input&gt;&quot;\n}\n```\n'));
  assert.ok(html.includes('**Error:**\n```\n&lt;error&gt;failure&lt;/error&gt;\n```\n'));
  assert.match(html, /<\/pre><p[^>]*>暂不支持的内容类型：<code>&lt;file&gt;<\/code>/);
  assert.doesNotMatch(html, /<details|<h[12]/);
});

for (const [taskStatus, label] of [['running', '执行中的会话快照'], ['succeeded', '已完成任务的根会话记录'], ['failed', '失败任务的根会话记录'], ['cancelled', '已取消任务的根会话记录']] as const) {
  test(`labels the root-only snapshot for a ${taskStatus} task with its read time`, () => {
    const html = renderView({ ...ready, taskStatus });

    assert.ok(html.includes(label));
    assert.match(html, /仅根会话（含追加消息），不递归包含子会话/);
    assert.match(html, /<time dateTime="2023-11-14T22:13:20.000Z">/);
    assert.match(html, /<button[^>]*>刷新会话<\/button>/);
  });
}

test('shows an empty-session state when the export has no messages', () => {
  const html = renderView({ ...ready, transcript: { ...ready.transcript, messages: [] } });

  assert.match(html, /role="status">会话暂无消息/);
  assert.match(html, /<button[^>]*>复制会话内容<\/button>/);
  assert.doesNotMatch(html, /role="listitem"/);
});

test('represents empty messages with a Markdown heading and separator', () => {
  const html = renderView({ ...ready, transcript: { ...ready.transcript, messages: [{ id: 'empty', role: 'user', time: { created: 2000 }, parts: [] }] } });

  assert.ok(html.includes('## User\n\n---\n\n</pre>'));
});

test('shows loading feedback without stale messages when a fetch starts', () => {
  const html = renderView({ status: 'loading' });

  assert.match(html, /role="status">正在加载会话内容/);
  assert.doesNotMatch(html, /<pre|复制会话内容/);
});

test('shows a refresh action when the linked session is no longer available', () => {
  const html = renderView({ status: 'no_session' });

  assert.match(html, /role="status">任务暂无可用的 OpenCode 会话/);
  assert.match(html, /<button[^>]*>刷新会话<\/button>/);
  assert.doesNotMatch(html, /复制会话内容/);
});

test('shows a safe local error and retry action when loading fails', () => {
  const html = renderView({ status: 'error', error: '<unavailable>' });

  assert.match(html, /role="alert"/);
  assert.match(html, /会话加载失败：&lt;unavailable&gt;/);
  assert.match(html, /<button[^>]*>重试<\/button>/);
  assert.doesNotMatch(html, /<pre|<unavailable>/);
  assert.doesNotMatch(html, /复制会话内容/);
});
