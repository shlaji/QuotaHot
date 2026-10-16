import { Hono } from 'hono';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { MAX_TASK_MESSAGE_LENGTH, type TaskModelsResponse } from '../shared/tasks.js';
import type { TaskScheduler } from './task-scheduler.js';
import { TaskError } from './task-error.js';
import { parseTaskInput } from './task-input.js';
import { listTaskModels } from './task-models.js';

export function taskRoutes(
  scheduler: TaskScheduler,
  now: () => number = Date.now,
  models: (directory: string) => Promise<string[]> = listTaskModels,
): Hono {
  const app = new Hono();
  app.onError((error, context) => {
    if (error instanceof TaskError) return context.json({ error: error.message }, error.status);
    throw error;
  });
  app.get('/tasks', (context) => context.json(scheduler.list()));
  app.get('/tasks/models', async (context) => {
    const directory = context.req.query('directory')?.trim() || scheduler.list().defaultDirectory;
    if (!isAbsolute(directory) || directory.includes('\0')) {
      throw new TaskError('Directory must be an absolute existing directory', 400);
    }
    try {
      if (!(await stat(directory)).isDirectory()) throw new TaskError('Directory is not a directory', 400);
    } catch (error) {
      if (error instanceof TaskError) throw error;
      if (error instanceof Error) throw new TaskError('Cannot access directory; choose an existing readable directory', 400);
      throw error;
    }
    const response: TaskModelsResponse = { models: await models(directory), directory };
    return context.json(response);
  });
  app.post('/tasks', async (context) => {
    let raw: unknown;
    try {
      raw = await context.req.json<unknown>();
    } catch (error) {
      if (error instanceof SyntaxError) throw new TaskError('Malformed JSON', 400);
      throw error;
    }
    const input = await parseTaskInput(raw, now());
    return context.json(scheduler.create(input), 201);
  });
  app.post('/tasks/:id/cancel', async (context) => context.json(await scheduler.cancel(context.req.param('id'))));
  app.post('/tasks/:id/messages', async (context) => {
    let raw: unknown;
    try {
      raw = await context.req.json<unknown>();
    } catch (error) {
      if (error instanceof SyntaxError) throw new TaskError('Malformed JSON', 400);
      throw error;
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).length !== 1 || !('message' in raw)
      || typeof raw.message !== 'string' || !raw.message.trim()
      || raw.message.length > MAX_TASK_MESSAGE_LENGTH || raw.message.includes('\0')) {
      throw new TaskError(`Expected only a message containing 1 to ${MAX_TASK_MESSAGE_LENGTH} characters without NUL`, 400);
    }
    return context.json(scheduler.continueTask(context.req.param('id'), raw.message), 202);
  });
  app.delete('/tasks/:id', (context) => {
    const id = context.req.param('id');
    scheduler.remove(id);
    return context.json({ removed: id });
  });
  return app;
}
