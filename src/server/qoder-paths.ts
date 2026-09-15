import { homedir } from 'node:os';
import { join } from 'node:path';
import { qoderStateDbPath } from './qoder.js';
import type { QoderClient } from '../shared/qoder.js';

export const QODER_CLIENTS: readonly QoderClient[] = ['qoder-cli', 'qoder-desktop', 'qoder-ide'];
export const QODER_LABELS: Readonly<Record<QoderClient, string>> = {
  'qoder-cli': 'Qoder CLI',
  'qoder-desktop': 'Qoder 桌面端',
  'qoder-ide': 'Qoder IDE',
};

export function qoderClientPath(client: QoderClient): string {
  switch (client) {
    case 'qoder-cli': return join(process.env.QODER_CONFIG_DIR || join(homedir(), '.qoder'), '.auth', 'user');
    case 'qoder-desktop': return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'com.qoder.app.stable', 'auth.v1.dat');
    case 'qoder-ide': return qoderStateDbPath();
  }
}

export function qoderExecutable(client: QoderClient): string {
  switch (client) {
    case 'qoder-cli': return join(homedir(), '.local', 'bin', 'qodercli');
    case 'qoder-desktop': return '/opt/Qoder/qoder';
    case 'qoder-ide': return '/usr/share/qoder-ide/qoder-ide';
  }
}
