// tests/28_vector_recall.test.ts — 语义向量召回层（sqlite-vec / 降级 / 混合检索）
// 覆盖：嵌入器确定性、向量写入/检索、降级路径、混合检索去重、KnowledgeHub 集成。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { HashEmbedder, VectorRecall, vecToBuffer, bufferToVec, cosine } from '../src/knowledge/vectorRecall.js';
import { KnowledgeHub } from '../src/knowledge/index.js';
import { EventLogger } from '../src/trace/EventLogger.js';
import { LiveHub } from '../src/trace/LiveHub.js';
import { Tracer } from '../src/trace/Tracer.js';
import { ErrorReporter } from '../src/runtime/errorReporter.js';

function makeHub(db?: Database.Database): { hub: KnowledgeHub; db: Database.Database; close: () => void } {
  const d = db ?? new Database(':memory:');
  const liveHub = new LiveHub();
  const logger = new EventLogger({ maxContentChars: 1000, onLive: (e) => liveHub.publish(e) });
  const tracer = new Tracer(logger);
  const errors = new ErrorReporter({ emit: () => {} });
  const hub = new KnowledgeHub(d, tracer, errors);
  return { hub, db: d, close: () => d.close() };
}

describe('HashEmbedder', () => {
  it('确定性：同输入同输出', () => {
    const e = new HashEmbedder(128);
    const a = e.embed('代码审计发现硬编码');
    const b = e.embed('代码审计发现硬编码');
    assert.deepEqual(Array.from(a), Array.from(b));
  });

  it('归一化：L2 范数 = 1', () => {
    const e = new HashEmbedder(64);
    const v = e.embed('some meaningful text here');
    let norm = 0;
    for (const x of v) norm += x * x;
    assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-5);
  });

  it('相似文本相似度高，不相关文本相似度低', () => {
    const e = new HashEmbedder(256);
    const v1 = e.embed('代码审计发现硬编码常量');
    const v2 = e.embed('代码审计发现硬编码');
    const v3 = e.embed('完全不同的内容关于天气');
    const s12 = cosine(v1, v2);
    const s13 = cosine(v1, v3);
    assert.ok(s12 > s13, `相似文本应更近: ${s12} vs ${s13}`);
  });

  it('中文 3-gram 被切出（避免单字丢失语义）', () => {
    const e = new HashEmbedder(256);
    const v = e.embed('知识库');
    assert.ok(v.some((x) => x !== 0));
  });
});

describe('vecToBuffer / bufferToVec', () => {
  it('往返一致', () => {
    const v = new Float32Array([0.1, -0.2, 0.3, 0]);
    const b = vecToBuffer(v);
    const v2 = bufferToVec(b);
    assert.deepEqual(Array.from(v), Array.from(v2));
  });
});

describe('VectorRecall — 旧 sqlite-vec 轨（已停写，仅保留为历史/兼容工具）', () => {
  // 生产写入路径已统一到 RAG（rag_chunks）；这里直接构造 VectorRecall 并用显式 upsert，
  // 只验证这个遗留组件本身没坏，不再代表 KnowledgeHub 的检索路径。
  function makeVRWith(seedItems: { id: string; collection: string; text: string }[]) {
    const { hub, db, close } = makeHub();
    for (const it of seedItems) {
      hub.putData({ collection: it.collection, itemId: it.id, content: { t: it.text } });
    }
    const vr = new VectorRecall(db);
    for (const it of seedItems) {
      const item = hub.getData(it.collection, it.id)!;
      vr.upsert(item.id, item.searchText);
    }
    return { hub, vr, close };
  }

  const SEED = [
    { id: 'd1', collection: 'audit', text: '代码审计发现三处硬编码密钥' },
    { id: 'd2', collection: 'audit', text: '安全扫描报告指出存在不安全常量' },
    { id: 'd3', collection: 'notes', text: '今天天气不错适合散步' },
  ];

  it('available 反映 sqlite-vec 是否加载', () => {
    const { vr, close } = makeVRWith(SEED);
    try {
      assert.equal(typeof vr.available, 'boolean');
    } finally { close(); }
  });

  it('语义检索：相关条目排在前面', () => {
    const { vr, close } = makeVRWith(SEED);
    try {
      const hits = vr.search('不安全的常量硬编码', { limit: 3 });
      const ids = hits.map((h) => h.itemId);
      assert.ok(ids.includes('d1') || ids.includes('d2'), `应召回安全相关条目: ${ids.join(',')}`);
      const top2 = hits.slice(0, 2).map((h) => h.itemId);
      assert.ok(!top2.includes('d3'), `天气不应在前 2: ${top2.join(',')}`);
    } finally { close(); }
  });

  it('降级路径：available=false 时内存重排仍能检索', () => {
    const { vr, close } = makeVRWith(SEED);
    try {
      (vr as any).vecAvailable = false;
      (vr as any).vecTableReady = false;
      const hits = vr.search('硬编码常量', { limit: 2 });
      assert.ok(hits.length > 0);
      assert.ok(hits.some((h) => h.itemId === 'd1'));
    } finally { close(); }
  });

  it('collection 过滤生效', () => {
    const { vr, close } = makeVRWith(SEED);
    try {
      const hits = vr.search('安全', { limit: 10, collection: 'audit' });
      assert.ok(hits.every((h) => h.collection === 'audit'));
    } finally { close(); }
  });

  it('stats 返回嵌入器信息', () => {
    const { vr, close } = makeVRWith(SEED);
    try {
      const s = vr.stats();
      assert.equal(s.embedder, 'hash-ngram');
      assert.equal(typeof s.dim, 'number');
      assert.equal(typeof s.available, 'boolean');
    } finally { close(); }
  });
});

describe('KnowledgeHub — 统一 RAG 检索入口', () => {
  it('searchSemantic 走 RAG（不再依赖 data_vec）', async () => {
    const { hub, close } = makeHub();
    try {
      hub.putData({ collection: 'audit', itemId: 'f1', content: { note: '代码审计发现三处硬编码密钥' }, tags: ['安全'] });
      hub.putData({ collection: 'audit', itemId: 'f2', content: { note: '存在不安全常量配置' }, tags: ['安全'] });
      hub.putData({ collection: 'notes', itemId: 'n1', content: { note: '今天天气适合散步' }, tags: ['日常'] });
      const hits = await hub.searchSemantic('不安全硬编码常量', { limit: 3 });
      assert.ok(hits.length > 0);
      const ids = hits.map((h) => h.itemId);
      assert.ok(ids.includes('f1') || ids.includes('f2'));
      assert.ok(hits.every((h) => h.matchedBy === 'semantic'), 'vector 模式只能标 semantic');
      assert.equal(hub.ragStatus().store.chunks > 0, true, '应写入 rag_chunks（唯一向量存储）');
    } finally {
      close();
    }
  });

  it('searchHybrid：RAG 融合 + 文档级去重', async () => {
    const { hub, close } = makeHub();
    try {
      // 同一文档多段都命中，确保 doc 级只返回一次
      hub.putData({ collection: 'kb', itemId: 'a', content: { t: '代码审计硬编码。'.repeat(40) } });
      hub.putData({ collection: 'kb', itemId: 'b', content: { t: '安全常量配置问题' } });
      hub.putData({ collection: 'kb', itemId: 'c', content: { t: '无关的天气记录' } });
      const res = await hub.searchHybrid('硬编码', { limit: 3 });
      const a = res.find((r) => r.itemId === 'a');
      assert.ok(a, 'a 应被召回');
      assert.ok(['both', 'keyword'].includes(a!.matchedBy));
      assert.equal(res.filter((r) => r.itemId === 'a').length, 1, '同一文档只能出现一次');
      assert.ok((a!.chunkHits ?? 0) >= 1);
      // 只断言相关性排序：a 必须排在无关的 c 之前（小语料下 c 仍可能进入 top-k）
      const ci = res.findIndex((r) => r.itemId === 'c');
      const ai = res.findIndex((r) => r.itemId === 'a');
      assert.ok(ci === -1 || ai < ci, `a 应排在 c 之前（a=${ai}, c=${ci}）`);
    } finally {
      close();
    }
  });

  it('deleteData 后 RAG 不再召回（级联删块）', async () => {
    const { hub, close } = makeHub();
    try {
      hub.putData({ collection: 'kb', itemId: 'x', content: { t: '待删除的条目内容' } });
      assert.ok((await hub.searchSemantic('待删除', { limit: 5 })).some((h) => h.itemId === 'x'));
      hub.deleteData('kb', 'x');
      const ghost = await hub.searchSemantic('待删除', { limit: 5 });
      assert.ok(!ghost.some((h) => h.itemId === 'x'), '已删除条目不应被语义召回');
    } finally {
      close();
    }
  });

  it('stats.vector 报告统一 RAG 层（不再是 hash 维度的 data_vec）', () => {
    const { hub, close } = makeHub();
    try {
      const s = hub.stats();
      assert.ok('vector' in s);
      assert.equal(s.vector.engine, 'rag');
      assert.equal(s.vector.available, true);
      assert.equal(s.vector.embedder, 'hash-ngram');
      assert.equal(s.vector.count, s.vector.chunks);
    } finally {
      close();
    }
  });
});
