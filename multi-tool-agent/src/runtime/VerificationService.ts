// src/runtime/VerificationService.ts — 终态 run 的手动 L2 深度验证（宿主全量测试）
//
// 为什么需要它：落盘后的 hostVerify 已经跑过一次全量，但用户可能想在任何时候重新确认
// "当前仓库仍然全绿"（例如改完后又手动改了一个文件、或想给同事一个可追溯的验证证据）。
// 这里把全量验证做成异步任务：排队 → 运行 → 通过/失败/取消，状态经 HTTP 查询，
// 同时写 verification_started/completed 事件，报告可归因。
//
// 边界：
//   - 只允许对终态 run 启动（避免与正在跑的 Agent 同时改文件）；
//   - 全局并发默认 1（全量测试是重资源，排队比并发抢 CPU 更可预期）；
//   - 状态在内存中（本地单实例 MVP）；服务重启后进行中的任务会消失，需重新发起。
import { randomUUID } from 'node:crypto';
import type { TraceEventType } from '../types.js';
import { runHostFullSuite } from '../sandbox/hostVerify.js';
import type { VerificationMode } from '../sandbox/verificationPlan.js';

export type VerificationStatus = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled';

export interface VerificationJob {
  jobId: string;
  runId: string;
  status: VerificationStatus;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  timedOut?: boolean;
  summary: string;
  excerpt?: string;
  /** full_suite=跑了行为测试；typecheck=只做类型检查；unavailable=没有可跑的验证 */
  mode?: VerificationMode;
  coverage?: 'full' | 'typecheck' | 'none';
}

interface InternalJob extends VerificationJob {
  repoPath: string;
  controller?: AbortController;
}

export interface VerificationServiceOptions {
  nodePath: string;
  timeoutMs?: number;
  /** 允许测试夹具覆盖默认 node 参数（默认 `--import tsx --test tests/*.test.ts`） */
  nodeArgs?: string[];
  /** 事件通道（Runtime 注入；终态 run 需要先 seed 序号） */
  emit?: (runId: string, type: TraceEventType, data?: Record<string, unknown>) => void;
  /** 每次启动前调用：把 EventLogger 的序号恢复到持久化最大值之后 */
  prepareEvent?: (runId: string) => void;
  /** 全局并发上限（默认 1） */
  maxConcurrent?: number;
}

export class VerificationService {
  private jobs = new Map<string, InternalJob>();
  private queue: string[] = [];
  private running = 0;

  constructor(private readonly opts: VerificationServiceOptions) {}

  start(
    runId: string,
    repoPath: string,
  ): { ok: true; job: VerificationJob } | { ok: false; code: 'ALREADY_RUNNING'; job: VerificationJob } {
    const existing = this.jobs.get(runId);
    if (existing && (existing.status === 'queued' || existing.status === 'running')) {
      return { ok: false, code: 'ALREADY_RUNNING', job: this.publicJob(existing) };
    }
    const job: InternalJob = {
      jobId: `ver_${randomUUID().slice(0, 8)}`,
      runId,
      status: 'queued',
      queuedAt: new Date().toISOString(),
      summary: '已排队（同一时间只跑一个全量验证）',
      repoPath,
    };
    this.jobs.set(runId, job);
    this.queue.push(runId);
    this.pump();
    return { ok: true, job: this.publicJob(job) };
  }

  get(runId: string): VerificationJob | null {
    const j = this.jobs.get(runId);
    return j ? this.publicJob(j) : null;
  }

  cancel(runId: string): { cancelled: boolean; job: VerificationJob | null } {
    const j = this.jobs.get(runId);
    if (!j) return { cancelled: false, job: null };
    if (j.status === 'queued') {
      this.queue = this.queue.filter((id) => id !== runId);
      this.finishCancelled(j, '已取消（尚未开始）');
      return { cancelled: true, job: this.publicJob(j) };
    }
    if (j.status === 'running' && j.controller && !j.controller.signal.aborted) {
      j.controller.abort();
      return { cancelled: true, job: this.publicJob(j) };
    }
    return { cancelled: false, job: this.publicJob(j) };
  }

  /** 测试/优雅停机：取消全部并清空（不等待子进程退出，spawnAsync 会 kill）。 */
  dispose(): void {
    for (const j of this.jobs.values()) {
      if (j.status === 'queued' || j.status === 'running') j.controller?.abort();
    }
    this.queue = [];
  }

  private pump(): void {
    const max = Math.max(1, this.opts.maxConcurrent ?? 1);
    while (this.running < max && this.queue.length) {
      const runId = this.queue.shift()!;
      const job = this.jobs.get(runId);
      if (!job || job.status !== 'queued') continue;
      void this.run(job);
    }
  }

  private async run(job: InternalJob): Promise<void> {
    this.running++;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.summary = '正在跑宿主全量测试…';
    job.controller = new AbortController();
    const started = Date.now();
    this.opts.prepareEvent?.(job.runId);
    this.opts.emit?.(job.runId, 'verification_started', {
      level: 'L2',
      phase: 'host-manual',
      jobId: job.jobId,
      repoPath: job.repoPath,
    });

    let ok = false;
    let note = '';
    let exitCode: number | null = null;
    let timedOut = false;
    let aborted = false;
    let mode: VerificationMode | undefined;
    let coverage: 'full' | 'typecheck' | 'none' | undefined;
    try {
      const r = await runHostFullSuite({
        repoPath: job.repoPath,
        nodePath: this.opts.nodePath,
        signal: job.controller.signal,
        timeoutMs: this.opts.timeoutMs ?? 600_000,
        nodeArgs: this.opts.nodeArgs,
        label: '深度验证',
      });
      ok = r.ok;
      note = r.note;
      exitCode = r.exitCode;
      timedOut = r.timedOut;
      aborted = r.aborted;
      mode = r.mode;
      coverage = r.coverage;
      job.durationMs = r.durationMs;
    } catch (e) {
      note = `深度验证异常：${(e as Error).message}`;
    } finally {
      const wasAborted = job.controller.signal.aborted || aborted;
      job.finishedAt = new Date().toISOString();
      job.durationMs = job.durationMs ?? Date.now() - started;
      job.exitCode = exitCode;
      job.timedOut = timedOut;
      job.mode = mode;
      job.coverage = coverage;
      if (wasAborted) {
        job.status = 'cancelled';
        job.summary = '已取消';
      } else if (ok) {
        job.status = 'passed';
        job.summary = `${mode === 'typecheck' ? '类型检查通过（未跑行为测试）' : '深度验证通过'}（${Math.round(job.durationMs / 100) / 10}s）`;
      } else if (mode === 'unavailable') {
        job.status = 'failed';
        job.summary = '无法自动验证：仓库没有可运行的测试或类型检查';
        job.excerpt = note.slice(0, 2000);
      } else {
        job.status = 'failed';
        job.summary = '深度验证失败';
        job.excerpt = note.slice(0, 2000);
      }
      this.opts.emit?.(job.runId, 'verification_completed', {
        level: 'L2',
        phase: 'host-manual',
        jobId: job.jobId,
        ok,
        cancelled: wasAborted,
        durationMs: job.durationMs,
        exitCode: job.exitCode,
        timedOut: job.timedOut,
        mode: job.mode,
        coverage: job.coverage,
        summary: job.summary,
        excerpt: job.excerpt,
      });
      this.running = Math.max(0, this.running - 1);
      this.pump();
    }
  }

  private finishCancelled(job: InternalJob, summary: string): void {
    job.status = 'cancelled';
    job.finishedAt = new Date().toISOString();
    job.durationMs = 0;
    job.summary = summary;
    this.opts.prepareEvent?.(job.runId);
    this.opts.emit?.(job.runId, 'verification_completed', {
      level: 'L2',
      phase: 'host-manual',
      jobId: job.jobId,
      ok: false,
      cancelled: true,
      durationMs: 0,
      summary,
    });
  }

  private publicJob(j: InternalJob): VerificationJob {
    return {
      jobId: j.jobId,
      runId: j.runId,
      status: j.status,
      queuedAt: j.queuedAt,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      durationMs: j.durationMs,
      exitCode: j.exitCode,
      timedOut: j.timedOut,
      mode: j.mode,
      coverage: j.coverage,
      summary: j.summary,
      excerpt: j.excerpt,
    };
  }
}
