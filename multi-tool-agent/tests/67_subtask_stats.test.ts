// tests/67_subtask_stats.test.ts — 按 spec 聚合子任务历史（T7 轻量版）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateSubtaskStats } from '../src/runtime/subtaskStats.js';
import type { SubtaskOutcome } from '../src/types.js';

function outcome(over: Partial<SubtaskOutcome>): SubtaskOutcome {
  return {
    subtaskId: 'st_x',
    specId: 'dir-inventory',
    specTitle: '目录清点',
    objective: '清点',
    status: 'ok',
    steps: 1,
    modelCalls: 1,
    toolCalls: 1,
    durationMs: 100,
    usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20, costUsd: 0, isEstimate: true },
    ...over,
  };
}

test('67a) 按 spec 聚合成功率/耗时/token；默认排除 Mock', () => {
  const realRun = {
    isMock: 0,
    createdAt: '2026-10-23T01:00:00.000Z',
    resultJson: JSON.stringify({
      v: 1,
      subtasks: [
        outcome({ subtaskId: 'a', specId: 'code-edit', status: 'ok', durationMs: 2000, usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, costUsd: 0, isEstimate: false } }),
        outcome({ subtaskId: 'b', specId: 'code-edit', status: 'failed', durationMs: 4000, usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300, costUsd: 0, isEstimate: false } }),
        outcome({ subtaskId: 'c', specId: 'dir-inventory', status: 'ok', durationMs: 1000 }),
      ],
    }),
  };
  const mockRun = {
    isMock: 1,
    createdAt: '2026-10-22T01:00:00.000Z',
    resultJson: JSON.stringify({ v: 1, subtasks: [outcome({ specId: 'code-edit' })] }),
  };
  const emptyRun = { isMock: 0, createdAt: '2026-10-21T01:00:00.000Z', resultJson: undefined };

  const stats = aggregateSubtaskStats([realRun, mockRun, emptyRun]);
  assert.equal(stats.runsScanned, 3);
  assert.equal(stats.runsWithSubtasks, 1);
  assert.equal(stats.mockExcluded, 1);
  assert.equal(stats.totalSubtasks, 3);
  const edit = stats.specs.find((s) => s.specId === 'code-edit')!;
  assert.equal(edit.total, 2);
  assert.equal(edit.ok, 1);
  assert.equal(edit.failed, 1);
  assert.equal(edit.successRate, 0.5);
  assert.equal(edit.avgDurationMs, 3000);
  assert.equal(edit.avgTokens, 225);
  assert.equal(edit.totalTokens, 450);
  assert.equal(edit.lastFinishedAt, realRun.createdAt);

  const withMock = aggregateSubtaskStats([realRun, mockRun], { includeMock: true });
  assert.equal(withMock.mockExcluded, 0);
  assert.equal(withMock.specs.find((s) => s.specId === 'code-edit')!.total, 3);
});

test('67b) 损坏的 resultJson 不会让统计炸掉', () => {
  const stats = aggregateSubtaskStats([
    { isMock: 0, createdAt: '2026-10-23T01:00:00.000Z', resultJson: '{not json' },
    { isMock: 0, createdAt: '2026-10-23T01:00:00.000Z', resultJson: null },
  ]);
  assert.equal(stats.runsScanned, 2);
  assert.equal(stats.totalSubtasks, 0);
  assert.deepEqual(stats.specs, []);
});
