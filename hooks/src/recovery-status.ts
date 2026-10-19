import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.js';

const MAX_BYTES = 64 * 1024;
const STALE_AFTER_MS = 180_000;

export type RecoveryPhase = 'waiting' | 'checking' | 'ready';

export type RecoverySession = {
  readonly sessionID: string;
  readonly phase: RecoveryPhase;
};

export type RecoveryInstance = {
  readonly version: 1;
  readonly id: string;
  readonly pid: number;
  readonly updatedAt: number;
  readonly phase: RecoveryPhase;
  readonly waitingCount: number;
  readonly sessions: readonly RecoverySession[];
  readonly nextCheckAt: number | null;
  readonly lastCheckedAt: number | null;
  readonly lastOutcome: string | null;
  readonly stale: boolean;
};

export type RecoveryStatus = {
  readonly instances: readonly RecoveryInstance[];
  readonly totalWaiting: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPhase(value: unknown): value is RecoveryPhase {
  return value === 'waiting' || value === 'checking' || value === 'ready';
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseInstance(value: unknown, now: number): RecoveryInstance | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.id !== 'string' || !value.id ||
      !Number.isSafeInteger(value.pid) || typeof value.pid !== 'number' || value.pid <= 0 ||
      !isTimestamp(value.updatedAt) || !isPhase(value.phase) ||
      !isTimestamp(value.waitingCount) || !Array.isArray(value.sessions) ||
      !(value.nextCheckAt === null || isTimestamp(value.nextCheckAt)) ||
      !(value.lastCheckedAt === null || isTimestamp(value.lastCheckedAt)) ||
      !(value.lastOutcome === null || typeof value.lastOutcome === 'string')) return null;

  const sessions: RecoverySession[] = [];
  for (const session of value.sessions) {
    if (!isRecord(session) || typeof session.sessionID !== 'string' || !session.sessionID ||
        !isPhase(session.phase)) return null;
    sessions.push({ sessionID: session.sessionID, phase: session.phase });
  }
  return {
    version: 1,
    id: value.id,
    pid: value.pid,
    updatedAt: value.updatedAt,
    phase: value.phase,
    waitingCount: value.waitingCount,
    sessions,
    nextCheckAt: value.nextCheckAt,
    lastCheckedAt: value.lastCheckedAt,
    lastOutcome: value.lastOutcome,
    stale: now - value.updatedAt > STALE_AFTER_MS,
  };
}

export function readRecoveryStatus(dataDir: string = DATA_DIR): RecoveryStatus {
  const directory = join(dataDir, 'recovery-status');
  const instances: RecoveryInstance[] = [];
  let filenames: string[];
  try {
    if (!lstatSync(directory).isDirectory()) return { instances, totalWaiting: 0 };
    filenames = readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return { instances, totalWaiting: 0 };
  }

  const now = Date.now();
  for (const filename of filenames) {
    const path = join(directory, filename);
    try {
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.size > MAX_BYTES) continue;
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const openedMetadata = fstatSync(fd, { bigint: true });
        if (!openedMetadata.isFile()) continue;
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_BYTES) continue;
        const readMetadata = fstatSync(fd, { bigint: true });
        if (openedMetadata.dev !== readMetadata.dev || openedMetadata.ino !== readMetadata.ino ||
            openedMetadata.size !== readMetadata.size || openedMetadata.mtimeNs !== readMetadata.mtimeNs ||
            openedMetadata.ctimeNs !== readMetadata.ctimeNs) continue;
        const parsed = parseInstance(JSON.parse(buffer.toString('utf8', 0, bytesRead)), now);
        if (parsed) {
          instances.push(parsed);
          if (parsed.stale) {
            const currentMetadata = lstatSync(path, { bigint: true });
            if (currentMetadata.isFile() && currentMetadata.dev === readMetadata.dev &&
                currentMetadata.ino === readMetadata.ino && currentMetadata.size === readMetadata.size &&
                currentMetadata.mtimeNs === readMetadata.mtimeNs && currentMetadata.ctimeNs === readMetadata.ctimeNs) {
              unlinkSync(path);
            }
          }
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      continue;
    }
  }

  return { instances, totalWaiting: instances.reduce((sum, instance) => sum + (instance.stale ? 0 : instance.waitingCount), 0) };
}
