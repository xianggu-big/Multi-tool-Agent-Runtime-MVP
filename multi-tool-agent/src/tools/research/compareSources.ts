// src/tools/research/compareSources.ts — 基于已有证据生成结构化比较
// 区分：来源直接支持的事实 / 推断 / 未知。证据不足时明确说明，不补造结论。
import { z } from 'zod';
import type { Tool, ToolContext } from '../types.js';
import type { ToolResult } from '../../types.js';
import { okResult, errResult } from '../types.js';

const inputSchema = z.object({
  items: z
    .array(
      z.object({
        claim: z.string().min(1),
        sourceUrl: z.string().optional(),
        support: z.enum(['supported', 'inferred', 'unknown']).optional(),
      }),
    )
    .min(1)
    .describe('来自 extract_evidence 的证据条目'),
  topic: z.string().optional().describe('比较主题'),
});

const INFER_WORDS = ['可能', '推测', '推断', '似乎', '大概', '也许', 'may', 'might', 'probably', 'suggests'];

export const compareSources: Tool = {
  name: 'compare_sources',
  description: '根据已有证据生成结构化比较，区分直接支持/推断/未知；证据不足时明确说明，不补造结论。',
  inputSchema,
  timeoutMs: 4000,
  permission: 'research:read',
  riskLevel: 'safe',
  execute(input: unknown, _ctx: ToolContext): ToolResult {
    const started = Date.now();
    const args = input as z.infer<typeof inputSchema>;

    if (!args.items.length) {
      return okResult(
        { comparison: [], summary: '证据不足：没有可用条目，无法形成比较。', insufficient: true },
        Date.now() - started,
      );
    }

    const comparison = args.items.map((it) => {
      let classification: 'supported' | 'inferred' | 'unknown' = it.support ?? 'supported';
      if (classification === 'supported') {
        const low = it.claim.toLowerCase();
        if (INFER_WORDS.some((w) => low.includes(w))) classification = 'inferred';
      }
      return {
        claim: it.claim,
        sourceUrl: it.sourceUrl ?? 'unknown',
        classification,
      };
    });

    const supported = comparison.filter((c) => c.classification === 'supported').length;
    const inferred = comparison.filter((c) => c.classification === 'inferred').length;
    const unknown = comparison.filter((c) => c.classification === 'unknown').length;
    const sufficient = supported + inferred >= 1;
    const summary = sufficient
      ? `针对「${args.topic ?? '该主题'}」共比较 ${comparison.length} 条证据：直接支持 ${supported}，推断 ${inferred}，未知 ${unknown}。`
      : '证据不足：现有条目无法支撑明确结论。';

    return okResult(
      { topic: args.topic, comparison, summary, sufficient, counts: { supported, inferred, unknown } },
      Date.now() - started,
    );
  },
};
