import { createHash } from 'node:crypto';

export class LosslessNumber {
  constructor(readonly source: string) {}
}

export function parseLosslessJson(source: string): unknown {
  try {
    return JSON.parse(source, (_key: string, value: unknown, context?: { readonly source?: string }): unknown => {
      if (typeof value !== 'number') return value;
      if (context?.source === undefined) throw new TypeError('Missing JSON number source');
      return new LosslessNumber(context.source);
    });
  } catch (error) {
    if (error instanceof SyntaxError) throw new SyntaxError('Invalid JSON');
    throw error;
  }
}

function canonicalJson(value: unknown): string {
  if (value instanceof LosslessNumber) return value.source;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new TypeError('Invalid JSON value');
}

export function fingerprintJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
