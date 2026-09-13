/**
 * 把一次上游请求还原成可直接粘进终端的 curl 命令。
 *
 * 凭证的处理分两步，目的是让复制出来的 curl **拿去就能跑**：
 *
 * 1. 落库时把凭证换成占位符（maskSecrets）。令牌每小时轮换，
 *    存历史令牌既没用又平白把凭证抄进一个没有 0600 保护的 SQLite 文件。
 * 2. 读取时再由服务端换回**当前**凭证（fillSecrets）。所以哪怕是三天前那条请求，
 *    curl 里带的也是此刻有效的那个令牌。
 *
 * 替换按**值**做而不是按字段名：令牌可能出现在 authorization 头里，也可能出现在
 * 刷新请求的 JSON 正文或某个查询串里。只盯着 authorization 会漏掉后两种。
 */
import type { RequestRecord } from './types.js';

export const TOKEN_PLACEHOLDER = '$QUOTAHOT_TOKEN';
export const REFRESH_PLACEHOLDER = '$QUOTAHOT_REFRESH_TOKEN';

/** 这一次请求用到的凭证原文。 */
export interface Secrets {
  accessToken: string;
  refreshToken?: string;
}

/**
 * 短值一律不替换。真实令牌都远超这个长度，而短字符串（空串、`cli`、`0`）
 * 会在正文里到处命中，把一条本该可读的日志改得面目全非。
 */
const MIN_SECRET_LEN = 16;

/** 单引号字符串里唯一需要处理的就是单引号本身。 */
function sq(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

type Pair = [from: string, to: string];

function applyPairs(text: string, pairs: Pair[]): string {
  let out = text;
  for (const [from, to] of pairs) out = out.split(from).join(to);
  return out;
}

function swapAll(req: RequestRecord, pairs: Pair[]): RequestRecord {
  if (pairs.length === 0) return req;
  return {
    method: req.method,
    url: applyPairs(req.url, pairs),
    headers: Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k, applyPairs(v, pairs)]),
    ),
    body: applyPairs(req.body, pairs),
  };
}

/**
 * 本次真正参与替换的凭证。判断长度用的始终是**凭证原文**而不是占位符——
 * 占位符本身很短，拿它去过滤会让回填这一步整个失效。
 */
function live(s: Secrets): { secret: string; placeholder: string }[] {
  return [
    { secret: s.accessToken, placeholder: TOKEN_PLACEHOLDER },
    { secret: s.refreshToken ?? '', placeholder: REFRESH_PLACEHOLDER },
  ].filter((p) => p.secret.length >= MIN_SECRET_LEN);
}

/** 落库前：凭证原文 → 占位符。 */
export function maskSecrets(req: RequestRecord, s: Secrets): RequestRecord {
  return swapAll(
    req,
    live(s).map(({ secret, placeholder }): Pair => [secret, placeholder]),
  );
}

/**
 * 读取时：占位符 → 当前凭证。只有服务端能做这件事——它才拿得到账户文件。
 * 某个凭证为空时保持占位符不动，好过写出一个 `Bearer ` 的空头。
 */
export function fillSecrets(req: RequestRecord, s: Secrets): RequestRecord {
  return swapAll(
    req,
    live(s).map(({ secret, placeholder }): Pair => [placeholder, secret]),
  );
}

/* ── 响应体 ────────────────────────────────────────────────────────────── */

/**
 * 上游**返回**的凭证，按字段名抹掉。
 *
 * 按值替换那一套在这里够不着：令牌端点响应里的是**刚签发**的新凭证，
 * 而我们手上只有旧的。不抹的话，一次刷新就会把一份长期有效的 refresh_token
 * 抄进 SQLite 文件里长期留着——请求侧特意避免的事情，不该从响应侧漏回来。
 */
const CREDENTIAL_FIELD = /"(access_token|refresh_token|id_token)"(\s*:\s*)"(?:[^"\\]|\\.)*"/g;

export function redactCredentials(text: string): string {
  return text.replace(CREDENTIAL_FIELD, '"$1"$2"<已隐去>"');
}

/** 落库前：响应体里的凭证原文 → 占位符。与请求侧同一套规则。 */
export function maskText(text: string, s: Secrets): string {
  return applyPairs(
    text,
    live(s).map(({ secret, placeholder }): Pair => [secret, placeholder]),
  );
}

/** 读取时：占位符 → 当前凭证。 */
export function fillText(text: string, s: Secrets): string {
  return applyPairs(
    text,
    live(s).map(({ secret, placeholder }): Pair => [placeholder, secret]),
  );
}

/* ── curl ──────────────────────────────────────────────────────────────── */

export function buildCurl(req: RequestRecord): string {
  const parts = [`curl -X ${req.method} ${sq(req.url)}`];
  for (const [k, v] of Object.entries(req.headers)) {
    parts.push(`  -H ${sq(`${k}: ${v}`)}`);
  }
  // --data-raw 而不是 -d：后者会把 @ 开头的内容当成文件名，也会吃掉换行
  if (req.body !== '') parts.push(`  --data-raw ${sq(req.body)}`);
  return parts.join(' \\\n');
}

/* ── 本机执行 ──────────────────────────────────────────────────────────── */

/**
 * 这条日志记的不是一次 HTTP 请求，而是本机跑了一次 CLI。
 *
 * Claude 侧的发送交给本机的官方 `claude`，那一发没有报文可记，但决定它去向的东西
 * 是齐的：环境变量对应请求头，完整命令行对应请求体。地址用 `cli://` 打头，
 * 界面和这里都据此分辨两种日志，不必再往库里加一列。
 */
export const CLI_SCHEME = 'cli://';

export function isCliRecord(req: Pick<RequestRecord, 'url'>): boolean {
  return req.url.startsWith(CLI_SCHEME);
}

/** 只在真的需要时才加引号，免得 `--print` 这种参数也被引号淹没。 */
export function shellArg(v: string): string {
  return v !== '' && /^[A-Za-z0-9._/:=@-]+$/.test(v) ? v : sq(v);
}

/** 命令行；出错时它就是贴给用户看的那一行，所以逐段按 shell 规则引起来。 */
export function commandLine(command: string, args: readonly string[]): string {
  return [command, ...args].map(shellArg).join(' ');
}

/**
 * 把一次本机执行还原成可直接粘进终端的命令。
 *
 * `env -i` 不是装饰：发送时子进程的环境是白名单重建的，多带一个 `ANTHROPIC_API_KEY`
 * 就会换掉认证目标，复现时照抄才问得出同一个结果。
 */
export function buildShell(req: RequestRecord): string {
  const parts = ['env -i'];
  for (const [k, v] of Object.entries(req.headers)) parts.push(`  ${k}=${sq(v)}`);
  parts.push(`  ${req.body}`);
  return parts.join(' \\\n');
}
