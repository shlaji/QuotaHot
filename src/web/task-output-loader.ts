import type { TaskLogCursor, TaskLogPageResponse, TaskRun, TaskSummary } from '../shared/tasks.js';
import { taskApi, type TaskLogSelection } from './task-api.js';
import { projectTaskLogPage, type TaskLogCheckpoint, type TaskLogWindow } from './task-log-page.js';

type TaskOutputRound = Pick<TaskSummary, 'id' | 'createdAt' | 'startedAt'>;

export interface TaskOutputPage {
  readonly number: number | null;
  readonly metadata: Omit<TaskLogPageResponse, 'chunks'>;
  readonly window: TaskLogWindow;
}

export interface TaskOutputLoadState {
  readonly runs: readonly TaskRun[];
  readonly run: TaskRun | null;
  readonly page: TaskOutputPage | null;
  readonly loading: boolean;
  readonly error: string;
  readonly following: boolean;
  readonly hasPrevious: boolean;
  readonly cacheSize: number;
}

export const INITIAL_OUTPUT_STATE: TaskOutputLoadState = {
  runs: [], run: null, page: null, loading: true, error: '', following: false, hasPrevious: false, cacheSize: 0,
};

export function taskOutputRoundKey(task: TaskOutputRound): string {
  return JSON.stringify([task.id, task.createdAt, task.startedAt]);
}

interface PageRequest {
  readonly number: number | null;
  readonly cursor?: TaskLogCursor;
  readonly checkpoint?: TaskLogCheckpoint;
}

export function loadTaskOutput(
  task: TaskOutputRound,
  onChange: (state: TaskOutputLoadState) => void,
) {
  let state = INITIAL_OUTPUT_STATE;
  let disposed = false;
  let controller = new AbortController();
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cache: TaskOutputPage[] = [];
  let lastRequest: PageRequest = { number: null };

  const emit = (updated: Partial<TaskOutputLoadState>) => {
    if (disposed) return;
    state = { ...state, ...updated, cacheSize: cache.length };
    onChange(state);
  };
  const cancel = () => {
    generation += 1;
    controller.abort();
    clearTimeout(timer);
  };
  const begin = () => {
    cancel();
    controller = new AbortController();
    return { version: generation, signal: controller.signal };
  };
  const present = (page: TaskOutputPage) => {
    const number = page.number;
    emit({ page, loading: false, error: '', hasPrevious: number !== null && cache.some((record) => record.number === number - 1) });
  };
  const fetchPage = async (request: PageRequest): Promise<void> => {
    if (disposed || state.run === null) return;
    lastRequest = request;
    const runId = state.run.id;
    const { version, signal } = begin();
    const selection: TaskLogSelection = { runId, tail: request.number === null, cursor: request.cursor };
    emit({ loading: true, error: '', following: request.number === null });
    try {
      const response = await taskApi.log(task.id, selection, signal);
      if (signal.aborted || version !== generation || disposed) return;
      if (response.runId !== runId || response.nextCursor.runId !== runId) {
        emit({ loading: false, following: false, error: '日志轮次不匹配，请重试。' });
        return;
      }
      const window = projectTaskLogPage(response, request.checkpoint);
      const { chunks, ...metadata } = response;
      const page = { number: request.number, metadata, window };
      cache = [...cache.filter((record) => record.number !== page.number), page].slice(-3);
      present(page);
      const following = request.number === null && metadata.archiveState === 'capturing';
      emit({ following });
      if (following) timer = setTimeout(() => void fetchPage(request), 2000);
    } catch (error) {
      if (signal.aborted || version !== generation || disposed) return;
      emit({ loading: false, following: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const selectRun = (runId: string) => {
    const run = state.runs.find((item) => item.id === runId);
    if (run === undefined || disposed) return;
    cancel();
    cache = [];
    emit({ run, page: null, hasPrevious: false });
    void fetchPage({ number: null });
  };
  const initialize = async () => {
    const { version, signal } = begin();
    emit({ loading: true, error: '' });
    try {
      const response = await taskApi.runs(task.id, signal);
      if (signal.aborted || version !== generation || disposed) return;
      if (response.taskId !== task.id) {
        emit({ loading: false, error: '任务轮次列表不匹配，请重试。' });
        return;
      }
      const runs = [...response.runs].sort((first, second) => second.ordinal - first.ordinal);
      emit({ runs, loading: false });
      if (runs[0]) selectRun(runs[0].id);
    } catch (error) {
      if (signal.aborted || version !== generation || disposed) return;
      emit({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  void initialize();
  return {
    selectRun,
    first() { void fetchPage({ number: 1 }); },
    latest() { void fetchPage({ number: null }); },
    previous() {
      const number = state.page?.number;
      if (number === null || number === undefined) return;
      const page = cache.find((record) => record.number === number - 1);
      if (page) { cancel(); emit({ following: false }); present(page); }
    },
    next() {
      const page = state.page;
      if (page === null || page.number === null || !page.metadata.hasMore) return;
      const number = page.number + 1;
      const cached = cache.find((record) => record.number === number);
      if (cached) { cancel(); emit({ following: false }); present(cached); }
      else void fetchPage({ number, cursor: page.metadata.nextCursor, checkpoint: page.window.checkpoint });
    },
    retry() { if (state.run === null) void initialize(); else void fetchPage(lastRequest); },
    stop() { disposed = true; cache = []; cancel(); },
  };
}

export type TaskOutputLoader = ReturnType<typeof loadTaskOutput>;
