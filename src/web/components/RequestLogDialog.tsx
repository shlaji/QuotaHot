import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { buildCurl, buildShell, fillSecrets, isCliRecord } from '../../shared/curl.js';
import { clock, duration, endpointLabel } from '../format.js';
import type { RequestLogPage, RequestLogRow, RequestRecord } from '../../shared/types.js';

interface Props {
  /** 账户 ID；为 null 表示弹窗关闭。 */
  accountId: string | null;
  onClose: () => void;
}

function statusClass(r: RequestLogRow): string {
  if (r.status === 0) return 'bad';
  if (r.status === 429) return 'warn';
  return r.status < 400 ? 'ok' : 'bad';
}

/**
 * CLI 那条路没有真正的状态码——它只有退出码和一段人话，是 classify() 折算成
 * 这几个数的。所以照 HTTP 写会骗人，这里按折算前的含义说。
 */
const CLI_STATUS: Record<number, string> = {
  0: '未执行',
  200: '发送成功',
  401: '认证失败',
  429: '已触限',
};

function statusText(r: RequestLogRow): string {
  if (isCliRecord(r)) return CLI_STATUS[r.status] ?? `退出异常（${r.status}）`;
  return r.status === 0 ? '未送达' : `HTTP ${r.status}`;
}

/**
 * 下拉框里成败要一眼看出来。
 * `option` 的文字颜色各浏览器管不了，所以状态只能写进文本本身。
 */
function statusMark(r: RequestLogRow): string {
  if (r.status === 0 || r.status >= 400) return r.status === 429 ? '⚠' : '✕';
  return '✓';
}

/** 下拉框每行：时间、打的哪个接口、结果、耗时——够在不逐条翻的情况下定位到某一条。 */
function optionText(r: RequestLogRow): string {
  return `${statusMark(r)} ${clock(r.sentAt)} · ${endpointLabel(r.url)} · ${statusText(r)} · ${duration(r.durationMs)}`;
}

/**
 * 某个账户最近真实发出的上游请求，一条一条翻着看。
 *
 * 展示的是**发出去的东西本身**（方法、地址、全部请求头、请求体）加上
 * **上游原样返回的正文**，而不是解析后的结论——上游拒绝时，问题几乎总是
 * 出在身份头上，而原因写在响应体里，光看“HTTP 403”两边都看不出来。
 *
 * Claude 的发送走的是本机 CLI，那一发同样在这里，只是各处换了对应物：环境变量
 * 之于请求头、命令行之于请求体、CLI 的 stdout/stderr 之于响应体。复现出来的
 * 也就不是 curl 而是一条命令。
 *
 * 屏幕上一律显示占位符，真令牌只在点“复制”那一下才填进去：日志是拿来看、
 * 拿来截图发给别人的，令牌不该跟着一起出现在画面里；而复制出来的东西要能
 * 直接重发，所以那一份必须是真的。
 */
export function RequestLogDialog({ accountId, onClose }: Props) {
  const [page, setPage] = useState<RequestLogPage | null>(null);
  const [error, setError] = useState('');
  const [index, setIndex] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (accountId === null) return;
    setPage(null);
    setError('');
    setIndex(0);
    setPickerOpen(false);
    let stale = false;
    api
      .accountRequests(accountId)
      .then((p) => {
        if (!stale) setPage(p);
      })
      .catch((err: unknown) => {
        if (!stale) setError(String(err instanceof Error ? err.message : err));
      });
    return () => {
      stale = true;
    };
  }, [accountId]);

  // 摊开的列表要么选一条、要么点别处、要么按 Esc 才收；这两件事全局才管得到
  useEffect(() => {
    if (!pickerOpen) return;
    const close = (e: Event) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      // 只吃掉自己这一层，别顺手把弹窗也关了
      if (e.key === 'Escape') {
        e.stopPropagation();
        setPickerOpen(false);
      }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  // 一展开就把当前这条摆到中间，否则翻到第 40 条时列表还停在顶上，找不着自己在哪
  useEffect(() => {
    if (!pickerOpen) return;
    const list = listRef.current;
    const item = list?.querySelector<HTMLElement>('.current');
    if (list && item) list.scrollTop = item.offsetTop - list.clientHeight / 2 + item.clientHeight / 2;
  }, [pickerOpen]);

  if (accountId === null) return null;

  const rows = page?.rows ?? null;
  const current = rows?.[index] ?? null;
  // 一条日志复现出来是 curl 还是一条本机命令，取决于它当初走的哪条路
  const cli = current !== null && isCliRecord(current);
  const replay = (r: RequestRecord): string => (isCliRecord(r) ? buildShell(r) : buildCurl(r));
  // 展示用的这份留着占位符；真令牌只活在 copy() 里，从不进入 DOM
  const curl = current === null ? '' : replay(current);
  const token = page?.secrets.accessToken ?? '';

  const copy = (text: string) => {
    void navigator.clipboard
      .writeText(text)
      .catch(() => setError('浏览器拒绝了剪贴板访问，请手动选中复制'));
  };

  const copyCurl = () => {
    if (current === null) return;
    // 复制的这份要能直接重发，所以填的是真令牌，而不是屏幕上那份占位符
    copy(replay(fillSecrets(current, page?.secrets ?? { accessToken: '' })));
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>请求日志 · {accountId}</h2>
          <button className="link" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="modal-body">
          {error && <p className="probe-error">{error}</p>}
          {page === null && !error && <p className="empty">加载中…</p>}
          {rows !== null && rows.length === 0 && (
            <p className="empty">这个账户还没有发过请求。启动调度或点「测试文本」后再来看。</p>
          )}

          {current !== null && rows !== null && (
            <>
              <div className="req-nav">
                <button className="ghost" disabled={index >= rows.length - 1} onClick={() => setIndex(index + 1)}>
                  ← 更早
                </button>
                <span className="req-pos">
                  第 {index + 1} / {rows.length} 条 · 最新的排在前面
                </span>
                <button className="ghost" disabled={index <= 0} onClick={() => setIndex(index - 1)}>
                  更新 →
                </button>
              </div>

              {/* 原生 select 的选项列表松开鼠标就收起，几十条日志来不及看清，
                  只能反复点开——所以这一个自己画：点开后一直摊着。 */}
              <div className="req-picker" ref={pickerRef}>
                <button
                  type="button"
                  className="req-picker-toggle"
                  aria-haspopup="listbox"
                  aria-expanded={pickerOpen}
                  onClick={() => setPickerOpen(!pickerOpen)}
                >
                  <span className="req-picker-value">{optionText(current)}</span>
                  <span className="req-picker-caret">{pickerOpen ? '▴' : '▾'}</span>
                </button>
                {pickerOpen && (
                  <div className="req-picker-list" role="listbox" ref={listRef}>
                    {rows.map((r, i) => (
                      <button
                        key={r.id}
                        type="button"
                        role="option"
                        aria-selected={i === index}
                        className={`req-picker-item${i === index ? ' current' : ''}`}
                        onClick={() => {
                          setIndex(i);
                          setPickerOpen(false);
                        }}
                      >
                        {optionText(r)}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <section className="probe-block">
                <h3>
                  {clock(current.sentAt)}{' '}
                  <span className="req-endpoint">{endpointLabel(current.url)}</span>{' '}
                  <span className={statusClass(current)}>{statusText(current)}</span>
                  <span className="req-dur">耗时 {duration(current.durationMs)}</span>
                </h3>
                {/* 归类名只是别名，真正打到哪儿、跑的是哪条命令，以这一行为准 */}
                <p className="req-url">
                  {cli ? current.body : `${current.method} ${current.url}`}
                </p>
                {current.error && <pre className="probe-error">{current.error}</pre>}

                <h4>
                  {cli ? '命令行' : 'curl'}
                  <button className="link" onClick={copyCurl}>
                    复制
                  </button>
                </h4>
                <p className="probe-meta warn-text">
                  {token === ''
                    ? '账户已移除或令牌刷新失败，复制出来的仍是占位符，需要自己补上令牌才能重发。'
                    : cli
                      ? '下面显示的是占位符；点“复制”时会换成这个账户当前有效的令牌，粘到终端里可直接重跑一次——环境是照发送时那份重建的（env -i），换一套环境问出来的结果不算数。复制出来的东西等同于账户凭证，别贴到公开的地方。'
                      : '下面显示的是占位符；点“复制”时会换成这个账户当前有效的令牌，粘到终端里可直接重发。复制出来的东西等同于账户凭证，别贴到公开的地方。'}
                </p>
                <pre className="req-curl">{curl}</pre>

                <h4>{cli ? '环境变量' : '请求头'}</h4>
                <table>
                  <tbody>
                    {Object.entries(current.headers).map(([k, v]) => (
                      <tr key={k}>
                        <td className="hkey">{k}</td>
                        <td className="hval">{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <h4>
                  {cli ? 'CLI 输出' : '响应体'}
                  {current.response !== '' && (
                    <button className="link" onClick={() => copy(current.response)}>
                      复制
                    </button>
                  )}
                </h4>
                {current.response === '' ? (
                  <p className="probe-meta">
                    {cli
                      ? 'CLI 什么都没输出，多半是命令没跑起来。'
                      : current.status === 0
                        ? '连接没建起来，上游没有返回任何内容。'
                        : '上游返回的正文是空的。'}
                  </p>
                ) : (
                  <pre className="raw-body">{current.response}</pre>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
