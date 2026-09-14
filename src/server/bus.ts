/** 轻量事件总线：把调度器活动推送给所有已连接客户端。 */
import type { ServerEvent } from '../shared/types.js';

type Listener = (event: ServerEvent) => void;

const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(event: ServerEvent): void {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch {
      // 单个失效客户端不能拖累其他订阅者
    }
  }
}
