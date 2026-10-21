// src/knowledge/hybrid.ts — 关键词 BM25 + 向量召回的融合与重排
//
// 关键词检索擅长：专有名词、错误码、函数名、精确短语。
// 向量检索擅长：同义改写、口语化提问、跨语言/模糊意图。
// 融合后通常比单路更稳；再加 rerank 把「候选池」按查询-文档相关性重排。
//
// 两种融合：
//   1) 加权分数融合：需要把两路分数归一到同一量纲，alpha 难调；
//   2) RRF（Reciprocal Rank Fusion）：只看名次，score = Σ 1/(k + rank)，k 常取 60。
//      RRF 对分数尺度不敏感，工程上更稳，是默认推荐。

import { dot, l2Normalize } from './embeddings.js';

export interface RankedItem {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface RankedList {
  name: string;
  items: RankedItem[];
  weight?: number;
}

export interface FusedItem {
  id: string;
  score: number;
  /** 来源名 → 名次（1-based） */
  ranks: Record<string, number>;
  sources: string[];
}

// ---------------------------------------------------------------------------
// 分词：拉丁词 + CJK 单字/双字
//
// 中文没有空格，直接用整句做 BM25 会几乎不可用。这里用 unigram + bigram：
// - unigram 保召回（单字也能命中）
// - bigram 保精度（审批 vs 批审 不同）
// 生产环境可换 jieba / ICU / 模型 tokenizer，接口不变。
// ---------------------------------------------------------------------------

export function tokenize(text: string): string[] {
  const lower = (text ?? '').toLowerCase();
  const out: string[] = [];
  const re = /[a-z0-9_]+|[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower))) {
    const tok = m[0];
    if (/^[a-z0-9_]+$/.test(tok)) {
      if (tok.length >= 2 || /^\d+$/.test(tok)) out.push(tok);
      continue;
    }
    for (const ch of tok) out.push(ch);
    for (let i = 0; i + 1 < tok.length; i++) out.push(tok.slice(i, i + 2));
  }
  return out;
}

export interface Bm25Doc {
  id: string;
  text: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface Bm25Options {
  k1?: number;
  b?: number;
}

export interface Bm25SearchOptions {
  limit?: number;
  filter?: (metadata: Record<string, unknown>) => boolean;
}

/**
 * Okapi BM25。这里用倒排 postings 而不是每次全表扫描：
 * 查询词 → 只对包含该词的文档累加分数。
 */
export class Bm25Index {
  private readonly k1: number;
  private readonly b: number;
  private docs: { id: string; metadata?: Record<string, unknown>; length: number }[] = [];
  private postings = new Map<string, Map<number, number>>();
  private docFreq = new Map<string, number>();
  private totalLength = 0;

  constructor(opts: Bm25Options = {}) {
    this.k1 = opts.k1 ?? 1.5;
    this.b = opts.b ?? 0.75;
  }

  get size(): number {
    return this.docs.length;
  }

  add(docs: Bm25Doc[]): void {
    for (const d of docs) {
      const idx = this.docs.length;
      const tokens = tokenize(`${d.title ?? ''}\n${d.text}`);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const [t, n] of tf) {
        let p = this.postings.get(t);
        if (!p) {
          p = new Map();
          this.postings.set(t, p);
        }
        p.set(idx, n);
        this.docFreq.set(t, (this.docFreq.get(t) ?? 0) + 1);
      }
      this.docs.push({ id: d.id, metadata: d.metadata, length: tokens.length });
      this.totalLength += tokens.length;
    }
  }

  search(query: string, opts: Bm25SearchOptions = {}): RankedItem[] {
    const limit = Math.max(1, Math.min(1000, opts.limit ?? 20));
    if (!this.docs.length) return [];
    const terms = [...new Set(tokenize(query))];
    if (!terms.length) return [];
    const avgdl = this.totalLength / this.docs.length || 1;
    const scores = new Float64Array(this.docs.length);

    for (const term of terms) {
      const postings = this.postings.get(term);
      if (!postings) continue;
      const df = this.docFreq.get(term) ?? 0;
      const idf = Math.log(1 + (this.docs.length - df + 0.5) / (df + 0.5));
      for (const [docIdx, tf] of postings) {
        const dl = this.docs[docIdx].length || 1;
        const denom = tf + this.k1 * (1 - this.b + this.b * (dl / avgdl));
        scores[docIdx] += idf * ((tf * (this.k1 + 1)) / denom);
      }
    }

    const out: RankedItem[] = [];
    for (let i = 0; i < this.docs.length; i++) {
      if (scores[i] <= 0) continue;
      const d = this.docs[i];
      if (opts.filter && !opts.filter(d.metadata ?? {})) continue;
      out.push({ id: d.id, score: scores[i], metadata: d.metadata });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
  }

  stats(): { docs: number; terms: number; avgDocLength: number } {
    return {
      docs: this.docs.length,
      terms: this.postings.size,
      avgDocLength: this.totalLength / (this.docs.length || 1),
    };
  }
}

/**
 * Reciprocal Rank Fusion。
 * 第 i 路第 r 名（1-based）贡献 weight_i / (k + r)。
 * k=60 来自原论文经验值：压低头部名次差距，避免某一路“霸榜”。
 */
export function reciprocalRankFusion(lists: RankedList[], opts: { k?: number } = {}): FusedItem[] {
  const k = Math.max(1, opts.k ?? 60);
  const map = new Map<string, FusedItem>();
  for (const list of lists) {
    const weight = list.weight ?? 1;
    list.items.forEach((item, idx) => {
      const rank = idx + 1;
      let cur = map.get(item.id);
      if (!cur) {
        cur = { id: item.id, score: 0, ranks: {}, sources: [] };
        map.set(item.id, cur);
      }
      cur.score += weight / (k + rank);
      cur.ranks[list.name] = rank;
      if (!cur.sources.includes(list.name)) cur.sources.push(list.name);
    });
  }
  return [...map.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/**
 * 加权分数融合。每一路先 min-max 归一到 [0,1]，再 alpha * 向量 + (1-alpha) * 关键词。
 * 适合两路分数可比、且你有评测集调 alpha 的场景；否则优先 RRF。
 */
export function weightedScoreFusion(
  lists: RankedList[],
  opts: { alpha?: number } = {},
): FusedItem[] {
  const byName = new Map(lists.map((l) => [l.name, normalizeScores(l.items)]));
  const ids = new Set<string>();
  for (const l of lists) for (const item of l.items) ids.add(item.id);
  const out: FusedItem[] = [];
  for (const id of ids) {
    let score = 0;
    const ranks: Record<string, number> = {};
    const sources: string[] = [];
    for (const list of lists) {
      const normalized = byName.get(list.name)?.get(id);
      if (normalized === undefined) continue;
      const rank = list.items.findIndex((x) => x.id === id) + 1;
      if (rank > 0) ranks[list.name] = rank;
      sources.push(list.name);
      const w = list.name === 'vector' ? (opts.alpha ?? 0.5) : 1 - (opts.alpha ?? 0.5);
      score += w * normalized * (list.weight ?? 1);
    }
    out.push({ id, score, ranks, sources });
  }
  return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function normalizeScores(items: RankedItem[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!items.length) return out;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const it of items) {
    min = Math.min(min, it.score);
    max = Math.max(max, it.score);
  }
  const span = max - min;
  for (const it of items) out.set(it.id, span > 0 ? (it.score - min) / span : 1);
  return out;
}

// ---------------------------------------------------------------------------
// Rerank
// ---------------------------------------------------------------------------

export interface RerankCandidate {
  id: string;
  text: string;
  title?: string;
  heading?: string;
  metadata?: Record<string, unknown>;
  /** 融合阶段分数（0~1 最好），作为轻量先验 */
  priorScore?: number;
}

export interface RerankedCandidate extends RerankCandidate {
  rerankScore: number;
  rerankDetails: {
    coverage: number;
    bigram: number;
    phrase: number;
    title: number;
    prior: number;
  };
}

export interface Reranker {
  readonly name: string;
  rerank(query: string, candidates: RerankCandidate[], topN?: number): RerankedCandidate[];
}

/**
 * 词法 reranker：模拟 cross-encoder 的“查询-文档联合打分”，但完全离线。
 * 生产环境应替换为 bge-reranker-v2-m3 / Cohere Rerank / LLM rerank。
 *
 * 注意：它不是语义 reranker；对同义改写的提升有限，但对“关键词命中 + 精确短语”
 * 的排序通常比单路向量更稳。评测数字见 reports/RAG_EVAL.md。
 */
export class LexicalReranker implements Reranker {
  readonly name = 'lexical-coverage';

  rerank(query: string, candidates: RerankCandidate[], topN?: number): RerankedCandidate[] {
    const qTokens = [...new Set(tokenize(query))];
    const qSet = new Set(qTokens);
    const qBigrams = bigrams(qTokens);
    const qNorm = normalizeText(query);
    const scored: RerankedCandidate[] = candidates.map((c) => {
      const dTokens = tokenize(`${c.title ?? ''} ${c.heading ?? ''} ${c.text}`);
      const dSet = new Set(dTokens);
      let hit = 0;
      for (const t of qSet) if (dSet.has(t)) hit += 1;
      const coverage = qSet.size ? hit / qSet.size : 0;
      const dBigrams = bigrams(dTokens);
      let bh = 0;
      for (const b of qBigrams) if (dBigrams.has(b)) bh += 1;
      const bigramScore = qBigrams.size ? bh / qBigrams.size : 0;
      const phrase = qNorm.length >= 2 && normalizeText(c.text).includes(qNorm) ? 1 : 0;
      const titleTokens = new Set(tokenize(`${c.title ?? ''} ${c.heading ?? ''}`));
      let th = 0;
      for (const t of qSet) if (titleTokens.has(t)) th += 1;
      const titleScore = qSet.size ? th / qSet.size : 0;
      const prior = clamp01(c.priorScore ?? 0);
      const rerankScore =
        0.45 * coverage + 0.2 * bigramScore + 0.15 * phrase + 0.1 * titleScore + 0.1 * prior;
      return {
        ...c,
        rerankScore,
        rerankDetails: {
          coverage: round4(coverage),
          bigram: round4(bigramScore),
          phrase,
          title: round4(titleScore),
          prior: round4(prior),
        },
      };
    });
    scored.sort((a, b) => b.rerankScore - a.rerankScore || a.id.localeCompare(b.id));
    return topN ? scored.slice(0, topN) : scored;
  }
}

/** 把任意分数压到 [0,1]：余弦相似度本就在 [-1,1]，RRF 分数需要按最大值缩放。 */
export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function bigrams(tokens: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) {
    for (const ch of t) {
      if (/^[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]$/.test(ch)) {
        // CJK 单字 token 不产生 bigram；下面用相邻 token 组合
      }
    }
  }
  for (let i = 0; i + 1 < tokens.length; i++) out.add(`${tokens[i]}\u0000${tokens[i + 1]}`);
  return out;
}

function normalizeText(s: string): string {
  return (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
