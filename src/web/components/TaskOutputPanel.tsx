import { useEffect, useRef, useState } from 'react';
import type { TaskSummary } from '../../shared/tasks.js';
import { taskRunUrl } from '../task-api.js';
import { INITIAL_OUTPUT_STATE, loadTaskOutput, taskOutputRoundKey, type TaskOutputLoader, type TaskOutputPage } from '../task-output-loader.js';
import { TaskMessageCopy } from './TaskMessageCopy.js';

interface Props {
  readonly task: TaskSummary;
  readonly active: boolean;
}

type OutputStream = 'messages' | 'diagnostics' | 'legacy';
const STREAM_LABELS: Readonly<Record<OutputStream, string>> = { messages: '消息正文（stdout）', diagnostics: '诊断输出（stderr）', legacy: '旧版原始输出（来源不明）' };
const RUN_KINDS = { initial: '初始执行', continuation: '追加执行', legacy_unknown: '旧版记录' } as const;

export function TaskOutputWindow({ page, stream }: { readonly page: TaskOutputPage; readonly stream: OutputStream }) {
  const window = page.window;
  const text = window[stream];
  return (
    <>
      {window.partial && stream === 'messages' && (
        <p className="task-feedback task-field-note" role="status">这是局部窗口，起点可能位于消息中间；不完整的开头已跳过。从头浏览可顺序读取，完整事件请复制或下载。</p>
      )}
      {window.pending && stream === 'messages' && <p className="task-feedback task-field-note">跨页消息尚未结束，正文将在后续页面继续。</p>}
      {window.textTruncated && stream === 'messages' && (
        <p className="task-feedback task-field-note" role="status">单条长消息的正文窗口仅显示前 64 KiB；完整 JSON 事件请使用“复制全部消息”或下载归档。</p>
      )}
      {window.invalidLines > 0 && stream === 'messages' && (
        <p className="task-feedback task-field-note" role="status">本页有 {window.invalidLines === 999 ? '999+' : window.invalidLines} 行无效 JSON，已跳过；原始内容仍可下载。</p>
      )}
      {stream === 'diagnostics' && <p className="task-feedback task-field-note">独立的 stderr 诊断流，按原始文本显示，不作为消息解析。</p>}
      {stream === 'legacy' && <p className="task-feedback task-field-note">旧版记录无法区分 stdout / stderr，来源和完整性未知，仅提供原始文本。</p>}
      {text === '' ? <p className="task-feedback" role="status">本页暂无{stream === 'messages' ? '可显示的消息正文' : '此流输出'}。</p>
        : <pre tabIndex={0} aria-label={STREAM_LABELS[stream]}>{text}</pre>}
    </>
  );
}

function TaskOutputContent({ task }: Pick<Props, 'task'>) {
  const [state, setState] = useState(INITIAL_OUTPUT_STATE);
  const [stream, setStream] = useState<OutputStream>('messages');
  const loader = useRef<TaskOutputLoader | null>(null);
  const { id, createdAt, startedAt } = task;
  const { run, page } = state;

  useEffect(() => {
    const current = loadTaskOutput({ id, createdAt, startedAt }, setState);
    loader.current = current;
    return () => { current.stop(); loader.current = null; };
  }, [id, createdAt, startedAt]);

  return (
    <div aria-busy={state.loading}>
      {state.loading && page === null && <p className="task-feedback" role="status">正在加载日志…</p>}
      {state.runs.length > 0 && (
        <div className="task-output-controls">
          <label className="field task-field"><span>运行轮次</span>
            <select value={run?.id ?? ''} onChange={(event) => loader.current?.selectRun(event.target.value)}>
              {state.runs.map((item) => <option key={item.id} value={item.id}>第 {item.ordinal} 轮 · {RUN_KINDS[item.kind]} · {new Date(item.createdAt).toLocaleString('zh-CN')}</option>)}
            </select>
          </label>
          <label className="field task-field"><span>显示内容</span>
            <select value={stream} onChange={(event) => {
              const value = event.target.value;
              if (value === 'messages' || value === 'diagnostics' || value === 'legacy') setStream(value);
            }}>
              {Object.entries(STREAM_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        </div>
      )}
      {state.error !== '' && (
        <div className="task-feedback task-feedback-error task-retry" role="alert">
          <span>日志加载失败：{state.error}</span>
          <button className="link" type="button" onClick={() => loader.current?.retry()}>重试</button>
        </div>
      )}
      {!state.loading && state.runs.length === 0 && state.error === '' && <p className="task-feedback">尚无运行记录。</p>}
      {run !== null && (
        <>
          {run.error !== '' && run.error !== task.error && <p className="task-feedback task-feedback-error" role="alert">{run.error}</p>}
          <nav className="task-output-navigation" aria-label="输出分页">
            <button className="act" type="button" onClick={() => loader.current?.first()}>从头浏览</button>
            <button className="act" type="button" disabled={state.loading || !state.hasPrevious} onClick={() => loader.current?.previous()}>上一页</button>
            <button className="act" type="button" disabled={state.loading || page?.number == null || !page.metadata.hasMore} onClick={() => loader.current?.next()}>下一页</button>
            <button className="act" type="button" onClick={() => loader.current?.latest()}>最新窗口</button>
          </nav>
          {page !== null && (
            <>
              <p className="task-feedback task-field-note">
                {page.number === null ? '最新窗口' : `第 ${page.number} 页`} · 每页最多 64 KiB · 已归档 {page.metadata.totalBytes.toLocaleString('zh-CN')} 字节
                {state.following ? ' · 正在跟随' : ''}
              </p>
              {page.metadata.archiveState === 'incomplete' && <p className="task-feedback task-feedback-error">本轮归档不完整；下载仅包含已保存的数据。</p>}
              {(page.metadata.archiveState === 'legacy_unknown' || run.kind === 'legacy_unknown') && (
                <p className="task-feedback task-field-note">旧版记录来源和完整性未知，不生成 JSON 消息。请切换“旧版原始输出”查看。</p>
              )}
              <TaskOutputWindow page={page} stream={stream} />
            </>
          )}
          <p className="task-feedback task-field-note">仅缓存最近 3 页。上一页不可用时，可从头顺序浏览。摘要刷新不会移动当前窗口。</p>
          {run.archiveState === 'legacy_unknown' || run.kind === 'legacy_unknown' ? (
            <p className="task-feedback task-field-note">旧版记录来源未知，无法安全识别消息事件；请使用原始日志下载。</p>
          ) : (
            <TaskMessageCopy key={run.id} id={id} runId={run.id} archiveState={run.archiveState} />
          )}
          <div className="task-output-downloads">
            <a href={`${taskRunUrl(id, run.id)}/download`} download>下载本轮原始日志</a>
            <a href={`/api/tasks/${encodeURIComponent(id)}/logs/download`} download>下载全部轮次 JSONL</a>
          </div>
        </>
      )}
    </div>
  );
}

export function TaskOutputPanel({ task, active }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <details className="task-output" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>查看输出</summary>
      {open && active && <TaskOutputContent key={taskOutputRoundKey(task)} task={task} />}
    </details>
  );
}
