import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRuntime, mockProvider, makeCtx } from './helpers.js';
import type { MockResponder } from '../src/llm/MockProvider.js';
import type { RunInput } from '../src/types.js';

test('9a) 达到最大模型调用次数时停止', async () => {
  const { runtime } = makeRuntime();
  const responder: MockResponder = () => ({
    stopReason: 'tool_use',
    content: '继续',
    toolCalls: [{ id: 'c1', name: 'search_files', arguments: { pattern: 'x', kind: 'content' } }],
  });
  const input: RunInput = { runType: 'codebase', goal: 'g', repoPath: makeCtx().repoPath, maxModelCalls: 2 };
  const runId = runtime.createRun(input, mockProvider(responder));
  const result = await runtime.run(input, runId);

  assert.equal(result.status, 'limit_reached');
  assert.equal(result.triggeredLimit, 'maxModelCalls');
  assert.equal(result.modelCalls, 2);
});

test('9b) 达到最大工具调用次数时停止', async () => {
  const { runtime } = makeRuntime();
  // 每次响应请求 2 个工具调用
  const responder: MockResponder = () => ({
    stopReason: 'tool_use',
    content: '继续',
    toolCalls: [
      { id: 'c1', name: 'search_files', arguments: { pattern: 'a', kind: 'content' } },
      { id: 'c2', name: 'list_files', arguments: { dir: '.', maxDepth: 1 } },
    ],
  });
  const input: RunInput = { runType: 'codebase', goal: 'g', repoPath: makeCtx().repoPath, maxToolCalls: 3 };
  const runId = runtime.createRun(input, mockProvider(responder));
  const result = await runtime.run(input, runId);

  assert.equal(result.status, 'limit_reached');
  assert.equal(result.triggeredLimit, 'maxToolCalls');
  assert.ok(result.toolCalls >= 3);
});
