type BrowserCrypto = Pick<Crypto, 'getRandomValues'> &
  Partial<Pick<Crypto, 'randomUUID'>>;

export function generateApiKey(cryptoApi: BrowserCrypto = globalThis.crypto): string {
  const uuid = cryptoApi.randomUUID?.();
  if (uuid) return `qh-${uuid.replace(/-/g, '')}`;

  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `qh-${hex}`;
}
