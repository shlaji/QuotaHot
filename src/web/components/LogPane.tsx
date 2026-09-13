import { useEffect, useRef, useState } from 'react';
import type { LogEntry } from '../../shared/types.js';

interface Props {
  logs: LogEntry[];
}

export function LogPane({ logs }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    if (follow && boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight;
    }
  }, [logs, follow]);

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
      <div className="log-box" ref={boxRef} onScroll={onScroll}>
        {logs.length === 0 && <p className="empty">暂无日志</p>}
        {logs.map((l) => (
          <div key={l.id} className={`log-line ${l.level}`}>
            <time>{new Date(l.ts).toLocaleTimeString('zh-CN')}</time>
            {l.accountId && <span className="log-acct">{l.accountId}</span>}
            <span className="log-msg">{l.message}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
