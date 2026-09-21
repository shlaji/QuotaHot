import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/server/store.js';
import { buildCurl, fillSecrets, maskSecrets } from '../src/shared/curl.js';
import type { RequestLogPage } from '../src/shared/types.js';

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
async function serveOn(
  dataDir: string,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<{ base: string; kill: () => Promise<void> }> {
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    env: { ...process.env, PORT: '0', QUOTAHOT_DATA_DIR: dataDir, ...extraEnv },
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

test('账户排序更新会持久化并保留其他配置字段', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-account-order-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const server = await serveOn(dataDir);

  try {
    const response = await fetch(`${server.base}/api/account-order`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'claude', ids: ['account-c', 'account-a', 'account-c'] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).accountOrder, {
      claude: ['account-c', 'account-a'],
    });

    const saved = await readConfig(dataDir);
    assert.deepEqual(saved.accountOrder, { claude: ['account-c', 'account-a'] });
    assert.equal(saved.text, 'hi');
    assert.equal(saved.dailyStart, '06:00');
    assert.equal(saved.gateway !== undefined, true);

    const malformed = await fetch(`${server.base}/api/account-order`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'claude', ids: 'account-a' }),
    });
    assert.equal(malformed.status, 400);
  } finally {
    await server.kill();
  }
});

test('Qoder 混合请求日志分别用 PAT 和 OAuth 回放', async (context) => {
  // Given: a Qoder catalog request masked with its gateway PAT and an account OAuth token.
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-qoder-request-log-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const accountId = 'qoder:catalog@example.test';
  const gatewayPat = 'synthetic-current-qoder-gateway-pat';
  const oauthToken = 'synthetic-qoder-account-oauth-token';
  await mkdir(join(dataDir, 'accounts'), { recursive: true });
  await writeFile(
    join(dataDir, 'accounts', 'qoder-catalog.json'),
    JSON.stringify({
      type: 'qoder',
      email: 'catalog@example.test',
      account_id: 'qoder-user',
      user_id: 'qoder-user',
      access_token: oauthToken,
      refresh_token: '',
      expired: new Date(Date.now() + 86_400_000).toISOString(),
    }),
    'utf8',
  );
  const store = new Store(join(dataDir, 'state.db'));
  store.setGatewayAccount(accountId, { pat: gatewayPat });
  store.recordRequest(
    accountId,
    Date.now(),
    maskSecrets(
      {
        method: 'GET',
        url: 'https://api.qoder.com/api/v1/cloud/models',
        headers: { authorization: `Bearer ${gatewayPat}` },
        body: '',
      },
      { accessToken: gatewayPat, accessTokenPlaceholder: '$QUOTAHOT_GATEWAY_TOKEN' },
    ),
    200,
    1,
    '',
  );
  for (const path of ['/api/v2/quota/usage', '/api/v2/user/plan']) {
    store.recordRequest(accountId, Date.now(), maskSecrets({
      method: 'GET', url: `https://openapi.qoder.sh${path}`,
      headers: { authorization: `Bearer ${oauthToken}` }, body: '',
    }, { accessToken: oauthToken }), 200, 1, '');
  }
  store.close();
  const server = await serveOn(dataDir);
  context.after(server.kill);

  // When: the user requests the log page and copies its first curl.
  const response = await fetch(`${server.base}/api/accounts/${encodeURIComponent(accountId)}/requests`);
  const page = (await response.json()) as RequestLogPage;
  const row = page.rows.find((entry) => entry.url.includes('/cloud/models'));
  assert.ok(row, '前提：目录请求应留在请求日志中');
  const copiedCurl = buildCurl(fillSecrets(row, page.secrets));

  // Then: the copied request restores the gateway PAT, never the account OAuth token.
  assert.equal(response.status, 200);
  assert.ok(copiedCurl.includes(gatewayPat));
  assert.ok(!copiedCurl.includes(oauthToken));
  const oauthRows = page.rows.filter((entry) => entry.url.startsWith('https://openapi.qoder.sh/'));
  assert.equal(oauthRows.length, 2);
  for (const oauthRow of oauthRows) {
    const oauthCurl = buildCurl(fillSecrets(oauthRow, page.secrets));
    assert.ok(oauthCurl.includes(oauthToken));
    assert.ok(!oauthCurl.includes(gatewayPat));
  }
});

/**
 * 导入弹窗里那一行路径是可以改的：装在非默认位置的人，在看见「本机没有这个路径」的地方
 * 就能把位置填对。这条用例盯的是三件事——填错当场退回、填对立刻按新位置扫、留空回到默认，
 * 并且每一次都得落到 config.json 里：只在内存里生效的话，重启之后又要再填一遍。
 *
 * HOME 指到临时目录，默认位置因此也在临时目录下，跑测试不会碰到真实的登录状态。
 */
test('导入来源的位置可以当场改，留空回到默认', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-srcpath-'));
  const home = await mkdtemp(join(tmpdir(), 'quotahot-srcpath-home-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  context.after(() => rm(home, { recursive: true, force: true }));

  // 一份放在别处的 cli-proxy-api 账户目录：默认位置上什么都没有
  const alt = join(home, 'elsewhere');
  await mkdir(alt, { recursive: true });
  await writeFile(
    join(alt, 'one.json'),
    JSON.stringify({
      type: 'claude',
      email: 'a@example.com',
      access_token: 'not-a-real-token',
      refresh_token: 'not-a-real-token',
      expired: new Date(Date.now() + 86_400_000).toISOString(),
    }),
    'utf8',
  );

  type Source = { source: string; path: string; defaultPath: string; available: boolean; accounts: { email: string }[] };
  type PathResult = { sources: Source[]; config: { clientPaths: Record<string, string> } };
  const server = await serveOn(dataDir, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
  });
  const put = (id: string, path: string): Promise<Response> =>
    fetch(`${server.base}/api/accounts/sources/${id}/path`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    });
  const proxySource = async (): Promise<Source> => {
    const listed = (await (await fetch(`${server.base}/api/accounts/sources`)).json()) as Source[];
    const found = listed.find((s) => s.source === 'cli-proxy-api');
    assert.ok(found, '来源列表里应当有 cli-proxy-api');
    return found;
  };

  try {
    // 填错：相对路径在终端和 systemd 下指向两个地方，不能收下
    const bad = await put('cli-proxy-api', 'elsewhere');
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /绝对路径/);
    const unknown = await put('not-a-client', '/tmp/x');
    assert.equal(unknown.status, 400);
    assert.equal((await proxySource()).path, join(home, '.cli-proxy-api'), '退回之后位置不该变');

    // 填对：`~` 展开成主目录，不用逼着人手敲一遍
    const ok = await put('cli-proxy-api', '~/elsewhere');
    assert.equal(ok.status, 200);
    const saved = (await ok.json()) as PathResult;
    const found = saved.sources.find((s) => s.source === 'cli-proxy-api');
    assert.equal(found?.path, alt);
    assert.equal(found?.available, true);
    assert.deepEqual(found?.accounts.map((a) => a.email), ['a@example.com'], '改完就该看见那边的账户');
    assert.equal(saved.config.clientPaths['cli-proxy-api'], alt, '配置要一起回给前端，否则下次保存会顶掉');
    assert.equal(
      ((await readConfig(dataDir)).clientPaths as Record<string, string>)['cli-proxy-api'],
      alt,
      '得落盘，重启之后不该要求再填一遍',
    );
    // 对整个进程生效，不只是这一次响应
    assert.equal((await proxySource()).path, alt);

    // 留空：回到默认位置，配置里那一项整个删掉
    const back = await put('cli-proxy-api', '   ');
    assert.equal(back.status, 200);
    const restored = (await back.json()) as PathResult;
    const atDefault = restored.sources.find((s) => s.source === 'cli-proxy-api');
    assert.equal(atDefault?.path, join(home, '.cli-proxy-api'));
    assert.equal(atDefault?.path, atDefault?.defaultPath, 'placeholder 上写的就是这个位置');
    assert.deepEqual(restored.config.clientPaths, {});
    assert.deepEqual((await readConfig(dataDir)).clientPaths, {});
  } finally {
    await server.kill();
  }
});
