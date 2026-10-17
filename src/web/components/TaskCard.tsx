import { useEffect, useId, useState, type SubmitEvent } from 'react';
import { MAX_TASK_MESSAGE_LENGTH, type ManagedTask, type TaskTrigger } from '../../shared/tasks.js';

export type TaskAction = 'cancel' | 'delete' | 'message';
type CopyFeedback = {
  readonly status: 'idle' | 'copied' | 'error';
  readonly message: string;
};

interface Props {
  readonly task: ManagedTask;
  readonly busyAction: TaskAction | null;
  readonly actionError: string;
  readonly onSendMessage: (message: string) => Promise<boolean>;
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

export function TaskCard({ task, busyAction, actionError, onSendMessage, onCancel, onDelete }: Props) {
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback>({ status: 'idle', message: '' });
  const [message, setMessage] = useState('');
  const messageInputId = useId();
  const messageHintId = useId();
  const cancellable = task.status === 'pending' || task.status === 'running';
  const busy = busyAction !== null;
  const submitting = busyAction === 'message';
  const canContinue = task.status === 'succeeded'
    && 'sessionId' in task && typeof task.sessionId === 'string' && task.sessionId !== '';
  const messageEnabled = canContinue && !busy;

  const submitMessage = async (event: SubmitEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const draft = message.trim();
    if (!messageEnabled || draft === '') return;
    if (await onSendMessage(draft)) setMessage('');
  };

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

      {(canContinue || message !== '' || submitting) && (
        <form className="task-form task-message-composer" aria-busy={submitting} onSubmit={submitMessage}>
          <div className="field task-field">
            <label htmlFor={messageInputId}><span>追加消息</span></label>
            <textarea
              id={messageInputId}
              required
              maxLength={MAX_TASK_MESSAGE_LENGTH}
              rows={3}
              value={message}
              disabled={!messageEnabled}
              aria-describedby={messageHintId}
              placeholder="说明下一步要让 OpenCode 完成的工作"
              onChange={(event) => setMessage(event.target.value)}
            />
          </div>
          <small id={messageHintId} className="task-field-note">
            {!canContinue
              ? '任务完成且会话可用后才能追加消息。'
              : '沿用当前会话继续执行，输出仅显示最新一轮。'}
          </small>
          <div className="task-submit-row">
            <button className="primary" type="submit" disabled={!messageEnabled || message.trim() === '' || message.length > MAX_TASK_MESSAGE_LENGTH}>
              {submitting ? '正在发送…' : '发送消息'}
            </button>
          </div>
        </form>
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
