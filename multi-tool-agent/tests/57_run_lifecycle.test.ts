// tests/57_run_lifecycle.test.ts — 终态即取消：不允许「run 已结束、子任务还在跑」
//
// 现场（2026-10-20，run_mvgejh0e_3e6c9b74）：
//   08:20:06 run_completed（主 Agent 放弃并提交汇总）
//   08:21:36 僵尸子任务的审批卡才因 300s 超时被拒
//   08:21:51 又提交了一次、又弹一张审批卡（再等 300s）
//   事件从 seq=1 重写 → 同一 run 出现重复序号（225 行 / 201 个 seq）
// 两个根因：
//   ① finalize() 没 abort run 级 signal → 子任务/审批等待继续活着；
//   ② EventLogger 在 run_completed 时清零 seq 计数 → 后续事件从 1 重来。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRuntime } from './helpers.js';
import { EventLogger } from '../src/trace/EventLogger.js';
import type { RunInput } from '../src/types.js';

function input(over: Partial<RunInput> = {}): RunInput {
  return { runType: 'misc', goal: 'g', ...over };
}

test('57a) finalize 会 abort 该 run 的取消信号（终态后不允许再有在飞工作）', () => {
  const { runtime, store, logger } = makeRuntime();
  const runId = runtime.createRun(input(), undefined as any);
  store.updateRun({ runId, status: 'running', updatedAt: new Date().toISOString() });
  // 模拟 run 执行期注册的取消器（run()/enqueue() 内部会做这一步）
  const ac = new AbortController();
  (runtime as any).cancellers.set(runId, ac);

  assert.equal(ac.signal.aborted, false);
  (runtime as any).finalize(runId, 'completed', { emit: 'run_completed', finalAnswer: 'done' });
  assert.equal(ac.signal.aborted, true, '终态必须 abort：否则僵尸子任务会继续烧 token / 弹审批卡');
  logger.flush();
  store.close();
});

test('57b) 挂起中的审批在 run 结束时立即按「任务已结束」拒绝，不再等 300s 超时', async () => {
  const { runtime, store, logger } = makeRuntime();
  const runId = runtime.createRun(input(), undefined as any);
  store.updateRun({ runId, status: 'running', updatedAt: new Date().toISOString() });
  const ac = new AbortController();
  (runtime as any).cancellers.set(runId, ac);

  const req = {
    approvalId: 'ap_test_1',
    toolName: 'submit_changes',
    files: [{ relPath: 'a.ts', op: 'edit', addedLines: 1, removedLines: 0 }],
    checks: [],
    highRisk: false,
  };
  const started = Date.now();
  const pending = (runtime as any).requestApproval(runId, req) as Promise<any>;
  // 模拟父 run 收尾
  (runtime as any).finalize(runId, 'completed', { emit: 'run_completed', finalAnswer: 'done' });

  const decision = await pending;
  assert.equal(decision.value, 'deny', 'run 结束后审批不能一直挂着，必须自动拒绝');
  assert.equal(decision.actor, 'run-finished');
  assert.ok(Date.now() - started < 2000, '应是立即返回，而不是等审批超时（默认 300s）');
  assert.equal((runtime as any).pendingApprovals.size, 0, '挂起项要清掉，避免泄漏');
  logger.flush();
  const decided = store.getEvents(runId).find((e) => e.type === 'approval_decided');
  assert.ok(decided, '应留下 approval_decided 事件');
  assert.equal((decided!.data as any).actor, 'run-finished');
  store.close();
});

test('57c) 终态后追加事件不再重号（seq 连续，可安全回放）', () => {
  const logger = new EventLogger({ maxContentChars: 500, onPersist: () => {}, console: false });
  const e1 = logger.emit('run_x', 'run_started', {});
  const e2 = logger.emit('run_x', 'run_completed', {});
  const e3 = logger.emit('run_x', 'approval_decided', { actor: 'run-finished' });
  assert.deepEqual([e1.seq, e2.seq, e3.seq], [1, 2, 3], '终态之后的事件必须顺延编号');
});

test('57d) 审批在 run 取消（abort）时同样立即拒绝，actor 记为 run-finished', async () => {
  const { runtime, store, logger } = makeRuntime();
  const runId = runtime.createRun(input(), undefined as any);
  store.updateRun({ runId, status: 'running', updatedAt: new Date().toISOString() });
  const ac = new AbortController();
  (runtime as any).cancellers.set(runId, ac);

  const pending = (runtime as any).requestApproval(runId, {
    approvalId: 'ap_test_2',
    toolName: 'submit_changes',
    files: [{ relPath: 'b.ts', op: 'edit', addedLines: 1, removedLines: 0 }],
    checks: [],
    highRisk: false,
  }) as Promise<any>;
  ac.abort();
  const decision = await pending;
  assert.equal(decision.value, 'deny');
  assert.equal(decision.actor, 'run-finished');
  logger.flush();
  store.close();
});
