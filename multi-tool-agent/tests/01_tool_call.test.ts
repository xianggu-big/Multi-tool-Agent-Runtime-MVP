import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRuntime, mockProvider, makeCtx } from './helpers.js';
import type { MockResponder } from '../src/llm/MockProvider.js';
import type { RunInput } from '../src/types.js';

test('1) 模型调用一个工具，收到结果后返回最终答案', async () => {
  const { runtime } = makeRuntime();
  const responder: MockResponder = ({ callIndex }) => {
    if (callIndex === 0) {
      return { stopReason: 'tool_use', content: '调用搜索', toolCalls: [{ id: 'c1', name: 'search_files', arguments: { pattern: 'add', kind: 'content' } }] };
    }
    return { stopReason: 'end_turn', content: '最终答案：在仓库中找到了 add 函数。' };
  };
  const input: RunInput = { runType: 'codebase', goal: '找 add 函数', repoPath: makeCtx().repoPath };
  const runId = runtime.createRun(input, mockProvider(responder));
  const result = await runtime.run(input, runId);

  assert.equal(result.status, 'completed');
  assert.equal(result.toolCalls, 1);
  assert.equal(result.modelCalls, 2);
  assert.match(result.finalAnswer ?? '', /add/);
});
