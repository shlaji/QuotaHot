import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AppConfig,
  ImportCandidate,
  LoginMode,
  LoginStart,
  Provider,
} from '../../shared/types.js';
import { api } from '../api.js';
import { day } from '../format.js';

const SOURCE_LABEL: Record<string, string> = {
  'cli-proxy-api': 'cli-proxy-api 认证目录',
  'codex-cli': 'Codex CLI',
  'claude-cli': 'Claude Code',
  'qoder-cli': 'Qoder CLI',
  'qoder-desktop': 'Qoder Desktop',
  'qoder-ide': 'Qoder IDE',
};

/**
 * 这个来源从哪个文件读账户，可以当场改。
 *
 * 会来看这一行的人，多半刚在上面读到一句「本机没有这个路径」——位置就摆在眼前，
 * 让他在原地把它填对，比先记住路径再去配置页找一遍要短得多。
 *
 * 失焦即保存，不另设按钮：这里只有一个字段，一个「保存」按钮不会让人更放心，只会多一步。
 * 保存的是全局配置里的 clientPaths，导入、跟随客户端、写回客户端、「本机在用」核对四处
 * 一起跟着走。留空 = 恢复默认位置，placeholder 里那个灰字就是默认值。
 */
function SourcePath({
  source,
  busy,
  onSave,
}: {
  source: ImportCandidate;
  busy: boolean;
  onSave: (path: string) => Promise<void>;
}) {
  const custom = source.path === source.defaultPath ? '' : source.path;
  const [text, setText] = useState(custom);
  // 服务端的值变了（自己刚存完、或者别处改过）就跟上，但别打断正在输入的人
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(custom);
  }, [custom, editing]);

  const commit = (): void => {
    setEditing(false);
    if (text.trim() === custom) return;
    void onSave(text.trim());
  };

  return (
    <p className="probe-meta source-path">
      <input
        type="text"
        value={text}
        disabled={busy}
        spellCheck={false}
        placeholder={source.defaultPath}
        title="留空使用默认位置"
        onChange={(e) => {
          setEditing(true);
          setText(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setEditing(false);
            setText(custom);
            e.currentTarget.blur();
          }
        }}
      />
      {custom ? (
        <button
          className="link"
          disabled={busy}
          onClick={() => {
            setEditing(false);
            setText('');
            void onSave('');
          }}
        >
          恢复默认
        </button>
      ) : (
        <em className="hint">默认位置</em>
      )}
    </p>
  );
}

/** 开着本地监听时的轮询间隔。 */
const POLL_MS = 2000;

const PROVIDER_TITLE: Record<Provider, string> = {
  claude: 'Claude',
  codex: 'ChatGPT / Codex',
  qoder: 'Qoder',
};

/**
 * 登录一栏。
 *
 * 授权在用户自己的浏览器里完成，程序只负责生成链接和交换令牌，全程不接触账号密码。
 * Codex 的回调如果能被本机 1455 端口接住，点完授权就结束了；接不住时（端口被占、
 * 或者服务端和浏览器不在同一台机器上）退回手动粘贴。Claude 的回调在官方页面上，
 * 只有手动粘贴这一条路。Qoder 的回调是 `qoder://` 自定义协议，谁都接不住，改由
 * 服务端轮询上游收尾——对这个组件来说它和“已在监听”是同一种状态，只是没有可粘的东西。
 *
 * Codex 还可以改用设备码：界面只显示一串验证码，用户拿任意一台设备打开官方页面输入。
 * 服务端把它当作“已在监听”推进，因此这里也只是换一段说明文字，其余逻辑完全共用。
 */
function LoginBlock({
  provider,
  onDone,
  onError,
}: {
  provider: Provider;
  onDone: (id: string) => void;
  onError: (msg: string) => void;
}) {
  const [session, setSession] = useState<LoginStart | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);
  const copyGenerationRef = useRef(0);
  const clearCopiedTimer = () => {
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = null;
    }
  };
  // 回调是浏览器直接打到服务端的，这个页面收不到通知，只能轮询
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const errorRef = useRef(onError);
  errorRef.current = onError;

  useEffect(() => {
    if (!session?.listening) return;
    let stop = false;
    const timer = setInterval(async () => {
      if (stop) return;
      try {
        const st = await api.loginStatus(session.loginId);
        if (st.state === 'pending') return;
        stop = true;
        setSession(null);
        if (st.state === 'done') doneRef.current(st.accountId);
        else if (st.state === 'error') errorRef.current(st.error);
        else errorRef.current('这次授权已过期，请重新点击登录');
      } catch {
        /* 服务端短暂不可用时继续等下一拍 */
      }
    }, POLL_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [session]);

  useEffect(
    () => () => {
      copyGenerationRef.current += 1;
      clearCopiedTimer();
    },
    [],
  );

  const begin = async (mode: LoginMode = 'redirect') => {
    setBusy(true);
    copyGenerationRef.current += 1;
    clearCopiedTimer();
    setCopied(false);
    try {
      setSession(await api.loginStart(provider, mode));
      setInput('');
    } catch (err) {
      onError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  const copyDeviceCode = async () => {
    if (!session?.userCode) return;
    const generation = ++copyGenerationRef.current;
    try {
      await navigator.clipboard.writeText(session.userCode);
      if (copyGenerationRef.current !== generation) return;
      clearCopiedTimer();
      setCopied(true);
      copiedTimerRef.current = window.setTimeout(() => {
        copiedTimerRef.current = null;
        setCopied(false);
      }, 1500);
    } catch {
      if (copyGenerationRef.current !== generation) return;
      setCopied(false);
    }
  };

  const finish = async () => {
    if (!session) return;
    setBusy(true);
    try {
      const { accountId } = await api.loginComplete(session.loginId, input);
      setSession(null);
      setInput('');
      onDone(accountId);
    } catch (err) {
      onError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  // Qoder 没有 code 可粘，设备码流程里授权码也不经用户的手，两者的手动路径都不成立
  const device = Boolean(session?.userCode);
  const paste = provider !== 'qoder' && !device;

  return (
    <section className="probe-block">
      <h3>
        {PROVIDER_TITLE[provider]}
        <span className="ok">{provider}</span>
      </h3>

      {!session ? (
        <div className="modal-actions">
          <button className="ghost" disabled={busy} onClick={() => void begin()}>
            获取授权链接
          </button>
          {/* 浏览器不在本机时，回调既接不住也不好复制，这时改用设备码 */}
          {provider === 'codex' && (
            <button className="link" disabled={busy} onClick={() => void begin('device')}>
              改用设备码
            </button>
          )}
        </div>
      ) : (
        <>
          <p className="probe-meta">
            1. {device ? '在任意一台设备上打开这个页面：' : '打开这个链接并完成授权：'}
            <br />
            <a href={session.authorizeUrl} target="_blank" rel="noreferrer noopener">
              {session.authorizeUrl.slice(0, 90)}
              {session.authorizeUrl.length > 90 ? '…' : ''}
            </a>
          </p>
          {device ? (
            <p className="probe-meta">
              2. 在页面上输入验证码 <code>{session.userCode}</code>{' '}
              <button className="link" onClick={() => void copyDeviceCode()}>
                {copied ? '已复制' : '复制'}
              </button>
              ，然后完成授权。服务端正在轮询这次授权的结果，拿到就自动写入，这个窗口不用管。
            </p>
          ) : !paste ? (
            <p className="probe-meta">
              2. 选好账号后这个页面会跳去 <code>{session.redirectUri}</code>（本机没装 Qoder
              时打不开，属正常现象）。服务端正在向上游轮询这次授权的结果，拿到就自动写入，
              这个窗口不用管。
            </p>
          ) : session.listening ? (
            <p className="probe-meta">
              2. 已在本机 <code>{session.redirectUri}</code> 等待回调，授权完成后会自动写入，
              这个窗口不用管。如果浏览器不在本机，仍可把地址粘到下面。
            </p>
          ) : (
            <p className="probe-meta">
              2. 授权后浏览器会跳到 <code>{session.redirectUri}</code>。
              {provider === 'codex'
                ? ' 这个地址多半打不开，属正常现象——直接复制地址栏里的完整地址粘到下面。'
                : ' 页面上会显示一段授权码，复制它或整个地址粘到下面。'}
              {session.listenError && ` 本次没能自动接住回调：${session.listenError}。`}
            </p>
          )}
          {paste && (
            <input
              type="text"
              placeholder="粘贴回调地址或授权码"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
          )}
          <div className="modal-actions">
            {paste && (
              <button className="primary" disabled={busy || !input.trim()} onClick={finish}>
                完成登录
              </button>
            )}
            <button
              className="link"
              disabled={busy}
              onClick={() => {
                // 顺手把本机端口还回去，不然要等这次授权过期
                void api.loginCancel(session.loginId).catch(() => {});
                setSession(null);
              }}
            >
              取消
            </button>
          </div>
        </>
      )}
    </section>
  );
}

interface Props {
  open: boolean;
  accountsDir: string;
  onClose: () => void;
  onNotify: (msg: string) => void;
  /**
   * 在这里改过来源路径之后，把服务端存下来的那份配置交回去。
   * 配置页拿着的是同一份配置，不同步过去的话，下一次在那儿按保存会把这次改动顶掉。
   */
  onConfigChange: (config: AppConfig) => void;
}

/** 账户管理：从本机其他客户端导入，或直接在这里登录一个新账户。 */
export function AccountsDialog({ open, accountsDir, onClose, onNotify, onConfigChange }: Props) {
  const [sources, setSources] = useState<ImportCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setSources(await api.sources());
    } catch (err) {
      onNotify(String(err instanceof Error ? err.message : err));
    }
  }, [onNotify]);

  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  if (!open) return null;

  const runImport = async (ids: string[]) => {
    setBusy(true);
    try {
      const result = await api.importAccounts(ids);
      const skipped = result.skipped.length > 0 ? `，跳过 ${result.skipped.length} 个` : '';
      onNotify(`已导入 ${result.imported.length} 个账户${skipped}`);
    } catch (err) {
      onNotify(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  /** 改某个来源的位置：存下来，用新位置重扫，顺手把配置同步给外层。 */
  const saveSourcePath = async (source: ImportCandidate, path: string): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.setSourcePath(source.source, path);
      setSources(result.sources);
      onConfigChange(result.config);
      const label = SOURCE_LABEL[source.source] ?? source.source;
      const now = result.sources.find((s) => s.source === source.source);
      onNotify(
        path
          ? `${label} 改为读 ${now?.path ?? path}`
          : `${label} 已恢复默认位置 ${now?.defaultPath ?? ''}`,
      );
    } catch (err) {
      onNotify(String(err instanceof Error ? err.message : err));
      // 存失败时把界面拉回服务端的真实状态，免得输入框里留着一个没生效的路径
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const usable = (sources ?? []).filter((s) => s.accounts.length > 0);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>账户</h2>
          <button className="link" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="modal-body">
          <p className="probe-meta">
            账户保存在 <code>{accountsDir}</code>。导入是一次性拷贝，不会动原始凭证。
            从 Claude Code 导入的账户默认<strong>跟随客户端</strong>：本程序只用它同步过来的
            token 查接口，续期仍由 Claude Code 自己做，两边不会互相把 refresh token 顶掉。
            这个开关在每张卡片上都能改。
          </p>

          <h2>登录新账户</h2>
          <LoginBlock
              provider="codex"
              onDone={(id) => onNotify(`已添加 ${id}`)}
              onError={onNotify}
          />
          <LoginBlock
            provider="claude"
            onDone={(id) => onNotify(`已添加 ${id}`)}
            onError={onNotify}
          />
          <LoginBlock
            provider="qoder"
            onDone={(id) => onNotify(`已添加 ${id}`)}
            onError={onNotify}
          />

          <hr/>

          <h2>从本机导入</h2>
          <p className="probe-meta">
            每一处的路径都能直接改：留空用默认位置，填绝对路径（<code>~</code> 会展开成主目录）。
            改完立刻按新位置重扫，跟随客户端、写回客户端、「本机在用」核对也一起跟着走。
          </p>
          {sources === null ? (
            <p className="empty">扫描中…</p>
          ) : (
            sources.map((s) => (
              <section key={s.source} className="probe-block">
                <h3>
                  {SOURCE_LABEL[s.source] ?? s.source}
                  <span className={s.accounts.length > 0 ? 'ok' : 'bad'}>
                    {s.accounts.length > 0 ? `${s.accounts.length} 个账户` : s.error || '没有账户'}
                  </span>
                </h3>
                <SourcePath
                  source={s}
                  busy={busy}
                  onSave={(path) => saveSourcePath(s, path)}
                />
                {s.accounts.length > 0 && (
                  <>
                    <table>
                      <thead>
                        <tr>
                          <th>账户</th>
                          <th>类型</th>
                          <th>令牌到期</th>
                          <th>续期方式</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.accounts.map((a) => (
                          <tr key={a.id}>
                            <td>{a.email}</td>
                            <td>{a.provider}</td>
                            <td>{a.expiresAt ? day(a.expiresAt) : '未知'}</td>
                            <td>{a.followClient ? '跟随客户端' : '本程序刷新'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <button className="ghost" disabled={busy} onClick={() => void runImport([s.source])}>
                      导入这一处
                    </button>
                  </>
                )}
              </section>
            ))
          )}

          {usable.length > 1 && (
            <button
              className="primary"
              disabled={busy}
              onClick={() => void runImport(usable.map((s) => s.source))}
            >
              全部导入
            </button>
          )}

        </div>
      </div>
    </div>
  );
}
