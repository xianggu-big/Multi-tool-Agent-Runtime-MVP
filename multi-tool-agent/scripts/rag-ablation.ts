// scripts/rag-ablation.ts — RAG 切块/维度消融（离线、可复现）
//
// 运行：npm run rag:ablation
// 产出：reports/RAG_ABLATION.md
//
// 目的：回答“512/64 是怎么选的、维度是不是越大越好”。
// 注意：embedding 仍是 hash-ngram（词法替身），本表只证明管线机制与成本曲线，
// 不代表 bge/OpenAI 的语义效果；真实模型接入后应重跑本表。

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkDocument } from '../src/knowledge/chunking.js';
import { createHashAsyncEmbedder } from '../src/knowledge/embeddings.js';
import { RagPipeline, type RagDoc, type RagSearchMode } from '../src/knowledge/ragPipeline.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..');
const REPO = resolve(PROJECT, '..');

interface EvalQuery { q: string; contains: string }

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

const CHUNK_CONFIGS = [
  { size: 256, overlap: 0 },
  { size: 256, overlap: 32 },
  { size: 256, overlap: 64 },
  { size: 512, overlap: 0 },
  { size: 512, overlap: 32 },
  { size: 512, overlap: 64 },
  { size: 800, overlap: 0 },
  { size: 800, overlap: 32 },
  { size: 800, overlap: 64 },
];

const DIMS = [64, 128, 256, 512];

interface ChunkRow {
  size: number;
  overlap: number;
  chunks: number;
  avgTokens: number;
  activeQueries: number;
  recall: number;
  mrr: number;
  ndcg: number;
  latencyMs: number;
}

interface DimRow {
  dim: number;
  chunks: number;
  vectorMB: number;
  vectorRecall: number;
  vectorMrr: number;
  hybridRecall: number;
  hybridMrr: number;
}

async function main(): Promise<void> {
  const docs = loadDocs();
  const chunkRows: ChunkRow[] = [];
  for (const cfg of CHUNK_CONFIGS) chunkRows.push(await evalChunks(docs, cfg.size, cfg.overlap));

  const dimRows: DimRow[] = [];
  for (const dim of DIMS) dimRows.push(await evalDim(docs, dim));

  const report = renderReport(chunkRows, dimRows);
  const out = join(PROJECT, 'reports', 'RAG_ABLATION.md');
  writeFileSync(out, report, 'utf8');
  console.log(`[rag:ablation] 已写入 ${relative(REPO, out)}`);
  console.log(chunkTable(chunkRows));
  console.log(dimTable(dimRows));
}

async function evalChunks(docs: RagDoc[], size: number, overlap: number): Promise<ChunkRow> {
  const chunks = docs.flatMap((d) => chunkDocument(d, { chunkSize: size, overlap }));
  const active = QUERIES.filter((q) => chunks.some((c) => norm(c.text).includes(norm(q.contains))));
  const pipeline = await RagPipeline.build(docs, {
    chunk: { chunkSize: size, overlap },
    embedder: createHashAsyncEmbedder(256),
    indexKind: 'flat',
  });
  const m = await measure(pipeline, active, 'hybrid_rerank');
  return {
    size,
    overlap,
    chunks: chunks.length,
    avgTokens: chunks.reduce((n, c) => n + c.tokenEstimate, 0) / Math.max(1, chunks.length),
    activeQueries: active.length,
    recall: m.recall,
    mrr: m.mrr,
    ndcg: m.ndcg,
    latencyMs: m.latencyMs,
  };
}

async function evalDim(docs: RagDoc[], dim: number): Promise<DimRow> {
  const chunks = docs.flatMap((d) => chunkDocument(d, { chunkSize: 512, overlap: 64 }));
  const active = QUERIES.filter((q) => chunks.some((c) => norm(c.text).includes(norm(q.contains))));
  const pipeline = await RagPipeline.build(docs, {
    chunk: { chunkSize: 512, overlap: 64 },
    embedder: createHashAsyncEmbedder(dim),
    indexKind: 'flat',
  });
  const vector = await measure(pipeline, active, 'vector');
  const hybrid = await measure(pipeline, active, 'hybrid_rerank');
  return {
    dim,
    chunks: chunks.length,
    vectorMB: (chunks.length * dim * 4) / (1024 * 1024),
    vectorRecall: vector.recall,
    vectorMrr: vector.mrr,
    hybridRecall: hybrid.recall,
    hybridMrr: hybrid.mrr,
  };
}

async function measure(
  pipeline: RagPipeline,
  queries: EvalQuery[],
  mode: RagSearchMode,
): Promise<{ recall: number; mrr: number; ndcg: number; latencyMs: number }> {
  let recall = 0;
  let mrr = 0;
  let ndcg = 0;
  let latency = 0;
  const chunks = pipeline.chunks;
  for (const q of queries) {
    const relevant = new Set(chunks.filter((c) => norm(c.text).includes(norm(q.contains))).map((c) => c.id));
    const res = await pipeline.search(q.q, { mode, k: 5 });
    const ids = res.results.map((r) => r.id);
    recall += ids.some((id) => relevant.has(id)) ? 1 : 0;
    const first = ids.findIndex((id) => relevant.has(id));
    mrr += first >= 0 ? 1 / (first + 1) : 0;
    ndcg += ndcgAt(ids, relevant, 5);
    latency += res.latencyMs;
  }
  const n = Math.max(1, queries.length);
  return { recall: recall / n, mrr: mrr / n, ndcg: ndcg / n, latencyMs: latency / n };
}

function loadDocs(): RagDoc[] {
  const files: string[] = [];
  const push = (p: string) => { if (existsSync(p)) files.push(p); };
  push(join(REPO, 'AGENTS.md'));
  push(join(PROJECT, 'README.md'));
  push(join(PROJECT, '.env.example'));
  push(join(PROJECT, 'reports', 'PROJECT_REPORT.md'));
  const docsDir = join(PROJECT, 'docs');
  if (existsSync(docsDir)) for (const f of readdirSync(docsDir)) if (f.endsWith('.md')) push(join(docsDir, f));
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

function renderReport(chunkRows: ChunkRow[], dimRows: DimRow[]): string {
  const L: string[] = [];
  L.push('# RAG 切块 / 维度消融（生成物）');
  L.push('');
  L.push('> 由 `npm run rag:ablation` 从同一语料/查询自动生成；**请勿手改数字**。');
  L.push('');
  L.push('## 0. 口径与边界');
  L.push('');
  L.push('- 语料：本仓库 AGENTS.md、README.md、.env.example、docs/*.md、PROJECT_REPORT.md。');
  L.push('- Embedding：hash-ngram（离线词法替身）；本表只反映管线机制与成本，不代表真实语义模型效果。');
  L.push('- 相关 chunk：文本包含查询指定的唯一短语（自动标注）；不同切块下相关集合会重算。');
  L.push('- 指标：Recall@5 / MRR / nDCG@5；延迟为单查询平均墙钟（本地、内存索引）。');
  L.push('');
  L.push('## 1. 切块大小 / overlap 消融');
  L.push('');
  L.push(chunkTable(chunkRows));
  L.push('');
  L.push('**读法**：块越小越容易精确命中，但上下文变碎、chunk 数/索引成本上升；overlap 提升跨段答案的召回，但会让索引体积和重复内容增加。512/64 是“语义完整度 vs 成本”的默认折中，不是本表唯一最优；选型应看语料类型与真实模型评测。');
  L.push('');
  L.push('## 2. Embedding 维度消融');
  L.push('');
  L.push(dimTable(dimRows));
  L.push('');
  L.push('**读法**：维度↑ → 向量存储/带宽/索引成本线性上升；hash 维度变化只说明“碰撞/表达力”的机制，不代表 bge/OpenAI 的语义上限。生产先用 512~1024 维做基线，评测不够再升维。');
  L.push('');
  L.push('## 3. 复跑');
  L.push('');
  L.push('```bash');
  L.push('npm run rag:ablation');
  L.push('npm run rag:bench');
  L.push('```');
  L.push('');
  return L.join('\r\n');
}

function chunkTable(rows: ChunkRow[]): string {
  const L = ['| chunk / overlap | chunks | 平均 token | 有效查询 | Recall@5 | MRR | nDCG@5 | 平均延迟 |', '|---|---:|---:|---:|---:|---:|---:|---:|'];
  for (const r of rows) {
    L.push(`| ${r.size} / ${r.overlap} | ${r.chunks} | ${r.avgTokens.toFixed(1)} | ${r.activeQueries} | ${pct(r.recall)} | ${r.mrr.toFixed(3)} | ${r.ndcg.toFixed(3)} | ${r.latencyMs.toFixed(2)}ms |`);
  }
  return L.join('\n');
}

function dimTable(rows: DimRow[]): string {
  const L = ['| 维度 | chunks | 向量存储 | vector Recall@5 | vector MRR | hybrid+rerank Recall@5 | hybrid+rerank MRR |', '|---:|---:|---:|---:|---:|---:|---:|'];
  for (const r of rows) {
    L.push(`| ${r.dim} | ${r.chunks} | ${r.vectorMB.toFixed(2)} MiB | ${pct(r.vectorRecall)} | ${r.vectorMrr.toFixed(3)} | ${pct(r.hybridRecall)} | ${r.hybridMrr.toFixed(3)} |`);
  }
  return L.join('\n');
}

function ndcgAt(ids: string[], relevant: Set<string>, k: number): number {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, ids.length); i++) if (relevant.has(ids[i])) dcg += 1 / Math.log2(i + 2);
  let idcg = 0;
  for (let i = 0; i < Math.min(k, relevant.size); i++) idcg += 1 / Math.log2(i + 2);
  return idcg > 0 ? dcg / idcg : 0;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});