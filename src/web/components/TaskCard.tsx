import { useId, useState, type SubmitEvent } from 'react';
import { MAX_TASK_MESSAGE_LENGTH, type TaskSummary, type TaskTrigger } from '../../shared/tasks.js';
import { TaskOutputPanel } from './TaskOutputPanel.js';

export type TaskAction = 'cancel' | 'delete' | 'message';

interface Props {
  readonly task: TaskSummary;
  readonly active: boolean;
  readonly busyAction: TaskAction | null;
  readonly actionError: string;
  readonly onSendMessage: (message: string) => Promise<boolean>;
  readonly onCancel: () => void;
  readonly onDelete: () => void;
}

const STATUS_LABEL: Record<TaskSummary['status'], string> = {
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

export function TaskCard({ task, active, busyAction, actionError, onSendMessage, onCancel, onDelete }: Props) {
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

      {(task.hasOutput || task.status !== 'pending') && (
        <TaskOutputPanel task={task} active={active && !busy} />
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
              : '沿用当前会话继续执行；输出默认显示最新一轮，可选择历史轮次。'}
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
