// src/runtime/SubAgentLifecycle.ts — 子 Agent 生命周期与资源自动回收
//
// 解决的问题：
//   子 Agent 完成工作后，是否要保留其上下文以备追问？还是立即销毁释放资源？
//   原 SubAgentPool 只管「并发执行 → 返回结果」，没有「结果拿到后何时释放」的判断。
//   低重要性任务（一次性搜索/清点）若不释放，会让上下文常驻、占用内存与后续任务的 token 预算；
//   高重要性任务（代码审计）又可能需要保留供追问。这套判定器把「何时释放」从隐式变成显式、可解释、可单测。
//
// 设计原则（与既有约定一致）：
//   ① **规则式、不调 LLM**：判定本身不该产生费用与延迟（同 router.ts 的取舍）；
//   ② **可解释**：每次释放都带 reason，便于审计与界面展示「为什么回收了这个子 Agent」；
//   ③ **结构层保证**：ephemeral 的终结性上报（submit_finding）一旦被主 Agent 采纳，立即进入待释放队列；
//   ④ **不隐瞒**：释放前若仍有未消费的结果，显式标记 `unconsumedResult: true`，不静默丢弃。
//
// 业界参考（调研结论，详见 docs/KNOWLEDGE_BASE_ENHANCEMENT.md）：
//   - LangGraph：checkpointer 区分 ephemeral(内存)/persistent(SQLite)，ephemeral 线程结束即丢；
//   - CrewAI：LRU + max STM entries + 任务后 agent.memory.clear()，闲置内存膨胀是已知痛点；
//   - OpenAI Swarm：handoff 后上下文随调用结束自然释放；
//   - 通用 AgentPool 模式：LRU 队列 + 闲置超时(30min) + 池上限驱逐。
//   本实现综合三者：importance 分级 + 闲置超时 + LRU 池上限驱逐 + 结果消费触发释放。

import type { RetentionPolicy, SubAgentImportance } from '../agents/specs.js';

// ---------------------------------------------------------------------------
// 默认保留策略（按 importance 分档；spec 可覆盖）
// ---------------------------------------------------------------------------

export const DEFAULT_RETENTION: Record<SubAgentImportance, Required<Pick<RetentionPolicy, 'importance' | 'idleTimeoutMs' | 'maxAgeMs'>>> = {
  // 一次性任务：结果被采纳后立即释放；即便主 Agent 没及时采纳，最多存活 30min 兜底。
  ephemeral: { importance: 'ephemeral', idleTimeoutMs: 30_000, maxAgeMs: 30 * 60_000 },
  // 会话级：保留供追问，5min 无活动后释放。
  session: { importance: 'session', idleTimeoutMs: 5 * 60_000, maxAgeMs: 4 * 60 * 60_000 },
  // 长生命周期：30min 无活动释放，最长 24h。
  durable: { importance: 'durable', idleTimeoutMs: 30 * 60_000, maxAgeMs: 24 * 60 * 60_000 },
};

/** 把 spec 的 retention（可能部分填写）补全成完整策略 */
export function resolveRetention(r?: RetentionPolicy): Required<Pick<RetentionPolicy, 'importance' | 'idleTimeoutMs' | 'maxAgeMs'>> {
  const base = DEFAULT_RETENTION[r?.importance ?? 'ephemeral'];
  return {
    importance: r?.importance ?? base.importance,
    idleTimeoutMs: r?.idleTimeoutMs ?? base.idleTimeoutMs,
    maxAgeMs: r?.maxAgeMs ?? base.maxAgeMs,
  };
}

// ---------------------------------------------------------------------------
// 子 Agent 句柄（生命周期管理器追踪的最小单元）
// ---------------------------------------------------------------------------

export type HandleStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'limit_reached' | 'released';

export interface SubAgentHandle {
  /** 子任务 id（st_xxx，与 SubtaskOutcome.subtaskId 对齐） */
  id: string;
  specId: string;
  specTitle: string;
  parentRunId: string;
  importance: SubAgentImportance;
  bornAt: number;
  /** 最近一次活动时间（模型/工具调用、主 Agent 追问都会刷新） */
  lastActiveAt: number;
  status: HandleStatus;
  /** 主 Agent 是否已采纳（merge）该子任务的结果 */
  resultConsumed: boolean;
  /** 是否调用了终结性上报工具（submit_finding） */
  terminalReported: boolean;
  /** 触发的限制名（maxSteps / totalTimeout / maxModelCalls / maxToolCalls） */
  triggeredLimit?: string;
  idleTimeoutMs: number;
  maxAgeMs: number;
  /** 释放时尚未被消费的结果（释放时若 resultConsumed=false 则置 true，不静默丢弃） */
  unconsumedResult?: boolean;
}

// ---------------------------------------------------------------------------
// 释放判定：纯函数，输入句柄 + 当前上下文 → 是否释放 + 原因
// ---------------------------------------------------------------------------

export interface ReleaseContext {
  now: number;
  /** 父任务是否已取消（AbortSignal.aborted） */
  parentAborted?: boolean;
  /** 池内当前存活实例数（用于 LRU 驱逐判定） */
  poolSize?: number;
  /** 池上限（超过时触发驱逐） */
  maxPoolSize?: number;
}

export interface ReleaseDecision {
  release: boolean;
  reason: string;
  /** 触发的判定规则名（便于统计与界面归类） */
  rule: ReleaseRule;
}

export type ReleaseRule =
  | 'parent_cancelled'
  | 'max_age_exceeded'
  | 'idle_timeout'
  | 'ephemeral_terminal' // ephemeral + 终结性上报完成 → 立即释放
  | 'ephemeral_consumed' // ephemeral + 结果已被主 Agent 采纳 → 释放
  | 'ephemeral_budget' // ephemeral + 预算耗尽 → 释放（无结果可消费）
  | 'failed_unrecoverable'
  | 'pool_eviction'; // LRU 驱逐

/**
 * 核心：判断单个子 Agent 是否应被释放。
 *
 * 判定顺序（前一条命中即返回，优先级从高到低）：
 *   1. 父任务取消 → 立即释放（级联取消，与 SubAgentPool 的 abortedResult 语义一致）；
 *   2. 硬性 maxAge 到期 → 释放（任何 tier 的兜底，防止常驻泄漏）；
 *   3. 不可恢复失败 → 释放（失败结果仍保留供主 Agent 核验，但资源回收）；
 *   4. ephemeral + 终结性上报完成 → 立即释放（一次性任务的典型路径）；
 *   5. ephemeral + 结果已被消费 → 释放；
 *   6. ephemeral + 预算耗尽（无结果） → 释放；
 *   7. 闲置超时（session/durable 主力规则；ephemeral 兜底） → 释放。
 *
 * 注意：session/durable 即使终结性上报完成也**不**立即释放——它们保留供追问，
 *      直到闲置超时或显式 retire()。这是 ephemeral 与 session 的本质区别。
 */
export function shouldRelease(h: SubAgentHandle, ctx: ReleaseContext): ReleaseDecision {
  // 已释放的不再判定
  if (h.status === 'released') return { release: false, reason: 'already released', rule: 'idle_timeout' };

  // 1. 父任务取消
  if (ctx.parentAborted) {
    return { release: true, reason: '父任务已取消，子 Agent 级联释放', rule: 'parent_cancelled' };
  }

  // 2. 硬性 maxAge
  if (ctx.now - h.bornAt > h.maxAgeMs) {
    return {
      release: true,
      reason: `达到最大存活时长 ${Math.round(h.maxAgeMs / 1000)}s（任何 tier 的硬性兜底）`,
      rule: 'max_age_exceeded',
    };
  }

  // 3. 不可恢复失败
  if (h.status === 'failed') {
    return { release: true, reason: '子 Agent 不可恢复失败，回收资源（失败结果已保留供核验）', rule: 'failed_unrecoverable' };
  }

  // 4-6. ephemeral 的即时释放路径
  if (h.importance === 'ephemeral') {
    if (h.terminalReported && h.status === 'completed') {
      return { release: true, reason: '一次性任务已终结上报，立即释放上下文', rule: 'ephemeral_terminal' };
    }
    if (h.resultConsumed) {
      return { release: true, reason: '一次性任务结果已被主 Agent 采纳，释放上下文', rule: 'ephemeral_consumed' };
    }
    if (h.status === 'limit_reached') {
      return { release: true, reason: `一次性任务预算耗尽（${h.triggeredLimit ?? '未知'}），无结果可消费，释放`, rule: 'ephemeral_budget' };
    }
  }

  // 7. 闲置超时（所有 tier 共用的兜底；ephemeral 的 idleTimeoutMs 默认很短=30s）
  const idleMs = ctx.now - h.lastActiveAt;
  if (idleMs > h.idleTimeoutMs) {
    return {
      release: true,
      reason: `闲置 ${Math.round(idleMs / 1000)}s 超过阈值 ${Math.round(h.idleTimeoutMs / 1000)}s，释放`,
      rule: 'idle_timeout',
    };
  }

  return { release: false, reason: '存活中', rule: 'idle_timeout' };
}

// ---------------------------------------------------------------------------
// 池级 LRU 驱逐：池满时挑出最该释放的句柄
// ---------------------------------------------------------------------------

/**
 * 池满时选一个牺牲者。优先级（先驱逐「便宜」的）：
 *   1. 已完成/失败/取消的 ephemeral（无保留价值）；
 *   2. 闲置最久的 ephemeral；
 *   3. 闲置最久的 session；
 *   4. 最后才考虑 durable（通常不会走到这步——durable 应有更大的 maxAge 兜底）。
 * 返回应驱逐的句柄 id；池未满或无可驱逐者返回 null。
 */
export function pickEvictionVictim(
  handles: SubAgentHandle[],
  opts: { maxPoolSize: number; now: number },
): string | null {
  if (handles.length <= opts.maxPoolSize) return null;

  const live = handles.filter((h) => h.status !== 'released');
  if (!live.length) return null;

  // 1. 已结束的 ephemeral 优先驱逐
  const finishedEphemeral = live.filter(
    (h) => h.importance === 'ephemeral' && (h.status === 'completed' || h.status === 'failed' || h.status === 'cancelled'),
  );
  if (finishedEphemeral.length) {
    return finishedEphemeral.sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0].id;
  }

  // 2. 闲置最久的 ephemeral
  const ephemerals = live.filter((h) => h.importance === 'ephemeral');
  if (ephemerals.length) {
    return ephemerals.sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0].id;
  }

  // 3. 闲置最久的 session
  const sessions = live.filter((h) => h.importance === 'session');
  if (sessions.length) {
    return sessions.sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0].id;
  }

  // 4. durable 兜底
  return live.sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0].id;
}

// ---------------------------------------------------------------------------
// 生命周期管理器（有状态：追踪存活句柄，周期性扫描释放）
// ---------------------------------------------------------------------------

export interface ReleaseEvent {
  id: string;
  rule: ReleaseRule;
  reason: string;
  unconsumedResult: boolean;
  at: number;
}

export interface LifecycleOptions {
  /** 池上限（同时存活的子 Agent 数；超过触发 LRU 驱逐） */
  maxPoolSize?: number;
  /** 扫描间隔（ms）；调用方按此间隔触发 sweep() */
  sweepIntervalMs?: number;
  /** 释放回调（用于实际清理上下文 / 发事件 / 写审计） */
  onRelease?: (e: ReleaseEvent) => void;
  /** 时钟注入（单测用） */
  now?: () => number;
}

export class SubAgentLifecycle {
  private handles = new Map<string, SubAgentHandle>();
  private readonly maxPoolSize: number;
  readonly sweepIntervalMs: number;
  private readonly onRelease?: (e: ReleaseEvent) => void;
  private readonly now: () => number;

  constructor(opts: LifecycleOptions = {}) {
    this.maxPoolSize = opts.maxPoolSize ?? 16;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 10_000;
    this.onRelease = opts.onRelease;
    this.now = opts.now ?? (() => Date.now());
  }

  /** 注册一个新子 Agent 句柄（派发子任务时调用） */
  register(h: {
    id: string;
    specId: string;
    specTitle: string;
    parentRunId: string;
    retention?: RetentionPolicy;
  }): SubAgentHandle {
    const r = resolveRetention(h.retention);
    const t = this.now();
    const handle: SubAgentHandle = {
      id: h.id,
      specId: h.specId,
      specTitle: h.specTitle,
      parentRunId: h.parentRunId,
      importance: r.importance,
      bornAt: t,
      lastActiveAt: t,
      status: 'running',
      resultConsumed: false,
      terminalReported: false,
      idleTimeoutMs: r.idleTimeoutMs,
      maxAgeMs: r.maxAgeMs,
    };
    this.handles.set(h.id, handle);
    // 注册即检查池是否超限（LRU 驱逐）
    this.maybeEvict();
    return handle;
  }

  /** 刷新活动时间（模型/工具调用、主 Agent 追问时调用） */
  touch(id: string): void {
    const h = this.handles.get(id);
    if (h && h.status !== 'released') h.lastActiveAt = this.now();
  }

  /** 标记终结性上报完成（submit_finding 成功） */
  markTerminalReported(id: string): void {
    const h = this.handles.get(id);
    if (h && h.status === 'running') {
      h.terminalReported = true;
      h.status = 'completed';
      h.lastActiveAt = this.now();
    }
  }

  /** 标记结果已被主 Agent 采纳 */
  markConsumed(id: string): void {
    const h = this.handles.get(id);
    if (h) {
      h.resultConsumed = true;
      h.lastActiveAt = this.now();
    }
  }

  /** 标记失败/取消/限额 */
  markEnded(id: string, status: 'failed' | 'cancelled' | 'limit_reached', extra?: { triggeredLimit?: string }): void {
    const h = this.handles.get(id);
    if (h && h.status === 'running') {
      h.status = status;
      h.triggeredLimit = extra?.triggeredLimit;
      h.lastActiveAt = this.now();
    }
  }

  /** 显式退役（durable 的正常结束路径） */
  retire(id: string): void {
    this.release(id, { rule: 'idle_timeout', reason: '显式退役', force: true });
  }

  /** 释放单个句柄 */
  private release(id: string, o: { rule: ReleaseRule; reason: string; force?: boolean }): void {
    const h = this.handles.get(id);
    if (!h || h.status === 'released') return;
    const unconsumedResult = !h.resultConsumed && h.status === 'completed';
    h.status = 'released';
    h.unconsumedResult = unconsumedResult;
    this.onRelease?.({
      id,
      rule: o.rule,
      reason: o.reason,
      unconsumedResult,
      at: this.now(),
    });
  }

  /** 池满驱逐 */
  private maybeEvict(): void {
    const live = [...this.handles.values()].filter((h) => h.status !== 'released');
    if (live.length <= this.maxPoolSize) return;
    const victim = pickEvictionVictim(live, { maxPoolSize: this.maxPoolSize, now: this.now() });
    if (victim) {
      this.release(victim, { rule: 'pool_eviction', reason: '池满 LRU 驱逐' });
    }
  }

  /**
   * 周期性扫描：遍历所有存活句柄，按 shouldRelease 判定释放。
   * @param parentRunId 可选：只扫描某个父任务的子 Agent
   * @param parentAborted 父任务是否已取消
   * @returns 本次释放的事件列表
   */
  sweep(opts: { parentRunId?: string; parentAborted?: boolean } = {}): ReleaseEvent[] {
    const events: ReleaseEvent[] = [];
    const now = this.now();
    for (const h of this.handles.values()) {
      if (h.status === 'released') continue;
      if (opts.parentRunId && h.parentRunId !== opts.parentRunId) continue;
      const dec = shouldRelease(h, { now, parentAborted: opts.parentAborted, poolSize: this.liveCount(), maxPoolSize: this.maxPoolSize });
      if (dec.release) {
        this.release(h.id, { rule: dec.rule, reason: dec.reason });
        events.push({ id: h.id, rule: dec.rule, reason: dec.reason, unconsumedResult: !!h.unconsumedResult, at: now });
      }
    }
    return events;
  }

  /** 父任务取消时，级联释放其所有子 Agent */
  cancelByParent(parentRunId: string): ReleaseEvent[] {
    return this.sweep({ parentRunId, parentAborted: true });
  }

  liveCount(): number {
    let c = 0;
    for (const h of this.handles.values()) if (h.status !== 'released') c++;
    return c;
  }

  get(id: string): SubAgentHandle | undefined {
    return this.handles.get(id);
  }

  /** 统计（供报告/健康检查） */
  stats(): {
    total: number;
    live: number;
    byImportance: Record<SubAgentImportance, number>;
    byStatus: Record<string, number>;
    unconsumedReleases: number;
  } {
    const byImportance: Record<SubAgentImportance, number> = { ephemeral: 0, session: 0, durable: 0 };
    const byStatus: Record<string, number> = {};
    let live = 0;
    let unconsumed = 0;
    for (const h of this.handles.values()) {
      byImportance[h.importance]++;
      byStatus[h.status] = (byStatus[h.status] ?? 0) + 1;
      if (h.status !== 'released') live++;
      if (h.unconsumedResult) unconsumed++;
    }
    return { total: this.handles.size, live, byImportance, byStatus, unconsumedReleases: unconsumed };
  }
}
