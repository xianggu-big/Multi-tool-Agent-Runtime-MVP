// tests/26_knowledge.test.ts — 知识系统：上下文管理 + 历史与变更追踪 + 数据仓库
// 覆盖：三模块各自能力 + 互通可追溯（correlationId 贯穿）+ 孤儿运行回收（审计首个用例）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildRuntime } from '../src/runtime/index.js';
import { SqliteStore } from '../src/store/SqliteStore.js';
import { KnowledgeHub } from '../src/knowledge/index.js';
import { ErrorReporter } from '../src/runtime/errorReporter.js';
import { Tracer } from '../src/trace/Tracer.js';
import { EventLogger } from '../src/trace/EventLogger.js';

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'mta-kn-')), 'runtime.db');
}

function cfgFor(dbPath: string) {
  const config = loadConfig();
  config.sqlitePath = dbPath;
  config.stream.liveDeltas = false;
  config.log.errorLogPath = join(dirname(dbPath), 'errors.log');
  return config;
}

// ---------------------------------------------------------------------------
// 1. 数据仓库：分类 + 标签 + 持久化 + FTS5 高效检索
// ---------------------------------------------------------------------------

test('26a) Repository：CRUD + 分类维度 + FTS5 全文检索只命中相关条目', () => {
  const dbPath = tmpDb();
  const { store, knowledge, errors } = buildRuntime(cfgFor(dbPath));
  void errors;

  // 创建两条不同集合的数据
  const r1 = knowledge.putData({
    collection: 'notes',
    itemId: 'note-1',
    type: 'finding',
    tags: ['auth', 'security'],
    content: { title: '登录漏洞', body: '密码用明文传输，存在中间人风险' },
    createdBy: 'run_a',
  });
  const r2 = knowledge.putData({
    collection: 'notes',
    itemId: 'note-2',
    type: 'todo',
    tags: ['perf'],
    content: { title: '优化查询', body: '列表接口加索引' },
    createdBy: 'run_a',
  });
  assert.equal(r1.isCreate, true);
  assert.ok(r1.correlationId.startsWith('corr_'));

  // 按集合查
  const inNotes = knowledge.queryData({ collection: 'notes' });
  assert.equal(inNotes.length, 2);

  // 按标签查
  const tagged = knowledge.repository.list({ tag: 'auth' });
  assert.equal(tagged.length, 1);
  assert.equal(tagged[0].itemId, 'note-1');

  // 按类型查
  const todos = knowledge.repository.list({ type: 'todo' });
  assert.equal(todos.length, 1);
  assert.equal(todos[0].itemId, 'note-2');

  // FTS5 全文检索：只命中含"漏洞"的
  const hits = knowledge.searchData('漏洞');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].itemId, 'note-1');

  // 更新（同 collection+itemId → 覆盖）
  const r1b = knowledge.putData({ collection: 'notes', itemId: 'note-1', type: 'finding', tags: ['auth', 'fixed'], content: { title: '登录漏洞', body: '已改用 TLS' }, createdBy: 'run_a' });
  assert.equal(r1b.isCreate, false);
  assert.equal(knowledge.getData('notes', 'note-1')!.tags.includes('fixed'), true);

  // 删除
  const del = knowledge.deleteData('notes', 'note-2');
  assert.ok(del.deleted);
  assert.equal(knowledge.getData('notes', 'note-2'), null);
  assert.equal(knowledge.queryData({ collection: 'notes' }).length, 1);

  store.close();
});

// ---------------------------------------------------------------------------
// 2. 上下文管理：多轮保持 + 跨会话检索
// ---------------------------------------------------------------------------

test('26b) Context：多轮保持（滚动窗口）+ 跨会话 FTS 检索相关历史上下文', () => {
  const dbPath = tmpDb();
  const { store, knowledge } = buildRuntime(cfgFor(dbPath));

  const s1 = knowledge.openSession({ title: '调试登录' }).session;
  knowledge.appendTurn(s1.sessionId, { role: 'user', content: '登录接口为什么慢？' });
  knowledge.appendTurn(s1.sessionId, { role: 'assistant', content: '因为密码哈希用了 bcrypt cost=12' });
  knowledge.appendTurn(s1.sessionId, { role: 'user', content: '降到 8 吧' });

  const s2 = knowledge.openSession({ title: '性能优化' }).session;
  knowledge.appendTurn(s2.sessionId, { role: 'user', content: '列表接口加索引' });

  // 多轮保持：取最近 2 轮（应是最后两轮，顺序正）
  const recent = knowledge.getRecentContext(s1.sessionId, 2);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].turnNo, 2); // assistant
  assert.equal(recent[1].turnNo, 3); // user
  assert.equal(recent[0].role, 'assistant');

  // 跨会话检索：查"bcrypt"应命中 s1 的 assistant 轮
  const hits = knowledge.searchContext('bcrypt');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionId, s1.sessionId);
  assert.equal(hits[0].role, 'assistant');

  // 检索"索引"命中 s2
  const hits2 = knowledge.searchContext('索引');
  assert.equal(hits2.length, 1);
  assert.equal(hits2[0].sessionId, s2.sessionId);

  store.close();
});

// ---------------------------------------------------------------------------
// 3. 历史与变更追踪：审计 before/after + 按条件查询
// ---------------------------------------------------------------------------

test('26c) History：putData 记 before/after；按 action/actor/时间查询', () => {
  const dbPath = tmpDb();
  const { store, knowledge } = buildRuntime(cfgFor(dbPath));

  const r = knowledge.putData({ collection: 'cfg', itemId: 'k1', content: { v: 1 }, createdBy: 'run_x' });
  // 再更新一次（产生 before/after）
  knowledge.putData({ collection: 'cfg', itemId: 'k1', content: { v: 2 }, createdBy: 'run_x' });

  // 按 correlationId 追溯该次写操作
  const trace = knowledge.traceByCorrelation(r.correlationId);
  assert.equal(trace.length, 1);
  assert.equal(trace[0].action, 'data_create');
  assert.equal(trace[0].actor, 'run_x');
  assert.equal((trace[0].after as any).content.v, 1);

  // 按 action 查所有 data_update
  const updates = knowledge.queryHistory({ action: 'data_update' });
  assert.equal(updates.length, 1);
  assert.equal((updates[0].before as any).content.v, 1, 'before 是改前快照');
  assert.equal((updates[0].after as any).content.v, 2, 'after 是改后快照');

  // 按 resourceType 查
  const itemAudits = knowledge.queryHistory({ resourceType: 'data_item' });
  assert.equal(itemAudits.length, 2); // 1 create + 1 update

  // 按时间区间查（宽区间应全中）
  const all = knowledge.queryHistory({ from: '2000-01-01T00:00:00.000Z' });
  assert.equal(all.length, 2);

  store.close();
});

// ---------------------------------------------------------------------------
// 4. 互通与可追溯：一次操作 → audit + 事件 + 同一 correlationId 三处串联
// ---------------------------------------------------------------------------

test('26d) 互通：putData 的 correlationId 同时出现在 audit 与事件流，可一键串起', () => {
  const dbPath = tmpDb();
  const { store, knowledge, tracer } = buildRuntime(cfgFor(dbPath));
  const runId = 'run_interop_1';

  // 以 runId 归属：事件会持久化进该 run 的事件流
  const r = knowledge.putData(
    { collection: 'x', itemId: 'i1', content: { msg: 'hello' } },
    { actor: runId, runId },
  );

  // ① audit 里有这条
  const trace = knowledge.traceByCorrelation(r.correlationId);
  assert.equal(trace.length, 1);
  assert.equal(trace[0].resourceId, r.item.id);

  // ② 事件流里有 data_changed，且带同一 correlationId
  tracer.flush();
  const events = store.getEvents(runId);
  const ev = events.find((e) => e.type === 'data_changed');
  assert.ok(ev, '应产生 data_changed 事件');
  assert.equal((ev!.data as any).correlationId, r.correlationId, '事件与审计共用 correlationId');
  assert.equal((ev!.data as any).auditId, r.auditId, '事件携带 auditId，便于从事件回查审计');
  assert.equal((ev!.data as any).resourceId, r.item.id, '事件携带资源 id，便于从事件回查数据');

  // ③ 用 correlationId 能从任一入口串起来：audit → resourceId → 数据
  const audit = trace[0];
  const item = knowledge.repository.getById(audit.resourceId!);
  assert.ok(item);
  assert.equal((item!.content as any).msg, 'hello');

  store.close();
});

// ---------------------------------------------------------------------------
// 5. 统一时间线：runs + audit 合并
// ---------------------------------------------------------------------------

test('26e) Timeline：把会话记录(runs) 与 变更追踪(audit) 按时间合并', () => {
  const dbPath = tmpDb();
  const { store, knowledge } = buildRuntime(cfgFor(dbPath));

  // 造一个 run 记录 + 一条 audit
  store.createRun({
    runId: 'run_tl_1', runType: 'misc', status: 'completed', goal: 'g',
    createdAt: '2026-10-13T10:00:00.000Z', updatedAt: '2026-10-13T10:00:05.000Z',
    steps: 1, modelCalls: 1, toolCalls: 0, totalDurationMs: 100, usageJson: '{}', isMock: 1,
  });
  knowledge.putData({ collection: 't', itemId: 'a', content: { v: 1 } });

  const tl = knowledge.timeline({}, () => store.listRuns(100), (id) => store.getEvents(id));
  const sources = new Set(tl.map((e) => e.source));
  assert.ok(sources.has('run'), '含会话记录');
  assert.ok(sources.has('audit'), '含变更追踪');
  // 倒序
  for (let i = 1; i < tl.length; i++) {
    assert.ok(tl[i - 1].at >= tl[i].at, '时间线应倒序');
  }

  store.close();
});

// ---------------------------------------------------------------------------
// 6. 孤儿运行回收（知识系统「变更追踪」的首个真实用例）
// ---------------------------------------------------------------------------

test('26f) 重启回收：孤儿运行 → failed + runtime_error 事件(序号接续) + 审计记录', () => {
  const dbPath = tmpDb();

  // 第一个"进程"：建一个 running 的运行、写两条事件，然后"死掉"（不收尾）
  const s1 = new SqliteStore(dbPath);
  s1.createRun({
    runId: 'run_orphan_k', runType: 'orchestrator', status: 'running', goal: '清点仓库',
    createdAt: '2026-10-13T09:00:00.000Z', updatedAt: '2026-10-13T09:00:10.000Z',
    steps: 2, modelCalls: 3, toolCalls: 1, totalDurationMs: 0, usageJson: '{}', isMock: 0,
  });
  s1.appendEvent({ runId: 'run_orphan_k', seq: 1, type: 'run_started', timestamp: '2026-10-13T09:00:00.000Z', data: { name: 'run' } });
  s1.appendEvent({ runId: 'run_orphan_k', seq: 2, type: 'step_started', timestamp: '2026-10-13T09:00:05.000Z', data: {} });
  // 一个已完成的运行不应被动到
  s1.createRun({
    runId: 'run_done_k', runType: 'misc', status: 'completed', goal: 'done',
    createdAt: '2026-10-13T09:00:00.000Z', updatedAt: '2026-10-13T09:00:10.000Z',
    steps: 1, modelCalls: 1, toolCalls: 0, totalDurationMs: 50, usageJson: '{}', isMock: 1,
  });
  s1.close();

  // 第二个"进程"：buildRuntime 启动 → 自动回收
  const { store, knowledge, errors } = buildRuntime(cfgFor(dbPath));

  // 运行被标记 failed
  const orphan = store.getRun('run_orphan_k')!;
  assert.equal(orphan.status, 'failed');
  assert.equal(orphan.errorCode, 'RUN_INTERRUPTED');
  assert.match(orphan.failureReason ?? '', /中断/);

  // 事件序号接续（runtime_error seq=3；随后补一条 run_digest seq=4，回放仍连续）
  const events = store.getEvents('run_orphan_k');
  assert.equal(events.length, 4, 'runtime_error + run_digest');
  assert.equal(events[2].seq, 3);
  assert.equal(events[2].type, 'runtime_error');
  assert.equal(events[3].seq, 4);
  assert.equal(events[3].type, 'run_digest');
  assert.ok(store.getRunDigest('run_orphan_k'), '被中断的 run 也要有复盘摘要');
  const evData = events[2].data as any;
  assert.equal(evData.code, 'RUN_INTERRUPTED');
  assert.ok(evData.correlationId.startsWith('corr_orphan_'));

  // 审计里有 run_interrupted 记录，且 correlationId 与事件一致
  const audits = knowledge.queryHistory({ action: 'run_interrupted' });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].correlationId, evData.correlationId, '审计与事件共用 correlationId');
  assert.equal(audits[0].resourceId, 'run_orphan_k');
  assert.equal((audits[0].before as any).status, 'running');
  assert.equal((audits[0].after as any).status, 'failed');

  // 错误报告器里有这条（内存环）
  const reps = errors.list({ code: 'RUN_INTERRUPTED' });
  assert.equal(reps.length, 1);
  assert.equal(reps[0].runId, 'run_orphan_k');

  // 已完成的运行不被触碰
  assert.equal(store.getRun('run_done_k')!.status, 'completed');
  assert.equal(store.getEvents('run_done_k').length, 0);

  store.close();
});

// ---------------------------------------------------------------------------
// 7. 幂等：再次启动不会重复回收
// ---------------------------------------------------------------------------

test('26g) 幂等：已回收的运行在再次启动时不会重复报告', () => {
  const dbPath = tmpDb();
  // 第一次：建 orphan + 回收
  const s1 = new SqliteStore(dbPath);
  s1.createRun({ runId: 'run_orphan_k2', runType: 'misc', status: 'running', goal: 'g', createdAt: '2026-10-13T09:00:00.000Z', updatedAt: '2026-10-13T09:00:00.000Z', steps: 0, modelCalls: 0, toolCalls: 0, totalDurationMs: 0, usageJson: '{}', isMock: 0 });
  s1.close();
  const b1 = buildRuntime(cfgFor(dbPath));
  assert.equal(b1.store.getRun('run_orphan_k2')!.status, 'failed');
  const auditCount1 = b1.knowledge.queryHistory({ action: 'run_interrupted' }).length;
  assert.equal(auditCount1, 1);
  const eventsAfterFirst = b1.store.getEvents('run_orphan_k2').length;
  assert.equal(eventsAfterFirst, 2, 'runtime_error + run_digest');
  b1.store.close();

  // 第二次：应无新增
  const b2 = buildRuntime(cfgFor(dbPath));
  assert.equal(b2.store.getRun('run_orphan_k2')!.status, 'failed', '状态保持 failed');
  const auditCount2 = b2.knowledge.queryHistory({ action: 'run_interrupted' }).length;
  assert.equal(auditCount2, auditCount1, '已是终态，不应再次回收（审计数量不增加）');
  // 事件数也不应增加（二次启动不会再追加 runtime_error / run_digest）
  assert.equal(b2.store.getEvents('run_orphan_k2').length, eventsAfterFirst);
  b2.store.close();
});

// ---------------------------------------------------------------------------
// 8. 服务端 API 烟雾
// ---------------------------------------------------------------------------

test('26h) API：POST/GET /api/data、/api/context、/api/history、/api/history/timeline 全通', async () => {
  const { createApp } = await import('../src/server.js');
  const config = cfgFor(tmpDb());
  const { app, store, knowledge } = createApp(config);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    // 数据：创建 + 查询
    const cr = await fetch(`${base}/api/data`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ collection: 'api', itemId: 'd1', type: 'note', tags: ['t'], content: { body: 'API 测试 hello' }, actor: 'user1' }),
    });
    assert.equal(cr.status, 201);
    const cj = (await cr.json()) as any;
    assert.ok(cj.correlationId);

    const q = (await (await fetch(`${base}/api/data?q=hello`)).json()) as any;
    assert.equal(q.count, 1);
    assert.equal(q.items[0].itemId, 'd1');

    // 上下文：开会话 + 追加轮
    const cs = await fetch(`${base}/api/context`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'API 会话' }),
    });
    assert.equal(cs.status, 201);
    const csj = (await cs.json()) as any;
    const sid = csj.session.sessionId;
    const ct = await fetch(`${base}/api/context/${sid}/turns`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'user', content: '你好世界' }),
    });
    assert.equal(ct.status, 201);

    // 跨会话检索
    const sc = (await (await fetch(`${base}/api/context?q=你好`)).json()) as any;
    assert.equal(sc.mode, 'search');
    assert.equal(sc.count, 1);

    // 历史：按 action 查
    const h = (await (await fetch(`${base}/api/history?action=data_create`)).json()) as any;
    assert.ok(h.count >= 1);

    // 时间线
    const tl = (await (await fetch(`${base}/api/history/timeline?limit=50`)).json()) as any;
    assert.ok(tl.count >= 1);
    const srcs = new Set(tl.entries.map((e: any) => e.source));
    assert.ok(srcs.has('run') || srcs.has('audit'));

    // 统计
    const st = (await (await fetch(`${base}/api/knowledge/stats`)).json()) as any;
    assert.ok(st.repository.total >= 1);
    assert.ok(st.context.sessions >= 1);
    assert.ok(st.audit.total >= 1);

    // 按 correlationId 追溯
    const tr = (await (await fetch(`${base}/api/history/trace/${cj.correlationId}`)).json()) as any;
    assert.equal(tr.count, 1);
    assert.equal(tr.entries[0].action, 'data_create');

    void knowledge;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});
