// src/knowledge/history.ts — 历史与变更追踪
//
// 三层历史，互为补充：
//   1) 操作日志 = 现有 events 表（TraceEvent，已含 runId/seq/timestamp）—— 本类不重复存储，仅暴露查询入口；
//   2) 会话记录 = 现有 runs 表（RunRecord）—— 同上；
//   3) 变更追踪 = 本模块新表 audit_log：actor/action/resource/before/after/correlationId/meta。
//
// correlationId 是可追溯性的「主键」：一次逻辑操作（如写一条数据 + 记一条审计 + 发一条事件）
// 共用同一个 correlationId，分布在三处。用 GET /api/history?correlationId=… 即可把它串起来。
//
// timeline()：把 runs 与 audit_log 按时间合并成一条统一时间线（events 数据量大，按 run 精确查，
//   不并入全局时间线，避免噪声；如需可在 include=events 时按 runId 局部并入）。

import type Database from 'better-sqlite3';
import type { RunRecord, TraceEvent } from '../types.js';

export interface AuditEntry {
  id: number;
  at: string;
  correlationId: string;
  actor?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown>;
}

export interface RecordAuditInput {
  correlationId: string;
  actor?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown>;
  /** 显式时间（默认 now）；测试与回收等需要稳定时间戳时使用 */
  at?: string;
}

export interface AuditQuery {
  from?: string;
  to?: string;
  actor?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  correlationId?: string;
  limit?: number;
  offset?: number;
}

export interface TimelineEntry {
  at: string;
  source: 'run' | 'audit' | 'event';
  kind: string;
  detail: Record<string, unknown>;
}

export interface TimelineQuery {
  runId?: string;
  actor?: string;
  from?: string;
  to?: string;
  /** 是否把事件流也并入时间线（默认 false：只并 runs + audit；事件量大，按需开启，且会 cap） */
  includeEvents?: boolean;
  limit?: number;
}

export class HistoryStore {
  constructor(private readonly db: Database.Database) {
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        correlationId TEXT NOT NULL,
        actor TEXT,
        action TEXT NOT NULL,
        resourceType TEXT NOT NULL,
        resourceId TEXT,
        beforeJson TEXT,
        afterJson TEXT,
        metaJson TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
      CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor);
      CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_log(resourceType, resourceId);
      CREATE INDEX IF NOT EXISTS idx_audit_corr ON audit_log(correlationId);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
    `);
  }

  /** 记一条变更；返回写入后的条目（含自增 id） */
  record(input: RecordAuditInput): AuditEntry {
    const at = input.at ?? new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO audit_log (at, correlationId, actor, action, resourceType, resourceId, beforeJson, afterJson, metaJson)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        at,
        input.correlationId,
        input.actor ?? null,
        input.action,
        input.resourceType,
        input.resourceId ?? null,
        input.before != null ? JSON.stringify(redact(input.before)) : null,
        input.after != null ? JSON.stringify(redact(input.after)) : null,
        input.meta != null ? JSON.stringify(redact(input.meta)) : null,
      );
    const id = Number(info.lastInsertRowid);
    return {
      id,
      at,
      correlationId: input.correlationId,
      actor: input.actor,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      before: input.before,
      after: input.after,
      meta: input.meta,
    };
  }

  query(q: AuditQuery = {}): AuditEntry[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.from) {
      where.push('at >= ?');
      params.push(q.from);
    }
    if (q.to) {
      where.push('at <= ?');
      params.push(q.to);
    }
    if (q.actor) {
      where.push('actor=?');
      params.push(q.actor);
    }
    if (q.action) {
      where.push('action=?');
      params.push(q.action);
    }
    if (q.resourceType) {
      where.push('resourceType=?');
      params.push(q.resourceType);
    }
    if (q.resourceId) {
      where.push('resourceId=?');
      params.push(q.resourceId);
    }
    if (q.correlationId) {
      where.push('correlationId=?');
      params.push(q.correlationId);
    }
    const sql = `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`;
    params.push(Math.max(1, Math.min(1000, q.limit ?? 100)));
    params.push(Math.max(0, q.offset ?? 0));
    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => this.rowToEntry(r));
  }

  /** 按 correlationId 取一条（可追溯性的核心入口） */
  byCorrelation(correlationId: string): AuditEntry[] {
    return this.query({ correlationId, limit: 200 });
  }

  /**
   * 统一时间线：把 runs（会话记录）与 audit_log（变更追踪）按时间合并。
   * includeEvents=true 时把事件流（操作日志）也并入（按 runId 过滤时尤其有用）。
   */
  timeline(
    q: TimelineQuery,
    getRuns: (q: { actor?: string; from?: string; to?: string; limit?: number }) => RunRecord[],
    getEvents: (runId: string) => TraceEvent[],
  ): TimelineEntry[] {
    const limit = Math.max(1, Math.min(2000, q.limit ?? 200));
    const out: TimelineEntry[] = [];

    // 会话记录
    const runs = getRuns({ actor: q.actor, from: q.from, to: q.to, limit: limit * 2 });
    for (const r of runs) {
      out.push({
        at: r.createdAt,
        source: 'run',
        kind: r.status,
        detail: {
          runId: r.runId,
          runType: r.runType,
          status: r.status,
          goal: r.goal,
          isMock: r.isMock,
          errorCode: r.errorCode,
        },
      });
    }

    // 变更追踪
    const audits = this.query({ actor: q.actor, from: q.from, to: q.to, limit: limit * 2 });
    for (const a of audits) {
      out.push({
        at: a.at,
        source: 'audit',
        kind: a.action,
        detail: {
          auditId: a.id,
          correlationId: a.correlationId,
          resourceType: a.resourceType,
          resourceId: a.resourceId,
          actor: a.actor,
          action: a.action,
          meta: a.meta,
        },
      });
    }

    // 操作日志（按需并入；量级大，仅在显式开启且最好带 runId 时使用）
    if (q.includeEvents && q.runId) {
      const events = getEvents(q.runId);
      for (const e of events) {
        // 只并入「值得进时间线」的事件类型，避免 llm_delta 等噪声
        const notable = ['run_started', 'run_completed', 'run_failed', 'run_cancelled', 'run_awaiting_user', 'runtime_error', 'data_changed', 'data_deleted', 'context_turn_appended'];
        if (!notable.includes(e.type)) continue;
        out.push({
          at: e.timestamp,
          source: 'event',
          kind: e.type,
          detail: { runId: e.runId, seq: e.seq, ...(e.data ?? {}) },
        });
      }
    }

    // 按时间倒序合并
    out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return out.slice(0, limit);
  }

  stats(): { total: number; byAction: Record<string, number>; byResourceType: Record<string, number> } {
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM audit_log`).get() as any).c as number;
    const byActionRows = this.db
      .prepare(`SELECT action, COUNT(*) AS c FROM audit_log GROUP BY action`)
      .all() as any[];
    const byResourceRows = this.db
      .prepare(`SELECT resourceType, COUNT(*) AS c FROM audit_log GROUP BY resourceType`)
      .all() as any[];
    const byAction: Record<string, number> = {};
    for (const r of byActionRows) byAction[r.action] = r.c;
    const byResourceType: Record<string, number> = {};
    for (const r of byResourceRows) byResourceType[r.resourceType] = r.c;
    return { total, byAction, byResourceType };
  }

  private rowToEntry(row: any): AuditEntry {
    return {
      id: row.id,
      at: row.at,
      correlationId: row.correlationId,
      actor: row.actor ?? undefined,
      action: row.action,
      resourceType: row.resourceType,
      resourceId: row.resourceId ?? undefined,
      before: row.beforeJson ? JSON.parse(row.beforeJson) : undefined,
      after: row.afterJson ? JSON.parse(row.afterJson) : undefined,
      meta: row.metaJson ? JSON.parse(row.metaJson) : undefined,
    };
  }
}

const SECRET_KEY_RE = /(apikey|api_key|key|token|secret|password|authorization)/i;

/** 轻量脱敏：审计落盘前把密钥字段遮掉（与 ErrorReporter 同口径，但此处只遮对象 key 名） */
function redact(v: unknown, depth = 0): unknown {
  if (depth > 8) return '…';
  if (typeof v === 'string') return v.slice(0, 8000);
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => redact(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? '***REDACTED***' : redact(val, depth + 1);
    }
    return out;
  }
  return v;
}
