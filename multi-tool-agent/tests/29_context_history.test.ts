// tests/29_context_history.test.ts — 多轮上下文：follow-up 提问不再丢前文
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildRuntime } from '../src/runtime/index.js';
import { mockProvider } from './helpers.js';
import type { MockResponder } from '../src/llm/MockProvider.js';
import type { RunInput } from '../src/types.js';

const WORKSPACE = resolve('demo/codebase-sample');

test('29a) contextHistory 会被插到 system 之后、本次 goal 之前（模型能看到前文）', async () => {
  const config = loadConfig();
  config.stream.liveDeltas = false;
  const { runtime, store } = buildRuntime(config, ':memory:');

  const captured: Array<{ role: string; content: string }> = [];
  const responder: MockResponder = (ctx) => {
    captured.push(...ctx.messages.map((m) => ({ role: m.role, content: String(m.content) })));
    return { stopReason: 'end_turn', content: '收到，这是后续回答' };
  };

  const input: RunInput = {
    runType: 'codebase',
    goal: '那第一点再展开讲讲？',
    repoPath: WORKSPACE,
    contextHistory: [
      { role: 'user', content: '帮我看看这个文件有什么改进方案' },
      { role: 'assistant', content: '有 3 点：安全性、健壮性、可读性' },
    ],
  };
  const runId = runtime.createRun(input, mockProvider(responder));
  const result = await runtime.run(input, runId);

  assert.equal(result.status, 'completed');
  // 顺序：system → 历史说明（R18）→ 历史 user → 历史 assistant → 本次 goal
  const roles = captured.map((m) => m.role);
  assert.equal(roles[0], 'system');
  assert.match(captured[1].content, /历史对话说明/, 'R18：历史之前有跨模式说明');
  assert.equal(roles[2], 'user', '第一问');
  assert.equal(captured[2].content, '帮我看看这个文件有什么改进方案');
  assert.equal(roles[3], 'assistant', '第一答');
  assert.equal(roles[4], 'user', '本次 goal');
  assert.equal(captured[4].content, '那第一点再展开讲讲？');

  store.close();
});

test('29b) 无 contextHistory 时行为不变（消息只有 system + goal）', async () => {
  const config = loadConfig();
  config.stream.liveDeltas = false;
  const { runtime, store } = buildRuntime(config, ':memory:');

  const captured: Array<{ role: string; content: string }> = [];
  const responder: MockResponder = (ctx) => {
    captured.push(...ctx.messages.map((m) => ({ role: m.role, content: String(m.content) })));
    return { stopReason: 'end_turn', content: 'ok' };
  };

  const input: RunInput = { runType: 'codebase', goal: '单独一个问题', repoPath: WORKSPACE };
  const runId = runtime.createRun(input, mockProvider(responder));
  await runtime.run(input, runId);

  assert.equal(captured.length, 2);
  assert.equal(captured[0].role, 'system');
  assert.equal(captured[1].role, 'user');
  store.close();
});
