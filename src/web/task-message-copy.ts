import { taskApi } from './task-api.js';

export type TaskMessageCopyResult =
  | { readonly status: 'copied' }
  | { readonly status: 'ready'; readonly serialized: string; readonly error: string };

export async function copyTaskMessages(selection: {
  readonly id: string;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly prepared?: string;
}, writeText: (serialized: string) => Promise<void>): Promise<TaskMessageCopyResult> {
  const serialized = selection.prepared ?? await taskApi.messages(selection.id, selection.runId, selection.signal);
  selection.signal.throwIfAborted();
  try {
    await writeText(serialized);
    selection.signal.throwIfAborted();
    return { status: 'copied' };
  } catch (error) {
    selection.signal.throwIfAborted();
    return { status: 'ready', serialized, error: error instanceof Error ? error.message : String(error) };
  }
}
