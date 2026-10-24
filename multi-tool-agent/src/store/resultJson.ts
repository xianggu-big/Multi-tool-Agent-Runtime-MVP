// src/store/resultJson.ts — 结构化结果的打包/解包（纯函数，可单测）
// runs.resultJson 存的是一个「信封」：{ v:1, misc?, orchestration?, subtasks? }
// 兼容旧数据：早期版本把 MiscReport 直接存成裸对象，unpack 时按裸 MiscReport 处理。

import type { AwaitingUser, CodexRunSummary, MiscReport, OrchestrationReport, SubtaskOutcome } from '../types.js';

export interface RunResultPayload {
  misc?: MiscReport;
  orchestration?: OrchestrationReport;
  subtasks?: SubtaskOutcome[];
  awaitingUser?: AwaitingUser;
  codex?: CodexRunSummary;
}

export function packResultJson(parts: RunResultPayload): string | undefined {
  const hasMisc = !!parts.misc;
  const hasOrch = !!parts.orchestration;
  const hasSubtasks = !!(parts.subtasks && parts.subtasks.length);
  const hasAwaiting = !!parts.awaitingUser;
  const hasCodex = !!parts.codex;
  if (!hasMisc && !hasOrch && !hasSubtasks && !hasAwaiting && !hasCodex) return undefined;
  return JSON.stringify({ v: 1, ...parts });
}

export function unpackResultJson(raw: string | undefined | null): RunResultPayload {
  if (!raw) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!data || typeof data !== 'object') return {};
  const d = data as Record<string, unknown>;
  // 新信封
  if (d.v === 1 || 'orchestration' in d || 'subtasks' in d || 'awaitingUser' in d || 'codex' in d) {
    return {
      misc: (d.misc as MiscReport) ?? undefined,
      orchestration: (d.orchestration as OrchestrationReport) ?? undefined,
      subtasks: (d.subtasks as SubtaskOutcome[]) ?? undefined,
      awaitingUser: (d.awaitingUser as AwaitingUser) ?? undefined,
      codex: (d.codex as CodexRunSummary) ?? undefined,
    };
  }
  // 旧格式：裸 MiscReport
  if (typeof d.summary === 'string') {
    return { misc: d as unknown as MiscReport };
  }
  return {};
}
