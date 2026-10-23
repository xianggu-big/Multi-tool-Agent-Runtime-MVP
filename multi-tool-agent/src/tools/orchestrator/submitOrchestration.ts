// src/tools/orchestrator/submitOrchestration.ts — 主 Agent 的汇总上报（终结性工具）
// 与子 Agent 的 submit_finding 对应：这是编排任务的终点。
// 结构上强制要求「来源标注」与「冲突显式化」——这是防止"把多个子结论揉成一段话"的关键：
//   - findings[].from 必须写明来自哪个子任务；
//   - 子任务结论冲突时必须列在 conflicts 里并给出处理方式，禁止静默取一个；
//   - 未解决/证据不足的部分必须写进 unresolved，不许假装完成。

import { z } from 'zod';
import type { Tool, ToolContext } from '../types.js';
import type { ToolResult } from '../../types.js';
import { okResult, errResult } from '../types.js';
import { normalizeOrchFindings } from '../shared/reportNormalize.js';

const inputSchema = z.object({
  summary: z.string().min(1).max(4000).describe('总体结论（必填；必须体现子任务的执行情况）'),
  findings: z
    .array(
      z.union([
        z.object({
          from: z.string().min(1).max(200).describe('来源子任务 id 或 specId（必须标注，不许无源断言）'),
          note: z.string().min(1).max(1000),
          path: z.string().max(500).optional(),
        }),
        // 字符串形式会被归一化为 from='（未标注来源）'，并由 Runtime 计入未解决项提醒
        z.string().max(1000),
      ]),
    )
    .max(80)
    .optional()
    .describe('来自子任务的发现；推荐对象形式 {from,note}（from 必填），字符串形式会丢失来源标注'),
  conflicts: z
    .array(
      z.union([
        z.object({
          between: z.array(z.string()).min(2).max(6).describe('产生冲突的子任务 id 列表'),
          topic: z.string().max(300),
          resolution: z.string().max(1000).describe('你如何处理这个冲突（采信谁 / 都保留 / 需人工）'),
        }),
        // 字符串简写：保留原文，但明确标成「未结构化、需人工复核」，不伪造 between。
        z.string().min(1).max(1000),
      ]),
    )
    .max(10)
    .optional()
    .describe('子任务结论不一致时必须显式列出，禁止静默取一个'),
  unresolved: z.array(z.string().max(500)).max(20).optional().describe('未解决 / 证据不足的部分（诚实标注）'),
  escalateTo: z.enum(['codebase', 'research', 'misc', 'human']).optional(),
  escalateReason: z.string().max(500).optional(),
});

export const submitOrchestration: Tool = {
  name: 'submit_orchestration',
  description:
    '提交编排任务的最终汇总（终结性工具：调用成功后任务立即结束）。' +
    'findings 必须标注来源（from = 子任务 id 或 specId）；子任务结论冲突时写进 conflicts 并说明处理方式；' +
    '没解决/证据不足的写进 unresolved——**不要在汇总里假装所有子任务都成功了**。' +
    '注意：即便所有子任务都失败，也必须调用本工具给出结论（说明失败情况与缺口）。',
  inputSchema,
  inputExample: {
    summary: '两个子任务均完成：src 已清点并审计，未发现 TODO',
    findings: [{ from: 'dir-inventory', note: 'src 共 2 个文件' }],
    unresolved: ['未做跨目录交叉验证'],
  },
  timeoutMs: 2000,
  permission: 'orchestrator:report',
  riskLevel: 'safe',
  terminal: true,
  execute(input: unknown, ctx: ToolContext): ToolResult {
    const started = Date.now();
    const parsed = input as z.infer<typeof inputSchema>;

    if (parsed.escalateTo && !parsed.escalateReason) {
      return errResult('MISSING_ESCALATE_REASON', '填写了 escalateTo 就必须给出 escalateReason', Date.now() - started);
    }
    // 业务规则：有 findings 却没标注来源的（from 为空串）——schema 已拦；
    // 这里补一条：声明为 human 升级时，必须同时说明未解决项（否则等于甩锅）
    if (parsed.escalateTo === 'human' && (!parsed.unresolved || parsed.unresolved.length === 0)) {
      return errResult(
        'UNRESOLVED_REQUIRED',
        '升级给人工时，必须在 unresolved 里写清「哪些部分没解决/为什么需要人工」，否则人工无法接手',
        Date.now() - started,
      );
    }
    const { findings, missingFromCount } = normalizeOrchFindings((parsed as any).findings);
    const conflicts = parsed.conflicts?.map((c) =>
      typeof c === 'string'
        ? {
            between: ['（未标注）'],
            topic: c.slice(0, 300),
            resolution: '（模型以字符串提交，未区分处理方式；需人工复核原文）',
          }
        : c,
    );
    return okResult(
      {
        submitted: true,
        ...parsed,
        ...(findings ? { findings } : { findings: undefined }),
        ...(conflicts ? { conflicts } : {}),
        ...(missingFromCount ? { missingFromCount } : {}),
      },
      Date.now() - started,
    );
  },
};
