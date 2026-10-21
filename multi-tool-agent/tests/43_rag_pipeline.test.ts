// tests/43_rag_pipeline.test.ts — RAG P0：切块 / embedding / HNSW·IVF / 混合检索 / rerank
//
// 这些用例把「面试里能说清楚」落成可执行事实：
//   - 512/64 不是拍脑袋：token 上限、句子边界、尾部句子 overlap、确定性 id；
//   - HNSW/IVF 的 efSearch / nprobe 是召回-延迟旋钮，高 ef/nprobe 必须逼近 Flat；
//   - RRF 只看名次，分数可按 1/(k+rank) 手算；
//   - 元数据过滤是 post-filter，HNSW 在高选择性过滤下要扩大 ef 重试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkDocument, estimateTokens, resolveChunkOptions } from '../src/knowledge/chunking.js';
import { getEmbeddingModel, isL2Normalized, l2Normalize, cosineSimilarity, createHashAsyncEmbedder, createConfiguredEmbedder } from '../src/knowledge/embeddings.js';
import { LexicalReranker, reciprocalRankFusion, weightedScoreFusion } from '../src/knowledge/hybrid.js';
import { FlatIndex, HnswIndex, IvfFlatIndex } from '../src/knowledge/vectorIndex.js';
import { RagPipeline } from '../src/knowledge/ragPipeline.js';
import type { VectorRecord } from '../src/knowledge/vectorIndex.js';
import { buildRuntime } from '../src/runtime/index.js';
import { loadConfig } from '../src/config.js';
import { makeCtx } from './helpers.js';

test('43a) 切块：确定性、token 上限、句子 overlap、标题/heading 前缀', () => {
  const sentence = '审批通过后写入文件并复核结果。';
  const text = Array.from({ length: 20 }, (_, i) => `第${i}段：${sentence}`).join('\n\n');
  const source = { id: 'doc-write', title: '写能力说明', text, metadata: { collection: 'docs' } };
  const opts = { chunkSize: 64, overlap: 16, minChunkTokens: 0 };

  const a = chunkDocument(source, opts);
  const b = chunkDocument(source, opts);
  assert.ok(a.length > 2, `应切成多块，实际 ${a.length}`);
  assert.deepEqual(
    a.map((c) => [c.id, c.charStart, c.charEnd, c.text]),
    b.map((c) => [c.id, c.charStart, c.charEnd, c.text]),
    '同一输入 + 同一参数必须完全确定',
  );
  assert.equal(a[0].id, 'doc-write#0');
  for (const c of a) {
    assert.ok(c.tokenEstimate <= 64, `块 ${c.id} 超预算：${c.tokenEstimate}`);
    assert.ok(c.charEnd > c.charStart);
    assert.equal(c.text, text.slice(c.charStart, c.charEnd).trim(), `块 ${c.id} 的 text 必须与 charStart/charEnd 对应的原文一致`);
  }
  // overlap 是「上一块尾部完整句子」：下一块起点落在上一块区间内。
  for (let i = 1; i < a.length; i++) {
    assert.ok(a[i].charStart < a[i - 1].charEnd, `块 ${i} 没有 overlap`);
  }

  // 尾部短块合并也必须按原文区间重取，不能把 overlap 的句子复制一遍。
  const mergeText = Array.from({ length: 7 }, (_, i) => `第${i}段：${sentence}`).join('\n\n') + '\n\n结尾一段。';
  const merged = chunkDocument({ id: 'doc-merge', text: mergeText }, { chunkSize: 128, overlap: 16, minChunkTokens: 80 });
  assert.equal(merged.length, 1, `短尾块应并入前一块，实际 ${merged.length} 块`);
  for (const c of merged) {
    assert.equal(c.text, mergeText.slice(c.charStart, c.charEnd).trim(), '合并后 text 仍必须与 charStart/charEnd 对应');
  }
  assert.equal(merged[0].text, mergeText, '合并后的块应覆盖完整原文且不重复 overlap');

  const withHeading = chunkDocument({
    id: 'doc-heading',
    title: '标题',
    text: '# 审批\n\n第一段内容。\n\n第二段内容。',
  }, { chunkSize: 128, overlap: 0 });
  assert.equal(withHeading[0].heading, '审批');
  assert.match(withHeading[0].embedText, /标题/);
  assert.match(withHeading[0].embedText, /审批/);
});

test('43b) token 估算与 embedding 模型表：中文按字、英文按 4 字符/token，维度明确', () => {
  assert.equal(estimateTokens('中文四字'), 4);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('中文abcd'), 3);
  assert.equal(getEmbeddingModel('bge-small-zh-v1.5').dim, 512);
  assert.equal(getEmbeddingModel('text-embedding-3-small').dim, 1536);
  assert.throws(() => getEmbeddingModel('no-such-model'), /未知 embedding 模型/);

  const v = l2Normalize(Float32Array.from([3, 4]));
  assert.ok(isL2Normalized(v));
  assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 1e-6);
  assert.equal(resolveChunkOptions({ chunkSize: 100, overlap: 90 }).overlap, 49, 'overlap 必须小于 chunkSize/2');
});

test('43c) RRF 只看名次：score = Σ 1/(k+rank)，两路都命中者胜出', () => {
  const fused = reciprocalRankFusion([
    { name: 'keyword', items: [{ id: 'a', score: 99 }, { id: 'b', score: 1 }] },
    { name: 'vector', items: [{ id: 'b', score: 0.9 }, { id: 'c', score: 0.1 }] },
  ], { k: 60 });
  const a = fused.find((x) => x.id === 'a')!;
  const b = fused.find((x) => x.id === 'b')!;
  assert.deepEqual(a.ranks, { keyword: 1 });
  assert.ok(Math.abs(a.score - 1 / 61) < 1e-12);
  assert.ok(Math.abs(b.score - (1 / 62 + 1 / 61)) < 1e-12);
  assert.equal(fused[0].id, 'b');
});

test('43d) 加权融合 alpha 可控，rerank 用短语命中翻盘', () => {
  const lists = [
    { name: 'keyword', items: [{ id: 'kw', score: 10 }, { id: 'both', score: 5 }] },
    { name: 'vector', items: [{ id: 'both', score: 0.8 }, { id: 'vec', score: 0.4 }] },
  ];
  const keywordHeavy = weightedScoreFusion(lists, { alpha: 0.2 });
  assert.equal(keywordHeavy[0].id, 'kw');
  const vectorHeavy = weightedScoreFusion(lists, { alpha: 0.9 });
  assert.equal(vectorHeavy[0].id, 'both');

  const reranked = new LexicalReranker().rerank('人工审批超时后按拒绝处理', [
    { id: 'noise', text: '这条讲的是 Docker 代理和镜像拉取。', priorScore: 1 },
    { id: 'target', text: '人工审批超时后按拒绝处理，并记录原因。', priorScore: 0 },
  ], 2);
  assert.equal(reranked[0].id, 'target');
  assert.ok(reranked[0].rerankDetails.phrase > 0, '完整短语命中必须进入 rerank 明细');
});

function makeRecords(n: number): VectorRecord[] {
  return Array.from({ length: n }, (_, i) => {
    const v = new Float32Array(8);
    for (let j = 0; j < v.length; j++) v[j] = Math.sin((i + 1) * (j + 1) * 0.37) + Math.cos(i * 0.11 + j);
    return { id: `v${i}`, vector: l2Normalize(v), metadata: { bucket: i % 2 === 0 ? 'even' : 'odd' } };
  });
}

test('43e) Flat 是精确基线；HNSW 高 ef / IVF 全探测必须追平', () => {
  const records = makeRecords(60);
  const q = new Float32Array([0.1, 0.2, -0.3, 0.4, 0.5, -0.6, 0.7, 0.8]);
  l2Normalize(q);

  const flat = new FlatIndex();
  flat.add(records);
  const truth = flat.search(q, { k: 10 }).map((r) => r.id);

  const hnsw = new HnswIndex({ M: 16, efConstruction: 200, efSearch: 64, seed: 7 });
  hnsw.add(records);
  assert.deepEqual(hnsw.search(q, { k: 10, efSearch: 64 }).map((r) => r.id), truth);

  const ivf = new IvfFlatIndex({ nlist: 6, nprobe: 6, seed: 7 });
  ivf.add(records);
  assert.deepEqual(ivf.search(q, { k: 10, nprobe: 6 }).map((r) => r.id), truth);

  // efSearch / nprobe 越小，扫描越少；距离计算次数是「为什么更快」的证据。
  const narrow = new HnswIndex({ M: 8, efConstruction: 40, efSearch: 4, seed: 7 });
  narrow.add(records);
  narrow.search(q, { k: 5, efSearch: 4 });
  const wide = new HnswIndex({ M: 8, efConstruction: 40, efSearch: 32, seed: 7 });
  wide.add(records);
  wide.search(q, { k: 5, efSearch: 32 });
  assert.ok(narrow.stats().distanceComputations < wide.stats().distanceComputations);
});

test('43f) 元数据过滤：只返回匹配 bucket；HNSW 候选被过滤光时会扩大 ef 重试', () => {
  const records = makeRecords(40);
  const q = new Float32Array([0.2, -0.1, 0.3, 0.4, -0.5, 0.6, 0.1, -0.2]);
  l2Normalize(q);
  const filter = (m: Record<string, unknown>) => m.bucket === 'odd';

  const hnsw = new HnswIndex({ M: 8, efConstruction: 60, efSearch: 4, seed: 11 });
  hnsw.add(records);
  const got = hnsw.search(q, { k: 10, filter, efSearch: 4 });
  assert.equal(got.length, 10, 'odd 共 20 条，扩大 ef 后应拿满 10 条');
  assert.ok(got.every((r) => r.metadata?.bucket === 'odd'));

  const ivf = new IvfFlatIndex({ nlist: 4, nprobe: 8, seed: 11 });
  ivf.add(records);
  assert.ok(ivf.search(q, { k: 10, filter, nprobe: 8 }).every((r) => r.metadata?.bucket === 'odd'));
});

test('43g) RagPipeline 端到端：四种模式都能检索，统计与过滤生效', async () => {
  const docs = [
    { id: 'write', title: '写能力', text: '# 写能力\n\nZEBRA-CODE 是写能力的演示标记。\n\n审批通过后落盘并复核。', metadata: { collection: 'docs' } },
    { id: 'docker', title: '沙箱', text: '# 沙箱\n\nDocker 镜像通过 build-image.mjs 构建。', metadata: { collection: 'docs' } },
    { id: 'misc', title: '其他', text: '# 其他\n\n这里只有无关的天气内容。', metadata: { collection: 'other' } },
  ];
  const pipeline = await RagPipeline.build(docs, { chunk: { chunkSize: 128, overlap: 16 }, indexKind: 'hnsw' });
  assert.equal(pipeline.stats().chunks, 3);
  assert.equal(pipeline.stats().index.kind, 'hnsw');

  for (const mode of ['keyword', 'vector', 'hybrid', 'hybrid_rerank'] as const) {
    const res = await pipeline.search('ZEBRA-CODE', { mode, k: 2 });
    assert.ok(res.results.length >= 1, `${mode} 无结果`);
    if (mode !== 'keyword') assert.equal(res.results.length, 2, `${mode} 应返回 k=2`);
    assert.ok(res.results.some((h) => h.docId === 'write'), `${mode} 未命中 write`);
    assert.ok(res.timings.embedMs >= 0);
  }
  const filtered = await pipeline.search('ZEBRA-CODE', { k: 5, filter: (m) => m.collection === 'docs' });
  assert.ok(filtered.results.every((h) => h.metadata.collection === 'docs'));
  assert.ok(filtered.results.every((h) => h.docId !== 'misc'));
});

test('43h) knowledge_search 工具已接入 Registry：模型可检索并拿到 chunk 来源', async () => {
  const cfg = loadConfig();
  cfg.sqlitePath = ':memory:';
  const { store, knowledge, registry } = buildRuntime(cfg, ':memory:');
  try {
    const put = knowledge.putData({
      collection: 'docs',
      itemId: 'approval-timeout',
      content: { title: '审批超时', body: '审批超时后按拒绝处理，并记录原因。' },
    });
    // 显式用离线 hash，避免测试环境里 MTA_EMBEDDING_MODEL 触网。
    await knowledge.rebuildRag({ embedder: createHashAsyncEmbedder(256) });

    const ctx = makeCtx({ runType: 'codebase', allowedPermissions: ['knowledge:read'] });
    const r = await registry.execute('knowledge_search', { query: '审批超时怎么处理', k: 3 }, ctx);
    assert.equal(r.result.ok, true, r.result.error?.message);
    const data = r.result.data as { hits: Array<{ chunkId: string; docId: string; text: string; sources: string[] }> };
    assert.ok(data.hits.length >= 1);
    assert.equal(data.hits[0].docId, put.item.id);
    assert.ok(data.hits[0].chunkId.startsWith(`${put.item.id}#`));
    assert.match(data.hits[0].text, /审批超时/);
    assert.ok(data.hits[0].sources.length >= 1);
  } finally {
    store.close();
  }
});

test('43i) rebuildRag 分页：超过 500 条不静默截断；真实 embedding 只显式 opt-in', async () => {
  const cfg = loadConfig();
  cfg.sqlitePath = ':memory:';
  const { store, knowledge } = buildRuntime(cfg, ':memory:');
  try {
    for (let i = 0; i < 505; i++) {
      knowledge.repository.put({
        collection: 'bulk',
        itemId: `doc-${i}`,
        content: { body: `条目${i} 唯一词${i}` },
      });
    }
    const pipeline = await knowledge.rebuildRag({ embedder: createHashAsyncEmbedder(64) });
    assert.equal(pipeline.docs.length, 505, '必须索引全部 505 条，而不是前 500 条');
    assert.equal(pipeline.stats().docs, 505);
  } finally {
    store.close();
  }

  assert.equal(createConfiguredEmbedder({} as NodeJS.ProcessEnv), undefined);
  assert.throws(
    () => createConfiguredEmbedder({ MTA_EMBEDDING_MODEL: 'text-embedding-3-small' } as NodeJS.ProcessEnv),
    /MTA_EMBEDDING_API_KEY/,
  );
  const e = createConfiguredEmbedder({
    MTA_EMBEDDING_MODEL: 'text-embedding-3-small',
    MTA_EMBEDDING_API_KEY: 'sk-test',
  } as NodeJS.ProcessEnv);
  assert.equal(e?.dim, 1536);
  assert.match(e?.name ?? '', /text-embedding-3-small/);
});

test('43j) 索引删除/更新：墓碑删除后不再返回；IVF 增量 add 不每次重训', () => {
  const records = makeRecords(40);
  const q = new Float32Array([0.1, 0.2, -0.3, 0.4, 0.5, -0.6, 0.7, 0.8]);
  l2Normalize(q);

  const flat = new FlatIndex();
  flat.add(records);
  assert.equal(flat.remove(['v0', 'no-such-id']), 1);
  assert.equal(flat.size, 39);
  assert.ok(!flat.search(q, { k: 40 }).some((r) => r.id === 'v0'));

  const hnsw = new HnswIndex({ M: 16, efConstruction: 120, efSearch: 64, seed: 7 });
  hnsw.add(records);
  assert.equal(hnsw.remove(['v0']), 1);
  assert.equal(hnsw.size, 39);
  assert.ok(!hnsw.search(q, { k: 10, efSearch: 64 }).some((r) => r.id === 'v0'));
  // upsert：同 id 覆盖，不应出现两条同 id 结果，size 也不增长。
  hnsw.add([{ id: 'v1', vector: records[2].vector, metadata: { bucket: 'odd' } }]);
  assert.equal(hnsw.size, 39);
  assert.equal(hnsw.search(q, { k: 40, efSearch: 64 }).filter((r) => r.id === 'v1').length, 1);

  const ivf = new IvfFlatIndex({ nlist: 4, nprobe: 4, seed: 7 });
  ivf.add(records);
  const rebuildsAfterFirst = ivf.stats().params.rebuilds;
  const extra = makeRecords(3).map((r, i) => ({ ...r, id: 'x' + i }));
  ivf.add(extra);
  assert.equal(ivf.stats().params.rebuilds, rebuildsAfterFirst, '增量 add 不应每次全量重训');
  assert.equal(ivf.size, 43);
  assert.equal(ivf.remove(['v0']), 1);
  assert.ok(!ivf.search(q, { k: 40, nprobe: 4 }).some((r) => r.id === 'v0'));
});
