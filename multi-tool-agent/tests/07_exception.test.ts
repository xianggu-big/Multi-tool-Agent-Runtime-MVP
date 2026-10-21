import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ToolRegistry } from '../src/tools/Registry.js';
import { makeCtx, makeRuntime, mockProvider } from './helpers.js';
import type { MockResponder } from '../src/llm/MockProvider.js';
import type { RunInput } from '../src/types.js';

test('7a) 工具执行抛出异常：规范化为 EXECUTION_ERROR（默认不可重试）', async () => {
  const reg = new ToolRegistry();
  reg.register({
    name: 'boom',
    description: 'boom',
    inputSchema: z.object({}),
    timeoutMs: 1000,
    permission: 'codebase:read',
    riskLevel: 'safe',
    execute: async () => {
      throw new Error('kaboom');
    },
  });
  const res = await reg.execute('boom', {}, makeCtx());
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error?.code, 'EXECUTION_ERROR');
  assert.equal(res.result.retryable, false);
});

test('7b) 工具执行失败（返回错误结果）后 Runtime 受控恢复并继续', async () => {
  const { runtime } = makeRuntime();
  // 不提供 repoPath，search_files 将返回 CONFIG 错误结果
  const responder: MockResponder = ({ callIndex }) => {
    if (callIndex === 0) {
      return { stopReason: 'tool_use', content: '搜索', toolCalls: [{ id: 'c1', name: 'search_files', arguments: { pattern: 'x', kind: 'content' } }] };
    }
    return { stopReason: 'end_turn', content: '工具返回错误，但任务仍可按受控策略继续并给出结论。' };
  };
  const input: RunInput = { runType: 'codebase', goal: 'g' };
  const runId = runtime.createRun(input, mockProvider(responder));
  const result = await runtime.run(input, runId);

  assert.equal(result.status, 'completed');
  const failed = runtime.getEvents(runId).find((e) => e.type === 'tool_failed');
  assert.ok(failed, '应记录工具失败事件');
});
