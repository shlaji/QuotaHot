import { homedir } from 'node:os';
import { join } from 'node:path';
import { clientPath } from './clientpaths.js';
import type { QoderClient } from '../shared/qoder.js';

export const QODER_CLIENTS: readonly QoderClient[] = ['qoder-cli', 'qoder-desktop', 'qoder-ide'];
export const QODER_LABELS: Readonly<Record<QoderClient, string>> = {
  'qoder-cli': 'Qoder CLI',
  'qoder-desktop': 'Qoder 桌面端',
  'qoder-ide': 'Qoder IDE',
};

/** 三个 Qoder 客户端各自的凭证位置；默认值和用户的覆盖值都在 clientpaths.ts 里。 */
export function qoderClientPath(client: QoderClient): string {
  return clientPath(client);
}

export function qoderExecutable(client: QoderClient): string {
  switch (client) {
    case 'qoder-cli': return join(homedir(), '.local', 'bin', 'qodercli');
    case 'qoder-desktop': return '/opt/Qoder/qoder';
    case 'qoder-ide': return '/usr/share/qoder-ide/qoder-ide';
  }
}
