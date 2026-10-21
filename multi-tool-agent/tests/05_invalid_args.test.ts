import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRuntime, mockProvider, makeCtx } from './helpers.js';
import type { MockResponder } from '../src/llm/MockProvider.js';
import type { RunInput } from '../src/types.js';

test('5) 工具参数不符合 Schema：被拒绝并反馈 INVALID_ARGS', async () => {
  const { runtime } = makeRuntime();
  const responder: MockResponder = ({ callIndex }) => {
    if (callIndex === 0) {
      // 缺少必填字段 pattern
      return { stopReason: 'tool_use', content: '搜索', toolCalls: [{ id: 'c1', name: 'search_files', arguments: { kind: 'content' } }] };
    }
    return { stopReason: 'end_turn', content: '参数错误已反馈。' };
  };
  const input: RunInput = { runType: 'codebase', goal: 'g', repoPath: makeCtx().repoPath };
  const runId = runtime.createRun(input, mockProvider(responder));
  const result = await runtime.run(input, runId);

  assert.equal(result.status, 'completed');
  // 说明：为了让模型（和子 Agent 的小预算）少踩「参数名不对就白耗一次调用」的坑，
  // 工具现在接受别名（pattern|query|keyword），并对"参数全缺"给出 MISSING_ARGS + 示例。
  // 两者都是**被拒绝并回喂给模型**，故这里接受任一：核心断言是"参数问题被拒绝且反馈"。
  const failed = runtime
    .getEvents(runId)
    .find((e) => e.type === 'tool_failed' && ['INVALID_ARGS', 'MISSING_ARGS'].includes((e.data as any)?.code));
  assert.ok(failed, '应记录参数校验失败事件');
  assert.match(String((failed!.data as any).message), /pattern|示例/);
});
