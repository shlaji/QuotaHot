export const MAX_TASK_MESSAGE_LENGTH = 32000;

export type TaskTrigger = { readonly type: 'quota' } | { readonly type: 'time'; readonly at: number };

export interface CreateTaskInput {
  readonly description: string;
  readonly model: string;
  readonly directory: string;
  readonly trigger: TaskTrigger;
}

export interface ManagedTask extends CreateTaskInput {
  readonly id: string;
  readonly sessionId: string | null;
  readonly status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly output: string;
  readonly error: string;
}

export interface TaskListResponse {
  readonly tasks: ManagedTask[];
  readonly defaultDirectory: string;
}
export interface TaskModelsResponse {
  readonly models: string[];
  readonly directory: string;
}
