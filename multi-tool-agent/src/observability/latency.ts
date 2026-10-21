// src/observability/latency.ts — 单 run 慢回答诊断
//
// 回答“一次回答为什么慢、token 花在哪”：
//   1) 看墙钟时间被哪些 span 占用（模型 / 工具 / 其他）；
//   2) 看模型调用内部：prompt vs completion vs reasoning token；
//   3) 看首 token 延迟（TTFT）与总时长，区分“排队慢”还是“生成慢”；
//   4) 看并发收益（并行工具/子任务把 sum(duration) 压缩成 union(duration)）。
//
// 输入是持久化事件（store.getEvents）或实时事件；不需要额外埋点。

import type { RunRecord, TraceEvent } from '../types.js';

export interface SpanTiming {
  spanId: string;
  kind: 'llm' | 'tool' | 'subtask' | 'other';
  name: string;
  step?: number;
  startTs: number;
  endTs: number;
  durationMs: number;
  status: 'ok' | 'error';
  usage?: UsageBreakdown;
  providerLatencyMs?: number;
  model?: string;
  ttftMs?: number;
  streaming?: boolean;
}

export interface UsageBreakdown {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  costUsd: number;
}

export interface TokenHotspot {
  step: number;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface LatencyDiagnosis {
  runId: string;
  status: string;
  wallMs: number;
  modelMs: number;
  toolMs: number;
  modelUnionMs: number;
  toolUnionMs: number;
  busyMs: number;
  overheadMs: number;
  overheadPct: number;
  concurrencySavedMs: number;
  firstTokenMs?: number;
  modelCalls: SpanTiming[];
  toolCalls: SpanTiming[];
  slowest: SpanTiming[];
  tokenHotspots: TokenHotspot[];
  advice: string[];
}

export function diagnoseRun(events: TraceEvent[], run?: RunRecord): LatencyDiagnosis {
  const runId = run?.runId ?? events[0]?.runId ?? 'unknown';
  const status = run?.status ?? inferStatus(events);
  const starts = new Map<string, StartInfo>();
  const firstDelta = new Map<string, number>();
  const modelCalls: SpanTiming[] = [];
  const toolCalls: SpanTiming[] = [];
  let runStart = Number.POSITIVE_INFINITY;
  let runEnd = Number.NEGATIVE_INFINITY;

  for (const e of events) {
    const d = asRecord(e.data);
    const ts = Date.parse(e.timestamp);
    if (e.type === 'run_started') runStart = Math.min(runStart, tsOf(d.startTs, ts));
    if (isTerminal(e.type)) runEnd = Math.max(runEnd, tsOf(d.endTs, ts));
    if (e.type === 'model_request' || e.type === 'tool_started') {
      const spanId = str(d.spanId);
      if (!spanId) continue;
      const prev = starts.get(spanId);
      starts.set(spanId, {
        kind: e.type === 'model_request' ? 'llm' : 'tool',
        name: str(d.name) || (e.type === 'model_request' ? 'llm' : 'tool'),
        step: numberOrUndefined(d.step),
        startTs: tsOf(d.startTs, ts),
        retryStart: prev?.retryStart ?? false,
      });
    }
    if (e.type === 'llm_delta') {
      const spanId = str(d.spanId);
      if (spanId && !firstDelta.has(spanId)) firstDelta.set(spanId, ts);
    }
    if (e.type === 'model_completed') {
      const spanId = str(d.spanId);
      const s = spanId ? starts.get(spanId) : undefined;
      if (!s || !spanId) continue;
      const endTs = tsOf(d.endTs, ts);
      const durationMs = numberOrZero(d.durationMs) || Math.max(0, endTs - s.startTs);
      const usage = parseUsage(d.usage);
      const ttft = firstDelta.get(spanId);
      modelCalls.push({
        spanId,
        kind: 'llm',
        name: s.name,
        step: s.step,
        startTs: s.startTs,
        endTs,
        durationMs,
        status: d.status === 'error' ? 'error' : 'ok',
        usage,
        providerLatencyMs: numberOrUndefined(d.providerLatencyMs),
        model: str(d.model) || undefined,
        ttftMs: ttft !== undefined ? Math.max(0, ttft - s.startTs) : undefined,
        streaming: ttft !== undefined,
      });
    }
    if (e.type === 'tool_completed' || e.type === 'tool_failed') {
      const spanId = str(d.spanId);
      const s = spanId ? starts.get(spanId) : undefined;
      if (!s || !spanId) continue;
      const endTs = tsOf(d.endTs, ts);
      toolCalls.push({
        spanId,
        kind: 'tool',
        name: s.name,
        step: s.step,
        startTs: s.startTs,
        endTs,
        durationMs: numberOrZero(d.durationMs) || Math.max(0, endTs - s.startTs),
        status: e.type === 'tool_failed' ? 'error' : 'ok',
      });
    }
  }

  if (!Number.isFinite(runStart)) runStart = Math.min(...[...modelCalls, ...toolCalls].map((s) => s.startTs), Date.now());
  if (!Number.isFinite(runEnd)) runEnd = Math.max(...[...modelCalls, ...toolCalls].map((s) => s.endTs), runStart);
  const wallMs = run?.totalDurationMs || Math.max(0, runEnd - runStart);
  const modelMs = sum(modelCalls);
  const toolMs = sum(toolCalls);
  const modelUnionMs = unionMs(modelCalls);
  const toolUnionMs = unionMs(toolCalls);
  const busyMs = unionMs([...modelCalls, ...toolCalls]);
  const overheadMs = Math.max(0, wallMs - busyMs);
  const overheadPct = wallMs > 0 ? overheadMs / wallMs : 0;
  const concurrencySavedMs = Math.max(0, modelMs + toolMs - busyMs);
  const firstTokenMs = modelCalls.find((m) => m.ttftMs !== undefined)?.ttftMs;

  const tokenHotspots = buildTokenHotspots(modelCalls);
  const slowest = [...modelCalls, ...toolCalls].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);
  const advice = buildAdvice({ wallMs, modelMs, toolMs, modelUnionMs, toolUnionMs, overheadPct, firstTokenMs, modelCalls, tokenHotspots });

  return {
    runId,
    status,
    wallMs,
    modelMs,
    toolMs,
    modelUnionMs,
    toolUnionMs,
    busyMs,
    overheadMs,
    overheadPct: round4(overheadPct),
    concurrencySavedMs,
    firstTokenMs,
    modelCalls,
    toolCalls,
    slowest,
    tokenHotspots,
    advice,
  };
}

export function formatDiagnosis(d: LatencyDiagnosis): string {
  const lines: string[] = [];
  lines.push(`run ${d.runId}  status=${d.status}  wall=${fmtMs(d.wallMs)}`);
  lines.push(
    `模型 sum=${fmtMs(d.modelMs)} union=${fmtMs(d.modelUnionMs)} · 工具 sum=${fmtMs(d.toolMs)} union=${fmtMs(d.toolUnionMs)}`,
  );
  lines.push(`忙=${fmtMs(d.busyMs)} · 其他/空转=${fmtMs(d.overheadMs)} (${(d.overheadPct * 100).toFixed(1)}%) · 并发节省=${fmtMs(d.concurrencySavedMs)}`);
  if (d.firstTokenMs !== undefined) lines.push(`首 token=${fmtMs(d.firstTokenMs)}`);
  lines.push('最慢 span：');
  for (const s of d.slowest) lines.push(`  ${s.kind.padEnd(4)} ${s.name} step=${s.step ?? '?'} ${fmtMs(s.durationMs)}`);
  if (d.tokenHotspots.length) {
    lines.push('token 热点（按 step）：');
    for (const h of d.tokenHotspots.slice(0, 5)) {
      lines.push(
        `  step ${h.step}: ${h.totalTokens} tok (in ${h.promptTokens} / out ${h.completionTokens} / reasoning ${h.reasoningTokens}) $${h.costUsd.toFixed(4)}`,
      );
    }
  }
  lines.push('诊断建议：');
  for (const a of d.advice) lines.push(`  - ${a}`);
  return lines.join('\n');
}

interface StartInfo {
  kind: 'llm' | 'tool';
  name: string;
  step?: number;
  startTs: number;
  retryStart?: boolean;
}

function buildTokenHotspots(calls: SpanTiming[]): TokenHotspot[] {
  const map = new Map<number, TokenHotspot>();
  for (const c of calls) {
    if (!c.usage) continue;
    const step = c.step ?? 0;
    let h = map.get(step);
    if (!h) {
      h = { step, modelCalls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0, costUsd: 0 };
      map.set(step, h);
    }
    h.modelCalls += 1;
    h.promptTokens += c.usage.promptTokens;
    h.completionTokens += c.usage.completionTokens;
    h.reasoningTokens += c.usage.reasoningTokens;
    h.totalTokens += c.usage.totalTokens;
    h.costUsd += c.usage.costUsd;
  }
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

function buildAdvice(x: {
  wallMs: number;
  modelMs: number;
  toolMs: number;
  modelUnionMs: number;
  toolUnionMs: number;
  overheadPct: number;
  firstTokenMs?: number;
  modelCalls: SpanTiming[];
  tokenHotspots: TokenHotspot[];
}): string[] {
  const out: string[] = [];
  if (x.overheadPct > 0.3) {
    out.push('超过 30% 的墙钟时间不在模型/工具 span 内：优先查事件循环阻塞、队列/限流、落盘/SSE、审批等待。');
  }
  if (x.wallMs > 0 && x.modelUnionMs / x.wallMs > 0.5) {
    out.push('模型调用主导：看 prompt token（检索 top-k/上下文压缩）与 completion/reasoning token（max_tokens/思考深度）。');
  }
  if (x.wallMs > 0 && x.toolUnionMs / x.wallMs > 0.3) {
    out.push('工具调用主导：看最慢工具与 maxToolConcurrency；并行工具看 union 而不是 sum。');
  }
  if (x.firstTokenMs !== undefined && x.firstTokenMs > 2000) {
    out.push('首 token 延迟偏高：常见于长 prompt、上游排队/网络、冷启动；先压缩上下文/换区域，再考虑流式参数。');
  }
  const reasoning = x.tokenHotspots.reduce((n, h) => n + h.reasoningTokens, 0);
  const totalOut = x.tokenHotspots.reduce((n, h) => n + h.completionTokens, 0);
  if (reasoning > 0 && totalOut > 0 && reasoning / totalOut > 0.3) {
    out.push(`思考 token 占输出 ${(reasoning / totalOut * 100).toFixed(0)}%：可降低 reasoning effort，或把简单任务分流到非思考模型。`);
  }
  const prompt = x.tokenHotspots.reduce((n, h) => n + h.promptTokens, 0);
  const total = x.tokenHotspots.reduce((n, h) => n + h.totalTokens, 0);
  if (total > 0 && prompt / total > 0.8) {
    out.push(`输入 token 占 ${(prompt / total * 100).toFixed(0)}%：优先做检索去重、上下文压缩、工具结果截断。`);
  }
  if (!out.length) out.push('未发现明显单点瓶颈；用 P50/P95 和同任务基线对比，避免只看一次 run。');
  return out;
}

function parseUsage(x: unknown): UsageBreakdown {
  const o = asRecord(x);
  return {
    promptTokens: numberOrZero(o.promptTokens),
    completionTokens: numberOrZero(o.completionTokens),
    totalTokens: numberOrZero(o.totalTokens) || numberOrZero(o.promptTokens) + numberOrZero(o.completionTokens),
    reasoningTokens: numberOrZero(o.reasoningTokens),
    costUsd: numberOrZero(o.costUsd),
  };
}

function inferStatus(events: TraceEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i].type;
    if (t === 'run_awaiting_user') return 'awaiting_user';
    if (t === 'run_completed') return 'completed';
    if (t === 'run_failed') return 'failed';
    if (t === 'run_cancelled') return 'cancelled';
    if (t === 'run_limit_reached') return 'limit_reached';
  }
  return 'running';
}

function isTerminal(t: string): boolean {
  return t === 'run_completed' || t === 'run_failed' || t === 'run_cancelled' || t === 'run_limit_reached' || t === 'run_awaiting_user';
}

function unionMs(spans: { startTs: number; endTs: number }[]): number {
  if (!spans.length) return 0;
  const sorted = [...spans].sort((a, b) => a.startTs - b.startTs);
  let total = 0;
  let curStart = sorted[0].startTs;
  let curEnd = sorted[0].endTs;
  for (let i = 1; i < sorted.length; i++) {
    const s = sorted[i];
    if (s.startTs <= curEnd) {
      curEnd = Math.max(curEnd, s.endTs);
    } else {
      total += Math.max(0, curEnd - curStart);
      curStart = s.startTs;
      curEnd = s.endTs;
    }
  }
  total += Math.max(0, curEnd - curStart);
  return total;
}

function sum(spans: { durationMs: number }[]): number {
  return spans.reduce((n, s) => n + s.durationMs, 0);
}

function tsOf(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function asRecord(x: unknown): Record<string, unknown> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return {};
  return x as Record<string, unknown>;
}

function str(x: unknown): string {
  return typeof x === 'string' ? x : '';
}

function numberOrZero(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0;
}

function numberOrUndefined(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}
