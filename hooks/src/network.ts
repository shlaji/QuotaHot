import { Agent, ProxyAgent, type Dispatcher } from 'undici';

export type NetworkConfig = {
  readonly proxy: string;
  readonly noProxy: readonly string[];
};

export function proxyError(proxy: string): string | null {
  const trimmed = proxy.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? null : 'invalid_proxy';
  } catch {
    return 'invalid_proxy';
  }
}

function bypasses(target: string, rules: readonly string[]): boolean {
  const url = new URL(target);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  for (const rawRule of rules) {
    let rule = rawRule.trim().toLowerCase();
    if (rule === '*') return true;
    const portMatch = /:(\d+)$/.exec(rule);
    if (portMatch?.[1] !== undefined) {
      if (portMatch[1] !== port) continue;
      rule = rule.slice(0, -portMatch[0].length);
    }
    rule = rule.replace(/^\*?\./, '').replace(/^\[|\]$/g, '');
    if (rule && (host === rule || host.endsWith(`.${rule}`))) return true;
  }
  return false;
}

export function dispatcherFor(target: string, network: NetworkConfig): Dispatcher {
  const proxy = network.proxy.trim();
  return proxy && !bypasses(target, network.noProxy)
    ? new ProxyAgent({ uri: proxy, allowH2: false, requestTls: { allowH2: false } })
    : new Agent({ allowH2: false });
}
