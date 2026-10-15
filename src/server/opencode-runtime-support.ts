import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { CreateTaskInput } from '../shared/tasks.js';

export type Session = { readonly id: string; readonly parentID: string | null; readonly directory: string };
export type SessionStatus = 'idle' | 'busy' | 'retry';
export type SessionMessage = {
  readonly role: string;
  readonly completed: boolean;
  readonly error: string;
  readonly finish: string;
};

export function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function createEnvironment(
  task: CreateTaskInput,
  extra: NodeJS.ProcessEnv | undefined,
  proxy: string,
  noProxy: readonly string[],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra, PWD: task.directory };
  if (!proxy) return env;
  env.HTTP_PROXY = proxy;
  env.HTTPS_PROXY = proxy;
  env.http_proxy = proxy;
  env.https_proxy = proxy;
  const bypass = noProxy.map((rule) => rule.trim()).filter(Boolean).join(',');
  env.NO_PROXY = bypass;
  env.no_proxy = bypass;
  delete env.ALL_PROXY;
  delete env.all_proxy;
  return env;
}

export async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('OpenCode serve did not provide a port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

export async function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  await delay(milliseconds, undefined, { signal });
}

export function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null { return typeof value === 'string' && value ? value : null; }

export function rootSessionId(value: unknown): string | null {
  const event = jsonObject(value);
  if (!event) return null;
  if (stringValue(event.type)?.includes('session')) {
    const id = stringValue(event.id);
    if (id) return id;
  }
  for (const key of ['sessionID', 'sessionId', 'session_id']) {
    const id = stringValue(event[key]);
    if (id) return id;
  }
  for (const key of ['session', 'properties', 'info', 'data']) {
    const nested = rootSessionId(event[key]);
    if (nested) return nested;
  }
  return null;
}

function messageInfo(value: unknown): SessionMessage | null {
  const outer = jsonObject(value);
  const info = jsonObject(outer?.info) ?? outer;
  if (!info || info.role !== 'assistant') return null;
  const time = jsonObject(info.time);
  const completed = typeof time?.completed === 'number' || typeof time?.completed === 'string';
  const errorValue = info.error;
  const error = errorValue === undefined ? '' : stringValue(errorValue) ??
    stringValue(jsonObject(errorValue)?.message) ?? JSON.stringify(errorValue) ?? 'OpenCode assistant error';
  const finish = stringValue(info.finish) ?? '';
  return { role: 'assistant', completed, error, finish };
}

export function requestUrl(base: string, path: string, directory: string): string {
  const url = new URL(path, base);
  url.searchParams.set('directory', directory);
  return url.toString();
}

export function sessionMessage(value: unknown): SessionMessage | null {
  if (Array.isArray(value)) return value.map(messageInfo).find((message): message is SessionMessage => message !== null) ?? null;
  return messageInfo(value);
}

export function sessionList(value: unknown): Session[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const session = jsonObject(item);
    const id = stringValue(session?.id);
    const directory = stringValue(session?.directory);
    if (!id || !directory) return [];
    const parentID = stringValue(session?.parentID) ?? stringValue(session?.parentId);
    return [{ id, directory, parentID }];
  });
}

export function statusMap(value: unknown): ReadonlyMap<string, SessionStatus> {
  const object = jsonObject(value);
  const entries = object ? Object.entries(object) : [];
  return new Map(entries.flatMap(([id, status]) => {
    const type = stringValue(jsonObject(status)?.type);
    return type === 'idle' || type === 'busy' || type === 'retry' ? [[id, type]] : [];
  }));
}

export function isErrorMessage(message: SessionMessage): boolean {
  return Boolean(message.error) || message.finish === 'error' || message.finish === 'abort';
}
