// src/tools/orchestrator/delegateSubtasks.ts — 主 Agent 的扇出工具
// 职责（薄适配器）：校验委派请求 → 交给 Runtime 注入的 spawnSubAgent → 把结果裁剪成「主 Agent 可消费的简报」。
// 不在工具里做并发/取消：那是 Runtime 的职责（SubAgentPool），工具只负责契约与上下文纪律。
//
// 三道结构层守卫（不依赖提示词自觉）：
//   ① 宽度：单次派发数 ≤ config.subagent.maxWidth；
//   ② 深度：只有 depth=0 的主 Agent 能派发（子 Agent 的 ctx 不注入 spawnSubAgent，压根调不到）；
//   ③ 规格：specId 必须存在，且在 allowedSpecs 白名单内。

import { z } from 'zod';
import type { Tool, ToolContext } from '../types.js';
import type { SubtaskOutcome, ToolResult } from '../../types.js';
import { okResult, errResult } from '../types.js';
import { getSpec, isWriteSpecId, listSpecIds } from '../../agents/specs.js';
import { SubAgentPool } from '../../runtime/SubAgentPool.js';

/** 取消/异常时也要给出结果对象——保证主 Agent 一定能拿到「每个子任务的去向」 */
function stubOutcome(req: { specId: string; objective: string }, status: 'cancelled' | 'failed', reason: string, errorCode: string) {
  const spec = getSpec(req.specId);
  return {
    subtaskId: `st_stub_${Math.random().toString(36).slice(2, 8)}`,
    specId: req.specId,
    specTitle: spec?.title ?? req.specId,
    objective: req.objective,
    status,
    failureReason: reason,
    errorCode,
    steps: 0,
    modelCalls: 0,
    toolCalls: 0,
    durationMs: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, isEstimate: true },
  } as const;
}

const subtaskSchema = z.object({
  specId: z.string().describe('子 Agent 契约 id（见可用清单）'),
  objective: z.string().min(1).max(500).describe('一句话目标（委派契约四要素之一，必须具体）'),
  boundary: z.string().max(500).optional().describe('本次额外边界（只能收紧、不能放宽契约里的硬边界）'),
  inputs: z.record(z.string()).optional().describe('输入引用，例如 { dir: "src/tools" } 或 { topic: "esbuild" }'),
  expectedOutput: z.string().max(300).optional().describe('期望输出要点（帮助子 Agent 对齐格式）'),
});

const inputSchema = z.object({
  subtasks: z.array(subtaskSchema).min(1).max(8).describe('要并行派发的子任务列表（彼此必须相互独立、无依赖）'),
});

/** 单个子任务结果的字符上限（上下文纪律：主 Agent 只看到简报，不看到全文） */
function brief(o: SubtaskOutcome, maxChars: number): SubtaskOutcome {
  const truncatedFields: string[] = [];
  const source = o.report;
  const report = source ? { ...source } : undefined;

  if (report && source) {
    const clip = (s: string, label: string): string => {
      if (s.length <= maxChars) return s;
      truncatedFields.push(label);
      return s.slice(0, maxChars) + `…[已截断，共 ${s.length} 字符]`;
    };
    report.summary = clip(report.summary, 'summary');
    if (report.findings && report.findings.length > 20) {
      report.findings = report.findings.slice(0, 20);
      truncatedFields.push(`findings(仅前 20/${source.findings!.length} 条)`);
    }
    if (report.items && report.items.length > 20) {
      report.items = report.items.slice(0, 20);
      truncatedFields.push('items(仅前 20 条)');
    }
    // 产物全文不回传（避免把主 Agent 上下文灌满）：只告诉它有哪些产物
    if (report.artifacts && report.artifacts.length) {
      report.artifacts = report.artifacts.map((a) => ({ label: a.label, content: '[产物正文未回传，见子任务事件流]' }));
      truncatedFields.push('artifacts(正文未回传)');
    }
  }

  return {
    subtaskId: o.subtaskId,
    specId: o.specId,
    specTitle: o.specTitle,
    objective: o.objective,
    status: o.status,
    report,
    failureReason: o.failureReason,
    errorCode: o.errorCode,
    triggeredLimit: o.triggeredLimit,
    steps: o.steps,
    modelCalls: o.modelCalls,
    toolCalls: o.toolCalls,
    durationMs: o.durationMs,
    usage: o.usage,
    ...(truncatedFields.length ? { truncatedFields: [...(o.truncatedFields ?? []), ...truncatedFields] } : {}),
  };
}

/** 派发批次的总超时：到点主动 abort 该批子任务（Registry 侧另有 +10s 兜底） */
export const DELEGATE_TIMEOUT_MS = 240000;

export const delegateSubtasks: Tool = {
  name: 'delegate_subtasks',
  description:
    '把一批**相互独立**的子任务并行派发给子 Agent，等全部结束后一次性返回各自的结构化简报。' +
    '每个子任务必须写清：specId（用哪个子 Agent）、objective（一句话目标）、inputs（输入引用，如具体子目录）、' +
    'boundary（本次额外边界）、expectedOutput（期望输出）。子任务之间不得有依赖；有依赖的活请串行分多次调用。' +
    '返回结果里每个子任务都带 status/report/evidence：子任务的结论属于「待采纳」，你需要结合它实际检查的范围判断后再采信。',
  inputSchema,
  inputExample: {
    subtasks: [
      { specId: 'dir-inventory', objective: '清点 src 目录的文件数与扩展名分布', inputs: { dir: 'src' } },
    ],
  },
  // Registry 的 withTimeout 只会 race 一个 reject、**不会取消**底层子任务，所以这里自己管超时：
  // 到点 abort 该批（子任务真的停下），Registry 的兜底超时再留 10s 余量。
  timeoutMs: DELEGATE_TIMEOUT_MS + 10000,
  permission: 'orchestrator:delegate',
  riskLevel: 'low',
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const started = Date.now();
    const args = input as z.infer<typeof inputSchema>;
    const cfg = ctx.config.subagent;

    // 守卫 ①：能力是否注入（只有主 Agent 有）
    if (!ctx.spawnSubAgent) {
      return errResult(
        'DELEGATION_NOT_AVAILABLE',
        '当前上下文没有派发子 Agent 的能力（只有编排任务的主 Agent 可以派发；子 Agent 不能再派子 Agent）',
        Date.now() - started,
      );
    }
    // 守卫 ②：宽度上限（结构层强制，不靠提示词）
    const width = Math.min(cfg.maxWidth, 8);
    if (args.subtasks.length > width) {
      return errResult(
        'WIDTH_LIMIT',
        `单次最多派发 ${width} 个子任务（收到 ${args.subtasks.length}）。请合并同类项或分批派发。`,
        Date.now() - started,
      );
    }
    // 守卫 ③：规格必须存在且在允许清单内
    const unknown = args.subtasks.map((t) => t.specId).filter((id) => !getSpec(id));
    if (unknown.length) {
      return errResult(
        'UNKNOWN_SPEC',
        `未知的子 Agent 契约: ${[...new Set(unknown)].join(', ')}。可用: ${(ctx.allowedSpecs ?? listSpecIds()).join(', ')}`,
        Date.now() - started,
      );
    }
    if (ctx.allowedSpecs && ctx.allowedSpecs.length) {
      const forbidden = args.subtasks.map((t) => t.specId).filter((id) => !ctx.allowedSpecs!.includes(id));
      if (forbidden.length) {
        return errResult('SPEC_NOT_ALLOWED', `本次任务不允许使用: ${[...new Set(forbidden)].join(', ')}`, Date.now() - started);
      }
    }
    // 守卫 ④（M1'）：写 spec 需本 run 显式授权（界面「允许修改文件」开关 / API 传 allowWriteSpecs=true）
    // fail-closed：未注入或非 true 一律拒绝——「不勾选 = 只读」由此保证（软提示之外的硬边界）
    const writeSpecs = [...new Set(args.subtasks.map((t) => t.specId).filter((id) => isWriteSpecId(id)))];
    if (writeSpecs.length && ctx.writeSpecsAllowed !== true) {
      return errResult(
        'WRITE_NOT_ALLOWED',
        `本次任务未授权写能力（涉及: ${writeSpecs.join(', ')}）。` +
          '请在界面勾选「允许修改文件（写能力）」后重试（或请求里传 orchestration.allowWriteSpecs=true）；' +
          '改动会先进入 Docker 沙箱验证，并在落盘前弹出审批卡等你确认。',
        Date.now() - started,
      );
    }
    // 去重提示：同一 spec 同一 objective 重复派发属于典型浪费
    const seen = new Set<string>();
    const dup: string[] = [];
    for (const t of args.subtasks) {
      const k = `${t.specId}::${t.objective}`;
      if (seen.has(k)) dup.push(t.objective);
      seen.add(k);
    }

    // 有界并发池：并发封顶 + 级联取消 + 单任务失败不打断其他任务
    // 批次级取消：到 DELEGATE_TIMEOUT_MS 主动 abort，否则 Registry 超时后子任务仍在后台跑
    // （2026-10-20 实测：工具超时后子任务又跑了 11 分钟、连弹两张审批卡）。
    const batchAc = new AbortController();
    const batchTimer = setTimeout(() => batchAc.abort(), DELEGATE_TIMEOUT_MS);
    const pool = new SubAgentPool(cfg.maxConcurrency);
    let outcomes;
    try {
      outcomes = await pool.map(
        args.subtasks,
        (t) =>
          ctx.spawnSubAgent!(
            {
              specId: t.specId,
              objective: t.objective,
              boundary: t.boundary,
              inputs: t.inputs,
              expectedOutput: t.expectedOutput,
            },
            { signal: batchAc.signal },
          ),
        {
          concurrency: cfg.maxConcurrency,
          signal: batchAc.signal,
          abortedResult: (item) =>
            stubOutcome(
              item as { specId: string; objective: string },
              'cancelled',
              `派发超时（>${Math.round(DELEGATE_TIMEOUT_MS / 1000)}s）或父任务取消，该子任务已中止`,
              'CANCELLED',
            ),
          errorResult: (item, _i, err) =>
            stubOutcome(item as { specId: string; objective: string }, 'failed', `子任务执行异常: ${err.message}`, 'EXECUTION_ERROR'),
        },
      );
    } finally {
      clearTimeout(batchTimer);
    }

    // 交回 Runtime 记录（按派发顺序）——汇总统计与事件顺序都以这个批次为准
    ctx.onSubtasksDelegated?.(outcomes);

    const ok = outcomes.filter((o) => o.status === 'ok').length;
    const failed = outcomes.filter((o) => o.status === 'failed').length;
    const cancelled = outcomes.filter((o) => o.status === 'cancelled').length;
    const limited = outcomes.filter((o) => o.status === 'limit_reached').length;

    const payload = {
      requested: args.subtasks.length,
      ok,
      failed,
      cancelled,
      limitReached: limited,
      // 部分失败不隐瞒：显式列出失败项与原因，让主 Agent 决定重跑/降级/标注缺口
      subtasks: outcomes.map((o) => brief(o, cfg.resultChars)),
      ...(dup.length ? { duplicateObjectives: dup } : {}),
      note:
        failed || cancelled || limited
          ? `${ok}/${args.subtasks.length} 成功：失败 ${failed}、取消 ${cancelled}、被限流截断 ${limited}——请在汇总里如实标注缺口，不要假装全部完成`
          : '全部子任务成功完成',
    };
    return okResult(payload, Date.now() - started);
  },
};
