import { Agent, ProxyAgent, interceptors, type Dispatcher } from 'undici';
import { shouldBypassProxy, validateProxy } from '../../shared/proxy.js';

export { validateProxy };
let currentProxy = '';
let currentBypass: string[] = [];
function agent(proxy: string): { readonly follow: Dispatcher; readonly manual: Dispatcher } {
  const base = proxy ? new ProxyAgent(proxy) : new Agent();
  return { follow: base.compose(interceptors.redirect({ maxRedirections: 3 })), manual: base };
}
let dispatcher = agent('');
const direct = agent('');
export function getProxy(): string { return currentProxy; }
export function getBypass(): string[] { return [...currentBypass]; }
export function setProxy(proxy: string, bypass: readonly string[] = []): void {
  const next = proxy.trim();
  const nextBypass = bypass.map((rule) => rule.trim()).filter(Boolean);
  if (next === currentProxy && nextBypass.join(',') === currentBypass.join(',')) return;
  currentBypass = nextBypass;
  if (next === currentProxy) return;
  const error = validateProxy(next);
  if (error) throw new Error(error);
  const created = agent(next);
  const previous = dispatcher;
  dispatcher = created;
  currentProxy = next;
  previous.manual.close().catch(() => {});
}
export function dispatcherFor(url: string, follow: boolean): Dispatcher {
  const route = currentProxy && shouldBypassProxy(url, currentBypass) ? direct : dispatcher;
  return follow ? route.follow : route.manual;
}
