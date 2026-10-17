import { useEffect, useRef, useState } from 'react';
import { taskRunUrl } from '../task-api.js';
import { copyTaskMessages, type TaskMessageCopyResult } from '../task-message-copy.js';
import type { TaskArchiveState } from '../../shared/tasks.js';

type CopyState = TaskMessageCopyResult | { readonly status: 'idle' | 'loading' | 'error'; readonly error: string };

export function TaskMessageCopy({ id, runId, archiveState }: {
  readonly id: string;
  readonly runId: string;
  readonly archiveState: TaskArchiveState;
}) {
  const [state, setState] = useState<CopyState>({ status: 'idle', error: '' });
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), [id, runId]);

  const copy = async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const prepared = state.status === 'ready' ? state.serialized : undefined;
    setState({ status: 'loading', error: '' });
    try {
      const result = await copyTaskMessages({ id, runId, signal: request.signal, prepared }, (text) => navigator.clipboard.writeText(text));
      if (!request.signal.aborted) setState(result);
    } catch (error) {
      if (!request.signal.aborted) setState({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div className="task-output-copy-area" aria-busy={state.status === 'loading'}>
      <div className="task-output-toolbar">
        <button className="link task-output-copy" type="button" disabled={state.status === 'loading'} onClick={() => void copy()}>
          {state.status === 'ready' ? '复制准备就绪，点击复制' : state.status === 'loading' ? '正在准备全部消息…'
            : archiveState === 'complete' ? '复制全部消息' : archiveState === 'capturing' ? '复制当前已归档消息' : '复制已归档消息'}
        </button>
        {state.status === 'copied' && <span className="task-output-feedback" role="status">已复制全部 JSON 事件。</span>}
      </div>
      <p className="task-feedback task-field-note">
        {archiveState === 'complete'
          ? '复制本轮完整 JSON 事件数组，含发起会话、步骤及工具事件，不仅是窗口文本。'
          : archiveState === 'capturing'
            ? '复制截至现在已归档的 stdout JSON 事件快照；执行继续时可再次复制更新后的内容。'
            : '本轮归档不完整，仅能复制已保存的 stdout JSON 事件；完整性无法保证。'}
      </p>
      {state.status === 'error' && <p className="task-feedback task-feedback-error" role="alert">消息读取失败：{state.error}。可重试复制或下载归档。</p>}
      {state.status === 'ready' && (
        <p className="task-feedback task-feedback-error" role="alert">
          剪贴板写入失败{state.error === '' ? '' : `：${state.error}`}。完整数组已准备好，请再次点击复制；也可
          <a href={`${taskRunUrl(id, runId)}/messages/download`} download>下载消息 JSON 后手动复制</a>。
        </p>
      )}
    </div>
  );
}
