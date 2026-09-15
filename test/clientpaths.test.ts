import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Account } from '../src/server/creds.js';

/**
 * 客户端凭证位置的覆盖。
 *
 * 从前每个来源的路径都写死在四个地方（导入、跟随、写回、核对），装在非默认位置的人
 * 只能看到一句「本机没有这个路径」。现在它们统一向 clientpaths.ts 要位置，所以这里
 * 盯的是两件事：**没配过时默认值一个字都没变**，以及**配了之后那四处全都跟着走**——
 * 只跟一半更糟：会出现「导入读 A、写回却写 B」这种谁都看不出来的错位。
 *
 * 默认值看的是 HOME / XDG_*，所以先把它们指到临时目录，跑测试不该碰到真实的登录状态。
 */
const home = await mkdtemp(join(tmpdir(), 'quotahot-clientpaths-home-'));
process.env.HOME = home;
process.env.XDG_DATA_HOME = join(home, '.local', 'share');
process.env.XDG_CONFIG_HOME = join(home, '.config');
delete process.env.QODER_CONFIG_DIR;

const { clientPath, claudeProfilePath, defaultClientPath, setClientPaths } = await import(
  '../src/server/clientpaths.js'
);
const { CLIENT_PATH_KEYS } = await import('../src/shared/clientpaths.js');
const { normalizeClientPaths, validateClientPaths, normalize, DEFAULT_CONFIG } = await import(
  '../src/server/config.js'
);

async function writeJson(path: string, content: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(content, null, 2));
}

test('没配过时，每个来源还是各客户端在本机的老位置', () => {
  setClientPaths({});
  const defaults = Object.fromEntries(CLIENT_PATH_KEYS.map((k) => [k, defaultClientPath(k)]));
  assert.deepEqual(defaults, {
    'cli-proxy-api': join(home, '.cli-proxy-api'),
    'codex-cli': join(home, '.codex', 'auth.json'),
    'claude-cli': join(home, '.claude', '.credentials.json'),
    opencode: join(home, '.local', 'share', 'opencode', 'auth.json'),
    'qoder-ide': join(home, '.config', 'Qoder', 'User', 'globalStorage', 'state.vscdb'),
    'qoder-cli': join(home, '.qoder', '.auth', 'user'),
    'qoder-desktop': join(home, '.config', 'com.qoder.app.stable', 'auth.v1.dat'),
  });
  assert.equal(clientPath('codex-cli'), join(home, '.codex', 'auth.json'));
  // 默认配置里一个覆盖都没有：升级上来的用户行为不该变
  assert.deepEqual(DEFAULT_CONFIG.clientPaths, {});
});

test('Claude 的邮箱文件跟着凭证路径走，而不是单独再配一次', () => {
  setClientPaths({});
  assert.equal(claudeProfilePath(), join(home, '.claude.json'));
  setClientPaths({ 'claude-cli': '/data/creds/.claude/.credentials.json' });
  assert.equal(claudeProfilePath(), '/data/creds/.claude.json');
  setClientPaths({});
});

test('相对路径和不认识的来源一律丢掉，~ 展开成主目录', () => {
  assert.deepEqual(normalizeClientPaths({ 'codex-cli': '~/elsewhere/auth.json' }), {
    'codex-cli': join(home, 'elsewhere', 'auth.json'),
  });
  // 工作目录在终端和 systemd 下不是一回事，相对路径会指到两个地方去
  assert.deepEqual(normalizeClientPaths({ 'codex-cli': 'relative/auth.json' }), {});
  assert.deepEqual(normalizeClientPaths({ 'codex-cli': '   ' }), {});
  assert.deepEqual(normalizeClientPaths({ 'not-a-client': '/tmp/x' }), {});
  assert.deepEqual(normalizeClientPaths(undefined), {});
  // 走完整条 normalize 也是一样：配置文件里手写的脏数据同样进不来
  assert.deepEqual(normalize({ clientPaths: { opencode: 'nope' } }).clientPaths, {});
});

test('填了相对路径会当场报错，而不是保存成功却没生效', () => {
  assert.equal(validateClientPaths({}), null);
  assert.equal(validateClientPaths({ clientPaths: { 'codex-cli': '' } }), null);
  assert.equal(validateClientPaths({ clientPaths: { 'codex-cli': '~/a/auth.json' } }), null);
  assert.match(
    validateClientPaths({ clientPaths: { 'codex-cli': 'relative/auth.json' } }) ?? '',
    /Codex CLI 需要填绝对路径/,
  );
  assert.match(validateClientPaths({ clientPaths: { opencode: 42 } }) ?? '', /OpenCode/);
});

test('改过位置之后，导入扫描去的是新位置', async (context) => {
  const dir = await mkdtemp(join(tmpdir(), 'quotahot-clientpaths-proxy-'));
  context.after(() => setClientPaths({}));
  await writeJson(join(dir, 'one.json'), {
    type: 'claude',
    email: 'a@x.com',
    access_token: 'at-1',
    refresh_token: 'rt-1',
    expired: new Date(Date.now() + 3_600_000).toISOString(),
  });

  const { scanSources } = await import('../src/server/import.js');
  setClientPaths({ 'cli-proxy-api': dir });
  const found = (await scanSources()).find((s) => s.source === 'cli-proxy-api');
  assert.equal(found?.path, dir);
  assert.equal(found?.available, true);
  assert.deepEqual(
    found?.accounts.map((a) => a.email),
    ['a@x.com'],
  );

  // 换回默认位置就该找不到这个账户了，否则说明覆盖值被记死在了某处
  setClientPaths({});
  const atDefault = (await scanSources()).find((s) => s.source === 'cli-proxy-api');
  assert.equal(atDefault?.path, join(home, '.cli-proxy-api'));
});

test('跟随、写回、核对三处都认同一份覆盖', async (context) => {
  context.after(() => setClientPaths({}));
  const codexPath = join(home, 'elsewhere', '.codex', 'auth.json');
  const claudePath = join(home, 'elsewhere', '.claude', '.credentials.json');
  setClientPaths({ 'codex-cli': codexPath, 'claude-cli': claudePath });

  const { followSourceOf } = await import('../src/server/clientfile.js');
  const { syncTargetsOf } = await import('../src/server/clientsync.js');
  const { scanClientsInUse, resetClientsInUse } = await import('../src/server/inuse.js');

  // 跟随客户端：没记来源的账户按 provider 找本机客户端，位置要用覆盖值
  assert.equal(followSourceOf('codex', 'oauth', '')?.path, codexPath);
  assert.equal(followSourceOf('claude', 'oauth', '')?.path, claudePath);
  // 账户自己记着的来源文件仍然优先：那是它当初真的被读出来的地方
  assert.equal(followSourceOf('codex', 'codex-cli', '/opt/from-import/auth.json')?.path, '/opt/from-import/auth.json');

  // 写回客户端
  const account: Account = {
    id: 'codex:a@x.com',
    provider: 'codex',
    email: 'a@x.com',
    path: join(home, 'accounts', 'codex-a.json'),
    accountId: 'acct-1',
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: 0,
    disabled: false,
    plan: '',
    subscriptionEndsAt: 0,
    userId: '',
    loginMethod: '',
    source: 'oauth',
    autoRefresh: true,
    syncPath: '',
    syncSource: '',
    idToken: '',
  };
  const targets = await syncTargetsOf(account);
  assert.deepEqual(
    targets.filter((t) => t.source === 'codex-cli').map((t) => t.path),
    [codexPath],
  );

  // 「本机在用」核对
  await writeJson(codexPath, { tokens: { access_token: 'at', account_id: 'acct-1' } });
  resetClientsInUse();
  const slots = await scanClientsInUse([]);
  assert.ok(
    slots.some((s) => s.source === 'codex-cli' && s.path === codexPath),
    '核对的应当是改过之后的位置',
  );
});
