import { access, chmod, lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadAccounts, type Account } from './creds.js';
import { withCredentialLock } from './credential-lock.js';
import { captureQoderSession, describeQoderPayload, qoderHost, readQoderPayload, restoreQoderSession, writeQoderPayload } from './qoder-native.js';
import { QODER_CLIENTS, QODER_LABELS } from './qoder-paths.js';
import { qoderProcesses, type QoderProcesses } from './qoder-process.js';
import { QoderWriteConflict, readQoderSessions, record, writePrivateFile, type QoderSession } from './qoder-session.js';
import type { QoderClient, QoderClientTarget, QoderSwitchResult } from '../shared/qoder.js';

async function rememberSession(account: Account, session: QoderSession, active = false): Promise<void> {
  await withCredentialLock(account.path, async () => {
    const data: unknown = JSON.parse(await readFile(account.path, 'utf8'));
    if (!record(data) || data.user_id !== session.userId) throw new Error('保存客户端会话时账户身份发生变化');
    const sessions = record(data.qoder_sessions) ? data.qoder_sessions : {};
    const profile = describeQoderPayload(session.client, session.payload, session.path);
    const credentials = active || data.sync_source === session.client ? {
      access_token: profile.accessToken, refresh_token: profile.refreshToken, expired: new Date(profile.expiresAt).toISOString(),
      sync_source: session.client, sync_path: session.path, auto_refresh: false,
    } : {};
    await writePrivateFile(account.path, JSON.stringify({ ...data, ...credentials, qoder_sessions: { ...sessions, [session.client]: session } }, null, 2));
  });
}

export async function qoderTargets(account: Account): Promise<QoderClientTarget[]> {
  if (account.provider !== 'qoder') throw new Error('只有 Qoder 账户支持此操作');
  const sessions = await readQoderSessions(account.path);
  return Promise.all(QODER_CLIENTS.map(async (client) => {
    const session = sessions[client];
    const base = { client, label: QODER_LABELS[client], path: session?.path ?? '', current: false };
    if (!session) return { ...base, available: false, reason: '请先从这个客户端导入该账户；三端登录会话不能互换' };
    try {
      if (process.platform !== 'linux') throw new Error('目前仅支持 Linux');
      if (session.host !== await qoderHost()) throw new Error('快照不是来自本机当前用户，请重新导入');
      const profile = describeQoderPayload(client, session.payload, session.path);
      if (profile.userId !== account.userId || profile.userId !== session.userId) throw new Error('快照身份与账户不一致');
      await access(session.path);
      let current = false;
      try { current = (await captureQoderSession(client, session.path)).userId === account.userId; }
      catch (error) { if (!(error instanceof Error)) throw error; }
      return { ...base, current, available: true, reason: '' };
    } catch (error) {
      return { ...base, available: false, reason: error instanceof Error ? error.message : '无法读取认证快照' };
    }
  }));
}

export async function switchQoderAccount(account: Account, client: QoderClient, processes: QoderProcesses = qoderProcesses): Promise<QoderSwitchResult> {
  if (account.provider !== 'qoder' || account.disabled) throw new Error('账户不支持切换或已被禁用');
  const initial = (await readQoderSessions(account.path))[client];
  if (!initial) throw new Error('请先从目标客户端导入此账户');
  await processes.preflight(client, initial.path);
  return withCredentialLock(initial.path, async () => {
    const session = (await readQoderSessions(account.path))[client];
    if (!session || session.path !== initial.path) throw new Error('认证快照已变化，请重新打开切换窗口');
    if (session.host !== await qoderHost()) throw new Error('不能使用其他机器或用户的认证快照');
    const profile = describeQoderPayload(client, session.payload, session.path);
    if (profile.userId !== account.userId || profile.userId !== session.userId) throw new Error('认证快照与目标账户不一致');
    await processes.preflight(client, session.path);
    const targetStat = await lstat(session.path);
    if (!targetStat.isFile() || targetStat.uid !== process.getuid?.()) throw new Error('认证文件不是当前用户拥有的普通文件');
    const backupDir = join(dirname(account.path), '.qoder-backups');
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    const backupStat = await lstat(backupDir);
    if (!backupStat.isDirectory() || backupStat.uid !== process.getuid?.()) throw new Error('备份目录不安全');
    await chmod(backupDir, 0o700);
    const backupPath = join(backupDir, `${client}-${createHash('sha256').update(session.path).digest('hex').slice(0, 16)}.json`);
    const wasRunning = await processes.stop(client);
    let before: string | undefined;
    let changed = false;
    try {
      before = await readQoderPayload(client, session.path);
      const previousProfile = describeQoderPayload(client, before, session.path);
      const previous = { ...session, payload: before, userId: previousProfile.userId, email: previousProfile.email };
      await writePrivateFile(backupPath, JSON.stringify({ client, path: session.path, host: session.host, payload: before }));
      const owner = (await loadAccounts(dirname(account.path))).find((candidate) => candidate.provider === 'qoder' && candidate.userId === previous.userId);
      if (owner) await rememberSession(owner, previous);
      const selected = previous.userId === account.userId ? previous : session;
      await processes.assertStopped?.(client);
      if (await readQoderPayload(client, session.path) !== before) throw new Error('凭证在切换期间发生变化，拒绝覆盖');
      changed = true;
      await restoreQoderSession(selected, session.path, before);
      const applied = await captureQoderSession(client, session.path);
      if (applied.userId !== account.userId) throw new Error('写入后的客户端身份校验失败');
      if (wasRunning) await processes.start(client);
      const final = await captureQoderSession(client, session.path);
      if (final.userId !== account.userId) throw new Error('重启后客户端身份与目标账户不一致');
      await rememberSession(account, final.session, true);
      return { client, label: QODER_LABELS[client], accountId: account.id, backupPath, restarted: wasRunning,
        note: client === 'qoder-cli' ? '凭证已切换。请启动新的 CLI 会话，并确保终端未设置 QODER_PERSONAL_ACCESS_TOKEN。' : `${wasRunning ? '已重启客户端' : '客户端原本未运行，下次启动生效'}，已核对本地登录身份；若服务端拒绝旧会话，请在客户端重新登录后导入。` };
    } catch (error) {
      if (error instanceof QoderWriteConflict) changed = false;
      try {
        if (changed && before !== undefined) {
          await processes.stop(client);
          await writeQoderPayload(client, session.path, before);
        }
        if (wasRunning) await processes.start(client);
      } catch {
        throw new Error(`切换未完成，自动恢复失败。请关闭客户端并从备份恢复：${backupPath}`);
      }
      throw new Error(`切换失败，${changed ? '已恢复原认证' : '未修改认证'}。${error instanceof Error ? error.message : '客户端操作失败'}`);
    }
  });
}
