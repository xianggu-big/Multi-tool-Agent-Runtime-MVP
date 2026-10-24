// src/scheduler/service.ts — 进程内定时器（只支持 once / daily；不补跑停服错过）
//
// 设计约束：
//   - 不在 buildRuntime() 里启动（测试/演示不得触发真实 run）；由 src/index.ts 显式 start()。
//   - tick() 纯逻辑可单测；默认 30s 一次，`unref` 不阻止进程退出。
//   - 触发 = runtime.enqueue(input)；run.scheduleId 落库，便于查该计划的运行历史。
import type { SqliteStore } from '../store/SqliteStore.js';
import type { RunInput, RunStatus } from '../types.js';
import type { ScheduleRecord } from './types.js';
import { computeNextRunAt, isMissed } from './time.js';
import { sanitizeRunLimits } from '../runtime/runLimits.js';

const ACTIVE_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['queued', 'running', 'waiting_tool', 'awaiting_user']);

export interface SchedulerDeps {
  store: SqliteStore;
  /** 入队一次 run（由服务端注入 Provider 解析逻辑）；返回 runId */
  enqueue: (input: RunInput) => string;
  log?: (msg: string) => void;
}

export interface SchedulerTickResult {
  scheduleId: string;
  runId?: string;
  skipped?: 'overlap';
  missed?: boolean;
  error?: string;
}

export function buildScheduleRunInput(s: ScheduleRecord): RunInput {
  // 防御性收敛：历史记录里可能残留旧版本写入的负数/超大预算。
  const limits = sanitizeRunLimits(s.options.limits);
  const input: RunInput = {
    runType: s.agent,
    goal: s.goal,
    repoPath: s.repoPath,
    scheduleId: s.id,
    // 无人值守自动放行：只在 allowWrite 开启时生效；高危操作仍会被暂缓
    autoApprove: s.autoApprove && s.allowWrite,
    allowRunTests: s.allowRunTests,
    ...limits,
  };
  if (s.options.llm) input.llm = s.options.llm;
  if (s.options.misc) input.misc = s.options.misc;
  if (s.agent === 'orchestrator') {
    input.orchestration = {
      ...(s.options.orchestration ?? {}),
      allowWriteSpecs: s.allowWrite,
    };
  }
  if (s.agent === 'codex') {
    input.codex = {
      allowWrite: s.allowWrite,
      safetyPrompt: s.safetyPrompt,
      dangerPatterns: s.dangerPatterns,
      model: s.options.codex?.model ?? s.options.llm?.model,
      workspaceId: s.options.codex?.workspaceId,
    };
  }
  return input;
}

export class SchedulerService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickAt?: string;
  private lastError?: string;
  private tickCount = 0;

  constructor(
    private readonly deps: SchedulerDeps,
    private readonly intervalMs = 30_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (e) {
        this.lastError = (e as Error).message;
        this.deps.log?.(`[scheduler] tick 失败：${this.lastError}`);
      }
    }, this.intervalMs);
    this.timer.unref?.();
    // 启动即 tick 一次：给刚过点 ≤1 个宽限期的任务一次机会
    try {
      this.tick();
    } catch {
      /* 启动 tick 失败不影响服务 */
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 运行状态（供 /api/health 聚合；不含任务内容）。 */
  status(): { running: boolean; intervalMs: number; lastTickAt?: string; lastError?: string; tickCount: number } {
    return {
      running: !!this.timer,
      intervalMs: this.intervalMs,
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
      tickCount: this.tickCount,
    };
  }

  tick(now: Date = new Date()): SchedulerTickResult[] {
    this.lastTickAt = now.toISOString();
    this.tickCount += 1;
    this.lastError = undefined;
    const results: SchedulerTickResult[] = [];
    for (const s of this.deps.store.listSchedules()) {
      if (!s.enabled || !s.nextRunAt) continue;
      const due = new Date(s.nextRunAt);
      if (Number.isNaN(due.getTime()) || due.getTime() > now.getTime()) continue;

      // 停服错过（超过 1 个 tick 宽限）：不补跑；一次性任务标记 missed 并停用
      if (isMissed(s.nextRunAt, now)) {
        const next = s.frequency === 'once' ? null : computeNextRunAt(s, now);
        this.deps.store.saveSchedule({
          ...s,
          nextRunAt: next ?? undefined,
          enabled: s.frequency === 'once' ? false : s.enabled,
          lastError: 'missed（服务未运行，未补跑）',
          updatedAt: now.toISOString(),
        });
        results.push({ scheduleId: s.id, missed: true });
        continue;
      }

      // 同一计划重叠：默认跳过，不堆 run
      if (this.isOverlapping(s)) {
        const next = s.frequency === 'once' ? null : computeNextRunAt(s, now);
        this.deps.store.saveSchedule({
          ...s,
          nextRunAt: next ?? undefined,
          enabled: s.frequency === 'once' ? false : s.enabled,
          lastError: 'overlap_skipped（上一次运行尚未结束）',
          updatedAt: now.toISOString(),
        });
        results.push({ scheduleId: s.id, skipped: 'overlap' });
        continue;
      }

      try {
        const runId = this.deps.enqueue(buildScheduleRunInput(s));
        const next = s.frequency === 'once' ? null : computeNextRunAt(s, now);
        this.deps.store.saveSchedule({
          ...s,
          lastRunAt: now.toISOString(),
          lastRunId: runId,
          lastStatus: 'queued',
          lastError: undefined,
          nextRunAt: next ?? undefined,
          enabled: s.frequency === 'once' ? false : s.enabled,
          updatedAt: now.toISOString(),
        });
        results.push({ scheduleId: s.id, runId });
      } catch (e) {
        const next = s.frequency === 'once' ? null : computeNextRunAt(s, now);
        this.deps.store.saveSchedule({
          ...s,
          nextRunAt: next ?? undefined,
          enabled: s.frequency === 'once' ? false : s.enabled,
          lastError: (e as Error).message.slice(0, 500),
          updatedAt: now.toISOString(),
        });
        results.push({ scheduleId: s.id, error: (e as Error).message });
      }
    }
    return results;
  }

  /** 立即触发一次（不改变 nextRunAt；一次性任务也不停用） */
  runNow(id: string, now: Date = new Date()): { ok: boolean; runId?: string; error?: string } {
    const s = this.deps.store.getSchedule(id);
    if (!s) return { ok: false, error: '定时任务不存在' };
    if (this.isOverlapping(s)) {
      return { ok: false, error: 'overlap_skipped（上一次运行尚未结束）' };
    }
    try {
      const runId = this.deps.enqueue(buildScheduleRunInput(s));
      this.deps.store.saveSchedule({
        ...s,
        lastRunAt: now.toISOString(),
        lastRunId: runId,
        lastStatus: 'queued',
        lastError: undefined,
        updatedAt: now.toISOString(),
      });
      return { ok: true, runId };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** 上一次 run 是否仍在活动状态（tick 与 run-now 共用；手动触发也必须防重叠）。 */
  private isOverlapping(s: ScheduleRecord): boolean {
    if (!s.skipIfRunning || !s.lastRunId) return false;
    const last = this.deps.store.getRun(s.lastRunId);
    return !!last && ACTIVE_STATUSES.has(last.status);
  }
}
