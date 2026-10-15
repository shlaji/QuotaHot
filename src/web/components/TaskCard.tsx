import { useEffect, useState } from 'react';
import type { ManagedTask, TaskTrigger } from '../../shared/tasks.js';

export type TaskAction = 'cancel' | 'delete';
type CopyFeedback = {
  readonly status: 'idle' | 'copied' | 'error';
  readonly message: string;
};

interface Props {
  readonly task: ManagedTask;
  readonly busyAction: TaskAction | null;
  readonly actionError: string;
  readonly onCancel: () => void;
  readonly onDelete: () => void;
}

const STATUS_LABEL: Record<ManagedTask['status'], string> = {
  pending: '待执行',
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

function assertNever(value: never): never {
  throw new Error(`Unexpected task trigger: ${String(value)}`);
}

function dateTime(value: number | null): string {
  return value === null ? '未发生' : new Date(value).toLocaleString('zh-CN');
}

function triggerText(trigger: TaskTrigger): string {
  switch (trigger.type) {
    case 'quota':
      return '任一托管账户额度可用';
    case 'time':
      return `定时于 ${dateTime(trigger.at)}`;
    default:
      return assertNever(trigger);
  }
}

export function TaskCard({ task, busyAction, actionError, onCancel, onDelete }: Props) {
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback>({ status: 'idle', message: '' });
  const cancellable = task.status === 'pending' || task.status === 'running';
  const busy = busyAction !== null;

  useEffect(() => {
    setCopyFeedback({ status: 'idle', message: '' });
  }, [task.output]);

  const copyOutput = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(task.output);
      setCopyFeedback({ status: 'copied', message: '已复制' });
    } catch (error: unknown) {
      const reason = error instanceof Error && error.message !== '' ? `（${error.message}）` : '';
      setCopyFeedback({
        status: 'error',
        message: `复制失败${reason}，请手动选中输出内容复制。`,
      });
    }
  };

  return (
    <article className={`card task-card task-status-${task.status}`} aria-busy={busy}>
      <header className="task-card-head">
        <div>
          <h3>{task.description}</h3>
          <span className="task-id" title={task.id}>{task.id}</span>
        </div>
        <span className={`task-status task-status-${task.status}`}>{STATUS_LABEL[task.status]}</span>
      </header>

      <p className="task-trigger">{triggerText(task.trigger)}</p>

      <dl className="task-meta">
        <div className="task-meta-wide">
          <dt>Provider / Model</dt>
          <dd><code>{task.model}</code></dd>
        </div>
        <div className="task-meta-wide">
          <dt>工作目录</dt>
          <dd title={task.directory}><code>{task.directory}</code></dd>
        </div>
        <div>
          <dt>创建</dt>
          <dd>{dateTime(task.createdAt)}</dd>
        </div>
        <div>
          <dt>开始</dt>
          <dd>{dateTime(task.startedAt)}</dd>
        </div>
        <div>
          <dt>结束</dt>
          <dd>{dateTime(task.finishedAt)}</dd>
        </div>
      </dl>

      {task.error !== '' && (
        <p className="task-feedback task-feedback-error" role="alert">
          {task.error}
        </p>
      )}

      {task.output !== '' && (
        <details className="task-output">
          <summary>查看输出</summary>
          <div className="task-output-toolbar">
            <button
              className="link task-output-copy"
              type="button"
              onClick={() => void copyOutput()}
            >
              复制全部输出
            </button>
            {copyFeedback.status === 'copied' && (
              <span className="task-output-feedback" role="status">已复制</span>
            )}
            {copyFeedback.status === 'error' && (
              <span className="task-output-feedback task-output-feedback-error" role="alert">
                {copyFeedback.message}
              </span>
            )}
          </div>
          <pre>{task.output}</pre>
        </details>
      )}

      {actionError !== '' && (
        <p className="task-feedback task-feedback-error" role="alert">
          操作失败：{actionError}
        </p>
      )}

      <footer className="task-card-actions">
        {cancellable && (
          <button className="act" type="button" disabled={busy} onClick={onCancel}>
            {busyAction === 'cancel' ? '正在取消…' : '取消任务'}
          </button>
        )}
        {!cancellable && (
          <button className="act danger" type="button" disabled={busy} onClick={onDelete}>
            {busyAction === 'delete' ? '正在删除…' : '删除'}
          </button>
        )}
      </footer>
    </article>
  );
}
