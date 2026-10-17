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
export interface TaskSummary extends Omit<ManagedTask, 'output'> {
  readonly hasOutput: boolean;
}

export interface TaskSummaryListResponse {
  readonly tasks: readonly TaskSummary[];
  readonly defaultDirectory: string;
}

export type TaskOutputResponse = Pick<ManagedTask,
  'id' | 'status' | 'createdAt' | 'startedAt' | 'finishedAt' | 'output' | 'error'>;

export interface ClaimedTask extends ManagedTask {
  readonly currentRunId: string;
}

export type TaskRunKind = 'initial' | 'continuation' | 'legacy_unknown';
export type TaskArchiveState = 'capturing' | 'complete' | 'incomplete' | 'legacy_unknown';

export interface TaskRun {
  readonly id: string;
  readonly taskId: string;
  readonly ordinal: number;
  readonly kind: TaskRunKind;
  readonly status: ManagedTask['status'];
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly closedAt: number | null;
  readonly error: string;
  readonly archiveState: TaskArchiveState;
  readonly totalBytes: number;
  readonly totalChunks: number;
}

export interface TaskRunCompletion {
  readonly status: 'succeeded' | 'failed';
  readonly output: string;
  readonly error: string;
  readonly finishedAt: number;
  readonly archiveState?: 'complete' | 'incomplete';
}

export interface TaskPreviewMetadata {
  readonly taskId: string;
  readonly currentRunId: string | null;
  readonly previewBytes: number;
  readonly totalBytes: number;
  readonly totalChunks: number;
  readonly archiveState: TaskArchiveState | null;
}

export interface TaskLogCursor {
  readonly runId: string;
  readonly sequence: number;
  readonly byteOffset: number;
}

export interface TaskLogPageRequest {
  readonly cursor?: TaskLogCursor;
  readonly maxBytes?: number;
  readonly maxChunks?: number;
  readonly tail?: boolean;
}

export interface TaskOutputChunk {
  readonly stream: 'stdout' | 'stderr';
  readonly data: Uint8Array;
}

export interface TaskLogChunk {
  readonly sequence: number;
  readonly byteOffset: number;
  readonly stream: TaskOutputChunk['stream'] | 'legacy';
  readonly data: Uint8Array;
}

export interface TaskLogPage {
  readonly runId: string;
  readonly chunks: readonly TaskLogChunk[];
  readonly nextCursor: TaskLogCursor;
  readonly totalBytes: number;
  readonly totalChunks: number;
  readonly hasEarlier: boolean;
  readonly hasMore: boolean;
}

export interface TaskRunListResponse {
  readonly taskId: string;
  readonly runs: readonly TaskRun[];
}

export interface TaskLogBase64Chunk extends Omit<TaskLogChunk, 'data'> {
  readonly data: string;
}

export interface TaskLogPageResponse extends Omit<TaskLogPage, 'chunks'> {
  readonly encoding: 'base64';
  readonly chunks: readonly TaskLogBase64Chunk[];
  readonly archiveState: TaskArchiveState;
}

export type TaskLogExportRecord =
  | { readonly type: 'run'; readonly run: TaskRun }
  | { readonly type: 'chunk'; readonly runId: string; readonly encoding: 'base64'; readonly chunk: TaskLogBase64Chunk }
  | { readonly type: 'complete'; readonly taskId: string; readonly totalRuns: number; readonly totalBytes: number };

export interface TaskModelsResponse {
  readonly models: string[];
  readonly directory: string;
}
