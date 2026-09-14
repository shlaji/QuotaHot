import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadAccounts } from '../src/server/creds.js';
import { refreshClientsInUse, resetClientsInUse, scanClientsInUse } from '../src/server/inuse.js';

/**
 * 「这台电脑正在用哪个账户」的核对。
 *
 * 读的是本机客户端的凭证文件，所以先把 HOME / XDG_DATA_HOME 指到临时目录——跑测试不该
 * 看见、更不该动任何人真实的登录状态。Qoder 那一路不在这里：它的凭证在加密的 state.vscdb
 * 里，临时目录下根本没有这个文件，正好走「客户端没装就跳过」那条分支。
 *
 * 断言的重点是三件事：标到的是不是同一个账户、客户端换人之后标记跟不跟得上、以及认不出
 * 来的时候会不会硬往某个账户身上安——最后这条错了，用户就会照着一个假标记去切账户。
 */
const home = await mkdtemp(join(tmpdir(), 'quotahot-inuse-home-'));
process.env.HOME = home;
process.env.XDG_DATA_HOME = join(home, '.local', 'share');

const claudeCredsPath = join(home, '.claude', '.credentials.json');
const claudeProfilePath = join(home, '.claude.json');
const codexCliPath = join(home, '.codex', 'auth.json');
const opencodePath = join(home, '.local', 'share', 'opencode', 'auth.json');

async function writeJson(path: string, content: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(content, null, 2));
}

/** Claude Code：令牌在凭证文件里，登录的是谁记在 ~/.claude.json。 */
async function setClaudeCode(accessToken: string, email: string): Promise<void> {
  await writeJson(claudeCredsPath, { claudeAiOauth: { accessToken, expiresAt: 0 } });
  await writeJson(claudeProfilePath, { oauthAccount: { emailAddress: email } });
}

/** 摆一个账户目录：字段名与程序自己的存储一致。 */
async function accountsDir(
  accounts: { provider: string; email: string; accessToken?: string; accountId?: string }[],
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'quotahot-inuse-accounts-'));
  for (const [i, a] of accounts.entries()) {
    await writeFile(
      join(dir, `${i}.json`),
      JSON.stringify({
        type: a.provider,
        email: a.email,
        access_token: a.accessToken ?? '',
        account_id: a.accountId ?? '',
      }),
    );
  }
  return dir;
}

test('客户端凭证里是哪个账户，就标到哪个账户上', async () => {
  resetClientsInUse();
  await setClaudeCode('claude-token-a', 'a@x.com');
  const dir = await accountsDir([
    { provider: 'claude', email: 'a@x.com', accessToken: 'claude-token-a' },
    { provider: 'claude', email: 'b@x.com', accessToken: 'claude-token-b' },
  ]);

  const found = await scanClientsInUse(await loadAccounts(dir));
  const claude = found.filter((c) => c.source === 'claude-cli');
  assert.equal(claude.length, 1);
  assert.equal(claude[0].accountId, 'claude:a@x.com');
  assert.equal(claude[0].label, 'Claude Code');
  assert.equal(claude[0].error, '');
  // 另一个账户没被标上：一台电脑同一时刻只在用其中一个
  assert.equal(found.some((c) => c.accountId === 'claude:b@x.com'), false);
  await rm(dir, { recursive: true, force: true });
});

test('客户端换了账号，标记跟着换，并报出这一处变化', async () => {
  resetClientsInUse();
  const dir = await accountsDir([
    { provider: 'claude', email: 'a@x.com', accessToken: 'claude-token-a' },
    { provider: 'claude', email: 'b@x.com', accessToken: 'claude-token-b' },
  ]);

  await setClaudeCode('claude-token-a', 'a@x.com');
  const first = await refreshClientsInUse(await loadAccounts(dir));
  assert.equal(first.clients.find((c) => c.source === 'claude-cli')?.accountId, 'claude:a@x.com');
  assert.equal(first.changes.length, 1);

  // 同一份文件里换成另一个账户：邮箱和令牌都变了，这正是用户在 Claude Code 里重新登录的样子
  await setClaudeCode('claude-token-b', 'b@x.com');
  const second = await refreshClientsInUse(await loadAccounts(dir));
  assert.equal(second.clients.find((c) => c.source === 'claude-cli')?.accountId, 'claude:b@x.com');
  assert.equal(second.changes.length, 1);
  assert.equal(second.changes[0].accountId, 'claude:b@x.com');
  // 换人这件事要说清楚换成了谁、原先是谁，只报一句“变了”等于没报
  assert.match(second.changes[0].message, /b@x\.com/);
  assert.match(second.changes[0].message, /a@x\.com/);

  // 没再动过，就不该再报一遍：日志里的每一条都得是真的换过人
  const third = await refreshClientsInUse(await loadAccounts(dir));
  assert.deepEqual(third.changes, []);
  await rm(dir, { recursive: true, force: true });
});

test('同一个 Codex 账户被两个客户端用着，两个都报出来', async () => {
  resetClientsInUse();
  await writeJson(codexCliPath, { tokens: { access_token: 'codex-token', account_id: 'acct-1' } });
  await writeJson(opencodePath, { openai: { type: 'oauth', access: 'codex-token', accountId: 'acct-1' } });
  const dir = await accountsDir([
    { provider: 'codex', email: 'c@x.com', accessToken: 'codex-token', accountId: 'acct-1' },
  ]);

  const found = await scanClientsInUse(await loadAccounts(dir));
  const labels = found.filter((c) => c.accountId === 'codex:c@x.com').map((c) => c.label).sort();
  assert.deepEqual(labels, ['Codex CLI', 'OpenCode']);
  await rm(dir, { recursive: true, force: true });
});

test('客户端没装就整个跳过，不留一条读不出凭证的记录', async () => {
  resetClientsInUse();
  await rm(opencodePath, { force: true });
  const dir = await accountsDir([
    { provider: 'codex', email: 'c@x.com', accessToken: 'codex-token', accountId: 'acct-1' },
  ]);

  const found = await scanClientsInUse(await loadAccounts(dir));
  assert.equal(found.some((c) => c.source === 'opencode'), false);
  await rm(dir, { recursive: true, force: true });
});

test('客户端登录的账户没导进来时，不硬安到同一家的别的账户头上', async () => {
  resetClientsInUse();
  await writeJson(codexCliPath, { tokens: { access_token: 'someone-else', account_id: 'acct-9' } });
  await rm(opencodePath, { force: true });
  const dir = await accountsDir([
    { provider: 'codex', email: 'c@x.com', accessToken: 'codex-token', accountId: 'acct-1' },
  ]);

  const found = await scanClientsInUse(await loadAccounts(dir));
  const codex = found.find((c) => c.source === 'codex-cli');
  assert.equal(codex?.accountId, '');
  // 认不出账户，但认得出它是谁：日志里得说得出「现在登录的是 acct-9」
  assert.equal(codex?.who, 'acct-9');
  await rm(dir, { recursive: true, force: true });
});

test('凭证文件读不动时如实记一条，不当成没这个客户端', async () => {
  resetClientsInUse();
  await mkdir(dirname(codexCliPath), { recursive: true });
  await writeFile(codexCliPath, '{ 这不是 JSON');
  const dir = await accountsDir([
    { provider: 'codex', email: 'c@x.com', accessToken: 'codex-token', accountId: 'acct-1' },
  ]);

  const found = await scanClientsInUse(await loadAccounts(dir));
  const codex = found.find((c) => c.source === 'codex-cli');
  assert.equal(codex?.accountId, '');
  assert.notEqual(codex?.error, '');
  await rm(dir, { recursive: true, force: true });
});
