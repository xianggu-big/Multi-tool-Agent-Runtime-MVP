import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRuntime, mockProvider, makeCtx } from './helpers.js';
import type { MockResponder } from '../src/llm/MockProvider.js';
import type { RunInput } from '../src/types.js';

test('11) 执行事件按正确顺序持久化', async () => {
  const { runtime } = makeRuntime();
  const responder: MockResponder = ({ callIndex }) => {
    if (callIndex === 0) {
      return { stopReason: 'tool_use', content: '搜索', toolCalls: [{ id: 'c1', name: 'search_files', arguments: { pattern: 'add', kind: 'content' } }] };
    }
    return { stopReason: 'end_turn', content: '完成。' };
  };
  const input: RunInput = { runType: 'codebase', goal: 'g', repoPath: makeCtx().repoPath };
  const runId = runtime.createRun(input, mockProvider(responder));
  await runtime.run(input, runId);

  const events = runtime.getEvents(runId);
  // 序号严格递增且连续
  for (let i = 0; i < events.length; i++) {
    assert.equal(events[i].seq, i + 1, '事件序号应连续递增');
    assert.equal(events[i].runId, runId);
  }
  assert.equal(events[0].type, 'run_started');
  assert.equal(events[events.length - 1].type, 'run_completed');

  // 关键事件相对顺序
  const idx = (t: string) => events.findIndex((e) => e.type === t);
  const iMr = idx('model_request');
  const iTcr = idx('tool_call_requested');
  const iTs = idx('tool_started');
  const iTc = idx('tool_completed');
  const iCp = idx('checkpoint_saved');
  const iRc = idx('run_completed');
  assert.ok(iMr < iTcr && iTcr < iTs && iTs < iTc && iTc < iCp && iCp < iRc, '事件相对顺序应正确');
});
