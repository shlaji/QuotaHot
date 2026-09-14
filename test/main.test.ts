import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/server/store.js';

const entry = new URL('../src/main.ts', import.meta.url).pathname;

type CliResult = { readonly code: number; readonly stdout: string; readonly stderr: string };

function cli(args: readonly string[]): Promise<CliResult> {
  return new Promise((resolveResult) => {
    execFile(process.execPath, ['--import', 'tsx', entry, ...args], { timeout: 5_000 }, (error, stdout, stderr) => {
      resolveResult({ code: error?.code === undefined ? 0 : Number(error.code), stdout, stderr });
    });
  });
}

async function startsServer(args: readonly string[], dataDir: string): Promise<string> {
  const child = spawn(process.execPath, ['--import', 'tsx', entry, ...args], {
    env: { ...process.env, PORT: '0', QUOTAHOT_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = await new Promise<string>((resolveOutput, reject) => {
    const timeout = setTimeout(() => reject(new Error('server did not start')), 10_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let text = '';
    const collect = (chunk: string): void => {
      text += chunk;
      if (!text.includes('QuotaHot 已启动:')) return;
      clearTimeout(timeout);
      resolveOutput(text);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', reject);
  });
  child.kill('SIGTERM');
  await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  return output;
}

test('help exits successfully without starting the server', async () => {
  // Given: the main distribution entrypoint.
  // When: a user requests help.
  const result = await cli(['--help']);
  // Then: usage is printed and the process exits instead of listening.
  assert.equal(result.code, 0);
  assert.match(result.stdout, /quotahot \[serve\]/);
  assert.doesNotMatch(result.stdout, /已启动/);
});

test('unknown command exits with usage error without starting the server', async () => {
  // Given: an argument that is not part of the main program's command surface.
  // When: command dispatch runs.
  const result = await cli(['hook']);
  // Then: it exits 2 and does not fall through to the service.
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown command: hook/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /已启动/);
});

test('no arguments starts the service', async (context) => {
  // Given: an isolated data directory and ephemeral port.
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-main-noargs-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  // When: the main program runs without arguments.
  const output = await startsServer([], dataDir);
  // Then: the HTTP service starts.
  assert.match(output, /QuotaHot 已启动:/);
});

test('serve explicitly starts the service', async (context) => {
  // Given: an isolated data directory and ephemeral port.
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-main-serve-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  // When: the serve command is explicit.
  const output = await startsServer(['serve'], dataDir);
  // Then: the HTTP service starts.
  assert.match(output, /QuotaHot 已启动:/);
});

/**
 * 同 startsServer，但一直读到 `marker` 出现为止。
 *
 * startsServer 见到「已启动」就收工，而自动启动那几行是在它之后才打出来的，
 * 拿它去断言只会读到半截输出。
 */
async function outputUntil(dataDir: string, marker: RegExp, graceMs = 0): Promise<string> {
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    env: { ...process.env, PORT: '0', QUOTAHOT_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    return await new Promise<string>((resolveOutput, reject) => {
      const timeout = setTimeout(() => reject(new Error(`未等到 ${marker}，已读到: ${text}`)), 10_000);
      let text = '';
      let done = false;
      const collect = (chunk: string): void => {
        text += chunk;
        if (done || !marker.test(text)) return;
        done = true;
        // 留一小段时间，好让「本该不出现」的那几行真有机会出现
        setTimeout(() => {
          clearTimeout(timeout);
          resolveOutput(text);
        }, graceMs).unref();
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.once('error', reject);
    });
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  }
}

/**
 * 进程起来之后按上次的意图把调度恢复起来。
 *
 * 少了这一步，`Restart=always` 只保证 Web 服务活着：崩溃或重启之后保活循环停在那儿，
 * 要等有人打开界面点一次启动，而界面上每个账户的「下次发送」倒计时照走不误，
 * 所以这件事没人看得出来。
 */
test('autoStart 为真时，进程起来就自动恢复调度', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-autostart-on-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(
    join(dataDir, 'config.json'),
    JSON.stringify({ autoStart: true, autoStartIds: [] }),
    'utf8',
  );

  const output = await outputUntil(dataDir, /自动启动调度:/);
  assert.match(output, /自动启动: 开/);
  assert.match(output, /自动启动调度: 全部可保活账户/);
});

test('只跑过选中账户的，重启之后也只恢复那几个', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-autostart-ids-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(
    join(dataDir, 'config.json'),
    JSON.stringify({ autoStart: true, autoStartIds: ['codex:a@x.com'] }),
    'utf8',
  );

  const output = await outputUntil(dataDir, /自动启动调度:/);
  // 悄悄扩成全部，等于替用户给他没打算保活的账户也发了
  assert.match(output, /自动启动调度: codex:a@x\.com/);
});

test('没点过启动的全新安装不自动跑', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-autostart-off-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));

  // 「自动启动: 关」是启动横幅的最后一行，等到它再多给一会儿，足以看出后面没有动作
  const output = await outputUntil(dataDir, /自动启动: 关/, 500);
  assert.doesNotMatch(output, /自动启动调度:/);
});

/** 起一个服务并让它一直跑着，返回它的地址；调用方负责在 context.after 里收掉。 */
async function serveOn(dataDir: string): Promise<{ base: string; kill: () => Promise<void> }> {
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    env: { ...process.env, PORT: '0', QUOTAHOT_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = await new Promise<string>((resolveBase, reject) => {
    const timeout = setTimeout(() => reject(new Error(`服务没起来，已读到: ${text}`)), 10_000);
    let text = '';
    const collect = (chunk: string): void => {
      text += chunk;
      const hit = /QuotaHot 已启动: (http:\/\/\S+)/.exec(text);
      if (!hit) return;
      clearTimeout(timeout);
      resolveBase(hit[1]);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', reject);
  });
  return {
    base,
    kill: async () => {
      child.kill('SIGTERM');
      await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
    },
  };
}

/**
 * 一个能被调度纳入、但这次用例里不会真去碰网络的账户目录。
 *
 * 下一拍预先排到明天：调度一起来就走「重启续跑」那条路直接进等待，
 * 不会去查额度也不会发送，用例因此不依赖任何外部服务。
 */
async function dataDirWithIdleAccount(dataDir: string): Promise<void> {
  await mkdir(join(dataDir, 'accounts'), { recursive: true });
  await writeFile(
    join(dataDir, 'accounts', 'codex-a.json'),
    JSON.stringify({
      type: 'codex',
      email: 'a@example.com',
      account_id: 'acct-1',
      access_token: 'not-a-real-token',
      refresh_token: 'not-a-real-token',
      expired: new Date(Date.now() + 86_400_000).toISOString(),
    }),
    'utf8',
  );
  const store = new Store(join(dataDir, 'state.db'));
  const tomorrow = Date.now() + 86_400_000;
  store.setNextDue('codex:a@example.com', tomorrow, tomorrow);
  store.close();
}

const readConfig = async (dataDir: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;

/**
 * 走一遍用户真正会做的那串操作：点启动 -> 存一次设置 -> 进程重启。
 *
 * 三处各自都可能把 autoStart 弄丢，而弄丢之后界面上什么都看不出来——倒计时照走，
 * 只是没有任何一条真的会发出去。
 */
test('点过启动之后，存设置不会弄丢它，重启进程调度自己回来', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-autostart-trip-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  await dataDirWithIdleAccount(dataDir);

  const first = await serveOn(dataDir);
  try {
    const started = await fetch(`${first.base}/api/scheduler/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [] }),
    });
    assert.equal((await started.json()).running, true, '前提：这个账户确实被纳入了调度');
    assert.equal((await readConfig(dataDir)).autoStart, true, '点过启动就该记下来');

    // 界面上存一次设置。请求体里压根没有 autoStart，服务端不该因此把它清掉
    const saved = await fetch(`${first.base}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello', dailyStart: '06:00', dailyEnd: '23:00' }),
    });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).text, 'hello', '前提：这次保存确实生效了');
    assert.equal((await readConfig(dataDir)).autoStart, true, '存设置不该把自动启动一起关掉');
  } finally {
    // SIGTERM 里那次 stop() 是进程在收尾，不是用户按的停止，不该改 autoStart
    await first.kill();
  }
  assert.equal((await readConfig(dataDir)).autoStart, true, 'SIGTERM 不该关掉自动启动');

  // 换个进程再来一遍，就是 systemd 把它拉起来时的样子
  const output = await outputUntil(dataDir, /自动启动调度:/);
  assert.match(output, /自动启动调度: 全部可保活账户/);
});

test('用户自己按的停止会记下来，重启之后不再自动跑', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-autostart-stop-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  await dataDirWithIdleAccount(dataDir);

  const server = await serveOn(dataDir);
  try {
    await fetch(`${server.base}/api/scheduler/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [] }),
    });
    assert.equal((await readConfig(dataDir)).autoStart, true, '前提：先得是跑着的');

    await fetch(`${server.base}/api/scheduler/stop`, { method: 'POST' });
    assert.equal((await readConfig(dataDir)).autoStart, false, '按了停止就不该再自己跑起来');
  } finally {
    await server.kill();
  }

  const output = await outputUntil(dataDir, /自动启动: 关/, 500);
  assert.doesNotMatch(output, /自动启动调度:/);
});
