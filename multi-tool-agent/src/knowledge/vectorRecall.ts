// src/knowledge/vectorRecall.ts — 语义向量召回层（在 FTS5 关键词检索之上叠加）
//
// 为什么需要这一层：
//   现有 Repository 用 FTS5 做关键词检索（按词命中），但「按语义/意图」召回不了——
//   例如存了「代码审计发现 3 处硬编码」，用户问「有没有不安全的常量」FTS5 命中不了关键词。
//   向量召回按语义近邻找，补齐这一块，让知识库「按意思」而非「按字面」生长。
//
// 可降级设计（与 Repository 的 FTS5→LIKE 降级同约定）：
//   ① sqlite-vec 扩展可用 → 真 kNN（vec0 虚表，余弦/L2 距离，高性能）；
//   ② 不可用 → 降级为「FTS5 取候选 + 内存余弦重排」（无原生扩展也能用，只是规模受限）；
//   ③ 嵌入器：默认用零依赖的 HashEmbedder（词/字符 n-gram 哈希向量，确定性，捕获词法重叠）；
//      可注入真实嵌入器（@xenova/transformers / OpenAI embeddings 等）升级为真语义召回。
//
// 与现有系统的关系：
//   - 复用 Repository 的同一 Database 连接（data_vec 虚表与 data_items 同库）；
//   - 不改 Repository 的接口；VectorRecall 是叠加层，由 KnowledgeHub 在 putData 后顺带嵌入；
//   - 检索时 KnowledgeHub 可选择「关键词(FTS5)」「语义(向量)」「混合(并集+去重)」。
//
// 业界对标（详见 docs/KNOWLEDGE_BASE_ENHANCEMENT.md）：
//   - sqlite-vec：纯 C、零依赖、与 better-sqlite3 原生集成（已在本机探测可用 v0.1.9）；
//   - LlamaIndex：分层索引（节点/摘要/图谱）+ 自动摘要——本层的「混合检索」是其轻量子集；
//   - ChromaDB/Qdrant：专用向量库——本系统单库 SQLite 已够，暂不引入额外服务。

import type Database from 'better-sqlite3';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// 嵌入器接口（可替换；默认零依赖实现，可注入真实模型）
// ---------------------------------------------------------------------------

export interface Embedder {
  readonly name: string;
  readonly dim: number;
  embed(text: string): Float32Array;
}

/**
 * 默认嵌入器：词 + 字符 n-gram 哈希到固定维度向量（确定性、零依赖、纯 JS）。
 * 不是真语义嵌入，但能捕获词法重叠——对「FTS5 候选重排」与「无依赖兜底」足够。
 * 真语义召回时注入 TransformerEmbedder / OpenAIEmbedder 替换即可，VectorRecall 不感知实现。
 */
export class HashEmbedder implements Embedder {
  readonly name = 'hash-ngram';
  readonly dim: number;
  private readonly seed: number;

  constructor(dim = 256, seed = 0x9e3779b9) {
    this.dim = dim;
    this.seed = seed;
  }

  embed(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    const tokens = this.tokenize(text);
    for (const tok of tokens) {
      // 双重哈希定位维度 + 符号（DCHam 降维，避免大哈希表）
      const h1 = this.hash(tok, this.seed);
      const h2 = this.hash(tok, this.seed ^ 0x517cc1b7);
      const idx = Math.abs(h1) % this.dim;
      const sign = (h2 & 1) === 0 ? 1 : -1;
      v[idx] += sign;
    }
    // L2 归一化（余弦相似度 = 归一化后的点积）
    let norm = 0;
    for (let i = 0; i < this.dim; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < this.dim; i++) v[i] /= norm;
    return v;
  }

  private tokenize(text: string): string[] {
    const lower = (text ?? '').toLowerCase();
    const out: string[] = [];
    // 词级 token
    const words = lower.match(/[a-z0-9\u4e00-\u9fff]+/g) ?? [];
    for (const w of words) {
      if (w.length >= 2) out.push(w);
      // 字符 3-gram（中文友好：单个汉字也算，且连续汉字切出 3-gram）
      if (w.length > 3) {
        for (let i = 0; i + 3 <= w.length; i++) out.push(w.slice(i, i + 3));
      }
    }
    return out;
  }

  private hash(s: string, seed: number): number {
    // xfnv1a 变体（确定性、分布均匀）
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h | 0;
  }
}

// ---------------------------------------------------------------------------
// 向量工具：Float32Array ↔ Buffer（sqlite-vec 要求 BLOB）
// ---------------------------------------------------------------------------

export function vecToBuffer(v: Float32Array): Buffer {
  const b = Buffer.alloc(v.length * 4);
  for (let i = 0; i < v.length; i++) b.writeFloatLE(v[i], i * 4);
  return b;
}

export function bufferToVec(b: Buffer): Float32Array {
  const v = new Float32Array(b.length / 4);
  for (let i = 0; i < v.length; i++) v[i] = b.readFloatLE(i * 4);
  return v;
}

/** 归一化余弦相似度（向量化但 JS 实现，降级路径用） */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot; // 输入已归一化时 = 余弦
}

// ---------------------------------------------------------------------------
// 向量召回层
// ---------------------------------------------------------------------------

export interface VectorRecallOptions {
  embedder?: Embedder;
  /** 召回条目数上限（kNN k） */
  topK?: number;
  /** 降级路径：FTS5/LIKE 取多少候选再重排 */
  fallbackCandidateLimit?: number;
  /** sqlite-vec 不可用时是否静默降级（默认 true） */
  silentFallback?: boolean;
}

export interface VectorHit {
  id: string;
  collection: string;
  itemId: string;
  score: number;
}

export class VectorRecall {
  private readonly db: Database.Database;
  readonly embedder: Embedder;
  readonly topK: number;
  private readonly fallbackCandidateLimit: number;
  private readonly silentFallback: boolean;
  private vecAvailable = false;
  private vecTableReady = false;

  constructor(db: Database.Database, opts: VectorRecallOptions = {}) {
    this.db = db;
    this.embedder = opts.embedder ?? new HashEmbedder();
    this.topK = Math.max(1, Math.min(200, opts.topK ?? 20));
    this.fallbackCandidateLimit = Math.max(this.topK, opts.fallbackCandidateLimit ?? 200);
    this.silentFallback = opts.silentFallback ?? true;
    this.init();
  }

  get available(): boolean {
    return this.vecAvailable;
  }

  /** 探测 sqlite-vec 并建表（失败则降级） */
  private init(): void {
    try {
      // sqlite-vec 的 load(db) 内部处理 enableLoadExtension 开关；无需手动切换
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sqliteVec = require('sqlite-vec');
      sqliteVec.load(this.db);
      // 探测版本（确认扩展真的加载了）
      this.db.prepare('SELECT vec_version()').get();
      this.vecAvailable = true;
      // 用辅助列 data_id(text) 直接存 data_items 的 id，避免 rowid 对齐问题
      // （sqlite-vec v0.1.9 不允许显式传 rowid；辅助列是官方推荐的关联方式）
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS data_vec USING vec0(embedding float[${this.embedder.dim}], data_id text);`,
      );
      this.vecTableReady = true;
    } catch (e) {
      this.vecAvailable = false;
      this.vecTableReady = false;
      if (!this.silentFallback) {
        // 不静默时抛出，让上层决定
        throw e;
      }
      // 静默降级：检索仍可用（FTS5 候选 + 内存重排），只是没有原生 kNN
    }
  }

  /** 写入/更新一条数据的向量（按 data_id 对齐，data_id = data_items.id） */
  upsert(dataId: string, text: string): void {
    if (!this.vecAvailable || !this.vecTableReady) return;
    const v = this.embedder.embed(text);
    const buf = vecToBuffer(v);
    const tx = this.db.transaction(() => {
      // 先删后插（vec0 不支持 ON CONFLICT；data_id 是辅助列可作删除条件）
      this.db.prepare('DELETE FROM data_vec WHERE data_id = ?').run(dataId);
      this.db.prepare('INSERT INTO data_vec (data_id, embedding) VALUES (?, ?)').run(dataId, buf);
    });
    tx();
  }

  /** 删除一条向量（按 data_id） */
  remove(dataId: string): void {
    if (!this.vecAvailable || !this.vecTableReady) return;
    this.db.prepare('DELETE FROM data_vec WHERE data_id = ?').run(dataId);
  }

  /**
   * 语义检索：返回 {id, collection, itemId, score}[]（按相似度降序）。
   * - sqlite-vec 可用：原生 kNN（按 data_id 关联回 data_items；score = 1 - distance/2）；
   * - 不可用：降级为「全表扫描 + 内存余弦」——规模小可用，大时建议装扩展。
   *   （不依赖 FTS5 关键词命中，因为语义召回的本意就是「字面不重叠但意思相近」。）
   */
  search(query: string, opts: { limit?: number; collection?: string } = {}): VectorHit[] {
    const limit = Math.max(1, Math.min(200, opts.limit ?? this.topK));
    const qv = this.embedder.embed(query);
    if (!qv.some((x) => x !== 0)) return []; // 全零查询向量无意义

    if (this.vecAvailable && this.vecTableReady) {
      try {
        const rows = this.db
          .prepare(
            `SELECT v.data_id AS id, v.distance AS d, di.collection, di.itemId
             FROM data_vec v
             JOIN data_items di ON di.id = v.data_id
             WHERE v.embedding MATCH ?
             ${opts.collection ? 'AND di.collection = ?' : ''}
             ORDER BY v.distance
             LIMIT ?`,
          )
          .all(vecToBuffer(qv), ...(opts.collection ? [opts.collection] : []), limit) as any[];
        return rows
          .filter((r) => r.id)
          .map((r) => ({
            id: r.id,
            collection: r.collection,
            itemId: r.itemId,
            // sqlite-vec 余弦距离 ∈ [0,2]，转成相似度 ∈ [0,1]（越大越相似）
            score: Math.max(0, 1 - (r.d ?? 0) / 2),
          }));
      } catch {
        // 查询失败（向量维度不匹配等）→ 降级
      }
    }

    // 降级：全表扫描 + 内存余弦（无原生扩展时的兜底）
    const rows = this.db
      .prepare(
        `SELECT id, collection, itemId, searchText FROM data_items
         ${opts.collection ? 'WHERE collection = ?' : ''}`,
      )
      .all(...(opts.collection ? [opts.collection] : [])) as any[];
    const scored: VectorHit[] = [];
    for (const r of rows) {
      if (!r.searchText) continue;
      const ev = this.embedder.embed(r.searchText);
      const s = cosine(qv, ev);
      if (s > 0) scored.push({ id: r.id, collection: r.collection, itemId: r.itemId, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  stats(): { available: boolean; embedder: string; dim: number; count: number } {
    let count = 0;
    if (this.vecAvailable && this.vecTableReady) {
      try {
        count = (this.db.prepare('SELECT COUNT(*) AS c FROM data_vec').get() as any)?.c ?? 0;
      } catch {
        count = 0;
      }
    }
    return { available: this.vecAvailable, embedder: this.embedder.name, dim: this.embedder.dim, count };
  }
}
