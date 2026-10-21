// src/runtime/StateMachine.ts — 任务状态机（合法状态转换）
// queued -> running -> (waiting_tool <-> running) -> 终态(awaiting_user/completed/failed/cancelled/limit_reached)
// 失败(失败/达到限制)在存在有效检查点时可恢复为 running。

import type { RunStatus } from '../types.js';

const ALLOWED: Record<RunStatus, RunStatus[]> = {
  queued: ['running'],
  running: ['waiting_tool', 'awaiting_user', 'completed', 'failed', 'cancelled', 'limit_reached'],
  waiting_tool: ['running', 'awaiting_user', 'completed', 'failed', 'cancelled', 'limit_reached'],
  awaiting_user: ['cancelled'],
  completed: [],
  failed: ['running'],
  cancelled: [],
  limit_reached: ['running'],
};

/** 可恢复的状态（用于 resume） */
export const RESUMABLE: RunStatus[] = ['failed', 'limit_reached'];

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  if (from === to) return true; // 允许在同一状态刷新（例如 running 刷新时间戳）
  return ALLOWED[from]?.includes(to) ?? false;
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`非法状态转换: ${from} -> ${to}`);
  }
}
