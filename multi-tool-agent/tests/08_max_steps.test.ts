import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRuntime, mockProvider, makeCtx } from './helpers.js';
import type { MockResponder } from '../src/llm/MockProvider.js';
import type { RunInput } from '../src/types.js';

test('8) 模型无限请求工具时触发最大步骤限制', async () => {
  const { runtime } = makeRuntime();
  // 始终返回工具调用，绝不结束
  const responder: MockResponder = () => ({
    stopReason: 'tool_use',
    content: '继续',
    toolCalls: [{ id: 'c1', name: 'search_files', arguments: { pattern: 'x', kind: 'content' } }],
  });
  const input: RunInput = { runType: 'codebase', goal: 'g', repoPath: makeCtx().repoPath, maxSteps: 4 };
  const runId = runtime.createRun(input, mockProvider(responder));
  const result = await runtime.run(input, runId);

  assert.equal(result.status, 'limit_reached');
  assert.equal(result.triggeredLimit, 'maxSteps');
  assert.ok(result.steps >= 4);
});
