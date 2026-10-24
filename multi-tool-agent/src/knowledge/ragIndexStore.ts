// src/knowledge/ragIndexStore.ts — 切块级 RAG 索引的持久化层（P0）
//
// 解决的问题：RagPipeline 原先只存在于内存（KnowledgeHub.ragCache），进程重启后首次检索
// 要把全部 chunk 重新跑一遍 embedding（本机实测 979 文档 = 1107 chunks = 52s）。
// 这里把「已经算出来的 chunk 正文 + 向量」落到 SQLite，重启只需读盘（4.5MB 量级）。
//
// 边界（P0 只做持久化，不把检索下沉到 SQL）：
//   - 检索仍是内存 Bm25Index + FlatIndex，由 RagPipeline.fromChunks() 从本表重建；
//   - 关键词刻意不用 FTS5（unicode61 对连续中文分词差，会静默降低召回）；
//   - 向量刻意不用 sqlite-vec（Phase 2 再按规模启用 kNN 下沉）。
//
// 一致性：一个文档的 chunk 行只在**同一个事务**里整批替换（先删后插），
// 所以不存在「半新半旧」的文档；doc_hash 与这些行同批写入，作为增量判定的唯一依据。

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { Chunk } from './chunking.js';
import { bufferToVec, vecToBuffer } from './vectorRecall.js';

export interface RagIndexFingerprint {
  /** embedding 模型名（含维度后缀，如 qwen3-embedding-0.6b@1024） */
  model: string;
  dim: number;
  /** 切块参数，形如 '512/64' */
  chunk: string;
}

export interface StoredChunk {
  chunk: Chunk;
  vector: Float32Array;
}

/** 文档内容哈希：只看真正参与检索的文本，避免 updatedAt 等无关字段触发重算 */
export function hashDocText(text: string): string {
  return createHash('sha1').update(text ?? '').digest('hex').slice(0, 16);
}

const META_KEY = 'fingerprint';

const DDL = `
  CREATE TABLE IF NOT EXISTS rag_chunks (
    chunk_id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    doc_hash TEXT NOT NULL,
    text TEXT NOT NULL,
    embed_text TEXT NOT NULL,
    heading TEXT,
    title TEXT,
    char_start INTEGER NOT NULL,
    char_end INTEGER NOT NULL,
    token_estimate INTEGER NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    embedding BLOB NOT NULL,
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    chunk_config TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_rag_chunks_doc ON rag_chunks(doc_id);
  CREATE TABLE IF NOT EXISTS rag_index_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

export class RagIndexStore {
  constructor(private readonly db: Database.Database) {
    db.exec(DDL);
  }

  /** 当前已持久化的索引指纹（从未建过则为 null） */
  fingerprint(): RagIndexFingerprint | null {
    const row = this.db.prepare('SELECT value FROM rag_index_meta WHERE key = ?').get(META_KEY) as
      | { value: string }
      | undefined;
    if (!row) return null;
    try {
      const p = JSON.parse(row.value) as RagIndexFingerprint;
      if (p && typeof p.model === 'string' && typeof p.dim === 'number' && typeof p.chunk === 'string') return p;
    } catch {
      /* 损坏的指纹按「无指纹」处理 → 触发全量重建 */
    }
    return null;
  }

  matches(fp: RagIndexFingerprint): boolean {
    const cur = this.fingerprint();
    return !!cur && cur.model === fp.model && cur.dim === fp.dim && cur.chunk === fp.chunk;
  }

  /** 清空所有 chunk 并写入新指纹（换模型 / 换切块参数时调用） */
  reset(fp: RagIndexFingerprint): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM rag_chunks').run();
      this.db
        .prepare(
          'INSERT INTO rag_index_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        )
        .run(META_KEY, JSON.stringify(fp));
    })();
  }

  /** docId → 已索引的内容哈希（用于和 data_items 当前内容比对） */
  listDocHashes(): Map<string, string> {
    const rows = this.db
      .prepare('SELECT doc_id, MAX(doc_hash) AS doc_hash FROM rag_chunks GROUP BY doc_id')
      .all() as Array<{ doc_id: string; doc_hash: string }>;
    const out = new Map<string, string>();
    for (const r of rows) out.set(r.doc_id, r.doc_hash);
    return out;
  }

  /** 整批替换一个文档的所有 chunk（同一事务：删旧 + 插新） */
  replaceDoc(docId: string, docHash: string, chunks: Chunk[], vectors: Float32Array[], fp: RagIndexFingerprint): void {
    if (chunks.length !== vectors.length) {
      throw new Error(`RAG 索引：chunk 与向量条数不符（${chunks.length} vs ${vectors.length}）`);
    }
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM rag_chunks WHERE doc_id = ?').run(docId);
      const ins = this.db.prepare(
        `INSERT INTO rag_chunks
           (chunk_id, doc_id, chunk_index, doc_hash, text, embed_text, heading, title,
            char_start, char_end, token_estimate, metadata_json, embedding, model, dim, chunk_config, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        ins.run(
          c.id,
          docId,
          c.chunkIndex,
          docHash,
          c.text,
          c.embedText,
          c.heading ?? null,
          c.title ?? null,
          c.charStart,
          c.charEnd,
          c.tokenEstimate,
          JSON.stringify(c.metadata ?? {}),
          vecToBuffer(vectors[i]),
          fp.model,
          fp.dim,
          fp.chunk,
          now,
        );
      }
    });
    tx();
  }

  /** 删除若干文档的全部 chunk（文档被删时级联） */
  removeDocs(docIds: string[]): number {
    if (!docIds.length) return 0;
    const del = this.db.prepare('DELETE FROM rag_chunks WHERE doc_id = ?');
    let n = 0;
    this.db.transaction(() => {
      for (const id of docIds) n += del.run(id).changes;
    })();
    return n;
  }

  /** 读出全部 chunk + 向量（供 RagPipeline.fromChunks 重建内存索引） */
  load(): StoredChunk[] {
    const rows = this.db
      .prepare('SELECT * FROM rag_chunks ORDER BY doc_id, chunk_index')
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const vector = bufferToVec(r.embedding as Buffer);
      const chunk: Chunk = {
        id: String(r.chunk_id),
        docId: String(r.doc_id),
        chunkIndex: Number(r.chunk_index),
        text: String(r.text),
        embedText: String(r.embed_text),
        heading: (r.heading as string | null) ?? undefined,
        title: (r.title as string | null) ?? undefined,
        charStart: Number(r.char_start),
        charEnd: Number(r.char_end),
        tokenEstimate: Number(r.token_estimate),
        metadata: safeJson(r.metadata_json as string),
      };
      return { chunk, vector };
    });
  }

  stats(): { docs: number; chunks: number; fingerprint: RagIndexFingerprint | null } {
    const chunks = (this.db.prepare('SELECT COUNT(*) AS c FROM rag_chunks').get() as { c: number }).c;
    const docs = (this.db.prepare('SELECT COUNT(DISTINCT doc_id) AS c FROM rag_chunks').get() as { c: number }).c;
    return { docs, chunks, fingerprint: this.fingerprint() };
  }
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
