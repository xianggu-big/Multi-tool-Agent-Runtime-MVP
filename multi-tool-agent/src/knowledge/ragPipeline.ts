// src/knowledge/ragPipeline.ts — 可评测的 RAG 管线
//
// 文档 → 切块 → embedding → 关键词索引(BM25) + 向量索引(Flat/HNSW/IVF)
//      → 召回 → RRF/加权融合 → (可选) rerank → top-k
//
// 这是一个“可替换零件”的管线：embedding / 索引 / reranker 都是接口，
// 默认使用离线 HashEmbedder + Flat，保证测试零依赖、结果确定。

import { chunkDocument, type Chunk, type ChunkOptions } from './chunking.js';
import { createHashAsyncEmbedder, type AsyncEmbedder } from './embeddings.js';
import {
  createVectorIndex,
  type HnswOptions,
  type IvfOptions,
  type VectorIndex,
  type VectorIndexKind,
  type MetadataFilter,
} from './vectorIndex.js';
import {
  Bm25Index,
  LexicalReranker,
  reciprocalRankFusion,
  weightedScoreFusion,
  type FusedItem,
  type RankedItem,
  type Reranker,
} from './hybrid.js';

export interface RagDoc {
  id: string;
  text: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface RagBuildOptions {
  chunk?: ChunkOptions;
  embedder?: AsyncEmbedder;
  indexKind?: VectorIndexKind;
  hnsw?: HnswOptions;
  ivf?: IvfOptions;
  /** 自定义 reranker（默认 LexicalReranker）；cross-encoder 需异步实现 */
  reranker?: Reranker;
}

export type RagSearchMode = 'keyword' | 'vector' | 'hybrid' | 'hybrid_weighted' | 'hybrid_rerank';

export interface RagSearchOptions {
  mode?: RagSearchMode;
  k?: number;
  /** 融合前的候选池大小；默认 max(k*4, 20) */
  candidatePool?: number;
  filter?: MetadataFilter;
  /** hybrid_weighted 的向量权重 */
  alpha?: number;
  /** RRF 的 k（默认 60） */
  rrfK?: number;
  /** HNSW 查询候选数 */
  efSearch?: number;
  /** IVF 探测簇数 */
  nprobe?: number;
  /** rerank 前保留的候选数（默认 k*3） */
  rerankTopN?: number;
}

export interface RagSearchHit {
  id: string;
  chunkId: string;
  docId: string;
  score: number;
  normalizedScore: number;
  text: string;
  title?: string;
  heading?: string;
  chunkIndex: number;
  metadata: Record<string, unknown>;
  sources: string[];
  ranks: Record<string, number>;
  rerankScore?: number;
  rerankDetails?: Record<string, number>;
}

export interface RagSearchResult {
  query: string;
  mode: RagSearchMode;
  k: number;
  totalChunks: number;
  results: RagSearchHit[];
  latencyMs: number;
  timings: { embedMs: number; keywordMs: number; vectorMs: number; fusionMs: number; rerankMs: number };
}

export interface RagStats {
  docs: number;
  chunks: number;
  embedder: string;
  dim: number;
  index: ReturnType<VectorIndex['stats']>;
  keyword: ReturnType<Bm25Index['stats']>;
}

export class RagPipeline {
  private readonly chunkById = new Map<string, Chunk>();
  private readonly reranker: Reranker;

  private constructor(
    readonly chunks: Chunk[],
    readonly docs: RagDoc[],
    private readonly embedder: AsyncEmbedder,
    private readonly index: VectorIndex,
    private readonly keyword: Bm25Index,
    reranker?: Reranker,
  ) {
    for (const c of chunks) this.chunkById.set(c.id, c);
    this.reranker = reranker ?? new LexicalReranker();
  }

  static async build(docs: RagDoc[], opts: RagBuildOptions = {}): Promise<RagPipeline> {
    const embedder = opts.embedder ?? createHashAsyncEmbedder();
    const chunks = docs.flatMap((d) => chunkDocument(d, opts.chunk));
    const vectors = chunks.length ? await embedder.embed(chunks.map((c) => c.embedText)) : [];
    return RagPipeline.fromChunks(chunks, vectors, { ...opts, embedder }, docs);
  }

  /**
   * 从「已有的 chunk + 向量」重建管线——**不调用 embedding**。
   * 供持久化索引用：重启后从 rag_chunks 读回数据，几毫秒重建内存 BM25 + FlatIndex。
   * docs 省略时按 chunk.docId 去重推导（仅用于 stats().docs）。
   */
  static fromChunks(
    chunks: Chunk[],
    vectors: Float32Array[],
    opts: RagBuildOptions = {},
    docs?: RagDoc[],
  ): RagPipeline {
    const embedder = opts.embedder ?? createHashAsyncEmbedder();
    if (vectors.length !== chunks.length) {
      throw new Error(`RagPipeline: embedding 条数不符（${vectors.length} vs ${chunks.length}）`);
    }
    for (const v of vectors) {
      if (v.length !== embedder.dim) {
        throw new Error(`RagPipeline: embedding 维度不符（${v.length} vs ${embedder.dim}）`);
      }
    }
    const index = createVectorIndex(opts.indexKind ?? 'flat', { hnsw: opts.hnsw, ivf: opts.ivf });
    index.add(
      chunks.map((c, i) => ({
        id: c.id,
        vector: vectors[i],
        metadata: c.metadata,
      })),
    );
    const keyword = new Bm25Index();
    keyword.add(
      chunks.map((c) => ({
        id: c.id,
        text: c.text,
        title: c.title,
        metadata: c.metadata,
      })),
    );
    const derivedDocs: RagDoc[] =
      docs ?? [...new Set(chunks.map((c) => c.docId))].map((id) => ({ id, text: '' }));
    return new RagPipeline(chunks, derivedDocs, embedder, index, keyword, opts.reranker);
  }

  async search(query: string, opts: RagSearchOptions = {}): Promise<RagSearchResult> {
    const q = (query ?? '').trim();
    const mode = opts.mode ?? 'hybrid_rerank';
    const k = Math.max(1, Math.min(200, Math.floor(opts.k ?? 5)));
    const started = Date.now();
    const timings = { embedMs: 0, keywordMs: 0, vectorMs: 0, fusionMs: 0, rerankMs: 0 };
    if (!q || !this.chunks.length) {
      return { query: q, mode, k, totalChunks: this.chunks.length, results: [], latencyMs: Date.now() - started, timings };
    }

    const pool = Math.max(k, Math.min(this.chunks.length, Math.floor(opts.candidatePool ?? Math.max(k * 4, 20))));
    let keywordHits: RankedItem[] = [];
    if (mode !== 'vector') {
      const t = Date.now();
      keywordHits = this.keyword.search(q, { limit: pool, filter: opts.filter });
      timings.keywordMs = Date.now() - t;
    }

    let vectorHits: RankedItem[] = [];
    if (mode !== 'keyword') {
      const t0 = Date.now();
      const [qv] = await this.embedder.embed([q]);
      timings.embedMs = Date.now() - t0;
      const t1 = Date.now();
      const raw = this.index.search(qv, {
        k: pool,
        filter: opts.filter,
        efSearch: opts.efSearch,
        nprobe: opts.nprobe,
      });
      timings.vectorMs = Date.now() - t1;
      vectorHits = raw.map((r) => ({ id: r.id, score: r.score, metadata: r.metadata }));
    }

    let results: RagSearchHit[];
    if (mode === 'keyword') {
      results = this.fromRanked(keywordHits, 'keyword').slice(0, k);
    } else if (mode === 'vector') {
      results = this.fromRanked(vectorHits, 'vector').slice(0, k);
    } else {
      const t = Date.now();
      const fused = mode === 'hybrid_weighted'
        ? weightedScoreFusion(
            [
              { name: 'keyword', items: keywordHits },
              { name: 'vector', items: vectorHits },
            ],
            { alpha: opts.alpha ?? 0.5 },
          )
        : reciprocalRankFusion(
            [
              { name: 'keyword', items: keywordHits },
              { name: 'vector', items: vectorHits },
            ],
            { k: opts.rrfK ?? 60 },
          );
      timings.fusionMs = Date.now() - t;

      if (mode === 'hybrid_rerank') {
        const t0 = Date.now();
        const topN = Math.max(k, opts.rerankTopN ?? k * 3);
        const maxFused = fused[0]?.score || 1;
        const candidates = fused.slice(0, topN).flatMap((f) => {
          const c = this.chunkById.get(f.id);
          if (!c) return [];
          return [{
            id: f.id,
            text: c.text,
            title: c.title,
            heading: c.heading,
            metadata: c.metadata,
            priorScore: maxFused > 0 ? f.score / maxFused : 0,
            fused: f,
          }];
        });
        const reranked = await this.reranker.rerank(
          q,
          candidates.map(({ fused, ...c }) => c),
          k,
        );
        timings.rerankMs = Date.now() - t0;
        const byId = new Map(candidates.map((c) => [c.id, c.fused]));
        results = reranked.flatMap((r) => {
          const c = this.chunkById.get(r.id);
          const f = byId.get(r.id);
          if (!c) return [];
          return [{
            ...this.hitBase(c),
            score: r.rerankScore,
            normalizedScore: r.rerankScore,
            sources: f?.sources ?? ['rerank'],
            ranks: f?.ranks ?? {},
            rerankScore: r.rerankScore,
            rerankDetails: r.rerankDetails as unknown as Record<string, number>,
          }];
        });
      } else {
        results = fused.slice(0, k).flatMap((f) => {
          const c = this.chunkById.get(f.id);
          if (!c) return [];
          const max = fused[0]?.score || 1;
          return [{
            ...this.hitBase(c),
            score: f.score,
            normalizedScore: max > 0 ? f.score / max : 0,
            sources: f.sources,
            ranks: f.ranks,
          }];
        });
      }
    }
    return {
      query: q,
      mode,
      k,
      totalChunks: this.chunks.length,
      results,
      latencyMs: Date.now() - started,
      timings,
    };
  }

  stats(): RagStats {
    return {
      docs: this.docs.length,
      chunks: this.chunks.length,
      embedder: this.embedder.name,
      dim: this.embedder.dim,
      index: this.index.stats(),
      keyword: this.keyword.stats(),
    };
  }

  private fromRanked(items: RankedItem[], source: string): RagSearchHit[] {
    const max = items[0]?.score || 1;
    return items.flatMap((it, idx) => {
      const c = this.chunkById.get(it.id);
      if (!c) return [];
      return [{
        ...this.hitBase(c),
        score: it.score,
        normalizedScore: max > 0 ? it.score / max : 0,
        sources: [source],
        ranks: { [source]: idx + 1 },
      }];
    });
  }

  private hitBase(c: Chunk): Omit<RagSearchHit, 'score' | 'normalizedScore' | 'sources' | 'ranks'> {
    return {
      id: c.id,
      chunkId: c.id,
      docId: c.docId,
      text: c.text,
      title: c.title,
      heading: c.heading,
      chunkIndex: c.chunkIndex,
      metadata: c.metadata,
    };
  }
}

/** 便捷函数：一次性构建并搜索（脚本/演示用）。 */
export async function ragSearch(
  docs: RagDoc[],
  query: string,
  opts: RagBuildOptions & RagSearchOptions = {},
): Promise<RagSearchResult> {
  const pipeline = await RagPipeline.build(docs, opts);
  return pipeline.search(query, opts);
}

export type { FusedItem };
