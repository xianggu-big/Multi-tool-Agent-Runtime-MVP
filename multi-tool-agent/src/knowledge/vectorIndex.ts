// src/knowledge/vectorIndex.ts — 内存向量索引（Flat / HNSW / IVF-Flat）
//
// 为什么自己实现：本项目是教学/演示型 MVP，需要把「HNSW vs IVF」的取舍做实、
// 可测、可量化，而不是只写一句“用 HNSW”。生产环境可直接换 Qdrant/Milvus/pgvector，
// 接口保持一致即可。
//
// 约定：所有向量在入索引时做 L2 归一化，因此余弦相似度 = 点积，score 越大越相似。
// 元数据过滤：统一用 predicate。HNSW/IVF 都是「先按图/簇找候选，再过滤」，
// 过滤选择性很高时召回会下降 —— 这正是 pre-filter 与 post-filter 的核心差异。

import { dot, l2Normalize } from './embeddings.js';

export type VectorMetadata = Record<string, unknown>;
export type MetadataFilter = (metadata: VectorMetadata) => boolean;

export interface VectorRecord {
  id: string;
  vector: Float32Array;
  metadata?: VectorMetadata;
}

export interface VectorSearchOptions {
  k: number;
  /** 元数据过滤（post-filter；高选择性场景见 docs/RAG_AND_AGENT_STACK.md） */
  filter?: MetadataFilter;
  /** HNSW 查询候选数；越大召回越高、延迟越高 */
  efSearch?: number;
  /** IVF 探测簇数；越大召回越高、延迟越高 */
  nprobe?: number;
}

export interface VectorSearchResult {
  id: string;
  score: number;
  metadata?: VectorMetadata;
}

export interface VectorIndexStats {
  kind: 'flat' | 'hnsw' | 'ivf';
  size: number;
  dim: number;
  distanceComputations: number;
  params: Record<string, number>;
}

export interface VectorIndex {
  readonly kind: 'flat' | 'hnsw' | 'ivf';
  readonly size: number;
  add(records: VectorRecord[]): void;
  /** 删除若干 id，返回实际删除数；不存在/已删的 id 忽略。 */
  remove(ids: string[]): number;
  search(query: Float32Array, opts: VectorSearchOptions): VectorSearchResult[];
  stats(): VectorIndexStats;
}

// ---------------------------------------------------------------------------
// Flat：精确基线（O(N)），用于衡量近似索引的 recall 与加速比
// ---------------------------------------------------------------------------

export class FlatIndex implements VectorIndex {
  readonly kind = 'flat' as const;
  private records: { id: string; vector: Float32Array; metadata?: VectorMetadata }[] = [];
  private dim = 0;
  private distanceComputations = 0;

  get size(): number {
    return this.records.length;
  }

  add(records: VectorRecord[]): void {
    for (const r of records) {
      const v = l2Normalize(Float32Array.from(r.vector));
      if (!this.dim) this.dim = v.length;
      if (v.length !== this.dim) throw new Error(`FlatIndex 维度不一致：${v.length} vs ${this.dim}`);
      this.records.push({ id: r.id, vector: v, metadata: r.metadata });
    }
  }

  remove(ids: string[]): number {
    const drop = new Set(ids);
    const before = this.records.length;
    this.records = this.records.filter((r) => !drop.has(r.id));
    return before - this.records.length;
  }

  search(query: Float32Array, opts: VectorSearchOptions): VectorSearchResult[] {
    // 空索引没有维度可校验：直接返回空，避免「删空知识库后查询」抛维度错误。
    if (!this.records.length) return [];
    const q = l2Normalize(Float32Array.from(query));
    if (q.length !== this.dim) throw new Error(`FlatIndex 查询维度不一致：${q.length} vs ${this.dim}`);
    const k = clampK(opts.k);
    const out: VectorSearchResult[] = [];
    for (const r of this.records) {
      if (opts.filter && !opts.filter(r.metadata ?? {})) continue;
      this.distanceComputations += 1;
      out.push({ id: r.id, score: dot(q, r.vector), metadata: r.metadata });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, k);
  }

  stats(): VectorIndexStats {
    return {
      kind: this.kind,
      size: this.records.length,
      dim: this.dim,
      distanceComputations: this.distanceComputations,
      params: {},
    };
  }
}

// ---------------------------------------------------------------------------
// HNSW：分层可导航小世界图
//
// 直觉：上层是“高速公路”（长边、少节点），下层是“城市道路”（短边、全节点）。
// 查询从最高层贪心下降，到第 0 层再用 efSearch 做束搜索。
// - M：每个节点每层最多保留的邻居数（越大召回越高、内存越大）
// - efConstruction：建图时候选池大小（越大图质量越好、构建越慢）
// - efSearch：查询时候选池大小（运行时旋钮：召回/延迟权衡）
// ---------------------------------------------------------------------------

export interface HnswOptions {
  M?: number;
  efConstruction?: number;
  efSearch?: number;
  seed?: number;
  maxLevel?: number;
}

interface HnswNode {
  id: string;
  vector: Float32Array;
  metadata?: VectorMetadata;
  level: number;
  neighbors: number[][];
}

export class HnswIndex implements VectorIndex {
  readonly kind = 'hnsw' as const;
  private readonly M: number;
  private readonly efConstruction: number;
  private readonly defaultEfSearch: number;
  private readonly maxLevelCap: number;
  private readonly mL: number;
  private readonly rng: () => number;
  private nodes: HnswNode[] = [];
  private byId = new Map<string, number>();
  /** 墓碑：删除只标记，不重建图（生产实现也常用 tombstone + compaction）。 */
  private tombstones = new Set<number>();
  private entry = -1;
  private topLevel = -1;
  private dim = 0;
  private distanceComputations = 0;

  constructor(opts: HnswOptions = {}) {
    this.M = clampInt(opts.M ?? 16, 4, 64);
    this.efConstruction = clampInt(opts.efConstruction ?? 200, this.M, 2000);
    this.defaultEfSearch = clampInt(opts.efSearch ?? 64, 1, 2000);
    this.maxLevelCap = clampInt(opts.maxLevel ?? 16, 0, 32);
    this.mL = 1 / Math.log(this.M);
    this.rng = mulberry32(opts.seed ?? 42);
  }

  get size(): number {
    return this.nodes.length - this.tombstones.size;
  }

  add(records: VectorRecord[]): void {
    for (const r of records) {
      // upsert：同 id 先打墓碑再插入新节点；旧节点仍参与图遍历，但不返回。
      if (this.byId.has(r.id)) this.remove([r.id]);
      this.insert(r);
    }
  }

  remove(ids: string[]): number {
    let removed = 0;
    for (const id of ids) {
      const idx = this.byId.get(id);
      if (idx === undefined || this.tombstones.has(idx)) continue;
      this.tombstones.add(idx);
      this.byId.delete(id);
      removed += 1;
    }
    return removed;
  }

  search(query: Float32Array, opts: VectorSearchOptions): VectorSearchResult[] {
    if (!this.nodes.length || this.tombstones.size >= this.nodes.length) return [];
    const q = l2Normalize(Float32Array.from(query));
    if (q.length !== this.dim) throw new Error(`HnswIndex 查询维度不一致：${q.length} vs ${this.dim}`);
    const k = clampK(opts.k);
    let ef = Math.max(k, opts.efSearch ?? this.defaultEfSearch);
    let results: { idx: number; dist: number }[] = [];
    const live = (idx: number) => !this.tombstones.has(idx);

    // 过滤是 post-filter：先按图找候选，再剔除不满足元数据/已删除的点。
    // 若过滤后不足 k，扩大 ef 重试（最多 5 次），仍不足则如实返回少量结果。
    for (let attempt = 0; attempt < 5; attempt++) {
      results = this.searchLayer(q, [this.entry], Math.max(ef, k), 0);
      const usable = results.filter(
        (r) => live(r.idx) && (!opts.filter || opts.filter(this.nodes[r.idx].metadata ?? {})),
      ).length;
      if (usable >= k || (!opts.filter && !this.tombstones.size)) break;
      ef *= 2;
      if (ef > 4096) break;
    }
    const filtered = results.filter(
      (r) => live(r.idx) && (!opts.filter || opts.filter(this.nodes[r.idx].metadata ?? {})),
    );
    return filtered.slice(0, k).map((r) => ({
      id: this.nodes[r.idx].id,
      score: 1 - r.dist,
      metadata: this.nodes[r.idx].metadata,
    }));
  }

  stats(): VectorIndexStats {
    return {
      kind: this.kind,
      size: this.size,
      dim: this.dim,
      distanceComputations: this.distanceComputations,
      params: {
        M: this.M,
        efConstruction: this.efConstruction,
        efSearch: this.defaultEfSearch,
        topLevel: this.topLevel,
        tombstones: this.tombstones.size,
      },
    };
  }

  private insert(record: VectorRecord): void {
    if (this.byId.has(record.id)) throw new Error(`HnswIndex 重复 id: ${record.id}`);
    const v = l2Normalize(Float32Array.from(record.vector));
    if (!this.dim) this.dim = v.length;
    if (v.length !== this.dim) throw new Error(`HnswIndex 维度不一致：${v.length} vs ${this.dim}`);

    const level = this.randomLevel();
    const idx = this.nodes.length;
    const node: HnswNode = {
      id: record.id,
      vector: v,
      metadata: record.metadata,
      level,
      neighbors: Array.from({ length: level + 1 }, () => [] as number[]),
    };
    this.nodes.push(node);
    this.byId.set(record.id, idx);

    if (this.entry === -1) {
      this.entry = idx;
      this.topLevel = level;
      return;
    }

    let ep = this.entry;
    for (let l = this.topLevel; l > level; l--) {
      ep = this.greedy(v, ep, l);
    }
    for (let l = Math.min(level, this.topLevel); l >= 0; l--) {
      const candidates = this.searchLayer(v, [ep], this.efConstruction, l);
      const selected = candidates.slice(0, this.M).map((c) => c.idx);
      node.neighbors[l] = selected;
      for (const n of selected) {
        const nb = this.nodes[n];
        if (!nb.neighbors[l]) nb.neighbors[l] = [];
        nb.neighbors[l].push(idx);
        if (nb.neighbors[l].length > this.M) nb.neighbors[l] = this.prune(nb, l);
      }
      if (candidates.length) ep = candidates[0].idx;
    }
    if (level > this.topLevel) {
      this.topLevel = level;
      this.entry = idx;
    }
  }

  private randomLevel(): number {
    const u = Math.max(1e-12, this.rng());
    const lvl = Math.floor(-Math.log(u) * this.mL);
    return Math.min(this.maxLevelCap, Math.max(0, lvl));
  }

  private greedy(q: Float32Array, start: number, layer: number): number {
    let cur = start;
    let curDist = this.distance(q, this.nodes[cur].vector);
    let changed = true;
    while (changed) {
      changed = false;
      const neighbors = this.nodes[cur].neighbors[layer] ?? [];
      for (const n of neighbors) {
        const d = this.distance(q, this.nodes[n].vector);
        if (d < curDist) {
          cur = n;
          curDist = d;
          changed = true;
        }
      }
    }
    return cur;
  }

  /** 第 0 层（或指定层）的束搜索：返回按距离升序的候选。 */
  private searchLayer(q: Float32Array, entryPoints: number[], ef: number, layer: number): { idx: number; dist: number }[] {
    const visited = new Set<number>(entryPoints);
    const candidates = entryPoints
      .map((idx) => ({ idx, dist: this.distance(q, this.nodes[idx].vector) }))
      .sort(byDist);
    let results = [...candidates];

    while (candidates.length) {
      const c = candidates.shift()!;
      const worst = results.length ? results[results.length - 1].dist : Number.POSITIVE_INFINITY;
      if (results.length >= ef && c.dist > worst) break;
      const neighbors = this.nodes[c.idx].neighbors[layer] ?? [];
      for (const n of neighbors) {
        if (visited.has(n)) continue;
        visited.add(n);
        const d = this.distance(q, this.nodes[n].vector);
        if (results.length < ef || d < results[results.length - 1].dist) {
          candidates.push({ idx: n, dist: d });
          candidates.sort(byDist);
          results.push({ idx: n, dist: d });
          results.sort(byDist);
          if (results.length > ef) results.pop();
        }
      }
    }
    return results;
  }

  private prune(node: HnswNode, layer: number): number[] {
    return node.neighbors[layer]
      .map((idx) => ({ idx, dist: this.distance(node.vector, this.nodes[idx].vector) }))
      .sort(byDist)
      .slice(0, this.M)
      .map((x) => x.idx);
  }

  private distance(a: Float32Array, b: Float32Array): number {
    this.distanceComputations += 1;
    return 1 - dot(a, b);
  }
}

// ---------------------------------------------------------------------------
// IVF-Flat：倒排文件 + 平坦量化
//
// 先 k-means 把向量分到 nlist 个簇；查询只扫描最近的 nprobe 个簇。
// - nlist：簇数（常用 sqrt(N) ~ 4*sqrt(N)）
// - nprobe：探测簇数（运行时旋钮：越大召回越高、延迟越高）
// 对比 HNSW：IVF 构建/内存更简单，但边界点可能被分错簇 → 召回依赖 nprobe。
// ---------------------------------------------------------------------------

export interface IvfOptions {
  nlist?: number;
  nprobe?: number;
  iterations?: number;
  seed?: number;
}

export class IvfFlatIndex implements VectorIndex {
  readonly kind = 'ivf' as const;
  private readonly nlistOpt: number;
  private readonly defaultNprobe: number;
  private readonly iterations: number;
  private readonly rng: () => number;
  private records: { id: string; vector: Float32Array; metadata?: VectorMetadata }[] = [];
  private byId = new Map<string, number>();
  private centroids: Float32Array[] = [];
  private lists: number[][] = [];
  private tombstones = new Set<number>();
  private builtSize = 0;
  private dirty = true;
  private rebuilds = 0;
  private dim = 0;
  private distanceComputations = 0;

  constructor(opts: IvfOptions = {}) {
    this.nlistOpt = clampInt(opts.nlist ?? 0, 0, 65_536);
    this.defaultNprobe = clampInt(opts.nprobe ?? 8, 1, 4096);
    this.iterations = clampInt(opts.iterations ?? 12, 1, 100);
    this.rng = mulberry32(opts.seed ?? 42);
  }

  get size(): number {
    return this.records.length - this.tombstones.size;
  }

  add(records: VectorRecord[]): void {
    for (const r of records) {
      const v = l2Normalize(Float32Array.from(r.vector));
      if (!this.dim) this.dim = v.length;
      if (v.length !== this.dim) throw new Error(`IvfFlatIndex 维度不一致：${v.length} vs ${this.dim}`);
      if (this.byId.has(r.id)) this.remove([r.id]);
      const idx = this.records.length;
      this.records.push({ id: r.id, vector: v, metadata: r.metadata });
      this.byId.set(r.id, idx);
      if (this.centroids.length) {
        // 已训练：增量分配到最近簇，不触发全量重训。
        this.lists[this.nearestCentroid(v)].push(idx);
      } else {
        this.dirty = true;
      }
    }
    // 数据量翻倍时再重训，避免每次 add 都 O(N·nlist·迭代) 重建。
    if (this.centroids.length && this.records.length >= Math.max(1, this.builtSize * 2)) {
      this.dirty = true;
    }
    if (!this.centroids.length) this.ensureBuilt();
  }

  remove(ids: string[]): number {
    let removed = 0;
    for (const id of ids) {
      const idx = this.byId.get(id);
      if (idx === undefined || this.tombstones.has(idx)) continue;
      this.tombstones.add(idx);
      this.byId.delete(id);
      removed += 1;
    }
    return removed;
  }

  search(query: Float32Array, opts: VectorSearchOptions): VectorSearchResult[] {
    if (!this.records.length) return [];
    this.ensureBuilt();
    if (!this.centroids.length) return [];
    const q = l2Normalize(Float32Array.from(query));
    if (q.length !== this.dim) throw new Error(`IvfFlatIndex 查询维度不一致：${q.length} vs ${this.dim}`);
    const k = clampK(opts.k);
    const nprobe = Math.max(1, Math.min(this.centroids.length, opts.nprobe ?? this.defaultNprobe));
    const probe = this.centroids
      .map((c, idx) => {
        this.distanceComputations += 1;
        return { idx, score: dot(q, c) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, nprobe);

    const out: VectorSearchResult[] = [];
    const seen = new Set<number>();
    for (const p of probe) {
      for (const i of this.lists[p.idx] ?? []) {
        if (seen.has(i) || this.tombstones.has(i)) continue;
        seen.add(i);
        const r = this.records[i];
        if (opts.filter && !opts.filter(r.metadata ?? {})) continue;
        this.distanceComputations += 1;
        out.push({ id: r.id, score: dot(q, r.vector), metadata: r.metadata });
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, k);
  }

  stats(): VectorIndexStats {
    return {
      kind: this.kind,
      size: this.size,
      dim: this.dim,
      distanceComputations: this.distanceComputations,
      params: {
        nlist: this.centroids.length,
        nprobe: this.defaultNprobe,
        tombstones: this.tombstones.size,
        rebuilds: this.rebuilds,
      },
    };
  }

  private ensureBuilt(): void {
    if (this.dirty || (!this.centroids.length && this.records.length)) this.build();
  }

  /** 物理清掉墓碑并重建 id→下标；只在重训时做，查询路径只跳过墓碑。 */
  private compact(): void {
    if (!this.tombstones.size) return;
    const keep: { id: string; vector: Float32Array; metadata?: VectorMetadata }[] = [];
    this.byId.clear();
    for (let i = 0; i < this.records.length; i++) {
      if (this.tombstones.has(i)) continue;
      this.byId.set(this.records[i].id, keep.length);
      keep.push(this.records[i]);
    }
    this.records = keep;
    this.tombstones.clear();
  }

  private build(): void {
    this.compact();
    const n = this.records.length;
    if (!n) {
      this.centroids = [];
      this.lists = [];
      this.builtSize = 0;
      this.dirty = false;
      return;
    }
    const nlist = Math.max(1, Math.min(n, this.nlistOpt || Math.round(Math.sqrt(n))));
    this.centroids = this.kmeansPlusPlus(nlist);
    this.lists = Array.from({ length: nlist }, () => [] as number[]);
    for (let iter = 0; iter < this.iterations; iter++) {
      const sums = Array.from({ length: nlist }, () => new Float32Array(this.dim));
      const counts = new Array<number>(nlist).fill(0);
      this.lists = Array.from({ length: nlist }, () => [] as number[]);
      for (let i = 0; i < n; i++) {
        const c = this.nearestCentroid(this.records[i].vector);
        this.lists[c].push(i);
        counts[c] += 1;
        for (let d = 0; d < this.dim; d++) sums[c][d] += this.records[i].vector[d];
      }
      for (let c = 0; c < nlist; c++) {
        if (counts[c] === 0) {
          // 空簇：用随机点重置，避免死簇
          const pick = Math.floor(this.rng() * n);
          this.centroids[c] = Float32Array.from(this.records[pick].vector);
        } else {
          for (let d = 0; d < this.dim; d++) sums[c][d] /= counts[c];
          this.centroids[c] = l2Normalize(sums[c]);
        }
      }
    }
    // 最终分配
    this.lists = Array.from({ length: nlist }, () => [] as number[]);
    for (let i = 0; i < n; i++) this.lists[this.nearestCentroid(this.records[i].vector)].push(i);
    this.builtSize = n;
    this.dirty = false;
    this.rebuilds += 1;
  }

  private kmeansPlusPlus(k: number): Float32Array[] {
    const n = this.records.length;
    const chosen: Float32Array[] = [Float32Array.from(this.records[Math.floor(this.rng() * n)].vector)];
    const minDist = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
    while (chosen.length < k) {
      const last = chosen[chosen.length - 1];
      let total = 0;
      for (let i = 0; i < n; i++) {
        const d = Math.max(0, 1 - dot(last, this.records[i].vector));
        if (d < minDist[i]) minDist[i] = d;
        total += minDist[i] * minDist[i];
      }
      let target = this.rng() * total;
      let pick = n - 1;
      for (let i = 0; i < n; i++) {
        target -= minDist[i] * minDist[i];
        if (target <= 0) {
          pick = i;
          break;
        }
      }
      chosen.push(Float32Array.from(this.records[pick].vector));
    }
    return chosen;
  }

  private nearestCentroid(v: Float32Array): number {
    let best = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let c = 0; c < this.centroids.length; c++) {
      this.distanceComputations += 1;
      const s = dot(v, this.centroids[c]);
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }
    return best;
  }
}

export type VectorIndexKind = 'flat' | 'hnsw' | 'ivf';

export function createVectorIndex(
  kind: VectorIndexKind,
  opts: { hnsw?: HnswOptions; ivf?: IvfOptions } = {},
): VectorIndex {
  if (kind === 'flat') return new FlatIndex();
  if (kind === 'hnsw') return new HnswIndex(opts.hnsw);
  return new IvfFlatIndex(opts.ivf);
}

function byDist(a: { dist: number }, b: { dist: number }): number {
  return a.dist - b.dist;
}

function clampK(k: number): number {
  return Math.max(1, Math.min(10_000, Math.floor(k || 1)));
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.floor(v)));
}

/** 纯函数 PRNG：保证建图/聚类可复现。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
