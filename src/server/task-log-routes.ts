import { Hono } from 'hono';
import type {
  TaskLogBase64Chunk, TaskLogChunk, TaskLogCursor, TaskLogExportRecord, TaskLogPageResponse,
  TaskLogPageRequest, TaskRun, TaskRunListResponse,
} from '../shared/tasks.js';
import type { TaskStore } from './task-store.js';
import { messageArray } from './task-message-export.js';

const PAGE_BYTES = 64 * 1024;
const PAGE_CHUNKS = 128;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class ArchiveReadError extends Error {
  constructor(readonly runId: string) { super(`Task archive unavailable: ${runId}`); }
}

function decimal(value: string, maximum: number): number {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number > maximum) {
    throw new RangeError('Invalid task log page parameter');
  }
  return number;
}

function pageRequest(query: URLSearchParams, runId: string): TaskLogPageRequest {
  for (const name of ['sequence', 'byteOffset', 'maxBytes', 'maxChunks', 'tail']) {
    if (query.getAll(name).length > 1) throw new RangeError('Duplicate task log page parameter');
  }
  const maxBytes = decimal(query.get('maxBytes') ?? String(PAGE_BYTES), PAGE_BYTES);
  const maxChunks = decimal(query.get('maxChunks') ?? String(PAGE_CHUNKS), PAGE_CHUNKS);
  const tail = query.get('tail') === 'true';
  if (query.has('tail') && query.get('tail') !== 'true' && query.get('tail') !== 'false') {
    throw new RangeError('Invalid task log page parameter');
  }
  if (maxBytes === 0 || maxChunks === 0 || query.has('sequence') !== query.has('byteOffset')
    || (tail && query.has('sequence'))) {
    throw new RangeError('Invalid task log page parameter');
  }
  if (tail) return { maxBytes, maxChunks, tail: true };
  return {
    maxBytes, maxChunks,
    cursor: {
      runId,
      sequence: decimal(query.get('sequence') ?? '0', Number.MAX_SAFE_INTEGER),
      byteOffset: decimal(query.get('byteOffset') ?? '0', Number.MAX_SAFE_INTEGER),
    },
  };
}

function encoded(chunk: TaskLogChunk): TaskLogBase64Chunk {
  return { sequence: chunk.sequence, byteOffset: chunk.byteOffset, stream: chunk.stream, data: Buffer.from(chunk.data).toString('base64') };
}

function* snapshotChunks(store: TaskStore, run: TaskRun): Generator<TaskLogChunk> {
  let cursor: TaskLogCursor = { runId: run.id, sequence: 0, byteOffset: 0 };
  do {
    const page = store.readLogPage(run.taskId, run.id, {
      cursor, maxBytes: Math.max(1, Math.min(PAGE_BYTES, run.totalBytes - cursor.byteOffset)), maxChunks: PAGE_CHUNKS,
    });
    if (!page || (cursor.byteOffset < run.totalBytes && page.nextCursor.byteOffset <= cursor.byteOffset)) {
      throw new ArchiveReadError(run.id);
    }
    if (run.totalBytes === 0) return;
    for (const chunk of page.chunks) yield chunk;
    cursor = page.nextCursor;
  } while (cursor.byteOffset < run.totalBytes);
}

function bodyStream(parts: Generator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts.next();
      if (part.done) controller.close();
      else controller.enqueue(part.value);
    },
    cancel() { parts.return(undefined); },
  }, { highWaterMark: 0 });
}

export function taskLogRoutes(store: TaskStore): Hono {
  const app = new Hono();

  app.get('/tasks/:id/runs', (c) => {
    c.header('Cache-Control', 'no-store');
    const id = c.req.param('id');
    if (!store.get(id)) return c.json({ error: 'Task not found' }, 404);
    return c.json({ taskId: id, runs: store.listRuns(id) } satisfies TaskRunListResponse);
  });

  app.get('/tasks/:id/runs/:runId/log', (c) => {
    c.header('Cache-Control', 'no-store');
    const id = c.req.param('id');
    const runId = c.req.param('runId');
    try {
      const request = pageRequest(new URL(c.req.url).searchParams, runId);
      const run = store.listRuns(id).find((item) => item.id === runId);
      if (!run) return c.json({ error: 'Task run not found' }, 404);
      const page = store.readLogPage(id, runId, request);
      if (!page) return c.json({ error: 'Task run not found' }, 404);
      return c.json({ ...page, encoding: 'base64', chunks: page.chunks.map(encoded), archiveState: run.archiveState } satisfies TaskLogPageResponse);
    } catch (error) {
      if (error instanceof RangeError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });

  app.get('/tasks/:id/runs/:runId/download', (c) => {
    c.header('Cache-Control', 'no-store');
    const id = c.req.param('id');
    const runId = c.req.param('runId');
    const run = store.listRuns(id).find((item) => item.id === runId);
    if (!run || !UUID.test(id) || !UUID.test(runId)) return c.json({ error: 'Task run not found' }, 404);
    c.header('X-Task-Archive-State', run.archiveState);
    c.header('Content-Type', 'application/octet-stream');
    c.header('Content-Disposition', `attachment; filename="task-${id}-run-${runId}.log"`);
    c.header('Content-Length', String(run.totalBytes));
    return c.body(bodyStream((function* () {
      for (const chunk of snapshotChunks(store, run)) yield chunk.data;
    })()));
  });

  app.get('/tasks/:id/runs/:runId/messages/download', (c) => {
    c.header('Cache-Control', 'no-store');
    const id = c.req.param('id');
    const runId = c.req.param('runId');
    const run = store.listRuns(id).find((item) => item.id === runId);
    if (!run || !UUID.test(id) || !UUID.test(runId)) return c.json({ error: 'Task run not found' }, 404);
    c.header('Content-Type', 'application/json; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="task-${id}-run-${runId}-messages.json"`);
    return c.body(bodyStream(messageArray(snapshotChunks(store, run))));
  });

  app.get('/tasks/:id/logs/download', (c) => {
    c.header('Cache-Control', 'no-store');
    const id = c.req.param('id');
    if (!UUID.test(id) || !store.get(id)) return c.json({ error: 'Task not found' }, 404);
    const runs = store.listRuns(id);
    c.header('Content-Type', 'application/x-ndjson');
    c.header('Content-Disposition', `attachment; filename="task-${id}-logs.jsonl"`);
    return c.body(bodyStream((function* () {
      function line(record: TaskLogExportRecord): Uint8Array {
        return Buffer.from(JSON.stringify(record) + '\n');
      }
      for (const run of runs) {
        yield line({ type: 'run', run });
        const decoders = new Map<TaskLogChunk['stream'], TextDecoder>();
        for (const chunk of snapshotChunks(store, run)) {
          let decoder = decoders.get(chunk.stream);
          if (!decoder) {
            decoder = new TextDecoder('utf-8');
            decoders.set(chunk.stream, decoder);
          }
          yield line({
            type: 'chunk', runId: run.id, encoding: 'utf8',
            chunk: { sequence: chunk.sequence, byteOffset: chunk.byteOffset, stream: chunk.stream, data: decoder.decode(chunk.data, { stream: true }) },
          });
        }
      }
      yield line({ type: 'complete', taskId: id, totalRuns: runs.length, totalBytes: runs.reduce((total, run) => total + run.totalBytes, 0) });
    })()));
  });

  return app;
}
