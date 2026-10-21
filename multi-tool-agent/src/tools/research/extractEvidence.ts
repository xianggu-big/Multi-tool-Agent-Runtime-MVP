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
    const sentences = args.text
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
