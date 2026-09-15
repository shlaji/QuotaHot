import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { createCipheriv, pbkdf2Sync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { captureQoderSession, restoreQoderSession } from '../src/server/qoder-native.js';
import { saveAccount, loadAccount, loadAccounts } from '../src/server/creds.js';
import { qoderTargets, switchQoderAccount } from '../src/server/qoder-switch.js';
import { qoderRoutes } from '../src/server/qoder-routes.js';
import { readQoderSessions } from '../src/server/qoder-session.js';
import type { QoderProcesses } from '../src/server/qoder-process.js';

function desktopCredential(id: string): Buffer {
  const cipher = createCipheriv('aes-128-cbc', pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1'), Buffer.alloc(16, 32));
  return Buffer.concat([Buffer.from('v10'), cipher.update(JSON.stringify({ schemaVersion: 1,
    token: `private-${id}`, refreshToken: `refresh-${id}`, expiresAt: '2099-01-01T00:00:00Z',
    user: { id, email: `${id}@example.com` } })), cipher.final()]);
}

async function desktopFixture(root: string) {
  const path = join(root, 'auth.v1.dat');
  const accounts = join(root, 'accounts');
  await writeFile(path, desktopCredential('a'));
  const captured = await captureQoderSession('qoder-desktop', path);
  await saveAccount(accounts, { provider: 'qoder', email: captured.email, userId: captured.userId,
    accessToken: captured.accessToken, refreshToken: captured.refreshToken, expiresAt: captured.expiresAt,
    source: 'qoder-desktop', autoRefresh: false, syncPath: path, qoderSession: captured.session });
  const account = await loadAccount(accounts, 'qoder:a@example.com');
  assert.ok(account);
  await writeFile(path, desktopCredential('b'));
  return { path, accounts, account };
}

test('IDE 快照恢复只改变认证键，保留目标数据库中的其他设置', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quotahot-qoder-'));
  try {
    const path = join(root, 'state.vscdb');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE, value TEXT)');
    const insert = db.prepare('INSERT INTO ItemTable VALUES (?, ?)');
    insert.run('secret://aicoding.auth.userInfo', JSON.stringify({ userId: 'a', email: 'a@example.com', token: 'token-a' }));
    insert.run('editor.setting', 'keep');
    db.close();
    const saved = await captureQoderSession('qoder-ide', path);
    const changed = new DatabaseSync(path);
    changed.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(JSON.stringify({ userId: 'b', email: 'b@example.com', token: 'token-b' }), 'secret://aicoding.auth.userInfo');
    changed.close();
    await restoreQoderSession(saved.session, path);
    const actual = await captureQoderSession('qoder-ide', path);
    assert.equal(actual.userId, 'a');
    const verified = new DatabaseSync(path, { readOnly: true });
    assert.equal(verified.prepare('SELECT value FROM ItemTable WHERE key = ?').get('editor.setting')?.value, 'keep');
    verified.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('损坏的导入凭证不会覆盖目标文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quotahot-qoder-'));
  try {
    await mkdir(join(root, 'accounts'));
    await assert.rejects(captureQoderSession('qoder-desktop', join(root, 'missing.dat')));
    await assert.rejects(readFile(join(root, 'missing.dat')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('桌面端切换先关闭再写入并重启，备份保留原认证且接口不泄露 token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quotahot-qoder-'));
  try {
    const { path, accounts, account } = await desktopFixture(root);
    const events: string[] = [];
    const processes: QoderProcesses = {
      async preflight() { events.push('check'); },
      async stop() { assert.equal((await captureQoderSession('qoder-desktop', path)).userId, 'b'); events.push('stop'); return true; },
      async start() { assert.equal((await captureQoderSession('qoder-desktop', path)).userId, 'a'); events.push('start'); },
    };
    const result = await switchQoderAccount(account, 'qoder-desktop', processes);
    assert.deepEqual(events, ['check', 'check', 'stop', 'start']);
    assert.equal((await stat(result.backupPath)).mode & 0o777, 0o600);
    assert.equal((await captureQoderSession('qoder-desktop', path)).userId, 'a');
    const response = await qoderRoutes({ accountsDir: accounts, changed: async () => {} }).request(`/accounts/${encodeURIComponent(account.id)}/qoder-clients`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(body.includes('private-a'), false);
    assert.equal(body.includes('refresh-a'), false);
    assert.equal(body.includes('payload'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('桌面端启动失败会恢复原始认证而不是报告成功', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quotahot-qoder-'));
  try {
    const { path, account } = await desktopFixture(root);
    const before = await readFile(path);
    let starts = 0;
    const processes: QoderProcesses = {
      async preflight() {}, async stop() { return true; },
      async start() { if (++starts === 1) throw new Error('start failure'); },
    };
    await assert.rejects(switchQoderAccount(account, 'qoder-desktop', processes), /已恢复/);
    assert.deepEqual(await readFile(path), before);
    assert.equal(starts, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('未导入的客户端不能借用另一端认证且未确认请求不产生切换', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quotahot-qoder-'));
  try {
    const { path, accounts, account } = await desktopFixture(root);
    const before = await readFile(path);
    const targets = await qoderTargets(account);
    assert.equal(targets.find((target) => target.client === 'qoder-ide')?.available, false);
    const response = await qoderRoutes({ accountsDir: accounts, changed: async () => {} }).request(`/accounts/${encodeURIComponent(account.id)}/qoder-switch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: 'qoder-desktop' }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await readFile(path), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('重复导入及 OAuth 更新保留同账户已保存的客户端认证快照', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quotahot-qoder-'));
  try {
    const { accounts, account } = await desktopFixture(root);
    const before = await readQoderSessions(account.path);
    await saveAccount(accounts, { provider: 'qoder', email: account.email, userId: account.userId,
      accessToken: 'new-oauth-session', refreshToken: '', expiresAt: 0, source: 'oauth', autoRefresh: false });
    assert.deepEqual(await readQoderSessions(account.path), before);
    await assert.rejects(saveAccount(accounts, { provider: 'qoder', email: account.email, userId: 'different-user',
      accessToken: 'other', refreshToken: '', expiresAt: 0, source: 'oauth', autoRefresh: false }), /身份不一致/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI 原生加密快照能切换并保持 machine_id 不变', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quotahot-qoder-'));
  try {
    const machine = '01234567-89ab-cdef-0123-456789abcdef';
    const key = Buffer.from(machine.slice(0, 16));
    const cipher = createCipheriv('aes-128-cbc', key, key);
    const raw = Buffer.from(Buffer.concat([cipher.update(JSON.stringify({ uid: 'cli-user', email: 'cli@example.com', security_oauth_token: 'cli-token' })), cipher.final()]).toString('base64'));
    const path = join(root, 'user');
    await writeFile(join(root, 'machine_id'), machine);
    await writeFile(path, raw);
    const capture = await captureQoderSession('qoder-cli', path);
    const accounts = join(root, 'accounts');
    await saveAccount(accounts, { provider: 'qoder', email: capture.email, userId: capture.userId,
      accessToken: capture.accessToken, refreshToken: '', expiresAt: 0, source: 'qoder-cli', autoRefresh: false, qoderSession: capture.session });
    const account = await loadAccount(accounts, 'qoder:cli@example.com');
    assert.ok(account);
    const processes: QoderProcesses = { async preflight() {}, async stop() { return false; }, async start() { assert.fail('CLI must not be launched'); } };
    const result = await switchQoderAccount(account, 'qoder-cli', processes);
    assert.equal(result.restarted, false);
    assert.deepEqual(await readFile(path), raw);
    assert.equal(await readFile(join(root, 'machine_id'), 'utf8'), machine);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('同一用户不同邮箱及并发导入合并到稳定账户而不丢客户端快照', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quotahot-qoder-'));
  try {
    const { accounts, account } = await desktopFixture(root);
    const snapshot = (await readQoderSessions(account.path))['qoder-desktop'];
    assert.ok(snapshot);
    await Promise.all(['qoder-cli', 'qoder-ide'].map(async (client) => {
      if (client !== 'qoder-cli' && client !== 'qoder-ide') throw new Error('bad fixture');
      await saveAccount(accounts, { provider: 'qoder', email: client === 'qoder-cli' ? 'a' : 'A@EXAMPLE.COM', userId: 'a',
        accessToken: 'same-owner', refreshToken: '', expiresAt: 0, source: client, autoRefresh: false,
        qoderSession: { ...snapshot, client } });
    }));
    assert.equal((await loadAccounts(accounts)).length, 1);
    assert.deepEqual(Object.keys(await readQoderSessions(account.path)).sort(), ['qoder-cli', 'qoder-desktop', 'qoder-ide']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('当前认证无法识别时拒绝覆盖，并恢复先前运行状态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quotahot-qoder-'));
  try {
    const { path, account } = await desktopFixture(root);
    await writeFile(path, 'unknown future format');
    let starts = 0;
    const processes: QoderProcesses = { async preflight() {}, async stop() { return true; }, async start() { starts++; } };
    await assert.rejects(switchQoderAccount(account, 'qoder-desktop', processes), /未修改认证/);
    assert.equal(await readFile(path, 'utf8'), 'unknown future format');
    assert.equal(starts, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('备份后其他进程改写凭证时中止，不回滚覆盖他人的新会话', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quotahot-qoder-'));
  try {
    const { path, account } = await desktopFixture(root);
    const processes: QoderProcesses = { async preflight() {}, async stop() { return false; }, async start() { assert.fail('not running'); },
      async assertStopped() { await writeFile(path, desktopCredential('c')); } };
    await assert.rejects(switchQoderAccount(account, 'qoder-desktop', processes), /未修改认证/);
    assert.equal((await captureQoderSession('qoder-desktop', path)).userId, 'c');
  } finally { await rm(root, { recursive: true, force: true }); }
});
