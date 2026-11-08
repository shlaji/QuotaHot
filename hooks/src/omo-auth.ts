import { randomUUID } from 'node:crypto';
import { copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { accountIdOf } from './account-files.js';
import type { Account, ConfigChange, SyncResult } from './types.js';

const oauthFields = {
  access: z.string().min(1),
  refresh: z.string().min(1),
  expires: z.number().finite().positive(),
  accountId: z.string().min(1),
};
const slotSchema = z.looseObject({ name: z.string().min(1), ...oauthFields });
export const omoAuthSchema = z.looseObject({
  'chatgpt-subscription': z.looseObject({
    type: z.literal('oauth'), ...oauthFields,
    accounts: z.array(slotSchema).length(1).optional(),
  }),
});

export async function syncOmo(account: Account, path: string, label: string): Promise<SyncResult> {
  const base = { path, source: 'omo-agent', label, created: false, backupPath: '', warning: '' };
  if (!account.accessToken || !account.refreshToken || !account.accountId || !Number.isFinite(account.expiresAt) || account.expiresAt <= 0
    || [account.idToken, account.accessToken].some((token) => accountIdOf(token) && accountIdOf(token) !== account.accountId)) {
    return { ...base, changes: [], error: 'Incomplete OmO OAuth credentials' };
  }
  try {
    const release = await lockfile.lock(path, { realpath: false, stale: 30_000, update: 10_000, retries: { retries: 5, factor: 1, minTimeout: 100, maxTimeout: 100 } });
    try {
      const parsed = omoAuthSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
      if (!parsed.success) return { ...base, changes: [], error: 'OmO requires one complete OAuth credential; native account pools are not overwritten' };
      const data = parsed.data;
      const record = data['chatgpt-subscription'];
      const changes: ConfigChange[] = [];
      const credentials = [
        { value: record, prefix: 'chatgpt-subscription' },
        ...(record.accounts ?? []).map((value) => ({ value, prefix: 'chatgpt-subscription.accounts[0]' })),
      ];
      for (const { value, prefix } of credentials) {
        if (value.accountId !== account.accountId) {
          for (const field of ['route', 'issuer', 'subject', 'clientId', 'scopes', 'planUsageEnabled', 'signedOut', 'displayName']) {
            delete value[field];
          }
          value.email = account.email;
          if (account.idToken) value.idToken = account.idToken;
          else delete value.idToken;
        }
        for (const [key, replacement] of [['access', account.accessToken], ['refresh', account.refreshToken],
          ['expires', account.expiresAt], ['accountId', account.accountId]] as const) {
          const before = value[key];
          if (before === replacement) continue;
          const secret = key === 'access' || key === 'refresh';
          changes.push({
            field: `${prefix}.${key}`,
            before: secret ? '[redacted]' : String(before),
            after: secret ? '[redacted]' : String(replacement),
          });
        }
        Object.assign(value, { access: account.accessToken, refresh: account.refreshToken, expires: account.expiresAt, accountId: account.accountId });
      }
      if (changes.length === 0) return { ...base, changes, error: '' };
      const backupPath = `${path}.quotahot-bak`;
      await copyFile(path, backupPath);
      const temporary = `${path}.quotahot-tmp-${randomUUID()}`;
      try {
        await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
      return { ...base, backupPath, changes, error: '' };
    } finally {
      await release();
    }
  } catch (error) {
    return { ...base, changes: [], error: error instanceof Error ? error.message : String(error) };
  }
}
