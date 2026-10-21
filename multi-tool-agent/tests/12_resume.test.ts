import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRuntime, mockProvider, makeCtx } from './helpers.js';
import type { MockResponder } from '../src/llm/MockProvider.js';
import type { RunInput } from '../src/types.js';

test('12) 从有效检查点恢复任务', async () => {
  const { runtime } = makeRuntime();
  // 第一次运行因 maxModelCalls=1 在中途触及限制；恢复后继续完成
  const responder: MockResponder = ({ callIndex }) => {
    if (callIndex === 0) {
      return { stopReason: 'tool_use', content: '搜索', toolCalls: [{ id: 'c1', name: 'search_files', arguments: { pattern: 'export function', kind: 'content' } }] };
    }
    if (callIndex === 1) {
      return { stopReason: 'tool_use', content: '读取', toolCalls: [{ id: 'c2', name: 'read_file', arguments: { path: 'src/calc.js' } }] };
    }
    return { stopReason: 'end_turn', content: '完成。' };
  };
  const input: RunInput = { runType: 'codebase', goal: 'g', repoPath: makeCtx().repoPath, maxModelCalls: 1, maxSteps: 10 };
  const runId = runtime.createRun(input, mockProvider(responder));

  const first = await runtime.run(input, runId);
  assert.equal(first.status, 'limit_reached');
  assert.equal(first.triggeredLimit, 'maxModelCalls');
  assert.equal(first.toolCalls, 1); // 仅执行了第一个工具

  // 从检查点恢复（放宽预算）
  const resumed = await runtime.resume(runId);
  assert.equal(resumed.status, 'completed');
  assert.ok(resumed.toolCalls >= 2, '恢复后应继续执行第二个工具');
  // 恢复后最终答案应存在
  assert.ok(resumed.finalAnswer && resumed.finalAnswer.length > 0);
});
