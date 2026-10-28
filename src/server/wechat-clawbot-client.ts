import { finished } from 'node:stream/promises';
import type { ConfirmedWechatBinding } from './wechat-session-store.js';
import { request, type HttpResponse } from './http.js';

const ORIGIN = 'https://ilinkai.weixin.qq.com';
const QR_ENDPOINT = '/ilink/bot/get_bot_qrcode';
const STATUS_ENDPOINT = '/ilink/bot/get_qrcode_status';
type QrEndpoint = typeof QR_ENDPOINT | typeof STATUS_ENDPOINT;
type ProtocolFailureReason = 'invalid_json' | 'invalid_envelope' | 'invalid_qrcode' | 'invalid_status';

export type QrLoginStatus =
  | { readonly status: 'waiting' }
  | { readonly status: 'scanned' }
  | { readonly status: 'confirmed'; readonly credentials: ConfirmedWechatBinding }
  | { readonly status: 'expired' };

export type WechatClawbotErrorCode =
  | 'auth_required' | 'http_failure' | 'invalid_response' | 'request_failed' | 'identity_missing';

export class WechatClawbotError extends Error {
  override readonly name = 'WechatClawbotError';

  constructor(readonly code: WechatClawbotErrorCode, readonly httpStatus?: number) {
    super(`WeChat ClawBot: ${code}`);
  }
}

export interface QrLoginAttempt {
  readonly qrPayload: string;
  readonly pollStatus: (signal?: AbortSignal) => Promise<QrLoginStatus>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WechatClawbotError('invalid_response');
  }
  return value;
}

function httpsUrl(value: string): URL {
  const parsed = URL.parse(value);
  if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new WechatClawbotError('invalid_response');
  }
  return parsed;
}

type QrRequest<T> = {
  readonly body?: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly parse: (data: Record<string, unknown>) => T;
};

async function requestJson<T>(requester: typeof request, path: QrEndpoint, options: QrRequest<T>): Promise<T> {
  let response: HttpResponse;
  const { body, parse, ...requestOptions } = options;
  const method = path === QR_ENDPOINT ? 'GET' : 'POST';
  const logFailure = (status: number, errorCode: string): void => {
    console.warn(JSON.stringify({ event: 'wechat_request_failed', endpoint: path, method, status, errorCode }));
  };
  try {
    response = await requester(`${ORIGIN}${path}${path === QR_ENDPOINT ? '?bot_type=3' : ''}`, {
      ...requestOptions, method, followRedirects: false,
      ...(body === undefined ? {} : { body }),
      ...(path === STATUS_ENDPOINT ? { headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '131584',
      } } : {}),
    });
  } catch (error) {
    logFailure(0, error instanceof Error && error.name === 'TimeoutError' ? 'timeout'
      : error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'transport_failed');
    if (error instanceof WechatClawbotError) throw error;
    throw new WechatClawbotError('request_failed');
  }
  if (!response.ok) {
    logFailure(response.status, 'http_failure');
    const bodyFinished = finished(response.body);
    response.body.destroy();
    await bodyFinished.catch(() => undefined);
    throw new WechatClawbotError(
      response.status === 401 || response.status === 403 ? 'auth_required' : 'http_failure',
      response.status,
    );
  }
  let reason: ProtocolFailureReason = 'invalid_json';
  try {
    const value: unknown = await response.json().catch((error: unknown) => {
      throw new WechatClawbotError(error instanceof SyntaxError ? 'invalid_response' : 'request_failed');
    });
    reason = 'invalid_envelope';
    if (!record(value) || value.ret !== 0) {
      throw new WechatClawbotError('invalid_response');
    }
    reason = path === QR_ENDPOINT ? 'invalid_qrcode' : 'invalid_status';
    return parse(value);
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'wechat_protocol_failed', endpoint: path, status: response.status,
      reason: error instanceof WechatClawbotError && error.code === 'request_failed' ? 'response_read_failed' : reason,
    }));
    throw error;
  }
}

class QrAttempt implements QrLoginAttempt {
  readonly #requester: typeof request;
  readonly #qrcode: string;
  readonly qrPayload: string;

  constructor(requester: typeof request, qrcode: string, qrPayload: string) {
    this.#requester = requester;
    this.#qrcode = qrcode;
    this.qrPayload = qrPayload;
  }

  async pollStatus(signal?: AbortSignal): Promise<QrLoginStatus> {
    return requestJson(this.#requester, STATUS_ENDPOINT, {
      body: new URLSearchParams({ qrcode: this.#qrcode }).toString(),
      timeoutMs: 120_000,
      ...(signal ? { signal } : {}),
      parse: (data): QrLoginStatus => {
        switch (data.status) {
          case 'wait': return { status: 'waiting' };
          case 'scaned': return { status: 'scanned' };
          case 'expired': return { status: 'expired' };
          case 'confirmed': {
            const owner = data.ilink_user_id;
            if (owner === undefined || owner === null || (typeof owner === 'string' && owner.trim() === '')) {
              throw new WechatClawbotError('identity_missing');
            }
            return { status: 'confirmed', credentials: {
              ownerIlinkUserId: text(owner),
              botId: text(data.ilink_bot_id),
              botToken: text(data.bot_token),
              baseUrl: httpsUrl(text(data.baseurl)).href,
            } };
          }
          default: throw new WechatClawbotError('invalid_response');
        }
      },
    });
  }
}

export class WechatClawbotClient {
  readonly #requester: typeof request;

  constructor(requester: typeof request = request) {
    this.#requester = requester;
  }

  async createQr(signal?: AbortSignal): Promise<QrLoginAttempt> {
    return requestJson(this.#requester, QR_ENDPOINT, {
      timeoutMs: 15_000, ...(signal ? { signal } : {}),
      parse: (data) => {
        const qrcode = text(data.qrcode);
        const qrPayload = text(data.qrcode_img_content);
        if (/[\s\u0000-\u001f\u007f]/u.test(qrPayload)
          || !/^https:\/\/liteapp\.weixin\.qq\.com\/q\/[A-Za-z0-9_-]+\?[^#]+$/.test(qrPayload)) {
          throw new WechatClawbotError('invalid_response');
        }
        const scan = httpsUrl(qrPayload);
        if (scan.searchParams.size !== 2
          || scan.searchParams.getAll('qrcode').length !== 1
          || scan.searchParams.getAll('bot_type').length !== 1
          || scan.searchParams.get('qrcode') !== qrcode
          || scan.searchParams.get('bot_type') !== '3') {
          throw new WechatClawbotError('invalid_response');
        }
        return new QrAttempt(this.#requester, qrcode, qrPayload);
      },
    });
  }
}
