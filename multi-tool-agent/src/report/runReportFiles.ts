// src/report/runReportFiles.ts — run 报告的落盘与索引（I/O 层，builder 保持纯函数）
//
// 产物：
//   reports/runs/<runId>.md    单 run 报告（首行带 meta 注释，供 INDEX 重建）
//   reports/runs/INDEX.md      索引（每次写入后全量重建 → 幂等）
//
// 设计约束：
//   - 幂等：同一 run 重跑覆盖同一文件；INDEX 全量重建，不增量追加（避免漂移）；
//   - 原子：先写临时文件再 rename（避免中断留下半截报告）；
//   - 只读 DB：本模块不碰数据库。

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TraceEvent } from '../types.js';
import { buildRunReport, buildRunReportIndex, parseRunReportMeta, type RunReportMeta, type RunReportRun } from './runReport.js';

export interface WriteRunReportInput {
  dir: string;
  run: RunReportRun;
  events: TraceEvent[];
  generatedAt: string;
}

/** 写单份报告；返回文件路径与 meta */
export function writeRunReport(input: WriteRunReportInput): { file: string; meta: RunReportMeta } {
  const { dir, run, events, generatedAt } = input;
  mkdirSync(dir, { recursive: true });
  const { markdown, meta } = buildRunReport({ run, events, generatedAt });
  const file = join(dir, `${run.runId}.md`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, markdown, 'utf8');
  renameSync(tmp, file);
  return { file, meta };
}

/** 扫描目录里所有报告的 meta（坏文件跳过，不抛错） */
export function listRunReportMetas(dir: string): RunReportMeta[] {
  if (!existsSync(dir)) return [];
  const metas: RunReportMeta[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md') || name === 'INDEX.md') continue;
    try {
      const meta = parseRunReportMeta(readFileSync(join(dir, name), 'utf8'));
      if (meta) metas.push(meta);
    } catch {
      /* 坏文件跳过 */
    }
  }
  return metas;
}

/** 全量重建 INDEX.md（幂等）；返回索引文件路径与条目数 */
export function regenerateRunReportIndex(dir: string): { file: string; count: number } {
  mkdirSync(dir, { recursive: true });
  const metas = listRunReportMetas(dir);
  const file = join(dir, 'INDEX.md');
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, buildRunReportIndex(metas), 'utf8');
  renameSync(tmp, file);
  return { file, count: metas.length };
}