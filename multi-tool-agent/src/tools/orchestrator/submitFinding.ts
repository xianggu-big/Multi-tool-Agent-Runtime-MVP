// src/tools/orchestrator/submitFinding.ts — 子 Agent 的结构化上报（终结性工具）
// 与 misc 的 submit_result 的区别：
//   - 面向「主 Agent / 编排者」而不是最终用户；
//   - 额外要求 evidence（证据指针）与 confidence（自评置信度）：主 Agent 要据此决定采信还是复核；
//   - 权限为 agent:report（子 Agent 契约里显式声明）。
// 仍然只写内存结果、无副作用，riskLevel=safe。

import { z } from 'zod';
import type { Tool, ToolContext } from '../types.js';
import type { ToolResult } from '../../types.js';
import { okResult, errResult } from '../types.js';
import { subtaskReportSchema } from '../../agents/specs.js';
import { normalizeItems, normalizeFindings } from '../shared/reportNormalize.js';

export const submitFinding: Tool = {
  name: 'submit_finding',
  description:
    '提交本次子任务的结论（终结性工具：调用成功后本子任务立即结束）。必须用它上报：summary 一句话结论；' +
    'findings 逐条发现（带路径）；evidence 给出证据指针（文件:行号 / URL）——没有证据的断言会被主 Agent 打回；' +
    'confidence 自评置信度，拿不准就填 low 让主 Agent 复核；超出能力范围时填 escalateTo + escalateReason。',
  inputSchema: subtaskReportSchema,
  inputExample: {
    summary: 'src 目录共 2 个文件，未发现 TODO',
    items: [{ label: '文件数', value: 2 }],
    findings: [{ path: 'src/calc.js', note: '无可疑硬编码' }],
    evidence: ['dir_stats:src'],
    confidence: 'high',
  },
  timeoutMs: 2000,
  permission: 'agent:report',
  riskLevel: 'safe',
  terminal: true,
  execute(input: unknown, _ctx: ToolContext): ToolResult {
    const started = Date.now();
    const parsed = input as z.infer<typeof subtaskReportSchema>;

    // 业务规则（Zod 之外的语义校验）
    if (parsed.escalateTo && !parsed.escalateReason) {
      return errResult(
        'MISSING_ESCALATE_REASON',
        '填写了 escalateTo 就必须同时给出 escalateReason，否则主 Agent 无法判断该不该改派',
        Date.now() - started,
      );
    }
    if (parsed.confidence === 'high' && (!parsed.evidence || parsed.evidence.length === 0) && (parsed.findings?.length ?? 0) > 0) {
      return errResult(
        'EVIDENCE_REQUIRED',
        '给出了 findings 并自评 high 置信度时，必须至少提供一条 evidence（文件:行号 / URL）；否则请下调 confidence',
        Date.now() - started,
      );
    }
    // 宽容归一化：模型把数组元素写成字符串很常见（"src/a.ts:1 无异常" / "文件数: 3"），
    // 这里统一成对象形状，避免"形状不对"把有效结论打回（实测因此产生过 9 次无效调用）。
    const items = normalizeItems((parsed as any).items);
    const findings = normalizeFindings((parsed as any).findings);
    return okResult(
      {
        submitted: true,
        ...parsed,
        ...(items ? { items } : { items: undefined }),
        ...(findings ? { findings } : { findings: undefined }),
      },
      Date.now() - started,
    );
  },
};
