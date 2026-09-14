import { after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const home = await mkdtemp(join(tmpdir(), 'quotahot-renewal-home-'));
const previousHome = process.env.HOME;
const previousDataHome = process.env.XDG_DATA_HOME;
process.env.HOME = home;
process.env.XDG_DATA_HOME = join(home, 'xdg');
after(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousDataHome;
  await rm(home, { recursive: true, force: true });
});

let calls = 0;
let replacementId = 'A';
const jwt = (id: string) => `header.${Buffer.from(JSON.stringify({ chatgpt_account_id: id })).toString('base64url')}.signature`;
mock.module('../src/server/http.js', { exports: {
  request: async () => {
    calls++;
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({
      access_token: jwt(replacementId), refresh_token: 'rotated-refresh', expires_in: 3600,
    }) };
  }, noteError: () => {}, recordOutbound: () => {},
} });
const { ensureFresh, loadAccounts, refreshViaOAuth } = await import('../src/server/creds.js');
const { syncTargetsOf, opencodeAuthPath } = await import('../src/server/clientsync.js');

test('renewal default client paths remain inside the isolated home and XDG directories', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const [account] = await loadAccounts(f.accounts);
  assert.ok(account);

  const targets = await syncTargetsOf({ ...account, syncPath: '', syncSource: '', source: 'oauth' });

  assert.equal(targets[0]?.path, join(home, '.codex/auth.json'));
  assert.equal(opencodeAuthPath(), join(home, 'xdg/opencode/auth.json'));
});

test('OAuth refresh succeeds and persists tokens when client backup publication fails', async (t) => {
  const f = await fixture(true, 'A');
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  await mkdir(`${f.client}.quotahot-bak`);
  const before = await readFile(f.client, 'utf8');
  const [account] = await loadAccounts(f.accounts);
  assert.ok(account);
  const warnings: string[] = [];

  const refreshed = await refreshViaOAuth(account, (level, message) => {
    if (level === 'warn') warnings.push(message);
  });

  assert.equal(refreshed, true);
  assert.equal(account.refreshToken, 'rotated-refresh');
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).refresh_token, 'rotated-refresh');
  assert.equal(await readFile(f.client, 'utf8'), before);
  assert.ok(warnings.length > 0);
  assert.equal(warnings.join('').includes('rotated-refresh'), false);
  assert.equal(warnings.join('').includes(jwt('A')), false);
});

async function fixture(autoRefresh = true, clientAccountId = 'B') {
  const dir = await mkdtemp(join(tmpdir(), 'quotahot-renewal-'));
  const accounts = join(dir, 'accounts');
  await mkdir(accounts);
  const client = join(dir, 'client.json');
  const path = join(accounts, 'a.json');
  await writeFile(client, JSON.stringify({ tokens: { account_id: clientAccountId, access_token: jwt(clientAccountId) } }));
  await writeFile(path, JSON.stringify({ type: 'codex', email: 'a@example.test', account_id: 'A',
    access_token: 'old-access', refresh_token: 'old-refresh', expired: '2020-01-01T00:00:00Z',
    auto_refresh: autoRefresh, sync_source: 'codex-cli', sync_path: client }));
  return { dir, accounts, path, client };
}

test('OAuth 刷新后只回写同账户的本机客户端', async (t) => {
  const f = await fixture(true, 'A');
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  replacementId = 'A';
  const [account] = await loadAccounts(f.accounts);
  assert.ok(account);

  assert.equal(await refreshViaOAuth(account, () => {}), true);
  const saved = JSON.parse(await readFile(f.client, 'utf8'));
  assert.equal(saved.tokens.access_token, jwt('A'));
  assert.equal(saved.tokens.refresh_token, 'rotated-refresh');

  const different = await fixture(true, 'B');
  t.after(() => rm(different.dir, { recursive: true, force: true }));
  const before = await readFile(different.client, 'utf8');
  const [differentAccount] = await loadAccounts(different.accounts);
  assert.ok(differentAccount);
  assert.equal(await refreshViaOAuth(differentAccount, () => {}), true);
  assert.equal(await readFile(different.client, 'utf8'), before);
});

test('OAuth 刷新时客户端凭证不存在不会新建文件', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  await rm(f.client);
  replacementId = 'A';
  const [account] = await loadAccounts(f.accounts);
  assert.ok(account);

  assert.equal(await refreshViaOAuth(account, () => {}), true);
  await assert.rejects(readFile(f.client, 'utf8'), { code: 'ENOENT' });
});

test('跟随同步拒绝客户端换成其他账户且不改凭证', async (t) => {
  const f = await fixture(false);
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const before = await readFile(f.path, 'utf8');
  const [account] = await loadAccounts(f.accounts);
  assert.ok(account);
  assert.equal(await ensureFresh(account, () => {}), false);
  assert.equal(await readFile(f.path, 'utf8'), before);
});

test('没有 id_token 时也拒绝刷新成另一个账户', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  replacementId = 'B';
  const [account] = await loadAccounts(f.accounts);
  assert.ok(account);
  assert.equal(await refreshViaOAuth(account, () => {}), false);
  replacementId = 'A';
});

test('并发账户副本共享一次刷新且各自获得新令牌', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  calls = 0;
  replacementId = 'A';
  const [first] = await loadAccounts(f.accounts);
  const [second] = await loadAccounts(f.accounts);
  assert.ok(first && second);
  const results = await Promise.all([ensureFresh(first, () => {}), ensureFresh(second, () => {})]);
  assert.deepEqual(results, [true, true]);
  assert.equal(calls, 1);
  assert.equal(first.refreshToken, 'rotated-refresh');
  assert.equal(second.refreshToken, 'rotated-refresh');
});

test('两个进程刷新同一账户时复用持锁者写回的令牌', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const httpUrl = new URL('../src/server/http.ts', import.meta.url).href;
  const credsUrl = new URL('../src/server/creds.ts', import.meta.url).href;
  const marker = join(f.dir, 'calls');
  const source = `
    import { mock } from 'node:test';
    import { appendFile } from 'node:fs/promises';
    mock.module(${JSON.stringify(httpUrl)}, { exports: {
      request: async () => {
        await appendFile(${JSON.stringify(marker)}, 'refresh\\n');
        return { ok:true, status:200, text:async()=>JSON.stringify({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600}) };
      }, noteError:()=>{}, recordOutbound:()=>{}
    }});
    const {loadAccounts,ensureFresh}=await import(${JSON.stringify(credsUrl)});
    const [account]=await loadAccounts(${JSON.stringify(f.accounts)});
    process.on('message',async()=>{
      const ok=await ensureFresh(account,()=>{});
      process.send({ok,token:account.refreshToken});
      process.disconnect();
    });
    process.send('ready');
  `;
  const children = [0, 1].map(() => spawn(process.execPath,
    ['--import', 'tsx', '--experimental-test-module-mocks', '--input-type=module', '-e', source],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }));
  t.after(() => { for (const child of children) child.kill(); });
  await Promise.all(children.map((child) => new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('message', (message) => message === 'ready' ? resolve() : reject(new Error('unexpected child message')));
  })));
  const results = children.map((child) => new Promise<unknown>((resolve) => child.once('message', resolve)));
  for (const child of children) child.send('go');
  assert.deepEqual(await Promise.all(results), [
    { ok: true, token: 'new-refresh' }, { ok: true, token: 'new-refresh' },
  ]);
  assert.equal(await readFile(marker, 'utf8'), 'refresh\n');
});
