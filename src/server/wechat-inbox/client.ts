import { randomBytes, randomUUID } from 'node:crypto';
import { finished } from 'node:stream/promises';
import { request, type HttpResponse } from '../http.js';
import { IlinkClientError, parseConfig, parseResponse, parseUpdates, parseUploadUrl,
  type IlinkJsonObject, type IlinkUpdates, type IlinkUploadUrlResponse } from './client-response.js';

export { IlinkClientError } from './client-response.js';
export type { IlinkClientErrorCode, IlinkJsonValue, IlinkJsonObject, IlinkMessage, IlinkItemResult,
  IlinkMessageResult, IlinkUpdates, IlinkUploadUrlResponse } from './client-response.js';

export const ILINK_PROTOCOL = { channelVersion: '2.2.0', clientVersion: 131584, appId: 'bot' } as const;

export interface IlinkBinding {
  readonly baseUrl: string;
  readonly botToken: string;
}
export interface IlinkRequestOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}
export interface IlinkSendMessage {
  readonly from_user_id: string;
  readonly to_user_id: string;
  readonly client_id: string;
  readonly message_type: 2;
  readonly message_state: 2;
  readonly item_list: readonly IlinkJsonObject[];
  readonly context_token?: string;
}
export interface IlinkUploadUrlRequest {
  readonly filekey: string;
  readonly media_type: 1 | 2 | 3 | 4;
  readonly to_user_id: string;
  readonly rawsize: number;
  readonly rawfilemd5: string;
  readonly filesize: number;
  readonly aeskey: string;
  readonly no_need_thumb: boolean;
  readonly thumb_rawsize?: number;
  readonly thumb_rawfilemd5?: string;
  readonly thumb_filesize?: number;
}
type IlinkEndpoint = 'getupdates' | 'getuploadurl' | 'sendmessage' | 'getconfig' | 'sendtyping'
  | 'msg/notifystart' | 'msg/notifystop';

export class IlinkBotClient {
  readonly #baseUrl: string;
  readonly #botToken: string;
  readonly #transport: typeof request;

  constructor(binding: IlinkBinding, transport: typeof request = request) {
    const base = URL.parse(binding.baseUrl);
    if (!base || base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
      || !binding.botToken.trim() || /[\u0000-\u0020\u007f]/u.test(binding.botToken)) {
      throw new IlinkClientError('invalid_binding');
    }
    this.#baseUrl = base.href.endsWith('/') ? base.href : `${base.href}/`;
    this.#botToken = binding.botToken;
    this.#transport = transport;
  }

  async getUpdates(cursor = '', options: IlinkRequestOptions = {}): Promise<IlinkUpdates> {
    return parseResponse(await this.botRequest('getupdates', { get_updates_buf: cursor }, options), parseUpdates, true);
  }

  async getUploadUrl(input: IlinkUploadUrlRequest, options: IlinkRequestOptions = {}): Promise<IlinkUploadUrlResponse> {
    return parseResponse(await this.botRequest('getuploadurl', input, options), parseUploadUrl);
  }

  async sendMessage(message: IlinkSendMessage, options: IlinkRequestOptions = {}): Promise<void> {
    parseResponse(await this.botRequest('sendmessage', { msg: message }, options), () => undefined, true);
  }

  async getConfig(ownerIlinkUserId: string, contextToken?: string, options: IlinkRequestOptions = {}): Promise<{ readonly typingTicket?: string }> {
    return parseResponse(await this.botRequest('getconfig', { ilink_user_id: ownerIlinkUserId,
      ...(contextToken !== undefined ? { context_token: contextToken } : {}) }, options), parseConfig);
  }

  async sendTyping(ownerIlinkUserId: string, ticket: string, status: 1 | 2, options: IlinkRequestOptions = {}): Promise<void> {
    parseResponse(await this.botRequest('sendtyping', { ilink_user_id: ownerIlinkUserId, typing_ticket: ticket, status }, options), () => undefined);
  }

  async notifyStart(options: IlinkRequestOptions = {}): Promise<void> {
    parseResponse(await this.botRequest('msg/notifystart', {}, options), () => undefined);
  }

  async notifyStop(options: IlinkRequestOptions = {}): Promise<void> {
    parseResponse(await this.botRequest('msg/notifystop', {}, options), () => undefined);
  }

  private async botRequest(endpoint: IlinkEndpoint, body: object, options: IlinkRequestOptions): Promise<string> {
    const timeoutMs = options.timeoutMs ?? 35_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
      throw new IlinkClientError('invalid_request');
    }
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    let response: HttpResponse;
    try {
      signal.throwIfAborted();
      response = await this.#transport(new URL(`ilink/bot/${endpoint}`, this.#baseUrl).href, {
        method: 'POST', followRedirects: false, timeoutMs, signal: options.signal ?? signal,
        headers: {
          'Content-Type': 'application/json', Authorization: `Bearer ${this.#botToken}`,
          AuthorizationType: 'ilink_bot_token',
          'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64'),
          'X-Request-ID': randomUUID(), 'iLink-App-Id': ILINK_PROTOCOL.appId,
          'iLink-App-ClientVersion': String(ILINK_PROTOCOL.clientVersion),
        },
        body: JSON.stringify({ ...body, base_info: { channel_version: ILINK_PROTOCOL.channelVersion } }),
      });
    } catch (error) {
      throw this.transportError(error, options.signal, deadline);
    }
    if (!response.ok || ((endpoint === 'getupdates' || endpoint === 'sendmessage') && response.status !== 200)) {
      const cleanup = finished(response.body);
      response.body.destroy();
      await Promise.allSettled([cleanup]);
      throw new IlinkClientError(response.status === 401 || response.status === 403 ? 'auth_required' : 'http_failure', response.status);
    }
    let raw: string;
    try {
      raw = await response.text();
    } catch (error) {
      throw this.transportError(error, options.signal, deadline);
    }
    return raw;
  }

  private transportError(error: unknown, signal: AbortSignal | undefined, deadline: AbortSignal): IlinkClientError {
    if (signal?.aborted) return new IlinkClientError('aborted');
    if (deadline.aborted || (error instanceof Error && error.name === 'TimeoutError')) return new IlinkClientError('timeout');
    if (error instanceof Error && error.name === 'AbortError') return new IlinkClientError('aborted');
    return new IlinkClientError('transport_failed');
  }
}
