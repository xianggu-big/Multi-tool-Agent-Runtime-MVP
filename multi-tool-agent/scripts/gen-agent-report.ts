// scripts/gen-agent-report.ts — Agent 效果报告生成器（扫库自动生成，人不用手写）
//
// 与 report:params 的分工：
//   - `report:params` 回答"参数现在是多少"（工程状态）
//   - **本脚本回答"这个 Agent 干得怎么样"**（任务台账 / 效果指标 / 行为过程 / 能力实况 / 调参对比 / 环比）
//
// 数据来源：`data/runtime.db`（只读打开，绝不写入）—— `runs` 表 + `events` 表 + `runs.resultJson`
// 产物：
//   - `reports/AGENT_REPORT.md`            人读报告（每天覆盖）
//   - `reports/history/agent-YYYY-MM-DD.json` 指标快照（用于"与上次对比"）
//
// 用法：npm run report:agent   ／   REPORT_DAYS=3 npm run report:agent（只看最近 3 天）

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadEnv } from '../src/env.js';
import { loadConfig } from '../src/config.js';
import { SUB_AGENT_SPECS } from '../src/agents/specs.js';

loadEnv();
const config = loadConfig();

const DB_PATH = resolve(config.sqlitePath);
const OUT_DIR = resolve('reports');
const HISTORY_DIR = join(OUT_DIR, 'history');
const DAYS = Number(process.env.REPORT_DAYS ?? 0); // 0 = 全部

// ---------------------------------------------------------------------------
// 读取数据（只读）
// ---------------------------------------------------------------------------
interface RunRow {
  runId: string;
  runType: string;
  status: string;
  goal: string;
  createdAt: string;
  finalAnswer?: string | null;
  failureReason?: string | null;
  errorCode?: string | null;
  triggeredLimit?: string | null;
  steps: number;
  modelCalls: number;
  toolCalls: number;
  totalDurationMs: number;
  usageJson: string;
  isMock: number;
  resultJson?: string | null;
}
interface EventRow {
  seq: number;
  type: string;
  timestamp: string;
  dataJson?: string | null;
}

function openDb(): { db?: Database.Database; missing: boolean } {
  if (!existsSync(DB_PATH)) return { missing: true };
  try {
    return { db: new Database(DB_PATH, { readonly: true, fileMustExist: true }), missing: false };
  } catch {
    return { missing: true };
  }
}

const { db, missing } = openDb();
const stateHint = missing
  ? `> ⚠️ 未找到数据库 \`${config.sqlitePath}\`（或无法只读打开）——本次报告为空。先跑几个任务再来。`
  : '';

const cutoff = DAYS > 0 ? new Date(Date.now() - DAYS * 86400_000).toISOString() : '';
const runs: RunRow[] = db
  ? ((db
      .prepare(
        `SELECT * FROM runs ${cutoff ? 'WHERE createdAt >= ?' : ''} ORDER BY createdAt DESC`,
      )
      .all(...(cutoff ? [cutoff] : [])) as RunRow[]) ?? [])
  : [];

const eventsOf = (runId: string): EventRow[] =>
  db
    ? (db.prepare(`SELECT seq, type, timestamp, dataJson FROM events WHERE runId = ? ORDER BY seq ASC`).all(runId) as EventRow[])
    : [];

// ---------------------------------------------------------------------------
// 指标计算
// ---------------------------------------------------------------------------
interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  cachedPromptTokens?: number;
}
const usageOf = (r: RunRow): Usage => {
  try {
    return JSON.parse(r.usageJson || '{}') as Usage;
  } catch {
    return {};
  }
};
const OK = new Set(['completed']);
const AWAITING = new Set(['awaiting_user']);
const isOk = (r: RunRow) => OK.has(r.status);
const isAwaiting = (r: RunRow) => AWAITING.has(r.status);

function statsOf(rows: RunRow[]) {
  const n = rows.length;
  const ok = rows.filter(isOk).length;
  const awaiting = rows.filter(isAwaiting).length;
  const resolved = n - awaiting;
  const durations = rows.map((r) => r.totalDurationMs).sort((a, b) => a - b);
  const p95 = durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] : 0;
  const sum = (f: (r: RunRow) => number) => rows.reduce((a, r) => a + f(r), 0);
  return {
    n,
    ok,
    awaiting,
    successRate: resolved ? ok / resolved : 0,
    avgSteps: n ? sum((r) => r.steps) / n : 0,
    avgMs: n ? sum((r) => r.totalDurationMs) / n : 0,
    p95Ms: p95,
    tokens: sum((r) => usageOf(r).totalTokens ?? 0),
    cachedTokens: sum((r) => usageOf(r).cachedPromptTokens ?? 0),
    cost: sum((r) => usageOf(r).costUsd ?? 0),
    toolCalls: sum((r) => r.toolCalls),
    modelCalls: sum((r) => r.modelCalls),
  };
}

// Codex 是外部 Agent 适配器：与内置 Agent 分开统计（否则会拉低/混淆「内置 Agent 能力」口径）
const codexRuns = runs.filter((r) => r.runType === 'codex');
const coreRuns = runs.filter((r) => r.runType !== 'codex');
const real = coreRuns.filter((r) => !r.isMock);
const mock = coreRuns.filter((r) => !!r.isMock);
const all = statsOf(coreRuns);
const realStats = statsOf(real);
const codexStats = statsOf(codexRuns.filter((r) => !r.isMock));
const byType = ['codebase', 'research', 'misc', 'orchestrator', 'codex'].map((t) => ({
  type: t,
  ...statsOf(runs.filter((r) => r.runType === t)),
}));

// 失败原因分类（真实任务优先）
const failReasons = new Map<string, number>();
for (const r of coreRuns) {
  if (isOk(r) || isAwaiting(r)) continue;
  const key = r.errorCode ?? r.triggeredLimit ?? r.status;
  failReasons.set(key, (failReasons.get(key) ?? 0) + 1);
}
// 工具级失败码（从事件里统计最近任务的 tool_failed）
const toolFailCodes = new Map<string, number>();
let runtimeErrors = 0;
let subtasksTotal = 0;
let subtasksOk = 0;
if (db) {
  const tf = db
    .prepare(
      `SELECT json_extract(dataJson, '$.code') AS code, COUNT(*) AS c
       FROM events WHERE type = 'tool_failed' GROUP BY code ORDER BY c DESC LIMIT 10`,
    )
    .all() as { code: string | null; c: number }[];
  for (const row of tf) toolFailCodes.set(row.code ?? '(未知)', row.c);
  runtimeErrors = (db.prepare(`SELECT COUNT(*) c FROM events WHERE type = 'runtime_error'`).get() as any).c ?? 0;
  subtasksOk = (db.prepare(`SELECT COUNT(*) c FROM events WHERE type = 'subtask_completed'`).get() as any).c ?? 0;
  subtasksTotal =
    subtasksOk + ((db.prepare(`SELECT COUNT(*) c FROM events WHERE type = 'subtask_failed'`).get() as any).c ?? 0);
}

// ---------------------------------------------------------------------------
// 行为过程：挑样本（最"有代表性"的成功与失败）
// ---------------------------------------------------------------------------
function timeline(runId: string, maxLines = 18): string[] {
  const evs = eventsOf(runId);
  const out: string[] = [];
  const t0 = evs.length ? Date.parse(evs[0].timestamp) : Date.now();
  const at = (ts: string) => `+${((Date.parse(ts) - t0) / 1000).toFixed(1)}s`;
  const short = (v: unknown, n = 70) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
    return s.length > n ? s.slice(0, n) + '…' : s;
  };
  for (const e of evs) {
    const d = e.dataJson ? (JSON.parse(e.dataJson) as any) : {};
    if (e.type === 'model_request') out.push(`\`${at(e.timestamp)}\` 🧠 第 ${d.step ?? '?'} 轮推理（${d.name ?? ''}）`);
    else if (e.type === 'model_completed')
      out.push(
        `\`${at(e.timestamp)}\` 　└ 完成 ${Math.round(d.durationMs ?? 0)}ms · ${d.outputs?.toolCallCount ?? 0} 个工具决策 · ${d.usage?.totalTokens ?? 0} tok` +
          (d.outputs?.stopReason ? ` · ${d.outputs.stopReason}` : ''),
      );
    else if (e.type === 'tool_call_requested') out.push(`　　　🔧 调用 ${d.name}(${short(d.arguments, 60)})`);
    else if (e.type === 'tool_completed') out.push(`　　　✅ ${d.name} ${Math.round(d.durationMs ?? 0)}ms`);
    else if (e.type === 'tool_failed') out.push(`　　　❌ ${d.name} [${d.code}] ${short(d.message, 80)}`);
    else if (e.type === 'subtask_started') out.push(`　　🧩 子 Agent ${d.specId}：${short(d.objective, 60)}`);
    else if (e.type === 'subtask_completed' || e.type === 'subtask_failed')
      out.push(`　　${e.type === 'subtask_completed' ? '✅' : '❌'} 子 Agent ${d.specId} ${Math.round(d.durationMs ?? 0)}ms`);
    else if (e.type === 'runtime_error') out.push(`　　🚨 错误报告 [${d.code}] ${short(d.message, 70)} @ ${d.location ?? '-'}`);
    else if (e.type.startsWith('run_'))
      out.push(`\`${at(e.timestamp)}\` 🏁 ${e.type.replace('run_', '')} ${d.failureReason ? `· ${short(d.failureReason, 70)}` : ''}`);
    if (out.length >= maxLines) {
      out.push(`　　…（省略其余事件，共 ${evs.length} 条）`);
      break;
    }
  }
  return out;
}

const okSample = [...real].filter(isOk).sort((a, b) => b.steps - a.steps)[0] ?? [...runs].filter(isOk)[0];
const failSample =
  real.find((r) => r.status === 'limit_reached') ?? real.find((r) => r.status === 'failed') ?? runs.find((r) => !isOk(r) && !isAwaiting(r));

// ---------------------------------------------------------------------------
// 调参对比：按「模型 + 参数指纹」分组（参数来自 run_started.inputs.llm*）
// ---------------------------------------------------------------------------
interface ParamGroup {
  key: string;
  rows: RunRow[];
}
function paramFingerprint(runId: string): string {
  const start = eventsOf(runId).find((e) => e.type === 'run_started');
  const d = start?.dataJson ? (JSON.parse(start.dataJson) as any) : {};
  const inp = d.inputs ?? {};
  const params = inp.llmParams ? JSON.stringify(inp.llmParams) : '默认参数';
  return `${inp.isMock ? 'mock' : inp.llmModel ?? '未知模型'} ｜ ${params}`;
}
const paramGroups = new Map<string, RunRow[]>();
for (const r of runs) {
  const key = paramFingerprint(r.runId);
  const list = paramGroups.get(key) ?? [];
  list.push(r);
  paramGroups.set(key, list);
}
const paramTable: ParamGroup[] = [...paramGroups.entries()]
  .map(([key, rows]) => ({ key, rows }))
  .sort((a, b) => b.rows.length - a.rows.length)
  .slice(0, 8);

// ---------------------------------------------------------------------------
// 环比：与历史快照对比
// ---------------------------------------------------------------------------
interface Snapshot {
  date: string;
  generatedAt: string;
  totals: ReturnType<typeof statsOf>;
  real: ReturnType<typeof statsOf>;
  byType: { type: string; n: number; ok: number; avgMs: number; cost: number }[];
}
mkdirSync(HISTORY_DIR, { recursive: true });
const snapshotFiles = readdirSync(HISTORY_DIR)
  .filter((f) => /^agent-\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .sort();
const prevFile = snapshotFiles.length ? join(HISTORY_DIR, snapshotFiles[snapshotFiles.length - 1]) : '';
let prev: Snapshot | null = null;
if (prevFile) {
  try {
    prev = JSON.parse(readFileSync(prevFile, 'utf8')) as Snapshot;
  } catch {
    prev = null;
  }
}
const today = new Date().toISOString().slice(0, 10);
const delta = (a: number, b: number, fmt: (v: number) => string = (v) => v.toFixed(0)) => {
  const d = a - b;
  if (!isFinite(d) || d === 0) return '—';
  return `${d > 0 ? '↑' : '↓'} ${fmt(Math.abs(d))}`;
};

const snapshot: Snapshot = {
  date: today,
  generatedAt: new Date().toISOString(),
  totals: all,
  real: realStats,
  byType: byType.map((t) => ({ type: t.type, n: t.n, ok: t.ok, avgMs: t.avgMs, cost: t.cost })),
};
writeFileSync(join(HISTORY_DIR, `agent-${today}.json`), JSON.stringify(snapshot, null, 2), 'utf8');

// ---------------------------------------------------------------------------
// 生成报告
// ---------------------------------------------------------------------------
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);
const usd = (v: number) => `$${v.toFixed(5)}`;
const tbl = (h: string[], rows: (string | number)[][]) =>
  [`| ${h.join(' | ')} |`, `|${h.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

const L: string[] = [
  '<!-- 由 `npm run report:agent` 从 data/runtime.db 自动生成（只读扫描）。请勿手改：改数据请跑任务，改口径请改脚本。 -->',
  '',
  '# Agent 效果报告（自动生成）',
  '',
  `> 生成时间：**${new Date().toISOString().replace('T', ' ').slice(0, 19)}** ｜ 数据范围：**${DAYS > 0 ? `最近 ${DAYS} 天` : '全部历史'}** ｜ 数据源：\`${config.sqlitePath}\`（${runs.length} 个任务）`,
  '> 口径说明：**成功 = 状态 completed；成功率分母 = 已结束任务（排除 awaiting_user）**；`mock` 与真实模型分开统计（Mock 的成功率不代表真实模型能力）。',
  stateHint,
  '',
  '## 0. 与上次对比（环比）',
  prev
    ? tbl(
        ['指标', `上次（${prev.date}）`, '本次', '变化'],
        [
          ['任务数', prev.totals.n, all.n, delta(all.n, prev.totals.n)],
          ['成功率（全部）', pct(prev.totals.successRate), pct(all.successRate), delta(all.successRate, prev.totals.successRate, (v) => `${(v * 100).toFixed(1)}pp`)],
          ['成功率（真实模型）', pct(prev.real.successRate), pct(realStats.successRate), delta(realStats.successRate, prev.real.successRate, (v) => `${(v * 100).toFixed(1)}pp`)],
          ['平均耗时', ms(prev.totals.avgMs), ms(all.avgMs), delta(all.avgMs, prev.totals.avgMs, ms)],
          ['累计 tokens', prev.totals.tokens, all.tokens, delta(all.tokens, prev.totals.tokens)],
          ['累计成本', usd(prev.totals.cost), usd(all.cost), delta(all.cost, prev.totals.cost, usd)],
        ],
      )
    : '（首次生成，无历史快照可比；从明天起这里会显示环比）',
  '',
  '## 1. 任务台账与效果指标',
  '',
  '### 1.1 汇总',
  '',
  tbl(
    ['口径', '任务数', '成功', '等待用户', '成功率', '平均步数', '平均耗时', 'P95 耗时', 'tokens', '缓存命中', '成本'],
    [
      ['内置 Agent（全部）', all.n, all.ok, all.awaiting, pct(all.successRate), all.avgSteps.toFixed(1), ms(all.avgMs), ms(all.p95Ms), all.tokens, all.tokens ? pct(all.cachedTokens / all.tokens) : '—', usd(all.cost)],
      ['内置 Agent（真实模型）', realStats.n, realStats.ok, realStats.awaiting, pct(realStats.successRate), realStats.avgSteps.toFixed(1), ms(realStats.avgMs), ms(realStats.p95Ms), realStats.tokens, realStats.tokens ? pct(realStats.cachedTokens / realStats.tokens) : '—', usd(realStats.cost)],
      ['Codex 直连（真实）', codexStats.n, codexStats.ok, codexStats.awaiting, codexStats.n ? pct(codexStats.successRate) : '—', codexStats.n ? codexStats.avgSteps.toFixed(1) : '—', codexStats.n ? ms(codexStats.avgMs) : '—', codexStats.n ? ms(codexStats.p95Ms) : '—', codexStats.tokens, '—', '费用未计入'],
      ['Mock（仅演示）', mock.length, mock.filter(isOk).length, mock.filter(isAwaiting).length, pct(mock.length ? mock.filter(isOk).length / Math.max(1, mock.length - mock.filter(isAwaiting).length) : 0), '—', ms(mock.length ? statsOf(mock).avgMs : 0), '—', mock.reduce((a, r) => a + (usageOf(r).totalTokens ?? 0), 0), '—', '—'],
    ],
  ),
  '',
  '### 1.2 各 Agent 表现（按 runType）',
  '',
  tbl(
    ['Agent', '任务数', '等待用户', '成功率', '平均步数', '平均耗时', '工具调用总数', '模型调用总数', '成本'],
    byType.map((t) => [t.type, t.n, t.awaiting, t.n ? pct(t.successRate) : '—', t.avgSteps.toFixed(1), ms(t.avgMs), t.toolCalls, t.modelCalls, usd(t.cost)]),
  ),
  `\n> 编排子任务：**${subtasksOk}/${subtasksTotal}** 成功（来自 \`subtask_completed\` / \`subtask_failed\` 事件）。`,
  '',
  '### 1.3 失败原因分类',
  '',
  failReasons.size
    ? tbl(['原因', '次数'], [...failReasons.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [`\`${k}\``, v]))
    : '（无失败任务）',
  toolFailCodes.size
    ? `\n**工具级失败码（Top 10）**\n\n${tbl(['错误码', '次数'], [...toolFailCodes.entries()].map(([k, v]) => [`\`${k}\``, v]))}`
    : '',
  `\n**结构化错误报告累计**：${runtimeErrors} 条（\`runtime_error\` 事件；明细见 \`data/errors.log\` 与 \`GET /api/errors\`）。`,
  '',
  '### 1.4 任务明细（最近 20 条）',
  '',
  runs.length
    ? tbl(
        ['时间', 'Agent', '状态', '目标', '步/模型/工具', '耗时', 'tokens', '成本', '结果摘要'],
        runs.slice(0, 20).map((r) => [
          r.createdAt.slice(5, 16).replace('T', ' '),
          r.runType + (r.isMock ? '(mock)' : ''),
          isOk(r) ? '✅' : r.status === 'awaiting_user' ? '⏸️ awaiting_user' : `❌ ${r.errorCode ?? r.status}`,
          (r.goal ?? '').replace(/\n/g, ' ').slice(0, 34),
          `${r.steps}/${r.modelCalls}/${r.toolCalls}`,
          ms(r.totalDurationMs),
          usageOf(r).totalTokens ?? 0,
          usd(usageOf(r).costUsd ?? 0),
          ((r.finalAnswer ?? r.failureReason ?? '') as string).replace(/\n/g, ' ').slice(0, 40),
        ]),
      )
    : '（无数据）',
  '',
  '## 2. 行为过程报告（典型样本逐帧）',
  '',
  okSample
    ? [
        `### 2.1 成功样本 · \`${okSample.runType}\` · ${okSample.steps} 步 / ${ms(okSample.totalDurationMs)}`,
        '',
        `**目标**：${okSample.goal}`,
        '',
        ...timeline(okSample.runId),
        '',
        `**结论**：${((okSample.finalAnswer ?? '(无)') as string).replace(/\n/g, ' ').slice(0, 200)}`,
      ].join('\n')
    : '（暂无成功样本）',
  '',
  failSample
    ? [
        `### 2.2 失败样本 · \`${failSample.runType}\` · ${failSample.status}${failSample.errorCode ? ` (${failSample.errorCode})` : ''}`,
        '',
        `**目标**：${failSample.goal}`,
        '',
        ...timeline(failSample.runId, 14),
        '',
        `**失败原因**：${failSample.failureReason ?? '(未记录)'}${failSample.triggeredLimit ? ` ／ 触发限制：${failSample.triggeredLimit}` : ''}`,
      ].join('\n')
    : '（无失败样本 —— 好事）',
  '',
  '## 3. 能力边界实况（实测数字 + 未验证项）',
  '',
  '| Agent | 现在能做什么 | 实测表现 | 还没验证 / 做不到 |',
  '|---|---|---|---|',
  ...[
    {
      type: 'codebase',
      can: '读代码、搜索、受限测试（白名单）；跨文件定位与解释',
      limits: '真实 `run_tests` 默认关闭；不能改代码',
    },
    {
      type: 'research',
      can: '检索资料、抓取网页、提取证据、比对来源',
      limits: '`web_search` 默认 OFFLINE_MOCK（非实时）；真实 Serper 未验证',
    },
    {
      type: 'misc',
      can: '只读清点 / 定位 / 小文件解释；结构化上报',
      limits: '无写权限（刻意）；超范围只上报不改派',
    },
    {
      type: 'orchestrator',
      can: '拆分成独立子任务并行派发 → 汇总核验',
      limits: '深度 ≤1；真实并行收益未与串行基线 A/B 对比',
    },
  ].map((a) => {
    const t = byType.find((x) => x.type === a.type)!;
    return [
      `**${a.type}**`,
      a.can,
      t.n ? `任务 ${t.n} 次 · 成功率 ${pct(t.successRate)} · 平均 ${ms(t.avgMs)}` : '尚无实测数据',
      a.limits,
    ];
  }),
  '',
  `> 子 Agent 契约（${SUB_AGENT_SPECS.length} 个）：${SUB_AGENT_SPECS.map((s) => `\`${s.id}\`(${s.budget.maxSteps} 步/${s.budget.tokenBudget} tok)`).join('、')}`,
  '',
  '## 4. 调参效果对比（按「模型 + 参数指纹」分组）',
  '',
  paramTable.length > 1
    ? tbl(
        ['模型 ｜ 参数', '任务数', '成功率', '平均耗时', '平均 tokens', '平均成本', '平均步数'],
        paramTable.map((g) => {
          const s = statsOf(g.rows);
          return [g.key, s.n, pct(s.successRate), ms(s.avgMs), Math.round(s.tokens / Math.max(1, s.n)), usd(s.cost / Math.max(1, s.n)), s.avgSteps.toFixed(1)];
        }),
      )
    : '（当前只有一种参数组合，无法对比。换个模型或改 `thinking`/`max_tokens` 再跑同类任务，这里就会出现对比表。）',
  '',
  '---',
  '',
  '## 附：这份报告怎么用',
  '',
  '1. **看环比**（§0）：任务数/成功率/成本是否在变好；异常波动从这里开始查。',
  '2. **看失败分类**（§1.3）：某类错误码突然变多 → 去 `docs/ERROR_REPORTING.md` 的错误码表对照处理。',
  '3. **看行为样本**（§2）：判断"它是不是在瞎试"——工具调用是否收敛、有没有反复重试同一动作。',
  '4. **看能力实况**（§3）：哪些 Agent 有实测数据、哪些还是空白 —— 空白就是下一步该补的验证。',
  '5. **看调参对比**（§4）：同任务不同参数的效果/成本差异，直接支撑"该怎么调"。',
  '',
  `> 历史快照：\`reports/history/agent-YYYY-MM-DD.json\`（每天一份指标快照，供环比与趋势分析；当前保留 ${snapshotFiles.length + 1} 份）。`,
  '',
];

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'AGENT_REPORT.md'), L.join('\n'), 'utf8');
db?.close();

console.log(`[report:agent] 已生成 reports/AGENT_REPORT.md`);
console.log(
  `  任务 ${all.n} 个（真实 ${realStats.n} / mock ${mock.length}）· 成功率 ${pct(all.successRate)}（真实 ${pct(realStats.successRate)}）· 平均耗时 ${ms(all.avgMs)} · 成本 ${usd(all.cost)}`,
  `  Codex 直连 ${codexStats.n} 个 · 成功率 ${codexStats.n ? pct(codexStats.successRate) : '—'} · 平均耗时 ${codexStats.n ? ms(codexStats.avgMs) : '—'} · tokens ${codexStats.tokens}（费用未计入）`,
);
console.log(`  快照：reports/history/agent-${today}.json${prev ? `（环比对象：${prev.date}）` : '（首次）'}`);
