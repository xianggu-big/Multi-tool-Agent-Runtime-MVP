// tests/48_awaiting_user.test.ts — 人机协同：ask_user 工具 + awaiting_user 终态
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRuntime, makeCtx } from './helpers.js';
import { canTransition, RESUMABLE } from '../src/runtime/StateMachine.js';
import { recordToResult } from '../src/store/SqliteStore.js';
import { buildTraceSnapshot } from '../src/trace/Tracer.js';
import type { LLMProvider, LLMResponse, RunInput } from '../src/types.js';

class AskProvider implements LLMProvider {
  readonly name = 'ask';
  calls = 0;
  async chat(): Promise<LLMResponse> {
    this.calls++;
    return {
      stopReason: 'tool_use',
      content: '',
      toolCalls: [
        {
          id: 't1',
          name: 'ask_user',
          arguments: {
            questions: ['要分析 src/tools 还是整个仓库？', '是否允许运行测试？'],
            reason: '范围与测试权限不明确',
            context: '已确认仓库根目录可用。',
          },
        },
      ],
      usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25, costUsd: 0, isEstimate: true },
      latencyMs: 1,
      model: 'ask',
    };
  }
}

test('48a) 状态机：running 可进入 awaiting_user；awaiting_user 是终态但允许取消', () => {
  assert.equal(canTransition('running', 'awaiting_user'), true);
  assert.equal(canTransition('waiting_tool', 'awaiting_user'), true);
  assert.equal(canTransition('awaiting_user', 'cancelled'), true);
  assert.equal(canTransition('awaiting_user', 'running'), false);
  assert.ok(!RESUMABLE.includes('awaiting_user'), '当前回答走「新一轮任务 + contextHistory」，不冒充断点续跑');
});

test('48b) ask_user 工具：终结性、权限 agent:ask、问题数组必填', () => {
  const { registry } = makeRuntime();
  const tool = registry.get('ask_user');
  assert.ok(tool, 'ask_user 应已注册');
  assert.equal(tool!.terminal, true);
  assert.equal(tool!.permission, 'agent:ask');
  assert.equal(tool!.riskLevel, 'safe');
  const result = tool!.execute(
    { questions: ['确认目录？'], reason: '范围不明确' },
    makeCtx({ runType: 'misc', allowedPermissions: ['agent:ask'] }),
  ) as { ok: boolean; data?: { questions: string[] } };
  assert.equal(result.ok, true);
  assert.deepEqual(result.data?.questions, ['确认目录？']);
});

test('48c) Runtime：模型调用 ask_user 后 run 进入 awaiting_user，而不是 completed', async () => {
  const { runtime, store, logger } = makeRuntime();
  const provider = new AskProvider();
  const input: RunInput = { runType: 'misc', goal: '帮我分析一个不确定范围的仓库' };
  const runId = runtime.createRun(input, provider);
  const result = await runtime.run(input, runId);
  logger.flush();

  assert.equal(result.status, 'awaiting_user');
  assert.equal(provider.calls, 1, 'ask_user 是终结性工具，不应再多跑一轮模型');
  assert.deepEqual(result.awaitingUser?.questions, ['要分析 src/tools 还是整个仓库？', '是否允许运行测试？']);
  assert.equal(result.awaitingUser?.reason, '范围与测试权限不明确');
  assert.match(result.finalAnswer || '', /需要你回答以下问题后继续/);
  assert.match(result.finalAnswer || '', /1\. 要分析 src\/tools/);

  // 落库与解包：刷新/重启后仍能拿到问题
  const rec = store.getRun(runId)!;
  assert.equal(rec.status, 'awaiting_user');
  const restored = recordToResult(rec);
  assert.deepEqual(restored.awaitingUser?.questions, result.awaitingUser?.questions);

  // 事件：显式终态事件，且不再被当作孤儿 running
  const events = store.getEvents(runId);
  assert.ok(events.some((e) => e.type === 'run_awaiting_user'), '应有 run_awaiting_user 事件');
  assert.ok(!store.listOrphanRuns().some((o) => o.runId === runId), 'awaiting_user 不应被当作孤儿 running');

  // Trace：run 根 span 正常收尾（status=ok），并生成“最终答案”节点
  const snap = buildTraceSnapshot(runId, result.status, events);
  assert.equal(snap.spans.find((s) => s.spanId === runId)?.status, 'ok');
  const answerSpan = snap.spans.find((s) => s.kind === 'answer');
  assert.ok(answerSpan, '应生成最终答案 span');
  assert.match(String(answerSpan!.outputs?.finalAnswer || ''), /需要你回答/);
});