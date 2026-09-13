import type { AccountView, SchedulerStatus } from '../../shared/types.js';
import { clock, countdown } from '../format.js';

const STATE_LABEL: Record<AccountView['state'], string> = {
  idle: '就绪',
  waiting: '等待窗口',
  sending: '发送中',
  stopped: '未在调度',
  error: '异常',
};

interface Props {
  accounts: AccountView[];
  status: SchedulerStatus;
  now: number;
  busy: boolean;
  /** 勾选的账户 id；为空表示“全部”，与账户页的勾选是同一份。 */
  selected: Set<string>;
  onSelectChange: (id: string, selected: boolean) => void;
  onSelectAll: (ids: string[]) => void;
  onClearSelection: () => void;
  /** ids 为空表示纳入全部可保活账户。 */
  onStart: (ids: string[]) => void;
  onStop: () => void;
}

/**
 * 调度任务页。
 *
 * 这一页回答的是“谁在跑、下一拍什么时候、上一拍什么时候”——这些是**调度**的事，
 * 不是某个账户的属性，所以从账户卡片上挪到了这里，卡片只留账户自身的信息。
 *
 * 启动时可以只勾一部分账户：一次启动纳入哪些账户就此定死，中途改勾选不会影响
 * 已经在跑的那一批，因此表格里另用一列标出“这个账户是不是真的在本次调度里”。
 */
export function SchedulePane({
  accounts,
  status,
  now,
  busy,
  selected,
  onSelectChange,
  onSelectAll,
  onClearSelection,
  onStart,
  onStop,
}: Props) {
  // Qoder 没有会自己重置的窗口，保活对它没有意义，因此它压根不出现在这一页
  const rows = accounts.filter((a) => a.provider !== 'qoder');
  const skipped = accounts.length - rows.length;
  const ids = rows.map((a) => a.id);
  const picked = ids.filter((id) => selected.has(id));
  const running = new Set(status.accountIds);

  // 勾了账户却一个都不能保活时，按“全部”启动只会让人以为自己的勾选被忽略了
  const deadSelection = selected.size > 0 && picked.length === 0;
  const scope = picked.length === 0 ? `全部 ${rows.length}` : `${picked.length}`;

  return (
    <>
      <div className="runbar">
        {rows.length > 0 && (
          <span className="select-hint">
            <button
              className="link"
              onClick={() => onSelectAll(ids)}
              disabled={picked.length === rows.length}
            >
              全选
            </button>
            <button className="link" onClick={onClearSelection} disabled={selected.size === 0}>
              清空
            </button>
            {picked.length === 0 ? '未勾选 · 启动时纳入全部账户' : `已勾选 ${picked.length} / ${rows.length}`}
          </span>
        )}

        <div className="spacer" />

        {status.running ? (
          <>
            <span className="running-hint">
              运行中 · 自 {clock(status.startedAt)} · 本次 {status.accountIds.length} 个账户
              {status.windowEdgeAt !== null &&
                (status.withinWindow
                  ? ` · 距关窗 ${countdown(status.windowEdgeAt, now)}`
                  : ` · 窗口外，${countdown(status.windowEdgeAt, now)}后开窗`)}
            </span>
            <button className="danger" disabled={busy} onClick={onStop}>
              停止
            </button>
          </>
        ) : (
          <>
            <span className="running-hint">
              已停止 ·{' '}
              {status.dailyStart === status.dailyEnd
                ? '每日窗口为全天'
                : `每日窗口 ${status.dailyStart}–${status.dailyEnd}`}
            </span>
            <button
              className="primary"
              disabled={busy || rows.length === 0 || deadSelection}
              title={
                deadSelection
                  ? '勾选的账户都不参与调度，换几个再启动'
                  : '按各账户自己的限额窗口节奏，周期性发送保活文本'
              }
              onClick={() => onStart(picked)}
            >
              启动定时任务（{scope}）
            </button>
          </>
        )}
      </div>

      <section className="sched">
        {rows.length === 0 ? (
          <p className="empty big">没有可保活的账户，先在账户页导入或登录一个。</p>
        ) : (
          <table className="sched-table">
            <thead>
              <tr>
                <th className="col-check" />
                <th>账户</th>
                <th>状态</th>
                <th>下次发送</th>
                <th>上次发送</th>
                <th>窗口重置</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                // 下次发送一分钟内触发时高亮，和原先卡片上的处理保持一致
                const imminent = a.nextDueAt !== null && a.nextDueAt - now < 60_000;
                const inRun = running.has(a.id);
                return (
                  <tr key={a.id} className={selected.has(a.id) ? 'picked' : ''}>
                    <td className="col-check">
                      <input
                        type="checkbox"
                        className="card-check"
                        checked={selected.has(a.id)}
                        onChange={(e) => onSelectChange(a.id, e.target.checked)}
                        aria-label={`选择 ${a.email}`}
                      />
                    </td>
                    <td>
                      <span className={`badge provider-${a.provider}`}>{a.provider}</span>
                      <span className="sched-email" title={a.email}>
                        {a.email}
                      </span>
                    </td>
                    <td>
                      <span className={`state-dot state-${a.state}`}>{STATE_LABEL[a.state]}</span>
                      {/* 启动之后才改的勾选不会影响这一批，所以要说清谁真的在跑 */}
                      {status.running && !inRun && <small className="sched-sub">未纳入本次调度</small>}
                      {/*
                        连续失败数是发送的战绩，不是令牌的：它只在发送失败时累加，成功一次就清零，
                        所以归在这一页的状态里，而不是卡片上那格 Token 有效期。
                      */}
                      {a.consecutiveFailures > 0 && (
                        <small className="sched-sub bad" title="连续几次发送都没成功；成功一次即归零">
                          连续失败 {a.consecutiveFailures} 次
                        </small>
                      )}
                    </td>
                    <td className={imminent ? 'imminent' : ''}>
                      <strong>{countdown(a.nextDueAt, now)}</strong>
                      <small className="sched-sub">{clock(a.nextDueAt)}</small>
                    </td>
                    <td>
                      <strong>{a.lastSentAt ? clock(a.lastSentAt) : '—'}</strong>
                      <small className="sched-sub">{a.windowSource || '无来源信息'}</small>
                    </td>
                    <td>
                      <strong>{countdown(a.windowResetAt, now)}</strong>
                      <small className="sched-sub">{clock(a.windowResetAt)}</small>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {skipped > 0 && (
          <p className="empty">
            另有 {skipped} 个 Qoder 账户不参与调度：它按订阅周期发放额度，没有会自己重置的窗口，发消息只是纯消耗。
          </p>
        )}
      </section>
    </>
  );
}
