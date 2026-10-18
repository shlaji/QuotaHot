import { useEffect, useRef, useState } from 'react';
import type { TaskSummary } from '../../shared/tasks.js';
import { formatTaskSessionTranscript } from '../../shared/task-session-transcript.js';
import { INITIAL_SESSION_STATE, loadTaskSession, type TaskSessionLoader, type TaskSessionLoadState } from '../task-session-loader.js';

interface Props {
  readonly task: TaskSummary;
  readonly active: boolean;
}

const SNAPSHOT_LABELS = {
  pending: '待执行任务的根会话快照。',
  running: '执行中的会话快照；运行尚未结束，请刷新获取最新内容。',
  succeeded: '已完成任务的根会话记录。',
  failed: '失败任务的根会话记录，仅显示已保存的内容。',
  cancelled: '已取消任务的根会话记录，仅显示已保存的内容。',
} as const satisfies Record<TaskSummary['status'], string>;

function assertNever(value: never): never {
  throw new TypeError(`Unexpected session content: ${String(value)}`);
}

export function TaskSessionView({ state, onRefresh }: {
  readonly state: TaskSessionLoadState;
  readonly onRefresh: () => void;
}) {
  switch (state.status) {
    case 'loading':
      return <p className="task-feedback" role="status">正在加载会话内容…</p>;
    case 'error':
      return (
        <div className="task-feedback task-feedback-error task-retry" role="alert">
          <span>会话加载失败：{state.error}</span>
          <button className="link" type="button" onClick={onRefresh}>重试</button>
        </div>
      );
    case 'no_session':
      return (
        <div className="task-output-controls">
          <p className="task-feedback" role="status">任务暂无可用的 OpenCode 会话。</p>
          <button className="link" type="button" onClick={onRefresh}>刷新会话</button>
        </div>
      );
    case 'ready': {
      const { transcript, fetchedAt, taskStatus } = state;
      const unsupportedTypes = [...new Set(transcript.messages.flatMap((message) => message.parts
        .filter((part) => part.type === 'unsupported').map((part) => part.originalType)))];
      return (
        <>
          <div className="task-output-toolbar">
            <span className="task-field-note">OpenCode 原生会话</span>
            <button className="link" type="button" onClick={onRefresh}>刷新会话</button>
          </div>
          <p className="task-feedback task-field-note">{SNAPSHOT_LABELS[taskStatus]}</p>
          <p className="task-feedback task-field-note">导出范围：仅根会话（含追加消息），不递归包含子会话；与每轮输出日志独立。</p>
          <p className="task-feedback task-field-note">
            快照读取时间：<time dateTime={new Date(fetchedAt).toISOString()}>{new Date(fetchedAt).toLocaleString('zh-CN')}</time>
          </p>
          <p className="task-feedback task-field-note">会话：{transcript.title || transcript.sessionId}</p>
          {transcript.messages.length === 0 && <p className="task-feedback" role="status">会话暂无消息。</p>}
          <pre tabIndex={0} aria-label="会话 Markdown">{formatTaskSessionTranscript(transcript)}</pre>
          {unsupportedTypes.map((type) => (
            <p className="task-feedback task-field-note" key={type}>暂不支持的内容类型：<code>{type}</code></p>
          ))}
        </>
      );
    }
    default:
      return assertNever(state);
  }
}

function TaskSessionContent({ task }: Pick<Props, 'task'>) {
  const [state, setState] = useState(INITIAL_SESSION_STATE);
  const loader = useRef<TaskSessionLoader | null>(null);
  const { id, sessionId, status } = task;

  useEffect(() => {
    const current = loadTaskSession({ id, sessionId, status }, setState);
    loader.current = current;
    return () => { current.stop(); loader.current = null; };
  }, [id, sessionId, status]);

  return <div aria-busy={state.status === 'loading'}><TaskSessionView state={state} onRefresh={() => loader.current?.refresh()} /></div>;
}

export function TaskSessionPanel({ task, active }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <details className="task-output task-session" open={open} onToggle={(event) => {
      if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
    }}>
      <summary>会话内容</summary>
      {open && active && <TaskSessionContent key={JSON.stringify([task.id, task.sessionId, task.startedAt, task.finishedAt, task.status])} task={task} />}
    </details>
  );
}
