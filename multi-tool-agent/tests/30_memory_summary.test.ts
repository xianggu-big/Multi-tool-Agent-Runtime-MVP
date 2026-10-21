// tests/30_memory_summary.test.ts — 记忆压缩：超出活跃窗口的对话自动归纳，防记忆丢失
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildRuntime } from '../src/runtime/index.js';
import { extractiveSummarize, SUMMARY_WINDOW, ContextStore } from '../src/knowledge/context.js';
import { SqliteStore } from '../src/store/SqliteStore.js';
import { mockProvider } from './helpers.js';
import type { MockResponder } from '../src/llm/MockProvider.js';
import type { RunInput } from '../src/types.js';

const WORKSPACE = resolve('demo/codebase-sample');

test('30a) 超过 SUMMARY_WINDOW 轮后：历史轮次被归纳进 summary（重要上下文不丢）', () => {
  const config = loadConfig();
  const { store, knowledge } = buildRuntime(config, ':memory:');

  const sess = knowledge.openSession({ title: '长对话' }).session;
  // 写 8 轮（超过 SUMMARY_WINDOW=6）
  for (let i = 1; i <= 8; i++) {
    knowledge.appendTurn(sess.sessionId, { role: 'user', content: `第${i}个问题：关键信息${i}` });
    knowledge.appendTurn(sess.sessionId, { role: 'assistant', content: `第${i}个回答：结论${i}` });
  }

  const after = knowledge.context.getSession(sess.sessionId)!;
  assert.equal(after.turnCount, 16);
  assert.ok(after.summary, '超出窗口的历史应被归纳进 summary');
  assert.match(after.summary ?? '', /关键信息1|结论1/, '最早期轮次应出现在摘要里（没被丢）');
  // 活跃窗口内（最近 SUMMARY_WINDOW 轮）不应进摘要
  assert.doesNotMatch(after.summary ?? '', /第8个问题/, '最近窗口内的轮次应留在活跃上下文，不进摘要');

  // 幂等：再追加一轮，summarizedThroughTurn 推进、摘要更新但不重复
  knowledge.appendTurn(sess.sessionId, { role: 'user', content: '第9问' });
  const after2 = knowledge.context.getSession(sess.sessionId)!;
  assert.ok((after2.summary ?? '').length > 0);
  store.close();
});

test('30b) extractiveSummarize：问/答前缀 + 预算截断', () => {
  const turns = [
    { id: 1, sessionId: 's', turnNo: 1, role: 'user' as const, content: '你好', searchText: '你好', createdAt: '' },
    { id: 2, sessionId: 's', turnNo: 2, role: 'assistant' as const, content: '你好，有什么可以帮你', searchText: '', createdAt: '' },
  ];
  const s = extractiveSummarize(turns);
  assert.match(s, /问: 你好/);
  assert.match(s, /答: 你好/);
  // 小预算：先到先得，超预算的轮次被丢弃
  assert.equal(extractiveSummarize(turns, 6), '问: 你好');
});

test('30c) ContextStore 可注入自定义摘要器（LLM 摘要器升级点）', () => {
  const db = new SqliteStore(':memory:');
  const cs = new ContextStore(db.database, { summarizer: () => 'CUSTOM-SUMMARY' });
  const s = cs.openSession({ title: 'x' }).sessionId;
  for (let i = 0; i < SUMMARY_WINDOW + 2; i++) cs.appendTurn(s, { role: 'user', content: `q${i}` });
  assert.equal(cs.getSession(s)!.summary, 'CUSTOM-SUMMARY');
  db.close();
});

test('30d) contextSummary 注入为「之前对话摘要」消息（在历史之前、本次 goal 之前）', async () => {
  const config = loadConfig();
  config.stream.liveDeltas = false;
  const { runtime, store } = buildRuntime(config, ':memory:');

  const captured: Array<{ role: string; content: string }> = [];
  const responder: MockResponder = (ctx) => {
    captured.push(...ctx.messages.map((m) => ({ role: m.role, content: String(m.content) })));
    return { stopReason: 'end_turn', content: 'ok' };
  };

  const input: RunInput = {
    runType: 'codebase',
    goal: '这次呢？',
    repoPath: WORKSPACE,
    contextSummary: '之前聊了：问A答B；问C答D',
    contextHistory: [{ role: 'user', content: '最近一问' }],
  };
  const runId = runtime.createRun(input, mockProvider(responder));
  await runtime.run(input, runId);

  const roles = captured.map((m) => m.role);
  assert.equal(roles[0], 'system');
  assert.match(captured[1].content, /之前对话摘要/, '摘要消息在 system 之后');
  // R18（2026-10-16）：历史前插入「历史对话说明」（跨模式防误认）——有历史时才注入，且位于历史之前
  assert.match(captured[2].content, /历史对话说明/, '历史对话说明在历史之前');
  assert.equal(roles[3], 'user');
  assert.equal(captured[3].content, '最近一问', '历史在说明之后');
  assert.equal(captured[4].content, '这次呢？', '本次 goal 在最后');
  store.close();
});
