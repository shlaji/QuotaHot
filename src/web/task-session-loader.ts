import type { TaskSessionTranscript, TaskSummary } from '../shared/tasks.js';
import { taskApi } from './task-api.js';

export type TaskSessionSelection = Pick<TaskSummary, 'id' | 'sessionId' | 'status'>;
export type TaskSessionLoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'no_session' }
  | { readonly status: 'error'; readonly error: string }
  | { readonly status: 'ready'; readonly transcript: TaskSessionTranscript; readonly fetchedAt: number; readonly taskStatus: TaskSummary['status'] };

export const INITIAL_SESSION_STATE: TaskSessionLoadState = { status: 'loading' };

function assertNever(value: never): never {
  throw new TypeError(`Unexpected session response: ${String(value)}`);
}

export function loadTaskSession(task: TaskSessionSelection, onChange: (state: TaskSessionLoadState) => void) {
  let disposed = false;
  let controller: AbortController | null = null;

  const refresh = async (): Promise<void> => {
    if (disposed) return;
    controller?.abort();
    const request = new AbortController();
    controller = request;
    onChange(INITIAL_SESSION_STATE);
    try {
      const response = await taskApi.session(task.id, request.signal);
      if (disposed || request.signal.aborted) return;
      if (response.taskId !== task.id) {
        onChange({ status: 'error', error: '返回的会话与当前任务不匹配，请重试。' });
        return;
      }
      switch (response.status) {
        case 'no_session':
          onChange({ status: 'no_session' });
          break;
        case 'error':
          onChange({ status: 'error', error: response.error });
          break;
        case 'ready':
          if (response.transcript.sessionId !== task.sessionId) {
            onChange({ status: 'error', error: '返回的会话 ID 已变化，请重试。' });
            return;
          }
          onChange({ status: 'ready', transcript: response.transcript, fetchedAt: Date.now(), taskStatus: task.status });
          break;
        default:
          assertNever(response);
      }
    } catch (error) {
      if (disposed || request.signal.aborted) return;
      onChange({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  };

  void refresh();
  return {
    refresh() { void refresh(); },
    stop() { disposed = true; controller?.abort(); },
  };
}

export type TaskSessionLoader = ReturnType<typeof loadTaskSession>;
