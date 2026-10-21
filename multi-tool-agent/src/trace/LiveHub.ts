// src/trace/LiveHub.ts — 进程内实时事件分发（SSE 快车道）
// 目的：把 EventLogger 产生的事件在「毫秒级」推给正在订阅该 runId 的 SSE 连接，
//       而不必等待异步批量落盘（setImmediate）与数据库轮询（看门狗 2s）。
// 设计约束：
//   - 纯内存、无 I/O，publish 为 O(订阅者数量)，对 Agent Loop 主路径影响可忽略；
//   - 单个订阅者回调抛错不影响其他订阅者，也不影响主流程；
//   - 连接断开必须调用返回的 unsubscribe，避免泄漏。

import type { TraceEvent } from '../types.js';

export type LiveListener = (e: TraceEvent) => void;

export class LiveHub {
  private byRun = new Map<string, Set<LiveListener>>();

  /** 订阅某个 runId 的实时事件，返回取消订阅函数 */
  subscribe(runId: string, listener: LiveListener): () => void {
    let set = this.byRun.get(runId);
    if (!set) {
      set = new Set();
      this.byRun.set(runId, set);
    }
    set.add(listener);
    return () => {
      const s = this.byRun.get(runId);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.byRun.delete(runId);
    };
  }

  /** 发布事件给所有订阅者（异常隔离） */
  publish(e: TraceEvent): void {
    const set = this.byRun.get(e.runId);
    if (!set || set.size === 0) return;
    for (const listener of [...set]) {
      try {
        listener(e);
      } catch {
        /* 单个订阅者失败不影响其他订阅者与主流程 */
      }
    }
  }

  /** 当前订阅者数量（诊断用） */
  subscriberCount(runId: string): number {
    return this.byRun.get(runId)?.size ?? 0;
  }

  /** 被订阅的 runId 数量（诊断用） */
  activeRuns(): number {
    return this.byRun.size;
  }
}
