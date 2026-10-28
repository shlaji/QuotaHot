import type { SQLOutputValue } from 'node:sqlite';

export type Row = Record<string, SQLOutputValue>;

export function text(value: SQLOutputValue): string {
  if (typeof value !== 'string') throw new TypeError('Invalid inbox text');
  return value;
}
export function integer(value: SQLOutputValue): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError('Invalid inbox integer');
  return value;
}
export function choice<Value extends string>(values: readonly Value[], value: SQLOutputValue): Value {
  const result = values.find((candidate) => candidate === value);
  if (result === undefined) throw new TypeError('Invalid inbox enum');
  return result;
}
