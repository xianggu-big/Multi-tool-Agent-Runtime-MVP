// tests/80_repair_loop.test.ts — R-Loop 判定函数 decideRepair 的语义回归（纯函数，不连 Docker）
//
// 尺子先行的守卫：Phase 1 运行时返工环（reports/REPAIR_LOOP_PLAN.md §6）必须复用这里的判定语义；
// 改动判定优先级（绿收尾 → 轮次上限 → 预算 → 首轮放行 → 同错误熔断 → 继续）必须先改本测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRepair, type RepairRoundOutcome } from '../src/evaluation/editEval.js';

const red = (failureKey: string): RepairRoundOutcome => ({ ok: false, failureKey });
const green: RepairRoundOutcome = { ok: true };

test('80a) maxRounds=0：返工环关闭，首轮都不执行', () => {
  assert.deepEqual(decideRepair([], { maxRounds: 0, budgetAvailable: true }), { action: 'abort', reason: 'max_rounds' });
});

test('80b) 空历史：放行第 1 轮', () => {
  assert.deepEqual(decideRepair([], { maxRounds: 3, budgetAvailable: true }), { action: 'retry' });
});

test('80c) 本轮绿：收尾进审批（done）', () => {
  assert.deepEqual(decideRepair([red('l1-tests: x'), green], { maxRounds: 3, budgetAvailable: true }), { action: 'done' });
});

test('80d) 首轮红：继续（retry）', () => {
  assert.deepEqual(decideRepair([red('l1-tests: x')], { maxRounds: 3, budgetAvailable: true }), { action: 'retry' });
});

test('80e) 相邻两轮同失败签名：熔断（cutoff/same_error）', () => {
  assert.deepEqual(
    decideRepair([red('l1-tests: add 失败（exit=1）'), red('l1-tests: add 失败（exit=1）')], { maxRounds: 3, budgetAvailable: true }),
    { action: 'cutoff', reason: 'same_error' },
  );
});

test('80f) 相邻两轮不同失败签名：不熔断，继续', () => {
  assert.deepEqual(
    decideRepair([red('l1-tests: add 失败（exit=1）'), red('l0-syntax: 语法错误（exit=1）')], { maxRounds: 3, budgetAvailable: true }),
    { action: 'retry' },
  );
});

test('80g) 隔轮同签名不算同错误（只比较相邻两轮）', () => {
  assert.deepEqual(
    decideRepair([red('k'), red('k2'), red('k')], { maxRounds: 4, budgetAvailable: true }),
    { action: 'retry' },
  );
});

test('80h) 轮次达上限：abort/max_rounds（优先于同错误判定）', () => {
  assert.deepEqual(
    decideRepair([red('k'), red('k')], { maxRounds: 2, budgetAvailable: true }),
    { action: 'abort', reason: 'max_rounds' },
  );
});

test('80i) 预算耗尽：返工轮不跑（abort/budget）；绿轮收尾不耗预算（done）', () => {
  assert.deepEqual(decideRepair([red('k')], { maxRounds: 3, budgetAvailable: false }), { action: 'abort', reason: 'budget' });
  // 收尾（进审批）不需要再消耗预算：绿轮后即使预算耗尽也是 done，不把成功误标为失败。
  assert.deepEqual(decideRepair([green], { maxRounds: 3, budgetAvailable: false }), { action: 'done' });
  // 预算也管首轮：还没跑任何轮就没了预算 → 诚实中止，不放行首轮。
  assert.deepEqual(decideRepair([], { maxRounds: 3, budgetAvailable: false }), { action: 'abort', reason: 'budget' });
});

test('80j) 判定优先级总排序：绿收尾 > 上限 > 预算 > 熔断 > 继续', () => {
  // 上限与预算同时命中：上限优先
  assert.deepEqual(decideRepair([red('k')], { maxRounds: 1, budgetAvailable: false }), { action: 'abort', reason: 'max_rounds' });
  // 轮次用满且末轮绿：成功收尾（done），不把成功误标为 abort
  assert.deepEqual(decideRepair([red('k'), green], { maxRounds: 2, budgetAvailable: true }), { action: 'done' });
});
