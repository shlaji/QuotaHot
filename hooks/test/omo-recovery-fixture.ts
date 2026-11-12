import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';
import { omoPlugin } from '../src/install.js';

type Reply = {
  readonly outcome: string;
  readonly latestData?: boolean;
  readonly waitUntil?: number;
  readonly switched?: boolean;
  readonly resume?: boolean;
};
type Handler = (event: Record<string, unknown>, ctx?: Record<string, unknown>) => unknown;
type Timer = { unref(): void };

export function omoRecoveryFixture(t: TestContext) {
  let wallClock = 100;
  let clock = 100;
  let watchFailures = 0;
  let state = '{}';
  const timers = new Map<Timer, { at: number; callback: () => unknown }>();
  const files = new Map<string, string>();
  const watchers = new Set<EventEmitter & { changed: () => void; close(): void }>();
  const payloads: Array<{ recover?: boolean; quotaCheckAfter?: number }> = [];
  const children: Array<{ finish(reply: Reply): void; killed(): boolean }> = [];
  const messages: string[] = [];
  const notifications: string[] = [];
  const sessions: Array<{ handlers: Map<string, Handler>; ctx: Record<string, unknown> }> = [];
  const modules: Record<string, Record<string, unknown>> = {
    crypto: { randomUUID },
    os: { homedir: () => '/isolated' },
    path: { dirname, join },
    fs: {
      watch: (_path: string, changed: () => void) => {
        if (watchFailures > 0) { watchFailures -= 1; throw new Error('watch unavailable'); }
        const watcher = Object.assign(new EventEmitter(), {
          changed, unref() {}, close: () => { watchers.delete(watcher); },
        });
        watchers.add(watcher);
        return watcher;
      },
    },
    'fs/promises': {
      readFile: async (path: string) => path.endsWith('switch-state.json') ? state : files.get(path),
      mkdir: async () => undefined,
      writeFile: async (path: string, contents: string) => { files.set(path, contents); },
      rename: async (from: string, to: string) => { files.set(to, files.get(from) ?? ''); files.delete(from); },
      unlink: async (path: string) => { files.delete(path); },
      rm: async (path: string) => { files.delete(path); },
    },
    child_process: {
      spawn: () => {
        let killed = false;
        const child = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(), stderr: new EventEmitter(),
          stdin: Object.assign(new EventEmitter(), { end: (input: string) => { payloads.push(JSON.parse(input)); } }),
          kill: () => { killed = true; child.emit('close', null); return true; },
        });
        children.push({
          finish: (reply) => {
            child.stdout.emit('data', Buffer.from(JSON.stringify(reply)));
            child.emit('close', 0);
          },
          killed: () => killed,
        });
        return child;
      },
    },
  };
  const bindings: Record<string, unknown> = {};
  const source = omoPlugin(['fake-hook']).replace(
    /^import\s+\{([^}]+)\}\s+from\s+['"]node:([^'"]+)['"];?\s*$/gm,
    (_line: string, imports: string, module: string) => {
      for (const field of imports.split(',')) {
        const [name, alias] = field.trim().split(/\s+as\s+/);
        assert.ok(name && modules[module] && name in modules[module], `Missing test binding: ${module}.${name}`);
        bindings[alias ?? name] = modules[module][name];
      }
      return '';
    },
  ).replace('export default function (pi)', 'function install(pi)');
  const install: (pi: object) => void = runInNewContext(`${source}\ninstall;`, {
    ...bindings, Buffer, AbortController, console,
    Date: { now: () => wallClock },
    process: { pid: 123, env: { QUOTAHOT_DATA_DIR: '/isolated/data' } },
    setTimeout: (callback: () => unknown, delay: number) => {
      const timer = { unref() {} };
      timers.set(timer, { at: clock + delay, callback });
      return timer;
    },
    clearTimeout: (timer: Timer) => { timers.delete(timer); },
  });
  const flush = async () => { for (let i = 0; i < 80; i += 1) await Promise.resolve(); };
  const advance = async (duration: number) => {
    clock += duration;
    wallClock += duration;
    for (let round = 0; round < 100; round += 1) {
      const due = [...timers].filter(([, timer]) => timer.at <= clock);
      if (!due.length) break;
      for (const [timer, task] of due) {
        if (!timers.delete(timer)) continue;
        task.callback();
      }
      await flush();
    }
    await flush();
  };
  const session = (id: string, agentDir = '/isolated/agent') => {
    const handlers = new Map<string, Handler>();
    const controller = new AbortController();
    let idle = true;
    let reloads = 0;
    install({
      on: (name: string, handler: Handler) => { handlers.set(name, handler); },
      setSessionModel: async () => true,
      sendUserMessage: async () => { messages.push(id); },
    });
    const ctx = {
      model: { provider: 'chatgpt-subscription' }, agentDir, signal: controller.signal, hasUI: true,
      sessionManager: { getSessionId: () => id },
      isIdle: () => idle,
      ui: { notify: (message: string) => { notifications.push(message); } },
      modelRegistry: { authStorage: {
        get: () => ({ type: 'oauth', accountId: 'account', email: 'test@example.invalid', loginId: 'login' }),
        reload: () => { reloads += 1; return 'loaded'; },
      } },
    };
    sessions.push({ handlers, ctx });
    const begin = async () => {
      await handlers.get('before_provider_request')?.({}, ctx);
      await handlers.get('turn_end')?.({ message: {
        role: 'assistant', provider: 'chatgpt-subscription', stopReason: 'error', errorMessage: 'quota exhausted',
      } }, ctx);
      const pending = Promise.resolve(handlers.get('agent_before_settle')?.({ outcome: 'error', entries: [] }, ctx));
      await flush();
      return { pending };
    };
    return {
      begin, controller,
      fail: async (reply: Reply) => {
        const { pending } = await begin();
        children.at(-1)?.finish(reply);
        await pending;
        await flush();
      },
      input: async (attribution = 'user') => { await handlers.get('input')?.({ attribution }, ctx); await flush(); },
      end: async (stopReason: string) => {
        await handlers.get('turn_end')?.({ message: { role: 'assistant', stopReason } }, ctx);
        await flush();
      },
      shutdown: async () => { await handlers.get('session_shutdown')?.({}, ctx); await flush(); },
      setIdle: (value: boolean) => { idle = value; },
      reloads: () => reloads,
    };
  };
  t.after(async () => {
    for (const item of sessions) await item.handlers.get('session_shutdown')?.({}, item.ctx);
    await flush();
  });
  return {
    session, advance, flush, children, payloads, messages, notifications, files, timers, watchers,
    jumpWallClock: (duration: number) => { wallClock += duration; },
    setState: (value: object) => { state = JSON.stringify(value); },
    emitState: () => { for (const watcher of [...watchers]) watcher.changed(); },
    failWatch: () => { watchFailures += 1; },
    now: () => wallClock,
  };
}
