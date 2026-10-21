// src/trace/EventLogger.ts — 结构化事件记录（可观测性）
// 要求：每个事件含 runId、递增序号、时间戳、结构化数据；
//       禁止把 API Key 等秘密写入日志；对模型上下文/代码/网页内容做长度限制与脱敏。
//
// 双通道设计（实时流式展示）：
//   1) 持久化通道：批量缓冲 → setImmediate → 落盘（seq 严格连续，可回放）；
//   2) 实时通道（onLive）：事件构造完成即刻回调（毫秒级），供 SSE 立即推送。
//   persist:false 的临时事件（如高频 llm_delta 文本增量）只走实时通道：
//   不落盘、不占用持久化 seq（固定为 0，标记 ephemeral），因此持久化事件序号仍严格连续。

import type { TraceEvent, TraceEventType } from '../types.js';

const SECRET_KEYS = new Set([
  'apikey',
  'api_key',
  'key',
  'token',
  'secret',
  'password',
  'authorization',
  'bearer',
  'accesstoken',
  'refreshtoken',
]);

const SECRET_VALUE_RE = /(sk-[A-Za-z0-9]{12,})|(AKIA[0-9A-Z]{16})|(Bearer\s+[A-Za-z0-9._-]+)/g;

/** seq 计数上限（LRU 淘汰最老的 run），防止长跑服务按 runId 无限增长。
 *
 * 2026-10-20 修正：**终态不再清零计数**。原实现在 run_completed/run_cancelled 时删掉计数器，
 * 但实测出现过「主 run 已 completed、仍有子任务在飞」→ 后续事件从 seq=1 重新编号，
 * 与历史事件撞号（同一 run 出现重复 seq，回放/前端排序全乱）。现在改为保留 + LRU 上限。 */
const DEFAULT_MAX_TRACKED_RUNS = 2000;

export interface EventLoggerOptions {
  maxContentChars: number;
  /** 持久化回调（单条，同步）。与 onPersistBatch 二选一；提供 batch 时优先使用。 */
  onPersist?: (e: TraceEvent) => void;
  /** 批量持久化回调（异步缓冲 flush 使用），性能优于逐条 onPersist。 */
  onPersistBatch?: (events: TraceEvent[]) => void;
  /**
   * 实时回调：事件构造完成即刻触发（不等落盘）。
   * 供 SSE 快车道推送；必须是 O(1) 的轻量操作（禁止同步 I/O）。
   */
  onLive?: (e: TraceEvent) => void;
  /** 是否打印到控制台（临时事件不打印，避免高频刷屏） */
  console?: boolean;
  /** 临时事件的统计回调（仅调试用，可选） */
  onEphemeral?: (e: TraceEvent) => void;
  /** seq 计数最多跟踪多少个 run（LRU 淘汰，默认 2000；测试可调小） */
  maxTrackedRuns?: number;
}

export interface EmitOptions {
  /**
   * 是否持久化。默认 true。
   * false = 临时事件：只走实时通道，seq=0 且 ephemeral=true（例如 llm_delta）。
   */
  persist?: boolean;
}

export class EventLogger {
  private seqByRun = new Map<string, number>();
  private buffer: TraceEvent[] = [];
  private scheduled = false;
  /** 临时事件计数（调试统计用） */
  private ephemeralCount = 0;

  constructor(private readonly opts: EventLoggerOptions) {}

  emit(
    runId: string,
    type: TraceEventType,
    data?: Record<string, unknown>,
    opts: EmitOptions = {},
  ): TraceEvent {
    const persist = opts.persist !== false;
    const sanitized = data ? (this.sanitize(data) as Record<string, unknown>) : undefined;

    let event: TraceEvent;
    if (persist) {
      const seq = (this.seqByRun.get(runId) ?? 0) + 1;
      this.rememberSeq(runId, seq);
      event = { runId, seq, type, timestamp: new Date().toISOString(), data: sanitized };
    } else {
      this.ephemeralCount += 1;
      event = { runId, seq: 0, type, timestamp: new Date().toISOString(), data: sanitized, ephemeral: true };
    }

    // 实时通道：先推（毫秒级），再走持久化缓冲。
    if (this.opts.onLive) {
      try {
        this.opts.onLive(event);
      } catch {
        /* 实时回调失败不得影响主流程 */
      }
    }

    if (persist) {
      // 性能关键路径：入内存队列 + 调度一个 setImmediate 批量落盘，避免在 LLM/工具调用主循环里同步写库。
      if (this.opts.onPersistBatch) {
        this.buffer.push(event);
        this.scheduleFlush();
      } else if (this.opts.onPersist) {
        this.opts.onPersist(event); // 无批量回调时保持同步，向后兼容
      }
      if (this.opts.console !== false) {
        const preview = this.redactString(JSON.stringify(event.data ?? {}));
        console.log(`[trace] ${event.timestamp} #${event.seq} ${type} run=${runId} ${preview}`);
      }
    } else if (this.opts.onEphemeral) {
      this.opts.onEphemeral(event);
    }

    return event;
  }

  /** 立即将缓冲事件批量落盘。run 收尾、服务退出、测试读取前应调用。 */
  flush(): void {
    this.scheduled = false;
    if (!this.opts.onPersistBatch || !this.buffer.length) return;
    const batch = this.buffer;
    this.buffer = [];
    this.opts.onPersistBatch(batch);
  }

  /** 尚未落盘的事件数（调试用） */
  pendingCount(): number {
    return this.buffer.length;
  }

  /** 临时事件累计数（调试用 / 性能观测） */
  ephemeralTotal(): number {
    return this.ephemeralCount;
  }

  /** 仍在跟踪 seq 的 run 数（防泄漏回归用）。 */
  trackedRuns(): number {
    return this.seqByRun.size;
  }

  /**
   * 终态 run 之后还要追加事件时（例如手动 L2 深度验证），先把序号恢复到最后一条持久化事件之后。
   * run_completed / run_cancelled 会主动删掉计数（防长跑服务按 runId 泄漏）；这里只抬不降，
   * 因此不会影响仍在跟踪的 failed / limit_reached。
   */
  ensureSeqAtLeast(runId: string, lastSeq: number): void {
    const cur = this.seqByRun.get(runId) ?? 0;
    if (lastSeq > cur) this.rememberSeq(runId, lastSeq);
  }

  /** 记录 seq 并做 LRU 淘汰（Map 保持插入顺序，删最老的 key） */
  private rememberSeq(runId: string, seq: number): void {
    this.seqByRun.delete(runId); // 先删再插 = 刷新为最新
    this.seqByRun.set(runId, seq);
    const cap = this.opts.maxTrackedRuns ?? DEFAULT_MAX_TRACKED_RUNS;
    while (this.seqByRun.size > cap) {
      const oldest = this.seqByRun.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.seqByRun.delete(oldest);
    }
  }

  /**
   * 丢弃某个 run 的 seq 计数（仅用于「已确定不会再追加事件」的终态）。
   * 背景：`run_completed`/`run_cancelled` 会在 emit 时自动清理，但复盘摘要（`run_digest`）
   * 是在终态事件**之后**追加的，需要先恢复计数再写一条，最后收尾清理，避免长跑服务按 runId 泄漏。
   */
  forgetRun(runId: string): void {
    this.seqByRun.delete(runId);
  }

  private scheduleFlush(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => this.flush());
  }

  private sanitize(value: unknown, depth = 0): unknown {
    if (depth > 12) return '…';
    if (typeof value === 'string') {
      return this.redactString(value.length > this.opts.maxContentChars ? value.slice(0, this.opts.maxContentChars) + '…[truncated]' : value);
    }
    if (Array.isArray(value)) {
      return value.slice(0, 200).map((v) => this.sanitize(v, depth + 1));
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const lk = k.toLowerCase();
        if (SECRET_KEYS.has(lk)) {
          out[k] = '***REDACTED***';
        } else {
          out[k] = this.sanitize(v, depth + 1);
        }
      }
      return out;
    }
    return value;
  }

  private redactString(s: string): string {
    return s.replace(SECRET_VALUE_RE, '***REDACTED***');
  }
}
