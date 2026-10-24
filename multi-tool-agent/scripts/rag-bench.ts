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
import { dirname, basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/env.js';
import { chunkDocument, type Chunk } from '../src/knowledge/chunking.js';
import { createConfiguredEmbedder, createHashAsyncEmbedder, type AsyncEmbedder } from '../src/knowledge/embeddings.js';
import { RagPipeline, type RagDoc, type RagSearchMode } from '../src/knowledge/ragPipeline.js';
import { HttpReranker } from '../src/knowledge/httpReranker.js';
import type { Reranker } from '../src/knowledge/hybrid.js';
import { FlatIndex, HnswIndex, IvfFlatIndex, type VectorIndex } from '../src/knowledge/vectorIndex.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..');
const REPO = resolve(PROJECT, '..');
// 评测语料冻结：存在 eval/rag-corpus 就用那份快照，否则退回当前仓库文件（数字会随文档增改漂移）
const CORPUS_ROOT = join(PROJECT, 'eval', 'rag-corpus');
const CORPUS_FROZEN = existsSync(join(CORPUS_ROOT, 'AGENTS.md'));

interface EvalQuery {
  q: string;
  contains: string;
  /**
   * literal    = 查询里**含**标注短语（关键词检索的主场）
   * paraphrase = 同义改写，不含短语，但仍共享内容词
   * abstract   = 用**不提技术名词**的自然语言描述问题
   * metaphor   = 只用比喻描述（与原文几乎零词面重叠，压力测试）
   */
  kind: 'literal' | 'paraphrase' | 'abstract' | 'metaphor';
}

// 评测集设计：每个标注短语出三条查询——
//   literal    直接出现短语
//   paraphrase 同义改写、不含短语
//   abstract   只描述「用户遇到的现象」，不说技术名词
// 只看「总 Recall」会把三种能力混在一起，所以报告里按 kind 拆开统计。
const QUERIES: EvalQuery[] = [
  { q: 'CODEBASE_WRITE_ENABLED 默认是开还是关，怎么整机禁用', contains: 'CODEBASE_WRITE_ENABLED', kind: 'literal' },
  { q: '上线后想把改文件能力彻底关掉，应该改哪个开关', contains: 'CODEBASE_WRITE_ENABLED', kind: 'paraphrase' },

  { q: 'build-image.mjs 这个脚本怎么用', contains: 'build-image.mjs', kind: 'literal' },
  { q: '给代码执行环境打包隔离镜像的那条命令是什么', contains: 'build-image.mjs', kind: 'paraphrase' },

  { q: '人工审批超时按拒绝是什么意思', contains: '超时按拒绝', kind: 'literal' },
  { q: '人在时限内没有回应，系统会怎么处理这次改动', contains: '超时按拒绝', kind: 'paraphrase' },

  { q: 'STREAM_HEARTBEAT_MS 默认多少', contains: 'STREAM_HEARTBEAT_MS', kind: 'literal' },
  { q: '长连接保活多久发一次空包', contains: 'STREAM_HEARTBEAT_MS', kind: 'paraphrase' },

  { q: 'MAX_TOOL_CONCURRENCY 控制什么', contains: 'MAX_TOOL_CONCURRENCY', kind: 'literal' },
  { q: '同时执行太多工具调用会被哪个上限拦住', contains: 'MAX_TOOL_CONCURRENCY', kind: 'paraphrase' },

  { q: 'FTS5 不可用时降级成 LIKE 查询吗', contains: 'LIKE', kind: 'literal' },
  { q: '全文索引扩展装不上时，搜索会退化成什么方式', contains: 'LIKE', kind: 'paraphrase' },

  { q: 'report:run 命令怎么生成单次报告', contains: 'report:run', kind: 'literal' },
  { q: '想给某一次执行生成一份带流程图的复盘文档', contains: 'report:run', kind: 'paraphrase' },

  { q: 'search_files 有哪些默认行为会静默失败', contains: 'search_files', kind: 'literal' },
  { q: '内容检索总是零命中，哪些默认行为容易误导人', contains: 'search_files', kind: 'paraphrase' },

  { q: 'Docker 代理 127.0.0.1:7890 连不上怎么排查', contains: '127.0.0.1:7890', kind: 'literal' },
  { q: '拉镜像时代理那条链路连不上，从哪里开始查', contains: '127.0.0.1:7890', kind: 'paraphrase' },

  { q: 'limit_reached 为什么单独统计', contains: 'limit_reached', kind: 'literal' },
  { q: '子任务被预算截断后，为什么不和失败合并计数', contains: 'limit_reached', kind: 'paraphrase' },

  { q: 'tool_call 首帧怎么提前渲染', contains: 'tool_call', kind: 'literal' },
  { q: '模型还没说完，第一个字节是怎么先显示出来的', contains: 'tool_call', kind: 'paraphrase' },

  { q: 'sqlite-vec 加载失败会怎样', contains: 'sqlite-vec', kind: 'literal' },
  { q: '向量检索扩展不可用时系统怎么兜底', contains: 'sqlite-vec', kind: 'paraphrase' },

  { q: 'workspacePath 越界如何防护', contains: 'workspacePath', kind: 'literal' },
  { q: '用相对路径读到仓库外的文件会被怎么拦', contains: 'workspacePath', kind: 'paraphrase' },

  { q: 'errors.log 记录什么', contains: 'errors.log', kind: 'literal' },
  { q: '结构化错误日志落在磁盘哪个文件', contains: 'errors.log', kind: 'paraphrase' },

  { q: 'allow_file 粘性同意是什么意思', contains: 'allow_file', kind: 'literal' },
  { q: '「这个文件以后都同意」这个选项是什么意思', contains: 'allow_file', kind: 'paraphrase' },

  { q: '并行 A/B 里 1.56M token 是什么结论', contains: '1.56M', kind: 'literal' },
  { q: '多 Agent 并行相比串行多花多少 token', contains: '1.56M', kind: 'paraphrase' },

  { q: 'Node v24 是硬性要求吗', contains: 'Node v24', kind: 'literal' },
  { q: '跑测试对运行时版本有什么硬要求', contains: 'Node v24', kind: 'paraphrase' },

  // ---- abstract：只描述现象，不提技术名词（零/弱词面重叠，考验语义泛化）----
  { q: '上线以后不想让它碰我的文件，部署前一次性禁掉', contains: 'CODEBASE_WRITE_ENABLED', kind: 'abstract' },
  { q: '跑代码之前要先准备好那个隔离盒子，怎么把它打出来', contains: 'build-image.mjs', kind: 'abstract' },
  { q: '我离开电脑太久没点确认，结果是默默通过了吗', contains: '超时按拒绝', kind: 'abstract' },
  { q: '页面挂很久没新消息，怎么知道后台还活着', contains: 'STREAM_HEARTBEAT_MS', kind: 'abstract' },
  { q: '一次让它干太多活会不会互相打架，有没有天花板', contains: 'MAX_TOOL_CONCURRENCY', kind: 'abstract' },
  { q: '高级索引装不上的时候，土办法是怎么搜的', contains: 'LIKE', kind: 'abstract' },
  { q: '想给某次执行留一份事后能翻的材料', contains: 'report:run', kind: 'abstract' },
  { q: '我明明知道仓库里有这段代码，它就是搜不出来', contains: 'search_files', kind: 'abstract' },
  { q: '容器里下载东西老失败，怀疑是翻墙那条路断了', contains: '127.0.0.1:7890', kind: 'abstract' },
  { q: '活儿没干完是被额度掐掉的，这算不算失败', contains: 'limit_reached', kind: 'abstract' },
  { q: '它话才说一半，我就先看到它准备动手了', contains: 'tool_call', kind: 'abstract' },
  { q: '做相似度搜索的那个插件没装成功会怎么样', contains: 'sqlite-vec', kind: 'abstract' },
  { q: '用 ../ 爬出去读别人的文件会被拦住吗', contains: 'workspacePath', kind: 'abstract' },
  { q: '出了错以后去哪里翻记录', contains: 'errors.log', kind: 'abstract' },
  { q: '点一次「以后这个文件都别问我」会有什么后果', contains: 'allow_file', kind: 'abstract' },
  { q: '多个子任务一起跑，账单比一个一个跑贵多少', contains: '1.56M', kind: 'abstract' },
  { q: '我这台机器的运行时版本不对会不会跑不起来', contains: 'Node v24', kind: 'abstract' },

  // ---- metaphor：只用比喻，几乎零词面重叠（压力测试；全模式掉分是预期）----
  { q: '马缰绳得拽住，不然一群马一起冲', contains: 'MAX_TOOL_CONCURRENCY', kind: 'metaphor' },
  { q: '门禁刷一次就整栋楼都开了', contains: 'allow_file', kind: 'metaphor' },
  { q: '油表见底就熄火，这算不算事故', contains: 'limit_reached', kind: 'metaphor' },
  { q: '停电以后怎么知道冰箱还在转', contains: 'STREAM_HEARTBEAT_MS', kind: 'metaphor' },
  { q: '保险丝烧了去哪里看熔断记录', contains: 'errors.log', kind: 'metaphor' },
  { q: '后门没锁，有人翻墙进来', contains: 'workspacePath', kind: 'metaphor' },
  { q: '把动手的权限整个焊死', contains: 'CODEBASE_WRITE_ENABLED', kind: 'metaphor' },
  { q: '先搭一间空房，再把东西搬进去', contains: 'build-image.mjs', kind: 'metaphor' },
  { q: '把一次性胶片留成相册', contains: 'report:run', kind: 'metaphor' },
  { q: '话还没落地，手先伸出去了', contains: 'tool_call', kind: 'metaphor' },
];

async function main(): Promise<void> {
  const docs = loadDocs();
  // 优先用 .env 配置的真实 embedding（MTA_EMBEDDING_*）；RAG_BENCH_EMBEDDER=hash 可强制回基线。
  loadEnv();
  const forceHash = (process.env.RAG_BENCH_EMBEDDER ?? '').toLowerCase() === 'hash';
  const embedder: AsyncEmbedder = forceHash
    ? createHashAsyncEmbedder(256)
    : (createConfiguredEmbedder() ?? createHashAsyncEmbedder(256));
  // 可选：MTA_RERANKER_URL 指向本地 cross-encoder 服务（scripts/rerank-server.py）
  const reranker: Reranker | undefined = process.env.MTA_RERANKER_URL
    ? new HttpReranker({ url: process.env.MTA_RERANKER_URL, timeoutMs: 30_000 })
    : undefined;
  console.log(`[rag-bench] embedder = ${embedder.name} (${embedder.dim}d) | reranker = ${reranker?.name ?? 'lexical-coverage'}`);
  const chunks: Chunk[] = docs.flatMap((d) => chunkDocument(d, { chunkSize: 512, overlap: 64 }));
  const vectors = await embedder.embed(chunks.map((c) => c.embedText));
  const records = chunks.map((c, i) => ({ id: c.id, vector: vectors[i], metadata: c.metadata }));
  const activeQueries = QUERIES.filter((q) => {
    const hit = chunks.some((c) => normalize(c.text).includes(normalize(q.contains)));
    if (!hit) console.warn(`[rag-bench] 跳过无标签查询（语料中找不到短语）：${q.contains}`);
    return hit;
  });
  const qVecs = await embedder.embed(activeQueries.map((q) => q.q));

  const { rows: quality, sweep, splits } = await evalQuality(docs, activeQueries, chunks, embedder, reranker);
  const index = evalIndexes(records, qVecs);
  const filtering = evalFiltering(records, qVecs);
  const report = renderReport({ docs, chunks, activeQueries, quality, index, filtering, embedder, sweep, splits, rerankerName: reranker?.name ?? 'lexical-coverage' });
  const out = join(PROJECT, 'reports', 'RAG_EVAL.md');
  writeFileSync(out, report.replace(/\r?\n/g, '\r\n'), 'utf8');
  console.log(`[rag-bench] 已写入 ${relative(REPO, out)} (${activeQueries.length} queries / ${chunks.length} chunks)`);
  console.log(qualityTable(quality));
  console.log('[hybrid_weighted alpha 扫描]');
  console.log('| alpha | Recall@5 | MRR | nDCG@5 |');
  console.log('|---|---:|---:|---:|');
  for (const s of sweep) {
    console.log(`| ${s.alpha.toFixed(1)} | ${(s.recallAt5 * 100).toFixed(1)}% | ${s.mrr.toFixed(3)} | ${s.ndcgAt5.toFixed(3)} |`);
  }
  console.log('[按查询类型拆分 Recall@5]');
  console.log('| 模式 | 字面型 | 同义型 | 抽象型 | 隐喻型 |');
  console.log('|---|---:|---:|---:|---:|');
  for (const s of splits) {
    console.log(`| ${s.mode} | ${(s.literalRecall * 100).toFixed(1)}% | ${(s.paraphraseRecall * 100).toFixed(1)}% | ${(s.abstractRecall * 100).toFixed(1)}% | ${(s.metaphorRecall * 100).toFixed(1)}% |`);
  }
  console.log(indexTable(index));
  console.log(filterTable(filtering));
}

function loadDocs(): RagDoc[] {
  const files: string[] = [];
  // 冻结快照与仓库同构（AGENTS.md / <项目目录>/{README,.env.example,reports,docs}），id 保持不变
  const base = CORPUS_FROZEN ? CORPUS_ROOT : REPO;
  const projDir = basename(PROJECT);
  const push = (p: string) => {
    if (existsSync(p)) files.push(p);
  };
  push(join(base, 'AGENTS.md'));
  push(join(base, projDir, 'README.md'));
  push(join(base, projDir, '.env.example'));
  push(join(base, projDir, 'reports', 'PROJECT_REPORT.md'));
  const docsDir = join(base, projDir, 'docs');
  if (existsSync(docsDir)) {
    for (const f of readdirSync(docsDir)) if (f.endsWith('.md')) push(join(docsDir, f));
  }
  return files.map((f) => {
    const id = relative(base, f).split(sep).join('/');
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

interface AlphaRow {
  alpha: number;
  recallAt5: number;
  mrr: number;
  ndcgAt5: number;
}

interface SplitRow {
  mode: RagSearchMode;
  literalRecall: number;
  paraphraseRecall: number;
  abstractRecall: number;
  metaphorRecall: number;
}

async function evalQuality(
  docs: RagDoc[],
  queries: EvalQuery[],
  chunks: Chunk[],
  embedder: AsyncEmbedder,
  reranker?: Reranker,
): Promise<{ rows: QualityRow[]; sweep: AlphaRow[]; splits: SplitRow[] }> {
  const pipeline = await RagPipeline.build(docs, {
    chunk: { chunkSize: 512, overlap: 64 },
    embedder,
    indexKind: 'flat',
    ...(reranker ? { reranker } : {}),
  });
  // hybrid_weighted 走加权融合（alpha = 向量权重），其余模式忽略 alpha
  const runMode = async (mode: RagSearchMode, alpha?: number, subset: EvalQuery[] = queries) => {
    let recall = 0;
    let mrr = 0;
    let ndcg = 0;
    let latency = 0;
    for (const q of subset) {
      const relevant = new Set(
        chunks.filter((c) => normalize(c.text).includes(normalize(q.contains))).map((c) => c.id),
      );
      const res = await pipeline.search(q.q, { mode, k: 5, ...(alpha !== undefined ? { alpha } : {}) });
      const ids = res.results.map((r) => r.id);
      recall += ids.some((id) => relevant.has(id)) ? 1 : 0;
      const first = ids.findIndex((id) => relevant.has(id));
      mrr += first >= 0 ? 1 / (first + 1) : 0;
      ndcg += ndcgAt(ids, relevant, 5);
      latency += res.latencyMs;
    }
    return {
      recallAt5: recall / subset.length,
      mrr: mrr / subset.length,
      ndcgAt5: ndcg / subset.length,
      avgLatencyMs: latency / subset.length,
      hits: subset.length,
    };
  };

  const modes: RagSearchMode[] = ['keyword', 'vector', 'hybrid', 'hybrid_weighted', 'hybrid_rerank'];
  const rows: QualityRow[] = [];
  for (const mode of modes) rows.push({ mode, ...(await runMode(mode)) });

  // 权重扫描：找出「语义召回已很强」时的最优 alpha，代替默认 RRF
  const sweep: AlphaRow[] = [];
  for (const alpha of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
    sweep.push({ alpha, ...(await runMode('hybrid_weighted', alpha)) });
  }
  // 按查询类型拆分：直接看「词法 vs 语义」的能力差异（构造效度）
  const literalQs = queries.filter((q) => q.kind === 'literal');
  const paraphraseQs = queries.filter((q) => q.kind === 'paraphrase');
  const abstractQs = queries.filter((q) => q.kind === 'abstract');
  const metaphorQs = queries.filter((q) => q.kind === 'metaphor');
  const splits: SplitRow[] = [];
  for (const mode of ['keyword', 'vector', 'hybrid', 'hybrid_weighted'] as RagSearchMode[]) {
    const lit = await runMode(mode, undefined, literalQs);
    const par = await runMode(mode, undefined, paraphraseQs);
    const abs = await runMode(mode, undefined, abstractQs);
    const met = await runMode(mode, undefined, metaphorQs);
    splits.push({
      mode,
      literalRecall: lit.recallAt5,
      paraphraseRecall: par.recallAt5,
      abstractRecall: abs.recallAt5,
      metaphorRecall: met.recallAt5,
    });
  }
  return { rows, sweep, splits };
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
  embedder: { name: string; dim: number };
  sweep: AlphaRow[];
  splits: SplitRow[];
  rerankerName: string;
}): string {
  const date = new Date().toISOString().slice(0, 10);
  const L: string[] = [];
  L.push('# RAG P0 评测（切块 / 索引 / 混合检索 / Rerank）');
  L.push('');
  L.push(`> 生成时间：${date}；命令：\`npm run rag:bench\`；生成物请重跑命令，不要手改数字。`);
  L.push('');
  L.push('## 1. 口径与环境');
  L.push('');
  L.push(`- 语料：${CORPUS_FROZEN ? '`eval/rag-corpus`（**冻结快照**，跨天可比）' : '本仓库当前文件（**未冻结**，数字会随文档增改漂移）'}：AGENTS.md、README.md、.env.example、docs/*.md、PROJECT_REPORT.md，共 **${x.docs.length}** 个文档。`);
  L.push(`- 切块：512 tokens / 64 overlap（\`src/knowledge/chunking.ts\` 默认），共 **${x.chunks.length}** 个 chunk。`);
  const isHash = x.embedder.name.startsWith('hash-ngram');
  L.push(
    `- Embedding：\`${x.embedder.name}\`（${x.embedder.dim} 维、L2 归一化）。` +
      (isHash
        ? '**它是词法哈希，不是语义模型**；本表衡量的是管线机制，不代表真实语义上限。'
        : '本地 Ollama 语义模型；与 hash 基线的对比见 `reports/RAG_IMPROVEMENT_2026-10-23.md`。'),
  );
  L.push(`- 评测查询：${x.activeQueries.length} 条；相关 chunk = 文本包含指定唯一短语（自动标注，可复现）。`);
  L.push(
    `- Reranker：\`${x.rerankerName}\`` +
      (x.rerankerName.startsWith('lexical') ? '（词法打分，**不是** cross-encoder）。' : '（本地 cross-encoder 服务）。'),
  );
  L.push('- 指标：Recall@5（top-5 是否命中任一相关块）、MRR（首个相关块名次倒数）、nDCG@5（二元相关性）。');
  L.push('');
  L.push('## 2. 混合检索与 Rerank');
  L.push('');
  L.push(qualityTable(x.quality));
  L.push('');
  L.push('**读法**：RRF 对两路分数尺度不敏感，通常比单路更稳；`hybrid_rerank` 在候选池上做词法联合打分。若 rerank 相对 RRF 没有提升，说明语料/查询以精确词命中为主，或 reranker 太弱（生产应换 bge-reranker / Cohere / LLM rerank）。');
  L.push('');
  L.push('## 2.1 hybrid_weighted 权重扫描（alpha = 向量权重）');
  L.push('');
  L.push('| alpha | Recall@5 | MRR | nDCG@5 |');
  L.push('|---|---:|---:|---:|');
  for (const s of x.sweep) {
    L.push(`| ${s.alpha.toFixed(1)} | ${(s.recallAt5 * 100).toFixed(1)}% | ${s.mrr.toFixed(3)} | ${s.ndcgAt5.toFixed(3)} |`);
  }
  L.push('');
  L.push('**读法**：alpha 越大越偏向语义路。语义召回显著强于词法时，最优 alpha 通常明显 >0.5；判断以 nDCG + MRR 为主，不能只看 Recall。');
  L.push('');
  L.push('## 2.2 按查询类型拆分（构造效度）');
  L.push('');
  L.push('| 模式 | 字面型 Recall@5 | 同义型 Recall@5 | 抽象型 Recall@5 | 隐喻型 Recall@5 |');
  L.push('|---|---:|---:|---:|---:|');
  for (const s of x.splits) {
    L.push(
      `| ${s.mode} | ${(s.literalRecall * 100).toFixed(1)}% | ${(s.paraphraseRecall * 100).toFixed(1)}% | ${(s.abstractRecall * 100).toFixed(1)}% | ${(s.metaphorRecall * 100).toFixed(1)}% |`,
    );
  }
  L.push('');
  L.push('**读法**：字面型考「能不能被关键词命中」；同义型考「换个说法还找不找得到」；抽象型只描述现象、不提技术名词；隐喻型与原文几乎零词面重叠（压力测试，全模式掉分是预期）。四列都高 = 真正语义稳健。');
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
