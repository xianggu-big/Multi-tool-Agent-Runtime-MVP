// src/runtime/subtaskStats.ts — 按 spec 聚合子任务历史（T7 的轻量版）
//
// 为什么不新建 `subtasks` 表：
//   - 现有 runs.resultJson 已经保存了每次 run 的全部子任务产物（Runtime 累积，不只最后一批）；
//   - 建表要迁移 + 双写 + 崩溃对账，收益只是查询更快；样本量还小，先做零迁移聚合更划算。
//   - 口径与 AGENT_REPORT 一致：默认排除 Mock（演示数据不能当能力评估）。
//
// 纯函数、零 I/O；HTTP 与脚本共用，避免两个地方各算一套。

import { unpackResultJson } from '../store/resultJson.js';

export interface SubtaskSpecStats {
  specId: string;
  total: number;
  ok: number;
  failed: number;
  cancelled: number;
  limited: number;
  /** ok / total，保留 3 位小数 */
  successRate: number;
  avgDurationMs: number;
  avgTokens: number;
  totalTokens: number;
  lastFinishedAt?: string;
}

export interface SubtaskStats {
  runsScanned: number;
  runsWithSubtasks: number;
  mockExcluded: number;
  totalSubtasks: number;
  specs: SubtaskSpecStats[];
}

export interface SubtaskStatsRun {
  isMock: number | boolean;
  createdAt: string;
  resultJson?: string | null;
}

interface Acc {
  total: number;
  ok: number;
  failed: number;
  cancelled: number;
  limited: number;
  totalTokens: number;
  durations: number[];
  tokens: number[];
  last?: string;
}

export function aggregateSubtaskStats(
  runs: ReadonlyArray<SubtaskStatsRun>,
  opts: { includeMock?: boolean } = {},
): SubtaskStats {
  const acc = new Map<string, Acc>();
  let runsWithSubtasks = 0;
  let totalSubtasks = 0;
  let mockExcluded = 0;

  for (const run of runs) {
    const isMock = run.isMock === true || run.isMock === 1;
    if (isMock && !opts.includeMock) {
      mockExcluded += 1;
      continue;
    }
    const subtasks = unpackResultJson(run.resultJson).subtasks ?? [];
    if (!subtasks.length) continue;
    runsWithSubtasks += 1;
    totalSubtasks += subtasks.length;
    for (const st of subtasks) {
      const key = st.specId || '（未知）';
      const cur: Acc = acc.get(key) ?? {
        total: 0,
        ok: 0,
        failed: 0,
        cancelled: 0,
        limited: 0,
        totalTokens: 0,
        durations: [],
        tokens: [],
      };
      cur.total += 1;
      if (st.status === 'ok') cur.ok += 1;
      else if (st.status === 'failed') cur.failed += 1;
      else if (st.status === 'cancelled') cur.cancelled += 1;
      else if (st.status === 'limit_reached') cur.limited += 1;
      cur.durations.push(Number(st.durationMs) || 0);
      const tokens = Number(st.usage?.totalTokens) || 0;
      cur.tokens.push(tokens);
      cur.totalTokens += tokens;
      if (!cur.last || run.createdAt > cur.last) cur.last = run.createdAt;
      acc.set(key, cur);
    }
  }

  const specs = [...acc.entries()]
    .map(([specId, s]) => ({
      specId,
      total: s.total,
      ok: s.ok,
      failed: s.failed,
      cancelled: s.cancelled,
      limited: s.limited,
      successRate: s.total ? +(s.ok / s.total).toFixed(3) : 0,
      avgDurationMs: s.durations.length ? Math.round(s.durations.reduce((a, b) => a + b, 0) / s.durations.length) : 0,
      avgTokens: s.tokens.length ? Math.round(s.tokens.reduce((a, b) => a + b, 0) / s.tokens.length) : 0,
      totalTokens: s.totalTokens,
      ...(s.last ? { lastFinishedAt: s.last } : {}),
    }))
    .sort((a, b) => b.total - a.total || a.specId.localeCompare(b.specId));

  return { runsScanned: runs.length, runsWithSubtasks, mockExcluded, totalSubtasks, specs };
}
