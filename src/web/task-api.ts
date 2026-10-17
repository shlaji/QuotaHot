import type {
  CreateTaskInput,
  ManagedTask,
  TaskModelsResponse,
  TaskOutputResponse,
  TaskSessionResponse,
  TaskSummary,
  TaskSummaryListResponse,
  TaskLogCursor,
  TaskLogPageResponse,
  TaskRunListResponse,
} from '../shared/tasks.js';

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${response.status}`);
  }
  return body as T;
}

function toSummary({ output, ...task }: ManagedTask): TaskSummary {
  return { ...task, hasOutput: output !== '' };
}

export function taskRunUrl(id: string, runId: string): string {
  return `/api/tasks/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`;
}

export interface TaskLogSelection {
  readonly runId: string;
  readonly cursor?: TaskLogCursor;
  readonly tail?: boolean;
}

export const taskApi = {
  list: (signal?: AbortSignal) =>
    json<TaskSummaryListResponse>('/api/tasks/summary', signal === undefined ? undefined : { signal }),
  output: (id: string, signal: AbortSignal) =>
    json<TaskOutputResponse>(`/api/tasks/${encodeURIComponent(id)}/output`, { signal }),
  session: (id: string, signal: AbortSignal) =>
    json<TaskSessionResponse>(`/api/tasks/${encodeURIComponent(id)}/session`, { signal }),
  runs: (id: string, signal: AbortSignal) =>
    json<TaskRunListResponse>(`/api/tasks/${encodeURIComponent(id)}/runs`, { signal }),
  log: (id: string, selection: TaskLogSelection, signal: AbortSignal) => {
    const query = new URLSearchParams({ maxBytes: String(64 * 1024) });
    if (selection.tail) query.set('tail', 'true');
    else if (selection.cursor) {
      query.set('sequence', String(selection.cursor.sequence));
      query.set('byteOffset', String(selection.cursor.byteOffset));
    }
    return json<TaskLogPageResponse>(`${taskRunUrl(id, selection.runId)}/log?${query}`, { signal });
  },
  messages: async (id: string, runId: string, signal: AbortSignal): Promise<string> => {
    const response = await fetch(`${taskRunUrl(id, runId)}/messages/download`, { signal });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const message = body !== null && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error : `HTTP ${response.status}`;
      throw new Error(message);
    }
    return response.text();
  },
  models: (directory: string) => {
    const selectedDirectory = directory.trim();
    const query = selectedDirectory === ''
      ? ''
      : `?${new URLSearchParams({ directory: selectedDirectory })}`;
    return json<TaskModelsResponse>(`/api/tasks/models${query}`);
  },
  create: (input: CreateTaskInput) =>
    json<ManagedTask>('/api/tasks', { method: 'POST', body: JSON.stringify(input) }).then(toSummary),
  sendMessage: (id: string, message: string) =>
    json<ManagedTask>(`/api/tasks/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }).then(toSummary),
  cancel: (id: string) =>
    json<ManagedTask>(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' }).then(toSummary),
  remove: (id: string) =>
    json<{ removed: string }>(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
