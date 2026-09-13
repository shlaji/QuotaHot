import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { opencodePlugin, selfInvocation } from '../src/install.js';

const exec = promisify(execFile);

test('isolated install-hook activation matches generator and adopts eligible auth', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'quotahot-plugin-integration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
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
  await exec(process.execPath, ['--import', import.meta.resolve('tsx'), resolve('src/index.ts'), 'install', 'opencode'], { cwd: process.cwd(), env: environment });
  const installedPath = join(configHome, 'opencode', 'plugin', 'quotahot.js');
  assert.equal(await readFile(installedPath, 'utf8'), opencodePlugin([...invocation, 'run', 'opencode']));

  const pluginPath = join(root, 'installed-plugin.mjs');
  await writeFile(pluginPath, opencodePlugin(child));
  const generated = await import(pluginPath);
  const { QuotaHot } = generated;
  assert.deepEqual(Object.keys(generated).sort(), ['QuotaHot', 'default']);
  assert.equal(generated.default.id, 'QuotaHot');
  assert.equal(generated.default.server, QuotaHot);
  const plugin = await generated.default.server({ client: { session: { messages: async () => [] } } });
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
exec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(import.meta.resolve('tsx'))} ${JSON.stringify(resolve('src/index.ts'))} run opencode --no-check --min-interval-seconds 0 --client opencode
`);
  await chmod(wrapper, 0o700);
  const pluginPath = join(root, 'plugin.mjs');
  await writeFile(pluginPath, opencodePlugin(wrapper));
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
    assert.equal(JSON.parse(await readFile(authPath, 'utf8')).openai.access, 'token-b@x.com');
  }
});
