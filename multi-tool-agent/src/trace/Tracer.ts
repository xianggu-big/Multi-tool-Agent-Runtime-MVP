// src/trace/Tracer.ts — 检测模块（Instrumentation）
// 职责：
//  1) 用 performance.now()（单调时钟）为 Agent Loop 的每个节点精确计时；
//  2) 生成成对的 span 事件（start / end），携带 spanId / kind / startTs / durationMs / status / 关键输入输出；
//  3) 提供纯函数 buildTraceSnapshot，把事件流聚合为「span 列表 + 根 + 摘要」，供瀑布图 / 流程图直接消费。
// 性能策略：计时与事件构造均为 O(1) 内存操作；落盘交由 EventLogger 的异步批量缓冲，不阻塞主循环。

import { performance } from 'node:perf_hooks';
import type {
  TraceEvent,
  TraceEventType,
  TraceSpan,
  TraceSpanKind,
  TraceSpanStatus,
  TraceSnapshot,
  TraceSummary,
} from '../types.js';
import { EventLogger } from './EventLogger.js';

/** start 事件类型（按 span kind） */
const START_EVENT: Record<TraceSpanKind, TraceEventType> = {
  run: 'run_started',
  step: 'step_started',
  llm: 'model_request',
  tool: 'tool_started',
  subtask: 'subtask_started',
  answer: 'run_completed',
};

/** 成功结束事件类型 */
const END_EVENT: Record<TraceSpanKind, TraceEventType> = {
  run: 'run_completed',
  step: 'checkpoint_saved',
  llm: 'model_completed',
  tool: 'tool_completed',
  subtask: 'subtask_completed',
  answer: 'run_completed',
};

/** 失败/取消结束事件类型（无专门失败事件的 kind 回退到 END_EVENT） */
const ERR_EVENT: Partial<Record<TraceSpanKind, TraceEventType>> = {
  run: 'run_failed',
  tool: 'tool_failed',
  subtask: 'subtask_failed',
};

export interface StartSpanOpts {
  spanId?: string;
  parentId?: string | null;
  step?: number;
  inputs?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface FinishSpanOpts {
  status?: TraceSpanStatus;
  outputs?: Record<string, unknown>;
  error?: { code?: string; message?: string };
  durationMs?: number;
  extra?: Record<string, unknown>;
}

export class Tracer {
  readonly logger: EventLogger;
  private readonly epochBase = Date.now() - performance.now();
  private n = 0;
  /** spanId -> startTs，用于 finish 时计算精确耗时 */
  private open = new Map<string, number>();

  constructor(logger: EventLogger) {
    this.logger = logger;
  }

  /** 单调时钟下的 epoch 毫秒（含小数，可跨 span 精确对齐） */
  now(): number {
    return this.epochBase + performance.now();
  }

  newSpanId(): string {
    this.n += 1;
    return `sp${this.n.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  /** 开始一个 span，emit start 事件，返回 spanId */
  start(runId: string, kind: TraceSpanKind, name: string, opts: StartSpanOpts = {}): string {
    const spanId = opts.spanId ?? this.newSpanId();
    const startTs = this.now();
    this.open.set(spanId, startTs);
    this.logger.emit(runId, START_EVENT[kind], {
      spanId,
      parentId: opts.parentId ?? null,
      kind,
      name,
      startTs,
      step: opts.step,
      inputs: opts.inputs,
      ...opts.extra,
    });
    return spanId;
  }

  /** 结束一个 span，emit 完成/失败事件，返回 durationMs */
  finish(runId: string, spanId: string, kind: TraceSpanKind, opts: FinishSpanOpts = {}): number {
    const startTs = this.open.get(spanId);
    this.open.delete(spanId);
    const endTs = this.now();
    const durationMs = startTs != null ? endTs - startTs : opts.durationMs ?? 0;
    const status: TraceSpanStatus = opts.status ?? 'ok';
    const type =
      status === 'ok' ? END_EVENT[kind] : ERR_EVENT[kind] ?? END_EVENT[kind];
    this.logger.emit(runId, type, {
      spanId,
      kind,
      durationMs,
      endTs,
      status,
      outputs: opts.outputs,
      error: opts.error,
      ...opts.extra,
    });
    return durationMs;
  }

  /** 透传非 span 事件（如 tool_call_requested、checkpoint_saved） */
  emit(runId: string, type: TraceEventType, data?: Record<string, unknown>): void {
    this.logger.emit(runId, type, data);
  }

  /**
   * 模型文本增量（流式思考/正文/工具调用骨架）：只走实时通道，不落盘、不占用持久化序号。
   * 高频调用（每秒数十次），必须保持 O(1)，因此不做任何 I/O。
   */
  delta(runId: string, spanId: string, channel: 'reasoning' | 'content' | 'tool_call', text: string): void {
    this.logger.emit(
      runId,
      'llm_delta',
      { spanId, kind: 'llm', channel, text },
      { persist: false },
    );
  }

  /** 通用临时事件（只推实时通道，不落盘） */
  emitLive(runId: string, type: TraceEventType, data?: Record<string, unknown>): void {
    this.logger.emit(runId, type, data, { persist: false });
  }

  /** 强制落盘（run 收尾 / 服务退出 / 测试读取前） */
  flush(): void {
    this.logger.flush();
  }
}

// ---------------------------------------------------------------------------
// 从事件流聚合 span 快照（纯函数，可对已持久化事件离线重建）
// ---------------------------------------------------------------------------

const END_STATUS: Record<string, TraceSpanStatus> = {
  run_completed: 'ok',
  run_awaiting_user: 'ok',
  model_completed: 'ok',
  tool_completed: 'ok',
  subtask_completed: 'ok',
  tool_failed: 'error',
  subtask_failed: 'error',
  run_failed: 'error',
  run_cancelled: 'cancelled',
  run_limit_reached: 'cancelled',
};

function tsOf(e: TraceEvent): number {
  return new Date(e.timestamp).getTime();
}

export function buildTraceSnapshot(runId: string, status: string, events: TraceEvent[]): TraceSnapshot {
  const spans = new Map<string, TraceSpan>();
  let rootId = '';
  let finalAnswer: string | undefined;
  let runEndTs: number | undefined;

  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, any>;
    const spanId: string | undefined = d.spanId;

    if (e.type === 'run_started' && !rootId) {
      rootId = spanId ?? runId;
      spans.set(rootId, {
        spanId: rootId,
        parentId: d.parentId ?? null,
        runId,
        kind: 'run',
        name: d.name ?? 'run',
        status: 'running',
        startTs: typeof d.startTs === 'number' ? d.startTs : tsOf(e),
        inputs: d.inputs,
      });
      continue;
    }

    // start 类事件：创建 span
    if (
      spanId &&
      (e.type === 'model_request' || e.type === 'tool_started' || e.type === 'step_started' || e.type === 'subtask_started')
    ) {
      // 幂等：同一 spanId 的重复 start 事件不覆盖（真实系统里可能因重试/重复上报出现）
      if (spans.has(spanId)) continue;
      spans.set(spanId, {
        spanId,
        parentId: d.parentId ?? rootId ?? null,
        runId,
        kind: (d.kind as TraceSpanKind) ?? 'llm',
        name: d.name ?? (d.kind as string),
        status: 'running',
        startTs: typeof d.startTs === 'number' ? d.startTs : tsOf(e),
        step: d.step,
        inputs: d.inputs,
      });
      continue;
    }

    // end 类事件：补全 span
    const endStatus = END_STATUS[e.type];
    if (spanId && endStatus) {
      const s = spans.get(spanId);
      const durationMs = typeof d.durationMs === 'number' ? d.durationMs : undefined;
      if (s) {
        s.status = endStatus;
        s.durationMs = durationMs;
        s.endTs = typeof d.endTs === 'number' ? d.endTs : durationMs != null ? s.startTs + durationMs : tsOf(e);
        if (d.outputs) s.outputs = d.outputs;
        if (d.error) s.error = d.error;
      } else if (e.type.startsWith('run_')) {
        // run 终态但未先见到 run_started（异常场景）：补一个 run span
        spans.set(spanId, {
          spanId,
          parentId: null,
          runId,
          kind: 'run',
          name: 'run',
          status: endStatus,
          startTs: tsOf(e),
          durationMs,
          endTs: tsOf(e),
          outputs: d.outputs,
          error: d.error,
        });
        if (!rootId) rootId = spanId;
      }
      if ((e.type === 'run_completed' || e.type === 'run_awaiting_user') && d.outputs?.finalAnswer) {
        finalAnswer = String(d.outputs.finalAnswer);
      }
      if (e.type.startsWith('run_') && (e.type === 'run_completed' || e.type === 'run_failed' || e.type === 'run_cancelled' || e.type === 'run_limit_reached' || e.type === 'run_awaiting_user')) {
        runEndTs = typeof d.endTs === 'number' ? d.endTs : tsOf(e);
      }
    }
  }

  // 未显式关闭的 span（如模型调用失败导致 run failed）：补 error 状态
  for (const s of spans.values()) {
    if (s.status === 'running') {
      s.status = status === 'failed' ? 'error' : 'cancelled';
      if (s.durationMs == null) {
        s.endTs = runEndTs ?? s.startTs;
        s.durationMs = Math.max(0, s.endTs - s.startTs);
      }
    }
  }

  // 合成「最终答案」节点
  if (finalAnswer != null && rootId) {
    const run = spans.get(rootId);
    const at = run?.endTs ?? runEndTs ?? 0;
    spans.set(`ans_${runId}`, {
      spanId: `ans_${runId}`,
      parentId: rootId,
      runId,
      kind: 'answer',
      name: '最终答案',
      status: 'ok',
      startTs: at,
      endTs: at,
      durationMs: 0,
      outputs: { finalAnswer },
    });
  }

  const list = [...spans.values()].sort((a, b) => a.startTs - b.startTs || (a.spanId < b.spanId ? -1 : 1));

  return {
    runId,
    status,
    rootId,
    spans: list,
    summary: summarize(list),
  };
}

function summarize(spans: TraceSpan[]): TraceSummary {
  const perKind: Record<string, { count: number; totalMs: number }> = {};
  let llmCalls = 0;
  let toolCalls = 0;
  let llmTotalMs = 0;
  let toolTotalMs = 0;
  let totalDurationMs = 0;

  for (const s of spans) {
    const ms = s.durationMs ?? 0;
    const k = perKind[s.kind] ?? (perKind[s.kind] = { count: 0, totalMs: 0 });
    k.count += 1;
    k.totalMs += ms;
    if (s.kind === 'llm') {
      llmCalls += 1;
      llmTotalMs += ms;
    } else if (s.kind === 'tool') {
      toolCalls += 1;
      toolTotalMs += ms;
    }
    if (s.kind === 'run') totalDurationMs = Math.max(totalDurationMs, ms);
  }

  return { totalDurationMs, llmCalls, toolCalls, llmTotalMs, toolTotalMs, perKind };
}
