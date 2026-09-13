export type QuotaSignalKind = 'status_429' | 'quota_phrase';

export function classifyQuotaSignal(payload: unknown): QuotaSignalKind | null {
  const root = payload !== null && typeof payload === 'object' ? payload : null;
  const nestedEvent = root === null ? undefined : Reflect.get(root, 'event');
  const event = nestedEvent ?? payload;
  const properties = event !== null && typeof event === 'object' ? Reflect.get(event, 'properties') : undefined;
  const retryStatus = properties !== null && typeof properties === 'object' ? Reflect.get(properties, 'status') : undefined;
  const propertyError = properties !== null && typeof properties === 'object' ? Reflect.get(properties, 'error') : undefined;
  const eventError = event !== null && typeof event === 'object' ? Reflect.get(event, 'error') : undefined;
  const rootError = root === null ? undefined : Reflect.get(root, 'error');
  const error = propertyError ?? eventError ?? rootError;
  const errorData = error !== null && typeof error === 'object' ? Reflect.get(error, 'data') : undefined;
  const retryError = retryStatus !== null && typeof retryStatus === 'object' ? Reflect.get(retryStatus, 'error') : undefined;

  for (const value of [event, error, errorData, retryError]) {
    if (value === null || typeof value !== 'object') continue;
    const status = Reflect.get(value, 'statusCode') ?? Reflect.get(value, 'status');
    if (status === 429 || status === '429') return 'status_429';
  }

  const phrase = /\brate[ _-]?limit(?:_exceeded| exceeded|ed)?\b|\busage[ _-]limit(?:[ _-]reached| has been reached)?\b|\bquota(?:[ _-](?:exhausted|exceeded)| has been exhausted)\b|\btoo many requests\b|you'?ve (?:hit|reached) your|\binsufficient_quota\b|\bresets? (?:at|in)\b/i;
  for (const value of [event, error, errorData, retryStatus, retryError]) {
    if (value === null || typeof value !== 'object') continue;
    for (const key of ['message', 'code']) {
      const text = Reflect.get(value, key);
      if (typeof text === 'string' && phrase.test(text)) return 'quota_phrase';
    }
  }
  return null;
}
