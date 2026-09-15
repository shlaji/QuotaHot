/**
 * 转发的编排：把一条归一化后的请求，交给池子里某个还能接活的账户。
 *
 * 重试换的是**账户**，不是把同一个账户再试一遍：客户端自己会对网络抖动重试，而我们能做
 * 而它做不到的事，只有「换一份还有额度的凭证」。因此重试只发生在**流还没开始**之前——
 * 一旦上游回了 200 并开始吐字，客户端已经收到了半句话，这时候换账户只会让它看到两段
 * 拼不起来的回答。
 */
import { ensureFresh, type Account } from '../creds.js';
import { GatewayPool, blamesAccount, isForwardable } from './pool.js';
import { UpstreamError, forward } from './upstream.js';
import { qoderTierFor } from './qoder.js';
import type { AnthropicRequest, EventStream } from './anthropic.js';
import type { AppConfig, Provider } from '../../shared/types.js';
import { needsPat } from '../../shared/gateway.js';
import type { GatewayConfig } from '../../shared/gateway.js';
import type { AccountState, Store } from '../store.js';

/** 网关要用到的外部能力；全部由 main.ts 注入，好让这一层在测试里不必启动服务。 */
export interface GatewayDeps {
  store: Store;
  pool: GatewayPool;
  accounts: () => Promise<Account[]>;
  states: () => Map<string, AccountState>;
  config: () => AppConfig;
  log: (level: 'info' | 'warn' | 'error', message: string, accountId?: string) => void;
  /** 账户状态变了，通知界面刷新一次卡片。 */
  changed: () => void;
}

/** 没有账户能接这次活。分开成一个类型，是因为它该回 503 而不是 500。 */
export class NoAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoAccountError';
  }
}

/**
 * 模型名属于哪一家。
 *
 * 允许客户端用 `claude/xxx`、`codex/xxx`、`qoder/xxx` 明确指定，剩下的按名字猜——三家的命名
 * 区分度足够高，猜错的成本也只是被下面的 crossProvider 判定挡回去。认不出来时返回 null，
 * 由调用方按池子里有什么来决定。
 *
 * 注意 opus/sonnet/haiku 归到 claude 而不是 qoder:它们是 Anthropic 的原生命名,优先走 Claude
 * 账户;要用 Qoder 顶这类流量得开 crossProvider,或直接点名 `qoder/...` 或 Qoder 档位名。
 */
export function providerFor(model: string): Provider | null {
  const name = model.trim().toLowerCase();
  if (name.startsWith('claude/') || name.startsWith('anthropic/')) return 'claude';
  if (name.startsWith('codex/') || name.startsWith('openai/')) return 'codex';
  if (name.startsWith('qoder/')) return 'qoder';
  // Qoder 的原生档位名:点名这些就是明确要走 Qoder,和 crossProvider 无关
  if (['auto', 'ultimate', 'performance', 'efficient', 'lite'].includes(name)) return 'qoder';
  if (name.includes('claude') || name.includes('sonnet') || name.includes('opus') || name.includes('haiku')) {
    return 'claude';
  }
  if (name.includes('gpt') || name.includes('codex') || /\bo[1-4]\b/.test(name)) return 'codex';
  return null;
}

/** 去掉 `claude/` 这类前缀，留下真正要发给上游的模型名。 */
function bareModel(model: string): string {
  const slash = model.indexOf('/');
  return slash === -1 ? model.trim() : model.slice(slash + 1).trim();
}

/**
 * 这次要发给上游的模型名。
 *
 * 客户端点名的模型属于目标账户这一家时原样用；跨家转发时它那个名字在这边根本不存在，
 * 只能落到本程序配置里的默认模型——配置项本来就是用户自己挑的，比我们硬编一张映射表可靠。
 *
 * Qoder 是个例外:它没有「配置的默认模型」,而是把 Anthropic 档次(opus/sonnet/haiku)按能力映
 * 射到自己的档位(ultimate/performance/efficient)。所以直接把客户端的原名交给 qoderTierFor,
 * 回报给客户端时用映射后的档位 key。
 */
export function resolveModel(model: string, target: Provider, cfg: AppConfig): string {
  if (target === 'qoder') return qoderTierFor(model).key;
  const bare = bareModel(model);
  return providerFor(model) === target && bare !== '' ? bare : cfg.models[target];
}

/**
 * 这次请求按顺序可以试哪几家 provider。
 *
 * crossProvider 关着时只试客户端点名的那一家;开着时按「点名那家优先、其余兜底」排。Qoder 顶
 * Claude/Codex 流量算跨家(模型能力和计费都不同),所以同样受 crossProvider 约束;但客户端直接
 * 点名 Qoder 档位时 wanted 就是 qoder,不受影响。
 */
function providerOrder(model: string, gateway: GatewayConfig): Provider[] {
  const all: Provider[] = ['claude', 'codex', 'qoder'];
  const wanted = providerFor(model);
  if (wanted === null) return gateway.crossProvider ? all : ['claude', 'codex'];
  if (!gateway.crossProvider) return [wanted];
  return [wanted, ...all.filter((p) => p !== wanted)];
}

export interface ForwardOutcome {
  account: Account;
  /** 实际发给上游的模型名，回给客户端时用它，免得它看到一个自己没点过的名字。 */
  model: string;
  events: EventStream;
}

/**
 * 边转发边记账。
 *
 * usage 分散在 message_start 和 message_delta 两个事件里，顺手在这里收下来——记账要用，
 * 而且这是唯一一处既能看到全部事件、又不必把流缓存下来的地方。
 *
 * 客户端中途断开会让这个生成器被 `return()` 掉，finally 因此也要负责收尾：不然那个账户的
 * 在飞计数会永远停在 1，界面上看就是一个再也闲不下来的账户。
 */
async function* accounted(
  deps: GatewayDeps,
  account: Account,
  events: EventStream,
  gateway: GatewayConfig,
): EventStream {
  let inputTokens = 0;
  let outputTokens = 0;
  let settled = false;
  const finish = (error: string): void => {
    if (settled) return;
    settled = true;
    if (error === '') deps.pool.succeed(account.id, inputTokens, outputTokens);
    // 流开起来之后再断，是链路问题而不是这份凭证的问题，因此不记进失败预算
    else deps.pool.fail(account.id, error, false, gateway);
    deps.changed();
  };

  try {
    for await (const evt of events) {
      try {
        const payload = JSON.parse(evt.data) as Record<string, unknown>;
        const usage = (payload.usage ?? (payload.message as Record<string, unknown> | undefined)?.usage ?? {}) as Record<string, unknown>;
        if (usage.input_tokens !== undefined) inputTokens = Number(usage.input_tokens) || inputTokens;
        if (usage.output_tokens !== undefined) outputTokens = Number(usage.output_tokens) || outputTokens;
      } catch {
        /* 记账读不出来不影响转发，继续把事件交给客户端 */
      }
      yield evt;
    }
    finish('');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log('warn', `转发中断: ${message}`, account.id);
    finish(message);
    throw err;
  } finally {
    // 客户端提前离开时上面的 for 会被直接终止，两个分支都没走到
    finish('客户端提前断开');
  }
}

/**
 * 选一个账户并把请求发出去。
 *
 * 返回的是**已经开始的**事件流：上游的第一个字节到了才算这一轮成功，在那之前的任何失败
 * 都还有机会换个账户重来。
 */
export async function runForward(
  deps: GatewayDeps,
  request: AnthropicRequest,
  opts: { betas?: string[]; signal?: AbortSignal } = {},
): Promise<ForwardOutcome> {
  const cfg = deps.config();
  const gateway = cfg.gateway;
  const accounts = (await deps.accounts()).filter((a) => isForwardable(a.provider));
  const states = deps.states();
  const tried = new Set<string>();
  const failures: string[] = [];

  for (let attempt = 0; attempt < Math.max(1, gateway.maxAttempts); attempt++) {
    let account: Account | null = null;
    let target: Provider | null = null;
    for (const provider of providerOrder(request.model, gateway)) {
      account = deps.pool.pick(accounts, states, gateway, provider, tried);
      if (account) {
        target = provider;
        break;
      }
    }
    if (!account || !target) break;

    tried.add(account.id);
    const model = resolveModel(request.model, target, cfg);
    deps.pool.begin(account.id);
    deps.changed();

    try {
      // Qoder 转发不看导入登录那份令牌,而看账户页面单独设的 PAT;别的 provider 才需要 ensureFresh
      let qoder: { pat: string; machineId: string } | undefined;
      if (needsPat(account.provider)) {
        const row = deps.store.gatewayAccount(account.id);
        if (!row || !row.pat) throw new UpstreamError(401, `${account.email} 未设置 Qoder PAT`);
        qoder = { pat: row.pat, machineId: row.machineId };
      } else if (!(await ensureFresh(account, (level, message) => deps.log(level, message, account!.id)))) {
        throw new UpstreamError(401, `${account.email} 的令牌不可用`);
      }
      const events = await forward(account, request, { model, betas: opts.betas, qoder, signal: opts.signal });
      deps.log('info', `转发 ${model} → ${account.email}`, account.id);
      return { account, model, events: accounted(deps, account, events, gateway) };
    } catch (err) {
      const status = err instanceof UpstreamError ? err.status : 0;
      const message = err instanceof Error ? err.message : String(err);
      deps.pool.fail(account.id, message, blamesAccount(status), gateway);
      deps.changed();
      deps.log('warn', `转发失败，换下一个账户: ${message}`, account.id);
      failures.push(`${account.email}: ${message}`);
      // 请求体本身不合法时换谁都一样，没必要把整池账户挨个试一遍
      if (status === 400) throw err;
    }
  }

  throw new NoAccountError(
    failures.length > 0
      ? `账号池里的账户都没能完成这次请求：${failures.join('；')}`
      : '账号池里没有可用于转发的账户：请在账户卡片上打开「API 服务」，并确认它没有在冷却或耗尽',
  );
}
