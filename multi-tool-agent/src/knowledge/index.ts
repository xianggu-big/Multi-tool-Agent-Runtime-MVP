// src/knowledge/index.ts — 知识系统门面（Context + History + Repository）
//
// 职责：把三个子仓库（数据仓库 / 变更追踪 / 上下文管理）+ Tracer + ErrorReporter 装配成一个门面，
//       保证「一次逻辑操作 = 一条 audit + 一条事件 + 同一 correlationId 贯穿三库」。
//
// 一致性：写数据 + 写审计在**同一个 better-sqlite3 事务**里（嵌套事务=SAVEPOINT），
//         要么都成功要么都回滚；事件在事务**外**发（事件落盘是异步批量的，不应进同步事务）。
//
// 可追溯性：每个操作返回 correlationId；它同时出现在
//           ① audit_log.correlationId  ② 事件 data.correlationId  ③ （数据侧）item.id 经 audit.resourceId 关联。
//           用 GET /api/history?correlationId=… 一键把三者串起来。

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { Repository, type DataItem, type DataQueryFilter, type PutDataInput } from './repository.js';
import {
  HistoryStore,
  type AuditEntry,
  type AuditQuery,
  type TimelineEntry,
  type TimelineQuery,
} from './history.js';
import {
  ContextStore,
  type ContextSession,
  type ContextTurn,
  type OpenSessionInput,
  type AppendTurnInput,
} from './context.js';
import { VectorRecall, type Embedder, type VectorHit } from './vectorRecall.js';
import { RagPipeline, type RagBuildOptions, type RagDoc, type RagSearchOptions } from './ragPipeline.js';
import { createConfiguredEmbedder } from './embeddings.js';
import type { Tracer } from '../trace/Tracer.js';
import type { ErrorReporter } from '../runtime/errorReporter.js';

export interface KnowledgeHubOptions {
  /** 默认操作者（runId/userId）；单次操作可用 opts.actor 覆盖 */
  defaultActor?: string;
  /** 默认事件归属 runId（用于实时流推送；无则发 ephemeral 事件，不落盘） */
  defaultRunId?: string;
}

export interface PutDataOptions {
  actor?: string;
  runId?: string;
  /** 显式 correlationId（默认自动生成）；便于把多次写并到一个操作里追溯 */
  correlationId?: string;
}

export interface PutDataResult {
  item: DataItem;
  isCreate: boolean;
  correlationId: string;
  auditId: number;
}

export class KnowledgeHub {
  readonly repository: Repository;
  readonly history: HistoryStore;
  readonly context: ContextStore;
  /** 语义向量召回层（叠加在 FTS5 关键词检索之上；sqlite-vec 不可用时降级为内存重排） */
  readonly vectorRecall: VectorRecall;
  /** 切块级 RAG 管线（懒构建；写入/删除后失效） */
  private ragCache: { pipeline: RagPipeline; builtAt: string; docs: number } | null = null;

  constructor(
    private readonly db: Database.Database,
    private readonly tracer: Tracer,
    private readonly errors: ErrorReporter,
    private readonly opts: KnowledgeHubOptions = {},
    embedder?: Embedder,
  ) {
    this.repository = new Repository(db);
    this.history = new HistoryStore(db);
    this.context = new ContextStore(db);
    this.vectorRecall = new VectorRecall(db, embedder ? { embedder } : {});
  }

  // ---------------------------------------------------------------- 数据仓库

  putData(input: PutDataInput, opts: PutDataOptions = {}): PutDataResult {
    const correlationId = opts.correlationId ?? `corr_${randomUUID().slice(0, 12)}`;
    const actor = opts.actor ?? input.createdBy ?? this.opts.defaultActor;
    const { item, isCreate, auditId } = this.db.transaction(() => {
      const r = this.repository.put(input);
      const audit = this.history.record({
        correlationId,
        actor,
        action: r.isCreate ? 'data_create' : 'data_update',
        resourceType: 'data_item',
        resourceId: r.item.id,
        before: r.previous,
        after: r.item,
        meta: { collection: r.item.collection, itemId: r.item.itemId, type: r.item.type },
      });
      return { item: r.item, isCreate: r.isCreate, auditId: audit.id };
    })();
    // 语义向量同步（事务外：失败不得影响主流程；向量层自身静默降级）
    // 按 data_items.id(TEXT) 直接对齐——vec0 用辅助列 data_id 关联，无需 rowid
    try {
      this.vectorRecall.upsert(item.id, item.searchText);
    } catch {
      /* 向量层失败不得影响数据写入 */
    }
    this.ragCache = null;
    const action = isCreate ? 'data_create' : 'data_update';
    this.emitDataEvent('data_changed', {
      correlationId,
      action,
      resourceId: item.id,
      collection: item.collection,
      itemId: item.itemId,
      auditId,
    }, opts.runId);
    return { item, isCreate, correlationId, auditId };
  }

  getData(collection: string, itemId: string): DataItem | null {
    return this.repository.get(collection, itemId);
  }

  queryData(filter: DataQueryFilter = {}): DataItem[] {
    return filter.q ? this.repository.search(filter.q, { limit: filter.limit, collection: filter.collection }) : this.repository.list(filter);
  }

  /** 全文检索（高效 FTS5） */
  searchData(query: string, opts: { limit?: number; collection?: string } = {}): DataItem[] {
    return this.repository.search(query, opts);
  }

  deleteData(collection: string, itemId: string, opts: PutDataOptions = {}): { deleted: DataItem | null; correlationId: string; auditId: number } {
    const correlationId = opts.correlationId ?? `corr_${randomUUID().slice(0, 12)}`;
    const actor = opts.actor ?? this.opts.defaultActor;
    const { deleted, auditId } = this.db.transaction(() => {
      const d = this.repository.delete(collection, itemId);
      let auditId = 0;
      if (d) {
        const audit = this.history.record({
          correlationId,
          actor,
          action: 'data_delete',
          resourceType: 'data_item',
          resourceId: d.id,
          before: d,
          meta: { collection, itemId },
        });
        auditId = audit.id;
      }
      return { deleted: d, auditId };
    })();
    // 向量同步删除（按 data_id；事务外，失败不影响主流程）
    if (deleted) {
      try {
        this.vectorRecall.remove(deleted.id);
      } catch {
        /* ignore */
      }
      this.ragCache = null;
      this.emitDataEvent('data_deleted', { correlationId, action: 'data_delete', resourceId: deleted.id, collection, itemId, auditId }, opts.runId);
    }
    return { deleted, correlationId, auditId };
  }

  // ---------------------------------------------------------------- 语义向量召回

  /** 语义检索：按意思而非字面召回（FTS5 的补充） */
  searchSemantic(query: string, opts: { limit?: number; collection?: string } = {}): VectorHit[] {
    return this.vectorRecall.search(query, opts);
  }

  /**
   * 从 data_items 懒构建切块级 RAG 索引（chunk → embedding → BM25 + 向量索引）。
   * 默认 Flat 精确索引；需要 HNSW/IVF 时传 indexKind。
   */
  async rebuildRag(opts: RagBuildOptions = {}): Promise<RagPipeline> {
    // Repository.list 单页上限 500：必须显式分页，否则超过 500 条会静默截断。
    // 超过 5 万条时明确报错，避免一次 rebuild 把内存/embedding 成本打满。
    const MAX_RAG_DOCS = 50_000;
    const docs: RagDoc[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = this.repository.list({ limit: 500, offset });
      docs.push(...page.map((item) => ({
        id: item.id,
        title: `${item.collection}/${item.itemId}`,
        text: item.searchText || '',
        metadata: {
          collection: item.collection,
          itemId: item.itemId,
          type: item.type,
          tags: item.tags,
        },
      })));
      if (page.length < 500) break;
      if (docs.length >= MAX_RAG_DOCS) {
        // 恰好 50,000 条应当允许；只有确实还有下一页时才拒绝。
        const extra = this.repository.list({ limit: 1, offset: docs.length });
        if (extra.length) {
          throw new Error(`RAG 索引文档数超过上限 ${MAX_RAG_DOCS}，请分批构建或改用外部向量库`);
        }
        break;
      }
    }
    // 显式 opt-in：MTA_EMBEDDING_MODEL 存在时走真实 embedding；否则保持离线 hash。
    const embedder = opts.embedder ?? createConfiguredEmbedder();
    const pipeline = await RagPipeline.build(docs, {
      chunk: { chunkSize: 512, overlap: 64 },
      ...opts,
      ...(embedder ? { embedder } : {}),
    });
    this.ragCache = { pipeline, builtAt: new Date().toISOString(), docs: docs.length };
    return pipeline;
  }

  /** 切块级混合检索（默认 hybrid_rerank）。首次调用会构建索引。 */
  async searchRag(query: string, opts: RagSearchOptions = {}) {
    const pipeline = this.ragCache?.pipeline ?? (await this.rebuildRag());
    return pipeline.search(query, opts);
  }

  /** RAG 索引状态；尚未构建时返回 null（不触发构建）。 */
  ragStats() {
    if (!this.ragCache) return null;
    return {
      ...this.ragCache.pipeline.stats(),
      builtAt: this.ragCache.builtAt,
      cachedDocs: this.ragCache.docs,
    };
  }

  /**
   * 混合检索：关键词(FTS5) ∪ 语义(向量)，按得分融合后去重。
   * - 关键词命中：score = 1.0（精确词命中优先）；
   * - 语义命中：score = 向量相似度 ∈ (0,1]；
   * - 同一条同时命中两条路径：取 max（不让低分语义压低精确命中）。
   */
  searchHybrid(query: string, opts: { limit?: number; collection?: string } = {}): (DataItem & { score: number; matchedBy: 'keyword' | 'semantic' | 'both' })[] {
    const limit = Math.max(1, Math.min(200, opts.limit ?? 20));
    const kw = this.repository.search(query, { limit: limit * 2, collection: opts.collection });
    const sem = this.vectorRecall.search(query, { limit: limit * 2, collection: opts.collection });
    const byId = new Map<string, DataItem & { score: number; matchedBy: 'keyword' | 'semantic' | 'both' }>();
    for (const it of kw) {
      byId.set(it.id, { ...it, score: 1.0, matchedBy: 'keyword' });
    }
    for (const h of sem) {
      const existing = byId.get(h.id);
      if (existing) {
        existing.score = Math.max(existing.score, h.score);
        existing.matchedBy = 'both';
      } else {
        const item = this.repository.getById(h.id);
        if (item) byId.set(h.id, { ...item, score: h.score, matchedBy: 'semantic' });
      }
    }
    return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // ---------------------------------------------------------------- 上下文管理

  openSession(input: OpenSessionInput = {}, opts: PutDataOptions = {}): { session: ContextSession; correlationId: string } {
    const session = this.context.openSession(input);
    const correlationId = opts.correlationId ?? `corr_${randomUUID().slice(0, 12)}`;
    const actor = opts.actor ?? this.opts.defaultActor;
    const audit = this.history.record({
      correlationId,
      actor,
      action: 'context_open',
      resourceType: 'context_session',
      resourceId: session.sessionId,
      after: { title: session.title, turnCount: session.turnCount },
      meta: input as unknown as Record<string, unknown>,
    });
    this.emitDataEvent('audit_recorded', { correlationId, action: 'context_open', resourceId: session.sessionId, auditId: audit.id }, opts.runId);
    return { session, correlationId };
  }

  appendTurn(sessionId: string, input: AppendTurnInput, opts: PutDataOptions = {}): { turn: ContextTurn; correlationId: string; auditId: number } {
    const correlationId = opts.correlationId ?? `corr_${randomUUID().slice(0, 12)}`;
    const actor = opts.actor ?? this.opts.defaultActor;
    const { turn, auditId } = this.db.transaction(() => {
      const t = this.context.appendTurn(sessionId, input);
      const audit = this.history.record({
        correlationId,
        actor,
        action: 'context_turn_append',
        resourceType: 'context_turn',
        resourceId: String(t.id),
        after: { sessionId, turnNo: t.turnNo, role: t.role, tokens: t.tokens },
        meta: { sessionId },
      });
      return { turn: t, auditId: audit.id };
    })();
    this.emitDataEvent('context_turn_appended', { correlationId, sessionId, turnNo: turn.turnNo, role: turn.role, auditId }, opts.runId);
    return { turn, correlationId, auditId };
  }

  getRecentContext(sessionId: string, n = 10): ContextTurn[] {
    return this.context.getRecent(sessionId, n);
  }

  searchContext(query: string, opts: { limit?: number; sessionId?: string } = {}): ContextTurn[] {
    return this.context.search(query, opts);
  }

  // ---------------------------------------------------------------- 历史与变更追踪

  queryHistory(q: AuditQuery = {}): AuditEntry[] {
    return this.history.query(q);
  }

  traceByCorrelation(correlationId: string): AuditEntry[] {
    return this.history.byCorrelation(correlationId);
  }

  timeline(
    q: TimelineQuery,
    getRuns: (q: { actor?: string; from?: string; to?: string; limit?: number }) => any[],
    getEvents: (runId: string) => any[],
  ): TimelineEntry[] {
    return this.history.timeline(q, getRuns, getEvents);
  }

  // ---------------------------------------------------------------- 统计

  stats(): {
    repository: ReturnType<Repository['stats']>;
    audit: ReturnType<HistoryStore['stats']>;
    context: ReturnType<ContextStore['stats']>;
    vector: ReturnType<VectorRecall['stats']>;
  } {
    return {
      repository: this.repository.stats(),
      audit: this.history.stats(),
      context: this.context.stats(),
      vector: this.vectorRecall.stats(),
    };
  }

  // ---------------------------------------------------------------- 内部

  /** 事件出口：有 runId 则持久化（进该 run 的时间线）；无则 ephemeral（实时可见、不落盘，避免污染 events） */
  private emitDataEvent(type: 'data_changed' | 'data_deleted' | 'context_turn_appended' | 'audit_recorded', data: Record<string, unknown>, runId?: string): void {
    try {
      if (runId ?? this.opts.defaultRunId) {
        this.tracer.emit(runId ?? this.opts.defaultRunId!, type, data);
      } else {
        // 无归属 run：发 ephemeral（实时通道可见，不占持久化序号）
        this.tracer.emitLive('__knowledge__', type, data);
      }
    } catch {
      /* 事件出口失败不得影响主流程 */
    }
  }
}
