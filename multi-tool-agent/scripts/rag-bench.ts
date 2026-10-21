// scripts/rag-bench.ts — RAG P0 评测：切块/索引/融合/rerank
//
// 运行：npm run rag:bench
// 产出：reports/RAG_EVAL.md（真实测量值）+ 控制台摘要
//
// 两个评测：
//   1) 检索质量：keyword / vector / RRF / RRF+rerank 的 Recall@5、MRR、nDCG@5；
//   2) 索引权衡：Flat vs HNSW(efSearch sweep) vs IVF(nprobe sweep) 的
//      recall@10（相对 Flat 精确结果）、中位延迟、距离计算次数、元数据过滤。
//
// 语料是本仓库的 AGENTS.md / README / docs / PROJECT_REPORT；标签用「唯一短语」
// 自动生成：包含该短语的 chunk 视为相关。这样不依赖人工标注，也可重复。

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkDocument, type Chunk } from '../src/knowledge/chunking.js';
import { createHashAsyncEmbedder } from '../src/knowledge/embeddings.js';
import { RagPipeline, type RagDoc, type RagSearchMode } from '../src/knowledge/ragPipeline.js';
import { FlatIndex, HnswIndex, IvfFlatIndex, type VectorIndex } from '../src/knowledge/vectorIndex.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..');
const REPO = resolve(PROJECT, '..');

interface EvalQuery {
  q: string;
  contains: string;
}

const QUERIES: EvalQuery[] = [
  { q: '写能力默认是否开启，部署时如何整机禁用', contains: 'CODEBASE_WRITE_ENABLED' },
  { q: '沙箱镜像如何构建', contains: 'build-image.mjs' },
  { q: '人工审批超时后按什么处理', contains: '超时按拒绝' },
  { q: 'SSE 心跳间隔如何配置', contains: 'STREAM_HEARTBEAT_MS' },
  { q: '工具并发上限由哪个参数控制', contains: 'MAX_TOOL_CONCURRENCY' },
  { q: 'FTS5 不可用时检索如何降级', contains: 'LIKE' },
  { q: '单 run 报告怎么生成', contains: 'report:run' },
  { q: 'DeepSeek 真实模型实测平均成本是多少', contains: '0.574' },
  { q: 'search_files 的三个静默陷阱', contains: 'search_files' },
  { q: 'Docker 代理拉取失败怎么排查', contains: '127.0.0.1:7890' },
  { q: '子任务 limit_reached 为什么要单独统计', contains: 'limit_reached' },
  { q: '流式输出 tool_call 首帧如何提前渲染', contains: 'tool_call' },
  { q: '知识库语义召回不可用时怎么降级', contains: 'sqlite-vec' },
  { q: '工作区路径越界如何防护', contains: 'workspacePath' },
  { q: '错误报告 JSONL 落在哪里', contains: 'errors.log' },
  { q: '审批粘性 allow_file 是什么意思', contains: 'allow_file' },
  { q: '并行 vs 串行成本 A/B 的结论', contains: '1.56M' },
  { q: '测试必须用哪个 Node 版本', contains: 'Node v24' },
];

async function main(): Promise<void> {
  const docs = loadDocs();
  const embedder = createHashAsyncEmbedder(256);
  const chunks: Chunk[] = docs.flatMap((d) => chunkDocument(d, { chunkSize: 512, overlap: 64 }));
  const vectors = await embedder.embed(chunks.map((c) => c.embedText));
  const records = chunks.map((c, i) => ({ id: c.id, vector: vectors[i], metadata: c.metadata }));
  const activeQueries = QUERIES.filter((q) => {
    const hit = chunks.some((c) => normalize(c.text).includes(normalize(q.contains)));
    if (!hit) console.warn(`[rag-bench] 跳过无标签查询（语料中找不到短语）：${q.contains}`);
    return hit;
  });
  const qVecs = await embedder.embed(activeQueries.map((q) => q.q));

  const quality = await evalQuality(docs, activeQueries, chunks);
  const index = evalIndexes(records, qVecs);
  const filtering = evalFiltering(records, qVecs);
  const report = renderReport({ docs, chunks, activeQueries, quality, index, filtering });
  const out = join(PROJECT, 'reports', 'RAG_EVAL.md');
  writeFileSync(out, report.replace(/\r?\n/g, '\r\n'), 'utf8');
  console.log(`[rag-bench] 已写入 ${relative(REPO, out)} (${activeQueries.length} queries / ${chunks.length} chunks)`);
  console.log(qualityTable(quality));
  console.log(indexTable(index));
  console.log(filterTable(filtering));
}

function loadDocs(): RagDoc[] {
  const files: string[] = [];
  const push = (p: string) => {
    if (existsSync(p)) files.push(p);
  };
  push(join(REPO, 'AGENTS.md'));
  push(join(PROJECT, 'README.md'));
  push(join(PROJECT, '.env.example'));
  push(join(PROJECT, 'reports', 'PROJECT_REPORT.md'));
  const docsDir = join(PROJECT, 'docs');
  if (existsSync(docsDir)) {
    for (const f of readdirSync(docsDir)) if (f.endsWith('.md')) push(join(docsDir, f));
  }
  return files.map((f) => {
    const id = relative(REPO, f).split(sep).join('/');
    return {
      id,
      title: id,
      text: readFileSync(f, 'utf8'),
      metadata: { collection: id.startsWith('docs/') || id.includes('/docs/') ? 'docs' : 'project' },
    };
  });
}

interface QualityRow {
  mode: RagSearchMode;
  recallAt5: number;
  mrr: number;
  ndcgAt5: number;
  avgLatencyMs: number;
  hits: number;
}

async function evalQuality(docs: RagDoc[], queries: EvalQuery[], chunks: Chunk[]): Promise<QualityRow[]> {
  const pipeline = await RagPipeline.build(docs, {
    chunk: { chunkSize: 512, overlap: 64 },
    embedder: createHashAsyncEmbedder(256),
    indexKind: 'flat',
  });
  const modes: RagSearchMode[] = ['keyword', 'vector', 'hybrid', 'hybrid_rerank'];
  const rows: QualityRow[] = [];
  for (const mode of modes) {
    let recall = 0;
    let mrr = 0;
    let ndcg = 0;
    let latency = 0;
    for (const q of queries) {
      const relevant = new Set(
        chunks.filter((c) => normalize(c.text).includes(normalize(q.contains))).map((c) => c.id),
      );
      const res = await pipeline.search(q.q, { mode, k: 5 });
      const ids = res.results.map((r) => r.id);
      recall += ids.some((id) => relevant.has(id)) ? 1 : 0;
      const first = ids.findIndex((id) => relevant.has(id));
      mrr += first >= 0 ? 1 / (first + 1) : 0;
      ndcg += ndcgAt(ids, relevant, 5);
      latency += res.latencyMs;
    }
    rows.push({
      mode,
      recallAt5: recall / queries.length,
      mrr: mrr / queries.length,
      ndcgAt5: ndcg / queries.length,
      avgLatencyMs: latency / queries.length,
      hits: queries.length,
    });
  }
  return rows;
}

interface IndexRow {
  name: string;
  recallAt10: number;
  medianLatencyMs: number;
  distanceComputations: number;
  params: string;
}

function evalIndexes(
  records: { id: string; vector: Float32Array; metadata?: Record<string, unknown> }[],
  qVecs: Float32Array[],
): IndexRow[] {
  const flat = new FlatIndex();
  flat.add(records);
  const truth = qVecs.map((qv) => flat.search(qv, { k: 10 }).map((r) => r.id));
  const rows: IndexRow[] = [];

  const measure = (name: string, make: () => VectorIndex, opts: { efSearch?: number; nprobe?: number }, params: string) => {
    const idx = make();
    idx.add(records);
    let recall = 0;
    const latencies: number[] = [];
    for (let qi = 0; qi < qVecs.length; qi++) {
      const t = process.hrtime.bigint();
      const got = idx.search(qVecs[qi], { k: 10, efSearch: opts.efSearch, nprobe: opts.nprobe }).map((r) => r.id);
      latencies.push(Number(process.hrtime.bigint() - t) / 1e6);
      const truthSet = new Set(truth[qi]);
      recall += got.filter((id) => truthSet.has(id)).length / Math.max(1, truthSet.size);
    }
    rows.push({
      name,
      recallAt10: recall / qVecs.length,
      medianLatencyMs: median(latencies),
      distanceComputations: idx.stats().distanceComputations,
      params,
    });
  };

  measure('flat (exact)', () => new FlatIndex(), {}, '—');
  for (const ef of [16, 32, 64, 128]) {
    measure(`hnsw efSearch=${ef}`, () => new HnswIndex({ M: 16, efConstruction: 200, efSearch: ef }), { efSearch: ef }, `M=16, efC=200`);
  }
  for (const np of [1, 2, 4, 8, 16]) {
    measure(`ivf nprobe=${np}`, () => new IvfFlatIndex({ nlist: 20, nprobe: np }), { nprobe: np }, 'nlist=20');
  }
  return rows;
}

interface FilterRow {
  name: string;
  recallAt10: number;
  medianLatencyMs: number;
}

function evalFiltering(
  records: { id: string; vector: Float32Array; metadata?: Record<string, unknown> }[],
  qVecs: Float32Array[],
): FilterRow[] {
  const filter = (m: Record<string, unknown>) => m.collection === 'docs';
  const flat = new FlatIndex();
  flat.add(records);
  const truth = qVecs.map((qv) => flat.search(qv, { k: 10, filter }).map((r) => r.id));
  const rows: FilterRow[] = [];
  const measure = (name: string, idx: VectorIndex, opts: { efSearch?: number; nprobe?: number }) => {
    let recall = 0;
    const lat: number[] = [];
    for (let i = 0; i < qVecs.length; i++) {
      const t = process.hrtime.bigint();
      const got = idx.search(qVecs[i], { k: 10, filter, efSearch: opts.efSearch, nprobe: opts.nprobe }).map((r) => r.id);
      lat.push(Number(process.hrtime.bigint() - t) / 1e6);
      const truthSet = new Set(truth[i]);
      recall += got.filter((id) => truthSet.has(id)).length / Math.max(1, truthSet.size);
    }
    rows.push({ name, recallAt10: recall / qVecs.length, medianLatencyMs: median(lat) });
  };
  measure('flat + filter', flat, {});
  const hnsw = new HnswIndex({ M: 16, efConstruction: 200, efSearch: 64 });
  hnsw.add(records);
  measure('hnsw ef=64 + filter', hnsw, { efSearch: 64 });
  const ivf = new IvfFlatIndex({ nlist: 20, nprobe: 8 });
  ivf.add(records);
  measure('ivf probe=8 + filter', ivf, { nprobe: 8 });
  return rows;
}

function renderReport(x: {
  docs: RagDoc[];
  chunks: Chunk[];
  activeQueries: EvalQuery[];
  quality: QualityRow[];
  index: IndexRow[];
  filtering: FilterRow[];
}): string {
  const date = new Date().toISOString().slice(0, 10);
  const L: string[] = [];
  L.push('# RAG P0 评测（切块 / 索引 / 混合检索 / Rerank）');
  L.push('');
  L.push(`> 生成时间：${date}；命令：\`npm run rag:bench\`；生成物请重跑命令，不要手改数字。`);
  L.push('');
  L.push('## 1. 口径与环境');
  L.push('');
  L.push(`- 语料：本仓库 AGENTS.md、multi-tool-agent/README.md、.env.example、docs/*.md、PROJECT_REPORT.md，共 **${x.docs.length}** 个文档。`);
  L.push(`- 切块：512 tokens / 64 overlap（\`src/knowledge/chunking.ts\` 默认），共 **${x.chunks.length}** 个 chunk。`);
  L.push('- Embedding：`hash-ngram-256`（离线、确定性、256 维、L2 归一化）。**它是词法哈希，不是语义模型**；本表衡量的是管线机制，不代表 bge/OpenAI embedding 的真实语义上限。');
  L.push(`- 评测查询：${x.activeQueries.length} 条；相关 chunk = 文本包含指定唯一短语（自动标注，可复现）。`);
  L.push('- 指标：Recall@5（top-5 是否命中任一相关块）、MRR（首个相关块名次倒数）、nDCG@5（二元相关性）。');
  L.push('');
  L.push('## 2. 混合检索与 Rerank');
  L.push('');
  L.push(qualityTable(x.quality));
  L.push('');
  L.push('**读法**：RRF 对两路分数尺度不敏感，通常比单路更稳；`hybrid_rerank` 在候选池上做词法联合打分。若 rerank 相对 RRF 没有提升，说明语料/查询以精确词命中为主，或 reranker 太弱（生产应换 bge-reranker / Cohere / LLM rerank）。');
  L.push('');
  L.push('## 3. 向量索引：Flat vs HNSW vs IVF');
  L.push('');
  L.push(indexTable(x.index));
  L.push('');
  L.push('**读法**：`flat` 是精确基线（O(N)）；HNSW 的 `efSearch` 与 IVF 的 `nprobe` 是运行时召回/延迟旋钮。`distanceComputations` 只统计向量距离计算（不含图遍历/堆操作），用于解释“为什么快/为什么召回掉”。');
  L.push('');
  L.push('## 4. 元数据过滤（post-filter）');
  L.push('');
  L.push(filterTable(x.filtering));
  L.push('');
  L.push('**读法**：这里故意用 `collection=docs` 做高选择性过滤。HNSW/IVF 先找候选再过滤，候选被过滤掉后可能不足 k → 召回下降。生产上高选择性过滤应做 **pre-filter**（分区/倒排/租户隔离），或把过滤条件下推到索引。');
  L.push('');
  L.push('## 5. 查询与标签');
  L.push('');
  L.push('| # | 查询 | 相关短语 |');
  L.push('|---|---|---|');
  x.activeQueries.forEach((q, i) => L.push(`| ${i + 1} | ${escapeCell(q.q)} | \`${escapeCell(q.contains)}\` |`));
  L.push('');
  L.push('## 6. 边界与下一步');
  L.push('');
  L.push('- 离线 hash embedding 无法验证“同义改写”的语义收益；接真实模型后（`OpenAICompatibleEmbedder` / BGE）应重跑本表。');
  L.push('- 当前 HNSW 是教学用简化实现（单层束搜索 + 最近邻剪枝），未做启发式邻居选择/删除；生产用 Qdrant/Milvus/pgvector。');
  L.push('- 元数据过滤目前是 post-filter；下一步做 pre-filter 分区，并测 10 万级语料。');
  L.push('- rerank 目前是词法 cross-encoder 替身；接真实 reranker 后看 Recall@5 / nDCG@5 的增量与延迟成本。');
  L.push('');
  return L.join('\n');
}

function qualityTable(rows: QualityRow[]): string {
  const L = ['| 模式 | Recall@5 | MRR | nDCG@5 | 平均延迟 |', '|---|---:|---:|---:|---:|'];
  for (const r of rows) {
    L.push(`| ${r.mode} | ${pct(r.recallAt5)} | ${r.mrr.toFixed(3)} | ${r.ndcgAt5.toFixed(3)} | ${r.avgLatencyMs.toFixed(2)}ms |`);
  }
  return L.join('\n');
}

function indexTable(rows: IndexRow[]): string {
  const L = ['| 索引 | Recall@10（相对 Flat） | 中位延迟 | 距离计算次数 | 参数 |', '|---|---:|---:|---:|---|'];
  for (const r of rows) {
    L.push(`| ${r.name} | ${pct(r.recallAt10)} | ${r.medianLatencyMs.toFixed(3)}ms | ${r.distanceComputations} | ${r.params} |`);
  }
  return L.join('\n');
}

function filterTable(rows: FilterRow[]): string {
  const L = ['| 索引 | 过滤后 Recall@10 | 中位延迟 |', '|---|---:|---:|'];
  for (const r of rows) L.push(`| ${r.name} | ${pct(r.recallAt10)} | ${r.medianLatencyMs.toFixed(3)}ms |`);
  return L.join('\n');
}

function ndcgAt(ids: string[], relevant: Set<string>, k: number): number {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, ids.length); i++) {
    if (relevant.has(ids[i])) dcg += 1 / Math.log2(i + 2);
  }
  let idcg = 0;
  for (let i = 0; i < Math.min(k, relevant.size); i++) idcg += 1 / Math.log2(i + 2);
  return idcg > 0 ? dcg / idcg : 0;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
