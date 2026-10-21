// src/tools/codebase/listFiles.ts — 列出允许访问的仓库文件（深度/数量限制）
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';
import type { Tool, ToolContext } from '../types.js';
import type { ToolResult } from '../../types.js';
import { okResult, errResult } from '../types.js';
import { assertInsideRepo, EXCLUDED_DIRS, isSensitive } from './security.js';
import { resolveWorkspacePath } from '../shared/workspacePath.js';

// 注意：`path` 是 `dir` 的别名——真实模型经常写 path；此前会被 Zod 静默丢弃，
// 导致「本想列 src，结果列了整个仓库」这种**静默错误结果**（比报错更危险），故显式接受别名。
const inputSchema = z.object({
  dir: z.string().optional().describe('相对于仓库根的目录（默认仓库根；也可传工作区相对/绝对路径）'),
  path: z.string().optional().describe('dir 的别名（等价写法）'),
  maxDepth: z.number().int().min(1).max(10).default(3).catch(3).describe('最大递归深度（1~10）'),
  limit: z.number().int().min(1).max(500).default(200).catch(200).describe('最大返回条目数（1~500）'),
});

export const listFiles: Tool = {
  name: 'list_files',
  description: '列出允许访问的仓库文件，限制递归深度与返回数量，排除依赖/构建/元数据目录。',
  inputSchema,
  timeoutMs: 5000,
  permission: 'codebase:read',
  riskLevel: 'safe',
  execute(input: unknown, ctx: ToolContext): ToolResult {
    const started = Date.now();
    try {
      if (!ctx.repoPath) return errResult('CONFIG', '未配置 repoPath', Date.now() - started);
      const root = assertInsideRepo(ctx.repoPath, ctx.repoPath);
      const args = input as z.infer<typeof inputSchema>;
      const resolved = resolveWorkspacePath(root, args.dir ?? args.path);
      if (!resolved.ok) {
        return errResult(
        resolved.escaped ? 'PATH_ESCAPE' : 'NOT_FOUND',
        `${resolved.reason}。${resolved.hint}`,
        Date.now() - started,
      );
      }
      const base = resolved.abs;
      const files: string[] = [];
      const walk = (dir: string, depth: number): void => {
        if (files.length >= args.limit) return;
        let entries: string[];
        try {
          entries = readdirSync(dir);
        } catch {
          return;
        }
        for (const name of entries) {
          if (files.length >= args.limit) break;
          if (EXCLUDED_DIRS.has(name)) continue;
          const full = join(dir, name);
          let st;
          try {
            st = statSync(full);
          } catch {
            continue;
          }
          const rel = relative(root, full).split('\\').join('/');
          if (st.isDirectory()) {
            files.push(`${rel}/`);
            if (depth < args.maxDepth) walk(full, depth + 1);
          } else if (!isSensitive(name)) {
            files.push(rel);
          }
        }
      };
      walk(base, 1);
      const truncated = files.length >= args.limit;
      return okResult({ files, count: files.length, truncated }, Date.now() - started, truncated);
    } catch (e) {
      return errResult('LIST_ERROR', (e as Error).message, Date.now() - started);
    }
  },
};
