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
import {
  RagPipeline,
  type RagBuildOptions,
  type RagDoc,
  type RagSearchHit,
  type RagSearchMode,
  type RagSearchOptions,
  type RagSearchResult,
} from './ragPipeline.js';
import { RagIndexStore, hashDocText, type RagIndexFingerprint } from './ragIndexStore.js';
import { chunkDocument } from './chunking.js';
import { createConfiguredEmbedder, createHashAsyncEmbedder } from './embeddings.js';
import type { Tracer } from '../trace/Tracer.js';
import type { ErrorReporter } from '../runtime/errorReporter.js';

export interface KnowledgeHubOptions {
  /** 默认操作者（runId/userId）；单次操作可用 opts.actor 覆盖 */
  defaultActor?: string;
  /** 默认事件归属 runId（用于实时流推送；无则发 ephemeral 事件，不落盘） */
  defaultRunId?: string;
  /**
   * 写入后是否在后台异步刷新 RAG 索引（默认 false）。
   * 关闭时：写入只把 cache 置空，下一次检索时同步增量补齐（单文档几百 ms）。
   * 开启时：写入立刻返回，索引在后台补；后台失败不抛出，留给下次检索重试。
   * 注意：测试/导入脚本默认关闭，避免后台任务与断言竞争。
   */
  backgroundIndex?: boolean;
}

export interface PutDataOptions {
  actor?: string;
  runId?: string;
  /** 显式 correlationId（默认自动生成）；便于把多次写并到一个操作里追溯 */
  correlationId?: string;
}

/** RAG 文档数上限：默认 50,000（内存索引的安全线），可用 MTA_RAG_MAX_DOCS 覆盖 */
function ragMaxDocs(): number {
  const raw = Number(process.env.MTA_RAG_MAX_DOCS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 50_000;
}

export interface PutDataResult {
  item: DataItem;
  isCreate: boolean;
  correlationId: string;
  auditId: number;
}

/** 对外唯一检索语义：关键词 / 语义 / 混合都走同一条切块级 RAG 管线 */
export type KnowledgeSearchMode = 'keyword' | 'semantic' | 'hybrid';

export interface KnowledgeSearchOptions {
  /** 返回多少条**文档级**命中（同一文档多个 chunk 只算一条），默认 20，上限 200 */
  limit?: number;
  /** 只检索某个 collection（下推到 RAG 元数据过滤） */
  collection?: string;
}

/** 文档级命中：保留 DataItem 原字段，同时带上 RAG 的 chunk/得分/来源信息 */
export interface KnowledgeDocHit extends DataItem {
  /** 融合/重排后的原始分（不同 mode 不可直接比较） */
  score: number;
  /** 归一到 [0,1] 的分（同一批结果内可比） */
  normalizedScore: number;
  /** 命中来源：关键词 / 语义 / 两者都有（同一文档多个 chunk 的并集） */
  matchedBy: 'keyword' | 'semantic' | 'both';
  /** 代表该文档的最高分 chunk */
  chunkId: string;
  heading?: string;
  /** 该文档命中的 chunk 数（用于观察长文被切碎后的召回情况） */
  chunkHits: number;
}

export interface KnowledgeSearchResult {
  query: string;
  mode: KnowledgeSearchMode;
  /** 实际执行的 RAG 模式（keyword / vector / hybrid_rerank） */
  ragMode: RagSearchMode;
  collection?: string;
  count: number;
  hits: KnowledgeDocHit[];
  latencyMs: number;
  timings: RagSearchResult['timings'];
}

/** 统一后的向量层统计（旧 `data_vec` 只作为历史表存在，不再写入） */
export interface KnowledgeVectorStats {
  engine: 'rag';
  available: boolean;
  built: boolean;
  embedder: string;
  dim: number;
  /** 向量条数 = chunk 数 */
  count: number;
  docs: number;
  chunks: number;
}

export class KnowledgeHub {
  readonly repository: Repository;
  readonly history: HistoryStore;
  readonly context: ContextStore;
  /** 切块级 RAG 管线（懒构建；写入/删除后失效，下次检索按 doc_hash 增量刷新） */
  private ragCache: {
    pipeline: RagPipeline;
    builtAt: string;
    docs: number;
    /** 本次刷新真正重算的文档数 / chunk 数（都为 0 表示全部命中缓存） */
    reindexedDocs: number;
    embeddedChunks: number;
  } | null = null;
  /** 切块 + 向量的持久化层：重启后从这里重建，不重跑 embedding */
  readonly ragStore: RagIndexStore;
  /** 正在进行的索引刷新（前台检索与后台补算共享同一个 Promise，避免并发重复构建） */
  private indexSync: Promise<RagPipeline> | null = null;
  /** 数据版本：每次写入/删除 +1；用来发现「构建期间又发生了写入」 */
  private dataVersion = 0;

  constructor(
    private readonly db: Database.Database,
    private readonly tracer: Tracer,
    private readonly errors: ErrorReporter,
    private readonly opts: KnowledgeHubOptions = {},
  ) {
    this.repository = new Repository(db);
    this.history = new HistoryStore(db);
    this.context = new ContextStore(db);
    this.ragStore = new RagIndexStore(db);
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
    // 统一写入路径：不再维护第二套 data_vec 向量；下次检索/后台任务按 doc_hash 增量重建 RAG。
    this.dataVersion += 1;
    this.ragCache = null; // 下次检索按 doc_hash 增量刷新（命中持久化索引时不跑 embedding）
    this.kickBackgroundIndex();
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
    if (deleted) {
      this.dataVersion += 1;
      this.ragCache = null;
      this.kickBackgroundIndex();
      this.emitDataEvent('data_deleted', { correlationId, action: 'data_delete', resourceId: deleted.id, collection, itemId, auditId }, opts.runId);
    }
    return { deleted, correlationId, auditId };
  }

  // ---------------------------------------------------------------- 统一检索（RAG）

  /**
   * 对外唯一检索入口：关键词 / 语义 / 混合都走同一条切块级 RAG 管线。
   *
   * - `keyword`  → BM25（中文按字 bigram + 拉丁词，优于 FTS5 默认分词）
   * - `semantic` → 向量近邻（Flat/HNSW/IVF，取决于索引构建参数）
   * - `hybrid`   → BM25 + 向量 → RRF → 词法 rerank
   *
   * 命中按 `docId` 聚合：同一文档多个 chunk 只返回一次（取最高分 chunk），
   * 避免长文档因为切块多而挤占其他文档的位置；`matchedBy` 是整篇文档的来源并集。
   */
  async searchKnowledge(
    query: string,
    opts: KnowledgeSearchOptions & { mode?: KnowledgeSearchMode } = {},
  ): Promise<KnowledgeSearchResult> {
    const mode = opts.mode ?? 'hybrid';
    const limit = Math.max(1, Math.min(200, opts.limit ?? 20));
    // 先多取 chunk，再按文档去重：否则一个长文档的多个 chunk 会把 doc 级 top-k 占满。
    const chunkK = Math.min(500, Math.max(limit * 4, 40));
    const ragMode: RagSearchMode = mode === 'keyword' ? 'keyword' : mode === 'semantic' ? 'vector' : 'hybrid_rerank';
    const rag = await this.searchRag(query, {
      mode: ragMode,
      k: chunkK,
      candidatePool: Math.max(chunkK * 2, 80),
      filter: opts.collection ? (m) => m.collection === opts.collection : undefined,
    });

    const byDoc = new Map<string, { best: RagSearchHit; sources: Set<string>; chunkHits: number }>();
    for (const h of rag.results) {
      if (!h.docId) continue;
      const existing = byDoc.get(h.docId);
      if (!existing) {
        byDoc.set(h.docId, { best: h, sources: new Set(h.sources), chunkHits: 1 });
        continue;
      }
      existing.chunkHits += 1;
      for (const s of h.sources) existing.sources.add(s);
      if (h.normalizedScore > existing.best.normalizedScore) existing.best = h;
    }

    const hits: KnowledgeDocHit[] = [];
    for (const { best, sources, chunkHits } of byDoc.values()) {
      const item = this.repository.getById(best.docId);
      if (!item) continue; // 索引里可能残留已删除文档的块，下次增量同步会清掉
      hits.push({
        ...item,
        score: best.score,
        normalizedScore: best.normalizedScore,
        matchedBy: matchedByOf(sources),
        chunkId: best.chunkId,
        heading: best.heading,
        chunkHits,
      });
    }
    hits.sort((a, b) => b.normalizedScore - a.normalizedScore || b.score - a.score);
    const top = hits.slice(0, limit);
    return {
      query,
      mode,
      ragMode,
      collection: opts.collection,
      count: top.length,
      hits: top,
      latencyMs: rag.latencyMs,
      timings: rag.timings,
    };
  }

  /** 语义检索（RAG vector 模式的兼容入口） */
  async searchSemantic(query: string, opts: KnowledgeSearchOptions = {}): Promise<KnowledgeDocHit[]> {
    return (await this.searchKnowledge(query, { ...opts, mode: 'semantic' })).hits;
  }

  /** 关键词检索（RAG BM25 模式的兼容入口；低层 FTS5 仍可用 `searchData`） */
  async searchKeyword(query: string, opts: KnowledgeSearchOptions = {}): Promise<KnowledgeDocHit[]> {
    return (await this.searchKnowledge(query, { ...opts, mode: 'keyword' })).hits;
  }

  /**
   * 从 data_items 增量构建/刷新切块级 RAG 索引（chunk → embedding → BM25 + 向量索引）。
   *
   * 持久化（P0）：chunk 正文 + 向量落在 rag_chunks，重启后只读盘重建内存索引，
   * **不再重跑 embedding**（本机 979 文档：52.3s → 数十毫秒）。
   * 增量：只重算 doc_hash 变化的文档；文档消失则级联删块。
   * 失效：embedding 模型 / 维度 / 切块参数任一变化 → 指纹不匹配 → 整库重算。
   * 默认 Flat 精确索引；需要 HNSW/IVF 时传 indexKind（仅评测用，不持久化索引结构）。
   */
  async rebuildRag(opts: RagBuildOptions = {}): Promise<RagPipeline> {
    // Repository.list 单页上限 500：必须显式分页，否则超过 500 条会静默截断。
    // 超过 5 万条时明确报错，避免一次 rebuild 把内存/embedding 成本打满。
    const MAX_RAG_DOCS = ragMaxDocs();
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
          throw new Error(
            `RAG 索引文档数超过上限 ${MAX_RAG_DOCS}：请分批构建、调大 MTA_RAG_MAX_DOCS，或改用外部向量库（内存索引在更大规模会先撑爆内存）`,
          );
        }
        break;
      }
    }

    // 显式 opt-in：MTA_EMBEDDING_MODEL 存在时走真实 embedding；否则保持离线 hash。
    const embedder = opts.embedder ?? createConfiguredEmbedder() ?? createHashAsyncEmbedder(256);
    const chunk = { chunkSize: 512, overlap: 64, ...(opts.chunk ?? {}) };
    const fingerprint: RagIndexFingerprint = {
      model: embedder.name,
      dim: embedder.dim,
      chunk: `${chunk.chunkSize}/${chunk.overlap}`,
    };
    if (!this.ragStore.matches(fingerprint)) this.ragStore.reset(fingerprint);

    const currentHashes = new Map(docs.map((d) => [d.id, hashDocText(d.text)]));
    const indexed = this.ragStore.listDocHashes();
    const removed = [...indexed.keys()].filter((id) => !currentHashes.has(id));
    if (removed.length) this.ragStore.removeDocs(removed);

    let reindexedDocs = 0;
    let embeddedChunks = 0;
    for (const d of docs) {
      const hash = currentHashes.get(d.id)!;
      if (indexed.get(d.id) === hash) continue;
      const chunks = chunkDocument(d, chunk);
      const vectors = chunks.length ? await embedder.embed(chunks.map((c) => c.embedText)) : [];
      this.ragStore.replaceDoc(d.id, hash, chunks, vectors, fingerprint);
      reindexedDocs += 1;
      embeddedChunks += chunks.length;
    }

    const stored = this.ragStore.load();
    const pipeline = RagPipeline.fromChunks(
      stored.map((s) => s.chunk),
      stored.map((s) => s.vector),
      { ...opts, embedder },
      docs,
    );
    this.ragCache = { pipeline, builtAt: new Date().toISOString(), docs: docs.length, reindexedDocs, embeddedChunks };
    return pipeline;
  }

  /** 切块级混合检索（默认 hybrid_rerank）。索引未就绪时按需构建（增量，命中持久化层时不跑 embedding）。 */
  async searchRag(query: string, opts: RagSearchOptions = {}) {
    const pipeline = await this.ensureIndex();
    return pipeline.search(query, opts);
  }

  /** 前台检索与后台补算共享同一个 in-flight 构建，避免并发重复构建 */
  private ensureIndex(): Promise<RagPipeline> {
    if (this.ragCache) return Promise.resolve(this.ragCache.pipeline);
    if (!this.indexSync) {
      const version = this.dataVersion;
      this.indexSync = this.rebuildRag()
        .then((pipeline) => {
          // 构建期间又有写入：本次结果可能是旧的，作废 cache 让下一次补齐
          if (this.dataVersion !== version) this.ragCache = null;
          return pipeline;
        })
        .finally(() => {
          this.indexSync = null;
        });
    }
    return this.indexSync;
  }

  /**
   * 后台补算：仅当 KnowledgeHubOptions.backgroundIndex=true 时生效。
   * 写入路径因此保持 O(1)，不会阻塞调用方；失败只吞掉，交给下一次检索重试。
   */
  private kickBackgroundIndex(): void {
    if (!this.opts.backgroundIndex) return;
    void this.ensureIndex()
      .then(() => {
        if (!this.ragCache && this.opts.backgroundIndex) this.kickBackgroundIndex();
      })
      .catch(() => {
        /* 后台失败不抛；下次检索会再试 */
      });
  }

  /** 是否开启了「写入后台补索引」（供状态接口展示） */
  get backgroundIndexEnabled(): boolean {
    return !!this.opts.backgroundIndex;
  }

  /** RAG 索引状态（无论是否构建过都返回；供 `GET /api/rag/status` 观测） */
  ragStatus() {
    return {
      engine: 'rag' as const,
      built: !!this.ragCache,
      /** 是否正在构建/刷新（前台检索与后台补算共享同一个任务） */
      indexing: !!this.indexSync,
      backgroundIndex: !!this.opts.backgroundIndex,
      cache: this.ragCache
        ? {
            builtAt: this.ragCache.builtAt,
            docs: this.ragCache.docs,
            lastSync: {
              reindexedDocs: this.ragCache.reindexedDocs,
              embeddedChunks: this.ragCache.embeddedChunks,
            },
          }
        : null,
      store: this.ragStore.stats(),
      /** 旧 sqlite-vec 轨已停写；历史表若存在可手动清理（见 docs/KNOWLEDGE_SYSTEM.md） */
      legacyVector: { active: false, table: 'data_vec' as const },
      /** 当前允许的最大文档数（`MTA_RAG_MAX_DOCS`，默认 50000） */
      docLimit: ragMaxDocs(),
    };
  }

  /** RAG 索引状态；尚未构建时返回 null（不触发构建）。 */
  ragStats() {
    if (!this.ragCache) return null;
    return {
      ...this.ragCache.pipeline.stats(),
      builtAt: this.ragCache.builtAt,
      cachedDocs: this.ragCache.docs,
      /** 最近一次刷新的增量指标：都为 0 表示全部命中持久化索引（未跑 embedding） */
      lastSync: {
        reindexedDocs: this.ragCache.reindexedDocs,
        embeddedChunks: this.ragCache.embeddedChunks,
      },
      store: this.ragStore.stats(),
    };
  }

  /** 混合检索（RAG BM25 + 向量 → RRF → rerank 的兼容入口） */
  async searchHybrid(query: string, opts: KnowledgeSearchOptions = {}): Promise<KnowledgeDocHit[]> {
    return (await this.searchKnowledge(query, { ...opts, mode: 'hybrid' })).hits;
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
    vector: KnowledgeVectorStats;
  } {
    const store = this.ragStore.stats();
    const cached = this.ragCache?.pipeline.stats();
    const fp = store.fingerprint;
    return {
      repository: this.repository.stats(),
      audit: this.history.stats(),
      context: this.context.stats(),
      vector: {
        engine: 'rag',
        available: true,
        built: !!this.ragCache,
        // 未构建时用持久化指纹（上次构建的参数）；全新库回落到默认离线嵌入器。
        embedder: cached?.embedder ?? fp?.model ?? defaultEmbedderName(),
        dim: cached?.dim ?? fp?.dim ?? defaultEmbedderDim(),
        count: store.chunks,
        docs: store.docs,
        chunks: store.chunks,
      },
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

/** 文档级 `matchedBy`：同一文档可能有多个 chunk 分别来自关键词/向量两路 */
function matchedByOf(sources: Set<string>): 'keyword' | 'semantic' | 'both' {
  const keyword = sources.has('keyword');
  const vector = sources.has('vector');
  if (keyword && vector) return 'both';
  if (keyword) return 'keyword';
  return 'semantic';
}

/** 未构建索引时展示的默认嵌入器（与 rebuildRag 的默认选择保持一致） */
function defaultEmbedderInfo(): { name: string; dim: number } {
  try {
    const configured = createConfiguredEmbedder();
    if (configured) return { name: configured.name, dim: configured.dim };
  } catch {
    /* 配置不完整（如缺 Key）时退回离线嵌入器，状态接口不该因此 500 */
  }
  const fallback = createHashAsyncEmbedder(256);
  return { name: fallback.name, dim: fallback.dim };
}

function defaultEmbedderName(): string {
  return defaultEmbedderInfo().name;
}

function defaultEmbedderDim(): number {
  return defaultEmbedderInfo().dim;
}
