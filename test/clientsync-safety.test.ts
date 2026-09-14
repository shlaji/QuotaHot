import { after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const home = await fs.mkdtemp(join(tmpdir(), 'quotahot-sync-safety-'));
process.env.HOME = home;
process.env.XDG_DATA_HOME = join(home, 'xdg');
after(() => fs.rm(home, { recursive: true, force: true }));
let failStaging = false;
let observedTarget = '';
let failDirectorySync = false;
const events: string[] = [];
mock.module('node:fs/promises', { exports: {
  ...fs,
  writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
    if (failStaging && String(args[0]).endsWith('.tmp')) {
      await fs.writeFile(args[0], 'partial-secret');
      throw new Error('injected staging failure');
    }
    return fs.writeFile(...args);
  },
  open: async (...args: Parameters<typeof fs.open>) => {
    const file = await fs.open(...args);
    const path = String(args[0]);
    const sync = file.sync.bind(file);
    mock.method(file, 'sync', async () => {
      if (failDirectorySync && path === dirname(observedTarget)) throw new Error('directory sync failed');
      await sync();
      if (path.endsWith('.tmp')) events.push('backup-synced');
      if (path === dirname(observedTarget)) events.push('directory-synced');
    });
    const write = file.writeFile.bind(file);
    mock.method(file, 'writeFile', async (...values: Parameters<typeof file.writeFile>) => {
      if (failStaging && path.endsWith('.tmp')) {
        await write('partial-secret');
        throw new Error('injected staging failure');
      }
      return write(...values);
    });
    const truncate = file.truncate.bind(file);
    mock.method(file, 'truncate', async (length?: number) => {
      if (path === observedTarget) {
        events.push('target-truncate');
        assert.equal(await fs.readFile(`${path}.quotahot-bak`, 'utf8'), original);
        assert.deepEqual(events.slice(0, 2), ['backup-synced', 'directory-synced']);
      }
      return truncate(length);
    });
    return file;
  },
} });
const { loadAccounts } = await import('../src/server/creds.js');
const { syncRefreshedTokenToClients } = await import('../src/server/clientsync.js');
const jwt = (claims: Record<string, string>) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
const original = JSON.stringify({ tokens: { account_id: 'A', access_token: 'old-token' } });

async function fixture(content: unknown, source = 'codex-cli') {
  const dir = await fs.mkdtemp(join(home, 'case-'));
  const client = source === 'opencode' ? join(home, 'xdg/opencode/auth.json') : join(dir, 'client.json');
  await fs.mkdir(dirname(client), { recursive: true });
  await fs.writeFile(client, typeof content === 'string' ? content : JSON.stringify(content));
  await fs.writeFile(join(dir, 'account.json'), JSON.stringify({
    type: 'codex', email: 'a@example.test', account_id: 'A', access_token: 'new-token',
    refresh_token: 'new-refresh', auto_refresh: true, sync_source: 'codex-cli',
    sync_path: source === 'opencode' ? join(dir, 'absent.json') : client,
  }));
  const [account] = await loadAccounts(dir);
  assert.ok(account);
  return { account, client, dir };
}

for (const [name, claims] of Object.entries({
  'explicit ID versus access token': { account_id: 'A', access_token: jwt({ chatgpt_account_id: 'B' }) },
  'explicit ID versus id token': { account_id: 'A', id_token: jwt({ account_id: 'B' }), access_token: 'old' },
  'explicit email versus access token': { account_id: 'A', email: 'a@example.test', access_token: jwt({ email: 'b@example.test' }) },
  'explicit email versus id token': { account_id: 'A', email: 'a@example.test', id_token: jwt({ email: 'b@example.test' }), access_token: 'old' },
  'token emails': { account_id: 'A', id_token: jwt({ email: 'a@example.test' }), access_token: jwt({ email: 'b@example.test' }) },
  'same token bytes with conflicting explicit ID': { account_id: 'B', access_token: 'new-token' },
})) {
  test(`automatic sync skips conflicting ${name}`, async () => {
    const { account, client, dir } = await fixture({ tokens: claims });
    const before = await fs.readFile(client, 'utf8');

    const [result] = await syncRefreshedTokenToClients(account);

    assert.equal(await fs.readFile(client, 'utf8'), before);
    assert.deepEqual(result?.changes, []);
    assert.ok(result?.warning);
    assert.equal((await fs.readdir(dir)).some((name) => name.includes('quotahot-bak')), false);
  });
}

test('official backup is durable before the first target truncation', async () => {
  const { account, client } = await fixture(original);
  observedTarget = client;
  events.length = 0;

  const [result] = await syncRefreshedTokenToClients(account);

  observedTarget = '';
  assert.equal(result?.error, '');
  assert.ok(events.includes('target-truncate'));
  assert.equal(await fs.readFile(`${client}.quotahot-bak`, 'utf8'), original);
});

test('partial unpublished backup is removed when staging fails', async () => {
  const { account, client, dir } = await fixture(original);
  await fs.writeFile(`${client}.quotahot-bak`, 'prior-backup');
  failStaging = true;

  const [result] = await syncRefreshedTokenToClients(account);

  failStaging = false;
  assert.ok(result?.error);
  assert.equal(await fs.readFile(client, 'utf8'), original);
  assert.equal(await fs.readFile(`${client}.quotahot-bak`, 'utf8'), 'prior-backup');
  assert.deepEqual((await fs.readdir(dir)).filter((name) => name.endsWith('.tmp')), []);
});

test('OpenCode explicit account ID cannot hide an access-token identity conflict', async () => {
  const { account, client } = await fixture({ openai: {
    type: 'oauth', accountId: 'A', access: jwt({ chatgpt_account_id: 'B' }),
  } }, 'opencode');
  const before = await fs.readFile(client, 'utf8');

  const [result] = await syncRefreshedTokenToClients(account);

  assert.equal(await fs.readFile(client, 'utf8'), before);
  assert.deepEqual(result?.changes, []);
  assert.ok(result?.warning);
  await fs.rm(client);
});

test('OpenCode explicit email cannot hide an access-token email conflict', async () => {
  const { account, client } = await fixture({ openai: {
    type: 'oauth', accountId: 'A', email: 'b@example.test', access: jwt({ email: 'a@example.test' }),
  } }, 'opencode');
  const before = await fs.readFile(client, 'utf8');

  const [result] = await syncRefreshedTokenToClients(account);

  assert.equal(await fs.readFile(client, 'utf8'), before);
  assert.deepEqual(result?.changes, []);
  assert.ok(result?.warning);
  await fs.rm(client);
});

test('consistent explicit and JWT identities allow automatic sync', async () => {
  const { account, client } = await fixture({ tokens: {
    account_id: 'A', email: 'A@EXAMPLE.TEST',
    id_token: jwt({ account_id: 'A', email: 'a@example.test' }),
    access_token: jwt({ chatgpt_account_id: 'A', email: 'a@example.test' }),
  } });

  const [result] = await syncRefreshedTokenToClients(account);

  assert.equal(result?.error, '');
  assert.ok(result?.changes.length);
  assert.equal(JSON.parse(await fs.readFile(client, 'utf8')).tokens.access_token, 'new-token');
});

test('directory sync failure leaves the active file untouched and retains the published backup', async () => {
  const { account, client, dir } = await fixture(original);
  observedTarget = client;
  failDirectorySync = true;
  events.length = 0;

  const [result] = await syncRefreshedTokenToClients(account);

  failDirectorySync = false;
  observedTarget = '';
  assert.ok(result?.error);
  assert.equal(events.includes('target-truncate'), false);
  assert.equal(await fs.readFile(client, 'utf8'), original);
  assert.equal(await fs.readFile(`${client}.quotahot-bak`, 'utf8'), original);
  assert.deepEqual((await fs.readdir(dir)).filter((name) => name.endsWith('.tmp')), []);
});

test('SIGKILL immediately after truncation leaves an official recovery copy', async () => {
  const { client, dir } = await fixture(original);
  const source = `
    import { mock } from 'node:test';
    import * as fs from 'node:fs/promises';
    mock.module('node:fs/promises', { exports: {
      ...fs, open: async (...args) => {
        const file = await fs.open(...args);
        if (String(args[0]) === ${JSON.stringify(client)}) {
          const truncate = file.truncate.bind(file);
          file.truncate = async (length) => {
            await truncate(length);
            await file.sync();
            process.kill(process.pid, 'SIGKILL');
            await new Promise(() => {});
          };
        }
        return file;
      }
    }});
    const { loadAccounts } = await import(${JSON.stringify(new URL('../src/server/creds.ts', import.meta.url).href)});
    const { syncRefreshedTokenToClients } = await import(${JSON.stringify(new URL('../src/server/clientsync.ts', import.meta.url).href)});
    const [account] = await loadAccounts(${JSON.stringify(dir)});
    await syncRefreshedTokenToClients(account);
  `;

  const child = spawn(process.execPath,
    ['--import', 'tsx', '--experimental-test-module-mocks', '--input-type=module', '-e', source],
    { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, 'xdg') } });
  const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (_code, signal) => resolve(signal));
  });

  assert.equal(signal, 'SIGKILL');
  assert.equal(await fs.readFile(client, 'utf8'), '');
  assert.equal(await fs.readFile(`${client}.quotahot-bak`, 'utf8'), original);
  assert.deepEqual((await fs.readdir(dir)).filter((name) => name.endsWith('.tmp')), []);
});
