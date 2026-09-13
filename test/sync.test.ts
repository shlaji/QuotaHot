import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * “跟随客户端”的账户：令牌只从原客户端的凭证文件同步，绝不走 OAuth 刷新。
 * 出站层被整个替换掉，因此“有没有发请求”是可以直接断言的，而不是靠约定。
 */

const calls: string[] = [];

mock.module('../src/server/http.js', {
  exports: {
    request: async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        headers: {},
        text: async () => JSON.stringify({ access_token: 'refreshed', expires_in: 3600 }),
      };
    },
    // 出站层整个被替换掉，记账那几个入口也得给：模块里少一个导出，import 它的那条路就起不来
    noteError: () => {},
    recordOutbound: () => {},
  },
});

const { checkFollowClient, ensureFresh, loadAccounts, refreshViaOAuth, setAutoRefresh } =
  await import('../src/server/creds.js');

/** 一个已经过期的账户文件，外加一份 Claude Code 的凭证文件。 */
async function fixture(opts: {
  autoRefresh: boolean;
  clientToken: string;
  clientExpiresAt: number;
}): Promise<{ dir: string; accountPath: string; clientPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'quotahot-sync-'));
  const accountPath = join(dir, 'claude-a@example.com.json');
  const clientPath = join(dir, '.credentials.json');
  await writeFile(
    accountPath,
    JSON.stringify({
      type: 'claude',
      email: 'a@example.com',
      access_token: 'stale',
      refresh_token: 'r-stale',
      expired: new Date(Date.now() - 60_000).toISOString(),
      source: 'claude-cli',
      auto_refresh: opts.autoRefresh,
      sync_path: clientPath,
      sync_source: 'claude-cli',
    }),
    'utf8',
  );
  await writeFile(
    clientPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: opts.clientToken,
        refreshToken: 'r-fresh',
        expiresAt: opts.clientExpiresAt,
      },
    }),
    'utf8',
  );
  return { dir, accountPath, clientPath };
}

test('跟随客户端的账户从客户端凭证文件同步新 token，全程不发请求', async () => {
  calls.length = 0;
  const expiresAt = Date.now() + 3_600_000;
  const { dir, accountPath } = await fixture({
    autoRefresh: false,
    clientToken: 'fresh-from-cli',
    clientExpiresAt: expiresAt,
  });

  const [acct] = await loadAccounts(dir);
  assert.equal(acct.autoRefresh, false);
  await writeClaudeProfile(dir, 'a@example.com');
  assert.equal(await withHome(dir, () => ensureFresh(acct, () => {})), true);
  assert.equal(acct.accessToken, 'fresh-from-cli');
  assert.deepEqual(calls, [], 'token 刷新必须由客户端自己做，这里一个请求都不该发出');

  // 新令牌要落盘，否则下一轮又得重新读一次客户端文件
  const saved = JSON.parse(await readFile(accountPath, 'utf8'));
  assert.equal(saved.access_token, 'fresh-from-cli');
  assert.equal(saved.refresh_token, 'r-fresh');
  assert.equal(Date.parse(saved.expired), expiresAt);
});

test('客户端那边还没续期时如实报错，而不是替它刷新', async () => {
  calls.length = 0;
  const { dir, accountPath } = await fixture({
    autoRefresh: false,
    clientToken: 'stale',
    clientExpiresAt: Date.now() - 60_000,
  });

  const [acct] = await loadAccounts(dir);
  const logs: string[] = [];
  assert.equal(await ensureFresh(acct, (_lvl, msg) => logs.push(msg)), false);
  assert.deepEqual(calls, []);
  assert.match(logs.join('\n'), /客户端/);
  // 账户文件不能被这次失败改写
  assert.equal(JSON.parse(await readFile(accountPath, 'utf8')).access_token, 'stale');
});

test('客户端文件读不出令牌时不回退到 OAuth 刷新', async () => {
  calls.length = 0;
  const { dir, clientPath } = await fixture({
    autoRefresh: false,
    clientToken: 'x',
    clientExpiresAt: Date.now() + 3_600_000,
  });
  await writeFile(clientPath, '{"claudeAiOauth":{}}', 'utf8');

  const [acct] = await loadAccounts(dir);
  assert.equal(await ensureFresh(acct, () => {}), false);
  assert.deepEqual(calls, [], '读不到就等下一轮，绝不能拿 refresh_token 去换');
});

test('没关自动刷新的账户照旧走 OAuth 刷新', async () => {
  calls.length = 0;
  const { dir } = await fixture({
    autoRefresh: true,
    clientToken: 'fresh-from-cli',
    clientExpiresAt: Date.now() + 3_600_000,
  });

  const [acct] = await loadAccounts(dir);
  assert.equal(await ensureFresh(acct, () => {}), true);
  assert.equal(acct.accessToken, 'refreshed');
  assert.equal(calls.length, 1, '这类账户的续期仍然由本程序负责');
});

test('切换续期方式会落盘，重新加载后仍然生效', async () => {
  const { dir, accountPath } = await fixture({
    autoRefresh: true,
    clientToken: 'fresh-from-cli',
    clientExpiresAt: Date.now() + 3_600_000,
  });

  const [acct] = await loadAccounts(dir);
  await setAutoRefresh(acct, false);
  assert.equal(JSON.parse(await readFile(accountPath, 'utf8')).auto_refresh, false);

  const [reloaded] = await loadAccounts(dir);
  assert.equal(reloaded.autoRefresh, false);
  assert.equal(reloaded.syncSource, 'claude-cli');
});

test('缺省字段的老账户文件仍按自动刷新处理', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quotahot-sync-'));
  await writeFile(
    join(dir, 'claude-old.json'),
    JSON.stringify({ type: 'claude', email: 'old@example.com', access_token: 't' }),
    'utf8',
  );
  const [acct] = await loadAccounts(dir);
  assert.equal(acct.autoRefresh, true, '升级上来的账户行为不能变');
  assert.equal(acct.syncPath, '');
});

test('强制刷新绕开“还没到期”，无条件换一份新 token', async () => {
  calls.length = 0;
  const { dir, accountPath } = await fixture({
    autoRefresh: true,
    clientToken: 'x',
    clientExpiresAt: Date.now() + 3_600_000,
  });
  // 令牌离过期还远：ensureFresh 到这儿就该直接返回，强制刷新则不该被它拦住
  await writeFile(
    accountPath,
    JSON.stringify({
      type: 'claude',
      email: 'a@example.com',
      access_token: 'still-good',
      refresh_token: 'r-good',
      expired: new Date(Date.now() + 86_400_000).toISOString(),
      auto_refresh: true,
    }),
    'utf8',
  );

  const [fresh] = await loadAccounts(dir);
  assert.equal(await ensureFresh(fresh, () => {}), true);
  assert.deepEqual(calls, [], '没到期时自动续期本来就什么都不该做');

  const [same] = await loadAccounts(dir);
  const logs: string[] = [];
  assert.equal(await refreshViaOAuth(same, (_lvl, msg) => logs.push(msg)), true);
  assert.equal(calls.length, 1, '手动点了就得真发一次刷新请求');
  assert.equal(same.accessToken, 'refreshed');
  assert.match(logs.join('\n'), /已刷新/);
  // 新令牌要落盘，否则下次加载又退回旧的那份
  assert.equal(JSON.parse(await readFile(accountPath, 'utf8')).access_token, 'refreshed');
});

test('没有 refresh_token 的账户强制刷新时如实报错，不发请求', async () => {
  calls.length = 0;
  const dir = await mkdtemp(join(tmpdir(), 'quotahot-sync-'));
  await writeFile(
    join(dir, 'claude-n.json'),
    JSON.stringify({ type: 'claude', email: 'n@example.com', access_token: 't' }),
    'utf8',
  );

  const [acct] = await loadAccounts(dir);
  const logs: string[] = [];
  assert.equal(await refreshViaOAuth(acct, (_lvl, msg) => logs.push(msg)), false);
  assert.deepEqual(calls, []);
  assert.match(logs.join('\n'), /refresh_token/);
});

/**
 * 「改为跟随客户端」之前的身份核对。
 *
 * 核对的是本机客户端此刻登录的账户，位置按 provider 定（~/.claude、~/.codex），
 * 因此这几个用例都临时改掉 HOME——真去读用户自己那份，结果会跟着谁登录着变。
 */
async function withHome<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const before = process.env.HOME;
  process.env.HOME = dir;
  try {
    return await fn();
  } finally {
    process.env.HOME = before;
  }
}

/** Claude Code 的登录身份不在凭证文件里，而在 ~/.claude.json 的 oauthAccount 下。 */
async function writeClaudeProfile(dir: string, email: unknown): Promise<void> {
  await writeFile(
    join(dir, '.claude.json'),
    JSON.stringify(email === undefined ? {} : { oauthAccount: { emailAddress: email } }),
    'utf8',
  );
}

test('Claude Code 换了账号时不给跟随', async () => {
  const { dir } = await fixture({
    autoRefresh: true,
    clientToken: 'token-of-b',
    clientExpiresAt: Date.now() + 3_600_000,
  });
  await writeClaudeProfile(dir, 'b@example.com');

  const [acct] = await loadAccounts(dir);
  const check = await withHome(dir, () => checkFollowClient(acct));
  assert.equal(check.ok, false);
  assert.match(check.reason, /b@example\.com/);
  assert.match(check.reason, /a@example\.com/);
  // 核对不通过时也要说清核对的是谁：改为自动刷新那个方向拿这个名字组织提醒语
  assert.equal(check.label, 'Claude Code');
});

test('已经在跟随时 Claude Code 换号也拒绝同步', async () => {
  const { dir, accountPath } = await fixture({
    autoRefresh: false,
    clientToken: 'token-of-b',
    clientExpiresAt: Date.now() + 3_600_000,
  });
  await writeClaudeProfile(dir, 'b@example.com');
  const before = await readFile(accountPath, 'utf8');
  const [acct] = await loadAccounts(dir);
  assert.ok(acct);
  assert.equal(await withHome(dir, () => ensureFresh(acct, () => {})), false);
  assert.equal(await readFile(accountPath, 'utf8'), before);
});

test('Claude Code 登录的还是同一个账户时可以跟随', async () => {
  const { dir } = await fixture({
    autoRefresh: true,
    clientToken: 'token-of-a',
    clientExpiresAt: Date.now() + 3_600_000,
  });
  // 邮箱大小写不同不算换了账号
  await writeClaudeProfile(dir, 'A@Example.com');

  const [acct] = await loadAccounts(dir);
  const check = await withHome(dir, () => checkFollowClient(acct));
  assert.equal(check.ok, true, check.reason);
  assert.equal(check.source, 'claude-cli');
  assert.equal(check.label, 'Claude Code');
});

test('认不出客户端登录的是谁时同样不给跟随', async () => {
  const { dir } = await fixture({
    autoRefresh: true,
    clientToken: 'token-of-a',
    clientExpiresAt: Date.now() + 3_600_000,
  });
  // ~/.claude.json 里没有 oauthAccount：Claude 的令牌不是 JWT，就再没有别的身份依据了
  await writeClaudeProfile(dir, undefined);

  const [acct] = await loadAccounts(dir);
  const check = await withHome(dir, () => checkFollowClient(acct));
  assert.equal(check.ok, false, '确认不了是不是同一个账户，跟随的就可能是别人');
  assert.match(check.reason, /认不出/);
});

test('客户端凭证文件读不出令牌时不给跟随', async () => {
  const { dir, clientPath } = await fixture({
    autoRefresh: true,
    clientToken: 'x',
    clientExpiresAt: Date.now() + 3_600_000,
  });
  await writeFile(clientPath, '{"claudeAiOauth":{}}', 'utf8');
  await writeClaudeProfile(dir, 'a@example.com');

  const [acct] = await loadAccounts(dir);
  const check = await withHome(dir, () => checkFollowClient(acct));
  assert.equal(check.ok, false);
  assert.match(check.reason, /读出令牌/);
});

/** Codex 账户跟随的是本机 ~/.codex/auth.json 里当前那个登录。 */
async function codexFixture(
  accountId: string,
  clientAccountId: string,
  syncPath = '',
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'quotahot-follow-'));
  await mkdir(join(dir, '.codex'), { recursive: true });
  await writeFile(
    join(dir, 'codex-c@example.com.json'),
    JSON.stringify({
      type: 'codex',
      email: 'c@example.com',
      account_id: accountId,
      access_token: 'mine',
      refresh_token: 'r',
      source: 'cli-proxy-api',
      sync_source: syncPath ? 'cli-proxy-api' : '',
      sync_path: syncPath,
      auto_refresh: true,
    }),
    'utf8',
  );
  await writeFile(
    join(dir, '.codex', 'auth.json'),
    JSON.stringify({ tokens: { access_token: 'theirs', account_id: clientAccountId } }),
    'utf8',
  );
  return dir;
}

test('没记来源的 Codex 账户按 ~/.codex/auth.json 核对，账户 ID 对不上就不给跟随', async () => {
  const dir = await codexFixture('acct-1', 'acct-2');
  const [acct] = await loadAccounts(dir);
  const check = await withHome(dir, () => checkFollowClient(acct));
  assert.equal(check.ok, false);
  assert.match(check.reason, /acct-2/);
});

test('Codex CLI 登录的就是这个账户时可以跟随，并把来源文件记进账户文件', async () => {
  const dir = await codexFixture('acct-1', 'acct-1');
  const [acct] = await loadAccounts(dir);
  const check = await withHome(dir, () => checkFollowClient(acct));
  assert.equal(check.ok, true, check.reason);

  await setAutoRefresh(acct, false, { source: check.source, path: check.path });
  // 不把定位到的文件记下来，跟随就无处可取——这正是老账户开跟随失败的原因
  const [reloaded] = await loadAccounts(dir);
  assert.equal(reloaded.autoRefresh, false);
  assert.equal(reloaded.syncSource, 'codex-cli');
  assert.equal(reloaded.syncPath, join(dir, '.codex', 'auth.json'));
});

test('cli-proxy-api 的来源文件不算客户端：仍按 ~/.codex/auth.json 核对', async () => {
  const dir = await codexFixture('acct-1', 'acct-2', '');
  // 导入来源是 cli-proxy-api 的账户目录，一个账户一个文件：拿它核对等于自己跟自己比，
  // 永远一致，校验就成了摆设
  const mirror = join(dir, 'cli-proxy-api-codex-c@example.com.json');
  await writeFile(
    mirror,
    JSON.stringify({ type: 'codex', email: 'c@example.com', account_id: 'acct-1', access_token: 'mine' }),
    'utf8',
  );
  const acctPath = join(dir, 'codex-c@example.com.json');
  const data = JSON.parse(await readFile(acctPath, 'utf8'));
  data.sync_source = 'cli-proxy-api';
  data.sync_path = mirror;
  await writeFile(acctPath, JSON.stringify(data), 'utf8');

  const [acct] = (await loadAccounts(dir)).filter((a) => a.id === 'codex:c@example.com');
  const check = await withHome(dir, () => checkFollowClient(acct));
  assert.equal(check.ok, false, 'Codex CLI 上登录的是 acct-2，跟随它就会同步到别人的令牌');
  assert.equal(check.path, '');
});
