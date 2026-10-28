import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type InboxStagingErrorCode = 'write_failed' | 'cleanup_failed' | 'aborted' | 'disposed';
export class InboxStagingError extends Error {
  override readonly name = 'InboxStagingError';
  constructor(readonly code: InboxStagingErrorCode) { super(`Inbox media staging: ${code}`); }
}

interface StagingFile {
  write(bytes: Uint8Array): Promise<{ readonly bytesWritten: number }>;
  close(): Promise<void>;
}
type OpenStagingFile = (path: string, flag: 'wx', mode: number) => Promise<StagingFile>;

async function filesystem<T>(operation: () => Promise<T>, code: InboxStagingErrorCode = 'write_failed'): Promise<T> {
  try { return await operation(); }
  catch { throw new InboxStagingError(code); }
}
function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new InboxStagingError('aborted');
}
async function nextChunk(iterator: AsyncIterator<Uint8Array>, signal: AbortSignal): Promise<IteratorResult<Uint8Array>> {
  checkAborted(signal);
  let onAbort = () => {};
  try {
    return await new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
      onAbort = () => reject(new InboxStagingError('aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(iterator.next()).then(resolve, reject);
    });
  } finally { signal.removeEventListener('abort', onAbort); }
}

export class InboxMediaStaging {
  private directory: Promise<string> | undefined;
  private directoryPath: string | undefined;
  private disposal: Promise<void> | undefined;
  private readonly cancellation = new AbortController();
  private readonly active = new Set<Promise<string>>();

  constructor(private readonly parentDirectory = tmpdir(), private readonly openFile: OpenStagingFile = open) {}

  async stage(source: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<string> {
    if (this.disposal) throw new InboxStagingError('disposed');
    const combined = signal ? AbortSignal.any([signal, this.cancellation.signal]) : this.cancellation.signal;
    const operation = this.stageFile(source, combined);
    this.active.add(operation);
    try { return await operation; }
    finally { this.active.delete(operation); }
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      this.cancellation.abort();
      this.disposal = this.removeDirectory();
    }
    return this.disposal;
  }

  private async removeDirectory(): Promise<void> {
    await Promise.allSettled(this.active);
    if (this.directoryPath) {
      const path = this.directoryPath;
      await filesystem(() => rm(path, { recursive: true, force: true }), 'cleanup_failed');
    }
  }

  private async createDirectory(): Promise<string> {
    const path = await filesystem(() => mkdtemp(join(this.parentDirectory, 'quotahot-inbox-')));
    this.directoryPath = path;
    await filesystem(() => chmod(path, 0o700));
    return path;
  }

  private async stageFile(source: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<string> {
    checkAborted(signal);
    this.directory ??= this.createDirectory();
    let path: string | undefined;
    let created = false;
    try {
      const directory = await this.directory;
      checkAborted(signal);
      path = join(directory, randomUUID());
      const filePath = path;
      const file = await filesystem(() => this.openFile(filePath, 'wx', 0o600));
      created = true;
      const [outcome] = await Promise.allSettled([this.consume(source, file, signal)]);
      const [closed] = await Promise.allSettled([file.close()]);
      if (outcome.status === 'rejected') throw outcome.reason;
      if (closed.status === 'rejected') throw new InboxStagingError('write_failed');
      checkAborted(signal);
      return path;
    } catch (error) {
      if (created && path) {
        const partialPath = path;
        await filesystem(() => rm(partialPath, { force: true }), 'cleanup_failed');
      }
      checkAborted(signal);
      throw error;
    }
  }

  private async consume(source: AsyncIterable<Uint8Array>, file: StagingFile, signal: AbortSignal): Promise<void> {
    const iterator = source[Symbol.asyncIterator]();
    let completed = false;
    try {
      while (true) {
        const next = await nextChunk(iterator, signal);
        checkAborted(signal);
        if (next.done) { completed = true; return; }
        for (let offset = 0; offset < next.value.byteLength;) {
          checkAborted(signal);
          const bytes = next.value.subarray(offset, offset + 65536);
          const { bytesWritten } = await filesystem(() => file.write(bytes));
          if (bytesWritten <= 0 || bytesWritten > bytes.byteLength) throw new InboxStagingError('write_failed');
          offset += bytesWritten;
        }
      }
    } finally {
      if (!completed && iterator.return) {
        void Promise.allSettled([Promise.resolve().then(() => iterator.return?.())]);
      }
    }
  }
}
