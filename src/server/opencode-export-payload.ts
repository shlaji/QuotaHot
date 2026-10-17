import type { TaskSessionErrorCode, TaskSessionMessage, TaskSessionPart, TaskSessionTranscript } from '../shared/tasks.js';
import { jsonObject } from './opencode-runtime-support.js';

export class SessionExportError extends Error {
  constructor(readonly code: TaskSessionErrorCode, message: string) {
    super(message);
    this.name = 'SessionExportError';
  }
}

function invalid(): never {
  throw new SessionExportError('invalid_output', 'OpenCode returned an invalid or mismatched session export');
}

function string(value: unknown): string {
  if (typeof value !== 'string') return invalid();
  return value;
}

function partProjection(value: unknown, owner: { readonly sessionId: string; readonly messageId: string }): TaskSessionPart {
  const part = jsonObject(value);
  if (!part || part.sessionID !== owner.sessionId || part.messageID !== owner.messageId) return invalid();
  const id = string(part.id);
  const type = string(part.type);
  if (!id || !type) return invalid();
  switch (type) {
    case 'text':
    case 'reasoning': return { id, type, text: string(part.text) };
    case 'tool': {
      const state = jsonObject(part.state);
      if (!state || !jsonObject(state.input)) return invalid();
      let input: string;
      try { input = JSON.stringify(state.input); }
      catch (error) {
        if (error instanceof RangeError) throw new SessionExportError('limit_exceeded', 'Tool input exceeds serialization depth');
        throw error;
      }
      const status = state.status;
      switch (status) {
        case 'pending':
        case 'running':
        case 'completed':
        case 'error': return {
          id, type, tool: string(part.tool), status, input,
          output: status === 'completed' ? string(state.output) : '',
          error: status === 'error' ? string(state.error) : '',
        };
        default: return invalid();
      }
    }
    default: return { id, type: 'unsupported', originalType: type };
  }
}

export function parseSessionExport(payload: string, sessionId: string): TaskSessionTranscript {
  let raw: unknown;
  try { raw = JSON.parse(payload); }
  catch (error) {
    if (error instanceof SyntaxError) return invalid();
    throw error;
  }
  const root = jsonObject(raw);
  const info = jsonObject(root?.info);
  if (!root || !info || info.id !== sessionId || (info.parentID != null && info.parentID !== '')
    || !Array.isArray(root.messages)) return invalid();
  if (root.messages.length > 2000) throw new SessionExportError('limit_exceeded', 'Session export exceeds 2000 messages');
  let partCount = 0;
  const messages: TaskSessionMessage[] = root.messages.map((value: unknown) => {
    const message = jsonObject(value);
    const metadata = jsonObject(message?.info);
    if (!message || !metadata || metadata.sessionID !== sessionId || !Array.isArray(message.parts)) return invalid();
    const id = string(metadata.id);
    const role = metadata.role;
    if (!id || (role !== 'user' && role !== 'assistant')) return invalid();
    partCount += message.parts.length;
    if (partCount > 10000) throw new SessionExportError('limit_exceeded', 'Session export exceeds 10000 parts');
    return { id, role, parts: message.parts.map((part: unknown) => partProjection(part, { sessionId, messageId: id })) };
  });
  return { sessionId, title: string(info.title), scope: 'root-only', messages };
}
