import type { UsageResult } from '../../shared/types.js';
import { clock, countdown, day, windowLabel } from '../format.js';

interface Props {
  results: UsageResult[] | null;
  now: number;
  onClose: () => void;
}

/**
 * 额度查询结果。这里是日常只读查询，因此优先展示已解析的数据，
 * 原始响应折叠进 <details> 中备用；之所以保留，是因为这些上游接口并没有版本约束。
 */
export function UsageDialog({ results, now, onClose }: Props) {
  if (!results) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>额度查询</h2>
          <button className="link" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="modal-body">
          {results.length === 0 && <p className="empty">没有可查询的账户。</p>}

          {results.map((r) => (
            <section key={r.accountId} className="probe-block">
              <h3>
                {r.email || r.accountId}
                <span className={r.ok ? 'ok' : 'bad'}>
                  {r.provider}
                  {r.plan && ` · ${r.plan}`}
                  {!r.ok && ` · HTTP ${r.status}`}
                </span>
              </h3>
              {(r.subscriptionEndsAt !== null || r.resetCredits !== null || r.userId) && (
                <p className="probe-meta">
                  {r.subscriptionEndsAt !== null && `订阅至 ${day(r.subscriptionEndsAt)}`}
                  {r.resetCredits !== null && ` · 可用重置次数 ${r.resetCredits}`}
                  {r.userId && ` · ${r.userId}`}
                </p>
              )}
              {r.error && <pre className="probe-error">{r.error}</pre>}

              {r.ok && r.windows.length === 0 ? (
                <p className="empty">
                  上游有响应但没解析出窗口，可能改了字段名，请看下面的原始响应。
                </p>
              ) : (
                r.windows.length > 0 && (
                  <table>
                    <thead>
                      <tr>
                        <th>窗口</th>
                        <th>已用</th>
                        <th>重置倒计时</th>
                        <th>重置时刻</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.windows.map((w) => (
                        <tr key={w.name}>
                          <td>{windowLabel(w.name)}</td>
                          <td>{w.usedPercent === null ? '—' : `${w.usedPercent.toFixed(1)}%`}</td>
                          <td>{countdown(w.resetAt, now)}</td>
                          <td className="hval">{clock(w.resetAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              )}

              {r.raw && (
                <details>
                  <summary>原始响应{r.endpoint && ` · ${r.endpoint}`}</summary>
                  <pre className="raw-body">{r.raw}</pre>
                </details>
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
