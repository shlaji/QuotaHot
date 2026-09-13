export function codexHeaders(accessToken: string, accountId: string): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    accept: 'application/json',
    'content-type': 'application/json',
    referer: 'https://chatgpt.com/',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    'openai-beta': 'codex-1',
    'oai-language': 'zh-CN',
    originator: 'Codex Desktop',
    'sec-fetch-site': 'none',
    'sec-fetch-mode': 'no-cors',
    'sec-fetch-dest': 'empty',
    priority: 'u=4, i',
  };
  if (accountId) headers['chatgpt-account-id'] = accountId;
  return headers;
}

export function claudeHeaders(accessToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'user-agent': 'axios/1.15.2',
    'accept-encoding': 'gzip, compress, deflate, br',
    connection: 'close',
    'cache-control': 'no-cache',
    'anthropic-beta': 'oauth-2025-04-20',
  };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  return headers;
}
