import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), 'expected contract object');
  return value;
}
export const contract = record(parse(readFileSync(new URL('../../specs/001-wechat-user-list/contracts/operator-inbox.openapi.yaml', import.meta.url), 'utf8')));

export function resolve(value: unknown): Record<string, unknown> {
  let node = record(value);
  const seen = new Set<string>();
  while ('$ref' in node) {
    assert.equal(Object.keys(node).length, 1, '$ref siblings are unsupported');
    const ref = node.$ref;
    assert.ok(typeof ref === 'string' && /^#\/components\/(schemas|responses|parameters)\/[^/]+$/.test(ref));
    assert.ok(!seen.has(ref), 'cyclic $ref');
    seen.add(ref);
    let target: unknown = contract;
    for (const part of ref.slice(2).split('/')) target = record(target)[part];
    node = record(target);
  }
  return node;
}

export function schemaCheck(value: unknown, depth = 0): (body: unknown) => boolean {
  assert.ok(depth < 32, 'schema nesting limit');
  const schema = resolve(value);
  const keywords = ['type', 'items', 'properties', 'required', 'additionalProperties', 'enum', 'const', 'oneOf', 'format', 'minimum', 'maximum', 'minLength', 'description', 'default'];
  for (const key of Object.keys(schema)) assert.ok(keywords.includes(key), `unsupported schema keyword: ${key}`);
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  for (const type of types) assert.ok(['object', 'array', 'string', 'integer', 'boolean', 'null'].includes(type));
  const properties = Object.entries(schema.properties === undefined ? {} : record(schema.properties))
    .map(([key, child]) => [key, schemaCheck(child, depth + 1)] as const);
  const items = schema.items === undefined ? undefined : schemaCheck(schema.items, depth + 1);
  const variants = schema.oneOf === undefined ? undefined : (() => {
    assert.ok(Array.isArray(schema.oneOf));
    return schema.oneOf.map((child: unknown) => schemaCheck(child, depth + 1));
  })();
  const required = schema.required ?? [];
  assert.ok(Array.isArray(required) && required.every((key) => typeof key === 'string'));
  if (schema.enum !== undefined) assert.ok(Array.isArray(schema.enum));
  if (schema.additionalProperties !== undefined) assert.equal(schema.additionalProperties, false);
  for (const key of ['minimum', 'maximum', 'minLength']) if (schema[key] !== undefined) assert.equal(typeof schema[key], 'number');
  if (schema.format !== undefined) assert.ok(['uuid', 'date-time', 'binary'].includes(String(schema.format)), 'unsupported schema format');
  return (body) => {
    if (types.length && !types.some((type) => {
      switch (type) {
        case 'null': return body === null;
        case 'object': return isRecord(body);
        case 'array': return Array.isArray(body);
        case 'integer': return Number.isInteger(body);
        case 'string': return typeof body === 'string';
        case 'boolean': return typeof body === 'boolean';
        default: assert.fail('unsupported schema type');
      }
    })) return false;
    if ('const' in schema && body !== schema.const) return false;
    if (Array.isArray(schema.enum) && !schema.enum.includes(body)) return false;
    if (variants && variants.filter((check) => check(body)).length !== 1) return false;
    if (isRecord(body)) {
      if (!required.every((key) => Object.hasOwn(body, key))) return false;
      if (!properties.every(([key, check]) => !Object.hasOwn(body, key) || check(body[key]))) return false;
      if (schema.additionalProperties === false && Object.keys(body).some((key) => !properties.some(([name]) => name === key))) return false;
    }
    if (Array.isArray(body) && items && !body.every(items)) return false;
    if (typeof body === 'number' && ((typeof schema.minimum === 'number' && body < schema.minimum)
      || (typeof schema.maximum === 'number' && body > schema.maximum))) return false;
    if (typeof body === 'string') {
      if (typeof schema.minLength === 'number' && [...body].length < schema.minLength) return false;
      if (schema.format === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body)) return false;
      if (schema.format === 'date-time' && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(body) || !Number.isFinite(Date.parse(body)))) return false;
    }
    return true;
  };
}

export function operation(method: string, path: string): Record<string, unknown> {
  return record(record(record(contract.paths)[path])[method.toLowerCase()]);
}
export async function assertContractResponse(response: Response, route: readonly [string, string]): Promise<void> {
  const declared = resolve(record(operation(...route).responses)[String(response.status)]);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  if (response.status === 204) {
    assert.equal(declared.content, undefined);
    assert.equal(await response.text(), '');
    return;
  }
  const content = record(declared.content);
  const mime = response.headers.get('content-type')?.split(';')[0];
  assert.ok(mime);
  const media = record(content[mime] ?? content['*/*']);
  const body: unknown = mime === 'application/json' ? await response.json() : await response.text();
  assert.ok(schemaCheck(media.schema)(body), `response violates ${route.join(' ')} ${response.status}`);
  if (response.status >= 400) assert.doesNotMatch(JSON.stringify(body), /secret|contextToken|botToken|baseUrl|https:\/\/|client_id/);
}
