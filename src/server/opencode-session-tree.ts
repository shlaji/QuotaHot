import {
  isErrorMessage,
  requestUrl,
  sessionList,
  sessionMessage,
  statusMap,
  type Session,
  type SessionMessage,
  type SessionStatus,
} from './opencode-runtime-support.js';

export type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type SessionSleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

const REQUEST_TIMEOUT_MS = 5_000;
const ABORT_TREE_TIMEOUT_MS = 30_000;
const STABLE_PASSES_REQUIRED = 2;

export class OpenCodeSessionTree {
  constructor(
    private readonly base: string,
    private readonly directory: string,
    private readonly fetcher: Fetcher,
    private readonly signal: AbortSignal,
    private readonly sleep: SessionSleep,
    private readonly abortTimeoutMs = ABORT_TREE_TIMEOUT_MS,
  ) {}

  async wait(rootId: string, rootExitCode: number | null, rootExitSignal: NodeJS.Signals | null): Promise<string> {
    let previousSignature = '';
    let stablePasses = 0;
    while (!this.signal.aborted) {
      const snapshot = await this.snapshot(rootId);
      const active = snapshot.sessions.some((session) => {
        const status = snapshot.statuses.get(session.id);
        return status === 'busy' || status === 'retry';
      });
      const incomplete = snapshot.sessions.some((session) => !snapshot.messages.get(session.id)?.completed);
      const rootFailed = rootExitCode !== null && rootExitCode !== 0 || rootExitSignal !== null;
      if (!active && (rootFailed || !incomplete)) {
        const errors = [...snapshot.messages.values()].filter((message) => message && isErrorMessage(message));
        const sessionErrors = errors.map((message) => message?.error || 'OpenCode session reported an error');
        if (rootFailed) sessionErrors.push(`OpenCode exited with ${rootExitSignal ?? rootExitCode}`);
        const signature = JSON.stringify(snapshot.sessions.map((session) => [
          session.id,
          snapshot.statuses.get(session.id) ?? 'idle',
          snapshot.messages.get(session.id)?.completed ?? false,
          snapshot.messages.get(session.id)?.error ?? '',
        ]).sort(([left], [right]) => String(left).localeCompare(String(right))));
        stablePasses = signature === previousSignature ? stablePasses + 1 : 1;
        previousSignature = signature;
        if (stablePasses >= STABLE_PASSES_REQUIRED) return sessionErrors.join('\n');
      } else {
        previousSignature = '';
        stablePasses = 0;
      }
      await this.sleep(500, this.signal);
    }
    throw new Error('Execution cancelled');
  }

  async abort(rootId: string): Promise<void> {
    const deadline = Date.now() + this.abortTimeoutMs;
    const aborted = new Set<string>();
    let stablePasses = 0;
    while (stablePasses < STABLE_PASSES_REQUIRED) {
      if (Date.now() >= deadline) throw new Error('Timed out aborting OpenCode session tree');
      const snapshot = await this.snapshot(rootId, deadline);
      const depth = new Map<string, number>();
      for (const session of snapshot.sessions) {
        depth.set(session.id, session.parentID ? (depth.get(session.parentID) ?? 0) + 1 : 0);
      }
      const unseen = snapshot.sessions.filter((session) => !aborted.has(session.id))
        .sort((left, right) => (depth.get(right.id) ?? 0) - (depth.get(left.id) ?? 0));
      for (const session of unseen) {
        if (Date.now() >= deadline) throw new Error('Timed out aborting OpenCode session tree');
        const response = await this.fetcher(
          requestUrl(this.base, `/session/${encodeURIComponent(session.id)}/abort`, this.directory),
          { method: 'POST', signal: this.requestSignal(deadline) },
        );
        if (!response.ok && response.status !== 404) {
          throw new Error(`OpenCode abort request failed with ${response.status}`);
        }
        aborted.add(session.id);
      }
      const afterAbort = await this.snapshot(rootId, deadline);
      const active = afterAbort.sessions.some((session) => {
        const status = afterAbort.statuses.get(session.id);
        return status === 'busy' || status === 'retry';
      });
      const unseenAfterAbort = afterAbort.sessions.some((session) => !aborted.has(session.id));
      stablePasses = !active && !unseenAfterAbort ? stablePasses + 1 : 0;
      if (stablePasses >= STABLE_PASSES_REQUIRED) return;
      if (Date.now() >= deadline) throw new Error('Timed out aborting OpenCode session tree');
      try {
        await this.sleep(500, this.requestSignal(deadline));
      } catch (error) {
        if (Date.now() >= deadline) throw new Error('Timed out aborting OpenCode session tree');
        throw error;
      }
    }
  }

  private async sessions(parentId: string, deadline?: number): Promise<Session[]> {
    const response = await this.fetcher(
      requestUrl(this.base, `/session/${encodeURIComponent(parentId)}/children`, this.directory),
      { signal: this.requestSignal(deadline) },
    );
    if (!response.ok) throw new Error(`OpenCode children request failed with ${response.status}`);
    return sessionList(await response.json());
  }

  private async snapshot(rootId: string, deadline?: number): Promise<{
    readonly sessions: Session[];
    readonly statuses: ReadonlyMap<string, SessionStatus>;
    readonly messages: ReadonlyMap<string, SessionMessage | null>;
  }> {
    const sessions = await this.tree(rootId, deadline);
    const statusResponse = await this.fetcher(requestUrl(this.base, '/session/status', this.directory), {
      signal: this.requestSignal(deadline),
    });
    if (!statusResponse.ok) throw new Error(`OpenCode status request failed with ${statusResponse.status}`);
    const statuses = statusMap(await statusResponse.json());
    const messages = new Map<string, SessionMessage | null>();
    for (const session of sessions) messages.set(session.id, await this.message(session.id, deadline));
    return { sessions, statuses, messages };
  }

  private async tree(rootId: string, deadline?: number): Promise<Session[]> {
    const found = new Map<string, Session>([[rootId, { id: rootId, parentID: null, directory: this.directory }]]);
    const queue = [rootId];
    while (queue.length > 0) {
      const parentId = queue.shift();
      if (!parentId) continue;
      for (const child of await this.sessions(parentId, deadline)) {
        if (found.has(child.id)) continue;
        if (child.directory !== this.directory) throw new Error(`OpenCode child session ${child.id} escaped the task directory`);
        found.set(child.id, child);
        queue.push(child.id);
      }
    }
    return [...found.values()];
  }

  private async message(sessionId: string, deadline?: number): Promise<SessionMessage | null> {
    const response = await this.fetcher(
      requestUrl(this.base, `/session/${encodeURIComponent(sessionId)}/message?limit=1`, this.directory),
      { signal: this.requestSignal(deadline) },
    );
    if (!response.ok) throw new Error(`OpenCode message request failed with ${response.status}`);
    return sessionMessage(await response.json());
  }

  private requestSignal(deadline?: number): AbortSignal {
    const remaining = deadline === undefined ? REQUEST_TIMEOUT_MS : Math.max(1, deadline - Date.now());
    const timeout = Math.min(REQUEST_TIMEOUT_MS, remaining);
    return this.signal.aborted
      ? AbortSignal.timeout(timeout)
      : AbortSignal.any([this.signal, AbortSignal.timeout(timeout)]);
  }
}
