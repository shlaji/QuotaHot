import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadAccounts } from '../src/server/creds.js';
import { setClientPaths } from '../src/server/clientpaths.js';
import {
  readClientCredentialSnapshot,
  writeVerifiedClientSnapshot,
} from '../src/server/clientfilesnapshot.js';
import {
  syncRefreshedTokenToClients,
  syncTargetsOf,
  syncToClient,
} from '../src/server/clientsync.js';

/**
 * 把令牌写回客户端配置文件。
 * 这里改的是用户自己的文件，所以断言的重点不是“写没写成”，而是：其他字段有没有被动、
 * 有没有留下备份、以及报出来的改动清单是否如实——用户全靠这份清单知道自己的文件变成了什么样。
 *
 * Codex 会走到“写默认路径”那条分支，真跑起来就是往运行测试的人自己的 ~/.codex 和 OpenCode
 * 凭证库里写。所以先把 HOME / XDG_DATA_HOME 指到临时目录：跑测试不该动任何人的登录状态。
 */
  const home = await mkdtemp(join(tmpdir(), 'quotahot-clientsync-home-'));
process.env.HOME = home;
process.env.XDG_DATA_HOME = join(home, '.local', 'share');
const codexCliPath = join(home, '.codex', 'auth.json');
const opencodePath = join(home, '.local', 'share', 'opencode', 'auth.json');
const omoAgentPath = join(home, '.omo', 'agent', 'auth.json');
const piPath = join(home, '.pi', 'agent', 'auth.json');
afterEach(async () => rm(dirname(piPath), { recursive: true, force: true }));

/** 摆好（或撤掉）OpenCode 的凭证库：它在不在，直接决定 Codex 有几个写回目标。 */
async function setOpencode(content: unknown | null): Promise<void> {
  await mkdir(dirname(opencodePath), { recursive: true });
  if (content === null) await rm(opencodePath, { force: true });
  else await writeFile(opencodePath, JSON.stringify(content), 'utf8');
}

const opencodeFile = {
  openai: { type: 'oauth', access: 'stale', refresh: 'stale-r', expires: 1_700_000_000_000 },
  'opencode-go': { type: 'api', key: 'sk-user-own-key' },
};

/** 一个账户文件 + 一个待写回的客户端文件。 */
async function fixture(
  account: Record<string, unknown>,
  client?: { name: string; content: unknown },
): Promise<{ dir: string; clientPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'quotahot-clientsync-'));
  const clientPath = join(dir, client?.name ?? '.credentials.json');
  await writeFile(
    join(dir, 'acct.json'),
    JSON.stringify({ sync_path: clientPath, ...account }),
    'utf8',
  );
  if (client) await writeFile(clientPath, JSON.stringify(client.content, null, 2), 'utf8');
  return { dir, clientPath };
}

const claudeAccount = {
  type: 'claude',
  email: 'a@example.com',
  access_token: 'new-access-token-value',
  refresh_token: 'new-refresh-token-value',
  expired: new Date(1_800_000_000_000).toISOString(),
  source: 'claude-cli',
  sync_source: 'claude-cli',
  auto_refresh: true,
};

test('写回 Claude Code：只动令牌那几个键，其余字段逐字保留', async () => {
  const { dir, clientPath } = await fixture(claudeAccount, {
    name: '.credentials.json',
    content: {
      claudeAiOauth: {
        accessToken: 'old-access-token-value',
        refreshToken: 'old-refresh-token-value',
        expiresAt: 1_700_000_000_000,
        scopes: ['user:inference'],
        subscriptionType: 'max',
      },
      somethingElse: { keep: true },
    },
  });

  const [acct] = await loadAccounts(dir);
  const [result] = await syncToClient(acct);

  const saved = JSON.parse(await readFile(clientPath, 'utf8'));
  assert.equal(saved.claudeAiOauth.accessToken, 'new-access-token-value');
  assert.equal(saved.claudeAiOauth.refreshToken, 'new-refresh-token-value');
  assert.equal(saved.claudeAiOauth.expiresAt, 1_800_000_000_000);
  // 这两项本程序压根不知道，绝不能在写回时被抹掉
  assert.deepEqual(saved.claudeAiOauth.scopes, ['user:inference']);
  assert.equal(saved.claudeAiOauth.subscriptionType, 'max');
  assert.deepEqual(saved.somethingElse, { keep: true });

  // 覆盖前的原文还得能找回来
  const backup = JSON.parse(await readFile(result.backupPath, 'utf8'));
  assert.equal(backup.claudeAiOauth.accessToken, 'old-access-token-value');
  assert.equal(result.created, false);
  assert.equal(result.label, 'Claude Code');
});

test('改动清单逐项列出字段，令牌只留头尾', async () => {
  const { dir } = await fixture(claudeAccount, {
    name: '.credentials.json',
    content: { claudeAiOauth: { accessToken: 'old-access-token-value', expiresAt: 1 } },
  });

  const [acct] = await loadAccounts(dir);
  const [{ changes }] = await syncToClient(acct);
  const fields = changes.map((c) => c.field);
  assert.deepEqual(fields, [
    'claudeAiOauth.accessToken',
    'claudeAiOauth.refreshToken',
    'claudeAiOauth.expiresAt',
  ]);

  const token = changes[0];
  assert.equal(token.before.includes('old-access-token-value'), false, '完整令牌不能进日志');
  assert.equal(token.after.includes('new-access-token-value'), false);
  assert.match(token.after, /^new-acce…/);
  // 原文件没有 refreshToken，要说清楚这是新添的一项
  assert.equal(changes[1].before, '(无)');
});

test('内容已经一致时什么都不写，也不留备份', async () => {
  const { dir, clientPath } = await fixture(claudeAccount, {
    name: '.credentials.json',
    content: {
      claudeAiOauth: {
        accessToken: 'new-access-token-value',
        refreshToken: 'new-refresh-token-value',
        expiresAt: 1_800_000_000_000,
      },
    },
  });
  const before = await readFile(clientPath, 'utf8');

  const [acct] = await loadAccounts(dir);
  const [result] = await syncToClient(acct);
  assert.deepEqual(result.changes, []);
  assert.equal(result.backupPath, '', '反复点同一个按钮不该在用户目录里堆备份');
  assert.equal(await readFile(clientPath, 'utf8'), before);
});

test('目标文件不存在时新建，并如实标记为新建', async () => {
  const { dir, clientPath } = await fixture(claudeAccount);
  const [acct] = await loadAccounts(dir);
  const [result] = await syncToClient(acct);

  assert.equal(result.created, true);
  assert.equal(result.backupPath, '');
  const saved = JSON.parse(await readFile(clientPath, 'utf8'));
  assert.equal(saved.claudeAiOauth.accessToken, 'new-access-token-value');
});

const codexAccount = {
  type: 'codex',
  email: 'c@example.com',
  access_token: 'codex-access',
  refresh_token: 'codex-refresh',
  id_token: 'codex-id',
  account_id: 'acct-123',
  expired: new Date(1_800_000_000_000).toISOString(),
};

function jwt(claims: Record<string, string>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

test('自动回写只更新已存在且同账户的客户端凭证', async () => {
  await setOpencode({
    openai: { type: 'oauth', access: 'old-open-code', refresh: 'old-refresh', accountId: 'acct-123' },
  });
  const { dir, clientPath } = await fixture(
    { ...codexAccount, source: 'codex-cli', sync_source: 'codex-cli' },
    { name: 'auth.json', content: { tokens: { access_token: 'old-codex', account_id: 'acct-123' } } },
  );

  const [acct] = await loadAccounts(dir);
  const results = await syncRefreshedTokenToClients(acct);

  assert.equal(results.every((result) => result.error === ''), true);
  assert.equal(JSON.parse(await readFile(clientPath, 'utf8')).tokens.access_token, 'codex-access');
  assert.equal(JSON.parse(await readFile(opencodePath, 'utf8')).openai.access, 'codex-access');
});

for (const { name, content } of [
  { name: '其他账户 ID', content: { tokens: { access_token: 'old', account_id: 'other' } } },
  {
    name: '其他邮箱',
    content: { tokens: { access_token: jwt({ email: 'other@example.com' }) } },
  },
  { name: '未知身份', content: { tokens: { access_token: 'opaque-old' } } },
]) {
  test(`自动回写跳过${name}的客户端凭证`, async () => {
    await setOpencode(null);
    const { dir, clientPath } = await fixture(
      { ...codexAccount, source: 'codex-cli', sync_source: 'codex-cli' },
      { name: 'auth.json', content },
    );
    const before = await readFile(clientPath, 'utf8');

    const [acct] = await loadAccounts(dir);
    const [result] = await syncRefreshedTokenToClients(acct);

    assert.equal(await readFile(clientPath, 'utf8'), before);
    assert.equal(result.changes.length, 0);
    assert.match(result.warning, /跳过/);
  });
}

test('自动回写跳过 id_token 与 access_token 冲突的客户端凭证', async () => {
  await setOpencode(null);
  const { dir, clientPath } = await fixture(
    { ...codexAccount, source: 'codex-cli', sync_source: 'codex-cli' },
    {
      name: 'auth.json',
      content: {
        tokens: {
          access_token: jwt({ chatgpt_account_id: 'acct-123' }),
          id_token: jwt({ chatgpt_account_id: 'other' }),
          account_id: 'acct-123',
        },
      },
    },
  );
  const before = await readFile(clientPath, 'utf8');

  const [acct] = await loadAccounts(dir);
  const [result] = await syncRefreshedTokenToClients(acct);

  assert.equal(await readFile(clientPath, 'utf8'), before);
  assert.equal(result.changes.length, 0);
  assert.match(result.warning, /不一致/);
});

test('自动回写不会创建缺失的客户端凭证文件', async () => {
  await setOpencode(null);
  const { dir, clientPath } = await fixture({
    ...codexAccount,
    source: 'codex-cli',
    sync_source: 'codex-cli',
  });

  const [acct] = await loadAccounts(dir);
  const results = await syncRefreshedTokenToClients(acct);

  assert.deepEqual(results, []);
  await assert.rejects(() => readFile(clientPath, 'utf8'));
});

test('跟随客户端的账户不会自动写回凭证', async () => {
  await setOpencode(null);
  const { dir, clientPath } = await fixture(
    { ...codexAccount, source: 'codex-cli', sync_source: 'codex-cli', auto_refresh: false },
    { name: 'auth.json', content: { tokens: { access_token: 'old', account_id: 'acct-123' } } },
  );
  const before = await readFile(clientPath, 'utf8');

  const [acct] = await loadAccounts(dir);
  const results = await syncRefreshedTokenToClients(acct);

  assert.deepEqual(results, []);
  assert.equal(await readFile(clientPath, 'utf8'), before);
});

test('自动回写跳过无法读取的客户端目标', async () => {
  await setOpencode(null);
  const { dir, clientPath } = await fixture({
    ...codexAccount,
    source: 'codex-cli',
    sync_source: 'codex-cli',
  });
  await mkdir(clientPath);

  const [acct] = await loadAccounts(dir);
  const [result] = await syncRefreshedTokenToClients(acct);

  assert.equal(result.changes.length, 0);
  assert.match(result.warning, /无法读取/);
});

test('自动回写跳过无效 JSON 的客户端目标', async () => {
  await setOpencode(null);
  const { dir, clientPath } = await fixture(
    { ...codexAccount, source: 'codex-cli', sync_source: 'codex-cli' },
    { name: 'auth.json', content: { tokens: { access_token: 'old', account_id: 'acct-123' } } },
  );
  await writeFile(clientPath, '{not-json', 'utf8');
  const before = await readFile(clientPath, 'utf8');

  const [acct] = await loadAccounts(dir);
  const [result] = await syncRefreshedTokenToClients(acct);

  assert.equal(await readFile(clientPath, 'utf8'), before);
  assert.equal(result.changes.length, 0);
  assert.match(result.warning, /无法读取/);
});

test('自动回写在预写钩子发现内容变化时不留下或覆盖备份', async () => {
  await setOpencode(null);
  const { dir, clientPath } = await fixture(
    { ...codexAccount, source: 'codex-cli', sync_source: 'codex-cli' },
    { name: 'auth.json', content: { tokens: { access_token: 'old', account_id: 'acct-123' } } },
  );
  const backupPath = `${clientPath}.quotahot-bak`;
  await writeFile(backupPath, 'existing backup', 'utf8');
  const changed = '{"tokens":{"access_token":"changed","account_id":"acct-123"}}\n';

  const [acct] = await loadAccounts(dir);
  const [result] = await syncRefreshedTokenToClients(acct, {
    onTargetValidated: async (target) => writeFile(target.path, changed, 'utf8'),
  });

  assert.equal(await readFile(clientPath, 'utf8'), changed);
  assert.equal(await readFile(backupPath, 'utf8'), 'existing backup');
  assert.equal((await readdir(dir)).some((name) => name.startsWith('auth.json.quotahot-bak.')), false);
  assert.match(result.warning, /跳过/);
});

test('自动同步拒绝验证后原地变化的凭证内容', async () => {
  const { clientPath } = await fixture(
    { ...codexAccount, source: 'codex-cli', sync_source: 'codex-cli' },
    { name: 'auth.json', content: { tokens: { access_token: 'old', account_id: 'acct-123' } } },
  );
  const snapshot = await readClientCredentialSnapshot('codex-cli', clientPath);
  assert.ok(snapshot);

  const replacement = '{"tokens":{"access_token":"changed","account_id":"acct-123"}}\n';
  await writeFile(clientPath, replacement, 'utf8');

  try {
    assert.equal(await writeVerifiedClientSnapshot(clientPath, snapshot, '{"safe":true}\n'), 'changed');
    assert.equal(await readFile(clientPath, 'utf8'), replacement);
  } finally {
    await snapshot.close();
  }
});

test('自动同步不会在句柄打开后替换已删除重建的凭证文件', async () => {
  const { clientPath } = await fixture(
    { ...codexAccount, source: 'codex-cli', sync_source: 'codex-cli' },
    { name: 'auth.json', content: { tokens: { access_token: 'old', account_id: 'acct-123' } } },
  );
  const snapshot = await readClientCredentialSnapshot('codex-cli', clientPath);
  assert.ok(snapshot);

  await rm(clientPath);
  const replacement = '{"tokens":{"access_token":"replacement","account_id":"other"}}\n';
  await writeFile(clientPath, replacement, 'utf8');

  try {
    assert.equal(await writeVerifiedClientSnapshot(clientPath, snapshot, '{"safe":true}\n'), 'replaced');
    assert.equal(await readFile(clientPath, 'utf8'), replacement);
  } finally {
    await snapshot.close();
  }
});

test('自动回写在一个目标发生写入错误时仍更新另一个已验证目标', async () => {
  await setOpencode({
    openai: { type: 'oauth', access: 'old-open-code', refresh: 'old-refresh', accountId: 'acct-123' },
  });
  const { dir, clientPath } = await fixture(
    { ...codexAccount, source: 'codex-cli', sync_source: 'codex-cli' },
    { name: 'auth.json', content: { tokens: { access_token: 'old', account_id: 'acct-123' } } },
  );
  const before = await readFile(clientPath, 'utf8');
  await mkdir(`${clientPath}.quotahot-bak`);

  const [acct] = await loadAccounts(dir);
  const results = await syncRefreshedTokenToClients(acct);

  assert.equal(await readFile(clientPath, 'utf8'), before);
  assert.equal(JSON.parse(await readFile(opencodePath, 'utf8')).openai.access, 'codex-access');
  assert.equal(results.length, 2);
  assert.notEqual(results[0]?.error, '');
  assert.match(results[0]?.backupPath ?? '', /\.recovery$/);
  assert.equal((await readdir(dir)).some((name) => name.endsWith('.tmp')), false);
  assert.equal(results[1]?.error, '');
});

test('写回 Codex CLI：令牌挂在 tokens 下，并顺手更新 last_refresh', async () => {
  await setOpencode(opencodeFile);
  const { dir, clientPath } = await fixture(
    { ...codexAccount, source: 'codex-cli', sync_source: 'codex-cli' },
    {
      name: 'auth.json',
      content: {
        OPENAI_API_KEY: 'sk-user-own-key',
        tokens: { access_token: 'stale', refresh_token: 'stale-r' },
        last_refresh: '2020-01-01T00:00:00.000Z',
      },
    },
  );

  const [acct] = await loadAccounts(dir);
  const [cli] = await syncToClient(acct);

  const saved = JSON.parse(await readFile(clientPath, 'utf8'));
  assert.equal(saved.tokens.access_token, 'codex-access');
  assert.equal(saved.tokens.id_token, 'codex-id');
  assert.equal(saved.tokens.account_id, 'acct-123');
  assert.equal(saved.OPENAI_API_KEY, 'sk-user-own-key', '用户自己的 API key 不许动');
  assert.notEqual(saved.last_refresh, '2020-01-01T00:00:00.000Z');
  assert.equal(
    cli.changes.some((c) => c.field === 'last_refresh'),
    true,
    '时间戳也是一处改动，同样要报给用户',
  );
});

test('写回 OpenCode：令牌挂在 openai 下，用它自己的短字段名，别的 provider 一字不动', async () => {
  await setOpencode(opencodeFile);
  const { dir } = await fixture({ ...codexAccount, source: 'codex-cli', sync_source: 'codex-cli' });

  const [acct] = await loadAccounts(dir);
  const [, oc] = await syncToClient(acct);

  const saved = JSON.parse(await readFile(opencodePath, 'utf8'));
  assert.equal(saved.openai.type, 'oauth');
  assert.equal(saved.openai.access, 'codex-access');
  assert.equal(saved.openai.refresh, 'codex-refresh');
  assert.equal(saved.openai.expires, 1_800_000_000_000);
  assert.equal(saved.openai.accountId, 'acct-123');
  // OpenCode 的文件里没有这两样东西，写回不该给它添出来
  assert.equal('id_token' in saved.openai, false);
  assert.equal('last_refresh' in saved, false);
  assert.deepEqual(saved['opencode-go'], { type: 'api', key: 'sk-user-own-key' }, '别的 provider 不许动');
  assert.equal(oc.label, 'OpenCode');
  assert.equal(oc.error, '');
});

test('写回 Oh-My-OpenCode agent：只更新 ChatGPT 订阅项并保留其他 provider', async () => {
  await mkdir(dirname(omoAgentPath), { recursive: true });
  await writeFile(omoAgentPath, JSON.stringify({
    'opencode-go': { type: 'api', key: 'sk-user-own-key' },
    agnes: { type: 'api', key: 'agnes-key' },
    qoder: { type: 'api', key: 'qoder-key' },
    'chatgpt-subscription': {
      type: 'oauth', access: 'old-access', refresh: 'old-refresh', expires: 1, accountId: 'old-id',
    },
  }), 'utf8');
  const { dir } = await fixture({ ...codexAccount, source: 'codex-cli', sync_source: 'codex-cli' });

  const [acct] = await loadAccounts(dir);
  const results = await syncToClient(acct);
  const target = results.find((result) => result.source === 'omo-agent');
  assert.ok(target);
  assert.equal(target.error, '');

  const saved = JSON.parse(await readFile(omoAgentPath, 'utf8'));
  assert.deepEqual(saved['chatgpt-subscription'], {
    type: 'oauth',
    access: 'codex-access',
    refresh: 'codex-refresh',
    expires: 1_800_000_000_000,
    accountId: 'acct-123',
  });
  assert.deepEqual(saved['opencode-go'], { type: 'api', key: 'sk-user-own-key' });
  assert.deepEqual(saved.agnes, { type: 'api', key: 'agnes-key' });
  assert.deepEqual(saved.qoder, { type: 'api', key: 'qoder-key' });
  assert.equal('last_refresh' in saved, false);
  await rm(omoAgentPath, { force: true });
});

test('Codex 两个目标各写各的：cli-proxy-api 导入的账户也照样写这两个文件', async () => {
  await setOpencode(opencodeFile);
  const { dir, clientPath } = await fixture({
    ...codexAccount,
    source: 'cli-proxy-api',
    sync_source: 'cli-proxy-api',
  });

  const [acct] = await loadAccounts(dir);
  const results = await syncToClient(acct);

  assert.deepEqual(
    results.map((r) => r.path),
    [codexCliPath, opencodePath, piPath],
    'Codex 的令牌要写给这两个客户端，而不是写回 cli-proxy-api 的认证目录',
  );
  assert.equal(
    results.every((r) => r.error === ''),
    true,
    '两个文件都得写成',
  );
  assert.equal(
    await readFile(clientPath, 'utf8').then(
      () => true,
      () => false,
    ),
    false,
    '来源文件不该被当成同步目标',
  );
  const cliSaved = JSON.parse(await readFile(codexCliPath, 'utf8'));
  assert.equal(cliSaved.tokens.access_token, 'codex-access');
  const ocSaved = JSON.parse(await readFile(opencodePath, 'utf8'));
  assert.equal(ocSaved.openai.access, 'codex-access');
});

test('没有 OpenCode 的凭证库就不写它：没装的机器上不该凭空多出一个 auth.json', async () => {
  await setOpencode(null);
  const { dir } = await fixture({
    ...codexAccount,
    source: 'cli-proxy-api',
    sync_source: 'cli-proxy-api',
  });

  const [acct] = await loadAccounts(dir);
  const results = await syncToClient(acct);

  assert.deepEqual(
    results.map((r) => r.path),
    [codexCliPath, piPath],
    '只剩 Codex CLI 一个目标',
  );
  assert.equal(
    await readFile(opencodePath, 'utf8').then(
      () => true,
      () => false,
    ),
    false,
    '文件不存在就该跳过，而不是替用户建一个',
  );
});

test('Claude 不写给 OpenCode：哪怕 OpenCode 的凭证库就在那儿', async () => {
  await setOpencode(opencodeFile);
  const { dir, clientPath } = await fixture(claudeAccount);

  const [acct] = await loadAccounts(dir);
  const results = await syncToClient(acct);

  assert.deepEqual(
    results.map((r) => r.path),
    [clientPath, piPath],
  );
  const saved = JSON.parse(await readFile(opencodePath, 'utf8'));
  assert.deepEqual(saved, opencodeFile, 'OpenCode 的文件一个字都不该被动');
});

test('目标文件原先是别人的账户时给出提醒，但照样写回', async () => {
  const { dir } = await fixture(
    {
      type: 'claude',
      email: 'new@example.com',
      access_token: 'tok',
      source: 'cli-proxy-api',
      sync_source: 'cli-proxy-api',
    },
    { name: 'other.json', content: { email: 'old@example.com', access_token: 'tok-old' } },
  );

  const [acct] = await loadAccounts(dir);
  const [result] = await syncToClient(acct);
  assert.match(result.warning, /old@example\.com/);
  assert.match(result.warning, /new@example\.com/);
  assert.equal(result.changes.length > 0, true, '提醒归提醒，用户点了就该写');
});

test('Qoder 没有可写回的文件，直接报错而不是写错地方', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quotahot-clientsync-'));
  await writeFile(
    join(dir, 'acct.json'),
    JSON.stringify({
      type: 'qoder',
      email: 'q@example.com',
      access_token: 'tok',
      source: 'qoder-ide',
      sync_path: join(dir, 'state.vscdb'),
    }),
    'utf8',
  );

  const [acct] = await loadAccounts(dir);
  assert.deepEqual(await syncTargetsOf(acct), []);
  await assert.rejects(() => syncToClient(acct), /state\.vscdb/);
});

test('本程序登录进来的账户落到该客户端的默认路径', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quotahot-clientsync-'));
  await writeFile(
    join(dir, 'acct.json'),
    JSON.stringify({ type: 'claude', email: 'o@example.com', access_token: 'tok', source: 'oauth' }),
    'utf8',
  );

  const [acct] = await loadAccounts(dir);
  const [target, ...rest] = await syncTargetsOf(acct);
  assert.equal(target?.source, 'claude-cli');
  assert.match(target?.path ?? '', /\.claude\/\.credentials\.json$/);
  assert.deepEqual(rest, [{ source: 'pi-claude', label: 'Pi (Claude)', path: piPath }]);
});

test('Pi 来源只同步原路径的对应 provider，普通账户额外提供配置的 Pi 路径', async (context) => {
  const configured = join(home, 'configured-pi', 'auth.json');
  setClientPaths({ pi: configured });
  context.after(() => setClientPaths({}));
  const { dir, clientPath } = await fixture({ ...codexAccount, source: 'pi', sync_source: 'pi-codex' });
  const [pi] = await loadAccounts(dir);
  assert.deepEqual(await syncTargetsOf(pi), [{ source: 'pi-codex', label: 'Pi (Codex)', path: clientPath }]);
  const { dir: ordinaryDir } = await fixture({ ...codexAccount, source: 'oauth' });
  const [ordinary] = await loadAccounts(ordinaryDir);
  assert.equal((await syncTargetsOf(ordinary)).find((target) => target.source === 'pi-codex')?.path, configured);
});

test('Pi 来源的 provider 与账户不匹配时不回退到默认客户端目标', async () => {
  const { dir } = await fixture({ ...codexAccount, source: 'pi', sync_source: 'pi-claude' });
  const [acct] = await loadAccounts(dir);
  assert.deepEqual(await syncTargetsOf(acct), []);
});

test('Pi 来源缺失 provider 标识或原始路径时不退回默认 CLI 或 Pi 路径', async () => {
  const { dir } = await fixture({ ...codexAccount, source: 'pi', sync_source: '', sync_path: '' });
  const [acct] = await loadAccounts(dir);
  assert.deepEqual(await syncTargetsOf(acct), []);
  const withSource = { ...acct, syncSource: 'pi-codex' };
  assert.deepEqual(await syncTargetsOf(withSource), []);
});

test('手动同步 Pi Claude 只更新 anthropic，保留 sibling、额外字段并报告遮盖的改动', async () => {
  const original = { anthropic: { type: 'oauth', access: 'old-access-token-value', refresh: 'old-refresh', expires: 1, custom: 'keep' },
    'openai-codex': { type: 'oauth', access: 'other', accountId: 'B' }, extra: { keep: true } };
  const { dir, clientPath } = await fixture({ ...claudeAccount, source: 'pi', sync_source: 'pi-claude' },
    { name: 'auth.json', content: original });
  const [acct] = await loadAccounts(dir);
  const [result] = await syncToClient(acct);
  const saved = JSON.parse(await readFile(clientPath, 'utf8'));
  assert.deepEqual(saved.anthropic, { type: 'oauth', access: claudeAccount.access_token,
    refresh: claudeAccount.refresh_token, expires: 1_800_000_000_000, custom: 'keep' });
  assert.deepEqual(saved['openai-codex'], original['openai-codex']);
  assert.deepEqual(saved.extra, original.extra);
  assert.deepEqual(JSON.parse(await readFile(result.backupPath, 'utf8')), original);
  assert.deepEqual(result.changes.map((change) => change.field), ['anthropic.access', 'anthropic.refresh', 'anthropic.expires']);
  assert.equal(result.changes[0]?.after.includes(claudeAccount.access_token), false);
  assert.equal('idToken' in saved.anthropic, false);
});

test('手动同步 Pi Codex 映射 accountId 且只更新 openai-codex', async () => {
  const original = { anthropic: { type: 'api_key', key: 'untouched' },
    'openai-codex': { type: 'oauth', access: 'old', refresh: 'old-r', expires: 1, accountId: 'B', custom: true } };
  const { dir, clientPath } = await fixture({ ...codexAccount, source: 'pi', sync_source: 'pi-codex' },
    { name: 'auth.json', content: original });
  const [acct] = await loadAccounts(dir);
  const [result] = await syncToClient(acct);
  const saved = JSON.parse(await readFile(clientPath, 'utf8'));
  assert.deepEqual(saved['openai-codex'], { type: 'oauth', access: codexAccount.access_token,
    refresh: codexAccount.refresh_token, expires: 1_800_000_000_000, accountId: 'acct-123', custom: true });
  assert.deepEqual(saved.anthropic, original.anthropic);
  assert.equal(result.error, '');
  assert.equal('idToken' in saved['openai-codex'], false);
});

test('手动 Pi 同步明确创建缺失文件及父目录，自动同步不创建', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quotahot-pi-create-'));
  const path = join(dir, 'new', 'auth.json');
  await writeFile(join(dir, 'acct.json'), JSON.stringify({ ...claudeAccount, source: 'pi', sync_source: 'pi-claude', sync_path: path }));
  const [acct] = await loadAccounts(dir);
  assert.deepEqual(await syncRefreshedTokenToClients(acct), []);
  await assert.rejects(() => readFile(path, 'utf8'));
  const [result] = await syncToClient(acct);
  assert.equal(result.created, true);
  assert.equal(result.backupPath, '');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).anthropic.access, claudeAccount.access_token);
});

for (const content of ['{broken', '[]', JSON.stringify({ anthropic: { type: 'api_key', key: 'secret' } }),
  JSON.stringify({ anthropic: { type: 'oauth', access: 'old' } })]) {
  test(`手动 Pi 同步拒绝已有的无效凭证 ${content}`, async () => {
    const { dir, clientPath } = await fixture({ ...claudeAccount, source: 'pi', sync_source: 'pi-claude' });
    await writeFile(clientPath, content);
    const [acct] = await loadAccounts(dir);
    const [result] = await syncToClient(acct);
    assert.ok(result.error);
    assert.equal(await readFile(clientPath, 'utf8'), content);
    await assert.rejects(() => readFile(`${clientPath}.quotahot-bak`, 'utf8'));
  });
}

test('自动 Pi 同步对已有同身份 provider 安全写回并保留 sibling', async () => {
  const original = { 'openai-codex': { type: 'oauth', access: 'old', refresh: 'old-r', expires: 1, accountId: 'acct-123' },
    anthropic: { type: 'oauth', access: 'unrelated', refresh: 'other', expires: 1 } };
  const { dir, clientPath } = await fixture({ ...codexAccount, source: 'pi', sync_source: 'pi-codex', auto_refresh: true },
    { name: 'auth.json', content: original });
  const [acct] = await loadAccounts(dir);
  const [result] = await syncRefreshedTokenToClients(acct);
  const saved = JSON.parse(await readFile(clientPath, 'utf8'));
  assert.equal(result.error, '');
  assert.equal(saved['openai-codex'].access, codexAccount.access_token);
  assert.deepEqual(saved.anthropic, original.anthropic);
  assert.deepEqual(JSON.parse(await readFile(result.backupPath, 'utf8')), original);
});

test('普通 Codex 自动刷新仅写回已存在且身份匹配的共享 Pi 凭证', async (context) => {
  const dir = await mkdtemp(join(tmpdir(), 'quotahot-pi-auto-'));
  const path = join(dir, 'auth.json');
  setClientPaths({ pi: path });
  context.after(() => setClientPaths({}));
  await writeFile(path, JSON.stringify({ 'openai-codex': {
    type: 'oauth', access: 'old', refresh: 'old-r', expires: 1, accountId: 'acct-123', custom: true,
  }, anthropic: { type: 'api_key', key: 'keep' } }));
  const { dir: accountDir } = await fixture({ ...codexAccount, source: 'oauth' });
  const [acct] = await loadAccounts(accountDir);
  const results = await syncRefreshedTokenToClients(acct);
  const pi = results.find((result) => result.source === 'pi-codex');
  assert.equal(pi?.error, '');
  assert.ok(pi?.changes.some((change) => change.field === 'openai-codex.access'));
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved['openai-codex'].access, codexAccount.access_token);
  assert.equal(saved['openai-codex'].custom, true);
  assert.deepEqual(saved.anthropic, { type: 'api_key', key: 'keep' });
});

test('手动 Pi Codex 同步拒绝不完整的本账户凭证，且不创建目标文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quotahot-pi-incomplete-'));
  const path = join(dir, 'auth.json');
  await writeFile(join(dir, 'account.json'), JSON.stringify({ ...codexAccount, source: 'pi',
    sync_source: 'pi-codex', sync_path: path, refresh_token: '' }));
  const [acct] = await loadAccounts(dir);
  const [result] = await syncToClient(acct);
  assert.match(result.error, /OAuth/);
  await assert.rejects(() => readFile(path, 'utf8'));
});
