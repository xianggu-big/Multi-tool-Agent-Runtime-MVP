import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRuntime, mockProvider, makeCtx } from './helpers.js';
import type { MockResponder } from '../src/llm/MockProvider.js';
import type { RunInput } from '../src/types.js';

test('2a) 模型连续调用多个工具（顺序）', async () => {
  const { runtime } = makeRuntime();
  const responder: MockResponder = ({ callIndex }) => {
    if (callIndex === 0) {
      return { stopReason: 'tool_use', content: '搜索', toolCalls: [{ id: 'c1', name: 'search_files', arguments: { pattern: 'export function', kind: 'content' } }] };
    }
    if (callIndex === 1) {
      return { stopReason: 'tool_use', content: '读取', toolCalls: [{ id: 'c2', name: 'read_file', arguments: { path: 'src/calc.js' } }] };
    }
    return { stopReason: 'end_turn', content: '完成：已搜索并读取。' };
  };
  const input: RunInput = { runType: 'codebase', goal: '分析', repoPath: makeCtx().repoPath };
  const runId = runtime.createRun(input, mockProvider(responder));
  const result = await runtime.run(input, runId);
  assert.equal(result.status, 'completed');
  assert.equal(result.toolCalls, 2);
});

test('2b) 一次响应包含多个工具调用（并行执行并分别记录）', async () => {
  const { runtime } = makeRuntime();
  const responder: MockResponder = ({ callIndex }) => {
    if (callIndex === 0) {
      return {
        stopReason: 'tool_use',
        content: '同时搜索与列出',
        toolCalls: [
          { id: 'c1', name: 'search_files', arguments: { pattern: 'function', kind: 'content' } },
          { id: 'c2', name: 'list_files', arguments: { dir: '.', maxDepth: 2 } },
        ],
      };
    }
    return { stopReason: 'end_turn', content: '完成。' };
  };
  const input: RunInput = { runType: 'codebase', goal: '并行', repoPath: makeCtx().repoPath };
  const runId = runtime.createRun(input, mockProvider(responder));
  const result = await runtime.run(input, runId);
  assert.equal(result.status, 'completed');
  assert.equal(result.toolCalls, 2);
  const events = runtime.getEvents(runId);
  const completed = events.filter((e) => e.type === 'tool_completed').length;
  assert.equal(completed, 2);
});
