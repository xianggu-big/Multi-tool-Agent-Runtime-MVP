// tests/68_rag_persist.test.ts — RAG 索引持久化（P0）
// 覆盖：
//   68a 重启（同库新 Hub）后重建索引零 embedding 调用；
//   68b 增量：改一个文档只重算该文档的 chunk；
//   68c 级联：删文档后其 chunk 全部消失，且不产生 embedding；
//   68d 指纹：切块参数变化触发整库重算；
//   68e 一致：重启前后同一查询返回同一批 chunk。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { KnowledgeHub } from '../src/knowledge/index.js';
import { EventLogger } from '../src/trace/EventLogger.js';
import { Tracer } from '../src/trace/Tracer.js';
import { ErrorReporter } from '../src/runtime/errorReporter.js';
import { createHashAsyncEmbedder, type AsyncEmbedder } from '../src/knowledge/embeddings.js';
import { chunkDocument } from '../src/knowledge/chunking.js';

const CHUNK = { chunkSize: 64, overlap: 16, minChunkTokens: 0 };

function openHub(db: Database.Database): KnowledgeHub {
  return new KnowledgeHub(db, new Tracer(new EventLogger({ maxContentChars: 1000 })), new ErrorReporter());
}

/** 包一层计数：断言「重启后没有再跑 embedding」靠它 */
class CountingEmbedder implements AsyncEmbedder {
  calls = 0;
  texts = 0;
  constructor(private readonly inner: AsyncEmbedder) {}
  get name(): string {
    return this.inner.name;
  }
  get dim(): number {
    return this.inner.dim;
  }
  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    this.calls += 1;
    this.texts += texts.length;
    return this.inner.embed(texts, signal);
  }
}

function seed(hub: KnowledgeHub): void {
  hub.putData({ collection: 'docs', itemId: 'a', content: { text: '审批通过后写入文件并复核结果。'.repeat(12) } });
  hub.putData({ collection: 'docs', itemId: 'b', content: { text: '检索命中率由召回与排序共同决定。'.repeat(12) } });
  hub.putData({ collection: 'docs', itemId: 'c', content: { text: '沙箱执行超时会终止命令并回滚。'.repeat(12) } });
}

/** 与 rebuildRag 完全同口径地预估某文档的 chunk 数 */
function expectedChunksFor(hub: KnowledgeHub, collection: string, itemId: string): number {
  const item = hub.getData(collection, itemId)!;
  return chunkDocument({ id: item.id, title: `${item.collection}/${item.itemId}`, text: item.searchText }, CHUNK).length;
}

test('68a) 持久化：同库新 Hub 重建索引零 embedding 调用', async () => {
  const db = new Database(':memory:');
  const hub = openHub(db);
  seed(hub);

  const e1 = new CountingEmbedder(createHashAsyncEmbedder(64));
  const p1 = await hub.rebuildRag({ embedder: e1, chunk: CHUNK });
  const chunks1 = p1.stats().chunks;
  assert.ok(chunks1 > 0, '应有 chunk');
  assert.equal(e1.texts, chunks1, '首次构建里每个 chunk 都应被嵌入一次');
  assert.equal(hub.ragStats()?.store.chunks, chunks1, '持久化层应保存同样数量的 chunk');

  // 模拟进程重启：同一数据库、新的内存 Hub（ragCache 为空）
  const hub2 = openHub(db);
  const e2 = new CountingEmbedder(createHashAsyncEmbedder(64));
  const p2 = await hub2.rebuildRag({ embedder: e2, chunk: CHUNK });

  assert.equal(e2.calls, 0, '重启后不应再调用 embedding');
  assert.equal(e2.texts, 0);
  assert.equal(p2.stats().chunks, chunks1);
  assert.equal(hub2.ragStats()?.lastSync.embeddedChunks, 0, 'lastSync 应显示本次零重算');
  db.close();
});

test('68b) 增量：只重算内容变化的文档', async () => {
  const db = new Database(':memory:');
  const hub = openHub(db);
  seed(hub);
  const before = (await hub.rebuildRag({ embedder: createHashAsyncEmbedder(64), chunk: CHUNK })).stats().chunks;
  const oldB = expectedChunksFor(hub, 'docs', 'b');

  hub.putData({ collection: 'docs', itemId: 'b', content: { text: '新增：混合检索的融合权重需要按语料调。'.repeat(12) } });
  const newB = expectedChunksFor(hub, 'docs', 'b');

  const e = new CountingEmbedder(createHashAsyncEmbedder(64));
  const p2 = await hub.rebuildRag({ embedder: e, chunk: CHUNK });

  assert.equal(e.texts, newB, '只应嵌入改动文档的 chunk 数');
  assert.ok(e.texts < p2.stats().chunks, '增量数必须小于全量');
  assert.equal(p2.stats().chunks, before - oldB + newB, '旧块应被整批替换，不留残块');
  assert.equal(hub.ragStats()?.lastSync.reindexedDocs, 1);
  db.close();
});

test('68c) 级联删除：删文档后其 chunk 全部消失且不产生 embedding', async () => {
  const db = new Database(':memory:');
  const hub = openHub(db);
  seed(hub);
  const before = (await hub.rebuildRag({ embedder: createHashAsyncEmbedder(64), chunk: CHUNK })).stats().chunks;
  const aChunks = expectedChunksFor(hub, 'docs', 'a');

  hub.deleteData('docs', 'a');

  const e = new CountingEmbedder(createHashAsyncEmbedder(64));
  const p2 = await hub.rebuildRag({ embedder: e, chunk: CHUNK });

  assert.equal(e.texts, 0, '删除不应产生 embedding');
  assert.equal(p2.stats().chunks, before - aChunks);
  assert.equal(hub.ragStats()?.lastSync.reindexedDocs, 0);
  db.close();
});

test('68d) 指纹变更：换切块参数触发整库重算', async () => {
  const db = new Database(':memory:');
  const hub = openHub(db);
  seed(hub);
  await hub.rebuildRag({ embedder: createHashAsyncEmbedder(64), chunk: CHUNK });
  assert.equal(hub.ragStats()?.store.fingerprint?.chunk, '64/16');

  const e = new CountingEmbedder(createHashAsyncEmbedder(64));
  const p2 = await hub.rebuildRag({ embedder: e, chunk: { chunkSize: 32, overlap: 8, minChunkTokens: 0 } });

  assert.equal(e.texts, p2.stats().chunks, '指纹变 → 全部 chunk 重新嵌入');
  assert.equal(hub.ragStats()?.store.fingerprint?.chunk, '32/8');
  db.close();
});

test('68e) 检索一致：重启前后同一查询返回同一批 chunk', async () => {
  const db = new Database(':memory:');
  const hub = openHub(db);
  seed(hub);
  const p1 = await hub.rebuildRag({ embedder: createHashAsyncEmbedder(64), chunk: CHUNK });
  const r1 = await p1.search('检索', { mode: 'keyword', k: 3 });
  assert.ok(r1.results.length > 0, '查询应有命中');

  const hub2 = openHub(db);
  const p2 = await hub2.rebuildRag({ embedder: createHashAsyncEmbedder(64), chunk: CHUNK });
  const r2 = await p2.search('检索', { mode: 'keyword', k: 3 });

  assert.deepEqual(
    r1.results.map((r) => r.chunkId),
    r2.results.map((r) => r.chunkId),
    '重启后同查询必须返回同一批 chunk',
  );
  db.close();
});

/** 轮询直到条件成立或超时（后台任务是异步的，不能用固定 sleep） */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
}

test('68f) 后台补索引：写入立即返回，索引由后台补齐', async () => {
  const db = new Database(':memory:');
  const hub = new KnowledgeHub(db, new Tracer(new EventLogger({ maxContentChars: 1000 })), new ErrorReporter(), {
    backgroundIndex: true,
  });
  assert.equal(hub.backgroundIndexEnabled, true);

  seed(hub);
  assert.ok(
    await waitFor(() => {
      const s = hub.ragStatus();
      return s.built && !s.indexing && s.store.docs === 3;
    }, 5000),
    '首次写入应在后台完成索引',
  );

  hub.putData({ collection: 'docs', itemId: 'd', content: { text: '后台新增的文档内容。'.repeat(10) } });
  assert.ok(
    await waitFor(() => {
      const s = hub.ragStatus();
      return s.built && !s.indexing && s.store.docs === 4;
    }, 5000),
    '新增文档应被后台补进索引（不用等检索）',
  );
  db.close();
});
