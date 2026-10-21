import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRuntime, mockProvider, makeCtx } from './helpers.js';
import type { MockResponder } from '../src/llm/MockProvider.js';
import type { ChatMessage, RunInput } from '../src/types.js';

test('3) 模型根据第一个工具的结果选择第二个工具', async () => {
  const { runtime } = makeRuntime();
  const responder: MockResponder = ({ messages, callIndex }) => {
    if (callIndex === 0) {
      return { stopReason: 'tool_use', content: '搜索', toolCalls: [{ id: 'c1', name: 'search_files', arguments: { pattern: 'export function', kind: 'content' } }] };
    }
    const last = messages.filter((m: ChatMessage) => m.role === 'tool').pop();
    const parsed = last ? JSON.parse(last.content) : null;
    const file = parsed?.data?.matches?.[0]?.file as string | undefined;
    if (last?.toolName === 'search_files') {
      return { stopReason: 'tool_use', content: '读取', toolCalls: [{ id: 'c2', name: 'read_file', arguments: { path: file ?? 'src/calc.js' } }] };
    }
    return { stopReason: 'end_turn', content: '完成。' };
  };
  const input: RunInput = { runType: 'codebase', goal: '分析', repoPath: makeCtx().repoPath };
  const runId = runtime.createRun(input, mockProvider(responder));
  const result = await runtime.run(input, runId);

  assert.equal(result.status, 'completed');
  assert.equal(result.toolCalls, 2);
  // 第二个工具读取的文件应来自第一次搜索结果（在仓库内）
  const readEvent = runtime.getEvents(runId).find((e) => e.type === 'tool_call_requested' && (e.data as any)?.name === 'read_file');
  assert.ok(readEvent, '应存在 read_file 调用');
  const path = (readEvent!.data as any).arguments.path as string;
  assert.match(path, /\.js$/);
  assert.ok(!path.includes('..'));
});
