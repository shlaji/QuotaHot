import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TaskSummary } from '../src/shared/tasks.js';
import { TaskCard } from '../src/web/components/TaskCard.js';

const predecessor: TaskSummary = {
  id: 'predecessor-1234',
  description: 'Prepare release notes',
  model: 'openai/test',
  directory: '/tmp/project',
  trigger: { type: 'quota' },
  sessionId: null,
  status: 'failed',
  createdAt: 1000,
  startedAt: 1000,
  finishedAt: 2000,
  error: '',
  hasOutput: false,
};

function renderDependency(tasks: readonly TaskSummary[]): string {
  const task: TaskSummary = {
    ...predecessor,
    id: 'dependent-1234',
    description: 'Publish release',
    trigger: { type: 'task', taskId: predecessor.id },
    status: 'pending',
    startedAt: null,
    finishedAt: null,
  };
  return renderToStaticMarkup(createElement(TaskCard, {
    task,
    tasks,
    active: false,
    busyAction: null,
    actionError: '',
    onSendMessage: async () => false,
    onCancel: () => {},
    onDelete: () => {},
  }));
}

test('task card shows dependency description and current status without rendering predecessor card', () => {
  const html = renderDependency([predecessor]);

  assert.match(html, /等待前置任务完成 · predeces/);
  assert.match(html, /前置任务：Prepare release notes · 失败/);
  assert.equal((html.match(/<article/g) ?? []).length, 1);
});

test('task card keeps the predecessor ID when its summary is absent', () => {
  const html = renderDependency([]);

  assert.match(html, /前置任务：任务记录已删除 · predecessor-1234/);
});
