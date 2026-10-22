// tests/58_compaction_ab.test.ts — 压缩 A/B 的汇总/判定/报告口径回归（纯函数，不连真实模型）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareCompactionAb,
  extractReadStats,
  matchMustMention,
  renderCompactionAbReport,
  summarizeCompactionAb,
  type CompactionAbCaseResult,
  type CompactionStrategy,
} from '../src/evaluation/compactionAb.js';

function result(over: Partial<CompactionAbCaseResult> = {}): CompactionAbCaseResult {
  const strategy: CompactionStrategy = over.strategy ?? 'rolling';
  const mustMention = over.mustMention ?? ['alpha', 'beta'];
  const matched = over.matched ?? mustMention;
  return {
    taskId: 'T1',
    taskTitle: '样例任务',
    strategy,
    iteration: 1,
    runId: `run_${strategy}_1`,
    status: 'completed',
    completed: true,
    passed: true,
    finalAnswer: matched.join(' '),
    mustMention,
    matched,
    missing: mustMention.filter((m) => !matched.includes(m)),
    steps: 5,
    modelCalls: 5,
    toolCalls: 8,
    readCalls: 4,
    uniqueReads: 3,
    repeatedReads: 1,
    promptTokens: 10_000,
    completionTokens: 2_000,
    totalTokens: 12_000,
    costUsd: 0.003,
    durationMs: 10_000,
    compaction: {
      count: 1,
      removedMessages: 4,
      maxDepth: 1,
      lastSummaryChars: 800,
      capReached: false,
      maxWatermark: 0.7,
      watermarkSources: ['provider'],
      contextWindow: 4096,
    },
    modelErrorCount: 0,
    toolErrorCount: 0,
    orphanToolErrorCount: 0,
    ...over,
  };
}

test('58a) 关键词命中大小写不敏感；重复读取按路径稳定统计', () => {
  assert.deepEqual(matchMustMention('NormalizeEmail and NULL', ['normalizeEmail', 'null', 'missing']), {
    matched: ['normalizeEmail', 'null'],
    missing: ['missing'],
  });
  const stats = extractReadStats([
    { type: 'tool_call_requested', data: { name: 'read_file', arguments: { path: 'src/a.js' } } },
    { type: 'tool_call_requested', data: { name: 'read_file', arguments: { file: './src/a.js' } } },
    { type: 'tool_call_requested', data: { name: 'read_file', arguments: '{"path":"src\\\\b.js"}' } },
    { type: 'tool_call_requested', data: { name: 'search_files', arguments: { path: 'src' } } },
  ]);
  assert.equal(stats.readCalls, 3);
  assert.equal(stats.uniqueReads, 2);
  assert.equal(stats.repeatedReads, 1);
  assert.deepEqual(stats.paths, ['src/a.js', 'src/b.js']);
});

test('58b) 汇总按策略分组，保留完成率/全中率/重复读取率/压缩观测', () => {
  const s = summarizeCompactionAb([
    result(),
    result({ strategy: 'legacy', runId: 'run_legacy_1', totalTokens: 20_000, costUsd: 0.005, repeatedReads: 2 }),
    result({ strategy: 'legacy', runId: 'run_legacy_2', totalTokens: 20_000, costUsd: 0.005, repeatedReads: 2 }),
  ]);
  assert.equal(s.totalRuns, 3);
  assert.equal(s.rolling.runs, 1);
  assert.equal(s.legacy.runs, 2);
  assert.equal(s.rolling.completionRate, 1);
  assert.equal(s.rolling.targetPassRate, 1);
  assert.equal(s.legacy.avgTotalTokens, 20_000);
  assert.equal(s.legacy.duplicateReadRate, 4 / 8);
  assert.equal(s.rolling.runsWithCompaction, 1);
  assert.equal(s.rolling.maxDepth, 1);
});

test('58c) rolling 质量不回退且 tokens 改善 >=15% → proven', () => {
  const rows = [
    result({ strategy: 'rolling', totalTokens: 6_000, costUsd: 0.001 }),
    result({ strategy: 'legacy', totalTokens: 10_000, costUsd: 0.003 }),
  ];
  const v = compareCompactionAb(rows, { plannedRuns: 2 });
  assert.equal(v.status, 'proven');
  assert.ok(v.materialEfficiencyGains.some((x) => x.includes('tokens')));
});

test('58d) rolling 目标全中率下降 → regressed，不能只看 token 更少', () => {
  const rows = [
    result({ strategy: 'rolling', totalTokens: 6_000, passed: false, matched: ['alpha'], missing: ['beta'] }),
    result({ strategy: 'legacy', totalTokens: 10_000 }),
  ];
  const v = compareCompactionAb(rows, { plannedRuns: 2 });
  assert.equal(v.status, 'regressed');
  assert.ok(v.qualityRegressions.some((x) => x.includes('目标全中率')));
});

test('58e) 计划 run 未跑完 → incomplete，禁止宣称效果', () => {
  const v = compareCompactionAb([result({ strategy: 'rolling' }), result({ strategy: 'legacy' })], { plannedRuns: 6 });
  assert.equal(v.status, 'incomplete');
  assert.match(v.reasons.join('\n'), /实验不完整/);
});

test('58f) 两种策略都未触发压缩 → not_proven，报告明说窗口模拟与关键词边界', () => {
  const noCompact = { count: 0, removedMessages: 0, maxDepth: 0, lastSummaryChars: 0, capReached: false };
  const rows = [
    result({ strategy: 'rolling', compaction: noCompact, totalTokens: 6_000 }),
    result({ strategy: 'legacy', compaction: noCompact, totalTokens: 10_000 }),
  ];
  const v = compareCompactionAb(rows, { plannedRuns: 2 });
  assert.equal(v.status, 'not_proven');
  assert.match(v.reasons.join('\n'), /没有触发上下文压缩/);
  const md = renderCompactionAbReport(
    {
      generatedAt: '2026-10-21T00:00:00.000Z',
      command: 'npm run eval:compaction',
      platform: 'win32 x64',
      node: 'v24.14.1',
      provider: 'deepseek',
      model: 'deepseek-flash',
      simulatedContextWindow: 4096,
      actualContextWindow: 1_048_576,
      fixture: 'eval/compaction-fixture/base',
      taskCount: 1,
      reps: 1,
      plannedRuns: 2,
      attemptedRuns: 2,
      budgetUsd: 1,
      spentUsd: 0.004,
      evidenceDir: 'data/compaction-ab/x',
    },
    rows,
  );
  assert.match(md, /未证明/);
  assert.match(md, /窗口模拟/);
  assert.match(md, /关键词命中不等于人工质量评估/);
  assert.match(md, /判定规则（预注册）/);
});

test('58g) 空结果不崩，报告标记实验不完整', () => {
  const s = summarizeCompactionAb([]);
  assert.equal(s.totalRuns, 0);
  assert.equal(s.rolling.completionRate, 0);
  const v = compareCompactionAb([], { plannedRuns: 30 });
  assert.equal(v.status, 'incomplete');
});
