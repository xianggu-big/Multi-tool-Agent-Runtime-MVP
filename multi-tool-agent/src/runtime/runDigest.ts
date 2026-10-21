// src/runtime/runDigest.ts — 每次任务结束后的「复盘摘要」（成功/失败都记，失败优先）
//
// 为什么需要它（2026-10-20 用户要求 + 两次真实事故驱动）：
//   - 失败时，`runs` 行只有一行 failureReason，看不到「过程中还出过哪些问题」；
//   - **成功时几乎没有痕迹**：run 显示 completed，但中间可能失败了 3 次工具、1 个子任务被限流、
//     1 次审批被拒——这些只散在 events 里，不复盘就等于没发生；
//   - 「一个流程都跑不完」（进程被杀/重启、provider 400）恰恰是最该被记录的一类。
//
// 设计口径（与 PROJECT_REPORT 的诚实原则一致）：
//   - 纯函数、零 I/O：输入 = runs 行 + 该 run 的全部事件，输出 = 结构化摘要；
//   - **不信任 finalAnswer**：结论只由 status / errorCode / 事件统计机械得出；
//   - 过程问题按 `code + 位置` 聚合，保留首条消息与首/末 seq（可回放定位）；
//   - `ok` 只认 `status === 'completed'`；`awaiting_user` 单独成档，不当成成功。

import type { TraceEvent } from '../types.js';
import { aggregateRunEvents } from '../report/runReport.js';

export const RUN_DIGEST_VERSION = 1;

/** 入库/入日志的最小 run 行（与 RunRecord 兼容，便于 store 行直接传入） */
export interface RunDigestRun {
  runId: string;
  runType: string;
  status: string;
  goal: string;
  createdAt: string;
  failureReason?: string | null;
  errorCode?: string | null;
  triggeredLimit?: string | null;
  steps: number;
  modelCalls: number;
  toolCalls: number;
  totalDurationMs: number;
  usageJson?: string | null;
  isMock: number | boolean;
}

export interface RunDigestIssue {
  /** 稳定机器码：TOOL_FAILED / MODEL_ERROR / SUBTASK_FAILED / APPROVAL_DENIED / VERIFY_FAILED … */
  code: string;
  /** 问题来源：tool / runtime / approval / verification / security */
  source: string;
  /** 出处：工具名 / specId / 文件行 / 审批 actor（有就带，便于直接定位） */
  where?: string;
  count: number;
  firstSeq: number;
  lastSeq: number;
  /** 首条消息（已截断），足够判断"是什么问题" */
  message: string;
}

export interface RunDigest {
  version: typeof RUN_DIGEST_VERSION;
  runId: string;
  runType: string;
  status: string;
  isMock: boolean;
  /** 是否成功（只认 completed；awaiting_user / cancelled / limit_reached / failed 都不算） */
  ok: boolean;
  goal: string;
  createdAt: string;
  finishedAt: string;
  durationMs: number;
  errorCode?: string;
  failureReason?: string;
  triggeredLimit?: string;
  counters: {
    steps: number;
    modelCalls: number;
    toolCalls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd: number;
  };
  eventStats: {
    total: number;
    byType: Record<string, number>;
  };
  counts: {
    /** 工具失败次数（含已自愈的） */
    toolFails: number;
    runtimeErrors: number;
    subtaskFailed: number;
    subtaskCompleted: number;
    approvalDenied: number;
    verifyFailed: number;
    changeRolledBack: number;
    untrustedFlagged: number;
  };
  /**
   * 上下文压缩观测（R23）：长任务是否被反复压缩、摘要是否越滚越大/触顶。
   * 没有发生压缩时该字段省略（历史 run 也没有）。
   */
  compaction?: {
    count: number;
    removedMessages: number;
    maxDepth: number;
    lastSummaryChars: number;
    capReached: boolean;
    /** 观察到的最大上下文水位（0~1）；用来区分“按窗口压”和“未知窗口回退”。 */
    maxWatermark?: number;
    /** 水位来源去重：provider / estimated / unknown */
    watermarkSources?: string[];
    /** 最近一次观察到的真实/估算 promptTokens */
    lastPromptTokens?: number;
    /** 最近一次观察到的模型上下文窗口 */
    contextWindow?: number;
  };
  /** 过程问题（按 code + 位置聚合，按出现顺序） */
  issues: RunDigestIssue[];
  /** 最早出现的问题 —— "一个流程都跑不完"时第一个该看的东西 */
  firstIssue?: { seq: number; code: string; source: string; where?: string; message: string };
  /** 一句话结论（列表/告警里直接可读） */
  headline: string;
}

function num(v: unknown, dflt = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function clip(s: string, max = 300): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function parseUsage(raw: string | null | undefined): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
} {
  if (!raw) return { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 };
  try {
    const u = JSON.parse(raw) as Record<string, unknown>;
    const prompt = num(u.promptTokens);
    const completion = num(u.completionTokens);
    return {
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: num(u.totalTokens, prompt + completion),
      costUsd: num(u.costUsd),
    };
  } catch {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 };
  }
}

interface RawIssue {
  seq: number;
  code: string;
  source: string;
  where?: string;
  message: string;
}

/** 收集「过程问题」：工具失败 / 运行时报告 / 子任务失败 / 审批拒绝 / 验证失败 / 回滚 / 注入命中 */
export function collectRunIssues(events: TraceEvent[]): { issues: RawIssue[]; counts: RunDigest['counts'] } {
  const counts: RunDigest['counts'] = {
    toolFails: 0,
    runtimeErrors: 0,
    subtaskFailed: 0,
    subtaskCompleted: 0,
    approvalDenied: 0,
    verifyFailed: 0,
    changeRolledBack: 0,
    untrustedFlagged: 0,
  };
  const raw: RawIssue[] = [];

  // 复用 run 报告的聚合口径（工具失败 / runtime_error / subtask_failed 的字段形态在这里已经统一过）
  const agg = aggregateRunEvents(events);
  for (const e of agg.errors) {
    raw.push({ seq: e.seq, code: e.code, source: e.source, where: e.name, message: clip(e.message) });
  }

  for (const e of events) {
    const d = asRecord(e.data);
    switch (e.type) {
      case 'tool_failed':
        counts.toolFails += 1;
        break;
      case 'runtime_error':
        counts.runtimeErrors += 1;
        break;
      case 'subtask_failed':
        counts.subtaskFailed += 1;
        break;
      case 'subtask_completed':
        counts.subtaskCompleted += 1;
        break;
      case 'approval_decided': {
        if (str(d.value) === 'deny') {
          counts.approvalDenied += 1;
          raw.push({
            seq: e.seq,
            code: 'APPROVAL_DENIED',
            source: 'approval',
            where: str(d.actor) || undefined,
            message: clip(str(d.reason) || `审批被拒绝（${str(d.value)}）`),
          });
        }
        break;
      }
      case 'verification_completed': {
        if (d.ok === false && d.cancelled !== true) {
          counts.verifyFailed += 1;
          raw.push({
            seq: e.seq,
            code: 'VERIFY_FAILED',
            source: 'verification',
            where: str(d.level) || str(d.phase) || undefined,
            message: clip(str(d.summary) || `L2 宿主复验失败（exitCode=${num(d.exitCode, -1)}）`),
          });
        }
        break;
      }
      case 'change_rolled_back':
        counts.changeRolledBack += 1;
        raw.push({
          seq: e.seq,
          code: 'CHANGE_ROLLED_BACK',
          source: 'verification',
          message: clip(str(d.reason) || '落盘后验证失败，已自动回滚'),
        });
        break;
      case 'untrusted_content_flagged':
        counts.untrustedFlagged += 1;
        raw.push({
          seq: e.seq,
          code: 'UNTRUSTED_CONTENT_FLAGGED',
          source: 'security',
          where: str(d.toolName) || undefined,
          message: clip(
            `不可信工具输出命中注入特征：${Array.isArray(d.hits) ? (d.hits as unknown[]).join(',') : str(d.hits)}`,
          ),
        });
        break;
      default:
        break;
    }
  }
  raw.sort((a, b) => a.seq - b.seq);
  return { issues: raw, counts };
}

/** 按 `code + where` 聚合（同一工具反复失败只算一类，但保留次数） */
export function groupIssues(raw: RawIssue[]): RunDigestIssue[] {
  const map = new Map<string, RunDigestIssue>();
  for (const r of raw) {
    const key = `${r.code}::${r.where ?? ''}`;
    const hit = map.get(key);
    if (hit) {
      hit.count += 1;
      hit.lastSeq = Math.max(hit.lastSeq, r.seq);
      continue;
    }
    map.set(key, {
      code: r.code,
      source: r.source,
      where: r.where,
      count: 1,
      firstSeq: r.seq,
      lastSeq: r.seq,
      message: r.message,
    });
  }
  return [...map.values()].sort((a, b) => a.firstSeq - b.firstSeq);
}

/** 汇总落盘的 `context_compacted` 事件（R23 观测：次数 / 移除条数 / 最大深度 / 摘要大小） */
export function summarizeCompaction(events: TraceEvent[]): RunDigest['compaction'] {
  let seen = false;
  let count = 0;
  let removedMessages = 0;
  let maxDepth = 0;
  let lastSummaryChars = 0;
  let capReached = false;
  let maxWatermark = 0;
  let lastPromptTokens = 0;
  let contextWindow = 0;
  const watermarkSources = new Set<string>();
  for (const e of events) {
    if (e.type !== 'context_compacted') continue;
    const d = asRecord(e.data);
    seen = true;
    // capReached 是“停止压缩”的标记事件，不计入实际压缩次数。
    if (d.capReached !== true) count += 1;
    removedMessages += num(d.removedMessages ?? d.compacted);
    maxDepth = Math.max(maxDepth, num(d.depth));
    lastSummaryChars = num(d.summaryChars, lastSummaryChars);
    if (d.capReached === true) capReached = true;
    maxWatermark = Math.max(maxWatermark, num(d.watermark));
    lastPromptTokens = num(d.promptTokens, lastPromptTokens);
    const cw = num(d.contextWindow);
    if (cw > 0) contextWindow = cw;
    if (typeof d.watermarkSource === 'string' && d.watermarkSource) {
      watermarkSources.add(d.watermarkSource);
    }
  }
  if (!seen) return undefined;
  return {
    count,
    removedMessages,
    maxDepth,
    lastSummaryChars,
    capReached,
    ...(maxWatermark > 0 ? { maxWatermark: +maxWatermark.toFixed(3) } : {}),
    ...(watermarkSources.size ? { watermarkSources: [...watermarkSources] } : {}),
    ...(lastPromptTokens > 0 ? { lastPromptTokens } : {}),
    ...(contextWindow > 0 ? { contextWindow } : {}),
  };
}

function headlineOf(input: {
  status: string;
  errorCode?: string;
  failureReason?: string;
  triggeredLimit?: string;
  issues: RunDigestIssue[];
}): string {
  const issueNote = input.issues.length
    ? `过程另有 ${input.issues.length} 类问题（共 ${input.issues.reduce((n, i) => n + i.count, 0)} 次：${input.issues
        .slice(0, 3)
        .map((i) => (i.where ? `${i.code}@${i.where}` : i.code))
        .join('、')}${input.issues.length > 3 ? '…' : ''}）`
    : '过程无错误';
  switch (input.status) {
    case 'completed':
      return input.issues.length ? `完成，但${issueNote}` : '完成，过程无错误';
    case 'awaiting_user':
      return `等待用户回答（暂停），${issueNote}`;
    case 'cancelled':
      return `已取消，${issueNote}`;
    case 'limit_reached':
      return `触顶中断（${input.triggeredLimit ?? input.errorCode ?? 'limit'}）：${clip(input.failureReason ?? '', 120)}`;
    default:
      return `失败（${input.errorCode ?? 'UNKNOWN'}）：${clip(input.failureReason ?? '无 failureReason', 160)}｜${issueNote}`;
  }
}

/**
 * 构造一次 run 的复盘摘要（纯函数，零 I/O）。
 * @param run       runs 行（store.getRun 的结果）
 * @param events    该 run 的全部事件（调用方负责先 flush 事件缓冲再读）
 * @param finishedAt 结束时间（ISO）；缺省用 now
 */
export function buildRunDigest(
  run: RunDigestRun,
  events: TraceEvent[],
  finishedAt: string = new Date().toISOString(),
): RunDigest {
  const byType: Record<string, number> = {};
  for (const e of events) byType[e.type] = (byType[e.type] ?? 0) + 1;

  const { issues: raw, counts } = collectRunIssues(events);
  const issues = groupIssues(raw);
  const compaction = summarizeCompaction(events);

  return {
    version: RUN_DIGEST_VERSION,
    runId: run.runId,
    runType: run.runType,
    status: run.status,
    isMock: run.isMock === true || run.isMock === 1,
    ok: run.status === 'completed',
    goal: clip(run.goal, 200),
    createdAt: run.createdAt,
    finishedAt,
    durationMs: num(run.totalDurationMs),
    ...(run.errorCode ? { errorCode: run.errorCode } : {}),
    ...(run.failureReason ? { failureReason: run.failureReason } : {}),
    ...(run.triggeredLimit ? { triggeredLimit: run.triggeredLimit } : {}),
    counters: {
      steps: num(run.steps),
      modelCalls: num(run.modelCalls),
      toolCalls: num(run.toolCalls),
      ...parseUsage(run.usageJson),
    },
    eventStats: { total: events.length, byType },
    counts,
    ...(compaction ? { compaction } : {}),
    issues,
    ...(issues.length
      ? {
          firstIssue: {
            seq: issues[0].firstSeq,
            code: issues[0].code,
            source: issues[0].source,
            ...(issues[0].where ? { where: issues[0].where } : {}),
            message: issues[0].message,
          },
        }
      : {}),
    headline: headlineOf({
      status: run.status,
      errorCode: run.errorCode ?? undefined,
      failureReason: run.failureReason ?? undefined,
      triggeredLimit: run.triggeredLimit ?? undefined,
      issues,
    }),
  };
}
