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
import {
  installOpencode,
  opencodePlugin,
  opencodePluginPath,
  selfInvocation,
  uninstallCodex,
  uninstallOpencode,
  uninstallPi,
  type InstallReport,
} from './install.js';
import type { Provider } from './types.js';
import { readRecoveryStatus } from './recovery-status.js';
import { APP_VERSION } from './version.js';

const HELP = `QuotaHot Hook - standalone account switching hooks

Usage:
  quotahot-hook status [options]
  quotahot-hook recovery-status [--json]
  quotahot-hook switch [options]
  quotahot-hook run opencode [options]
  quotahot-hook install [--print]
  quotahot-hook uninstall
  quotahot-hook help
  quotahot-hook version
  quotahot-hook --version
`;

const COMMAND_HELP: Readonly<Record<string, string>> = {
  'recovery-status': `Usage: quotahot-hook recovery-status [--json]

Reads local OpenCode recovery snapshots; never queries upstream quota.
`,
  status: `Usage: quotahot-hook status [options]

Options:
  --provider <codex|claude>
  --threshold <percent>
  --cache-seconds <seconds>
  --no-check
  --json
`,
  switch: `Usage: quotahot-hook switch [options]

Options:
  --provider <codex|claude>
  --client <codex-cli|opencode|claude-cli|pi-claude|pi-codex>
  --threshold <percent>
  --cache-seconds <seconds>
  --min-interval-seconds <seconds>
  --reason <text>
  --exhausted
  --no-check
  --dry-run
  --json
`,
  run: `Usage: quotahot-hook run opencode [options]

Options:
  --provider <codex|claude>
  --client <codex-cli|opencode|claude-cli|pi-claude|pi-codex>
  --threshold <percent>
  --cache-seconds <seconds>
  --min-interval-seconds <seconds>
  --reason <text>
  --no-check
  --dry-run
  --json
`,
  install: `Usage: quotahot-hook install [--print]

Options:
  --print
`,
  uninstall: 'Usage: quotahot-hook uninstall\n',
};

class UsageError extends Error {}

type Flags = {
  readonly values: Readonly<Record<string, string>>;
  readonly bools: ReadonlySet<string>;
  readonly positional: readonly string[];
};

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
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }
    const separator = argument.indexOf('=');
    if (separator >= 0) {
      values[argument.slice(2, separator)] = argument.slice(separator + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values[argument.slice(2)] = next;
      index += 1;
    } else {
      bools.add(argument.slice(2));
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
  if (client !== 'opencode' || flags.positional.length !== 1) return 2;
  try {
    const output = await runHook(client, await readStdin(), switchOptions(flags));
    console.log(output.stdout);
    if (flags.bools.has('json')) console.error(JSON.stringify({ outcome: output.outcome }));
  } catch {
    console.error('quotahot-hook outcome: unknown');
    console.log('{"switched":false,"outcome":"unknown"}');
  }
  return 0;
}

async function install(flags: Flags, remove: boolean): Promise<number> {
  if (flags.positional.length > 0) throw new UsageError(`Unexpected target: ${flags.positional[0]}`);
  if (flags.bools.has('print')) {
    console.log(`# ${await opencodePluginPath()}\n${opencodePlugin([...selfInvocation(), 'run', 'opencode'])}`);
    return 0;
  }
  const reports: InstallReport[] = remove
    ? await Promise.all([uninstallOpencode(), uninstallCodex(), uninstallPi()])
    : [await installOpencode([...selfInvocation(), 'run', 'opencode']), await uninstallCodex(), await uninstallPi()];
  for (const report of reports) for (const change of report.changes) console.log(change);
  return 0;
}

export async function run(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  try {
    if (command === 'version' || command === '--version') {
      console.log(APP_VERSION);
      return 0;
    }
    if (command === 'help' && flags.positional[0] !== undefined) {
      const help = COMMAND_HELP[flags.positional[0]];
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
        else if (state.totalWaiting === 0) console.log('没有正在等待的 OpenCode 额度恢复任务');
        else {
          const active = state.instances.filter((instance) => !instance.stale);
          console.log(`等待恢复的会话: ${state.totalWaiting} · 插件实例: ${active.length}`);
          for (const instance of active) {
            const next = instance.nextCheckAt === null ? '未安排' : new Date(instance.nextCheckAt).toLocaleString();
            console.log(`进程 ${instance.pid} · ${instance.stale ? '状态可能过期' : instance.phase} · 下次检查: ${next}`);
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
      case 'run': return runEvent(flags.positional[0], flags);
      case 'install': return await install(flags, false);
      case 'uninstall': return await install(flags, true);
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
