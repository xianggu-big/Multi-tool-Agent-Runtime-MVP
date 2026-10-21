// src/knowledge/context.ts — 上下文管理：多轮对话/操作的上下文保持与检索
//
// 模型：一个 session = 一条会话/一次连续操作流；内含有序 turns（user/assistant/tool/system）。
//   - 多轮保持：getRecent(sessionId, n) 返回滚动窗口，供「下一轮带入历史」；
//   - 跨 session 检索：search(q) 用 FTS5 在全部历史 turn 里召回相关上下文（"还记得我们之前聊过 X 吗"）；
//   - 摘要钩子：summary 字段预留给 LLM 滚动摘要（MVP 不自动生成，预留接口）。
//
// 与其它模块：本类只管读写；变更经 KnowledgeHub 写 audit + 发事件（同一 correlationId）。

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface ContextSession {
  sessionId: string;
  title?: string;
  summary?: string;
  meta: Record<string, unknown>;
  turnCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ContextTurn {
  id: number;
  sessionId: string;
  turnNo: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: unknown;
  searchText: string;
  tokens?: number;
  createdAt: string;
}

export interface OpenSessionInput {
  sessionId?: string;
  title?: string;
  meta?: Record<string, unknown>;
}

export interface AppendTurnInput {
  role: ContextTurn['role'];
  content: unknown;
  tokens?: number;
}

/**
 * 会话摘要器：把「活跃窗口之外」的历史轮次压缩成一段文本，防止记忆丢失。
 * 默认为提取式（确定性、零成本、可注入 LLM 摘要器升级为真归纳）。
 */
export type SessionSummarizer = (turns: ContextTurn[]) => string;

/** 活跃上下文保留的最近轮数：超过它的轮次进入滚动摘要 */
export const SUMMARY_WINDOW = 6;

/**
 * 默认提取式摘要：每轮压成「问/答: 一句话」，按预算截断（先到先得，最多 maxChars）。
 * 不是真语义归纳，但能保留「之前聊过什么、结论是什么」，对 follow-up 足够；
 * 需要真归纳时注入 LLM 摘要器即可（ContextStore 不感知实现）。
 */
export function extractiveSummarize(turns: ContextTurn[], maxChars = 4000): string {
  const parts: string[] = [];
  let budget = maxChars;
  for (const t of turns) {
    const text = flattenContent(t.content).replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text) continue;
    const prefix = t.role === 'user' ? '问' : t.role === 'assistant' ? '答' : t.role;
    const line = `${prefix}: ${text}`;
    if (budget - line.length < 0) break;
    parts.push(line);
    budget -= line.length;
  }
  return parts.join('\n');
}

export class ContextStore {
  private ftsAvailable: boolean | null = null;
  private readonly summarizer: SessionSummarizer;

  constructor(private readonly db: Database.Database, opts: { summarizer?: SessionSummarizer } = {}) {
    this.summarizer = opts.summarizer ?? extractiveSummarize;
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contexts (
        sessionId TEXT PRIMARY KEY,
        title TEXT,
        summary TEXT,
        metaJson TEXT NOT NULL DEFAULT '{}',
        turnCount INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ctx_updated ON contexts(updatedAt);

      CREATE TABLE IF NOT EXISTS context_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId TEXT NOT NULL,
        turnNo INTEGER NOT NULL,
        role TEXT NOT NULL,
        contentJson TEXT,
        searchText TEXT,
        tokens INTEGER,
        createdAt TEXT NOT NULL,
        UNIQUE(sessionId, turnNo)
      );
      CREATE INDEX IF NOT EXISTS idx_ctx_turns_session ON context_turns(sessionId, turnNo);
      CREATE INDEX IF NOT EXISTS idx_ctx_turns_role ON context_turns(role);
    `);
    try {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS context_turns_fts USING fts5(content);`);
      this.ftsAvailable = true;
    } catch {
      this.ftsAvailable = false;
    }
  }

  /** 打开会话（已存在则 upsert 标题/元信息） */
  openSession(input: OpenSessionInput = {}): ContextSession {
    const now = new Date().toISOString();
    const sessionId = input.sessionId?.trim() || `ctx_${randomUUID().slice(0, 8)}`;
    const existing = this.getSession(sessionId);
    if (existing) {
      if (input.title !== undefined || input.meta !== undefined) {
        this.db
          .prepare(`UPDATE contexts SET title=?, metaJson=?, updatedAt=? WHERE sessionId=?`)
          .run(
            input.title ?? existing.title ?? null,
            JSON.stringify({ ...existing.meta, ...(input.meta ?? {}) }),
            now,
            sessionId,
          );
      }
      return this.getSession(sessionId)!;
    }
    this.db
      .prepare(
        `INSERT INTO contexts (sessionId, title, metaJson, turnCount, createdAt, updatedAt)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(sessionId, input.title ?? null, JSON.stringify(input.meta ?? {}), 0, now, now);
    return this.getSession(sessionId)!;
  }

  /** 追加一轮；返回写入后的 turn（含 turnNo） */
  appendTurn(sessionId: string, input: AppendTurnInput): ContextTurn {
    const now = new Date().toISOString();
    const searchText = flattenContent(input.content).slice(0, 20000);
    const role = input.role;
    const sess = this.getSession(sessionId);
    if (!sess) throw new Error(`session 不存在: ${sessionId}（先 openSession）`);

    const tx = this.db.transaction(() => {
      const turnNo = sess.turnCount + 1;
      const info = this.db
        .prepare(
          `INSERT INTO context_turns (sessionId, turnNo, role, contentJson, searchText, tokens, createdAt)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .run(sessionId, turnNo, role, JSON.stringify(input.content), searchText, input.tokens ?? null, now);
      this.db
        .prepare(`UPDATE contexts SET turnCount=?, updatedAt=? WHERE sessionId=?`)
        .run(turnNo, now, sessionId);
      return { id: Number(info.lastInsertRowid), turnNo };
    });
    const { id, turnNo } = tx();
    this.syncFts(id, searchText);
    this.maybeSummarize(sessionId);   // 超出活跃窗口 → 滚动更新摘要，防记忆丢失

    return {
      id,
      sessionId,
      turnNo,
      role,
      content: input.content,
      searchText,
      tokens: input.tokens,
      createdAt: now,
    };
  }

  private syncFts(turnId: number, searchText: string): void {
    if (!this.ftsAvailable) return;
    // FTS5 standalone 表 rowid 与 context_turns.id 对齐
    this.db.prepare(`DELETE FROM context_turns_fts WHERE rowid=?`).run(turnId);
    if (searchText) {
      this.db.prepare(`INSERT INTO context_turns_fts (rowid, content) VALUES (?, ?)`).run(turnId, searchText);
    }
  }

  /**
   * 滚动摘要：把「活跃窗口（最近 SUMMARY_WINDOW 轮）之外」的历史轮次归纳成一段文本，
   * 写入 contexts.summary，并在 meta.summarizedThroughTurn 记录已归纳到的轮号（幂等、可增量）。
   * 这样即使活跃窗口外的对话被移出模型上下文，重要内容也以摘要形式保留。
   */
  maybeSummarize(sessionId: string): void {
    const sess = this.getSession(sessionId);
    if (!sess) return;
    // 活跃窗口起点：第 (turnCount - SUMMARY_WINDOW + 1) 轮及之后留在上下文，之前进入摘要
    const keepFrom = Math.max(1, sess.turnCount - SUMMARY_WINDOW + 1);
    const through = Number(sess.meta.summarizedThroughTurn ?? 0);
    // 需要摘要的轮次 = (through+1 .. keepFrom-1)。没有新轮次被移出窗口则跳过
    if (keepFrom - 1 <= through) return;
    const oldTurns = this.getTurns(sessionId).filter((t) => t.turnNo <= keepFrom - 1);
    if (!oldTurns.length) return;
    const summary = this.summarizer(oldTurns);
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE contexts SET summary=?, metaJson=?, updatedAt=? WHERE sessionId=?`)
      .run(
        summary,
        JSON.stringify({ ...sess.meta, summarizedThroughTurn: keepFrom - 1 }),
        now,
        sessionId,
      );
  }

  getSession(sessionId: string): ContextSession | null {
    const row = this.db.prepare(`SELECT * FROM contexts WHERE sessionId=?`).get(sessionId) as any;
    return row ? this.rowToSession(row) : null;
  }

  /** 取最近 n 轮（滚动窗口，供多轮上下文注入） */
  getRecent(sessionId: string, n = 10): ContextTurn[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM context_turns WHERE sessionId=? ORDER BY turnNo DESC LIMIT ?`,
      )
      .all(sessionId, Math.max(1, Math.min(500, n))) as any[];
    return rows.reverse().map((r) => this.rowToTurn(r));
  }

  /** 取全部 turns */
  getTurns(sessionId: string, limit = 1000): ContextTurn[] {
    const rows = this.db
      .prepare(`SELECT * FROM context_turns WHERE sessionId=? ORDER BY turnNo ASC LIMIT ?`)
      .all(sessionId, Math.max(1, Math.min(5000, limit))) as any[];
    return rows.map((r) => this.rowToTurn(r));
  }

  /** session 概览 + 最近若干轮（一次性给前端用） */
  getWithRecent(sessionId: string, n = 10): { session: ContextSession | null; recent: ContextTurn[] } {
    return { session: this.getSession(sessionId), recent: this.getRecent(sessionId, n) };
  }

  /** 跨 session 全文检索相关历史上下文（按相关度返回） */
  search(query: string, opts: { limit?: number; sessionId?: string } = {}): ContextTurn[] {
    const q = (query ?? '').trim();
    if (!q) return [];
    const limit = Math.max(1, Math.min(500, opts.limit ?? 50));
    if (this.ftsAvailable) {
      try {
        const ftsQ = sanitizeFtsQuery(q);
        const rows = this.db
          .prepare(
            `SELECT t.id, t.sessionId, t.turnNo, t.role, t.contentJson, t.searchText, t.tokens, t.createdAt
             FROM context_turns_fts f JOIN context_turns t ON t.id = f.rowid
             ${opts.sessionId ? 'WHERE t.sessionId=?' : ''}
             ORDER BY rank LIMIT ?`,
          )
          .all(...(opts.sessionId ? [opts.sessionId] : []), ftsQ, limit) as any[];
        return rows.map((r) => this.rowToTurn(r));
      } catch {
        /* 降级 */
      }
    }
    // 降级 LIKE
    const rows = this.db
      .prepare(
        `SELECT * FROM context_turns ${opts.sessionId ? 'WHERE sessionId=? AND ' : 'WHERE '}searchText LIKE ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(...(opts.sessionId ? [opts.sessionId] : []), `%${q.toLowerCase()}%`, limit) as any[];
    return rows.map((r) => this.rowToTurn(r));
  }

  /** 列出最近会话 */
  listSessions(limit = 50): ContextSession[] {
    const rows = this.db
      .prepare(`SELECT * FROM contexts ORDER BY updatedAt DESC LIMIT ?`)
      .all(Math.max(1, Math.min(500, limit))) as any[];
    return rows.map((r) => this.rowToSession(r));
  }

  /** 删除会话（连带 turns） */
  deleteSession(sessionId: string): boolean {
    const existing = this.getSession(sessionId);
    if (!existing) return false;
    const tx = this.db.transaction(() => {
      const turns = this.db
        .prepare(`SELECT id FROM context_turns WHERE sessionId=?`)
        .all(sessionId) as any[];
      if (this.ftsAvailable) {
        for (const t of turns) {
          this.db.prepare(`DELETE FROM context_turns_fts WHERE rowid=?`).run(t.id);
        }
      }
      this.db.prepare(`DELETE FROM context_turns WHERE sessionId=?`).run(sessionId);
      this.db.prepare(`DELETE FROM contexts WHERE sessionId=?`).run(sessionId);
    });
    tx();
    return true;
  }

  stats(): { sessions: number; turns: number; fts: boolean } {
    const sessions = (this.db.prepare(`SELECT COUNT(*) AS c FROM contexts`).get() as any).c as number;
    const turns = (this.db.prepare(`SELECT COUNT(*) AS c FROM context_turns`).get() as any).c as number;
    return { sessions, turns, fts: !!this.ftsAvailable };
  }

  private rowToSession(row: any): ContextSession {
    return {
      sessionId: row.sessionId,
      title: row.title ?? undefined,
      summary: row.summary ?? undefined,
      meta: row.metaJson ? JSON.parse(row.metaJson) : {},
      turnCount: row.turnCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private rowToTurn(row: any): ContextTurn {
    return {
      id: row.id,
      sessionId: row.sessionId,
      turnNo: row.turnNo,
      role: row.role,
      content: row.contentJson ? JSON.parse(row.contentJson) : null,
      searchText: row.searchText ?? '',
      tokens: row.tokens ?? undefined,
      createdAt: row.createdAt,
    };
  }
}

/** 拍平内容为可检索文本 */
function flattenContent(content: unknown): string {
  const parts: string[] = [];
  const walk = (v: unknown) => {
    if (v == null) return;
    if (typeof v === 'string') parts.push(v);
    else if (typeof v === 'number' || typeof v === 'boolean') parts.push(String(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'object') {
      for (const [, val] of Object.entries(v as Record<string, unknown>)) walk(val);
    }
  };
  walk(content);
  return parts.join(' ').toLowerCase();
}

function sanitizeFtsQuery(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .split(/[\s,]+/)
    .map((t) => t.replace(/["'^*]/g, ''))
    .filter(Boolean);
  if (!tokens.length) return '""';
  return tokens.map((t) => `"${t}"*`).join(' ');
}
