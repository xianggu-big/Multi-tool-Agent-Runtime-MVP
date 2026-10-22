// src/evaluation/compactionAb.ts — 上下文压缩 A/B 的纯函数核心（无 I/O、可单测）
//
// 设计取舍：
//   - 执行层需要真实模型；汇总与判定必须离线可测，避免报告口径随运行漂移。
//   - 判定规则在跑实验前固定：rolling 的质量不能低于 legacy，且至少一项效率指标改善 >=15%，
//     并且不能新增孤儿 tool / Provider 失败模式；否则只能写“未证明”。
//   - 这是小样本工程评测，不做统计显著性声明。

import type { RunStatus, TraceEvent } from '../types.js';

export type CompactionStrategy = 'rolling' | 'legacy';

export interface CompactionAbCompaction {
  count: number;
  removedMessages: number;
  maxDepth: number;
  lastSummaryChars: number;
  capReached: boolean;
  maxWatermark?: number;
  watermarkSources?: string[];
  lastPromptTokens?: number;
  contextWindow?: number;
}

export interface CompactionAbCaseResult {
  taskId: string;
  taskTitle: string;
  strategy: CompactionStrategy;
  iteration: number;
  runId: string;
  status: RunStatus | 'exception';
  completed: boolean;
  passed: boolean;
  finalAnswer: string;
  mustMention: string[];
  matched: string[];
  missing: string[];
  steps: number;
  modelCalls: number;
  toolCalls: number;
  readCalls: number;
  uniqueReads: number;
  repeatedReads: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number;
  compaction: CompactionAbCompaction | null;
  modelErrorCount: number;
  toolErrorCount: number;
  orphanToolErrorCount: number;
  errorCode?: string;
  failureReason?: string;
}

export interface CompactionAbStrategySummary {
  strategy: CompactionStrategy;
  runs: number;
  completed: number;
  passed: number;
  completionRate: number;
  targetPassRate: number;
  targetRetentionMean: number;
  avgSteps: number;
  avgModelCalls: number;
  avgToolCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgTotalTokens: number;
  costUsd: number;
  avgCostUsd: number;
  avgDurationMs: number;
  p95DurationMs: number;
  readCalls: number;
  uniqueReads: number;
  repeatedReads: number;
  duplicateReadRate: number;
  avgRepeatedReads: number;
  runsWithCompaction: number;
  totalCompactions: number;
  avgCompactionsPerRun: number;
  maxDepth: number;
  avgSummaryChars: number;
  modelErrorRuns: number;
  toolErrorRuns: number;
  orphanRiskRuns: number;
  failedRuns: number;
}

export interface CompactionAbSummary {
  totalRuns: number;
  rolling: CompactionAbStrategySummary;
  legacy: CompactionAbStrategySummary;
  totalCostUsd: number;
}

export type CompactionAbMetricDirection = 'higher_better' | 'lower_better';

export interface CompactionAbMetricComparison {
  metric:
    | 'completionRate'
    | 'targetPassRate'
    | 'targetRetentionMean'
    | 'avgTotalTokens'
    | 'avgCostUsd'
    | 'avgDurationMs'
    | 'duplicateReadRate'
    | 'avgRepeatedReads';
  label: string;
  direction: CompactionAbMetricDirection;
  legacy: number;
  rolling: number;
  delta: number;
  /** 正数 = rolling 更好；legacy=0 时无法计算相对改善，记为 0。 */
  improvementPct: number;
  material: boolean;
}

export type CompactionAbVerdictStatus = 'proven' | 'not_proven' | 'regressed' | 'incomplete';

export interface CompactionAbVerdict {
  status: CompactionAbVerdictStatus;
  reasons: string[];
  qualityRegressions: string[];
  newFailureModes: string[];
  materialEfficiencyGains: string[];
  comparisons: CompactionAbMetricComparison[];
}

export interface CompactionAbReportMeta {
  generatedAt: string;
  command: string;
  platform: string;
  node: string;
  provider: string;
  model: string;
  simulatedContextWindow: number;
  actualContextWindow?: number;
  fixture: string;
  taskCount: number;
  reps: number;
  plannedRuns: number;
  attemptedRuns: number;
  budgetUsd: number;
  spentUsd: number;
  evidenceDir: string;
  gitHead?: string;
  gitDirty?: boolean;
  notes?: string[];
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function money(n: number): string {
  return `$${n.toFixed(4)}`;
}

function ms(n: number): string {
  return `${Math.round(n)}ms`;
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 400);
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function p95(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  return sorted[idx];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readPathFromArgs(value: unknown): string | null {
  let args = asRecord(value);
  if (!args && typeof value === 'string') {
    try {
      args = asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!args) return null;
  const raw = args.path ?? args.file ?? args.filename ?? args.filepath;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/** 从事件流统计 read_file 调用的重复读取；只依赖持久化事件，便于报告复核。 */
export function extractReadStats(
  events: Array<Pick<TraceEvent, 'type' | 'data'>>,
): { readCalls: number; uniqueReads: number; repeatedReads: number; paths: string[] } {
  const readCalls = events.filter((e) => e.type === 'tool_call_requested' && e.data?.name === 'read_file');
  const counts = new Map<string, number>();
  for (const e of readCalls) {
    const path = readPathFromArgs(e.data?.arguments);
    if (!path) continue;
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  let repeatedReads = 0;
  for (const n of counts.values()) repeatedReads += Math.max(0, n - 1);
  return {
    readCalls: readCalls.length,
    uniqueReads: counts.size,
    repeatedReads,
    paths: [...counts.keys()].sort(),
  };
}

/** 关键词命中是结构化验收，不是人工质量评估。大小写不敏感。 */
export function matchMustMention(answer: string, mustMention: string[]): { matched: string[]; missing: string[] } {
  const haystack = answer.toLowerCase();
  const matched: string[] = [];
  const missing: string[] = [];
  for (const key of mustMention) {
    if (haystack.includes(key.toLowerCase())) matched.push(key);
    else missing.push(key);
  }
  return { matched, missing };
}

function summarizeStrategy(strategy: CompactionStrategy, results: CompactionAbCaseResult[]): CompactionAbStrategySummary {
  const rows = results.filter((r) => r.strategy === strategy);
  const completed = rows.filter((r) => r.completed);
  const passed = rows.filter((r) => r.passed);
  const retention = rows.map((r) => (r.mustMention.length ? r.matched.length / r.mustMention.length : 1));
  const promptTokens = rows.reduce((n, r) => n + r.promptTokens, 0);
  const completionTokens = rows.reduce((n, r) => n + r.completionTokens, 0);
  const totalTokens = rows.reduce((n, r) => n + r.totalTokens, 0);
  const costUsd = rows.reduce((n, r) => n + r.costUsd, 0);
  const readCalls = rows.reduce((n, r) => n + r.readCalls, 0);
  const uniqueReads = rows.reduce((n, r) => n + r.uniqueReads, 0);
  const repeatedReads = rows.reduce((n, r) => n + r.repeatedReads, 0);
  const compactions = rows.map((r) => r.compaction?.count ?? 0);
  return {
    strategy,
    runs: rows.length,
    completed: completed.length,
    passed: passed.length,
    completionRate: rows.length ? completed.length / rows.length : 0,
    targetPassRate: rows.length ? passed.length / rows.length : 0,
    targetRetentionMean: mean(retention),
    avgSteps: mean(rows.map((r) => r.steps)),
    avgModelCalls: mean(rows.map((r) => r.modelCalls)),
    avgToolCalls: mean(rows.map((r) => r.toolCalls)),
    promptTokens,
    completionTokens,
    totalTokens,
    avgTotalTokens: mean(rows.map((r) => r.totalTokens)),
    costUsd,
    avgCostUsd: mean(rows.map((r) => r.costUsd)),
    avgDurationMs: mean(rows.map((r) => r.durationMs)),
    p95DurationMs: p95(rows.map((r) => r.durationMs)),
    readCalls,
    uniqueReads,
    repeatedReads,
    duplicateReadRate: readCalls ? repeatedReads / readCalls : 0,
    avgRepeatedReads: mean(rows.map((r) => r.repeatedReads)),
    runsWithCompaction: rows.filter((r) => (r.compaction?.count ?? 0) > 0).length,
    totalCompactions: compactions.reduce((a, b) => a + b, 0),
    avgCompactionsPerRun: mean(compactions),
    maxDepth: rows.reduce((n, r) => Math.max(n, r.compaction?.maxDepth ?? 0), 0),
    avgSummaryChars: mean(rows.map((r) => r.compaction?.lastSummaryChars ?? 0)),
    modelErrorRuns: rows.filter((r) => r.modelErrorCount > 0).length,
    toolErrorRuns: rows.filter((r) => r.toolErrorCount > 0).length,
    orphanRiskRuns: rows.filter((r) => r.orphanToolErrorCount > 0).length,
    failedRuns: rows.filter((r) => !r.completed).length,
  };
}

export function summarizeCompactionAb(results: CompactionAbCaseResult[]): CompactionAbSummary {
  const rolling = summarizeStrategy('rolling', results);
  const legacy = summarizeStrategy('legacy', results);
  return { totalRuns: results.length, rolling, legacy, totalCostUsd: rolling.costUsd + legacy.costUsd };
}

function comparison(
  metric: CompactionAbMetricComparison['metric'],
  label: string,
  direction: CompactionAbMetricDirection,
  legacy: number,
  rolling: number,
): CompactionAbMetricComparison {
  const delta = rolling - legacy;
  const raw = direction === 'higher_better' ? delta : -delta;
  const improvementPct = legacy > 0 ? (raw / legacy) * 100 : 0;
  return { metric, label, direction, legacy, rolling, delta, improvementPct, material: improvementPct >= 15 };
}

/**
 * 预注册判定。只回答“这批数据是否支持 rolling 更好”，
 * 不回答“rolling 在任意仓库/任意模型上都更好”。
 */
export function compareCompactionAb(
  results: CompactionAbCaseResult[],
  opts: { plannedRuns: number },
): CompactionAbVerdict {
  const s = summarizeCompactionAb(results);
  const comparisons = [
    comparison('completionRate', '完成率', 'higher_better', s.legacy.completionRate, s.rolling.completionRate),
    comparison('targetPassRate', '目标全中率', 'higher_better', s.legacy.targetPassRate, s.rolling.targetPassRate),
    comparison(
      'targetRetentionMean',
      '目标关键词平均保持率',
      'higher_better',
      s.legacy.targetRetentionMean,
      s.rolling.targetRetentionMean,
    ),
    comparison('avgTotalTokens', '平均 tokens/run', 'lower_better', s.legacy.avgTotalTokens, s.rolling.avgTotalTokens),
    comparison('avgCostUsd', '平均成本/run', 'lower_better', s.legacy.avgCostUsd, s.rolling.avgCostUsd),
    comparison('avgDurationMs', '平均耗时/run', 'lower_better', s.legacy.avgDurationMs, s.rolling.avgDurationMs),
    comparison(
      'duplicateReadRate',
      '重复读取率',
      'lower_better',
      s.legacy.duplicateReadRate,
      s.rolling.duplicateReadRate,
    ),
    comparison(
      'avgRepeatedReads',
      '平均重复读取次数/run',
      'lower_better',
      s.legacy.avgRepeatedReads,
      s.rolling.avgRepeatedReads,
    ),
  ];

  const qualityRegressions: string[] = [];
  if (s.rolling.completionRate < s.legacy.completionRate) qualityRegressions.push('完成率低于 legacy');
  if (s.rolling.targetPassRate < s.legacy.targetPassRate) qualityRegressions.push('目标全中率低于 legacy');
  if (s.rolling.targetRetentionMean < s.legacy.targetRetentionMean) {
    qualityRegressions.push('目标关键词平均保持率低于 legacy');
  }

  const newFailureModes: string[] = [];
  if (s.rolling.orphanRiskRuns > s.legacy.orphanRiskRuns) newFailureModes.push('出现更多孤儿 tool / tool_calls 协议错误');
  if (s.rolling.modelErrorRuns > s.legacy.modelErrorRuns) newFailureModes.push('出现更多 Provider 错误');
  if (s.rolling.failedRuns > s.legacy.failedRuns) newFailureModes.push('失败 run 数增加');

  const materialEfficiencyGains = comparisons
    .filter(
      (c) =>
        c.direction === 'lower_better' &&
        c.material &&
        ['avgTotalTokens', 'avgCostUsd', 'avgDurationMs', 'duplicateReadRate', 'avgRepeatedReads'].includes(c.metric),
    )
    .map((c) => `${c.label}改善 ${c.improvementPct.toFixed(1)}%`);

  const reasons: string[] = [];
  let status: CompactionAbVerdictStatus;
  if (results.length < opts.plannedRuns || s.rolling.runs === 0 || s.legacy.runs === 0) {
    status = 'incomplete';
    reasons.push(`实验不完整：计划 ${opts.plannedRuns} 次，实际 ${results.length} 次；不能据此宣称效果`);
  } else if (s.rolling.runsWithCompaction === 0 && s.legacy.runsWithCompaction === 0) {
    status = 'not_proven';
    reasons.push('两种策略都没有触发上下文压缩，本批数据没有区分力');
  } else if (qualityRegressions.length || newFailureModes.length) {
    status = 'regressed';
    reasons.push(...qualityRegressions, ...newFailureModes);
  } else if (materialEfficiencyGains.length) {
    status = 'proven';
    reasons.push(...materialEfficiencyGains);
  } else {
    status = 'not_proven';
    reasons.push('质量没有回退，但没有任何效率指标达到预设的 >=15% 改善门槛');
  }

  if (status !== 'incomplete') {
    reasons.push('质量门槛：完成率、目标全中率、关键词平均保持率均不得低于 legacy');
    if (!qualityRegressions.length && !newFailureModes.length) reasons.push('未发现新增失败模式');
  }

  return { status, reasons, qualityRegressions, newFailureModes, materialEfficiencyGains, comparisons };
}

function strategyLabel(s: CompactionStrategy): string {
  return s === 'rolling' ? 'rolling（生产）' : 'legacy（对照）';
}

function statusBadge(status: CompactionAbVerdictStatus): string {
  switch (status) {
    case 'proven':
      return '✅ 已证明（仅限本实验条件）';
    case 'regressed':
      return '❌ 回退';
    case 'incomplete':
      return '⏸️ 实验不完整';
    default:
      return '⚪ 未证明';
  }
}

function formatMetricValue(metric: CompactionAbMetricComparison): string {
  if (metric.metric === 'avgCostUsd') return `${money(metric.legacy)} → ${money(metric.rolling)}`;
  if (metric.metric === 'avgDurationMs') return `${ms(metric.legacy)} → ${ms(metric.rolling)}`;
  if (metric.metric === 'avgTotalTokens') return `${Math.round(metric.legacy)} → ${Math.round(metric.rolling)}`;
  if (metric.metric === 'avgRepeatedReads') return `${metric.legacy.toFixed(2)} → ${metric.rolling.toFixed(2)}`;
  return `${pct(metric.legacy)} → ${pct(metric.rolling)}`;
}

function summarizeByTaskAndStrategy(results: CompactionAbCaseResult[]) {
  const map = new Map<string, CompactionAbCaseResult[]>();
  for (const r of results) {
    const key = `${r.taskId}\u0000${r.strategy}`;
    const rows = map.get(key) ?? [];
    rows.push(r);
    map.set(key, rows);
  }
  return [...map.entries()]
    .map(([key, rows]) => {
      const [taskId, strategy] = key.split('\u0000') as [string, CompactionStrategy];
      return {
        taskId,
        taskTitle: rows[0]?.taskTitle ?? taskId,
        strategy,
        runs: rows.length,
        passed: rows.filter((r) => r.passed).length,
        retention: mean(rows.map((r) => (r.mustMention.length ? r.matched.length / r.mustMention.length : 1))),
        tokens: mean(rows.map((r) => r.totalTokens)),
        costUsd: mean(rows.map((r) => r.costUsd)),
        compactions: mean(rows.map((r) => r.compaction?.count ?? 0)),
        repeatedReads: mean(rows.map((r) => r.repeatedReads)),
      };
    })
    .sort((a, b) => a.taskId.localeCompare(b.taskId) || a.strategy.localeCompare(b.strategy));
}

export function renderCompactionAbReport(meta: CompactionAbReportMeta, results: CompactionAbCaseResult[]): string {
  const summary = summarizeCompactionAb(results);
  const verdict = compareCompactionAb(results, { plannedRuns: meta.plannedRuns });
  const lines: string[] = [];
  lines.push('# 上下文压缩 A/B（真实模型）');
  lines.push('');
  lines.push(`> 生成时间：${meta.generatedAt}；命令：\`${meta.command}\`；生成物请重跑命令，不要手改数字。`);
  lines.push('');
  lines.push(`**判定：${statusBadge(verdict.status)}**`);
  lines.push('');
  for (const reason of verdict.reasons) lines.push(`- ${reason}`);
  lines.push('');
  lines.push('## 1. 口径与边界');
  lines.push('');
  lines.push(`- 真实模型：\`${meta.provider}/${meta.model}\`；每个 run 使用独立临时仓库副本，只读任务。`);
  lines.push(
    `- **窗口模拟**：运行时按 \`${meta.simulatedContextWindow}\` tokens 计算压缩水位；模型真实窗口为 ${
      meta.actualContextWindow ? `\`${meta.actualContextWindow}\`` : '未知'
    }。本实验只验证“在同样的小窗口假设下，两种摘要策略谁更好”，不宣称 1M 窗口也会得到同样结果。`,
  );
  lines.push(
    `- 任务：${meta.taskCount} 个 × 2 策略 × ${meta.reps} 次 = 计划 ${meta.plannedRuns} run；实际 ${meta.attemptedRuns} run。`,
  );
  lines.push('- 通过标准：run 状态为 completed，且最终答案包含该任务预先声明的全部验收关键词。关键词命中不等于人工质量评估。');
  lines.push('- 判定是预注册的：rolling 的完成率/目标全中率/关键词保持率不得低于 legacy，且至少一项效率指标改善 >=15%，且不得新增失败模式。');
  lines.push(`- 样本很小（每格 ${meta.reps} 次），不声称统计显著性；结论只适用于本 fixture、本模型、本窗口假设。`);
  if (meta.notes?.length) for (const n of meta.notes) lines.push(`- ${n}`);
  lines.push('');
  lines.push('## 2. 环境与预算');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('|---|---|');
  lines.push(`| Node | \`${cell(meta.node)}\` |`);
  lines.push(`| 平台 | \`${cell(meta.platform)}\` |`);
  lines.push(`| Provider / 模型 | \`${cell(meta.provider)}\` / \`${cell(meta.model)}\` |`);
  lines.push(`| 模拟上下文窗口 | \`${meta.simulatedContextWindow}\` tokens |`);
  lines.push(`| Fixture | \`${cell(meta.fixture)}\` |`);
  lines.push(`| Git | ${meta.gitHead ? `\`${meta.gitHead}\`${meta.gitDirty ? '（工作区有未提交改动）' : ''}` : '不可用'} |`);
  lines.push(`| 预算 / 实际估算 | ${money(meta.budgetUsd)} / ${money(summary.totalCostUsd)} |`);
  lines.push(`| 证据目录 | \`${cell(meta.evidenceDir)}\` |`);
  lines.push('');
  lines.push('## 3. 汇总');
  lines.push('');
  lines.push('| 指标 | rolling（生产） | legacy（对照） |');
  lines.push('|---|---:|---:|');
  const rows: Array<[string, string, string]> = [
    ['run 数', String(summary.rolling.runs), String(summary.legacy.runs)],
    [
      '完成数 / 完成率',
      `${summary.rolling.completed} / ${pct(summary.rolling.completionRate)}`,
      `${summary.legacy.completed} / ${pct(summary.legacy.completionRate)}`,
    ],
    [
      '目标全中 / 全中率',
      `${summary.rolling.passed} / ${pct(summary.rolling.targetPassRate)}`,
      `${summary.legacy.passed} / ${pct(summary.legacy.targetPassRate)}`,
    ],
    ['关键词平均保持率', pct(summary.rolling.targetRetentionMean), pct(summary.legacy.targetRetentionMean)],
    [
      '平均 steps / model calls / tool calls',
      `${summary.rolling.avgSteps.toFixed(1)} / ${summary.rolling.avgModelCalls.toFixed(1)} / ${summary.rolling.avgToolCalls.toFixed(1)}`,
      `${summary.legacy.avgSteps.toFixed(1)} / ${summary.legacy.avgModelCalls.toFixed(1)} / ${summary.legacy.avgToolCalls.toFixed(1)}`,
    ],
    [
      'tokens（总 / 平均）',
      `${summary.rolling.totalTokens} / ${Math.round(summary.rolling.avgTotalTokens)}`,
      `${summary.legacy.totalTokens} / ${Math.round(summary.legacy.avgTotalTokens)}`,
    ],
    [
      '成本（总 / 平均）',
      `${money(summary.rolling.costUsd)} / ${money(summary.rolling.avgCostUsd)}`,
      `${money(summary.legacy.costUsd)} / ${money(summary.legacy.avgCostUsd)}`,
    ],
    [
      '耗时（平均 / P95）',
      `${ms(summary.rolling.avgDurationMs)} / ${ms(summary.rolling.p95DurationMs)}`,
      `${ms(summary.legacy.avgDurationMs)} / ${ms(summary.legacy.p95DurationMs)}`,
    ],
    [
      'read calls / unique / repeated',
      `${summary.rolling.readCalls} / ${summary.rolling.uniqueReads} / ${summary.rolling.repeatedReads}`,
      `${summary.legacy.readCalls} / ${summary.legacy.uniqueReads} / ${summary.legacy.repeatedReads}`,
    ],
    ['重复读取率', pct(summary.rolling.duplicateReadRate), pct(summary.legacy.duplicateReadRate)],
    [
      '发生压缩的 run / 总压缩次数',
      `${summary.rolling.runsWithCompaction} / ${summary.rolling.totalCompactions}`,
      `${summary.legacy.runsWithCompaction} / ${summary.legacy.totalCompactions}`,
    ],
    [
      '平均压缩次数 / 最大深度',
      `${summary.rolling.avgCompactionsPerRun.toFixed(2)} / ${summary.rolling.maxDepth}`,
      `${summary.legacy.avgCompactionsPerRun.toFixed(2)} / ${summary.legacy.maxDepth}`,
    ],
    [
      'Provider 错误 run / tool 错误 run / 孤儿风险 run',
      `${summary.rolling.modelErrorRuns} / ${summary.rolling.toolErrorRuns} / ${summary.rolling.orphanRiskRuns}`,
      `${summary.legacy.modelErrorRuns} / ${summary.legacy.toolErrorRuns} / ${summary.legacy.orphanRiskRuns}`,
    ],
  ];
  for (const [label, rolling, legacy] of rows) lines.push(`| ${label} | ${rolling} | ${legacy} |`);
  lines.push('');
  lines.push('## 4. 效率对比');
  lines.push('');
  lines.push('> `改善` 已按指标方向归一化：正数代表 rolling 更好。只有达到 >=15% 才标记为 material。');
  lines.push('');
  lines.push('| 指标 | legacy → rolling | 改善 | 达到 15% 门槛 |');
  lines.push('|---|---:|---:|---|');
  for (const c of verdict.comparisons) {
    const direction = c.direction === 'higher_better' ? '越高越好' : '越低越好';
    lines.push(
      `| ${c.label}（${direction}） | ${formatMetricValue(c)} | ${c.improvementPct.toFixed(1)}% | ${c.material ? '是' : '否'} |`,
    );
  }
  lines.push('');
  lines.push('## 5. 逐任务');
  lines.push('');
  lines.push('| 任务 | 策略 | run | 全中 | 关键词保持率 | 平均 tokens | 平均成本 | 平均压缩次数 | 平均重复读取 |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of summarizeByTaskAndStrategy(results)) {
    lines.push(
      `| ${cell(row.taskId)} ${cell(row.taskTitle)} | ${strategyLabel(row.strategy)} | ${row.runs} | ${row.passed} | ${pct(row.retention)} | ${Math.round(row.tokens)} | ${money(row.costUsd)} | ${row.compactions.toFixed(2)} | ${row.repeatedReads.toFixed(2)} |`,
    );
  }
  lines.push('');
  lines.push('## 6. 逐 run 证据');
  lines.push('');
  lines.push('| 任务 | 策略 | # | runId | 状态 | 全中 | 关键词 | tokens | 成本 | 耗时 | 压缩 | 重复读取 | 错误 |');
  lines.push('|---|---|---:|---|---|---|---:|---:|---:|---:|---:|---:|---|');
  const ordered = [...results].sort(
    (a, b) => a.taskId.localeCompare(b.taskId) || a.strategy.localeCompare(b.strategy) || a.iteration - b.iteration,
  );
  for (const r of ordered) {
    const errors = [
      r.modelErrorCount ? `provider×${r.modelErrorCount}` : '',
      r.orphanToolErrorCount ? `orphan×${r.orphanToolErrorCount}` : '',
      r.toolErrorCount ? `tool×${r.toolErrorCount}` : '',
      r.errorCode ?? '',
    ]
      .filter(Boolean)
      .join('；');
    lines.push(
      `| ${cell(r.taskId)} | ${strategyLabel(r.strategy)} | ${r.iteration} | \`${r.runId}\` | ${r.status} | ${r.passed ? '是' : '否'} | ${r.matched.length}/${r.mustMention.length} | ${r.totalTokens} | ${money(r.costUsd)} | ${ms(r.durationMs)} | ${r.compaction ? `${r.compaction.count}次/深度${r.compaction.maxDepth}/${r.compaction.lastSummaryChars}字` : '无'} | ${r.repeatedReads}/${r.readCalls} | ${cell(errors || '无')} |`,
    );
  }
  lines.push('');
  lines.push('## 7. 失败模式');
  lines.push('');
  const failed = results.filter((r) => !r.passed || r.modelErrorCount > 0 || r.orphanToolErrorCount > 0);
  if (!failed.length) {
    lines.push('- 无（本实验里所有 run 均完成且命中全部验收关键词，且未记录 Provider/孤儿 tool 错误）');
  } else {
    for (const r of failed) {
      const note =
        r.failureReason || r.errorCode || (r.missing.length ? `缺少关键词：${r.missing.join('、')}` : '未通过验收');
      lines.push(`- \`${r.runId}\`（${r.taskId}/${r.strategy}/${r.iteration}）：${cell(note)}`);
    }
  }
  lines.push('');
  lines.push('## 8. 判定规则（预注册）');
  lines.push('');
  lines.push('1. rolling 的完成率、目标全中率、关键词平均保持率不得低于 legacy。');
  lines.push('2. 至少一项效率指标（平均 tokens、平均成本、平均耗时、重复读取率、平均重复读取次数）改善 >=15%。');
  lines.push('3. rolling 不得新增孤儿 tool / tool_calls 协议错误、Provider 错误或更多失败 run。');
  lines.push('4. 计划 run 未跑完 → 只能判为“实验不完整”。');
  lines.push('5. 不满足以上条件 → 只能写“未证明”，不能把单测通过或个别 run 的优势外推成普适结论。');
  lines.push('');
  return lines.join('\n');
}
