import { fingerprintJson, LosslessNumber, parseLosslessJson } from './fingerprint.js';

export type IlinkClientErrorCode = 'invalid_binding' | 'invalid_request' | 'auth_required' | 'http_failure'
  | 'upstream_failure' | 'invalid_response' | 'timeout' | 'aborted' | 'transport_failed';

export class IlinkClientError extends Error {
  override readonly name = 'IlinkClientError';
  constructor(readonly code: IlinkClientErrorCode, readonly httpStatus?: number) {
    super(`iLink bot: ${code}`);
  }
}

export type IlinkJsonValue = null | boolean | number | string | readonly IlinkJsonValue[] | IlinkJsonObject;
export interface IlinkJsonObject { readonly [key: string]: IlinkJsonValue }
export interface IlinkMessage {
  readonly message_id: string;
  readonly from_user_id?: string;
  readonly to_user_id?: string;
  readonly direction: 'inbound' | 'outbound';
  readonly client_id?: string;
  readonly context_token?: string;
  readonly message_type: 1 | 2;
  readonly message_state?: number;
  readonly create_time_ms?: number;
  readonly update_time_ms?: number;
  readonly item_list?: readonly IlinkItemResult[];
}
export type IlinkItemResult = { readonly kind: 'item'; readonly item: IlinkJsonObject }
  | { readonly kind: 'malformed_item'; readonly reason: 'invalid_item'; readonly fingerprint: string };
export type IlinkMessageResult = { readonly kind: 'message'; readonly message: IlinkMessage }
  | { readonly kind: 'malformed_message'; readonly reason: 'invalid_message'; readonly fingerprint: string;
    readonly from_user_id?: string; readonly to_user_id?: string; readonly message_id?: string };
export interface IlinkUpdates {
  readonly kind: 'updates';
  readonly msgs: readonly IlinkMessageResult[];
  readonly get_updates_buf?: string;
  readonly longpolling_timeout_ms?: number;
}
export interface IlinkUploadUrlResponse {
  readonly upload_param?: string;
  readonly thumb_upload_param?: string;
  readonly upload_full_url?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof LosslessNumber);
}

function optionalText(value: unknown): string | undefined {
  if (value === undefined || typeof value === 'string') return value;
  throw new IlinkClientError('invalid_response');
}

function optionalClientId(value: unknown): string | undefined {
  const text = optionalText(value);
  return text?.trim() ? text : undefined;
}

function optionalInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (value instanceof LosslessNumber && Number.isSafeInteger(Number(value.source))) return Number(value.source);
  throw new IlinkClientError('invalid_response');
}

function jsonValue(value: unknown): IlinkJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (value instanceof LosslessNumber && Number.isFinite(Number(value.source))) return Number(value.source);
  if (Array.isArray(value)) return value.map(jsonValue);
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
  throw new IlinkClientError('invalid_response');
}

function messageId(value: unknown): string | undefined {
  const decimal = value instanceof LosslessNumber ? value.source : value;
  if (typeof decimal !== 'string' || !/^(0|[1-9][0-9]*)$/.test(decimal)
    || decimal.length > 20 || BigInt(decimal) > 18446744073709551615n) return undefined;
  return decimal;
}

function itemResult(value: unknown): IlinkItemResult {
  try {
    if (!record(value)) throw new IlinkClientError('invalid_response');
    optionalInteger(value.type);
    return { kind: 'item', item: Object.fromEntries(Object.entries(value).map(([key, field]) => [key, jsonValue(field)])) };
  } catch (error) {
    if (!(error instanceof IlinkClientError) || error.code !== 'invalid_response') throw error;
    return { kind: 'malformed_item', reason: 'invalid_item', fingerprint: fingerprintJson(value) };
  }
}

function message(value: unknown): IlinkMessageResult {
  const id = record(value) ? messageId(value.message_id) : undefined;
  const sender = record(value) ? value.from_user_id : undefined;
  const receiver = record(value) ? value.to_user_id : undefined;
  try {
    if (!record(value) || id === undefined) throw new IlinkClientError('invalid_response');
    const messageType = optionalInteger(value.message_type);
    let direction: IlinkMessage['direction'];
    switch (messageType) {
      case 1: direction = 'inbound'; break;
      case 2: direction = 'outbound'; break;
      default: throw new IlinkClientError('invalid_response');
    }
    if (value.item_list !== undefined && !Array.isArray(value.item_list)) throw new IlinkClientError('invalid_response');
    return { kind: 'message', message: {
      message_id: id, direction, from_user_id: optionalText(value.from_user_id),
      to_user_id: optionalText(value.to_user_id), client_id: optionalClientId(value.client_id),
      context_token: optionalText(value.context_token), message_type: messageType,
      message_state: optionalInteger(value.message_state), create_time_ms: optionalInteger(value.create_time_ms),
      update_time_ms: optionalInteger(value.update_time_ms), item_list: value.item_list?.map(itemResult),
    } };
  } catch (error) {
    if (!(error instanceof IlinkClientError) || error.code !== 'invalid_response') throw error;
    return { kind: 'malformed_message', reason: 'invalid_message', fingerprint: fingerprintJson(value),
      ...(id !== undefined ? { message_id: id } : {}), ...(typeof sender === 'string' ? { from_user_id: sender } : {}),
      ...(typeof receiver === 'string' ? { to_user_id: receiver } : {}) };
  }
}

export function parseResponse<Result>(raw: string, decode: (value: Record<string, unknown>) => Result, requireAccepted = false): Result {
  try {
    const value: unknown = parseLosslessJson(raw);
    if (!record(value)) throw new IlinkClientError('invalid_response');
    if (!requireAccepted && [value.ret, value.errcode].some((code) => code instanceof LosslessNumber && Number(code.source) === -14)) {
      throw new IlinkClientError('auth_required');
    }
    const ret = optionalInteger(value.ret);
    if (requireAccepted && ret === undefined) throw new IlinkClientError('invalid_response');
    if (requireAccepted && ret !== 0) throw new IlinkClientError('upstream_failure');
    const errcode = optionalInteger(value.errcode);
    if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) throw new IlinkClientError('upstream_failure');
    return decode(value);
  } catch (error) {
    if (error instanceof IlinkClientError) throw error;
    throw new IlinkClientError('invalid_response');
  }
}

export function parseUpdates(value: Record<string, unknown>): IlinkUpdates {
  if (value.msgs !== undefined && !Array.isArray(value.msgs)) throw new IlinkClientError('invalid_response');
  const cursor = optionalText(value.get_updates_buf);
  const timeout = optionalInteger(value.longpolling_timeout_ms);
  if (timeout !== undefined && timeout <= 0) throw new IlinkClientError('invalid_response');
  return {
    kind: 'updates', msgs: value.msgs === undefined ? [] : value.msgs.map(message),
    ...(cursor !== undefined ? { get_updates_buf: cursor } : {}),
    ...(timeout !== undefined ? { longpolling_timeout_ms: timeout } : {}),
  };
}

export function parseUploadUrl(value: Record<string, unknown>): IlinkUploadUrlResponse {
  const upload = optionalText(value.upload_param);
  const thumb = optionalText(value.thumb_upload_param);
  const url = optionalText(value.upload_full_url);
  return { ...(upload !== undefined ? { upload_param: upload } : {}),
    ...(thumb !== undefined ? { thumb_upload_param: thumb } : {}), ...(url !== undefined ? { upload_full_url: url } : {}) };
}

export function parseConfig(value: Record<string, unknown>): { readonly typingTicket?: string } {
  const ticket = optionalText(value.typing_ticket);
  return ticket !== undefined ? { typingTicket: ticket } : {};
}
