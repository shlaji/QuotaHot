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

const HELP = `QuotaHot Hook - 独立的账户额度检查与切换命令，不启动 Web 服务。

用法：
  quotahot-hook status [选项]          查看账户额度和本机当前登录账户
  quotahot-hook switch [选项]          手动切换账户并同步客户端凭证
  quotahot-hook run opencode [选项]    OpenCode 插件的事件入口
  quotahot-hook recovery-status [--json]  查看本地额度恢复等待状态
  quotahot-hook recovery [--json]         recovery-status 的简写
  quotahot-hook install [--print]      安装 OpenCode 插件，清理旧触发器
  quotahot-hook uninstall              移除 QuotaHot 的触发集成
  quotahot-hook help [命令]             查看全局或命令帮助
  quotahot-hook version | --version    查看版本号

各命令可用 --help 查看参数；账户数据默认在 ~/.quotahot，可设置 QUOTAHOT_DATA_DIR。
`;

const COMMAND_HELP: Readonly<Record<string, string>> = {
  'recovery-status': `用法：quotahot-hook recovery-status [--json]

只读取本地 OpenCode 额度恢复快照，不查询上游、不切换账户；过期快照会标为 stale。
  --json  输出含等待会话和插件实例的结构化状态，便于诊断。
`,
  status: `用法：quotahot-hook status [选项]

查询账户额度与本机客户端在用账户，默认查询 Codex；可能更新本地额度缓存。
  --provider <codex|claude>  选择账户类型（默认 codex）。
  --threshold <percent>     上游未明确给出可用结论时，用于判断额度用尽的已用百分比（0–100，默认 80）。
  -c, --cache-seconds <seconds> 优先使用指定秒数内的额度缓存（默认 300）。
  --no-check               不请求上游，仅使用本地缓存；未知用量会标为 skipped。
  --json                   输出完整的账户状态和客户端登录映射。
`,
  switch: `用法：quotahot-hook switch [选项]

手动选择可用账户并覆盖目标客户端的当前登录凭证；切换前可用 --dry-run 预览。
  --provider <codex|claude>  选择账户类型（默认 codex）。
  --client <名称列表>       指定逗号分隔的写回目标：codex-cli、opencode、claude-cli、pi-claude、pi-codex；
                            默认按 provider 同步对应客户端（Pi 仅在已有凭证时写入）。覆盖登录有风险。
  --threshold <percent>     上游未明确给出可用结论时，用于判断额度用尽的已用百分比（0–100，默认 80）。
  -c, --cache-seconds <seconds> 使用额度缓存的秒数（默认 300）。
  -i, --min-interval-seconds <seconds> 两次切换间的最短秒数（默认 60）。
  --reason <text>           设置切换原因（默认“手动触发”）。
  --exhausted              将当前账户直接标为额度用尽并冷却；无需额度证据，请谨慎使用。
  --no-check               不请求上游额度，可能按旧缓存或未知用量选错账户。
  --dry-run                只预览，不写状态、缓存或凭证；过期令牌无法只读刷新。
  --json                   输出完整切换结果（可能包含账户邮箱）。
`,
  run: `用法：quotahot-hook run opencode [选项]

从标准输入读取 OpenCode 事件；只对 OpenAI/Codex 明确额度信号尝试切换，运行故障时不阻断插件。
额度事件固定按 OpenCode 的来源、原因及额度阈值处理，不接受手动切换参数。
  -i, --min-interval-seconds <seconds> 切换间隔（默认 60）；设为 0 会绕过间隔保护。
  --no-check               不查询上游额度，可能按旧缓存或未知用量选错账户。
  --dry-run                只预览，不写切换状态或客户端凭证。
  --json                   标准输出仍是插件 JSON；诊断结果另写标准错误。
`,
  install: `用法：quotahot-hook install [--print]

安装 QuotaHot OpenCode 插件并清理自有的旧 Codex/Pi 触发器，不修改账户凭证。
  --print  只打印插件路径及内容，不安装、不清理、不写文件。
`,
  uninstall: '用法：quotahot-hook uninstall\n\n移除 QuotaHot 自有的 OpenCode 插件和旧触发器，不删除账户凭证。\n',
  version: '用法：quotahot-hook version\n\n打印当前独立 hook 程序的版本号，不启动服务。\n',
};

class UsageError extends Error {}

type Flags = {
  readonly values: Readonly<Record<string, string>>;
  readonly bools: ReadonlySet<string>;
  readonly positional: readonly string[];
};

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
    if (['help', 'json', 'no-check', 'dry-run', 'exhausted', 'print'].includes(name)) {
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
  if (client !== 'opencode' || flags.positional.length !== 1) throw new UsageError('run 只接受 opencode 作为事件来源');
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
  const [rawCommand, ...rest] = argv;
  const command = rawCommand === 'recovery' ? 'recovery-status' : rawCommand;
  const flags = parseFlags(rest);
  try {
    const supported: Readonly<Record<string, readonly string[]>> = {
      status: ['help', 'provider', 'threshold', 'cache-seconds', 'no-check', 'json'],
      switch: ['help', 'provider', 'client', 'threshold', 'cache-seconds', 'min-interval-seconds', 'reason', 'exhausted', 'no-check', 'dry-run', 'json'],
      run: ['help', 'json', 'no-check', 'dry-run', 'min-interval-seconds'],
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
      for (const option of ['help', 'json', 'no-check', 'dry-run', 'exhausted', 'print']) {
        if (flags.values[option] !== undefined) throw new UsageError(`${command} 的 --${option} 不接受参数`);
      }
      for (const option of ['threshold', 'cache-seconds', 'min-interval-seconds']) {
        const value = flags.values[option];
        if (flags.bools.has(option) || (value !== undefined && (value.trim() === '' || !Number.isFinite(Number(value)) || Number(value) < 0 || (option === 'threshold' && Number(value) > 100)))) {
          throw new UsageError(`${command} 的 --${option} 需要${option === 'threshold' ? ' 0 到 100 的百分比' : '非负秒数'}`);
        }
      }
      if (command !== 'run' && command !== 'switch' && flags.positional.length > 0) throw new UsageError(`${command} 不接受额外参数`);
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
      case 'run': return await runEvent(flags.positional[0], flags);
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
