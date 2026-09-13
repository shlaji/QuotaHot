import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildArgs,
  buildEnv,
  classify,
  configDirFor,
  parseLimitHint,
  parseResult,
  sendViaCli,
  spawnOnce,
  type CliRun,
} from '../src/server/claudecli.js';

/**
 * 这里不碰真正的 claude，改用一段可控的假命令：
 * 要验的是「进程怎么起、环境怎么传、输出怎么判」，不是模型答了什么。
 */
function fakeCli(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'quotahot-cli-'));
  const path = join(dir, 'fake-claude');
  writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

function run(over: Partial<CliRun> = {}): CliRun {
  return {
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    spawnError: '',
    durationMs: 10,
    ...over,
  };
}

const SUCCESS = '{"type":"result","subtype":"success","is_error":false,"result":"ok"}';

test('环境变量是白名单重建的，父进程的 ANTHROPIC_* 不会漏进去', () => {
  const env = buildEnv(
    { accessToken: 'sk-ant-oat01-TOKEN', configDir: '/tmp/cfg' },
    {
      PATH: '/usr/bin',
      HOME: '/home/u',
      ANTHROPIC_API_KEY: 'leaked',
      ANTHROPIC_BASE_URL: 'https://elsewhere.example',
      CLAUDE_CODE_USE_BEDROCK: '1',
    },
  );
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-TOKEN');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/tmp/cfg');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/u');
  // 这三个只要漏一个，这一发就不属于这个账户了
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
});

test('配置了代理才写代理变量，且大小写两份都给', () => {
  const withProxy = buildEnv(
    { accessToken: 't', configDir: '/c', proxy: 'http://127.0.0.1:7897', noProxy: ['localhost', ''] },
    {},
  );
  assert.equal(withProxy.HTTPS_PROXY, 'http://127.0.0.1:7897');
  assert.equal(withProxy.https_proxy, 'http://127.0.0.1:7897');
  assert.equal(withProxy.NO_PROXY, 'localhost');

  const direct = buildEnv({ accessToken: 't', configDir: '/c', proxy: '  ' }, {});
  assert.equal(direct.HTTPS_PROXY, undefined);
  assert.equal(direct.NO_PROXY, undefined);
});

test('文本用 -- 隔开，以 - 开头的自定义文本不会被当成参数', () => {
  const args = buildArgs('claude-sonnet-5', '--help', ['--safe-mode']);
  assert.deepEqual(args, [
    '--print',
    '--output-format',
    'json',
    '--model',
    'claude-sonnet-5',
    '--safe-mode',
    '--',
    '--help',
  ]);
  // 模型为空时不发一个空的 --model
  assert.ok(!buildArgs('  ', 'hi').includes('--model'));
});

test('每个账户一个隔离目录，ID 里的 : 和 @ 都不进路径', () => {
  const dir = configDirFor('claude:a@x.com');
  assert.ok(dir.endsWith('claude_a_x.com'));
  assert.notEqual(configDirFor('claude:a@x.com'), configDirFor('claude:b@x.com'));
});

test('结果对象在多行输出里也能找到', () => {
  assert.equal(parseResult(`启动提示\n${SUCCESS}`)?.subtype, 'success');
  assert.equal(parseResult('  \n'), null);
  assert.equal(parseResult('not json at all'), null);
});

test('退出码为 0 且 is_error 为 false 才算发出去了', () => {
  assert.deepEqual(classify(run({ stdout: SUCCESS })), {
    ok: true,
    status: 200,
    error: '',
    limit: null,
  });
  // 退出码是 0，但 CLI 自己说这轮出错了
  const failed = classify(
    run({ stdout: '{"type":"result","is_error":true,"result":"boom"}' }),
  );
  assert.equal(failed.ok, false);
  assert.match(failed.error, /boom/);
  // 输出里没有结果对象，等于没有任何成功证据
  assert.equal(classify(run({ stdout: '' })).ok, false);
});

test('触限归 429、认证失败归 401，其余按可重试处理', () => {
  assert.equal(classify(run({ code: 1, stderr: 'Claude usage limit reached' })).status, 429);
  assert.equal(
    classify(run({ code: 1, stderr: 'Failed to authenticate. API Error: 403 Request not allowed' }))
      .status,
    401,
  );
  assert.equal(classify(run({ code: 1, stderr: 'fetch failed: ECONNRESET' })).status, 0);
});

/**
 * 真实日志里出现过的那句话。认不出来的代价不是少一条日志：这一发会被当成接口故障，
 * 重试几轮之后账户被判「连续失败过多」直接停掉，保活断在这里。
 */
test('“You’ve hit your weekly limit” 也算触限，不是接口故障', () => {
  const detail = "You've hit your weekly limit · resets 10pm (Asia/Singapore)";
  const outcome = classify(run({ code: 1, stdout: `{"is_error":true,"result":${JSON.stringify(detail)}}` }));

  assert.equal(outcome.status, 429, '必须归成触限');
  assert.equal(outcome.limit?.name, '7d', '说的是周额度');

  // 那个时刻要落在新加坡时间的 22:00
  const hhmm = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Singapore',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(outcome.limit!.resetAt));
  assert.equal(hhmm, '22:00');
  assert.ok(outcome.limit!.resetAt > Date.now(), '重置时刻必须在将来');
});

test('触限文案里的重置时刻：钟点、相对时间、以及认不出来时的留白', () => {
  const now = Date.parse('2026-09-06T09:00:00+08:00');
  const tz = { timeZone: 'Asia/Shanghai' };

  // 没带时区就按本机时区解释，因此这里用固定时区的相对写法来断言
  const rel = parseLimitHint('5-hour limit reached · resets in 42 minutes', now);
  assert.equal(rel?.name, '5h');
  assert.equal(rel?.resetAt, now + 42 * 60_000);

  // 钟点已经走过，就是明天的同一时刻
  const tomorrow = parseLimitHint('weekly limit · resets 8am (Asia/Shanghai)', now);
  assert.equal(tomorrow?.name, '7d');
  assert.equal(new Date(tomorrow!.resetAt).toLocaleDateString('en-CA', tz), '2026-09-07');
  assert.equal(new Date(tomorrow!.resetAt).toLocaleTimeString('en-GB', { ...tz, hour12: false }), '08:00:00');

  // 半点、以及说不出重置时刻的那一句
  const half = parseLimitHint('usage limit reached · resets at 11:30pm (Asia/Shanghai)', now);
  assert.equal(new Date(half!.resetAt).toLocaleTimeString('en-GB', { ...tz, hour12: false }), '23:30:00');
  assert.equal(parseLimitHint('Claude usage limit reached', now), null);
  // 认不出来的时区名不能凭本机时区硬猜，宁可交白卷让上层退回估算窗口
  assert.equal(parseLimitHint('weekly limit · resets 10pm (Middle/Earth)', now), null);
});

test('命令不存在、超时都不抛异常，而是给出能看懂的原因', async () => {
  const missing = await spawnOnce('/nonexistent/claude', [], {}, undefined, 5_000);
  assert.match(classify(missing).error, /无法执行 claude 命令/);

  const slow = await spawnOnce(fakeCli('sleep 30'), [], {}, undefined, 300);
  assert.equal(slow.timedOut, true);
  assert.match(classify(slow).error, /超时/);
});

test('走完整条路：假 CLI 收到令牌与文本，成功输出被判为成功', async () => {
  // 把拿到的东西原样吐回来，就能验证令牌和文本确实传到了子进程
  const command = fakeCli(
    `echo "token=$CLAUDE_CODE_OAUTH_TOKEN cfg=$CLAUDE_CONFIG_DIR text=$*" >&2\n` +
      `echo '${SUCCESS}'`,
  );
  const r = await sendViaCli({
    accountId: 'claude:a@x.com',
    accessToken: 'sk-ant-oat01-TOKEN',
    text: 'hi',
    model: 'claude-sonnet-5',
    command,
    timeoutMs: 10_000,
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.error, '');
  assert.ok(r.commandLine.includes('--print'));
  assert.ok(r.sentAt > 0);
});

test('每一发都整理成一条可入库的日志：环境当请求头，命令行当请求体', async () => {
  const command = fakeCli(`echo '${SUCCESS}'\necho '起不来了' >&2`);
  const r = await sendViaCli({
    accountId: 'claude:a@x.com',
    accessToken: 'sk-ant-oat01-TOKEN',
    text: 'hi',
    model: 'claude-sonnet-5',
    command,
    proxy: 'http://127.0.0.1:7890',
    timeoutMs: 10_000,
  });

  assert.equal(r.record.method, 'EXEC');
  assert.equal(r.record.url, `cli://${command}`);
  assert.equal(r.record.body, r.commandLine);
  // 决定这一发去向的三样：令牌、身份目录、代理，缺一样都查不出问题出在哪
  assert.equal(r.record.headers.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-TOKEN');
  assert.match(r.record.headers.CLAUDE_CONFIG_DIR ?? '', /claude_a_x\.com$/);
  assert.equal(r.record.headers.HTTPS_PROXY, 'http://127.0.0.1:7890');
  // 两条流都要留：成功证据在 stdout，失败原因常常只在 stderr
  assert.ok(r.output.includes('"subtype":"success"'));
  assert.match(r.output, /stderr[\s\S]*起不来了/);
});

test('目录都建不起来时也留得下一条日志', async () => {
  const r = await sendViaCli({
    accountId: 'claude:a@x.com',
    accessToken: 'sk-ant-oat01-TOKEN',
    text: 'hi',
    model: 'claude-sonnet-5',
    command: '/nonexistent/claude',
    timeoutMs: 5_000,
  });
  // 目录能建起来时这条会照常执行并失败；无论走哪一支，日志里都得有东西
  assert.equal(r.ok, false);
  assert.equal(r.record.url, 'cli:///nonexistent/claude');
  assert.ok(r.record.body.startsWith('/nonexistent/claude'));
});
