// tests/13_state_transition.test.ts — 场景 13：非法状态转换被拒绝
// 验证状态机的合法转换表，以及 Runtime 层 resume 对非可恢复状态的拒绝。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, assertTransition, RESUMABLE } from '../src/runtime/StateMachine.js';
import { makeRuntime, mockProvider } from './helpers.js';
import type { MockResponder } from '../src/llm/MockProvider.js';
import type { RunInput } from '../src/types.js';

test('13a) 状态机拒绝非法转换', () => {
  // 终态不可再转换
  assert.equal(canTransition('completed', 'running'), false);
  assert.equal(canTransition('completed', 'failed'), false);
  assert.equal(canTransition('cancelled', 'running'), false);
  assert.equal(canTransition('failed', 'completed'), false); // failed 只能 -> running
  assert.equal(canTransition('limit_reached', 'completed'), false);
  // 非相邻/无定义转换
  assert.equal(canTransition('queued', 'completed'), false);
  assert.equal(canTransition('queued', 'waiting_tool'), false);
  // 同一状态刷新允许
  assert.equal(canTransition('running', 'running'), true);
  // 非法转换应抛错
  assert.throws(() => assertTransition('completed', 'running'), /非法状态转换/);
  assert.throws(() => assertTransition('running', 'queued'), /非法状态转换/);
});

test('13b) 仅 failed / limit_reached 可恢复', () => {
  assert.deepEqual(RESUMABLE, ['failed', 'limit_reached']);
  assert.equal(RESUMABLE.includes('completed'), false);
  assert.equal(RESUMABLE.includes('cancelled'), false);
});

test('13c) Runtime 拒绝恢复已完成任务', async () => {
  const { runtime } = makeRuntime();
  const responder: MockResponder = () => ({ stopReason: 'end_turn', content: '完成。' });
  const input: RunInput = { runType: 'research', goal: 'g', maxModelCalls: 5, maxSteps: 5 };
  const runId = runtime.createRun(input, mockProvider(responder));
  const res = await runtime.run(input, runId);
  assert.equal(res.status, 'completed');

  // 已完成任务不可恢复：resume 必须抛错（resume 在同步阶段即抛错，显式 try/catch 更稳妥）
  let threw = false;
  let message = '';
  try {
    await runtime.resume(runId);
  } catch (e) {
    threw = true;
    message = (e as Error).message;
  }
  assert.equal(threw, true, 'resume 应对已完成任务抛错');
  assert.match(message, /不可恢复/);
});
