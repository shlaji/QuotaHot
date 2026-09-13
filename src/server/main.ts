/** HTTP 入口：提供 REST API、实时 SSE 推送，以及生产环境下的静态前端托管。 */
import { serve } from '@hono/node-server';
import { accessGuard, webCredentials } from './access.js';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadAccounts,
  ensureFresh,
  refreshViaOAuth,
  deleteAccount,
  checkFollowClient,
  setAutoRefresh,
  type Account,
} from './creds.js';
import { syncToClient } from './clientsync.js';
import { catalogFor, clearCatalogCache } from './catalog.js';
import { importFrom, importIfEmpty, scanSources } from './import.js';
import { cancelLogin, completeLogin, loginStatus, startLogin } from './oauth.js';
import { refreshAccountUsage, refreshUsage } from './refresh.js';
import { Store } from './store.js';
import { Scheduler, selectAccounts, selectSchedulable } from './scheduler.js';
import * as bus from './bus.js';
import * as cfgMod from './config.js';
import { EMBEDDED_ASSETS } from './assets.js';
import { setAuditSink, setProxy, validateProxy, getProxy, getBypass } from './http.js';
import type {
  AppConfig,
  AutoRefreshResult,
  ForceRefreshResult,
  RequestLogPage,
  StateResponse,
} from '../shared/types.js';
import { APP_VERSION } from '../version.js';

const PORT = Number(process.env.PORT ?? 8686);
const HOST = process.env.QUOTAHOT_HOST || '127.0.0.1';

const store = new Store(cfgMod.DB_PATH);
// 出站层负责记账，这里把它接到库上；两者解耦后测试可以完全不碰数据库
setAuditSink({
  record: (accountId, sentAt, req, status, durationMs, error) =>
    store.recordRequest(accountId, sentAt, req, status, durationMs, error),
  update: (rowId, error) => store.updateRequestError(rowId, error),
  updateResponse: (rowId, response) => store.updateRequestResponse(rowId, response),
});
const config: AppConfig = cfgMod.loadConfig();
const webAuth = webCredentials();
try {
  setProxy(config.proxy, config.noProxy);
} catch (err) {
  // 即使代理配置有问题也先启动，保证界面可访问，并允许用户在界面里修正
  console.error(`代理配置无效，已忽略: ${(err as Error).message}`);
}
const scheduler = new Scheduler(store, config);

// 首次运行时把 cli-proxy-api 的账户搬进自己的目录，让升级上来的用户不必先手动导入。
// 不挡在启动前面：迁移只在首次运行时真的做事，而顶层 await 会挡住 CommonJS 打包。
// 界面可能比迁移先一步打开，因此完成后补推一次账户列表。
void importIfEmpty(cfgMod.ACCOUNTS_DIR)
  .then(async (migrated) => {
    if (!migrated) return;
    console.log(
      `已从 ${cfgMod.CLI_PROXY_API_DIR} 导入 ${migrated.imported.length} 个账户到 ${cfgMod.ACCOUNTS_DIR}`,
    );
    bus.emit({ type: 'accounts', accounts: await scheduler.snapshot() });
  })
  .catch((err) => console.error(`导入 cli-proxy-api 账户失败: ${String(err)}`));

const app = new Hono();
app.use('*', accessGuard(webAuth));
const api = new Hono();

api.get('/state', async (c) => {
  const body: StateResponse = {
    version: APP_VERSION,
    scheduler: scheduler.status(),
    accounts: await scheduler.snapshot(),
    config: scheduler.getConfig(),
    accountsDir: cfgMod.ACCOUNTS_DIR,
    proxy: getProxy(),
    noProxy: getBypass(),
  };
  return c.json(body);
});

api.get('/config', (c) => c.json(scheduler.getConfig()));

api.put('/config', async (c) => {
  const raw = await c.req.json();
  const next = cfgMod.normalize(raw);
  // 这里校验原始请求体：如果先走 normalize()，错误时间会被默认值悄悄替换掉
  const err = cfgMod.validateSchedule(raw) ?? validateProxy(next.proxy);
  if (err) return c.json({ error: err }, 400);

  // 运行中改配置只影响下一拍，不会中断当前这次等待
  scheduler.setConfig(next);
  await cfgMod.saveConfig(next);
  bus.emit({ type: 'scheduler', status: scheduler.status() });
  return c.json(next);
});

/**
 * 启动调度。
 * 不传 ids（或传空数组）表示纳入全部可保活账户；传了就只跑这几个。
 */
api.post('/scheduler/start', async (c) => {
  const body = await c.req.json<{ ids?: unknown }>().catch(() => ({}) as { ids?: unknown });
  const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
  await scheduler.start(ids);
  return c.json(scheduler.status());
});

api.post('/scheduler/stop', async (c) => {
  await scheduler.stop();
  return c.json(scheduler.status());
});

/**
 * 某个账户最近真实发出的上游请求，用于在界面上还原成 curl。
 *
 * 日志行原样返回，令牌仍是占位符——界面上要展示的就是这一份，屏幕和截图里
 * 都不会出现真令牌。真令牌单独放在 `secrets` 里，前端只在用户点“复制”时才拿它
 * 把占位符换回去。给之前先 ensureFresh 一次，所以复制出去的 curl 立刻就能重发。
 */
api.get('/accounts/:id/requests', async (c) => {
  const id = decodeURIComponent(c.req.param('id'));
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50) || 50));
  const rows = store.accountRequests(id, limit);
  const empty: RequestLogPage = { rows, secrets: { accessToken: '' } };
  if (rows.length === 0) return c.json(empty);

  // 这条路由只是“看日志”，不该因为凭证出问题就整个失败：刷新失败也好、
  // 账户文件读不动也好，都退回占位符继续把日志给出去。
  try {
    const account = (await loadAccounts(cfgMod.ACCOUNTS_DIR)).find((a) => a.id === id);
    if (account && (await ensureFresh(account, () => {}))) {
      const page: RequestLogPage = {
        rows,
        secrets: { accessToken: account.accessToken, refreshToken: account.refreshToken },
      };
      return c.json(page);
    }
  } catch (err) {
    console.error(`读取 ${id} 的当前令牌失败，复制出的 curl 会保留占位符: ${String(err)}`);
  }
  return c.json(empty);
});

/** 单个账户的额度查询。与整体刷新同源，因此卡片数据不会出现两套口径。 */
api.post('/accounts/:id/usage', async (c) => {
  const cfg = scheduler.getConfig();
  try {
    setProxy(cfg.proxy, cfg.noProxy);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
  const result = await refreshAccountUsage(store, decodeURIComponent(c.req.param('id')));
  if (result === null) return c.json({ error: '找不到该账户' }, 404);
  bus.emit({ type: 'accounts', accounts: await scheduler.snapshot() });
  return c.json(result);
});

api.post('/accounts/:id/send-now', async (c) => {
  const result = await scheduler.sendNow(decodeURIComponent(c.req.param('id')));
  return c.json(result);
});

/**
 * 批量“测试文本”：对选中的账户逐个真发一次，和单卡片上的按钮完全同一条路径。
 * 不传 ids 表示对全部账户执行。注意每个账户都会因此打开一个 5 小时窗口。
 */
api.post('/send-now', async (c) => {
  const body = await c.req.json<{ ids?: string[] }>().catch(() => ({}) as { ids?: string[] });
  const cfg = scheduler.getConfig();
  // 只发给会被调度的账户：Qoder 传进来也只会得到一条“不发送”的失败结果
  const all = selectSchedulable(await loadAccounts(cfgMod.ACCOUNTS_DIR), cfg).map((a) => a.id);
  const ids = body.ids && body.ids.length > 0 ? all.filter((id) => body.ids!.includes(id)) : all;
  return c.json(await scheduler.sendNowMany(ids));
});

/**
 * 额度查询：向每家上游查询当前计数器状态。
 * 不调模型、不消耗 token，也不会打开 5 小时窗口，因此任何时候都可以安全点击。
 * 不传 ids 表示查全部账户。
 */
api.post('/usage', async (c) => {
  const body = await c.req.json<{ ids?: string[] }>().catch(() => ({}) as { ids?: string[] });
  const cfg = scheduler.getConfig();
  try {
    setProxy(cfg.proxy, cfg.noProxy);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
  const results = await refreshUsage(store, cfg, body.ids);
  // 卡片上的数字来自 store，因此刷新完要把最新快照主动推给前端
  bus.emit({ type: 'accounts', accounts: await scheduler.snapshot() });
  return c.json(results);
});

/** 列出本机可导入的凭证来源；只返回邮箱和过期时间，不含任何令牌内容。 */
api.get('/accounts/sources', async (c) => c.json(await scanSources()));

api.post('/accounts/import', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { sources?: unknown };
  const sources = Array.isArray(body.sources) ? body.sources.map(String) : [];
  try {
    const result = await importFrom(cfgMod.ACCOUNTS_DIR, sources);
    bus.emit({ type: 'accounts', accounts: await scheduler.snapshot() });
    return c.json(result);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

/**
 * 切换某个账户的续期方式。
 *
 * 关掉 autoRefresh 即“跟随客户端”：本程序只用同步过来的令牌查接口，不再拿 refresh_token
 * 去换新的——从 Claude Code 这类客户端同步进来的账户默认就是这个模式，续期由它自己负责，
 * 两边同时刷新会互相把对方的凭证顶掉。
 *
 * 无论往哪个方向切，都先做同一道身份核对：本机那个客户端（Claude 是
 * ~/.claude/.credentials.json，Codex 是 ~/.codex/auth.json，Qoder 是它的 state.vscdb）
 * 现在登录的还是这个账户吗。两个方向要的结论不一样，所以处置也不同：
 *
 * - 改为跟随：对不上就不给切。客户端换了账号还去跟随它，就会一路把别人的令牌同步进来，
 *   卡片显示 A 却在查 B 的额度。核对通过则把定位到的那个文件一并记进账户文件，
 *   跟随才真的有处可取——早期导入的账户没有 sync_path，靠的正是这一步补上。
 * - 改为自动刷新：对得上反而要提醒。客户端手里那份和我们是同一份登录，本程序一刷新
 *   它就作废了，用户下次打开客户端得重新登录。这只是提醒，不拦——客户端已经换成别的
 *   账户时，改为自动刷新恰恰是让这个账户不再被别人的令牌顶掉的办法。
 */
api.patch('/accounts/:id', async (c) => {
  const id = decodeURIComponent(c.req.param('id'));
  const body = (await c.req.json().catch(() => ({}))) as { autoRefresh?: unknown };
  if (typeof body.autoRefresh !== 'boolean') return c.json({ error: '需要 autoRefresh 布尔值' }, 400);

  const account = (await loadAccounts(cfgMod.ACCOUNTS_DIR)).find((a) => a.id === id);
  if (!account) return c.json({ error: '找不到该账户' }, 404);
  // Qoder 根本没有 refresh 端点（见 creds.ensureFresh：它一律回 IDE 的库里重读），
  // 允许切到自动刷新只会在界面上摆出一个并不存在的模式
  if (body.autoRefresh && account.provider === 'qoder') {
    return c.json(
      { error: 'Qoder 没有可用的 refresh 端点，只能跟随 Qoder IDE 续期；令牌失效后请在 IDE 里重新登录' },
      400,
    );
  }

  const check = await checkFollowClient(account);
  let note = '';
  if (!body.autoRefresh) {
    if (!check.ok) return c.json({ error: `不能跟随这个客户端：${check.reason}` }, 400);
    await setAutoRefresh(account, false, { source: check.source, path: check.path });
    note = `已核对 ${check.label} 上登录的就是这个账户，之后从 ${check.path} 取新令牌`;
  } else {
    await setAutoRefresh(account, true);
    note = check.ok
      ? `注意：${check.label} 上登录的还是这个账户，本程序刷新后它手里那份会立刻失效，需要时用「同步账户」写回去`
      : '';
  }
  bus.emit({ type: 'accounts', accounts: await scheduler.snapshot() });
  const result: AutoRefreshResult = { id, autoRefresh: body.autoRefresh, note };
  return c.json(result);
});

/**
 * 手动更新 token：无条件拿 refresh_token 去换一份新的。
 *
 * 与自动续期唯一的差别是跳过“离过期还早”那道判断——手动点它的场景恰恰是令牌名义上没过期、
 * 实际已经不好使了。刷新请求本身照例走出站层，因此在这个账户的请求日志里能看到完整的一条
 * （正文里的 refresh_token 是占位符），过程和结果另外写进应用日志。
 *
 * 只对自动刷新的账户开放：跟随客户端的账户一旦在这里换了令牌，原客户端手里那份立刻作废，
 * 用户下次打开 Claude Code 就得重新登录——那正是跟随模式要避免的事。
 */
api.post('/accounts/:id/refresh-token', async (c) => {
  const id = decodeURIComponent(c.req.param('id'));
  const cfg = scheduler.getConfig();
  try {
    setProxy(cfg.proxy, cfg.noProxy);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  const account = (await loadAccounts(cfgMod.ACCOUNTS_DIR)).find((a) => a.id === id);
  if (!account) return c.json({ error: '找不到该账户' }, 404);
  if (account.provider === 'qoder') {
    return c.json({ error: 'Qoder 没有可用的 refresh 端点，请在 Qoder IDE 里重新登录后再同步进来' }, 400);
  }
  if (!account.autoRefresh) {
    return c.json(
      { error: '这个账户是跟随客户端模式：强制刷新会把原客户端手里的令牌顶掉，要刷请先改为自动刷新' },
      400,
    );
  }

  const log = (level: 'info' | 'warn' | 'error', msg: string) => scheduler.log(level, id, msg);
  const before = account.expiresAt;
  log('info', `手动更新 token（原有效期至 ${before ? new Date(before).toLocaleString() : '未知'}）`);
  const ok = await refreshViaOAuth(account, log);
  if (ok) scheduler.adoptTokens(account);
  bus.emit({ type: 'accounts', accounts: await scheduler.snapshot() });
  if (!ok) return c.json({ error: '刷新失败，原因见日志面板和该账户的请求日志' }, 502);

  const result: ForceRefreshResult = { accountId: id, expiresAt: account.expiresAt };
  return c.json(result);
});

/**
 * 把当前令牌写回该账户对应的客户端配置文件。
 *
 * 这是导入的反向操作：在本程序里登录或刷新之后，让 Claude Code、Codex CLI、OpenCode 直接
 * 用上这份令牌。动的是用户自己的文件，因此覆盖前先备份，只改令牌那几个键，并把每一处改动
 * 都写进日志——用户必须能从日志里看出自己的配置文件被改了哪里，而不是只看到一句“同步成功”。
 *
 * 一个账户可能对应好几个文件（Codex 就是两个），其中一个写不进去不影响其余的：逐个报结果，
 * 全都失败时才算这次同步失败。
 */
api.post('/accounts/:id/sync-to-client', async (c) => {
  const id = decodeURIComponent(c.req.param('id'));
  const account = (await loadAccounts(cfgMod.ACCOUNTS_DIR)).find((a) => a.id === id);
  if (!account) return c.json({ error: '找不到该账户' }, 404);

  const log = (level: 'info' | 'warn' | 'error', msg: string) => scheduler.log(level, id, msg);
  try {
    const results = await syncToClient(account);
    for (const result of results) {
      if (result.error) {
        log('error', `写入 ${result.label} 的配置文件 ${result.path} 失败: ${result.error}`);
      } else if (result.changes.length === 0) {
        log('info', `${result.path} 里已经是这份令牌，未做改动`);
      } else {
        log(
          'info',
          `${result.created ? '已新建' : '已更新'} ${result.label} 的配置文件 ${result.path}，共 ${result.changes.length} 处改动` +
            (result.backupPath ? `（原文件已备份为 ${result.backupPath}）` : ''),
        );
        // 逐项列出来：只报一句“已更新”，用户没法判断自己的文件被动了什么
        for (const ch of result.changes) log('info', `  ${ch.field}: ${ch.before} → ${ch.after}`);
      }
      if (result.warning) log('warn', result.warning);
    }
    if (results.every((r) => r.error)) {
      return c.json({ error: results.map((r) => `${r.label}: ${r.error}`).join('；') }, 400);
    }
    return c.json(results);
  } catch (err) {
    const message = (err as Error).message;
    log('error', `同步账户失败: ${message}`);
    return c.json({ error: message }, 400);
  }
});

api.delete('/accounts/:id', async (c) => {
  const id = decodeURIComponent(c.req.param('id'));
  const account = (await loadAccounts(cfgMod.ACCOUNTS_DIR)).find((a) => a.id === id);
  if (!account) return c.json({ error: '找不到该账户' }, 404);
  await deleteAccount(account.path);
  bus.emit({ type: 'accounts', accounts: await scheduler.snapshot() });
  return c.json({ removed: id });
});

/**
 * 登录：先取授权链接，用户在浏览器里完成授权。
 * Codex 的回调能被本机 1455 端口接住，接住了就自动收尾；接不住时用户把最终地址粘回来。
 * Qoder 走设备码：链接发出去后由服务端后台轮询上游收尾，用户不需要粘贴任何东西。
 * Codex 也可以显式要求走设备码（mode='device'）：界面显示一串验证码，用户在任意设备上
 * 输入即可，同样由服务端轮询收尾——浏览器和这个进程不在同一台机器上时用它。
 * 授权本身在浏览器里进行，这个进程不接触用户的账号密码。
 */
api.post('/login/start', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { provider?: unknown; mode?: unknown };
  const provider =
    body.provider === 'claude' || body.provider === 'codex' || body.provider === 'qoder'
      ? body.provider
      : null;
  if (!provider) return c.json({ error: '需要指定 claude、codex 或 qoder' }, 400);
  const mode = body.mode === 'device' ? 'device' : 'redirect';
  if (mode === 'device' && provider !== 'codex') {
    return c.json({ error: '只有 Codex 支持设备码登录' }, 400);
  }
  const cfg = scheduler.getConfig();
  try {
    // 授权码交换要经过同一条出站链路，因此先把代理应用上
    setProxy(cfg.proxy, cfg.noProxy);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
  // 监听路径在浏览器那边收尾，没有请求可以借力推送，因此这里预先挂一个回调
  const notify = () => void scheduler.snapshot().then((accounts) => bus.emit({ type: 'accounts', accounts }));
  try {
    return c.json(await startLogin(provider, cfgMod.ACCOUNTS_DIR, notify, mode));
  } catch (err) {
    // 设备码要先向上游申请，这一步可能当场失败（网络、代理），得把原因交回界面
    return c.json({ error: (err as Error).message }, 400);
  }
});

/** 开了本地监听时，登录是在浏览器那边收尾的，前端靠轮询这里知道结果。 */
api.get('/login/status', (c) => c.json(loginStatus(c.req.query('loginId') ?? '')));

/** 主动放弃一次登录，好把 1455 端口立刻还给官方 CLI，而不是干等十分钟过期。 */
api.post('/login/cancel', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { loginId?: unknown };
  cancelLogin(String(body.loginId ?? ''));
  return c.json({ ok: true });
});

api.post('/login/complete', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { loginId?: unknown; input?: unknown };
  try {
    const id = await completeLogin(cfgMod.ACCOUNTS_DIR, String(body.loginId ?? ''), String(body.input ?? ''));
    bus.emit({ type: 'accounts', accounts: await scheduler.snapshot() });
    return c.json({ accountId: id });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

/**
 * 模型下拉框的选项：按账户向上游要真正可用的列表。
 * 每个 provider 用一个账户问就够了——同一家的目录对同账户类型是一样的。
 * `?refresh=1` 跳过缓存，供界面上的“刷新”用。
 */
api.get('/models', async (c) => {
  const cfg = scheduler.getConfig();
  try {
    setProxy(cfg.proxy, cfg.noProxy);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
  if (c.req.query('refresh')) clearCatalogCache();

  const accounts = selectAccounts(await loadAccounts(cfgMod.ACCOUNTS_DIR), cfg);
  const pick = async (provider: 'claude' | 'codex'): Promise<Account | null> => {
    for (const a of accounts) {
      // 目录接口也要带有效令牌，因此先确保这个账户是活的
      if (a.provider === provider && (await ensureFresh(a, () => {}))) return a;
    }
    return null;
  };

  const [claude, codex] = await Promise.all([
    pick('claude').then((a) => catalogFor('claude', a)),
    pick('codex').then((a) => catalogFor('codex', a)),
  ]);
  return c.json({ claude, codex });
});

api.get('/logs', (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 200) || 200, 1000);
  return c.json(store.recentLogs(limit));
});


/** SSE：把日志和状态变化实时推给前端，避免轮询。 */
api.get('/events', (c) =>
  streamSSE(c, async (stream) => {
    let closed = false;
    const queue: string[] = [];
    let wake: (() => void) | null = null;

    const unsubscribe = bus.subscribe((event) => {
      queue.push(JSON.stringify(event));
      wake?.();
    });

    stream.onAbort(() => {
      closed = true;
      unsubscribe();
      wake?.();
    });

    // 首帧直接发送完整当前状态，客户端就不必再单独补拉一次
    await stream.writeSSE({
      data: JSON.stringify({ type: 'accounts', accounts: await scheduler.snapshot() }),
    });
    await stream.writeSSE({
      data: JSON.stringify({ type: 'scheduler', status: scheduler.status() }),
    });

    while (!closed) {
      while (queue.length > 0) {
        await stream.writeSSE({ data: queue.shift()! });
      }
      // 每 25 秒发一次心跳，避免链路中的代理因空闲超时而断开
      await Promise.race([
        new Promise<void>((r) => {
          wake = r;
        }),
        new Promise<void>((r) => setTimeout(r, 25_000)),
      ]);
      wake = null;
      if (!closed) await stream.writeSSE({ event: 'ping', data: '' });
    }
    unsubscribe();
  }),
);

app.route('/api', api);

/**
 * 前端构建产物的位置。
 *
 * 按可执行文件自身的位置找，而不是当前工作目录：直接跑源码时它在仓库根的 dist/，
 * 打包分发时 server.mjs 和前端一起躺在 dist/ 里。两种形态都不再要求用户先 cd 到某个目录。
 */
const DIST_DIR = [
  join(import.meta.dirname, '..', '..', 'dist'),
  import.meta.dirname,
].find((dir) => existsSync(join(dir, 'index.html')));

// 生产环境托管 vite 构建产物；开发环境由 vite dev server 接管前端。
// 打包产物里前端已经内嵌，直接从内存发，此时磁盘上有没有 dist/ 都无所谓
if (EMBEDDED_ASSETS.size > 0) {
  const index = EMBEDDED_ASSETS.get('/index.html');
  app.use('/*', async (c, next) => {
    // 前端是单页应用，认不出来的路径一律回 index.html，交给前端路由
    const asset = EMBEDDED_ASSETS.get(c.req.path) ?? index;
    if (!asset) return next();
    c.header('Content-Type', asset.type);
    return c.body(asset.body);
  });
} else if (DIST_DIR) {
  app.use('/*', serveStatic({ root: DIST_DIR }));
  app.get('*', serveStatic({ root: DIST_DIR, path: 'index.html' }));
}

/**
 * 后台定时刷新额度，让卡片无需手动点击也能显示最新数字。
 * 每轮从结束时重新安排下一轮，而不是固定间隔硬触发，以免慢轮次不断堆积。
 */
let refreshTimer: NodeJS.Timeout | null = null;

async function refreshLoop(): Promise<void> {
  const cfg = scheduler.getConfig();
  if (cfg.usageRefreshMinutes > 0) {
    try {
      const results = await refreshUsage(store, cfg);
      bus.emit({ type: 'accounts', accounts: await scheduler.snapshot() });
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        console.error(`额度刷新: ${results.length} 个账户中 ${failed.length} 个失败 · ${failed[0].error.slice(0, 120)}`);
      }
    } catch (err) {
      // 单次失败不能把整个定时器打死，下一轮很可能就恢复了
      console.error(`额度刷新失败: ${(err as Error).message}`);
    }
  }
  // 每轮都重新读取配置，让编辑从下一轮开始生效
  const minutes = scheduler.getConfig().usageRefreshMinutes;
  refreshTimer = setTimeout(() => void refreshLoop(), Math.max(1, minutes || 10) * 60_000);
  refreshTimer.unref();
}

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`QuotaHot 已启动: http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${info.port}`);
  console.log(`Web 认证: ${webAuth ? `已启用（用户 ${webAuth.username}）` : '未启用'}`);
  console.log(`数据目录: ${cfgMod.DATA_DIR}`);
  console.log(`账户目录: ${cfgMod.ACCOUNTS_DIR}`);
  const bypass = getBypass();
  console.log(`出站代理: ${getProxy() || '直连'}${bypass.length ? ` · 忽略 ${bypass.join(', ')}` : ''}`);
  const every = config.usageRefreshMinutes;
  console.log(`额度刷新: ${every > 0 ? `每 ${every} 分钟` : '仅手动'}`);
  void refreshLoop();
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`\n收到 ${sig}，正在停止…`);
    if (refreshTimer) clearTimeout(refreshTimer);
    void scheduler.stop().finally(() => {
      server.close();
      store.close();
      process.exit(0);
    });
  });
}
