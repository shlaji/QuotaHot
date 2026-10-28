import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readNotificationConfig, saveNotificationConfig } from '../src/notification-config.js';
import { createNotificationCliFixture, runNotificationCli, runNotificationCliResult } from './notification-cli-fixture.js';

test('missing notification config is disabled by default', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-notification-config-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));

  const config = await readNotificationConfig(dataDir);

  assert.deepEqual(config, { version: 1, enabled: false, target: null, authorizedAt: null });
});

test('saving an enabled notification config persists the exact verified target', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-notification-config-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const input = {
    version: 1,
    enabled: true,
    target: { openConversationId: 'conversation-1', displayName: 'Test group' },
    authorizedAt: '2026-10-22T10:00:00.000Z',
  };

  const saved = await saveNotificationConfig(dataDir, input);
  const loaded = await readNotificationConfig(dataDir);

  assert.deepEqual(saved, input);
  assert.deepEqual(loaded, input);
});

test('invalid enabled config is rejected instead of being persisted', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'quotahot-notification-config-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));

  await assert.rejects(saveNotificationConfig(dataDir, {
    version: 1,
    enabled: true,
    target: null,
    authorizedAt: null,
  }));
});

test('notify configure verifies and displays the target without enabling automatic sends', async (context) => {
  const fixture = await createNotificationCliFixture(context);

  const output = JSON.parse(runNotificationCli(fixture, ['notify', 'configure', '--group', 'conversation-1', '--json']));
  const config = await readNotificationConfig(fixture.dataDir);
  const args = await readFile(fixture.dwsArgsPath, 'utf8');

  assert.equal(output.target.displayName, 'Test group');
  assert.equal(config.enabled, false);
  assert.equal(config.target?.openConversationId, 'conversation-1');
  assert.equal(args.trim(), 'chat +conversation-info --group conversation-1 --format json');
});

test('notify enable requires the explicit yes flag and persists authorization', async (context) => {
  const fixture = await createNotificationCliFixture(context);
  await saveNotificationConfig(fixture.dataDir, {
    version: 1,
    enabled: false,
    target: { openConversationId: 'conversation-1', displayName: 'Test group' },
    authorizedAt: null,
  });

  const output = JSON.parse(runNotificationCli(fixture, ['notify', 'enable', '--yes', '--json']));
  const config = await readNotificationConfig(fixture.dataDir);

  assert.equal(output.enabled, true);
  assert.equal(config.enabled, true);
  assert.equal(config.authorizedAt !== null, true);
});

test('notify disable prevents further automatic sends while retaining target identity', async (context) => {
  const fixture = await createNotificationCliFixture(context);
  await saveNotificationConfig(fixture.dataDir, {
    version: 1,
    enabled: true,
    target: { openConversationId: 'conversation-1', displayName: 'Test group' },
    authorizedAt: '2026-10-22T10:00:00.000Z',
  });

  const output = JSON.parse(runNotificationCli(fixture, ['notify', 'disable', '--json']));
  const config = await readNotificationConfig(fixture.dataDir);

  assert.equal(output.enabled, false);
  assert.equal(config.enabled, false);
  assert.equal(config.target?.openConversationId, 'conversation-1');
});

test('notify configure usage errors exit before DWS or config side effects', async (context) => {
  const fixture = await createNotificationCliFixture(context);

  const result = runNotificationCliResult(fixture, ['notify', 'configure', '--json']);
  const config = await readNotificationConfig(fixture.dataDir);

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(existsSync(fixture.dwsArgsPath), false);
  assert.equal(config.enabled, false);
});

test('notify enable without yes exits without changing disabled authorization', async (context) => {
  const fixture = await createNotificationCliFixture(context);
  const disabled = {
    version: 1,
    enabled: false,
    target: { openConversationId: 'conversation-1', displayName: 'Test group' },
    authorizedAt: null,
  } as const;
  await saveNotificationConfig(fixture.dataDir, disabled);

  const result = runNotificationCliResult(fixture, ['notify', 'enable', '--json']);
  const config = await readNotificationConfig(fixture.dataDir);

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.deepEqual(config, disabled);
});

test('notify status reports the missing-config disabled state as JSON', async (context) => {
  const fixture = await createNotificationCliFixture(context);

  const output = JSON.parse(runNotificationCli(fixture, ['notify', 'status', '--json']));

  assert.deepEqual(output, { version: 1, enabled: false, target: null, authorizedAt: null });
});

test('notify install preview does not write plugin files', async (context) => {
  const fixture = await createNotificationCliFixture(context);
  const preview = runNotificationCli(fixture, ['notify', 'install', '--print']);

  assert.match(preview, /quotahot-session-notify\.js/);
  assert.equal(existsSync(join(fixture.home, '.config', 'opencode', 'plugin', 'quotahot-session-notify.js')), false);
});

test('notify install and uninstall preserve the quota plugin and foreign plugin files', async (context) => {
  const fixture = await createNotificationCliFixture(context);
  const pluginDirectory = join(fixture.home, '.config', 'opencode', 'plugin');
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(join(pluginDirectory, 'quotahot.js'), 'quota-plugin-owned-by-existing-installer\n');
  await writeFile(join(pluginDirectory, 'foreign.js'), 'foreign-plugin\n');

  runNotificationCli(fixture, ['notify', 'install']);
  const installedNotification = await readFile(join(pluginDirectory, 'quotahot-session-notify.js'), 'utf8');
  runNotificationCli(fixture, ['notify', 'uninstall']);

  assert.match(installedNotification, /quotahot-session-notify:start/);
  assert.equal(await readFile(join(pluginDirectory, 'quotahot.js'), 'utf8'), 'quota-plugin-owned-by-existing-installer\n');
  assert.equal(await readFile(join(pluginDirectory, 'foreign.js'), 'utf8'), 'foreign-plugin\n');
  assert.equal(existsSync(join(pluginDirectory, 'quotahot-session-notify.js')), false);
});
