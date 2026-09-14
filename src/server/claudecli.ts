/**
 * 用本机的官方 `claude` CLI 发送 Claude 侧的保活文本。
 *
 * 为什么不直接打 `/v1/messages`：OAuth 令牌只在 Claude Code 身份下签发，上游是按整套
 * “请求头 + 请求体”判断调用方是不是真的 CLI 的。逐字复刻出来的请求永远在追一个会变的
 * 目标，而一旦对不上，这一发就不被受理——真正的 CLI 本来就装在这台机器上，让它自己去发
 * 是唯一不会被判错的形态。
 *
 * 代价是拿不到限额响应头，所以窗口重置时间要另外向只读的额度接口问一次，见 providers.ts。
 *
 * 有三件事必须在这里守住：
 *
 * 1. **身份隔离**。CLI 默认读 `~/.claude` 下的登录状态；照原样调用的话，几十个账户会全部
 *    用同一份（也就是用户自己的）身份去发。这里给每个账户单独指一个 `CLAUDE_CONFIG_DIR`，
 *    并只通过 `CLAUDE_CODE_OAUTH_TOKEN` 把该账户的令牌递进去。
 * 2. **环境净化**。父进程里只要有 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_BASE_URL`，CLI 就会
 *    优先用它们——那一发既不属于这个账户，甚至可能根本没打到官方端点。所以子进程的环境
 *    变量是白名单式重建的，而不是继承下来再删几个。
 * 3. **超时**。CLI 卡住会把该账户的整条调度循环一起卡住，因此必须有硬上限，并且真的要
 *    把进程杀掉。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { commandLine, CLI_SCHEME } from '../shared/curl.js';
import type { RequestRecord } from '../shared/types.js';
import { DATA_DIR } from './config.js';

/** CLI 启动加上模型回一句短话，正常在十几秒内结束；余量是留给代理链路抖动的。 */
const DEFAULT_TIMEOUT_MS = 180_000;
/** SIGTERM 之后还赖着不走就不再等了。 */
const KILL_GRACE_MS = 5_000;
/** 连 SIGKILL 都没能让 'close' 到来时的兜底，见 spawnOnce 里的说明。 */
const FORCE_RESOLVE_MS = 1_000;
/** 单条输出最多留这么多，避免模型话痨时把内存吃掉。 */
const OUTPUT_CAP = 64 * 1024;

/**
 * 只透传这几个变量：CLI 需要它们才能正常起来，而且它们都与“用哪个账户发”无关。
 * 其余一律不带——尤其是 ANTHROPIC_* 与 CLAUDE_*，它们会直接改写认证目标。
 */
const PASSTHROUGH_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'TERM',
  'TZ',
  'TMPDIR',
];

/**
 * 这些开关在版本之间增删过，传一个 CLI 不认识的参数会让整次发送直接失败，
 * 而它们本身只是让运行环境更干净，缺了照样能发。因此按 `--help` 自报的内容裁剪。
 */
const OPTIONAL_FLAGS = ['--safe-mode', '--no-session-persistence', '--strict-mcp-config'];

/** 每个账户一个隔离的 CLI 配置目录，账户 ID 里的 `:`、`@` 都不适合直接做目录名。 */
export function configDirFor(accountId: string): string {
  const safe = accountId.replace(/[^A-Za-z0-9._-]/g, '_') || 'default';
  return join(DATA_DIR, 'claude-cli', safe);
}

export interface CliEnvOptions {
  accessToken: string;
  configDir: string;
  proxy?: string;
  noProxy?: readonly string[];
}

/** 子进程的环境变量：白名单透传 + 本次发送真正需要的那几个。 */
export function buildEnv(o: CliEnvOptions, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  env.CLAUDE_CODE_OAUTH_TOKEN = o.accessToken;
  env.CLAUDE_CONFIG_DIR = o.configDir;
  // 输出是拿去解析的，不该混进 ANSI 转义
  env.NO_COLOR = '1';

  const proxy = (o.proxy ?? '').trim();
  if (proxy) {
    // CLI 走的是 Node 自己的 fetch，只认这几个大小写变体，因此两份都给
    env.HTTPS_PROXY = proxy;
    env.HTTP_PROXY = proxy;
    env.https_proxy = proxy;
    env.http_proxy = proxy;
    const bypass = (o.noProxy ?? []).map((r) => r.trim()).filter(Boolean).join(',');
    if (bypass) {
      env.NO_PROXY = bypass;
      env.no_proxy = bypass;
    }
  }
  return env;
}

/**
 * 命令行参数。
 *
 * `--print` + `--output-format json` 是必须的：前者让它跑完就退，后者给出可解析的结果。
 * 文本用 `--` 隔开后再传，免得以 `-` 开头的自定义文本被当成参数。
 */
export function buildArgs(model: string, text: string, flags: readonly string[] = []): string[] {
  const args = ['--print', '--output-format', 'json'];
  if (model.trim()) args.push('--model', model.trim());
  args.push(...flags, '--', text);
  return args;
}

/** `--help` 里出现过的长参数；探测失败时返回空集合，也就是只用必需参数发。 */
async function listFlags(command: string): Promise<Set<string>> {
  const run = await spawnOnce(command, ['--help'], process.env, undefined, 20_000);
  const text = `${run.stdout}\n${run.stderr}`;
  return new Set(text.match(/--[a-z][a-z0-9-]*/g) ?? []);
}

const flagCache = new Map<string, Promise<Set<string>>>();

/** 同一个可执行文件只探测一次：这个进程里它不会中途换版本。 */
async function optionalFlags(command: string): Promise<string[]> {
  let probe = flagCache.get(command);
  if (probe === undefined) {
    probe = listFlags(command);
    flagCache.set(command, probe);
  }
  const supported = await probe;
  return OPTIONAL_FLAGS.filter((f) => supported.has(f));
}

export interface CliRun {
  /** 进程退出码；被信号杀掉时为 null。 */
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** 进程根本没起来时的原因（命令不存在、没有执行权限等）。 */
  spawnError: string;
  durationMs: number;
}

function capped(chunks: string[], size: number, chunk: string): number {
  if (size >= OUTPUT_CAP) return size;
  const slice = chunk.slice(0, OUTPUT_CAP - size);
  chunks.push(slice);
  return size + slice.length;
}

/** 起一个子进程并等它结束；无论成败都以 CliRun 返回，不抛异常。 */
export function spawnOnce(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
  timeoutMs: number,
): Promise<CliRun> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const out: string[] = [];
    const err: string[] = [];
    let outSize = 0;
    let errSize = 0;
    let timedOut = false;
    let settled = false;
    let child: ChildProcess | null = null;
    let timer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let forceTimer: NodeJS.Timeout | null = null;

    const finish = (r: Omit<CliRun, 'stdout' | 'stderr' | 'durationMs'>): void => {
      if (settled) return;
      settled = true;
      for (const t of [timer, killTimer, forceTimer]) if (t !== null) clearTimeout(t);
      // 管道可能还攥在 CLI 的子进程手里；不主动松手的话，这两个句柄会一直挂在事件循环上
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      child?.unref();
      resolve({
        ...r,
        stdout: out.join(''),
        stderr: err.join(''),
        durationMs: Date.now() - startedAt,
      });
    };

    let started: ChildProcess;
    try {
      started = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        spawnError: String((e as Error).message ?? e),
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    child = started;
    timer = setTimeout(() => {
      timedOut = true;
      started.kill('SIGTERM');
      // 先礼后兵：SIGTERM 给它自己收尾的机会，超过宽限期再强杀
      killTimer = setTimeout(() => {
        started.kill('SIGKILL');
        forceTimer = setTimeout(
          () => finish({ code: null, signal: 'SIGKILL', timedOut, spawnError: '' }),
          FORCE_RESOLVE_MS,
        );
      }, KILL_GRACE_MS);
    }, timeoutMs);

    started.stdout?.setEncoding('utf8');
    started.stderr?.setEncoding('utf8');
    started.stdout?.on('data', (c: string) => {
      outSize = capped(out, outSize, c);
    });
    started.stderr?.on('data', (c: string) => {
      errSize = capped(err, errSize, c);
    });

    started.on('error', (e) =>
      finish({ code: null, signal: null, timedOut, spawnError: String(e.message) }),
    );
    /**
     * 正常结束时等 'close'，那时输出才算收全。
     * 但超时被杀的那条路不能等：CLI 可能把 stdout 交给了自己的子进程，那样 'close' 永远
     * 不会来，而这条循环还在上面挂着。所以进程一退就收工，拿到多少输出算多少。
     */
    started.on('exit', (code, signal) => {
      if (timedOut) finish({ code, signal, timedOut, spawnError: '' });
    });
    started.on('close', (code, signal) => finish({ code, signal, timedOut, spawnError: '' }));
  });
}

/** `--output-format json` 的结果对象；这里只取判断成败用得上的几个字段。 */
interface CliResult {
  subtype?: string;
  is_error?: boolean;
  result?: string;
}

/**
 * 从 stdout 里取出那条结果对象。
 *
 * 正常情况下 stdout 只有一段 JSON，但 CLI 偶尔会在前面打点提示，所以是从后往前找
 * 第一条能解析出来的 JSON，而不是整块解析。
 */
export function parseResult(stdout: string): CliResult | null {
  const trimmed = stdout.trim();
  if (trimmed === '') return null;
  const candidates = [trimmed, ...trimmed.split('\n').reverse()];
  for (const line of candidates) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object') return parsed as CliResult;
    } catch {
      /* 不是完整 JSON 的那几行直接跳过 */
    }
  }
  return null;
}

/**
 * 触限时 CLI 说的是人话而不是状态码，而且措辞在版本之间换过好几种：
 *   `Claude usage limit reached`
 *   `You've hit your weekly limit · resets 10pm (Asia/Singapore)`
 *   `5-hour limit reached · resets 3am`
 * 认不出来的后果不是少记一条日志，而是这一发被当成接口故障：重试若干次都白重试，
 * 下一拍还要照失败退避排，等额度真重置了也没人去发——所以宁可把 limit 认宽一点。
 */
const LIMIT_RE =
  /usage limit reached|rate[_ -]?limit|\b429\b|too many requests|(?:hit|reached|exceeded|out of)[^.\n]{0,40}\blimits?\b|\blimits?\b[^.\n]{0,20}(?:reached|exceeded)|quota exceeded/i;
/** 这句话说的是周额度而不是 5 小时额度。 */
const WEEKLY_RE = /weekly|per[- ]week|\bweek\b|7[- ]?day|seven[- ]day/i;
/**
 * 那句话尾巴上的重置时刻，例如 `· resets 10pm (Asia/Singapore)`、`resets at 3:30am`。
 * 括号里的时区是 CLI 自己带的 IANA 名，缺省时按本机时区解释。
 */
const RESET_AT_RE =
  /reset(?:s|ting)?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\s*(?:\(([^)]{1,64})\))?/i;
/** 另一种写法：`resets in 42 minutes` / `try again in 2 hours`。 */
const RESET_IN_RE = /(?:reset\w*|try again)\s+in\s+(\d{1,4})\s*(second|minute|hour|day)s?/i;

/** 触限那句话自报的重置时刻。 */
export interface LimitHint {
  resetAt: number;
  /** 与 ratelimit.ts 的窗口命名保持一致，好直接当 Window 用。 */
  name: '5h' | '7d';
}

/** 某个时区此刻的“零点之后分钟数”；时区名不被 Intl 认识时返回 null。 */
function minutesOfDayIn(tz: string | undefined, at: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(at));
    const get = (type: string): number =>
      Number(parts.find((p) => p.type === type)?.value ?? NaN);
    // hour12:false 在部分实现里把零点报成 24
    const hour = get('hour') % 24;
    const minute = get('minute');
    return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
  } catch {
    return null;
  }
}

/**
 * 从触限文案里解析出下一次重置的绝对时刻。
 *
 * 只给了钟点没给日期，所以取“该时区里下一次走到这个钟点”的那一刻：过了就是明天。
 * 解析不出来时返回 null，由调用方退回估算窗口——这条线索是锦上添花，不是必需品。
 */
export function parseLimitHint(text: string, nowMs = Date.now()): LimitHint | null {
  const name = WEEKLY_RE.test(text) ? '7d' : '5h';

  const rel = RESET_IN_RE.exec(text);
  if (rel !== null) {
    const unit = { second: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000 }[
      rel[2].toLowerCase()
    ]!;
    return { resetAt: nowMs + Number(rel[1]) * unit, name };
  }

  const m = RESET_AT_RE.exec(text);
  if (m === null) return null;
  const hour12 = Number(m[1]);
  if (hour12 < 1 || hour12 > 12) return null;
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  if (minute > 59) return null;
  const target = (hour12 % 12) * 60 + (m[3].toLowerCase() === 'p' ? 720 : 0) + minute;

  const current = minutesOfDayIn(m[4]?.trim(), nowMs);
  if (current === null) return null;
  // 钟点已经走过就是明天的同一时刻；正好相等说明就在这一分钟内重置，按一分钟后算，
  // 反正调度那边还会再加一层 buffer，早一点也只是多问一次
  const delta = target < current ? target - current + 1440 : target - current;
  return { resetAt: nowMs + Math.max(delta, 1) * 60_000, name };
}

/**
 * 令牌不对时 CLI 给的是 `Failed to authenticate. API Error: 403 Request not allowed`，
 * 而不是一个状态码，所以这里连它的原话一起认。403 也算进来：这类拒绝重试多少次都是同一个
 * 结果，早点把账户停下来、让用户去看凭证，好过安静地重试到重试次数耗尽。
 */
const AUTH_RE =
  /failed to authenticate|\b40[13]\b|unauthorized|forbidden|authentication_error|invalid (?:api key|bearer token|token)|oauth token (?:has )?expired|please run\s+\/login|not logged in|no credentials/i;

export interface CliOutcome {
  ok: boolean;
  /**
   * 折算成 HTTP 状态码，好让上层沿用既有的分支：
   * 200 成功、429 已触限、401 认证失败、0 则是“压根没送出去”。
   */
  status: number;
  error: string;
  /** 触限那句话里自报的重置时刻；只有 status 为 429 且解析成功时才有值。 */
  limit: LimitHint | null;
}

/**
 * 判定这一次调用算成功还是失败。
 *
 * CLI 对认证失败、触限这类问题一律只给非零退出码和一段人话，没有状态码，
 * 所以只能按输出内容归类。归错的代价是有限的：401 会停掉该账户，429 会照常排下一拍，
 * 其余都按可重试处理。
 */
export function classify(run: CliRun, nowMs = Date.now()): CliOutcome {
  if (run.spawnError) {
    return { ok: false, status: 0, error: `无法执行 claude 命令: ${run.spawnError}`, limit: null };
  }
  if (run.timedOut) {
    return {
      ok: false,
      status: 0,
      error: `claude 命令超时（${(run.durationMs / 1000).toFixed(0)}s），已终止`,
      limit: null,
    };
  }

  const result = parseResult(run.stdout);
  if (run.code === 0 && result !== null && result.is_error !== true) {
    return { ok: true, status: 200, error: '', limit: null };
  }

  // 出错时的说明可能在 stderr，也可能在结果对象的 result 字段里，两处都要看
  const detail = [run.stderr.trim(), result?.result ?? '', run.stdout.trim()]
    .find((s) => s !== '') ?? '';
  const message = detail.slice(0, 500) || `claude 命令以退出码 ${run.code ?? '?'} 结束`;

  if (LIMIT_RE.test(detail)) {
    return { ok: false, status: 429, error: message, limit: parseLimitHint(detail, nowMs) };
  }
  if (AUTH_RE.test(detail)) return { ok: false, status: 401, error: message, limit: null };
  return { ok: false, status: 0, error: message, limit: null };
}

export interface CliSendOptions {
  accountId: string;
  accessToken: string;
  text: string;
  model: string;
  /** 可执行文件名或绝对路径；留空表示用 PATH 里的 `claude`。 */
  command?: string;
  proxy?: string;
  noProxy?: readonly string[];
  timeoutMs?: number;
}

export interface CliSendResult extends CliOutcome {
  sentAt: number;
  /** 实际执行的命令行，出问题时直接贴给用户看。 */
  commandLine: string;
  /** 这一发在请求日志里的样子，见 toRecord。 */
  record: RequestRecord;
  /** stdout 与 stderr 原样拼在一起，供日志留档。 */
  output: string;
  durationMs: number;
}

/**
 * 把这一发整理成一条请求日志。
 *
 * 走 CLI 就没有报文可记，但决定它去向的东西一样不少：环境变量里写着用哪个令牌、
 * 哪个身份目录、走不走代理，命令行里写着发的是什么。这两样按请求头和请求体的位置
 * 存进同一张表，界面上于是能像看一次 HTTP 请求那样看它。
 *
 * 令牌在落库前会被换成占位符，这里不必先抹——见 http.ts 的 recordOutbound。
 */
function toRecord(command: string, args: readonly string[], env: NodeJS.ProcessEnv): RequestRecord {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) headers[k] = v;
  return {
    method: 'EXEC',
    url: `${CLI_SCHEME}${command}`,
    headers,
    body: commandLine(command, args),
  };
}

/**
 * 留档用的输出。
 *
 * 两条流都要：正常时结果 JSON 在 stdout，而失败原因经常只写在 stderr 里，
 * 只留一条就会出现“日志里什么都看得到，唯独看不到它为什么不行”。
 */
function outputOf(run: CliRun): string {
  const parts: string[] = [];
  if (run.stdout.trim() !== '') parts.push(run.stdout.trimEnd());
  if (run.stderr.trim() !== '') parts.push(`── stderr ──\n${run.stderr.trimEnd()}`);
  return parts.join('\n');
}

/** 代表某个账户跑一次 `claude --print`。 */
export async function sendViaCli(o: CliSendOptions): Promise<CliSendResult> {
  const command = (o.command ?? '').trim() || 'claude';
  const configDir = configDirFor(o.accountId);
  const sentAt = Date.now();

  try {
    // 工作目录用这个隔离目录本身：那里没有任何项目文件，CLI 也就没有额外上下文可读
    await mkdir(configDir, { recursive: true });
  } catch (err) {
    const error = `无法创建 CLI 配置目录 ${configDir}: ${String((err as Error).message ?? err)}`;
    // 连目录都没建起来，环境和参数都还不存在，但这一拍照样要在日志里留下痕迹
    return {
      ok: false,
      status: 0,
      error,
      limit: null,
      sentAt,
      commandLine: command,
      record: toRecord(command, [], {}),
      output: '',
      durationMs: 0,
    };
  }

  const args = buildArgs(o.model, o.text, await optionalFlags(command));
  const env = buildEnv({
    accessToken: o.accessToken,
    configDir,
    proxy: o.proxy,
    noProxy: o.noProxy,
  });
  const run = await spawnOnce(command, args, env, configDir, o.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  return {
    ...classify(run),
    sentAt,
    commandLine: commandLine(command, args),
    record: toRecord(command, args, env),
    output: outputOf(run),
    durationMs: run.durationMs,
  };
}
