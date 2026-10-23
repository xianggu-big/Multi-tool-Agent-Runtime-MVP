// src/runtime/readStats.ts — 从落盘事件里统计 `read_file` 的重复读取
//
// 为什么单独抽出来（2026-10-23）：
//   - 编排（delegate_subtasks）最大的隐性成本是「子任务各自把同一批文件读一遍」；
//     PARALLEL_AB 的 7× token 主要来自这里，但此前只有在 A/B 脚本里能算，日常 run 看不见。
//   - 这里只做**观测**：基于 `tool_call_requested` 事件数，不改执行路径、不做跨子任务缓存
//     （子任务共享缓存有信息泄露风险，是否做要单独评估）。
//   - 纯函数、零 I/O，run_digest 与 A/B 报告共用同一口径，避免两边数字对不上。

import type { TraceEvent } from '../types.js';

export interface ReadStats {
  /** read_file 调用总次数（含重复） */
  total: number;
  /** 不同路径数（归一化后） */
  uniquePaths: number;
  /** 重复读取次数 = total - 去重后按路径计数的总和 */
  duplicateCalls: number;
  /** 重复最多的路径（次数倒序，最多 10 条；只含 count >= 2） */
  repeatedPaths: Array<{ path: string; count: number }>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** 与 read_file 的入参别名保持一致（path/file/filename/filepath）。 */
export function readPathFromArgs(value: unknown): string | null {
  let args = asRecord(value);
  if (!args && typeof value === 'string') {
    try {
      args = asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!args) return null;
  const raw = args.path ?? args.file ?? args.filename ?? args.filepath;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/** 统计一次 run（含其子任务）里 read_file 的重复读取；仅依赖持久化事件，报告可复核。 */
export function extractReadStats(events: Array<Pick<TraceEvent, 'type' | 'data'>>): ReadStats {
  const calls = events.filter((e) => e.type === 'tool_call_requested' && e.data?.name === 'read_file');
  const counts = new Map<string, number>();
  for (const e of calls) {
    const path = readPathFromArgs(e.data?.arguments);
    if (!path) continue;
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  let duplicateCalls = 0;
  for (const n of counts.values()) duplicateCalls += Math.max(0, n - 1);
  const repeatedPaths = [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([path, count]) => ({ path, count }));
  return { total: calls.length, uniquePaths: counts.size, duplicateCalls, repeatedPaths };
}
