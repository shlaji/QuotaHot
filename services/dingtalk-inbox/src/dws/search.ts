import type { GroupCandidate, PersonCandidate } from '../shared/types.js';
import type { JsonValue } from './protocol.js';

export type SearchResult<Candidate> = { readonly items: readonly Candidate[]; readonly complete: boolean };
type JsonObject = { readonly [key: string]: JsonValue };

export class SearchSchemaError extends Error {
  constructor() { super('Invalid DWS search response'); this.name = 'SearchSchemaError'; }
}

function object(value: JsonValue | undefined): JsonObject | null {
  const isObject = (input: JsonValue | undefined): input is JsonObject => typeof input === 'object' && input !== null && !Array.isArray(input);
  return isObject(value) ? value : null;
}

function text(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function envelope(value: JsonValue) {
  const root = object(value);
  if (root === null) throw new SearchSchemaError();
  const rows = root['result'] ?? root['items'];
  if (!Array.isArray(rows)) throw new SearchSchemaError();
  return { root, rows, evidence: object(root['searchEvidence']) ?? root };
}

function hasIncompleteEvidence(metadata: JsonObject): boolean {
  return (metadata['complete'] !== undefined && metadata['complete'] !== true)
    || (metadata['hasMore'] !== undefined && metadata['hasMore'] !== false)
    || (metadata['paginationKnown'] !== undefined && metadata['paginationKnown'] !== true)
    || (metadata['partial'] !== undefined && metadata['partial'] !== false)
    || (metadata['failedCount'] !== undefined && metadata['failedCount'] !== 0)
    || metadata['success'] === false;
}

export function parsePeople(value: JsonValue): SearchResult<PersonCandidate> {
  const { root, rows, evidence } = envelope(value);
  const items = new Map<string, PersonCandidate>();
  for (const row of rows) {
    const candidate = object(row);
    if (candidate === null) continue;
    const userId = text(candidate['userId']);
    const displayName = text(candidate['title']) ?? text(candidate['name']) ?? text(candidate['author']);
    if (userId === null || displayName === null) continue;
    items.set(userId, { userId, displayName });
  }
  const affirmative = root['complete'] === true || evidence['complete'] === true
    || (evidence['paginationKnown'] === true && evidence['hasMore'] === false);
  return { items: [...items.values()], complete: affirmative && !hasIncompleteEvidence(root) && !hasIncompleteEvidence(evidence) };
}

export function parseGroups(value: JsonValue): SearchResult<GroupCandidate> {
  const { root, rows, evidence } = envelope(value);
  const items = new Map<string, GroupCandidate>();
  for (const row of rows) {
    const candidate = object(row);
    if (candidate === null) continue;
    const openConversationId = text(candidate['openConversationId']);
    const displayName = text(candidate['title']) ?? text(candidate['name']) ?? text(candidate['displayName']);
    if (openConversationId === null || displayName === null) continue;
    items.set(openConversationId, { openConversationId, displayName });
  }
  const affirmative = evidence['complete'] === true && evidence['partial'] === false && evidence['failedCount'] === 0;
  return { items: [...items.values()], complete: affirmative && !hasIncompleteEvidence(root) && !hasIncompleteEvidence(evidence) };
}
