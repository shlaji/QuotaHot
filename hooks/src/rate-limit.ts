import type { Window } from './types.js';

export type HeaderLike = Iterable<[string, string]> | Record<string, string>;

function numberOf(value: unknown): number | null {
  const number = Number(String(value ?? '').trim());
  return Number.isFinite(number) ? number : null;
}

export function epochMs(value: string, nowMs: number): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const number = Number(trimmed);
  if (Number.isFinite(number)) return number > 1_000_000_000 ? number * 1000 : nowMs + number * 1000;
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

export function findKey(node: unknown, target: string, depth = 0): unknown {
  if (depth > 6 || node === null || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const value of node) {
      const found = findKey(value, target, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = node as Record<string, unknown>;
  if (target in record) return record[target];
  for (const value of Object.values(record)) {
    const found = findKey(value, target, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function parseBody(payload: unknown, nowMs: number): Window[] {
  const limits = findKey(payload, 'rate_limits');
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) return [];
  const windows: Window[] = [];
  for (const [name, node] of Object.entries(limits as Record<string, unknown>)) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) continue;
    const record = node as Record<string, unknown>;
    let resetAt: number | null = null;
    for (const key of ['resets_in_seconds', 'reset_after_seconds', 'resets_at', 'reset_at']) {
      if (!(key in record)) continue;
      resetAt = epochMs(String(record[key]), nowMs);
      break;
    }
    if (resetAt === null) continue;
    windows.push({
      name: name.toLowerCase(), resetAt,
      usedPercent: numberOf(record.used_percent),
      windowMinutes: numberOf(record.window_minutes),
      source: 'body:rate_limits',
    });
  }
  return windows;
}

export function parseCodexUsage(payload: unknown, nowMs: number): Window[] {
  const streaming = parseBody(payload, nowMs);
  if (streaming.length > 0) return streaming;
  const windows: Window[] = [];
  for (const key of ['primary_window', 'secondary_window'] as const) {
    const node = findKey(payload, key);
    if (node === null || typeof node !== 'object' || Array.isArray(node)) continue;
    const record = node as Record<string, unknown>;
    let resetAt: number | null = null;
    for (const resetField of ['reset_after_seconds', 'resets_in_seconds', 'resets_at', 'reset_at']) {
      if (!(resetField in record)) continue;
      resetAt = epochMs(String(record[resetField]), nowMs);
      if (resetAt !== null) break;
    }
    if (resetAt === null) continue;
    const seconds = numberOf(record.limit_window_seconds);
    windows.push({
      name: key === 'primary_window' ? 'primary' : 'secondary', resetAt,
      usedPercent: numberOf(record.used_percent ?? record.used_percentage ?? record.utilization ?? record.percent),
      windowMinutes: seconds === null ? numberOf(record.window_minutes) : Math.round(seconds / 60),
      source: `usage:${key}`,
    });
  }
  return windows;
}

export function parseHeaders(headers: HeaderLike, nowMs: number): Window[] {
  const entries = typeof (headers as Iterable<[string, string]>)[Symbol.iterator] === 'function'
    ? [...headers as Iterable<[string, string]>]
    : Object.entries(headers);
  const windows = new Map<string, Window>();
  for (const [rawKey, value] of entries) {
    const match = /^x-codex-(primary|secondary)-([a-z-]+)$/i.exec(rawKey.toLowerCase());
    if (!match) continue;
    const name = match[1]?.toLowerCase();
    const field = match[2]?.toLowerCase();
    if (name === undefined || field === undefined) continue;
    const current = windows.get(name) ?? { name, resetAt: 0, usedPercent: null, windowMinutes: null, source: '' };
    if (field.includes('reset')) {
      const resetAt = epochMs(value, nowMs);
      if (resetAt !== null) windows.set(name, { ...current, resetAt, source: `header:${rawKey.toLowerCase()}` });
    } else if (field.includes('used')) {
      windows.set(name, { ...current, usedPercent: numberOf(value) });
    } else if (field.includes('window')) {
      windows.set(name, { ...current, windowMinutes: numberOf(value) });
    }
  }
  return [...windows.values()].filter((window) => window.resetAt > 0);
}

export function mergeWindows(...groups: readonly (readonly Window[])[]): Window[] {
  const windows = new Map<string, Window>();
  for (const group of groups) for (const window of group) if (!windows.has(window.name)) windows.set(window.name, window);
  return [...windows.values()];
}
