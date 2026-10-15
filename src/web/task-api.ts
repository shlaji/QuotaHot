import type {
  CreateTaskInput,
  ManagedTask,
  TaskListResponse,
  TaskModelsResponse,
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

export const taskApi = {
  list: (signal?: AbortSignal) =>
    json<TaskListResponse>('/api/tasks', signal === undefined ? undefined : { signal }),
  models: (directory: string) => {
    const selectedDirectory = directory.trim();
    const query = selectedDirectory === ''
      ? ''
      : `?${new URLSearchParams({ directory: selectedDirectory })}`;
    return json<TaskModelsResponse>(`/api/tasks/models${query}`);
  },
  create: (input: CreateTaskInput) =>
    json<ManagedTask>('/api/tasks', { method: 'POST', body: JSON.stringify(input) }),
  cancel: (id: string) =>
    json<ManagedTask>(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  remove: (id: string) =>
    json<{ removed: string }>(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
