// tests/79_rag_unified.test.ts — RAG 双轨统一（P0）
// 覆盖：
//   79a 写入/检索只维护 rag_chunks，不再创建或写入 data_vec；
//   79b keyword / semantic / hybrid 三种模式都走同一条 RAG 管线；
//   79c 文档级去重：同一文档多个 chunk 只返回一次，并保留 chunkHits；
//   79d collection 元数据过滤下推到 RAG；
//   79e 删除后级联清理，不再召回；
//   79f stats.vector 报告统一 RAG 层（docs/chunks/embedder）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeHub } from '../src/knowledge/index.js';
import { loadConfig } from '../src/config.js';
import { EventLogger } from '../src/trace/EventLogger.js';
import { Tracer } from '../src/trace/Tracer.js';
import { ErrorReporter } from '../src/runtime/errorReporter.js';

function openHub(db: Database.Database): KnowledgeHub {
  return new KnowledgeHub(db, new Tracer(new EventLogger({ maxContentChars: 1000 })), new ErrorReporter());
}

function seed(hub: KnowledgeHub): void {
  hub.putData({ collection: 'kb', itemId: 'a', content: { t: '代码审计发现三处硬编码密钥。'.repeat(160) } });
  hub.putData({ collection: 'kb', itemId: 'b', content: { t: '安全常量配置问题与修复建议。' } });
  hub.putData({ collection: 'notes', itemId: 'n1', content: { t: '今天天气适合散步。' } });
}

test('79a) 单一写入路径：只写 rag_chunks，不再创建 data_vec', async () => {
  const db = new Database(':memory:');
  const hub = openHub(db);
  seed(hub);
  const hits = await hub.searchSemantic('硬编码密钥', { limit: 3 });
  assert.ok(hits.some((h) => h.itemId === 'a'), '语义模式应召回 a');

  const legacy = db.prepare("SELECT name FROM sqlite_master WHERE name = 'data_vec'").get();
  assert.equal(legacy, undefined, '统一后不应再创建旧 sqlite-vec 表');
  assert.ok(hub.ragStatus().store.chunks > 0, '向量应落在 rag_chunks');
  db.close();
});

test('79b) 三种模式都走统一 RAG 管线，并暴露实际 ragMode', async () => {
  const db = new Database(':memory:');
  const hub = openHub(db);
  seed(hub);

  const kw = await hub.searchKnowledge('硬编码', { mode: 'keyword', limit: 3 });
  assert.equal(kw.ragMode, 'keyword');
  assert.ok(kw.hits.some((h) => h.itemId === 'a'));
  assert.ok(kw.hits.every((h) => h.matchedBy === 'keyword'));

  const sem = await hub.searchKnowledge('硬编码密钥', { mode: 'semantic', limit: 3 });
  assert.equal(sem.ragMode, 'vector');
  assert.ok(sem.hits.some((h) => h.itemId === 'a'));
  assert.ok(sem.hits.every((h) => h.matchedBy === 'semantic'));

  const hy = await hub.searchKnowledge('硬编码', { mode: 'hybrid', limit: 3 });
  assert.equal(hy.ragMode, 'hybrid_rerank');
  assert.ok(hy.hits.some((h) => h.itemId === 'a'));
  db.close();
});

test('79c) 文档级去重：长文档多个 chunk 只出现一次，chunkHits 记录命中块数', async () => {
  const db = new Database(':memory:');
  const hub = openHub(db);
  seed(hub);
  const res = await hub.searchHybrid('硬编码密钥', { limit: 5 });
  const aHits = res.filter((h) => h.itemId === 'a');
  assert.equal(aHits.length, 1, '同一文档只能返回一次');
  assert.ok(aHits[0].chunkHits >= 2, `长文档应命中多个 chunk（实际 ${aHits[0].chunkHits}）`);
  db.close();
});

test('79d) collection 过滤在 RAG 路径生效', async () => {
  const db = new Database(':memory:');
  const hub = openHub(db);
  seed(hub);
  const res = await hub.searchKnowledge('安全', { mode: 'hybrid', limit: 10, collection: 'kb' });
  assert.ok(res.hits.length > 0);
  assert.ok(res.hits.every((h) => h.collection === 'kb'), '只应返回 kb 集合');
  assert.equal(res.collection, 'kb');
  db.close();
});

test('79e) 删除后 RAG 级联清理，不再召回', async () => {
  const db = new Database(':memory:');
  const hub = openHub(db);
  seed(hub);
  assert.ok((await hub.searchSemantic('硬编码密钥', { limit: 3 })).some((h) => h.itemId === 'a'));

  hub.deleteData('kb', 'a');
  const after = await hub.searchSemantic('硬编码密钥', { limit: 5 });
  assert.ok(!after.some((h) => h.itemId === 'a'), '已删除文档不应被召回');
  db.close();
});

test('79f) stats.vector 报告统一 RAG 层（docs/chunks/embedder）', async () => {
  const db = new Database(':memory:');
  const hub = openHub(db);
  seed(hub);
  await hub.searchKnowledge('硬编码', { mode: 'keyword', limit: 3 });

  const v = hub.stats().vector;
  assert.equal(v.engine, 'rag');
  assert.equal(v.built, true);
  assert.equal(v.docs, 3);
  assert.equal(v.count, v.chunks);
  assert.ok(v.chunks >= 3);
  assert.equal(v.embedder, 'hash-ngram');
  assert.equal(v.dim, 256);
  const status = hub.ragStatus();
  assert.equal(status.engine, 'rag');
  assert.equal(status.legacyVector.active, false);
  db.close();
});

test('79g) HTTP /api/knowledge/search：三 mode 同管线，collection 过滤生效', async () => {
  const { createApp } = await import('../src/server.js');
  const dir = mkdtempSync(join(tmpdir(), 'mta-rag-unified-'));
  const config = loadConfig();
  config.sqlitePath = join(dir, 'runtime.db');
  config.stream.liveDeltas = false;
  config.log.errorLogPath = join(dir, 'errors.log');
  const { app, store, knowledge } = createApp(config);
  knowledge.putData({ collection: 'kb', itemId: 'a', content: { t: '硬编码密钥与不安全常量' } });
  knowledge.putData({ collection: 'notes', itemId: 'n', content: { t: '硬编码只是笔记里的词' } });

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const kw = (await (await fetch(`${base}/api/knowledge/search?q=硬编码&mode=keyword&collection=kb`)).json()) as any;
    assert.equal(kw.engine, 'rag');
    assert.equal(kw.ragMode, 'keyword');
    assert.ok(Array.isArray(kw.items) && kw.items.length > 0);
    assert.ok(kw.items.every((h: any) => h.collection === 'kb'));

    const sem = (await (await fetch(`${base}/api/knowledge/search?q=硬编码密钥&mode=semantic&collection=kb`)).json()) as any;
    assert.equal(sem.ragMode, 'vector');
    assert.ok(Array.isArray(sem.hits) && sem.hits.length > 0);
    assert.equal(sem.hits[0].itemId, 'a');

    const hy = (await (await fetch(`${base}/api/knowledge/search?q=硬编码&mode=hybrid`)).json()) as any;
    assert.equal(hy.ragMode, 'hybrid_rerank');
    assert.ok(Array.isArray(hy.hits));
    assert.ok(typeof hy.latencyMs === 'number');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});

test('79h) ingest-docs --replace 在没有 data_vec 的新库上可执行（回归）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mta-ingest-replace-'));
  const dbPath = join(dir, 'runtime.db');
  writeFileSync(join(dir, 'a.md'), '# 标题\n\n用于测试 --replace 的正文。', 'utf8');
  const env = { ...process.env, SQLITE_PATH: dbPath, MTA_EMBEDDING_MODEL: '' };
  const run = (extra: string[] = []) =>
    spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/ingest-docs.ts', '--dir', dir, '--collection', 'docs', ...extra],
      { cwd: process.cwd(), env, encoding: 'utf8' },
    );
  try {
    const first = run();
    assert.equal(first.status, 0, `首次导入失败：${first.stderr}`);
    const replaced = run(['--replace']);
    assert.equal(replaced.status, 0, `--replace 失败（可能又 prepare 了不存在的 data_vec）：${replaced.stderr}`);

    const db = new Database(dbPath, { readonly: true });
    try {
      assert.equal((db.prepare('SELECT COUNT(*) AS c FROM data_items').get() as { c: number }).c, 1);
      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'data_vec'").get(), undefined);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
