import {
  CLIENTS,
  DEFAULT_CACHE_MS,
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_THRESHOLD,
  STATE_PATH,
  surveyAccounts,
  switchAccount,
  type AccountStatus,
  type SwitchOptions,
} from './switcher.js';
import { runHook } from './runtime.js';
import { install } from './install-cli.js';
import type { Provider } from './types.js';
import { readRecoveryStatus } from './recovery-status.js';
import { APP_VERSION } from './version.js';
import { HELP, COMMAND_HELP } from './cli-help.js';
import { UsageError, type Flags } from './cli-types.js';
import { notify } from './notification-cli.js';

function canonicalOptionName(name: string): string {
  switch (name) {
    case 'c': return 'cache-seconds';
    case 'i': return 'min-interval-seconds';
    default: return name;
  }
}

function parseFlags(argv: readonly string[]): Flags {
  const values: Record<string, string> = {};
  const bools = new Set<string>();
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === '-h') {
      bools.add('help');
      continue;
    }
    const prefixLength = argument.startsWith('--') ? 2 : argument.startsWith('-') ? 1 : 0;
    if (prefixLength === 0) {
      positional.push(argument);
      continue;
    }
    const body = argument.slice(prefixLength);
    const separator = body.indexOf('=');
    if (separator >= 0) {
      values[canonicalOptionName(body.slice(0, separator))] = body.slice(separator + 1);
      continue;
    }
    const name = canonicalOptionName(body);
    if (['help', 'json', 'no-check', 'dry-run', 'exhausted', 'print', 'yes'].includes(name)) {
      bools.add(name);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values[name] = next;
      index += 1;
    } else {
      bools.add(name);
    }
  }
  return { values, bools, positional };
}

function numeric(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function switchOptions(flags: Flags): Partial<SwitchOptions> {
  const clients = (flags.values.client ?? '').split(',').map((client) => client.trim()).filter(Boolean);
  const unknown = clients.filter((client) => !(client in CLIENTS));
  if (unknown.length > 0) throw new UsageError(`Unknown clients: ${unknown.join(', ')}`);
  const rawProvider = flags.values.provider;
  if (flags.bools.has('provider') || (rawProvider !== undefined && rawProvider !== 'codex' && rawProvider !== 'claude')) {
    throw new UsageError(`Invalid --provider: ${rawProvider ?? '(missing)'}`);
  }
  const provider: Provider = rawProvider ?? 'codex';
  return {
    provider,
    clients,
    threshold: numeric(flags.values.threshold, DEFAULT_THRESHOLD),
    cacheMs: numeric(flags.values['cache-seconds'], DEFAULT_CACHE_MS / 1000) * 1000,
    minIntervalMs: numeric(flags.values['min-interval-seconds'], DEFAULT_MIN_INTERVAL_MS / 1000) * 1000,
    check: !flags.bools.has('no-check'),
    dryRun: flags.bools.has('dry-run'),
    exhausted: flags.bools.has('exhausted'),
    ...(flags.values.reason ? { reason: flags.values.reason } : {}),
  };
}

function statusLine(status: AccountStatus): string {
  const percent = status.usedPercent === null ? 'usage unknown' : `${Math.round(status.usedPercent)}% used`;
  const reset = status.resetAt > 0 ? `, resets ${new Date(status.resetAt).toLocaleString()}` : '';
  return `${status.usable ? 'available' : 'unavailable'} ${status.email}: ${percent}${reset} (${status.source}${status.error ? `: ${status.error}` : ''})`;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function runEvent(client: string | undefined, flags: Flags): Promise<number> {
  if ((client !== 'opencode' && client !== 'omo') || flags.positional.length !== 1) throw new UsageError('run 只接受 opencode 或 omo 作为事件来源');
  try {
    const output = await runHook(client, await readStdin(), switchOptions(flags));
    console.log(output.stdout);
    if (flags.bools.has('json')) console.error(JSON.stringify({ outcome: output.outcome }));
  } catch (error) {
    if (error instanceof UsageError) throw error;
    console.error('quotahot-hook outcome: unknown');
    console.log('{"switched":false,"outcome":"unknown"}');
  }
  return 0;
}

export async function run(argv: readonly string[]): Promise<number> {
  const [rawCommand, ...rest] = argv;
  const command = rawCommand === 'recovery' ? 'recovery-status' : rawCommand;
  const flags = parseFlags(rest);
  try {
    const supported: Readonly<Record<string, readonly string[]>> = {
      status: ['help', 'provider', 'threshold', 'cache-seconds', 'no-check', 'json'],
      switch: ['help', 'provider', 'client', 'threshold', 'cache-seconds', 'min-interval-seconds', 'reason', 'exhausted', 'no-check', 'dry-run', 'json'],
      run: ['help', 'json', 'no-check', 'dry-run', 'min-interval-seconds'],
      notify: ['help', 'json', 'group', 'yes', 'print'],
      install: ['help', 'print'],
      uninstall: ['help'],
      'recovery-status': ['help', 'json'],
      version: ['help'], '--version': ['help'],
    };
    const allowed = command === undefined ? undefined : supported[command];
    if (allowed) {
      for (const argument of rest) {
        if (argument === '-h') continue;
        if (argument.startsWith('-')) {
          const prefixLength = argument.startsWith('--') ? 2 : 1;
          const option = argument.slice(prefixLength).split('=', 1)[0];
          if (!allowed.includes(canonicalOptionName(option))) throw new UsageError(`${command} 不支持选项 ${argument.split('=', 1)[0]}`);
        }
      }
      for (const option of ['help', 'json', 'no-check', 'dry-run', 'exhausted', 'print', 'yes']) {
        if (flags.values[option] !== undefined) throw new UsageError(`${command} 的 --${option} 不接受参数`);
      }
      for (const option of ['threshold', 'cache-seconds', 'min-interval-seconds']) {
        const value = flags.values[option];
        if (flags.bools.has(option) || (value !== undefined && (value.trim() === '' || !Number.isFinite(Number(value)) || Number(value) < 0 || (option === 'threshold' && Number(value) > 100)))) {
          throw new UsageError(`${command} 的 --${option} 需要${option === 'threshold' ? ' 0 到 100 的百分比' : '非负秒数'}`);
        }
      }
      if (command !== 'run' && command !== 'switch' && command !== 'notify' && command !== 'install' && command !== 'uninstall' && flags.positional.length > 0) throw new UsageError(`${command} 不接受额外参数`);
    }
    if (command === 'run') {
    }
    if (command === 'version' || command === '--version') {
      console.log(APP_VERSION);
      return 0;
    }
    if (command === 'help' && flags.positional[0] !== undefined) {
      const help = COMMAND_HELP[flags.positional[0] === 'recovery' ? 'recovery-status' : flags.positional[0]];
      if (help === undefined) throw new UsageError(`Unknown command: ${flags.positional[0]}`);
      console.log(help);
      return 0;
    }
    if (command !== undefined && flags.bools.has('help')) {
      const help = COMMAND_HELP[command];
      if (help === undefined) throw new UsageError(`Unknown command: ${command}`);
      console.log(help);
      return 0;
    }
    switch (command) {
      case 'recovery-status': {
        if (flags.positional.length > 0 || flags.values.provider !== undefined) throw new UsageError('recovery-status accepts only --json');
        const state = readRecoveryStatus();
        if (flags.bools.has('json')) console.log(JSON.stringify(state, null, 2));
        else if (state.totalWaiting === 0) console.log('没有正在等待的 OpenCode / OmO 额度恢复任务');
        else {
          const active = state.instances.filter((instance) => !instance.stale);
          console.log(`等待恢复的会话: ${state.totalWaiting} · 插件实例: ${active.length}`);
          for (const instance of active) {
            const next = instance.nextCheckAt === null ? '未安排' : new Date(instance.nextCheckAt).toLocaleString();
            console.log(`${instance.source === 'omo' ? 'OmO' : 'OpenCode'} · 进程 ${instance.pid} · ${instance.stale ? '状态可能过期' : instance.phase} · 下次检查: ${next}`);
            for (const session of instance.sessions) console.log(`  ${session.sessionID}: ${session.phase}`);
          }
        }
        return 0;
      }
      case 'status': {
        const options = switchOptions(flags);
        const survey = await surveyAccounts(options.provider ?? 'codex', {
          threshold: options.threshold ?? DEFAULT_THRESHOLD,
          cacheMs: options.cacheMs ?? DEFAULT_CACHE_MS,
          check: options.check ?? true,
        });
        if (flags.bools.has('json')) console.log(JSON.stringify(survey, null, 2));
        else for (const status of survey.statuses) console.log(statusLine(status));
        return 0;
      }
      case 'switch': {
        const result = await switchAccount(switchOptions(flags));
        console.log(flags.bools.has('json') ? JSON.stringify(result, null, 2) : result.message);
        return 0;
      }
      case 'run': return await runEvent(flags.positional[0], flags);
      case 'notify': return await notify(flags);
      case 'install': return await install(flags.positional, { remove: false, print: flags.bools.has('print') });
      case 'uninstall': return await install(flags.positional, { remove: true, print: false });
      case 'help':
      case '--help':
      case '-h':
      case undefined:
        console.log(HELP);
        return 0;
      default:
        console.error(HELP);
        return 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return error instanceof UsageError ? 2 : 1;
  }
}

void run(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
  process.stdout.write('', () => process.exit(code));
});

export { STATE_PATH };
