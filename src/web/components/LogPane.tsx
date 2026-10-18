import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { LogEntry } from '../../shared/types.js';

interface Props {
  logs: LogEntry[];
}

interface LogDateRange {
  readonly start: string;
  readonly end: string;
}

function localDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function recentLogDateRange(today = new Date()): LogDateRange {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 2);
  return { start: localDate(start), end: localDate(today) };
}

export function filterLogsByDate(logs: readonly LogEntry[], range: LogDateRange): LogEntry[] {
  return logs.filter((log) => {
    const date = localDate(new Date(log.ts));
    return (range.start === '' || date >= range.start) && (range.end === '' || date <= range.end);
  });
}

export function LogPane({ logs }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [range, setRange] = useState(() => recentLogDateRange());
  const rangeHintId = useId();
  const visibleLogs = useMemo(() => filterLogsByDate(logs, range), [logs, range]);

  useEffect(() => {
    if (follow && boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight;
    }
  }, [visibleLogs, follow]);

  // 向上滚动时暂停自动跟随，回到底部后恢复
  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };

  return (
    <section className="logs">
      <header>
        <h2>实时日志</h2>
        <label className="follow">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          自动滚动
        </label>
      </header>
      <div className="log-filters">
        <div className="panel-row">
          <label className="field">
            <span>开始日期</span>
            <input
              type="date"
              value={range.start}
              aria-describedby={rangeHintId}
              onChange={(event) => setRange({ ...range, start: event.target.value })}
            />
          </label>
          <label className="field">
            <span>结束日期</span>
            <input
              type="date"
              value={range.end}
              aria-describedby={rangeHintId}
              onChange={(event) => setRange({ ...range, end: event.target.value })}
            />
          </label>
          <button type="button" className="ghost" onClick={() => setRange(recentLogDateRange())}>
            最近 3 天
          </button>
        </div>
        <p id={rangeHintId} className="log-filter-hint">
          按本地日期筛选已加载日志，包含起止日期；<span>留空不限。</span>
        </p>
      </div>
      <div className="log-box" ref={boxRef} onScroll={onScroll}>
        {visibleLogs.length === 0 && (
          <p className="empty" role="status">
            {logs.length === 0 ? '暂无日志' : '所选日期范围内暂无日志'}
          </p>
        )}
        {visibleLogs.map((l) => {
          const date = new Date(l.ts);
          return (
            <div key={l.id} className={`log-line ${l.level}`}>
              <time>{`${localDate(date)} ${date.toLocaleTimeString('zh-CN')}`}</time>
              {l.accountId && <span className="log-acct">{l.accountId}</span>}
              <span className="log-msg">{l.message}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
