import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { opencodePlugin, selfInvocation } from '../src/install.js';
import { saveNotificationConfig } from '../src/notification-config.js';
import { NotificationLedgerFileSchema } from '../src/notification-schema.js';
import { createNotificationCliFixture } from './notification-cli-fixture.js';

const exec = promisify(execFile);

test('standalone notification install preserves ownership and deduplicates completions across reloads', async (t) => {
  const fixture = await createNotificationCliFixture(t);
  const configHome = join(fixture.home, 'config');
  const pluginDirectory = join(configHome, 'opencode', 'plugin');
  const quotaPath = join(pluginDirectory, 'quotahot.js');
  const notificationPath = join(pluginDirectory, 'quotahot-session-notify.js');
  const foreignPath = join(pluginDirectory, 'foreign.js');
  const ledgerPath = join(fixture.dataDir, 'session-notify-ledger.json');
  const environment = {
    ...process.env,
    HOME: fixture.home,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: join(fixture.home, 'client-data'),
    QUOTAHOT_DATA_DIR: fixture.dataDir,
    PATH: `${fixture.binDir}:${process.env.PATH ?? ''}`,
  };
  const runCli = (...args: string[]) => exec(process.execPath, [
    '--import', import.meta.resolve('tsx'), resolve('src/index.ts'), ...args,
  ], { cwd: process.cwd(), env: environment, timeout: 10_000 });

  await runCli('install');
  const quotaSource = await readFile(quotaPath, 'utf8');
  const foreignSource = 'export default async () => ({});\n';
  await writeFile(foreignPath, foreignSource);
  await runCli('notify', 'install');
  const notificationSource = await readFile(notificationPath, 'utf8');
  assert.match(quotaSource, /quotahot:start/);
  assert.doesNotMatch(quotaSource, /quotahot-session-notify:start/);
  assert.match(notificationSource, /quotahot-session-notify:start/);
  assert.doesNotMatch(notificationSource, /quotahot:start/);
  assert.equal(await readFile(quotaPath, 'utf8'), quotaSource);

  await saveNotificationConfig(fixture.dataDir, {
    version: 1,
    enabled: true,
    target: { openConversationId: 'conversation-1', displayName: 'Test group' },
    authorizedAt: '2026-10-22T10:00:00.000Z',
  });
  await writeFile(join(fixture.home, 'package.json'), '{"type":"module"}\n');
  const driverPath = join(fixture.home, 'opencode-driver.mjs');
  await writeFile(driverPath, `
import assert from 'node:assert/strict';
import SessionNotification from ${JSON.stringify(pathToFileURL(notificationPath).href)};

const notifications = [];
let messageReads = 0;
const plugin = await SessionNotification({ client: {
  session: { messages: async ({ path }) => {
    assert.equal(path.id, 'completion-session');
    messageReads += 1;
    return { data: [
      { info: { id: 'question', sessionID: path.id, role: 'user', time: { created: 1 } },
        parts: [{ type: 'text', text: 'question' }] },
      { info: { id: 'answer', sessionID: path.id, role: 'assistant', providerID: 'openai', time: { created: 2, completed: 3 } },
        parts: [{ type: 'text', text: 'final answer' }] },
    ] };
  } },
  tui: { showToast: async ({ body }) => { notifications.push(body); } },
} });
try {
  const idle = { event: { type: 'session.idle', properties: { sessionID: 'completion-session' } } };
  await plugin.event(idle);
  await plugin.event(idle);
  assert.equal(messageReads, 2);
  assert.equal(notifications.length, 2);
  for (const notification of notifications) {
    assert.equal(notification.variant, 'success');
    assert.match(notification.message, /sent/);
  }
} finally {
  await plugin.dispose();
}
`);
  await exec(process.execPath, [driverPath], { env: environment, timeout: 10_000 });
  assert.equal(existsSync(ledgerPath), true, 'completion must be persisted in the shared ledger');
  const firstLedger = await readFile(ledgerPath, 'utf8');
  const ledger = NotificationLedgerFileSchema.parse(JSON.parse(firstLedger));
  assert.equal(ledger.records.length, 1);
  assert.equal(ledger.records[0]?.sessionId, 'completion-session');
  assert.equal(ledger.records[0]?.assistantMessageId, 'answer');
  assert.equal(ledger.records[0]?.completionKey, 'completion-session:answer');
  assert.equal(ledger.records[0]?.state, 'sent');
  assert.equal(ledger.records[0]?.partCount, 1);
  assert.deepEqual(ledger.records[0]?.sentParts, [1]);
  const firstCalls = (await readFile(fixture.dwsArgsPath, 'utf8')).trim().split('\n');
  assert.deepEqual(firstCalls.map((call) => call.split(' ')[1]), [
    '+conversation-info', '+send-to-group', '+messages-query-send-status', '+conversation-info',
  ]);

  await exec(process.execPath, [driverPath], { env: environment, timeout: 10_000 });
  const callsAfterReload = (await readFile(fixture.dwsArgsPath, 'utf8')).trim().split('\n');
  assert.equal(callsAfterReload.filter((call) => call.split(' ')[1] === '+send-to-group').length, 1);
  assert.deepEqual(callsAfterReload.slice(firstCalls.length).map((call) => call.split(' ')[1]), [
    '+conversation-info', '+conversation-info',
  ]);
  assert.equal(await readFile(ledgerPath, 'utf8'), firstLedger);

  await runCli('notify', 'uninstall');
  assert.equal(existsSync(notificationPath), false);
  assert.equal(await readFile(quotaPath, 'utf8'), quotaSource);
  assert.equal(await readFile(foreignPath, 'utf8'), foreignSource);
  assert.equal(await readFile(ledgerPath, 'utf8'), firstLedger);

  await writeFile(notificationPath, foreignSource);
  await runCli('notify', 'install');
  assert.equal(await readFile(notificationPath, 'utf8'), foreignSource);
  await runCli('notify', 'uninstall');
  assert.equal(await readFile(notificationPath, 'utf8'), foreignSource);
  assert.equal(await readFile(quotaPath, 'utf8'), quotaSource);
  assert.equal(await readFile(foreignPath, 'utf8'), foreignSource);
});

test('isolated install-hook activation matches generator and adopts eligible auth', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'quotahot-plugin-integration-'));
  const configHome = join(root, 'config');
  const dataHome = join(root, 'data');
  const authPath = join(dataHome, 'opencode-auth.json');
  const statePath = join(dataHome, 'switch-state.json');
  const child = join(root, 'fixture-child');
  await mkdir(dataHome, { recursive: true });
  await writeFile(authPath, '{"access":"old"}\n');
  await writeFile(child, `#!/bin/sh
body=$(cat)
case "$body" in
  *all-unusable*) exit 0 ;;
  *) printf '%s\n' '{"access":"new"}' > ${JSON.stringify(authPath)}; printf '%s\n' '{"selected":"fixture-candidate"}' > ${JSON.stringify(statePath)} ;;
esac
  `);
  await chmod(child, 0o700);
  const syntheticClientRequest = async () => ({
    auth: JSON.parse(await readFile(authPath, 'utf8')),
    state: JSON.parse(await readFile(statePath, 'utf8')),
  });

  const originalArgv = process.argv[1];
  process.argv[1] = resolve('src/index.ts');
  const invocation = selfInvocation();
  if (originalArgv === undefined) delete process.argv[1];
  else process.argv[1] = originalArgv;
  const environment = { ...process.env, HOME: root, XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome, QUOTAHOT_DATA_DIR: dataHome };
  await exec(process.execPath, ['--import', import.meta.resolve('tsx'), resolve('src/index.ts'), 'install'], { cwd: process.cwd(), env: environment });
  const installedPath = join(configHome, 'opencode', 'plugin', 'quotahot.js');
  assert.equal(await readFile(installedPath, 'utf8'), opencodePlugin([...invocation, 'run', 'opencode']));

  const pluginPath = join(root, 'installed-plugin.mjs');
  await writeFile(pluginPath, opencodePlugin(child).replaceAll('process.env.QUOTAHOT_DATA_DIR ?? join(homedir(), ".quotahot")', JSON.stringify(dataHome)));
  const generated = await import(pluginPath);
  const { QuotaHot } = generated;
  assert.deepEqual(Object.keys(generated).sort(), ['QuotaHot', 'default']);
  assert.equal(generated.default.id, 'QuotaHot');
  assert.equal(generated.default.server, QuotaHot);
  const plugin = await generated.default.server({ client: { session: { messages: async () => [] } } });
  t.after(async () => { await plugin.dispose(); await rm(root, { recursive: true, force: true }); });
  await plugin.event({ event: { type: 'message.updated', properties: { info: { id: 'a', sessionID: 'eligible', role: 'assistant', providerID: 'openai', time: { created: 1 } } } } });
  await plugin.event({ event: { type: 'session.status', properties: { sessionID: 'eligible', status: { type: 'retry', message: 'quota_exhausted' } } } });
  assert.equal(await readFile(authPath, 'utf8'), '{"access":"new"}\n');
  assert.equal(await readFile(statePath, 'utf8'), '{"selected":"fixture-candidate"}\n');
  assert.deepEqual(await syntheticClientRequest(), {
    auth: { access: 'new' },
    state: { selected: 'fixture-candidate' },
  });

  await writeFile(authPath, '{"access":"stable"}\n');
  await plugin.event({ event: { type: 'message.updated', properties: { info: { id: 'b', sessionID: 'other', role: 'assistant', providerID: 'anthropic', time: { created: 2 } } } } });
  await plugin.event({ event: { type: 'session.status', properties: { sessionID: 'other', status: { type: 'retry', message: 'quota_exhausted' } } } });
  assert.equal(await readFile(authPath, 'utf8'), '{"access":"stable"}\n');

  await plugin.event({ event: { type: 'message.updated', properties: { info: { id: 'c', sessionID: 'unusable', role: 'assistant', providerID: 'openai', time: { created: 3 } } } } });
  await plugin.event({ event: { type: 'session.status', properties: { sessionID: 'unusable', status: { type: 'retry', message: 'all-unusable quota_exhausted' } } } });
  assert.equal(await readFile(authPath, 'utf8'), '{"access":"stable"}\n');
});

test('recovery-status command reads a waiting session published by the generated plugin', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'quotahot-recovery-status-e2e-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'quotahot-data');
  const child = join(root, 'no-candidate');
  await writeFile(child, '#!/bin/sh\ncat >/dev/null\nprintf \'{"outcome":"no_candidate"}\'\n', { mode: 0o700 });
  const pluginPath = join(root, 'plugin.mjs');
  await writeFile(pluginPath, opencodePlugin(child));
  const oldDataDir = process.env.QUOTAHOT_DATA_DIR;
  process.env.QUOTAHOT_DATA_DIR = dataDir;
  t.after(() => { if (oldDataDir === undefined) delete process.env.QUOTAHOT_DATA_DIR; else process.env.QUOTAHOT_DATA_DIR = oldDataDir; });
  const { QuotaHot } = await import(pluginPath);
  const plugin = await QuotaHot({ client: { session: { messages: async () => ({ data: [{ info: {
    id: 'assistant-1', sessionID: 'waiting-1', role: 'assistant', providerID: 'openai', time: { created: 1 },
  } }] }) } } });
  t.after(() => plugin.dispose());
  await plugin.event({ event: { type: 'message.updated', properties: { info: {
    id: 'assistant-1', sessionID: 'waiting-1', role: 'assistant', providerID: 'openai', time: { created: 1 },
  } } } });
  await plugin.event({ event: { type: 'session.error', properties: { sessionID: 'waiting-1', error: { status: 429 } } } });
  const stdout = await new Promise<string>((resolveOutput, rejectOutput) => {
    execFile(process.execPath, ['--import', import.meta.resolve('tsx'), resolve('src/index.ts'), 'recovery-status', '--json'], {
      cwd: process.cwd(), env: { ...process.env, QUOTAHOT_DATA_DIR: dataDir },
    }, (error, output) => error ? rejectOutput(error) : resolveOutput(output));
  });
  const status = JSON.parse(stdout);
  assert.equal(status.totalWaiting, 1);
  assert.deepEqual(status.instances[0].sessions, [{ sessionID: 'waiting-1', phase: 'waiting' }]);
});

test('generated plugin quota phrases drive the real OpenCode hook switch path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'quotahot-plugin-real-hook-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'quotahot-data');
  const accountsDir = join(dataDir, 'accounts');
  const dataHome = join(root, 'client-data');
  const authPath = join(dataHome, 'opencode', 'auth.json');
  const statePath = join(dataDir, 'switch-state.json');
  await mkdir(accountsDir, { recursive: true });
  await mkdir(join(dataHome, 'opencode'), { recursive: true });
  for (const email of ['a@x.com', 'b@x.com']) {
    await writeFile(join(accountsDir, `codex-${email}.json`), JSON.stringify({
      type: 'codex',
      email,
      account_id: `acct-${email}`,
      access_token: `token-${email}`,
      refresh_token: `refresh-${email}`,
      expired: new Date(Date.now() + 86_400_000).toISOString(),
      source: 'codex-cli',
      sync_source: 'codex-cli',
      auto_refresh: true,
    }));
  }
  const wrapper = join(root, 'real-hook');
  await writeFile(wrapper, `#!/bin/sh
export HOME=${JSON.stringify(root)}
export XDG_DATA_HOME=${JSON.stringify(dataHome)}
export QUOTAHOT_DATA_DIR=${JSON.stringify(dataDir)}
exec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(import.meta.resolve('tsx'))} ${JSON.stringify(resolve('src/index.ts'))} run opencode --no-check --min-interval-seconds 0
`);
  await chmod(wrapper, 0o700);
  const pluginPath = join(root, 'plugin.mjs');
  await writeFile(pluginPath, opencodePlugin(wrapper).replaceAll('process.env.QUOTAHOT_DATA_DIR ?? join(homedir(), ".quotahot")', JSON.stringify(dataDir)));
  const { QuotaHot } = await import(pluginPath);
  const plugin = await QuotaHot({ client: {} });

  for (const [index, phrase] of ['usage_limit_reached', 'quota_exceeded', 'quota has been exhausted'].entries()) {
    await rm(statePath, { force: true });
    await writeFile(authPath, JSON.stringify({ openai: { type: 'oauth', access: 'token-a@x.com' } }));
    const sessionID = `phrase-${index}`;
    await plugin.event({ event: { type: 'message.updated', properties: { info: {
      id: `message-${index}`, sessionID, role: 'assistant', providerID: 'openai', time: { created: index + 1 },
    } } } });
    await plugin.event({ event: { type: 'session.status', properties: {
      sessionID, status: { type: 'retry', message: phrase },
    } } });
    assert.equal(JSON.parse(await readFile(authPath, 'utf8')).openai.access, 'token-b@x.com', phrase);
  }
});

test('OpenCode quota event switches Codex CLI and existing Pi Codex without changing Pi Anthropic', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'quotahot-plugin-client-sync-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'quotahot-data');
  const dataHome = join(root, 'client-data');
  const piDir = join(root, 'pi-agent');
  const accountsDir = join(dataDir, 'accounts');
  const opencodePath = join(dataHome, 'opencode', 'auth.json');
  const codexPath = join(root, '.codex', 'auth.json');
  const piPath = join(piDir, 'auth.json');
  await mkdir(accountsDir, { recursive: true });
  await mkdir(join(dataHome, 'opencode'), { recursive: true });
  await mkdir(join(root, '.codex'), { recursive: true });
  await mkdir(piDir, { recursive: true });
  for (const email of ['a@x.com', 'b@x.com']) {
    await writeFile(join(accountsDir, `codex-${email}.json`), JSON.stringify({
      type: 'codex', email, account_id: `acct-${email}`, access_token: `token-${email}`,
      refresh_token: `refresh-${email}`, expired: new Date(Date.now() + 86_400_000).toISOString(),
      source: 'codex-cli', sync_source: 'codex-cli', auto_refresh: true,
    }));
  }
  const anthropic = { type: 'oauth', access: 'anthropic-token', refresh: 'anthropic-refresh', expires: 123 };
  await writeFile(opencodePath, JSON.stringify({ openai: { type: 'oauth', access: 'token-a@x.com' } }));
  await writeFile(codexPath, JSON.stringify({ tokens: { access_token: 'token-a@x.com', account_id: 'acct-a@x.com' } }));
  await writeFile(piPath, JSON.stringify({
    'openai-codex': { type: 'oauth', access: 'token-a@x.com', refresh: 'refresh-a@x.com', expires: 123, accountId: 'acct-a@x.com' },
    anthropic,
  }));

  const wrapper = join(root, 'real-hook');
  await writeFile(wrapper, `#!/bin/sh
export HOME=${JSON.stringify(root)}
export XDG_DATA_HOME=${JSON.stringify(dataHome)}
export QUOTAHOT_DATA_DIR=${JSON.stringify(dataDir)}
export PI_CODING_AGENT_DIR=${JSON.stringify(piDir)}
exec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(import.meta.resolve('tsx'))} ${JSON.stringify(resolve('src/index.ts'))} run opencode --no-check --min-interval-seconds 0
`);
  await chmod(wrapper, 0o700);
  const pluginPath = join(root, 'plugin.mjs');
  await writeFile(pluginPath, opencodePlugin(wrapper).replaceAll('process.env.QUOTAHOT_DATA_DIR ?? join(homedir(), ".quotahot")', JSON.stringify(dataDir)));
  const { QuotaHot } = await import(pluginPath);
  const plugin = await QuotaHot({ client: {} });

  await plugin.event({ event: { type: 'message.updated', properties: { info: {
    id: 'quota-message', sessionID: 'quota-session', role: 'assistant', providerID: 'openai', time: { created: 1 },
  } } } });
  await plugin.event({ event: { type: 'session.status', properties: {
    sessionID: 'quota-session', status: { type: 'retry', message: 'quota_exhausted' },
  } } });

  assert.equal(JSON.parse(await readFile(opencodePath, 'utf8')).openai.access, 'token-b@x.com');
  assert.equal(JSON.parse(await readFile(codexPath, 'utf8')).tokens.access_token, 'token-b@x.com');
  const piAuth = JSON.parse(await readFile(piPath, 'utf8'));
  assert.equal(piAuth['openai-codex'].access, 'token-b@x.com');
  assert.deepEqual(piAuth.anthropic, anthropic);
});
