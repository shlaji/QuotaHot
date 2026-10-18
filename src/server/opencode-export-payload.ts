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

function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 8.64e15) return invalid();
  return value;
}

function partProjection(value: unknown, owner: { readonly sessionId: string; readonly messageId: string }): TaskSessionPart {
  const part = jsonObject(value);
  if (!part || part.sessionID !== owner.sessionId || part.messageID !== owner.messageId) return invalid();
  const id = string(part.id);
  const type = string(part.type);
  if (!id || !type) return invalid();
  switch (type) {
    case 'text': {
      if (part.synthetic !== undefined && typeof part.synthetic !== 'boolean') return invalid();
      return { id, type, text: string(part.text), ...(part.synthetic === undefined ? {} : { synthetic: part.synthetic }) };
    }
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
  const sessionTime = jsonObject(info?.time);
  if (!root || !info || !sessionTime || info.id !== sessionId || (info.parentID != null && info.parentID !== '')
    || !Array.isArray(root.messages)) return invalid();
  if (root.messages.length > 2000) throw new SessionExportError('limit_exceeded', 'Session export exceeds 2000 messages');
  const time = { created: timestamp(sessionTime.created), updated: timestamp(sessionTime.updated) };
  let partCount = 0;
  const messages: TaskSessionMessage[] = root.messages.map((value: unknown) => {
    const message = jsonObject(value);
    const metadata = jsonObject(message?.info);
    const messageTime = jsonObject(metadata?.time);
    if (!message || !metadata || !messageTime || metadata.sessionID !== sessionId || !Array.isArray(message.parts)) return invalid();
    const id = string(metadata.id);
    const role = metadata.role;
    if (!id || (role !== 'user' && role !== 'assistant')) return invalid();
    partCount += message.parts.length;
    if (partCount > 10000) throw new SessionExportError('limit_exceeded', 'Session export exceeds 10000 parts');
    const common = {
      id,
      time: { created: timestamp(messageTime.created),
        ...(messageTime.completed === undefined ? {} : { completed: timestamp(messageTime.completed) }) },
      parts: message.parts.map((part: unknown) => partProjection(part, { sessionId, messageId: id })),
    };
    switch (role) {
      case 'user': return { ...common, role };
      case 'assistant': return { ...common, role, agent: string(metadata.agent), providerID: string(metadata.providerID), modelID: string(metadata.modelID) };
    }
  });
  return { sessionId, title: string(info.title), time, scope: 'root-only', messages };
}
