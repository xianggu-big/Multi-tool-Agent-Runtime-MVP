// src/tools/codebase/searchFiles.ts — 在仓库内搜索文件或文本
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { z } from 'zod';
import type { Tool, ToolContext } from '../types.js';
import type { ToolResult } from '../../types.js';
import { okResult, errResult } from '../types.js';
import { assertInsideRepo, EXCLUDED_DIRS, isSensitive } from './security.js';
import { resolveWorkspacePath } from '../shared/workspacePath.js';

// `query` / `keyword` 是 `pattern` 的别名：真实模型极常这么写，此前每次都 INVALID_ARGS
// （实测一次多 Agent 运行里因此产生了 11 次无效工具调用，直接吃光子 Agent 预算）。
const inputSchema = z.object({
  pattern: z.string().min(1).optional().describe('要匹配的文件名片段或文本内容（必填；也可用 query / keyword）。多关键词用 OR 写法：A|B'),
  query: z.string().min(1).optional().describe('pattern 的别名（等价写法）'),
  keyword: z.string().min(1).optional().describe('pattern 的别名（等价写法）'),
  // kind 接受同义词（真实模型会写 text/name/grep）——见 execute 里的归一化。
  // P0-3 修复：默认值由 filename 改为 content（不传 kind 做内容搜索，不再静默 0 命中）
  kind: z.string().optional().describe('匹配方式：content（按内容，默认）或 filename（按文件名）；同义词 name/file→filename、text/code/grep→content'),
  // P0-3 修复：此前 path 不在 schema 里、被 Zod 静默丢弃（"在 X 目录内搜索"退化成全仓搜索）
  path: z.string().optional().describe('限定搜索目录（相对仓库根，如 "src/runtime"；别名 dir / subdir）'),
  dir: z.string().optional().describe('path 的别名（等价写法）'),
  subdir: z.string().optional().describe('path 的别名（等价写法）'),
  fileTypes: z.array(z.string()).optional().describe('仅在这些扩展名中搜索，如 ["ts","js"]'),
  // 数值越界回落默认值（.catch）：这类参数"取默认"不会产生错误结果，但能省掉一次失败的往返
  limit: z.number().int().min(1).max(200).default(50).catch(50).describe('最大返回匹配数（1~200）'),
  maxDepth: z.number().int().min(1).max(12).default(8).catch(8).describe('最大递归深度（1~12）'),
  maxOutputLength: z.number().int().min(100).max(20000).default(4000).catch(4000).describe('结果文本最大长度'),
});

/** 单个 glob 片段 → 正则源码（转义元字符，保留 * 与 ?） */
function globEscape(p: string): string {
  return p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
}

/**
 * pattern → 正则：`A|B|C` 为 OR（多关键词）；无 `|` 时为单片段 glob。
 * P0-3 修复：此前整串（含 `|`）被转义成字面量——"TODO|FIXME" 恒 0 命中（实测 UI/编排多次踩中）。
 */
function patternToRegex(p: string): RegExp {
  const parts = p
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
  const alts = (parts.length ? parts : [p]).map(globEscape);
  return new RegExp(alts.length > 1 ? `(?:${alts.join('|')})` : alts[0], 'i');
}

const CONTENT_KINDS = ['content', 'text', 'code', 'grep', 'body'];
const FILENAME_KINDS = ['filename', 'name', 'file', 'path', 'glob'];

function isText(buf: Buffer): boolean {
  for (let i = 0; i < Math.min(buf.length, 8000); i++) {
    if (buf[i] === 0) return false;
  }
  return true;
}

interface Match {
  file: string;
  line?: number;
  snippet?: string;
}

function walk(
  dir: string,
  root: string,
  depth: number,
  maxDepth: number,
  out: Match[],
  opts: { kind: 'filename' | 'content'; pattern: RegExp; fileTypes?: string[]; limit: number },
  seen: Set<string>,
): void {
  if (out.length >= opts.limit) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (out.length >= opts.limit) break;
    if (EXCLUDED_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (depth < maxDepth) walk(full, root, depth + 1, maxDepth, out, opts, seen);
      continue;
    }
    if (isSensitive(name)) continue;

    if (opts.kind === 'filename') {
      if (opts.pattern.test(name) && (!opts.fileTypes || opts.fileTypes.includes(extname(name).slice(1)))) {
        const rel = full.slice(root.length + 1).split('\\').join('/');
        if (!seen.has(rel)) {
          seen.add(rel);
          out.push({ file: rel });
        }
      }
    } else {
      if (opts.fileTypes && !opts.fileTypes.includes(extname(name).slice(1))) continue;
      // 内容搜索
      let buf: Buffer;
      try {
        buf = readFileSync(full);
      } catch {
        continue;
      }
      if (!isText(buf) || buf.length > 2_000_000) continue;
      const text = buf.toString('utf8');
      const lines = text.split('\n');
      const hits: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (opts.pattern.test(lines[i])) {
          hits.push(`${i + 1}: ${lines[i].slice(0, 200).trim()}`);
          if (hits.length >= 5) break;
        }
      }
      if (hits.length) {
        const rel = full.slice(root.length + 1).split('\\').join('/');
        if (!seen.has(rel)) {
          seen.add(rel);
          out.push({ file: rel, line: parseInt(hits[0], 10) || undefined, snippet: hits.join(' | ') });
        }
      }
    }
  }
}

export const searchFiles: Tool = {
  name: 'search_files',
  description: '在仓库（或指定目录）内按内容或文件名搜索，多关键词用 A|B（OR）。支持限制文件类型、匹配数量与输出长度，自动排除依赖/构建/元数据/敏感文件；不传 kind 时默认按内容搜索。',
  inputSchema,
  inputExample: { pattern: 'TODO|FIXME', kind: 'content', path: 'src', limit: 20 },
  timeoutMs: 8000,
  permission: 'codebase:read',
  riskLevel: 'safe',
  execute(input: unknown, ctx: ToolContext): ToolResult {
    const started = Date.now();
    try {
      if (!ctx.repoPath) return errResult('CONFIG', '未配置 repoPath', Date.now() - started);
      const root = assertInsideRepo(ctx.repoPath, ctx.repoPath);
      const args = input as z.infer<typeof inputSchema>;
      // 别名归一化：pattern | query | keyword 三者等价；全缺则给出可行动的错误（而不是 Zod 的 "pattern: Required"）
      const pattern: string | undefined = args.pattern ?? args.query ?? args.keyword;
      if (!pattern) {
        return errResult(
          'MISSING_ARGS',
          '缺少搜索词：请提供 pattern（也可用 query / keyword）。示例: {"pattern": "TODO", "kind": "content"}',
          Date.now() - started,
        );
      }
      // kind 归一化：**默认 content**（P0-3 修复：此前默认 filename，导致"不传 kind 做内容搜索恒 0 命中且 ok:true"）；
      // 显式 filename/name/file/path/glob 才按文件名；未识别取值按 content 处理并回显（透明，便于模型自我纠正）。
      const kindRequested = args.kind === undefined ? undefined : String(args.kind).toLowerCase();
      const kind: 'filename' | 'content' =
        kindRequested !== undefined && FILENAME_KINDS.includes(kindRequested) ? 'filename' : 'content';
      const kindUnrecognized =
        kindRequested !== undefined && !CONTENT_KINDS.includes(kindRequested) && !FILENAME_KINDS.includes(kindRequested);
      // path/dir/subdir 作用域（P0-3 修复：此前参数不在 schema，被 Zod 静默丢弃）
      const pathArg = args.path ?? args.dir ?? args.subdir;
      let searchRoot = root;
      let scope = '.';
      if (pathArg !== undefined && String(pathArg).trim() !== '' && String(pathArg).trim() !== '.') {
        const resolved = resolveWorkspacePath(root, pathArg);
        if (!resolved.ok) {
          return errResult(
            resolved.escaped ? 'PATH_ESCAPE' : 'PATH_NOT_FOUND',
            `${resolved.reason}。${resolved.hint}`,
            Date.now() - started,
          );
        }
        searchRoot = resolved.abs;
        scope = resolved.rel;
      }
      const re = patternToRegex(pattern);
      const out: Match[] = [];
      walk(searchRoot, root, 1, args.maxDepth, out, { kind, pattern: re, fileTypes: args.fileTypes, limit: args.limit }, new Set());
      const truncated = out.length >= args.limit;
      const where = scope === '.' ? '整个仓库' : `目录 ${scope}`;
      // 0 命中必须给「可行动修正」（P0-3：静默 0 命中是本项目最危险的错误形态——把"调用方式不对"伪装成"真的没有"）
      const hint =
        out.length === 0
          ? `0 命中（已在${where}内按${kind === 'content' ? '内容' : '文件名'}搜索）。可行动修正：` +
            (kind === 'content' ? '① 想按文件名找 → 传 kind:"filename"；' : '① 想按内容找 → 传 kind:"content"；') +
            '② 多关键词 → 用 OR 写法 "关键词A|关键词B"；③ 限定目录 → 传 path:"src/子目录"；④ 通配符 * 与 ? 可用。'
          : undefined;
      const text = out.map((m) => (m.line ? `${m.file}:${m.line} ${m.snippet ?? ''}` : m.file)).join('\n');
      const clipped = text.length > args.maxOutputLength ? text.slice(0, args.maxOutputLength) + '\n…[truncated]' : text;
      return okResult(
        {
          matches: out,
          count: out.length,
          truncated,
          resolvedKind: kind,
          scope,
          ...(kindUnrecognized ? { kindRequested, kindNote: 'kind 取值未识别，已按 content 处理' } : {}),
          ...(hint ? { hint } : {}),
        },
        Date.now() - started,
        truncated,
      );
    } catch (e) {
      return errResult('SEARCH_ERROR', (e as Error).message, Date.now() - started);
    }
  },
};
