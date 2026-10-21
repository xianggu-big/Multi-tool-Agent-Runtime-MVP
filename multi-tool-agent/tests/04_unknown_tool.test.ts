import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRuntime, mockProvider } from './helpers.js';
import type { MockResponder } from '../src/llm/MockProvider.js';
import type { RunInput } from '../src/types.js';

test('4) 模型返回不存在的工具：被拒绝并反馈错误（不执行）', async () => {
  const { runtime } = makeRuntime();
  const responder: MockResponder = ({ callIndex }) => {
    if (callIndex === 0) {
      return { stopReason: 'tool_use', content: '调用未知工具', toolCalls: [{ id: 'c1', name: 'nonexistent_tool', arguments: {} }] };
    }
    return { stopReason: 'end_turn', content: '已收到拒绝反馈，给出结论。' };
  };
  const input: RunInput = { runType: 'codebase', goal: 'g', repoPath: process.cwd() };
  const runId = runtime.createRun(input, mockProvider(responder));
  const result = await runtime.run(input, runId);

  assert.equal(result.status, 'completed');
  const failed = runtime.getEvents(runId).find((e) => e.type === 'tool_failed' && (e.data as any)?.code === 'UNKNOWN_TOOL');
  assert.ok(failed, '应记录 UNKNOWN_TOOL 失败事件');
  // 工具从未真正执行：仅 1 次工具调用请求且结果为错误
  assert.equal(result.toolCalls, 1);
});
