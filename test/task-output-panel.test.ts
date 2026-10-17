import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TaskLogPageResponse, TaskSummary } from '../src/shared/tasks.js';
import { TaskCard } from '../src/web/components/TaskCard.js';
import { TaskOutputPanel, TaskOutputWindow } from '../src/web/components/TaskOutputPanel.js';
import { TaskMessageCopy } from '../src/web/components/TaskMessageCopy.js';
import { projectTaskLogPage } from '../src/web/task-log-page.js';

const task: TaskSummary = {
  id: 'task-1', description: 'Run tests', model: 'openai/test-model', directory: '/work/project',
  trigger: { type: 'quota' }, status: 'succeeded', sessionId: 'ses_test',
  createdAt: 1000, startedAt: 2000, finishedAt: 3000, hasOutput: true, error: '',
};

for (const status of ['succeeded', 'failed'] as const) {
  test(`enables the composer for a ${status} task with a session`, () => {
    const html = renderToStaticMarkup(createElement(TaskCard, {
      task: { ...task, status }, active: true, busyAction: null, actionError: '',
      onSendMessage: async () => false, onCancel: () => {}, onDelete: () => {},
    }));

    assert.match(html, /<form class="task-form task-message-composer"/);
    assert.match(html, /<textarea(?![^>]*\bdisabled=)[^>]*>/);
    assert.match(html, /<button[^>]*type="submit"[^>]*disabled=/);
  });

  for (const sessionId of [null, '']) {
    test(`does not offer a composer for a ${status} task with sessionId ${JSON.stringify(sessionId)}`, () => {
      const html = renderToStaticMarkup(createElement(TaskCard, {
        task: { ...task, status, sessionId }, active: true, busyAction: null, actionError: '',
        onSendMessage: async () => false, onCancel: () => {}, onDelete: () => {},
      }));

      assert.doesNotMatch(html, /<form|<textarea|type="submit"/);
    });
  }

  for (const busyAction of ['message', 'cancel', 'delete'] as const) {
    test(`disables the composer for a ${status} task while ${busyAction} is busy`, () => {
      const html = renderToStaticMarkup(createElement(TaskCard, {
        task: { ...task, status }, active: true, busyAction, actionError: '',
        onSendMessage: async () => false, onCancel: () => {}, onDelete: () => {},
      }));

      assert.match(html, /<textarea[^>]*disabled=/);
    });
  }
}

for (const status of ['pending', 'running', 'cancelled'] as const) {
  test(`does not offer a composer for a ${status} task even with a session`, () => {
    const html = renderToStaticMarkup(createElement(TaskCard, {
      task: { ...task, status }, active: true, busyAction: null, actionError: '',
      onSendMessage: async () => false, onCancel: () => {}, onDelete: () => {},
    }));

    assert.doesNotMatch(html, /<form|<textarea|type="submit"/);
  });
}

for (const active of [true, false]) {
  test(`initially renders only the native output disclosure when active is ${active}`, (context) => {
    const fetch = context.mock.method(globalThis, 'fetch', async () => { throw new Error('Collapsed panels must not fetch'); });
    const html = renderToStaticMarkup(createElement(TaskOutputPanel, { task, active }));

    assert.match(html, /^<details class="task-output"><summary>/);
    assert.doesNotMatch(html, /<pre|<button|aria-busy| open=/);
    assert.equal(fetch.mock.callCount(), 0);
  });
}

for (const status of ['running', 'succeeded', 'failed', 'cancelled'] as const) {
  test(`keeps the output disclosure available for a ${status} task without an excerpt yet`, () => {
    const html = renderToStaticMarkup(createElement(TaskCard, {
      task: { ...task, status, hasOutput: false }, active: true, busyAction: null, actionError: '',
      onSendMessage: async () => false, onCancel: () => {}, onDelete: () => {},
    }));

    assert.match(html, /<details class="task-output">/);
    assert.doesNotMatch(html, /<pre/);
  });
}

test('does not offer output for a pending task that has never produced any', () => {
  const html = renderToStaticMarkup(createElement(TaskCard, {
    task: { ...task, status: 'pending', startedAt: null, finishedAt: null, hasOutput: false },
    active: true, busyAction: null, actionError: '',
    onSendMessage: async () => false, onCancel: () => {}, onDelete: () => {},
  }));

  assert.doesNotMatch(html, /<details|<pre/);
});

function logWindow(stdout: string) {
  const response: TaskLogPageResponse = {
    runId: 'run', encoding: 'base64', archiveState: 'complete', totalBytes: stdout.length, totalChunks: 2,
    nextCursor: { runId: 'run', sequence: 2, byteOffset: stdout.length }, hasEarlier: false, hasMore: false,
    chunks: [
      { sequence: 0, byteOffset: 0, stream: 'stdout', data: Buffer.from(stdout).toString('base64') },
      { sequence: 1, byteOffset: stdout.length, stream: 'stderr', data: Buffer.from('{"type":"text","part":{"text":"diagnostics"}}\n').toString('base64') },
    ],
  };
  return { number: 1, metadata: response, window: projectTaskLogPage(response) };
}

test('renders only projected message text as escaped plain text in a focusable pre', () => {
  const page = logWindow([
    { sessionID: 'root' }, { type: 'step_start', part: { text: 'step hidden' } },
    { type: 'tool_use', part: { text: 'tool hidden' } }, { type: 'step_finish', text: 'finish hidden' },
    { type: 'text', part: { text: '  中文\n<script>literal</script>  ' } },
  ].map((event) => JSON.stringify(event)).join('\n'));

  const html = renderToStaticMarkup(createElement(TaskOutputWindow, { page, stream: 'messages' }));

  assert.match(html, /<pre tabindex="0" aria-label="消息正文（stdout）">  中文\n&lt;script&gt;literal&lt;\/script&gt;  <\/pre>/);
  assert.doesNotMatch(html, /step hidden|tool hidden|finish hidden|sessionID|diagnostics|<script>/);
});

test('shows stderr only in its explicitly labelled diagnostics stream without JSON projection', () => {
  const page = logWindow('{"type":"text","part":{"text":"message only"}}\n');

  const html = renderToStaticMarkup(createElement(TaskOutputWindow, { page, stream: 'diagnostics' }));

  assert.match(html, /aria-label="诊断输出（stderr）"/);
  assert.match(html, /&quot;type&quot;:&quot;text&quot;/);
  assert.doesNotMatch(html, /message only/);
});

test('keeps a huge message in one bounded scroll surface rather than adding transcript nodes', () => {
  const page = logWindow(JSON.stringify({ type: 'text', part: { text: '宽字符'.repeat(20_000) } }));

  const html = renderToStaticMarkup(createElement(TaskOutputWindow, { page, stream: 'messages' }));

  assert.equal(html.match(/<pre /g)?.length, 1);
  assert.equal(html.match(/<script/g), null);
});

test('labels running copies as a snapshot and incomplete copies as partial', () => {
  const running = renderToStaticMarkup(createElement(TaskMessageCopy, {
    id: task.id, runId: 'run', archiveState: 'capturing',
  }));
  const incomplete = renderToStaticMarkup(createElement(TaskMessageCopy, {
    id: task.id, runId: 'run', archiveState: 'incomplete',
  }));

  assert.match(running, /复制当前已归档消息/);
  assert.match(running, /执行继续时可再次复制更新后的内容/);
  assert.match(incomplete, /归档不完整/);
  assert.match(incomplete, /复制已归档消息/);
});
