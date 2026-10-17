import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CreateTaskInput,
  TaskSummary,
  TaskSummaryListResponse,
  TaskModelsResponse,
} from '../../shared/tasks.js';
import { taskApi } from '../task-api.js';
import { taskDisplayTitle } from '../../shared/tasks.js';
import '../task-styles.css';
import { TaskCard, type TaskAction } from './TaskCard.js';
import { TaskForm } from './TaskForm.js';

interface Props {
  readonly active?: boolean;
}

const POLL_INTERVAL_MS = 2000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function upsertTask(current: TaskSummaryListResponse, task: TaskSummary): TaskSummaryListResponse {
  const exists = current.tasks.some((item) => item.id === task.id);
  return {
    ...current,
    tasks: exists
      ? current.tasks.map((item) => (item.id === task.id ? task : item))
      : [task, ...current.tasks],
  };
}

function withoutKey<T>(record: Readonly<Record<string, T>>, id: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== id));
}

export function TaskPane({ active = true }: Props) {
  const [snapshot, setSnapshot] = useState<TaskSummaryListResponse | null>(null);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [directory, setDirectory] = useState('');
  const [modelResponse, setModelResponse] = useState<TaskModelsResponse | null>(null);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState('');
  const [busyById, setBusyById] = useState<Record<string, TaskAction>>({});
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const busyTaskIdsRef = useRef(new Set<string>());
  const pollProtectedIdsRef = useRef(new Set<string>());
  const pollControllerRef = useRef<AbortController | null>(null);
  const directoryRef = useRef('');
  const modelRequestRef = useRef(0);

  const loadModels = useCallback(async (): Promise<void> => {
    const request = modelRequestRef.current + 1;
    modelRequestRef.current = request;
    setModelLoading(true);
    setModelError('');
    try {
      const response = await taskApi.models(directoryRef.current);
      if (request === modelRequestRef.current) setModelResponse(response);
    } catch (error) {
      if (request === modelRequestRef.current) setModelError(messageOf(error));
    } finally {
      if (request === modelRequestRef.current) setModelLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) {
      setModelLoading(false);
      return;
    }
    void loadModels();
    return () => {
      modelRequestRef.current += 1;
    };
  }, [active, loadModels]);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let timer: number | null = null;

    const schedule = () => {
      timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };

    // Recursive scheduling means a slow request delays the next tick instead of overlapping it.
    const poll = async (): Promise<void> => {
      if (disposed) return;
      const controller = new AbortController();
      const protectedIds = new Set(busyTaskIdsRef.current);
      pollProtectedIdsRef.current = protectedIds;
      pollControllerRef.current = controller;
      try {
        const response = await taskApi.list(controller.signal);
        if (!disposed) {
          setSnapshot((current) => {
            const previous = new Map(current?.tasks.map((task) => [task.id, task]));
            const tasks = new Map(response.tasks.map((task) => [task.id, task]));
            for (const id of protectedIds) {
              const preserved = previous.get(id);
              if (preserved === undefined) tasks.delete(id);
              else tasks.set(id, preserved);
            }
            return { ...response, tasks: [...tasks.values()] };
          });
          setLoadError('');
        }
      } catch (error) {
        const aborted = error instanceof DOMException && error.name === 'AbortError';
        if (!aborted && !disposed) {
          setLoadError(messageOf(error));
        }
      } finally {
        if (pollControllerRef.current === controller) pollControllerRef.current = null;
        if (!disposed) schedule();
      }
    };

    setLoadError('');
    void poll();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      pollControllerRef.current?.abort();
      pollControllerRef.current = null;
    };
  }, [active, retryGeneration]);

  const beginMutation = (id: string, action: TaskAction) => {
    busyTaskIdsRef.current.add(id);
    pollProtectedIdsRef.current.add(id);
    setBusyById((current) => ({ ...current, [id]: action }));
    setActionErrors((current) => withoutKey(current, id));
  };

  const endMutation = (id: string) => {
    busyTaskIdsRef.current.delete(id);
    setBusyById((current) => withoutKey(current, id));
  };

  const createTask = async (input: CreateTaskInput): Promise<void> => {
    const created = await taskApi.create(input);
    pollProtectedIdsRef.current.add(created.id);
    setSnapshot((current) =>
      current === null
        ? { tasks: [created], defaultDirectory: '' }
        : upsertTask(current, created),
    );
    setNotice('任务已创建，正在等待触发。');
  };

  const cancelTask = async (task: TaskSummary) => {
    if (busyTaskIdsRef.current.has(task.id)) return;
    beginMutation(task.id, 'cancel');
    try {
      const cancelled = await taskApi.cancel(task.id);
      setSnapshot((current) => (current === null ? current : upsertTask(current, cancelled)));
      setNotice(`已取消任务：${taskDisplayTitle(task)}`);
    } catch (error) {
      setActionErrors((current) => ({ ...current, [task.id]: messageOf(error) }));
    } finally {
      endMutation(task.id);
    }
  };

  const deleteTask = async (task: TaskSummary) => {
    if (busyTaskIdsRef.current.has(task.id)
      || !confirm(`删除后任务和输出记录都会消失。确定删除“${taskDisplayTitle(task)}”吗？`)) return;
    beginMutation(task.id, 'delete');
    try {
      await taskApi.remove(task.id);
      setSnapshot((current) =>
        current === null
          ? current
          : { ...current, tasks: current.tasks.filter((item) => item.id !== task.id) },
      );
      setNotice(`已删除任务：${taskDisplayTitle(task)}`);
    } catch (error) {
      setActionErrors((current) => ({ ...current, [task.id]: messageOf(error) }));
    } finally {
      endMutation(task.id);
    }
  };

  const sendMessage = async (task: TaskSummary, message: string): Promise<boolean> => {
    if (busyTaskIdsRef.current.has(task.id)) return false;
    beginMutation(task.id, 'message');
    try {
      const updated = await taskApi.sendMessage(task.id, message);
      setSnapshot((current) => (current === null ? current : upsertTask(current, updated)));
      setNotice(`消息已发送，任务继续执行：${taskDisplayTitle(task)}`);
      return true;
    } catch (error) {
      setActionErrors((current) => ({ ...current, [task.id]: messageOf(error) }));
      return false;
    } finally {
      endMutation(task.id);
    }
  };

  const retry = () => {
    setLoadError('');
    setRetryGeneration((current) => current + 1);
  };

  const changeDirectory = (value: string) => {
    directoryRef.current = value;
    setDirectory(value);
  };

  return (
    <main className="task-pane">
      <TaskForm
        defaultDirectory={snapshot?.defaultDirectory ?? ''}
        directory={directory}
        tasks={snapshot?.tasks ?? []}
        modelDiscovery={{
          response: modelResponse,
          loading: modelLoading,
          error: modelError,
          refresh: () => void loadModels(),
        }}
        onDirectoryChange={changeDirectory}
        onCreate={createTask}
      />

      <section className="task-list-section" aria-labelledby="task-list-title" aria-busy={snapshot === null && loadError === ''}>
        <header className="task-section-head task-list-head">
          <div>
            <h2 id="task-list-title">任务列表</h2>
            <p>{active ? '每 2 秒刷新状态；展开输出后按页读取日志。' : '切回本页后继续刷新状态，日志读取已暂停。'}</p>
          </div>
          {snapshot !== null && <span className="task-count">{snapshot.tasks.length}</span>}
        </header>

        {notice !== '' && <p className="task-feedback task-feedback-notice" role="status">{notice}</p>}

        {loadError !== '' && (
          <div className="task-feedback task-feedback-error task-retry" role="alert">
            <span>任务列表加载失败：{loadError}</span>
            <button className="link" type="button" onClick={retry}>重试</button>
          </div>
        )}

        {snapshot === null && loadError === '' && <p className="empty big">正在加载任务…</p>}
        {snapshot !== null && snapshot.tasks.length === 0 && (
          <p className="empty big">还没有任务。填写上方表单创建第一个任务。</p>
        )}
        {snapshot !== null && snapshot.tasks.length > 0 && (
          <div className="task-grid">
            {snapshot.tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                tasks={snapshot.tasks}
                active={active}
                busyAction={busyById[task.id] ?? null}
                actionError={actionErrors[task.id] ?? ''}
                onSendMessage={(message) => sendMessage(task, message)}
                onCancel={() => void cancelTask(task)}
                onDelete={() => void deleteTask(task)}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
