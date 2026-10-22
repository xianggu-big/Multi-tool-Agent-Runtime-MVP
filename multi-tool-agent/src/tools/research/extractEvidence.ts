// src/tools/research/extractEvidence.ts — 从资料提取证据（保留来源，不凭空生成）
import { z } from 'zod';
import type { Tool, ToolContext } from '../types.js';
import type { ToolResult } from '../../types.js';
import { okResult, errResult } from '../types.js';

const STOP = new Set(['的', '了', '和', '与', '是', '在', 'a', 'an', 'the', 'of', 'to', 'and', 'is', 'in', 'for', 'with', 'vs', 'compare', '比较']);

const inputSchema = z.object({
  text: z.string().min(1).describe('待提取的已获取资料文本'),
  question: z.string().min(1).describe('研究问题，用于相关性判断'),
  sourceUrl: z.string().optional().describe('资料来源 URL（原样保留，绝不伪造）'),
  maxItems: z.number().int().min(1).max(30).default(10).describe('最多返回证据条数'),
});

function keywords(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/i)
    .map((w) => w.trim())
    .filter((w) => w.length > 1 && !STOP.has(w.toLowerCase()));
}

const TEXT_KEYS = new Set(['title', 'snippet', 'description', 'content', 'text', 'summary', 'quote', 'claim']);

/** 递归收集 JSON 里的可读文本（搜索/抓取结果常被模型原样塞进 text）。 */
function collectReadable(node: unknown, out: string[], depth = 0): void {
  if (depth > 6 || out.length > 400) return;
  if (typeof node === 'string') {
    const s = node.trim();
    if (s.length > 4 && !/^https?:\/\//i.test(s)) out.push(s);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectReadable(item, out, depth + 1);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === 'string') {
        if (TEXT_KEYS.has(key)) collectReadable(value, out, depth + 1);
      } else {
        collectReadable(value, out, depth + 1);
      }
    }
  }
}

/**
 * 把「结构化工具结果」转成可读文本。
 * 模型经常把 web_search / fetch_page 的 JSON 原样传给 extract_evidence；
 * 直接按句子切会把 JSON 切成碎片，这里先抽出 title/snippet 等字段。
 */
export function toReadableText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return raw;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const out: string[] = [];
    collectReadable(parsed, out);
    return out.length > 0 ? out.join('\n') : raw;
  } catch {
    return raw;
  }
}

export const extractEvidence: Tool = {
  name: 'extract_evidence',
  description: '从已获取资料中提取与研究问题相关的证据，保留来源 URL 与原文定位；不得凭空生成来源或引用。',
  inputSchema,
  timeoutMs: 4000,
  permission: 'research:read',
  riskLevel: 'safe',
  execute(input: unknown, _ctx: ToolContext): ToolResult {
    const started = Date.now();
    const args = input as z.infer<typeof inputSchema>;
    const kws = keywords(args.question);
    const sourceText = toReadableText(args.text);
    const sentences = sourceText
      .split(/(?<=[。.!?!\n])\s*|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 4);
    const scored: { claim: string; score: number }[] = [];
    for (const s of sentences) {
      const low = s.toLowerCase();
      let score = 0;
      for (const k of kws) if (low.includes(k.toLowerCase())) score++;
      if (score > 0) scored.push({ claim: s.slice(0, 400), score });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, args.maxItems);
    return okResult(
      {
        evidence: top.map((t) => ({ claim: t.claim, quote: t.claim, sourceUrl: args.sourceUrl ?? 'unknown' })),
        count: top.length,
        keywordCount: kws.length,
      },
      Date.now() - started,
    );
  },
};
