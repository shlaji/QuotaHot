/**
 * 前后端共享的代理 URL 校验逻辑。
 *
 * 放在 shared/ 而不是 server/http.ts，是为了让前端无需把 undici 打进浏览器包里，
 * 也能即时给出校验提示。前后端必须保持一致，否则就会出现前端放行、后端拒绝的分裂行为。
 */

/** 非法时返回错误信息，合法时返回 null；空字符串表示直连。 */
export function validateProxy(proxy: string): string | null {
  const next = proxy.trim();
  if (!next) return null;

  let url: URL;
  try {
    url = new URL(next);
  } catch {
    return '代理地址必须是带协议的完整 URL，例如 http://127.0.0.1:7897';
  }
  // ProxyAgent 只支持 HTTP CONNECT；socks5:// 虽然能构造成功，但请求时一定会失败
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `不支持的代理协议 ${url.protocol}，只支持 http / https`;
  }
  if (!url.hostname) return '代理地址缺少主机名';
  return null;
}

/**
 * 判断某个 URL 是否应绕过代理并直连，遵循 NO_PROXY 语义：
 *
 *   - `*`                全部绕过
 *   - `example.com`      匹配该主机及其所有子域
 *   - `.example.com`     同上，接受前导点以兼容 NO_PROXY 写法
 *   - `example.com:8443` 仅在端口也匹配时生效
 *
 * 匹配时不区分大小写。无法解析的 URL 永远不会绕过代理，这样错误输入会安全地继续走代理，
 * 而不是悄悄泄漏成直连。
 */
export function shouldBypassProxy(target: string, rules: readonly string[]): boolean {
  if (rules.length === 0) return false;

  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  // URL 会给 IPv6 主机保留方括号；这里去掉，便于规则按更自然的形式书写
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');

  for (const raw of rules) {
    let rule = raw.trim().toLowerCase();
    if (!rule) continue;
    if (rule === '*') return true;

    let rulePort = '';
    const colon = rule.lastIndexOf(':');
    // 结尾的 :数字 视为端口；方括号里的冒号则属于 IPv6 字面量本身
    if (colon > 0 && !rule.slice(colon).includes(']') && /^\d+$/.test(rule.slice(colon + 1))) {
      rulePort = rule.slice(colon + 1);
      rule = rule.slice(0, colon);
    }
    if (rulePort && rulePort !== port) continue;

    const cidr = parseIpv4Cidr(rule);
    if (cidr && isIpv4InCidr(host, cidr)) return true;

    rule = rule.replace(/^\*?\./, '').replace(/^\[|\]$/g, '');
    if (!rule) continue;

    if (host === rule || host.endsWith(`.${rule}`)) return true;
  }
  return false;
}

type Ipv4Cidr = { network: number; mask: number };

function parseIpv4Cidr(value: string): Ipv4Cidr | null {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d|[12]\d|3[0-2])$/.exec(value);
  if (!match) return null;
  const address = parseIpv4(match[1]);
  if (address === null) return null;
  const prefix = Number(match[2]);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { network: address & mask, mask };
}

function isIpv4InCidr(host: string, cidr: Ipv4Cidr): boolean {
  const address = parseIpv4(host);
  return address !== null && (address & cidr.mask) === cidr.network;
}

function parseIpv4(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let address = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    address = ((address << 8) | octet) >>> 0;
  }
  return address;
}
