/**
 * 这台电脑此刻正用着哪个账户。
 *
 * 账户目录里摆着一排账户，可用户在终端里敲 `claude` 或 `codex` 时，用的只是其中一个——
 * 具体哪一个，写在客户端自己的凭证文件里。列表上不标出来，用户就只能靠邮箱去猜，而
 * quotahot-hook 还会在额度用尽时替他换账户，猜就更不作数了。
 *
 * 所以这里反着来：不问「账户跟随哪个客户端」，而是逐个打开本机客户端的凭证文件，问
 * 「它现在登录的是账户目录里的哪一个」。判据用 creds.identityOf，与「改为跟随客户端」
 * 那道核对是同一套——否则会出现「跟随核对不放行、列表却标着本机在用」这种自相矛盾。
 *
 * 结果放在内存里缓存：快照要在每次发送前后重建，让它每回都去读四个文件（其中 Qoder 那个
 * 还要解密一次 SQLite）不值得。真正的核对由 server/main.ts 里的定时任务按配置周期跑，
 * 用户在别处换了账号，最迟一个周期后列表就会跟上。
 */
import { CLIENT_LABELS, fileExists, readClientTokens } from './clientfile.js';
import { clientPath } from './clientpaths.js';
import { QODER_LABELS } from './qoder-paths.js';
import { identityOf, whoOf, type Account } from './creds.js';
import type { ClientUse, Provider } from '../shared/types.js';

/** 一个待核对的客户端：读哪个文件、按哪套字段名解析、里面装的是哪家的账户。 */
interface ClientSlot {
  source: string;
  label: string;
  path: string;
  provider: Provider;
}

/**
 * 本机上会拿账户去干活的客户端，以及它们各自读凭证的位置。
 *
 * 与 clientfile.followSourceOf 同源，只是那边一次只回一个（某账户跟随谁），这边要的是
 * 全体。cli-proxy-api 同样不算：它是另一个程序的账户目录，一个账户一个文件，谁都没在
 * 「用」其中某一个。位置每次现算：clientpaths.ts 里的默认值看的是 homedir() 和 XDG_*，
 * 而用户也可能刚在配置页里把某个客户端指到别处。
 */
function defaultSlots(): ClientSlot[] {
  return [
    { source: 'claude-cli', label: CLIENT_LABELS['claude-cli'], path: clientPath('claude-cli'), provider: 'claude' },
    { source: 'codex-cli', label: CLIENT_LABELS['codex-cli'], path: clientPath('codex-cli'), provider: 'codex' },
    { source: 'opencode', label: CLIENT_LABELS.opencode, path: clientPath('opencode'), provider: 'codex' },
    { source: 'qoder-ide', label: CLIENT_LABELS['qoder-ide'], path: clientPath('qoder-ide'), provider: 'qoder' },
    ...(['qoder-cli', 'qoder-desktop'] as const).map((source): ClientSlot => ({
      source, label: QODER_LABELS[source], path: clientPath(source), provider: 'qoder',
    })),
  ];
}

/**
 * 这一轮要核对哪些文件。
 *
 * 默认位置之外，还得带上账户自己记着的 sync_path：从别处导入的 Codex CLI 可能压根不在
 * ~/.codex 下（CODEX_HOME 改过），只看默认位置就会把用户真正在用的那个客户端漏掉。
 * 同一个路径只核对一次。
 */
function slotsOf(accounts: readonly Account[]): ClientSlot[] {
  const slots = defaultSlots();
  const seen = new Set(slots.map((s) => s.path));
  for (const a of accounts) {
    const source = a.syncSource || a.source;
    if (!a.syncPath || seen.has(a.syncPath) || !CLIENT_LABELS[source]) continue;
    seen.add(a.syncPath);
    slots.push({ source, label: CLIENT_LABELS[source], path: a.syncPath, provider: a.provider });
  }
  return slots;
}

/** 客户端的标识：同一个客户端可能在不同路径上各有一份（改过 CODEX_HOME 就是）。 */
function keyOf(c: { source: string; path: string }): string {
  return `${c.source}@${c.path}`;
}

/**
 * 挨个打开本机客户端的凭证文件，认出它现在用的是哪个账户。
 *
 * 文件不存在就整个跳过：没装 OpenCode 的机器不该在界面上看到一行「OpenCode 读不出凭证」。
 * 文件在、却认不出里面是谁（读不动、或者登录的账户根本没导进来）时仍然记一条，accountId
 * 为空——这不是标记的用武之地，但值得在日志里说一声，那正是「客户端换了个我们不认识的
 * 账号」的样子。
 */
export async function scanClientsInUse(accounts: readonly Account[]): Promise<ClientUse[]> {
  const found: ClientUse[] = [];
  for (const slot of slotsOf(accounts)) {
    if (!(await fileExists(slot.path))) continue;
    const base = { source: slot.source, label: slot.label, path: slot.path };

    const tokens = await readClientTokens(slot.source, slot.path);
    if (!tokens) {
      found.push({ ...base, accountId: '', who: '', error: '读不出这个文件里的令牌' });
      continue;
    }

    // 只跟同一家的账户比：Claude 的令牌和 Codex 的账户之间没有任何可比的身份
    const candidates = accounts.filter((a) => a.provider === slot.provider);
    const mine = candidates.find((a) => identityOf(tokens, a).kind === 'same');
    // 认出来了就报账户目录里的写法，两处显示才是同一个名字；没认出来只好报文件里写着的那个
    const who = mine ? mine.email : whoOf(tokens);
    found.push({ ...base, accountId: mine?.id ?? '', who, error: '' });
  }
  return found;
}

/** 缓存：最近一次核对的结果，快照直接读它。 */
let clients: ClientUse[] = [];
let checkedAt = 0;

/** 本机哪些客户端此刻用着这个账户；从未核对过或没人用它时为空数组。 */
export function clientsUsing(accountId: string): ClientUse[] {
  return clients.filter((c) => c.accountId === accountId);
}

/** 上次核对本机客户端的时刻，毫秒时间戳；从未核对过时为 null。 */
export function lastCheckedAt(): number | null {
  return checkedAt > 0 ? checkedAt : null;
}

/** 核对结果的一处变化，交给调用方写日志。 */
export interface InUseChange {
  /** 变化涉及的账户 id；客户端换到了不认识的账号时为空串。 */
  accountId: string;
  message: string;
}

/** 核对只在测试里需要从头再来一次，正常运行期间缓存只会被 refresh 更新。 */
export function resetClientsInUse(): void {
  clients = [];
  checkedAt = 0;
}

function describe(before: ClientUse | undefined, after: ClientUse): string {
  const was = before?.accountId ? `此前是 ${before.who || before.accountId}` : '';
  if (after.error) return `${after.label}（${after.path}）${after.error}`;
  if (!after.accountId) {
    const who = after.who ? `的是 ${after.who}` : '的账户不在本程序的账户目录里';
    return `${after.label} 现在登录${who}，没有对应的账户${was ? `（${was}）` : ''}`;
  }
  return `${after.label} 现在用的是 ${after.who}${was ? `（${was}）` : ''}`;
}

/**
 * 重新核对一遍，并报出与上一次的差异。
 *
 * 差异按「客户端」算而不是按「账户」算：用户关心的是「Claude Code 换人了」，一次换人在
 * 账户那头是两条（一个不再被用、另一个开始被用），合成一句才读得下去。客户端从本机消失
 * （卸载、凭证文件被删）也报一句，否则列表上的标记会静悄悄地没掉。
 */
export async function refreshClientsInUse(
  accounts: readonly Account[],
): Promise<{ clients: ClientUse[]; changes: InUseChange[] }> {
  const next = await scanClientsInUse(accounts);
  const previous = new Map(clients.map((c) => [keyOf(c), c]));
  const changes: InUseChange[] = [];

  for (const after of next) {
    const key = keyOf(after);
    const before = previous.get(key);
    previous.delete(key);
    // 同一个客户端、同一个账户、同样读得动，就没什么可说的
    if (before && before.accountId === after.accountId && before.error === after.error) continue;
    changes.push({ accountId: after.accountId, message: describe(before, after) });
  }
  for (const gone of previous.values()) {
    if (!gone.accountId && !gone.error) continue;
    changes.push({
      accountId: gone.accountId,
      message: `${gone.label} 的凭证文件 ${gone.path} 已经不在了，不再算这台电脑在用的账户`,
    });
  }

  clients = next;
  checkedAt = Date.now();
  return { clients: next, changes };
}
