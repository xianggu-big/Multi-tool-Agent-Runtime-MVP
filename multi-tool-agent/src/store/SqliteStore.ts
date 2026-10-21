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
  }

  createRun(rec: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (runId, runType, status, goal, createdAt, updatedAt, steps, modelCalls, toolCalls, totalDurationMs, usageJson, isMock)
         VALUES (@runId, @runType, @status, @goal, @createdAt, @updatedAt, @steps, @modelCalls, @toolCalls, @totalDurationMs, @usageJson, @isMock)`,
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
    };
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
      };
    })(),
  };
}
