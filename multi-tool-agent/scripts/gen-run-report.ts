// scripts/gen-run-report.ts — run 级报告生成器（流程图 + 分层量化 + 六阶段错误归因）
//
// 回答的问题：**这一次 run 到底发生了什么、消耗在哪一层、卡在哪个阶段**。
//   - 与 report:agent 的分工：那份是"所有 run 的台账与效果"，这份是"单个 run 的事故/执行还原"；
//   - 与前端「流程监控」的分工：那份是可视化图表，这份是可 diff、可入库、可贴进 issue 的 Markdown。
//
// 数据源：`runs` 行 + `events` 事件流 + `runs.resultJson`（只读打开，绝不写入）
// 产物：`reports/runs/<runId>.md` + `reports/runs/INDEX.md`（全量重建，幂等）
//
// 用法：
//   npm run report:run -- <runId> [<runId> ...]
//   npm run report:run -- --last 5          # 最近 5 个 run
//   npm run report:run -- --all
//   node --import tsx scripts/gen-run-report.ts <runId> --db ./data/m1-e2e.db --out-dir reports/runs

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv } from '../src/env.js';
import { loadConfig } from '../src/config.js';
import { writeRunReport, regenerateRunReportIndex } from '../src/report/runReportFiles.js';
import type { RunReportRun } from '../src/report/runReport.js';
import type { TraceEvent, TraceEventType } from '../src/types.js';

loadEnv();
const config = loadConfig();

const argv = process.argv.slice(2);
function take(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, v && !v.startsWith('--') ? 2 : 1);
  return v;
}
const all = argv.includes('--all');
if (all) argv.splice(argv.indexOf('--all'), 1);
const last = Number(take('--last') ?? 0) || 0;
const dbPath = resolve(take('--db') ?? config.sqlitePath);
const outDir = resolve(take('--out-dir') ?? 'reports/runs');
const ids = argv.filter((a) => !a.startsWith('--'));

if (!existsSync(dbPath)) {
  console.error(`[report:run] 数据库不存在：${dbPath}`);
  process.exit(1);
}
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const RUN_COLUMNS = `runId, runType, status, goal, createdAt, updatedAt, finalAnswer, failureReason,
  errorCode, triggeredLimit, steps, modelCalls, toolCalls, totalDurationMs, usageJson, isMock, resultJson`;

function getRun(runId: string): RunReportRun | undefined {
  return db.prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE runId = ?`).get(runId) as RunReportRun | undefined;
}
function getEvents(runId: string): TraceEvent[] {
  const rows = db.prepare(`SELECT runId, seq, type, timestamp, dataJson FROM events WHERE runId = ? ORDER BY seq ASC`).all(runId) as Array<{
    runId: string;
    seq: number;
    type: string;
    timestamp: string;
    dataJson?: string | null;
  }>;
  return rows.map((r) => {
    let data: Record<string, unknown> | undefined;
    if (r.dataJson) {
      try {
        data = JSON.parse(r.dataJson) as Record<string, unknown>;
      } catch {
        data = undefined;
      }
    }
    return { runId: r.runId, seq: r.seq, type: r.type as TraceEventType, timestamp: r.timestamp, data };
  });
}

let targets = ids;
if (!targets.length && (last > 0 || all)) {
  const rows = db
    .prepare(`SELECT runId FROM runs ORDER BY createdAt DESC ${all ? '' : 'LIMIT ?'}`)
    .all(...(all ? [] : [last])) as Array<{ runId: string }>;
  targets = rows.map((r) => r.runId);
}

if (!targets.length) {
  console.error('用法：npm run report:run -- <runId> | --last <n> | --all [--db <path>] [--out-dir <dir>]');
  console.error('\n最近 10 个 run：');
  for (const r of db.prepare(`SELECT runId, runType, status, createdAt FROM runs ORDER BY createdAt DESC LIMIT 10`).all() as Array<{ runId: string; runType: string; status: string; createdAt: string }>) {
    console.error(`  ${r.runId}  ${r.runType}  ${r.status}  ${r.createdAt}`);
  }
  process.exit(1);
}

const generatedAt = new Date().toISOString();
let ok = 0;
let missing = 0;
for (const runId of targets) {
  const run = getRun(runId);
  if (!run) {
    console.error(`  ✗ ${runId}（库中不存在）`);
    missing += 1;
    continue;
  }
  const events = getEvents(runId);
  const { file, meta } = writeRunReport({ dir: outDir, run, events, generatedAt });
  console.log(`  ✓ ${file.replace(`${resolve('.')}\\`, '')}  [${meta.stages.map((s) => s.verdict).join('/')}]`);
  console.log(`      ${meta.headline}`);
  ok += 1;
}
const index = regenerateRunReportIndex(outDir);
console.log(`[report:run] 生成 ${ok} 份${missing ? `（${missing} 个 runId 不存在）` : ''}；索引 ${index.file}（共 ${index.count} 份）`);
db.close();