import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TestContext } from 'node:test';

export type NotificationCliFixture = {
  readonly home: string;
  readonly dataDir: string;
  readonly binDir: string;
  readonly dwsArgsPath: string;
};

export async function createNotificationCliFixture(context: TestContext): Promise<NotificationCliFixture> {
  const home = await mkdtemp(join(tmpdir(), 'quotahot-notification-cli-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const binDir = join(home, 'bin');
  const dataDir = join(home, 'data');
  const dwsArgsPath = join(home, 'dws-args');
  const dwsPath = join(binDir, 'dws');
  await mkdir(binDir, { recursive: true });
  await writeFile(dwsPath, `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(dwsArgsPath)}
case "$2" in
  +conversation-info) printf '%s' '{"success":true,"result":{"conversationInfo":{"openConversationId":"conversation-1","title":"Test group","singleChat":false}}}' ;;
  +send-to-group) printf '%s' '{"success":true,"result":{"openTaskId":"task-1"}}' ;;
  +messages-query-send-status) printf '%s' '{"success":true,"openTaskId":"task-1","result":{"openConversationId":"conversation-1","openMessageId":"message-1","sendStatus":"SUCCESS"}}' ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
  await chmod(dwsPath, 0o700);
  return { home, dataDir, binDir, dwsArgsPath };
}

export function runNotificationCliResult(fixture: NotificationCliFixture, args: readonly string[], input?: string) {
  return spawnSync(process.execPath, [
    '--import',
    import.meta.resolve('tsx'),
    resolve('src/index.ts'),
    ...args,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: fixture.home,
      QUOTAHOT_DATA_DIR: fixture.dataDir,
      PATH: `${fixture.binDir}:${process.env.PATH ?? ''}`,
    },
    encoding: 'utf8',
    input,
    timeout: 10_000,
  });
}

export function runNotificationCli(fixture: NotificationCliFixture, args: readonly string[], input?: string): string {
  const result = runNotificationCliResult(fixture, args, input);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('CLI 命令未成功');
  return result.stdout;
}
