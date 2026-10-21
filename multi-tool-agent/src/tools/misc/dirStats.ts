// src/tools/misc/dirStats.ts — 目录清点统计（杂项 Agent 专用，只读）
// 用途：回答「这个目录有多少文件 / 按扩展名怎么分布 / 最大的几个文件是什么」这类低价值但耗时的问题，
//       替代让模型逐个 read_file 的低效做法。
// 边界：只读；忽略依赖/构建目录；有扫描条目与深度上限；绝不跟随符号链接（避免越界与环）。

import { z } from 'zod';
import { lstatSync, readdirSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import type { Tool, ToolContext } from '../types.js';
import type { ToolResult } from '../../types.js';
import { okResult, errResult } from '../types.js';
import { EXCLUDED_DIRS, isSensitive } from '../codebase/security.js';
import { resolveWorkspacePath } from '../shared/workspacePath.js';

const inputSchema = z.object({
  /** 相对仓库根的目录（默认仓库根）；也接受工作区相对/绝对路径 */
  dir: z.string().optional().describe('要统计的目录（相对仓库根，例如 src；也可传工作区相对/绝对路径）'),
  /** dir 的别名（模型常写 path；此前会被静默丢弃 → 统计错目录） */
  path: z.string().optional().describe('dir 的别名（等价写法）'),
  /** 最大递归深度 */
  maxDepth: z.number().int().min(0).max(8).default(4).catch(4).describe('最大递归深度（0~8，默认 4）'),
  /** 返回「最大文件」的数量 */
  topN: z.number().int().min(1).max(20).default(5).catch(5).describe('返回最大的 N 个文件（1~20，默认 5）'),
});

interface FileEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

export const dirStats: Tool = {
  name: 'dir_stats',
  description:
    '统计一个目录（相对仓库根）：文件数、总大小、按扩展名分布、最大的若干文件、最新/最旧文件。只读，忽略依赖与构建目录。适用于「清点/概览」类琐事。',
  inputSchema,
  timeoutMs: 8000,
  permission: 'misc:read',
  riskLevel: 'safe',
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const started = Date.now();
    const args = input as z.infer<typeof inputSchema>;
    const repoPath = ctx.repoPath;
    if (!repoPath) {
      return errResult('NO_WORKSPACE', '未提供工作区根目录（repoPath），无法统计', Date.now() - started);
    }

    const scanLimit = Math.min(ctx.config.misc?.scanLimit ?? 5000, 50000);
    // 宽容路径解析：接受相对仓库根 / 工作区相对 / 绝对路径；失败时给出可用的顶层目录
    const resolved = resolveWorkspacePath(repoPath, args.dir ?? (input as any).path);
    if (!resolved.ok) {
      return errResult(
        resolved.escaped ? 'PATH_ESCAPE' : 'NOT_FOUND',
        `${resolved.reason}。${resolved.hint}`,
        Date.now() - started,
      );
    }
    const base = resolved.abs;

    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(base);
    } catch {
      return errResult('NOT_FOUND', `路径不可访问: ${resolved.rel}`, Date.now() - started);
    }
    if (!stat.isDirectory()) {
      return errResult('NOT_A_DIR', `不是目录（是文件）: ${resolved.rel}。若要看单文件内容请用 read_file`, Date.now() - started);
    }

    const files: FileEntry[] = [];
    let dirCount = 0;
    let skippedDirs = 0;
    let sensitiveSkipped = 0;
    let truncated = false;
    let visited = 0;

    const walk = (dir: string, depth: number): void => {
      if (depth > args.maxDepth || truncated) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return; // 无权限/竞态删除：跳过而不是让整个任务失败
      }
      for (const name of entries) {
        if (truncated) return;
        if (visited >= scanLimit) {
          truncated = true;
          return;
        }
        const full = join(dir, name);
        let st: ReturnType<typeof lstatSync>;
        try {
          st = lstatSync(full);
        } catch {
          continue;
        }
        visited += 1;
        if (st.isSymbolicLink()) continue; // 不跟随符号链接（防越界/环路）
        if (st.isDirectory()) {
          if (EXCLUDED_DIRS.has(name)) {
            skippedDirs += 1;
            continue;
          }
          dirCount += 1;
          walk(full, depth + 1);
        } else if (st.isFile()) {
          // 敏感文件（.env / *.key 等）只统计数量、不记录路径，避免报告里泄露文件名
          if (isSensitive(name)) {
            sensitiveSkipped += 1;
            continue;
          }
          files.push({ path: relative(repoPath, full).split(sep).join('/'), size: st.size, mtimeMs: st.mtimeMs });
        }
      }
    };

    const t0 = Date.now();
    walk(base, 0);
    const scanMs = Date.now() - t0;

    const byExt = new Map<string, { count: number; size: number }>();
    let totalSize = 0;
    for (const f of files) {
      totalSize += f.size;
      const ext = extname(f.path).toLowerCase() || '(无扩展名)';
      const cur = byExt.get(ext) ?? { count: 0, size: 0 };
      cur.count += 1;
      cur.size += f.size;
      byExt.set(ext, cur);
    }

    const top = [...files].sort((a, b) => b.size - a.size).slice(0, args.topN);
    const newest = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    const oldest = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs)[0];
    const extensions = [...byExt.entries()]
      .map(([ext, v]) => ({ ext, count: v.count, size: v.size, sizeHuman: humanSize(v.size) }))
      .sort((a, b) => b.count - a.count || b.size - a.size);

    return okResult(
      {
        dir: resolved.rel,
        maxDepth: args.maxDepth,
        fileCount: files.length,
        dirCount,
        totalSize,
        totalSizeHuman: humanSize(totalSize),
        extensions,
        largest: top.map((f) => ({ path: f.path, size: f.size, sizeHuman: humanSize(f.size) })),
        newest: newest ? { path: newest.path, mtime: new Date(newest.mtimeMs).toISOString() } : null,
        oldest: oldest ? { path: oldest.path, mtime: new Date(oldest.mtimeMs).toISOString() } : null,
        skippedDirs,
        sensitiveSkipped,
        truncated,
        scanMs,
        note: truncated
          ? `已达扫描上限 ${scanLimit} 条目，统计结果不完整（可缩小 dir 或降低 maxDepth）`
          : undefined,
      },
      Date.now() - started,
      truncated,
    );
  },
};
