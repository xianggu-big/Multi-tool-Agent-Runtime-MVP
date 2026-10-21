// tests/35_streaming_tool_call.test.ts — 流式 tool_call 首帧反馈（P1-4）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newOpenAIStreamState,
  accumulateOpenAIStreamChunk,
  buildResponseFromStreamState,
} from '../src/llm/OpenAIProvider.js';
import { MockProvider } from '../src/llm/MockProvider.js';
import type { LLMDelta } from '../src/types.js';

test('35a) accumulateOpenAIStreamChunk：首帧 tool_call 分片即上报 started', () => {
  const state = newOpenAIStreamState();
  // 第一帧：只有 id 和 name（无 arguments）
  const d1 = accumulateOpenAIStreamChunk(state, {
    choices: [{
      delta: {
        tool_calls: [{ index: 0, id: 'call_123', function: { name: 'search_files', arguments: '' } }],
      },
    }],
  });
  assert.equal(d1.toolCallStarted?.id, 'call_123');
  assert.equal(d1.toolCallStarted?.name, 'search_files');

  // 第二帧：arguments 片段（不是新 started）
  const d2 = accumulateOpenAIStreamChunk(state, {
    choices: [{
      delta: {
        tool_calls: [{ index: 0, function: { arguments: '{"pa' } }],
      },
    }],
  });
  assert.equal(d2.toolCallStarted, null);

  // 第三帧：第二个 tool_call 开始
  const d3 = accumulateOpenAIStreamChunk(state, {
    choices: [{
      delta: {
        tool_calls: [{ index: 1, id: 'call_456', function: { name: 'read_file', arguments: '' } }],
      },
    }],
  });
  assert.equal(d3.toolCallStarted?.id, 'call_456');
  assert.equal(d3.toolCallStarted?.name, 'read_file');
});

test('35b) OpenAI 流式响应装配：tool_call 最终结构正确', () => {
  const state = newOpenAIStreamState();
  accumulateOpenAIStreamChunk(state, {
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_abc', function: { name: 'list_files', arguments: '{"dir":"."}' } }] } }],
  });
  const resp = buildResponseFromStreamState(state, 'gpt-4', 10, 0.000001);
  assert.equal(resp.stopReason, 'tool_use');
  assert.equal(resp.toolCalls.length, 1);
  assert.equal(resp.toolCalls[0].id, 'call_abc');
  assert.equal(resp.toolCalls[0].name, 'list_files');
  assert.deepEqual(resp.toolCalls[0].arguments, { dir: '.' });
});

test('35c) MockProvider 流式调用时 emit tool_call delta（首帧反馈）', async () => {
  const provider = new MockProvider(() => ({
    stopReason: 'tool_use',
    content: '',
    toolCalls: [{ id: 'tc1', name: 'search_files', arguments: { pattern: 'test', kind: 'content' } }],
  }));
  const deltas: LLMDelta[] = [];
  await provider.chat(
    { system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] },
    (d) => deltas.push(d),
  );

  const toolDeltas = deltas.filter((d) => d.channel === 'tool_call');
  assert.equal(toolDeltas.length, 1, '应产生 1 个 tool_call 增量');
  const parsed = JSON.parse(toolDeltas[0].text);
  assert.equal(parsed.id, 'tc1');
  assert.equal(parsed.name, 'search_files');
});
