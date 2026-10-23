// src/tools/misc/submitResult.ts — 结构化结论提交（终结性工具）
// 设计要点：
//  1) **终结性（terminal）**：执行成功后 Runtime 立即以它的数据结束任务，不再多跑一轮模型；
//  2) **结构化**：schema 由 Zod 强制，模型必须给出一句话结论；清单/发现/改派建议都是可选的；
//  3) **越界上报通道**：当任务超出杂项 Agent 能力（比如要求改代码/联网调研）时，
//     模型被要求直接调用本工具并带上 escalateTo，从而「一步结束 + 明确改派」而不是硬撑。
//  注意：本工具只写内存中的结果（不落盘、不产生副作用），因此 riskLevel=safe。

import { z } from 'zod';
import type { Tool, ToolContext } from '../types.js';
import type { ToolResult } from '../../types.js';
import { okResult, errResult } from '../types.js';

const itemObject = z.object({
  label: z.string().min(1).max(200).describe('条目名，例如「文件总数」'),
  value: z.union([z.string().max(500), z.number()]).describe('条目值'),
  detail: z.string().max(1000).optional().describe('补充说明（可选）'),
});

const findingObject = z.object({
  path: z.string().max(500).optional().describe('相关路径（没有明确路径可省略）'),
  note: z.string().max(1000).describe('说明'),
});

const inputSchema = z.object({
  summary: z.string().min(1).max(2000).describe('一句话结论（必填）'),
  items: z
    // 真实模型（DeepSeek，2026-10-23 实测）会先把条目写成字符串数组；
    // 直接 INVALID_ARGS 会白烧 1~2 轮 tool call，这里接受简写并在 execute 里归一化。
    .array(z.union([itemObject, z.string().min(1).max(700)]))
    .max(50)
    .optional()
    .describe('结构化清单（可选）；也可用字符串简写，如 "文件总数：5"'),
  findings: z
    .array(z.union([findingObject, z.string().min(1).max(1000)]))
    .max(50)
    .optional()
    .describe('逐条发现（可选）；字符串会转成 { note }，没有路径就不编造路径'),
  escalateTo: z
    .enum(['codebase', 'research', 'human'])
    .optional()
    .describe('任务超出杂项 Agent 能力时，建议改派给谁（可选）'),
  escalateReason: z.string().max(500).optional().describe('改派原因（可选）'),
  artifacts: z
    .array(
      z.object({
        label: z.string().max(200).describe('产物名，例如「格式化后的 JSON」'),
        content: z.string().max(20000).describe('文本内容（不落盘，仅出现在回答里）'),
      }),
    )
    .max(5)
    .optional()
    .describe('不落盘的文本产物（可选）'),
});

export type SubmitResultInput = z.infer<typeof inputSchema>;

/** 字符串简写 → 结构化条目：按第一个全角/半角冒号拆 label/value；拆不出就整句当 label。 */
function normalizeItem(entry: SubmitResultInput['items'] extends (infer I)[] | undefined ? I : never) {
  if (typeof entry !== 'string') return entry;
  const text = entry.trim();
  const idx = text.search(/[：:]/);
  if (idx > 0) {
    const label = text.slice(0, idx).trim().slice(0, 200);
    const value = text.slice(idx + 1).trim().slice(0, 500);
    if (label) return { label, value };
  }
  return { label: text.slice(0, 200), value: '' };
}

function normalizeFinding(entry: NonNullable<SubmitResultInput['findings']>[number]) {
  return typeof entry === 'string' ? { note: entry.slice(0, 1000) } : entry;
}

export const submitResult: Tool = {
  name: 'submit_result',
  description:
    '提交本次杂项任务的最终结论（终结性工具：调用成功后任务立即结束）。必须用它给出结构化结论；' +
    '如果任务超出能力范围（需要改代码/联网/跑命令），不要硬撑，直接调用本工具并填写 escalateTo。',
  inputSchema,
  timeoutMs: 2000,
  permission: 'misc:report',
  riskLevel: 'safe',
  terminal: true,
  execute(input: unknown, _ctx: ToolContext): ToolResult {
    const started = Date.now();
    const parsed = input as SubmitResultInput;
    // 语义校验（Zod 之外的业务规则）：改派建议必须带理由，否则调用方无法判断该不该转
    if (parsed.escalateTo && !parsed.escalateReason) {
      return errResult(
        'MISSING_ESCALATE_REASON',
        '填写了 escalateTo 就必须同时给出 escalateReason（说明为什么超出能力范围），否则无法判断该不该改派',
        Date.now() - started,
      );
    }
    return okResult(
      {
        submitted: true,
        ...parsed,
        ...(parsed.items ? { items: parsed.items.map(normalizeItem) } : {}),
        ...(parsed.findings ? { findings: parsed.findings.map(normalizeFinding) } : {}),
      },
      Date.now() - started,
    );
  },
};
