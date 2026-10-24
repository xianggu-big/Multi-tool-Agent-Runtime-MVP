// src/store/SqliteStore.ts — SQLite 持久化（任务、事件、检查点）
// 使用 better-sqlite3（同步 API），无外部服务依赖。

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { unpackResultJson } from './resultJson.js';
import type {
  Checkpoint,
  ChatMessage,
  RunRecord,
  RunResult,
  RunStatus,
  TraceEvent,
} from '../types.js';
import type { RunDigest } from '../runtime/runDigest.js';
import type {
  PendingActionRecord,
  PendingActionStatus,
  ScheduleRecord,
} from '../scheduler/types.js';

export class SqliteStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.init();
    this.migrate();
  }

  /** 暴露底层连接，供知识系统等共享同一 DB（单连接 → 跨表事务天然一致） */
  get database(): Database.Database {
    return this.db;
  }

  /** 健康探针：只做一次最小查询，不触碰业务数据。 */
  ping(): { ok: boolean; error?: string } {
    try {
      this.db.prepare('SELECT 1').get();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /**
   * 删除早于 cutoff 的终态 run 及其事件/检查点/复盘摘要（数据保留策略）。
   *
   * 保守规则（宁可不删）：
   *   - 只删 completed / failed / cancelled / limit_reached；
   *   - `awaiting_user` 与活动状态一律保留；
   *   - 仍有 pending 待确认操作的 run 保留（用户还要做决定）；
   *   - 被定时任务 lastRunId 引用的 run 保留（否则「上次运行」会凭空消失）。
   */
  pruneRunsOlderThan(
    cutoffIso: string,
    opts: { dryRun?: boolean; limit?: number } = {},
  ): { runs: number; events: number; checkpoints: number; digests: number; pendingActions: number } {
    const limit = Math.max(1, Math.min(50_000, Math.floor(opts.limit ?? 5000)));
    const rows = this.db
      .prepare(
        `SELECT r.runId AS runId FROM runs r
         WHERE r.createdAt < @cutoff
           AND r.status IN ('completed','failed','cancelled','limit_reached')
           AND NOT EXISTS (SELECT 1 FROM pending_actions p WHERE p.runId = r.runId AND p.status = 'pending')
           AND NOT EXISTS (SELECT 1 FROM schedules s WHERE s.lastRunId = r.runId)
         ORDER BY r.createdAt ASC
         LIMIT @limit`,
      )
      .all({ cutoff: cutoffIso, limit }) as Array<{ runId: string }>;
    const ids = rows.map((r) => r.runId);
    const totals = { runs: ids.length, events: 0, checkpoints: 0, digests: 0, pendingActions: 0 };
    if (!ids.length) return totals;

    const countStmt = (sql: string) => this.db.prepare(sql);
    const countEvents = countStmt('SELECT COUNT(*) AS n FROM events WHERE runId = ?');
    const countCheckpoints = countStmt('SELECT COUNT(*) AS n FROM checkpoints WHERE runId = ?');
    const countDigests = countStmt('SELECT COUNT(*) AS n FROM run_digests WHERE runId = ?');
    const countPending = countStmt('SELECT COUNT(*) AS n FROM pending_actions WHERE runId = ?');
    for (const id of ids) {
      totals.events += Number((countEvents.get(id) as any)?.n ?? 0);
      totals.checkpoints += Number((countCheckpoints.get(id) as any)?.n ?? 0);
      totals.digests += Number((countDigests.get(id) as any)?.n ?? 0);
      totals.pendingActions += Number((countPending.get(id) as any)?.n ?? 0);
    }
    if (opts.dryRun) return totals;

    const delRun = this.db.transaction((runIds: string[]) => {
      const delEvents = this.db.prepare('DELETE FROM events WHERE runId = ?');
      const delCheckpoints = this.db.prepare('DELETE FROM checkpoints WHERE runId = ?');
      const delDigests = this.db.prepare('DELETE FROM run_digests WHERE runId = ?');
      const delPending = this.db.prepare('DELETE FROM pending_actions WHERE runId = ?');
      const delRuns = this.db.prepare('DELETE FROM runs WHERE runId = ?');
      for (const id of runIds) {
        delEvents.run(id);
        delCheckpoints.run(id);
        delDigests.run(id);
        delPending.run(id);
        delRuns.run(id);
      }
    });
    delRun(ids);
    return totals;
  }

  /** 关闭数据库连接（测试与服务优雅退出时使用） */
  close(): void {
    try {
      this.db.close();
    } catch {
      /* 已关闭则忽略 */
    }
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        runId TEXT PRIMARY KEY,
        runType TEXT NOT NULL,
        status TEXT NOT NULL,
        goal TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        finalAnswer TEXT,
        failureReason TEXT,
        errorCode TEXT,
        steps INTEGER NOT NULL DEFAULT 0,
        modelCalls INTEGER NOT NULL DEFAULT 0,
        toolCalls INTEGER NOT NULL DEFAULT 0,
        totalDurationMs INTEGER NOT NULL DEFAULT 0,
        usageJson TEXT NOT NULL DEFAULT '{}',
        triggeredLimit TEXT,
        isMock INTEGER NOT NULL DEFAULT 0,
        resultJson TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        runId TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        dataJson TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_run ON events(runId, seq);
      CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(createdAt);
      CREATE TABLE IF NOT EXISTS checkpoints (
        runId TEXT PRIMARY KEY,
        step INTEGER NOT NULL,
        status TEXT NOT NULL,
        messagesJson TEXT NOT NULL,
        modelCalls INTEGER NOT NULL,
        toolCalls INTEGER NOT NULL,
        usageJson TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        pausedMs INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS run_digests (
        runId TEXT PRIMARY KEY,
        runType TEXT NOT NULL,
        status TEXT NOT NULL,
        isMock INTEGER NOT NULL DEFAULT 0,
        ok INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        finishedAt TEXT NOT NULL,
        issueCount INTEGER NOT NULL DEFAULT 0,
        failureCode TEXT,
        headline TEXT NOT NULL,
        digestJson TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_digests_finished ON run_digests(finishedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_digests_status ON run_digests(status);
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        agent TEXT NOT NULL,
        goal TEXT NOT NULL,
        repoPath TEXT,
        frequency TEXT NOT NULL,
        runAt TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        allowWrite INTEGER NOT NULL DEFAULT 0,
        autoApprove INTEGER NOT NULL DEFAULT 0,
        safetyPrompt TEXT,
        dangerPatternsJson TEXT NOT NULL DEFAULT '[]',
        allowRunTests INTEGER NOT NULL DEFAULT 0,
        skipIfRunning INTEGER NOT NULL DEFAULT 1,
        optionsJson TEXT NOT NULL DEFAULT '{}',
        nextRunAt TEXT,
        lastRunAt TEXT,
        lastRunId TEXT,
        lastStatus TEXT,
        lastError TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_schedules_next ON schedules(enabled, nextRunAt);
      CREATE TABLE IF NOT EXISTS pending_actions (
        id TEXT PRIMARY KEY,
        runId TEXT NOT NULL,
        scheduleId TEXT,
        kind TEXT NOT NULL,
        payloadJson TEXT NOT NULL,
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        decidedAt TEXT,
        resultJson TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_actions(status, createdAt);
      CREATE INDEX IF NOT EXISTS idx_pending_run ON pending_actions(runId);
    `);
  }

  /** 轻量迁移：老库缺列时补齐（SQLite 的 ADD COLUMN 是 O(1)，不需要重建表） */
  private migrate(): void {
    const cols = (this.db.prepare(`PRAGMA table_info(runs)`).all() as any[]).map((c) => c.name);
    if (!cols.includes('resultJson')) {
      this.db.exec(`ALTER TABLE runs ADD COLUMN resultJson TEXT`);
    }
    // M1（评审 P2-a）：旧库补齐 checkpoints.pausedMs（新库建表已含）
    const cpCols = (this.db.prepare(`PRAGMA table_info(checkpoints)`).all() as any[]).map((c) => c.name);
    if (!cpCols.includes('pausedMs')) {
      this.db.exec(`ALTER TABLE checkpoints ADD COLUMN pausedMs INTEGER NOT NULL DEFAULT 0`);
    }
    // 定时任务：run 与 schedule 的关联列（历史库补齐）
    if (!cols.includes('scheduleId')) {
      this.db.exec(`ALTER TABLE runs ADD COLUMN scheduleId TEXT`);
    }
  }

  createRun(rec: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (runId, runType, status, goal, createdAt, updatedAt, steps, modelCalls, toolCalls, totalDurationMs, usageJson, isMock, scheduleId)
         VALUES (@runId, @runType, @status, @goal, @createdAt, @updatedAt, @steps, @modelCalls, @toolCalls, @totalDurationMs, @usageJson, @isMock, @scheduleId)`,
      )
      .run({
        runId: rec.runId,
        runType: rec.runType,
        status: rec.status,
        goal: rec.goal,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        steps: rec.steps,
        modelCalls: rec.modelCalls,
        toolCalls: rec.toolCalls,
        totalDurationMs: rec.totalDurationMs,
        usageJson: rec.usageJson,
        isMock: rec.isMock,
        scheduleId: rec.scheduleId ?? null,
      });
  }

  getRun(runId: string): RunRecord | null {
    const row = this.db.prepare(`SELECT * FROM runs WHERE runId = ?`).get(runId) as any;
    if (!row) return null;
    return this.rowToRecord(row);
  }

  updateRun(patch: Partial<RunRecord> & { runId: string }): void {
    const fields = Object.keys(patch).filter((k) => k !== 'runId' && k !== 'usageJson' ? true : k === 'usageJson');
    // 明确允许的字段，避免任意列更新
    const allowed = [
      'status',
      'finalAnswer',
      'failureReason',
      'errorCode',
      'steps',
      'modelCalls',
      'toolCalls',
      'totalDurationMs',
      'usageJson',
      'triggeredLimit',
      'resultJson',
      'updatedAt',
    ];
    const sets: string[] = [];
    const params: Record<string, unknown> = { runId: patch.runId };
    for (const f of allowed) {
      if (f in patch) {
        sets.push(`${f} = @${f}`);
        params[f] = (patch as any)[f];
      }
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE runId = @runId`).run(params);
  }

  appendEvent(e: TraceEvent): void {
    this.db
      .prepare(
        `INSERT INTO events (runId, seq, type, timestamp, dataJson) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(e.runId, e.seq, e.type, e.timestamp, e.data ? JSON.stringify(e.data) : null);
  }

  /** 批量写入事件（单事务，供异步缓冲 flush 使用，减少主循环阻塞与 fsync 次数） */
  appendEvents(events: TraceEvent[]): void {
    if (!events.length) return;
    const stmt = this.db.prepare(
      `INSERT INTO events (runId, seq, type, timestamp, dataJson) VALUES (?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((items: TraceEvent[]) => {
      for (const e of items) {
        stmt.run(e.runId, e.seq, e.type, e.timestamp, e.data ? JSON.stringify(e.data) : null);
      }
    });
    tx(events);
  }

  getEvents(runId: string): TraceEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE runId = ? ORDER BY seq ASC`)
      .all(runId) as any[];
    return rows.map((r) => ({
      runId: r.runId,
      seq: r.seq,
      type: r.type,
      timestamp: r.timestamp,
      data: r.dataJson ? JSON.parse(r.dataJson) : undefined,
    }));
  }

  saveCheckpoint(cp: Checkpoint): void {
    this.db
      .prepare(
        `INSERT INTO checkpoints (runId, step, status, messagesJson, modelCalls, toolCalls, usageJson, createdAt, pausedMs)
         VALUES (@runId, @step, @status, @messagesJson, @modelCalls, @toolCalls, @usageJson, @createdAt, @pausedMs)
         ON CONFLICT(runId) DO UPDATE SET
           step=excluded.step, status=excluded.status, messagesJson=excluded.messagesJson,
           modelCalls=excluded.modelCalls, toolCalls=excluded.toolCalls, usageJson=excluded.usageJson, createdAt=excluded.createdAt,
           pausedMs=excluded.pausedMs`,
      )
      .run({
        runId: cp.runId,
        step: cp.step,
        status: cp.status,
        messagesJson: JSON.stringify(cp.messages),
        modelCalls: cp.modelCalls,
        toolCalls: cp.toolCalls,
        usageJson: JSON.stringify(cp.usage),
        createdAt: cp.createdAt,
        pausedMs: cp.pausedMs ?? 0,
      });
  }

  getLatestCheckpoint(runId: string): Checkpoint | null {
    const row = this.db.prepare(`SELECT * FROM checkpoints WHERE runId = ?`).get(runId) as any;
    if (!row) return null;
    return {
      runId: row.runId,
      step: row.step,
      status: row.status,
      messages: JSON.parse(row.messagesJson) as ChatMessage[],
      modelCalls: row.modelCalls,
      toolCalls: row.toolCalls,
      pausedMs: row.pausedMs ?? 0,
      usage: JSON.parse(row.usageJson),
      createdAt: row.createdAt,
    };
  }

  /**
   * 列出「孤儿运行」：状态停在非终态（running/queued/waiting_tool）的历史运行。
   * 只应在服务启动阶段调用——本进程刚启动时，DB 里仍在 running 的行都不可能是本进程产生的，
   * 必然来自上次进程被杀/重启（内存状态已丢失，永远不会再被推进），会永久污染列表/统计。
   */
  listOrphanRuns(): Array<{ runId: string; runType: string; goal: string; updatedAt: string; maxSeq: number }> {
    const rows = this.db
      .prepare(`SELECT runId, runType, goal, updatedAt FROM runs WHERE status NOT IN ('completed','failed','cancelled','limit_reached','awaiting_user')`)
      .all() as any[];
    return rows.map((r) => {
      const maxSeq = (
        this.db.prepare(`SELECT COALESCE(MAX(seq),0) AS m FROM events WHERE runId = ?`).get(r.runId) as any
      ).m as number;
      return { runId: r.runId, runType: r.runType, goal: r.goal, updatedAt: r.updatedAt, maxSeq };
    });
  }

  /**
   * 孤儿运行收尾（单事务）：
   *   ① 补一条 `runtime_error` 事件——序号取该 run 事件最大值 + 1，保持回放序号严格连续。
   *      **必须直接写库**：新进程的内存序号计数器从 1 开始，若走 EventLogger.emit 会与历史事件撞号。
   *   ② 把 run 标记为 failed（errorCode/failureReason 说明是「被中断」而非「执行失败」）。
   * 返回写入的事件序号（供调用方记录到 audit）。
   */
  finalizeInterruptedRun(
    runId: string,
    patch: {
      at: string;
      errorCode: string;
      failureReason: string;
      eventData: Record<string, unknown>;
    },
  ): number {
    const tx = this.db.transaction(() => {
      const maxSeq = (
        this.db.prepare(`SELECT COALESCE(MAX(seq),0) AS m FROM events WHERE runId = ?`).get(runId) as any
      ).m as number;
      const nextSeq = maxSeq + 1;
      this.db
        .prepare(`INSERT INTO events (runId, seq, type, timestamp, dataJson) VALUES (?,?,?,?,?)`)
        .run(runId, nextSeq, 'runtime_error', patch.at, JSON.stringify(patch.eventData));
      this.db
        .prepare(`UPDATE runs SET status='failed', errorCode=?, failureReason=?, updatedAt=? WHERE runId=?`)
        .run(patch.errorCode, patch.failureReason, patch.at, runId);
      return nextSeq;
    });
    return tx();
  }

  // ---------------------------------------------------------------------------
  // 复盘摘要（run_digests）：每次 run 终态都写一行（成功也写），失败优先可查
  // ---------------------------------------------------------------------------

  /** 写入/覆盖一个 run 的复盘摘要（终态时会调用；重跑覆盖同 runId） */
  saveRunDigest(digest: RunDigest): void {
    this.db
      .prepare(
        `INSERT INTO run_digests
           (runId, runType, status, isMock, ok, createdAt, finishedAt, issueCount, failureCode, headline, digestJson)
         VALUES (@runId, @runType, @status, @isMock, @ok, @createdAt, @finishedAt, @issueCount, @failureCode, @headline, @digestJson)
         ON CONFLICT(runId) DO UPDATE SET
           status=@status, isMock=@isMock, ok=@ok, finishedAt=@finishedAt,
           issueCount=@issueCount, failureCode=@failureCode, headline=@headline, digestJson=@digestJson`,
      )
      .run({
        runId: digest.runId,
        runType: digest.runType,
        status: digest.status,
        isMock: digest.isMock ? 1 : 0,
        ok: digest.ok ? 1 : 0,
        createdAt: digest.createdAt,
        finishedAt: digest.finishedAt,
        issueCount: digest.issues.length,
        failureCode: digest.errorCode ?? null,
        headline: digest.headline,
        digestJson: JSON.stringify(digest),
      });
  }

  /** 取单个 run 的完整复盘摘要 */
  getRunDigest(runId: string): RunDigest | null {
    const row = this.db.prepare(`SELECT digestJson FROM run_digests WHERE runId = ?`).get(runId) as any;
    if (!row) return null;
    try {
      return JSON.parse(row.digestJson) as RunDigest;
    } catch {
      return null;
    }
  }

  /**
   * 列表（默认按结束时间倒序）。
   * `onlyProblems=true` → 只看「失败 / 触顶 / 取消 / 等待用户 / 或过程有错误」的 run（复盘优先）。
   */
  listRunDigests(opts: { status?: string; runType?: string; onlyProblems?: boolean; limit?: number } = {}): Array<{
    runId: string;
    runType: string;
    status: string;
    isMock: number;
    ok: number;
    createdAt: string;
    finishedAt: string;
    issueCount: number;
    failureCode: string | null;
    headline: string;
  }> {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (opts.status) {
      where.push('status = @status');
      params.status = opts.status;
    }
    if (opts.runType) {
      where.push('runType = @runType');
      params.runType = opts.runType;
    }
    if (opts.onlyProblems) {
      where.push(`(status <> 'completed' OR issueCount > 0)`);
    }
    const sql = `SELECT runId, runType, status, isMock, ok, createdAt, finishedAt, issueCount, failureCode, headline
                 FROM run_digests ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY finishedAt DESC LIMIT @limit`;
    params.limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    return this.db.prepare(sql).all(params) as any[];
  }

  listRuns(limit = 50): RunRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM runs ORDER BY createdAt DESC LIMIT ?`)
      .all(limit) as any[];
    return rows.map((r) => this.rowToRecord(r));
  }

  // ---------------------------------------------------------------- 定时任务
  saveSchedule(rec: ScheduleRecord): void {
    this.db
      .prepare(
        `INSERT INTO schedules (
           id, name, agent, goal, repoPath, frequency, runAt, enabled, allowWrite, autoApprove,
           safetyPrompt, dangerPatternsJson, allowRunTests, skipIfRunning, optionsJson,
           nextRunAt, lastRunAt, lastRunId, lastStatus, lastError, createdAt, updatedAt
         ) VALUES (
           @id, @name, @agent, @goal, @repoPath, @frequency, @runAt, @enabled, @allowWrite, @autoApprove,
           @safetyPrompt, @dangerPatternsJson, @allowRunTests, @skipIfRunning, @optionsJson,
           @nextRunAt, @lastRunAt, @lastRunId, @lastStatus, @lastError, @createdAt, @updatedAt
         )
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, agent=excluded.agent, goal=excluded.goal, repoPath=excluded.repoPath,
           frequency=excluded.frequency, runAt=excluded.runAt, enabled=excluded.enabled,
           allowWrite=excluded.allowWrite, autoApprove=excluded.autoApprove,
           safetyPrompt=excluded.safetyPrompt, dangerPatternsJson=excluded.dangerPatternsJson,
           allowRunTests=excluded.allowRunTests, skipIfRunning=excluded.skipIfRunning,
           optionsJson=excluded.optionsJson, nextRunAt=excluded.nextRunAt, lastRunAt=excluded.lastRunAt,
           lastRunId=excluded.lastRunId, lastStatus=excluded.lastStatus, lastError=excluded.lastError,
           updatedAt=excluded.updatedAt`,
      )
      .run({
        id: rec.id,
        name: rec.name,
        agent: rec.agent,
        goal: rec.goal,
        repoPath: rec.repoPath ?? null,
        frequency: rec.frequency,
        runAt: rec.runAt ?? null,
        enabled: rec.enabled ? 1 : 0,
        allowWrite: rec.allowWrite ? 1 : 0,
        autoApprove: rec.autoApprove ? 1 : 0,
        safetyPrompt: rec.safetyPrompt ?? null,
        dangerPatternsJson: JSON.stringify(rec.dangerPatterns ?? []),
        allowRunTests: rec.allowRunTests ? 1 : 0,
        skipIfRunning: rec.skipIfRunning ? 1 : 0,
        optionsJson: JSON.stringify(rec.options ?? {}),
        nextRunAt: rec.nextRunAt ?? null,
        lastRunAt: rec.lastRunAt ?? null,
        lastRunId: rec.lastRunId ?? null,
        lastStatus: rec.lastStatus ?? null,
        lastError: rec.lastError ?? null,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
      });
  }

  getSchedule(id: string): ScheduleRecord | null {
    const row = this.db.prepare(`SELECT * FROM schedules WHERE id = ?`).get(id) as any;
    return row ? this.rowToSchedule(row) : null;
  }

  listSchedules(): ScheduleRecord[] {
    const rows = this.db.prepare(`SELECT * FROM schedules ORDER BY createdAt ASC`).all() as any[];
    return rows.map((r) => this.rowToSchedule(r));
  }

  deleteSchedule(id: string): void {
    this.db.prepare(`DELETE FROM schedules WHERE id = ?`).run(id);
  }

  listRunsBySchedule(scheduleId: string, limit = 20): RunRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM runs WHERE scheduleId = ? ORDER BY createdAt DESC LIMIT ?`)
      .all(scheduleId, limit) as any[];
    return rows.map((r) => this.rowToRecord(r));
  }

  private rowToSchedule(row: any): ScheduleRecord {
    return {
      id: row.id,
      name: row.name,
      agent: row.agent,
      goal: row.goal,
      repoPath: row.repoPath ?? undefined,
      frequency: row.frequency === 'daily' ? 'daily' : 'once',
      runAt: row.runAt ?? undefined,
      enabled: row.enabled === 1,
      allowWrite: row.allowWrite === 1,
      autoApprove: row.autoApprove === 1,
      safetyPrompt: row.safetyPrompt ?? undefined,
      dangerPatterns: safeJsonArray(row.dangerPatternsJson),
      allowRunTests: row.allowRunTests === 1,
      skipIfRunning: row.skipIfRunning === 1,
      options: safeJsonObject(row.optionsJson),
      nextRunAt: row.nextRunAt ?? undefined,
      lastRunAt: row.lastRunAt ?? undefined,
      lastRunId: row.lastRunId ?? undefined,
      lastStatus: row.lastStatus ?? undefined,
      lastError: row.lastError ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // ---------------------------------------------------------------- 待确认高危操作
  createPendingAction(rec: PendingActionRecord): void {
    this.db
      .prepare(
        `INSERT INTO pending_actions (id, runId, scheduleId, kind, payloadJson, status, createdAt, decidedAt, resultJson)
         VALUES (@id, @runId, @scheduleId, @kind, @payloadJson, @status, @createdAt, @decidedAt, @resultJson)`,
      )
      .run({
        id: rec.id,
        runId: rec.runId,
        scheduleId: rec.scheduleId ?? null,
        kind: rec.kind,
        payloadJson: JSON.stringify(rec.payload ?? {}),
        status: rec.status,
        createdAt: rec.createdAt,
        decidedAt: rec.decidedAt ?? null,
        resultJson: rec.result ? JSON.stringify(rec.result) : null,
      });
  }

  getPendingAction(id: string): PendingActionRecord | null {
    const row = this.db.prepare(`SELECT * FROM pending_actions WHERE id = ?`).get(id) as any;
    return row ? this.rowToPendingAction(row) : null;
  }

  listPendingActions(
    opts: { status?: PendingActionStatus; runId?: string; scheduleId?: string; limit?: number } = {},
  ): PendingActionRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.status) {
      where.push('status = ?');
      params.push(opts.status);
    }
    if (opts.runId) {
      where.push('runId = ?');
      params.push(opts.runId);
    }
    if (opts.scheduleId) {
      where.push('scheduleId = ?');
      params.push(opts.scheduleId);
    }
    const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
    const sql = `SELECT * FROM pending_actions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY createdAt DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, limit) as any[];
    return rows.map((r) => this.rowToPendingAction(r));
  }

  updatePendingAction(
    id: string,
    patch: { status: PendingActionStatus; decidedAt?: string; result?: Record<string, unknown> },
  ): void {
    this.db
      .prepare(`UPDATE pending_actions SET status = ?, decidedAt = ?, resultJson = ? WHERE id = ?`)
      .run(patch.status, patch.decidedAt ?? new Date().toISOString(), patch.result ? JSON.stringify(patch.result) : null, id);
  }

  private rowToPendingAction(row: any): PendingActionRecord {
    return {
      id: row.id,
      runId: row.runId,
      scheduleId: row.scheduleId ?? undefined,
      kind: row.kind,
      payload: safeJsonObject(row.payloadJson),
      status: row.status,
      createdAt: row.createdAt,
      decidedAt: row.decidedAt ?? undefined,
      result: row.resultJson ? safeJsonObject(row.resultJson) : undefined,
    };
  }

  private rowToRecord(row: any): RunRecord {
    return {
      runId: row.runId,
      runType: row.runType,
      status: row.status as RunStatus,
      goal: row.goal,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      finalAnswer: row.finalAnswer ?? undefined,
      failureReason: row.failureReason ?? undefined,
      errorCode: row.errorCode ?? undefined,
      steps: row.steps,
      modelCalls: row.modelCalls,
      toolCalls: row.toolCalls,
      totalDurationMs: row.totalDurationMs,
      usageJson: row.usageJson,
      triggeredLimit: row.triggeredLimit ?? undefined,
      isMock: row.isMock,
      resultJson: row.resultJson ?? undefined,
      scheduleId: row.scheduleId ?? undefined,
    };
  }
}

function safeJsonObject(raw: unknown): Record<string, any> {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {};
  } catch {
    return {};
  }
}

function safeJsonArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function recordToResult(rec: RunRecord): RunResult {
  return {
    runId: rec.runId,
    status: rec.status,
    runType: rec.runType,
    goal: rec.goal,
    finalAnswer: rec.finalAnswer,
    failureReason: rec.failureReason,
    errorCode: rec.errorCode,
    steps: rec.steps,
    modelCalls: rec.modelCalls,
    toolCalls: rec.toolCalls,
    totalDurationMs: rec.totalDurationMs,
    usage: JSON.parse(rec.usageJson) as RunResult['usage'],
    triggeredLimit: rec.triggeredLimit,
    isMock: !!rec.isMock,
    ...(() => {
      const payload = unpackResultJson(rec.resultJson);
      return {
        ...(payload.misc ? { misc: payload.misc } : {}),
        ...(payload.orchestration ? { orchestration: payload.orchestration } : {}),
        ...(payload.subtasks ? { subtasks: payload.subtasks } : {}),
        ...(payload.awaitingUser ? { awaitingUser: payload.awaitingUser } : {}),
        ...(payload.codex ? { codex: payload.codex } : {}),
      };
    })(),
  };
}
