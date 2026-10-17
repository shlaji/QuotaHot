import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import type { CreateTaskInput, TaskTrigger } from '../shared/tasks.js';
import { TaskError } from './task-error.js';

export async function parseTaskInput(raw: unknown, now = Date.now()): Promise<CreateTaskInput> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new TaskError('Expected a task object', 400);
  const description = 'description' in raw ? raw.description : undefined;
  const model = 'model' in raw ? raw.model : undefined;
  const directory = 'directory' in raw ? raw.directory : homedir();
  const trigger = 'trigger' in raw ? raw.trigger : undefined;
  if (typeof description !== 'string' || !description.trim() || description.length > 32000 || description.includes('\0')) {
    throw new TaskError('Description must contain 1 to 32000 characters without NUL', 400);
  }
  if (typeof model !== 'string' || model.length > 200 || !/^[^\s/\0]+\/[^\s\0]+$/.test(model)) {
    throw new TaskError('Model must be provider/model, without whitespace, at most 200 characters', 400);
  }
  if (typeof directory !== 'string' || !isAbsolute(directory) || directory.includes('\0')) {
    throw new TaskError('Directory must be an absolute existing directory', 400);
  }
  let parsedTrigger: TaskTrigger;
  if (trigger === null || typeof trigger !== 'object' || Array.isArray(trigger) || !('type' in trigger)) throw new TaskError('Invalid trigger', 400);
  switch (trigger.type) {
    case 'quota':
      if (Object.keys(trigger).length !== 1) throw new TaskError('Quota trigger accepts only type', 400);
      parsedTrigger = { type: 'quota' }; break;
    case 'time': {
      const at = 'at' in trigger ? trigger.at : undefined;
      if (Object.keys(trigger).length !== 2 || typeof at !== 'number' || !Number.isFinite(at) || at <= now || !Number.isFinite(new Date(at).getTime())) {
        throw new TaskError('Trigger time must be a finite future timestamp', 400);
      }
      parsedTrigger = { type: 'time', at };
      break;
    }
    case 'task': {
      const taskId = 'taskId' in trigger ? trigger.taskId : undefined;
      if (Object.keys(trigger).length !== 2 || typeof taskId !== 'string' || !taskId.trim()
        || taskId !== taskId.trim() || taskId.includes('\0')) {
        throw new TaskError('Task trigger requires only type and a nonempty taskId without whitespace padding or NUL', 400);
      }
      parsedTrigger = { type: 'task', taskId };
      break;
    }
    default: throw new TaskError('Trigger must be quota, time or task', 400);
  }
  try {
    if (!(await stat(directory)).isDirectory()) throw new TaskError('Directory is not a directory', 400);
  } catch (error) {
    if (error instanceof TaskError) throw error;
    throw new TaskError(`Cannot access directory: ${error instanceof Error ? error.message : String(error)}`, 400);
  }
  return { description, model, directory, trigger: parsedTrigger };
}
