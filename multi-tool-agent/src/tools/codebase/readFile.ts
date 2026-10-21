// src/tools/codebase/readFile.ts — 读取仓库内指定文件（防穿越 + 行范围 + 长度限制）
import { existsSync, readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import type { Tool, ToolContext } from '../types.js';
import type { ToolResult } from '../../types.js';
import { okResult, errResult } from '../types.js';
import { isSensitive } from './security.js';
import { resolveWorkspacePath, listRootEntries } from '../shared/workspacePath.js';

// `file` / `filename` / `filepath` 都是 `path` 的别名：真实模型常写 file，此前会直接 INVALID_ARGS
// 白耗一次工具调用额度（在子 Agent 的小预算下很容易致命）。
/** 读前预检：超过该大小直接拒绝，避免 readFileSync 把大文件整个吞进内存。 */
const MAX_FILE_READ_BYTES = 8 * 1024 * 1024;

const inputSchema = z.object({
  path: z.string().optional().describe('要读取的路径（相对仓库根；也可传工作区相对/绝对路径）'),
  file: z.string().optional().describe('path 的别名（等价写法）'),
  filename: z.string().optional().describe('path 的别名（等价写法）'),
  filepath: z.string().optional().describe('path 的别名（等价写法）'),
  startLine: z.number().int().min(1).optional().describe('起始行（从 1 开始）'),
  maxLines: z.number().int().min(1).max(2000).default(200).catch(200).describe('最多读取行数（1~2000）'),
  maxLength: z.number().int().min(1).max(200000).default(20000).catch(20000).describe('最大读取字符数（1~200000）'),
});

export const readFile: Tool = {
  name: 'read_file',
  description: '读取仓库内指定文件，支持行范围与最大读取长度，禁止访问仓库目录之外的文件。',
  inputSchema,
  timeoutMs: 5000,
  permission: 'codebase:read',
  riskLevel: 'safe',
  execute(input: unknown, ctx: ToolContext): ToolResult {
    const started = Date.now();
    try {
      if (!ctx.repoPath) return errResult('CONFIG', '未配置 repoPath', Date.now() - started);
      const args = input as z.infer<typeof inputSchema>;
      const raw = args.path ?? args.file ?? args.filename ?? args.filepath;
      if (!raw) {
        return errResult(
          'MISSING_ARGS',
          '缺少 path（也可用 file / filename / filepath）。示例: {"path": "src/calc.js"}',
          Date.now() - started,
        );
      }
      // 两段式解析：
      //   ① 先按「存在性」在多种候选形态里挑（相对仓库根 / 工作区相对 / 绝对）；
      //   ② 若都不存在，再用**词法**解析拿到一个候选，以便优先报出「越权」「敏感文件」这类安全结论，
      //      而不是把它们误报成"文件不存在"。
      let resolved = resolveWorkspacePath(ctx.repoPath, raw, { allowRoot: false });
      if (!resolved.ok && !resolved.escaped) {
        const lexical = resolveWorkspacePath(ctx.repoPath, raw, { allowRoot: false, requireExists: false });
        if (lexical.ok) resolved = lexical;
      }
      if (!resolved.ok) {
        return errResult(
          resolved.escaped ? 'PATH_ESCAPE' : 'NOT_FOUND',
          `${resolved.reason}。${resolved.hint}`,
          Date.now() - started,
        );
      }
      const abs = resolved.abs;
      const name = abs.split(/[\\/]/).pop()!;
      if (isSensitive(name)) return errResult('SENSITIVE', `拒绝读取敏感文件: ${name}`, Date.now() - started);
      // M1'（R15-①）：写上下文（已注入沙箱）优先读沙箱 work 副本——
      // 子 Agent 刚 staged 的文件在真实仓库里可能还不存在（create）或仍是旧内容（edit），
      // 读真实仓库会让它"读不到自己刚写的文件"（真实实测：PATH_NOT_FOUND 后模型被迫绕开）。
      // readWorkFile 语义：staged → 读副本；未 staged → 回落真实仓库；已删除 → null。
      let content: string;
      let source: 'repo' | 'sandbox' = 'repo';
      if (ctx.sandbox) {
        // 沙箱副本同样要先做大小预检，否则 readWorkFile 会把超大文件整块读进内存。
        const sandboxSize = ctx.sandbox.workFileSize?.(resolved.rel);
        if (sandboxSize !== undefined && sandboxSize !== null && sandboxSize > MAX_FILE_READ_BYTES) {
          return errResult(
            'FILE_TOO_LARGE',
            `文件过大：${resolved.rel}（${sandboxSize} 字节 > ${MAX_FILE_READ_BYTES}）；请用 search_files 或指定更小的文件。`,
            Date.now() - started,
          );
        }
        const work = ctx.sandbox.readWorkFile(resolved.rel);
        if (work === null) {
          return errResult('NOT_FOUND', `文件在沙箱工作区中不存在（可能已被删除）：${resolved.rel}`, Date.now() - started);
        }
        content = work;
        source = 'sandbox';
      } else {
        if (!existsSync(abs)) {
          return errResult('NOT_FOUND', `文件不存在：${resolved.rel}。${listRootEntries(ctx.repoPath).length ? `仓库根下的可用条目: ${listRootEntries(ctx.repoPath).join(', ')}` : ''}`, Date.now() - started);
        }
        const size = statSync(abs).size;
        if (size > MAX_FILE_READ_BYTES) {
          return errResult(
            'FILE_TOO_LARGE',
            `文件过大：${resolved.rel}（${size} 字节 > ${MAX_FILE_READ_BYTES}）；请用 search_files 或指定更小的文件。`,
            Date.now() - started,
          );
        }
        try {
          const buf = readFileSync(abs);
          content = buf.toString('utf8');
        } catch (e) {
          return errResult('READ_ERROR', `无法读取文件: ${(e as Error).message}`, Date.now() - started);
        }
      }

      const lines = content.split('\n');
      const start = args.startLine ? args.startLine - 1 : 0;
      let slice = lines.slice(start, start + args.maxLines).join('\n');
      let truncated = false;
      if (slice.length > args.maxLength) {
        slice = slice.slice(0, args.maxLength) + '\n…[truncated]';
        truncated = true;
      }
      return okResult({ path: source === 'sandbox' ? resolved.rel : abs, lines: lines.length, content: slice, source }, Date.now() - started, truncated);
    } catch (e) {
      return errResult('READ_ERROR', (e as Error).message, Date.now() - started);
    }
  },
};
