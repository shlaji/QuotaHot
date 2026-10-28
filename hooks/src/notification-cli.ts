import { createHash } from 'node:crypto';
import { DATA_DIR } from './config.js';
import { UsageError, type Flags } from './cli-types.js';
import { installNotificationOpencode, opencodeNotificationPluginPath, selfInvocation, uninstallNotificationOpencode } from './install.js';
import { opencodeNotificationPlugin } from './opencode-plugin.js';
import { readNotificationConfig, saveNotificationConfig } from './notification-config.js';
import { claimNotification, saveNotificationRecord } from './notification-ledger.js';
import { CompletionKeySchema, NotificationCompletionLedgerSchema, NotificationDigestSchema, NotificationSessionSendInputSchema } from './notification-schema.js';
import { sendNotificationChunks, splitNotificationContent } from './notification-delivery.js';
import { selectFinalAssistantMessage } from './notification-message.js';
import { resolveNotificationTarget } from './notification-target.js';

function notificationStatusLine(config: Awaited<ReturnType<typeof readNotificationConfig>>): string {
  if (config.target === null) return '会话通知：未配置目标，未启用';
  return `会话通知：${config.enabled ? '已启用' : '已停用'} · ${config.target.displayName} · ${config.target.openConversationId}`;
}

async function readNotificationSendInput(): Promise<unknown> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function printNotificationResult(result: { readonly state: string; readonly reason?: string; readonly sentParts?: readonly number[] }, json: boolean): void {
  if (json) console.log(JSON.stringify(result));
  else console.log(`会话通知结果：${result.state}${result.reason ? `；${result.reason}` : ''}`);
}

async function sendSessionNotification(flags: Flags): Promise<number> {
  if (flags.values.group !== undefined || flags.bools.has('group') || flags.bools.has('yes')) {
    throw new UsageError('notify send-session 不接受 --group 或 --yes');
  }
  const parsedInput = NotificationSessionSendInputSchema.safeParse(await readNotificationSendInput());
  if (!parsedInput.success) {
    printNotificationResult({ state: 'skipped', reason: 'OpenCode 通知载荷无效' }, flags.bools.has('json'));
    return 0;
  }
  const selectedMessage = selectFinalAssistantMessage(parsedInput.data.sessionId, parsedInput.data.messages);
  if (selectedMessage.kind === 'skipped') {
    printNotificationResult({ state: 'skipped', reason: selectedMessage.reason }, flags.bools.has('json'));
    return 0;
  }
  const input = selectedMessage.payload;
  const config = await readNotificationConfig(DATA_DIR);
  if (!config.enabled || config.target === null) {
    printNotificationResult({ state: 'skipped', reason: '会话通知未启用或未配置目标群' }, flags.bools.has('json'));
    return 0;
  }

  const resolution = await resolveNotificationTarget(config.target.openConversationId);
  if (resolution.kind !== 'verified') {
    printNotificationResult({ state: 'failed', reason: '无法核验已配置的通知群' }, flags.bools.has('json'));
    return 0;
  }

  const partCount = splitNotificationContent(input.content).length;
  if (partCount === 0) {
    printNotificationResult({ state: 'skipped', reason: '最终消息没有可发送文本' }, flags.bools.has('json'));
    return 0;
  }
  const completionKey = CompletionKeySchema.parse(`${input.sessionId}:${input.assistantMessageId}`);
  const messageDigest = NotificationDigestSchema.parse(createHash('sha256').update(input.content).digest('hex'));
  const claim = await claimNotification(DATA_DIR, NotificationCompletionLedgerSchema.parse({
    sessionId: input.sessionId,
    assistantMessageId: input.assistantMessageId,
    completionKey,
    messageDigest,
    ownerPid: process.pid,
    partCount,
    state: 'in_progress',
    sentParts: [],
    updatedAt: new Date().toISOString(),
  }));
  if (claim.kind === 'existing') {
    printNotificationResult({
      state: claim.record.state === 'in_progress' ? 'unknown' : claim.record.state,
      sentParts: claim.record.sentParts,
      reason: '该完成消息已有投递记录，不会重复发送',
    }, flags.bools.has('json'));
    return 0;
  }

  const delivery = await sendNotificationChunks({ target: resolution.target, content: input.content });
  const finalState = delivery.state === 'skipped' ? 'failed' : delivery.state;
  const finalRecord = NotificationCompletionLedgerSchema.parse({
    ...claim.record,
    state: finalState,
    sentParts: delivery.sentParts,
    updatedAt: new Date().toISOString(),
    ...(delivery.state === 'sent' ? {} : { reason: delivery.reason }),
  });
  await saveNotificationRecord(DATA_DIR, finalRecord);
  printNotificationResult(delivery, flags.bools.has('json'));
  return 0;
}

export async function notify(flags: Flags): Promise<number> {
  const [action] = flags.positional;
  if (flags.positional.length !== 1) throw new UsageError('notify 需要且只接受一个子命令');

  if (action === 'send-session') return await sendSessionNotification(flags);

  if (action === 'install') {
    if (flags.values.group !== undefined || flags.bools.has('group') || flags.bools.has('yes') || flags.bools.has('json')) {
      throw new UsageError('notify install 只接受 --print');
    }
    if (flags.bools.has('print')) {
      const path = await opencodeNotificationPluginPath();
      console.log(`# ${path}\n${opencodeNotificationPlugin(selfInvocation())}`);
      return 0;
    }
    for (const change of (await installNotificationOpencode(selfInvocation())).changes) console.log(change);
    return 0;
  }

  if (action === 'uninstall') {
    if (flags.values.group !== undefined || flags.bools.has('group') || flags.bools.has('yes') || flags.bools.has('json') || flags.bools.has('print')) {
      throw new UsageError('notify uninstall 不接受选项');
    }
    for (const change of (await uninstallNotificationOpencode()).changes) console.log(change);
    return 0;
  }

  if (action === 'install') {
    if (flags.values.group !== undefined || flags.bools.has('group') || flags.bools.has('yes') || flags.bools.has('json')) {
      throw new UsageError('notify install 只接受 --print');
    }
    if (flags.bools.has('print')) {
      const path = await opencodeNotificationPluginPath();
      console.log(`# ${path}\n${opencodeNotificationPlugin(selfInvocation())}`);
      return 0;
    }
    for (const change of (await installNotificationOpencode(selfInvocation())).changes) console.log(change);
    return 0;
  }

  if (action === 'uninstall') {
    if (flags.values.group !== undefined || flags.bools.has('group') || flags.bools.has('yes') || flags.bools.has('json') || flags.bools.has('print')) {
      throw new UsageError('notify uninstall 不接受选项');
    }
    for (const change of (await uninstallNotificationOpencode()).changes) console.log(change);
    return 0;
  }

  if (action === 'configure') {
    const group = flags.values.group;
    if (group === undefined || flags.bools.has('group')) throw new UsageError('notify configure 需要 --group <openConversationId>');
    if (flags.bools.has('yes')) throw new UsageError('notify configure 不接受 --yes；启用自动发送请另行运行 notify enable --yes');
    const resolution = await resolveNotificationTarget(group);
    if (resolution.kind !== 'verified') throw new UsageError(`无法核验通知群：${resolution.reason}`);
    const config = await saveNotificationConfig(DATA_DIR, {
      version: 1,
      enabled: false,
      target: resolution.target,
      authorizedAt: null,
    });
    if (flags.bools.has('json')) console.log(JSON.stringify(config, null, 2));
    else console.log(`${notificationStatusLine(config)}；未来会话自动发送尚未启用`);
    return 0;
  }

  if (action === 'enable') {
    if (flags.values.group !== undefined || flags.bools.has('group')) throw new UsageError('notify enable 不接受 --group');
    if (!flags.bools.has('yes')) throw new UsageError('持续自动发送需要明确确认：notify enable --yes');
    const current = await readNotificationConfig(DATA_DIR);
    if (current.target === null) throw new UsageError('尚未配置并核验通知群；请先运行 notify configure --group <openConversationId>');
    const config = await saveNotificationConfig(DATA_DIR, {
      version: 1,
      enabled: true,
      target: current.target,
      authorizedAt: new Date().toISOString(),
    });
    if (flags.bools.has('json')) console.log(JSON.stringify(config, null, 2));
    else console.log(`${notificationStatusLine(config)}；持续自动发送已获授权`);
    return 0;
  }

  if (action === 'disable') {
    if (flags.values.group !== undefined || flags.bools.has('group') || flags.bools.has('yes')) {
      throw new UsageError('notify disable 不接受 --group 或 --yes');
    }
    const current = await readNotificationConfig(DATA_DIR);
    const config = current.target === null
      ? current
      : await saveNotificationConfig(DATA_DIR, {
        version: 1,
        enabled: false,
        target: current.target,
        authorizedAt: current.authorizedAt,
      });
    if (flags.bools.has('json')) console.log(JSON.stringify(config, null, 2));
    else console.log(notificationStatusLine(config));
    return 0;
  }

  if (action === 'status') {
    if (flags.values.group !== undefined || flags.bools.has('group') || flags.bools.has('yes')) {
      throw new UsageError('notify status 不接受 --group 或 --yes');
    }
    const config = await readNotificationConfig(DATA_DIR);
    if (flags.bools.has('json')) console.log(JSON.stringify(config, null, 2));
    else console.log(notificationStatusLine(config));
    return 0;
  }

  throw new UsageError(`未知通知子命令：${action ?? '(missing)'}`);
}
