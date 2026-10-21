// src/report/runReport.ts — 单个 run 的「流程图 + 分层量化 + 阶段归因」报告（纯函数、零 I/O、可单测）
//
// 设计要点（来自 2026-10-15 记账 run 复核与 PARALLEL_AB 的教训）：
//   - **不信任 finalAnswer**：所有数字由 events / runs 行 / resultJson 机械统计得出，模型文字只作附录；
//   - **分层上报**：runs 行的 counters 只算主 Agent（子任务的调用不计入），子任务消耗来自
//     resultJson.subtasks 的合计；两者相加才是"总计"——这正是"干净的 3 步完成"谎言的来源；
//   - **缺口显式化**：gaps / unresolved / partial 原样呈现，不做"看起来成功"的渲染；
//   - **确定性**：时间戳由调用方传入（generatedAt），同样输入必得同样输出（便于漂移检测/回归测试）。

import type { OrchestrationReport, SubtaskOutcome, TokenUsage, TraceEvent } from '../types.js';
import { unpackResultJson } from '../store/resultJson.js';
import { summarizeSubtasks, summarizeSubtaskUsage } from '../runtime/AgentRuntime.js';

/** 数据库行 / store.getRun() 的宽松入参（isMock 在 SQLite 里是 0/1） */
export interface RunRecordLike {
  runId: string;
  runType: string;
  status: string;
  goal: string;
  createdAt: string;
  updatedAt?: string | null;
  finalAnswer?: string | null;
  failureReason?: string | null;
  errorCode?: string | null;
  triggeredLimit?: string | null;
  steps: number;
  modelCalls: number;
  toolCalls: number;
  totalDurationMs: number;
  usageJson?: string | null;
  isMock?: number | boolean | null;
  resultJson?: string | null;
}

/** 归一化：CLI（SQLite 行）与 HTTP 接口（store.getRun()）共用同一入口 */
export function toReportRun(rec: RunRecordLike): RunReportRun {
  return {
    runId: rec.runId,
    runType: rec.runType,
    status: rec.status,
    goal: rec.goal,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt ?? null,
    finalAnswer: rec.finalAnswer ?? null,
    failureReason: rec.failureReason ?? null,
    errorCode: rec.errorCode ?? null,
    triggeredLimit: rec.triggeredLimit ?? null,
    steps: rec.steps,
    modelCalls: rec.modelCalls,
    toolCalls: rec.toolCalls,
    totalDurationMs: rec.totalDurationMs,
    usageJson: rec.usageJson ?? null,
    isMock: rec.isMock === true ? 1 : rec.isMock === false || rec.isMock == null ? 0 : Number(rec.isMock) === 1 ? 1 : 0,
    resultJson: rec.resultJson ?? null,
  };
}
/** runs 行（本报告只依赖这些列；与 SqliteStore 的列名一致） */
export interface RunReportRun {
  runId: string;
  runType: string;
  status: string;
  goal: string;
  createdAt: string;
  updatedAt?: string | null;
  finalAnswer?: string | null;
  failureReason?: string | null;
  errorCode?: string | null;
  triggeredLimit?: string | null;
  steps: number;
  modelCalls: number;
  toolCalls: number;
  totalDurationMs: number;
  usageJson?: string | null;
  isMock: number;
  resultJson?: string | null;
}

export type StageVerdict = 'ok' | 'gap' | 'fail' | 'na';

/** 六阶段错误归因：每个阶段给「结论 + 计数 + 证据 seq」，避免"整跑一句成败" */
export interface StageFinding {
  id: string;
  title: string;
  verdict: StageVerdict;
  summary: string;
  /** 支撑该结论的事件 seq（可回溯到 events 表） */
  evidence: number[];
  metrics: Array<[string, number | string]>;
}

export interface RunReportMeta {
  runId: string;
  runType: string;
  status: string;
  isMock: boolean;
  generatedAt: string;
  steps: number;
  modelCalls: number;
  toolCalls: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number;
  /** 子任务合计（主 Agent 之外的那部分） */
  subtask: { total: number; ok: number; failed: number; cancelled: number; limited: number; toolCalls: number; totalTokens: number; costUsd: number };
  /** 编排缺口（无编排时为 null） */
  gaps: OrchestrationReport['gaps'] | null;
  stages: Array<{ id: string; verdict: StageVerdict }>;
  /** 一行结论（列表页/INDEX 用） */
  headline: string;
}

export interface RunReportResult {
  markdown: string;
  meta: RunReportMeta;
}

export const REPORT_STAGES: ReadonlyArray<{ id: string; title: string }> = [
  { id: 'intake', title: '① 入参与分流' },
  { id: 'model', title: '② 模型调用' },
  { id: 'tool', title: '③ 工具调用' },
  { id: 'subtask', title: '④ 子任务与编排' },
  { id: 'approval', title: '⑤ 审批 / 落盘 / 验证' },
  { id: 'delivery', title: '⑥ 收尾与交付' },
];

/** meta 以单行注释落在报告首行，供 INDEX 重建时解析（勿手改） */
export const META_PREFIX = '<!-- run-report-meta ';

// ---------------------------------------------------------------------------
// 小工具（严格类型下安全读取 unknown 数据）
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function num(v: unknown, dflt = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
/** 工具名可能在顶层，也可能只在 inputs / outputs 里（started 与 completed 的形态不一致） */
function toolNameOf(d: Record<string, unknown>): string {
  return str(d.name) || str(asRecord(d.inputs).name) || str(asRecord(d.outputs).name);
}/** toolCallId 可能在顶层，也可能在 inputs / outputs 里（实测两种形态都存在） */
function toolCallIdOf(d: Record<string, unknown>): string {
  return str(d.toolCallId) || str(asRecord(d.inputs).toolCallId) || str(asRecord(d.outputs).toolCallId);
}
function safeJson(raw: string | null | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
function parseUsage(raw: string | null | undefined): TokenUsage {
  const d = asRecord(safeJson(raw));
  return {
    promptTokens: num(d.promptTokens),
    completionTokens: num(d.completionTokens),
    totalTokens: num(d.totalTokens),
    costUsd: num(d.costUsd),
    isEstimate: d.isEstimate === true,
  };
}
/** Mermaid/表格标签清洗：引号会破坏 Mermaid 语法，换行会破坏表格 */
function label(s: string, max = 60): string {
  const flat = s.replace(/"/g, "'").replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
function fmtUsd(usd: number): string {
  return `$${usd.toFixed(5)}`;
}
function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

// ---------------------------------------------------------------------------
// 事件聚合：步骤 / 工具 / 错误 / 子任务时间线
// ---------------------------------------------------------------------------

interface StepAgg {
  step: number;
  modelCalls: number;
  tools: number;
  toolFails: number;
  tokens: number;
  costUsd: number;
  durationMs: number;
  toolNames: string[];
}

interface ErrRec {
  seq: number;
  source: 'tool' | 'model' | 'runtime' | 'run';
  code: string;
  name: string;
  message: string;
}

interface ToolAgg {
  name: string;
  calls: number;
  fails: number;
  durationMs: number;
  /** 是否来自子任务（按 span 树判定，不看名字） */
  subagent: boolean;
}

export interface RunEventAggregate {
  steps: StepAgg[];
  tools: ToolAgg[];
  errors: ErrRec[];
  /** 每个 step 的事件 seq 区间（[最小, 最大]），用于流程图/证据回溯 */
  eventsByType: Record<string, number>;
}


export function aggregateRunEvents(events: TraceEvent[]): RunEventAggregate {
  const steps = new Map<number, StepAgg>();
  const tools = new Map<string, ToolAgg>();
  const errors: ErrRec[] = [];
  const eventsByType: Record<string, number> = {};

  // 判定「这条事件是否属于子任务」：最可靠的依据是 span 树的父子关系——
  // 子任务内的 span 其 parentId 指向 kind='subtask' 的 span。
  // 不能只看工具名：tool_started 带 `spec/fetch_page` 前缀，而 tool_completed 的 name 是**裸名**
  // （实测 run_mv94f94p 的 fetch_page 因此被误记成主 Agent）。
  // 关键：**tool_completed / tool_failed / model_completed 事件不自带 parentId**（只有 started/request 侧有），
  // 所以不能只看"当前这条事件"，必须先按 spanId 建索引（kind 与 parentId），再回溯判定归属。
  const spanKind = new Map<string, string>();
  const spanParent = new Map<string, string>();
  const prefixedNameByCall = new Map<string, string>();
  for (const e of events) {
    const d = asRecord(e.data);
    const sid = str(d.spanId);
    if (sid) {
      const kind = str(d.kind);
      if (kind) spanKind.set(sid, kind);
      const parent = str(d.parentId);
      if (parent) spanParent.set(sid, parent);
    }
    const tc = toolCallIdOf(d);
    const nm = str(d.name);
    if (tc && nm.includes('/')) prefixedNameByCall.set(tc, nm);
  }
  /** 该 span 是否处在某个子任务 span（kind='subtask'）之下 */
  const isUnderSubtask = (d: Record<string, unknown>): boolean => {
    const parent = str(d.parentId);
    if (parent && spanKind.get(parent) === 'subtask') return true;
    const sid = str(d.spanId);
    const viaIndex = sid ? spanParent.get(sid) : undefined;
    return !!viaIndex && spanKind.get(viaIndex) === 'subtask';
  };
  const isSubtaskSpan = (d: Record<string, unknown>): boolean => {
    if (isUnderSubtask(d)) return true;
    // 兜底：事件里直接带 specId，或名字带 `spec/tool` 前缀（tool_started 的形态）
    return !!str(d.specId) || str(d.name).includes('/');
  };

  const stepOf = (d: Record<string, unknown>): number => {
    const s = num(d.step, 0);
    return s > 0 ? s : 0;
  };
  const ensureStep = (n: number): StepAgg => {
    let s = steps.get(n);
    if (!s) {
      s = { step: n, modelCalls: 0, tools: 0, toolFails: 0, tokens: 0, costUsd: 0, durationMs: 0, toolNames: [] };
      steps.set(n, s);
    }
    return s;
  };

  for (const e of events) {
    eventsByType[e.type] = (eventsByType[e.type] ?? 0) + 1;
    const d = asRecord(e.data);
    const sub = isSubtaskSpan(d);
    switch (e.type) {
      case 'model_completed': {
        const u = parseUsage(JSON.stringify(asRecord(d.usage)));
        // 子任务的模型调用不占主 Agent 的 step 表（否则流程图会出现凭空的 step 4/5/6）
        if (!sub) {
          const st = ensureStep(stepOf(d));
          st.modelCalls += 1;
          st.durationMs += num(d.durationMs);
          st.tokens += u.totalTokens;
          st.costUsd += u.costUsd;
        }
        break;
      }
      case 'model_request': {
        if (!sub) ensureStep(stepOf(d));
        break;
      }
      case 'tool_completed':
      case 'tool_failed': {
        const name = toolNameOf(d) || 'unknown';
        const failed = e.type === 'tool_failed';
        if (!sub) {
          const st = ensureStep(stepOf(d));
          st.tools += 1;
          if (failed) st.toolFails += 1;
          st.durationMs += num(d.durationMs);
          if (!st.toolNames.includes(name)) st.toolNames.push(name);
        }
        // 聚合键：优先用 started 侧的前缀名（`doc-research/fetch_page`），裸名回落到本名（避免同一工具两行）
        const specId = str(d.specId);
        const tc = toolCallIdOf(d);
        const key = name.includes('/') ? name : prefixedNameByCall.get(tc) ?? (specId ? `${specId}/${name}` : name);
        let agg = tools.get(key);
        if (!agg) {
          agg = { name: key, calls: 0, fails: 0, durationMs: 0, subagent: sub };
          tools.set(key, agg);
        }
        agg.calls += 1;
        agg.subagent = agg.subagent || sub;
        if (failed) agg.fails += 1;
        agg.durationMs += num(d.durationMs);
        if (failed) {
          const err = asRecord(d.error);
          errors.push({
            seq: e.seq,
            source: 'tool',
            code: str(err.code) || str(d.errorCode) || 'TOOL_FAILED',
            name,
            message: str(err.message) || str(d.failureReason),
          });
        }
        break;
      }
      case 'runtime_error': {
        errors.push({
          seq: e.seq,
          source: 'runtime',
          code: str(d.code) || 'RUNTIME_ERROR',
          name: str(d.location) || str(d.phase),
          message: str(d.message),
        });
        break;
      }
      case 'subtask_failed': {
        const err = asRecord(d.error);
        errors.push({
          seq: e.seq,
          source: 'runtime',
          code: str(d.errorCode) || str(err.code) || 'SUBTASK_FAILED',
          name: str(d.specId) || str(d.subtaskId),
          message: str(d.failureReason) || str(err.message),
        });
        break;
      }
      default:
        break;
    }
  }
  const stepList = [...steps.values()].filter((s) => s.step > 0).sort((a, b) => a.step - b.step);
  const toolList = [...tools.values()].sort((a, b) => b.calls - a.calls || b.durationMs - a.durationMs);
  return { steps: stepList, tools: toolList, errors, eventsByType };
}
// ---------------------------------------------------------------------------
// 六阶段错误归因
// ---------------------------------------------------------------------------

function countBy(events: TraceEvent[], type: string): number {
  return events.reduce((n, e) => n + (e.type === type ? 1 : 0), 0);
}

/** 同名工具在失败之后是否又成功过（"自愈"判据：失败但被后续成功覆盖 → 记 gap 而非 fail） */
function recoveredAfter(events: TraceEvent[], name: string, seq: number): boolean {
  return events.some((e) => e.seq > seq && e.type === 'tool_completed' && toolNameOf(asRecord(e.data)) === name);
}

export function attributeStages(
  run: RunReportRun,
  agg: RunEventAggregate,
  events: TraceEvent[],
  subtasks: SubtaskOutcome[],
  orch: OrchestrationReport | undefined,
): StageFinding[] {
  const started = asRecord(events.find((e) => e.type === 'run_started')?.data);
  const inputs = asRecord(started.inputs);
  const limits = asRecord(started.limits);
  const allowedTools = Array.isArray(started.allowedTools) ? started.allowedTools.length : 0;
  const firstModelSeq = events.find((e) => e.type === 'model_request')?.seq ?? Number.POSITIVE_INFINITY;

  // ① 入参与分流
  const intakeErrors = agg.errors.filter((e) => e.seq < firstModelSeq);
  const intake: StageFinding = {
    id: 'intake',
    title: '① 入参与分流',
    verdict: intakeErrors.length ? 'fail' : 'ok',
    summary: intakeErrors.length
      ? `首个模型调用（seq ${firstModelSeq}）之前已有 ${intakeErrors.length} 个错误：${intakeErrors.map((e) => `${e.code}@seq${e.seq}`).join('、')}`
      : `入参被接受：runType=${run.runType}${run.isMock ? '（mock）' : ''}、目标 ${run.goal.length} 字、可用工具 ${allowedTools} 个`,
    evidence: intakeErrors.map((e) => e.seq),
    metrics: [
      ['runType', run.runType],
      ['目标字数', run.goal.length],
      ['maxSteps', num(limits.maxSteps) || '未记录'],
      ['maxModelCalls', num(limits.maxModelCalls) || '未记录'],
      ['可用工具', allowedTools || '未记录'],
    ],
  };

  // ② 模型调用
  const modelRequests = countBy(events, 'model_request');
  const modelCompleted = events.filter((e) => e.type === 'model_completed');
  const modelErrors = modelCompleted.filter((e) => str(asRecord(e.data).status) === 'error').length;
  const retries = Math.max(0, modelRequests - modelCompleted.length);
  const modelUsage = parseUsage(run.usageJson);
  const model: StageFinding = {
    id: 'model',
    title: '② 模型调用',
    verdict: modelErrors > 0 ? 'fail' : retries > 0 ? 'gap' : modelCompleted.length ? 'ok' : 'na',
    summary: modelCompleted.length
      ? `${modelCompleted.length} 次完成 / ${modelRequests} 次请求（差 ${retries} = 重试或未完成）· ${fmtNum(modelUsage.totalTokens)} tok · ${fmtUsd(modelUsage.costUsd)}`
      : '无模型调用事件（可能是入参即失败 / 非模型路径）',
    evidence: events.filter((e) => e.type === 'model_request' || e.type === 'model_completed').map((e) => e.seq).slice(0, 20),
    metrics: [
      ['model_request', modelRequests],
      ['model_completed', modelCompleted.length],
      ['status=error', modelErrors],
      ['重试/未完成', retries],
      ['tokens', modelUsage.totalTokens],
      ['成本', fmtUsd(modelUsage.costUsd)],
    ],
  };

  // ③ 工具调用
  const toolFails = agg.errors.filter((e) => e.source === 'tool');
  const unrecovered = toolFails.filter((f) => !recoveredAfter(events, f.name, f.seq));
  const mainToolCalls = agg.tools.filter((t) => !t.subagent).reduce((n, t) => n + t.calls, 0);
  const subToolCalls = agg.tools.filter((t) => t.subagent).reduce((n, t) => n + t.calls, 0);
  const tool: StageFinding = {
    id: 'tool',
    title: '③ 工具调用',
    verdict: toolFails.length === 0 ? 'ok' : unrecovered.length ? 'fail' : 'gap',
    summary: toolFails.length === 0
      ? `${mainToolCalls} 次主 Agent 工具调用、0 次失败（另有 ${subToolCalls} 次来自子任务）`
      : `${toolFails.length} 次失败（${unrecovered.length} 次未被后续成功覆盖）——${toolFails.map((f) => `${f.name}:${f.code}`).join('、')}`,
    evidence: toolFails.map((f) => f.seq),
    metrics: [
      ['主 Agent 工具调用', mainToolCalls],
      ['子任务工具调用', subToolCalls],
      ['失败', toolFails.length],
      ['未自愈', unrecovered.length],
    ],
  };

  // ④ 子任务与编排
  const stats = summarizeSubtasks(subtasks) ?? { total: 0, ok: 0, failed: 0, cancelled: 0, limited: 0, ids: [] };
  const usage = summarizeSubtaskUsage(subtasks);
  const gaps = orch?.gaps ?? null;
  const subtaskVerdict: StageVerdict = !subtasks.length
    ? 'na'
    : stats.failed > 0 || stats.limited > 0
      ? 'fail'
      : stats.cancelled > 0
        ? 'gap'
        : 'ok';
  const subtask: StageFinding = {
    id: 'subtask',
    title: '④ 子任务与编排',
    verdict: subtaskVerdict,
    summary: !subtasks.length
      ? '未派发子任务（单 Agent 路径）'
      : `${stats.total} 个子任务：成功 ${stats.ok}、失败 ${stats.failed}、取消 ${stats.cancelled}、被限流截断 ${stats.limited}` +
        (gaps ? `；缺口合计 ${gaps.total}（未解决项 ${gaps.unresolved}）` : ''),
    evidence: events.filter((e) => e.type.startsWith('subtask_') || e.type === 'orchestration_submitted').map((e) => e.seq).slice(0, 24),
    metrics: [
      ['子任务数', stats.total],
      ['成功/失败', `${stats.ok}/${stats.failed}`],
      ['取消/限流', `${stats.cancelled}/${stats.limited}`],
      ['子任务工具调用', usage.toolCalls],
      ['子任务 tokens', usage.totalTokens],
      ['子任务成本', fmtUsd(usage.costUsd)],
    ],
  };

  // ⑤ 审批 / 落盘 / 验证
  const requested = countBy(events, 'approval_requested');
  const decided = events.filter((e) => e.type === 'approval_decided');
  const denies = decided.filter((e) => str(asRecord(e.data).value) === 'deny').length;
  const autoByPolicy = decided.filter((e) => asRecord(e.data).autoByPolicy === true).length;
  const hostVerifyMentions = events.filter((e) => JSON.stringify(e.data ?? {}).includes('hostVerify')).length;
  const verifyStarted = countBy(events, 'verification_started');
  const verifyDone = events.filter((e) => e.type === 'verification_completed');
  const verifyFailed = verifyDone.filter((e) => {
    const d = asRecord(e.data);
    return d.cancelled !== true && d.ok !== true;
  }).length;
  const verifyCancelled = verifyDone.filter((e) => asRecord(e.data).cancelled === true).length;
  const applyEvents = events.filter((e) => e.type === 'change_applied');
  const appliedFiles = applyEvents.reduce((n, e) => n + (Array.isArray(asRecord(e.data).applied) ? (asRecord(e.data).applied as unknown[]).length : 0), 0);
  const rollbackEvents = events.filter((e) => e.type === 'change_rolled_back');
  const rolledBackFiles = rollbackEvents.reduce((n, e) => n + (Array.isArray(asRecord(e.data).files) ? (asRecord(e.data).files as unknown[]).length : 0), 0);
  const approvalVerdict: StageVerdict =
    verifyFailed > 0 ? 'fail'
      : denies > 0 || rolledBackFiles > 0 || verifyCancelled > 0 ? 'gap'
        : requested > 0 || verifyStarted > 0 || applyEvents.length > 0 ? 'ok' : 'na';
  const approval: StageFinding = {
    id: 'approval',
    title: '⑤ 审批 / 落盘 / 验证',
    verdict: approvalVerdict,
    summary: (requested === 0 && verifyStarted === 0 && !applyEvents.length)
      ? '未触发人工审批或验证（无写操作）'
      : `${requested} 次审批请求 / ${decided.length} 次决定（拒绝 ${denies}、粘性自动放行 ${autoByPolicy}）；` +
        `验证 ${verifyStarted} 次（失败 ${verifyFailed}、取消 ${verifyCancelled}）；` +
        `落盘 ${appliedFiles} 个文件、回滚 ${rolledBackFiles} 个；含 hostVerify 字样 ${hostVerifyMentions} 条`,
    evidence: events.filter((e) =>
      e.type === 'approval_requested' || e.type === 'approval_decided' ||
      e.type === 'verification_started' || e.type === 'verification_completed' ||
      e.type === 'change_applied' || e.type === 'change_rolled_back').map((e) => e.seq),
    metrics: [
      ['审批请求', requested],
      ['已决定', decided.length],
      ['拒绝', denies],
      ['粘性自动放行', autoByPolicy],
      ['验证开始', verifyStarted],
      ['验证失败/取消', `${verifyFailed}/${verifyCancelled}`],
      ['落盘文件', appliedFiles],
      ['回滚文件', rolledBackFiles],
      ['hostVerify 提及', hostVerifyMentions],
    ],
  };

  // ⑥ 收尾与交付
  const unresolved = orch?.unresolved ?? [];
  const blockedHint = unresolved.filter((u) => /待用户|阻塞|未解决|人工复核/.test(u)).length;
  const deliveryVerdict: StageVerdict =
    run.status === 'completed'
      ? (orch?.partial || unresolved.length ? 'gap' : 'ok')
      : run.status === 'awaiting_user'
        ? 'gap'
        : 'fail';
  const delivery: StageFinding = {
    id: 'delivery',
    title: '⑥ 收尾与交付',
    verdict: deliveryVerdict,
    summary:
      `终态 ${run.status}` +
      (run.failureReason ? `（${run.failureReason}）` : '') +
      (run.triggeredLimit ? ` · 触发限制 ${run.triggeredLimit}` : '') +
      (unresolved.length ? ` · 未解决项 ${unresolved.length}（含"待用户回答/阻塞"字样 ${blockedHint} 条）` : '') +
      (orch?.partial ? ' · partial=true（结论只覆盖成功的那部分）' : ''),
    evidence: events.filter((e) => e.type.startsWith('run_')).map((e) => e.seq),
    metrics: [
      ['终态', run.status],
      ['steps', run.steps],
      ['failureReason', run.failureReason || '—'],
      ['未解决项', unresolved.length],
      ['最终答复', run.finalAnswer ? `${String(run.finalAnswer).length} 字` : '空'],
    ],
  };

  return [intake, model, tool, subtask, approval, delivery];
}
// ---------------------------------------------------------------------------
// 报告装配
// ---------------------------------------------------------------------------

const VERDICT_ICON: Record<StageVerdict, string> = { ok: '✅', gap: '⚠️', fail: '❌', na: '·' };

export function verdictIcon(v: StageVerdict): string {
  return VERDICT_ICON[v];
}

function mermaidFlow(run: RunReportRun, agg: RunEventAggregate): string {
  const lines = ['```mermaid', 'graph TD'];
  lines.push(`  R["run_started · ${label(run.runType, 24)}${run.isMock ? ' · mock' : ''}<br/>${label(run.goal, 64)}"]`);
  let prev = 'R';
  let failClass = false;
  let waitClass = false;
  for (const s of agg.steps) {
    const id = `S${s.step}`;
    lines.push(`  ${id}["step ${s.step}<br/>模型 ${s.modelCalls} · 工具 ${s.tools} · ${fmtMs(s.durationMs)}"]`);
    lines.push(`  ${prev} --> ${id}`);
    if (s.toolFails > 0) {
      lines.push(`  class ${id} fail`);
      failClass = true;
    }
    prev = id;
  }
  const endLabel = `${run.status}${run.triggeredLimit ? ` · ${run.triggeredLimit}` : ''}<br/>${run.steps} 步 / ${run.modelCalls} 模型 / ${run.toolCalls} 工具`;
  lines.push(`  E["${label(endLabel, 90)}"]`);
  lines.push(`  ${prev} --> E`);
  if (run.status === 'awaiting_user') {
    lines.push('  class E wait');
    waitClass = true;
  } else if (run.status !== 'completed') {
    lines.push('  class E fail');
    failClass = true;
  }
  if (failClass) lines.push('  classDef fail fill:#fee2e2,stroke:#dc2626,color:#991b1b');
  if (waitClass) lines.push('  classDef wait fill:#fff7ed,stroke:#d97706,color:#92400e');
  lines.push('```');
  return lines.join('\n');
}

function mermaidSubtasks(run: RunReportRun, subtasks: SubtaskOutcome[], limit = 10): string {
  const shown = subtasks.slice(0, limit);
  const lines = ['```mermaid', 'graph LR'];
  lines.push(`  R["${label(run.runId, 34)}"]`);
  shown.forEach((s, i) => {
    const id = `T${i + 1}`;
    const icon = s.status === 'ok' ? '✅' : s.status === 'failed' ? '❌' : s.status === 'limit_reached' ? '⏱️ 限流截断' : '⛔ 取消';
    lines.push(`  ${id}["${label(`${s.specId} ${icon}`, 40)}<br/>${label(s.objective, 44)}<br/>${s.steps} 步 · ${s.toolCalls} 工具 · ${fmtMs(s.durationMs)}"]`);
    lines.push(`  R --> ${id}`);
    lines.push(`  ${id} --> SUM`);
    if (s.status !== 'ok') lines.push(`  class ${id} bad`);
  });
  lines.push(`  SUM["编排汇总<br/>${subtasks.length} 个子任务"]`);
  if (shown.some((s) => s.status !== 'ok')) lines.push('  classDef bad fill:#fee2e2,stroke:#dc2626,color:#991b1b');
  lines.push('```');
  if (subtasks.length > shown.length) lines.push(`> （图上只画前 ${shown.length} 个，另有 ${subtasks.length - shown.length} 个见下表）\n`);
  return lines.join('\n');
}

export interface BuildRunReportInput {
  run: RunReportRun;
  events: TraceEvent[];
  /** 生成时间（ISO）；由调用方传入以保证可重复 */
  generatedAt: string;
}

export function buildRunReport(input: BuildRunReportInput): RunReportResult {
  const { run, events, generatedAt } = input;
  const agg = aggregateRunEvents(events);
  const payload = unpackResultJson(run.resultJson);
  const subtasks = payload.subtasks ?? [];
  const orch = payload.orchestration;
  const misc = payload.misc;
  const mainUsage = parseUsage(run.usageJson);
  const subUsage = summarizeSubtaskUsage(subtasks);
  const stats = summarizeSubtasks(subtasks) ?? { total: 0, ok: 0, failed: 0, cancelled: 0, limited: 0, ids: [] };
  const gaps = orch?.gaps ?? null;
  const stages = attributeStages(run, agg, events, subtasks, orch);

  const totalTokens = mainUsage.totalTokens + subUsage.totalTokens;
  const totalCost = mainUsage.costUsd + subUsage.costUsd;
  const headline =
    `${run.runType} · ${run.status}` +
    (stats.total ? ` · 子任务 ${stats.total}（成功 ${stats.ok} / 失败 ${stats.failed} / 取消 ${stats.cancelled} / 限流截断 ${stats.limited}）` : '') +
    (gaps ? ` · 缺口 ${gaps.total}` : '') +
    ` · ${run.steps} 步 / ${run.modelCalls} 模型 / ${run.toolCalls}+${subUsage.toolCalls} 工具 · ${fmtNum(totalTokens)} tok · ${fmtUsd(totalCost)} · ${fmtMs(run.totalDurationMs)}`;

  const meta: RunReportMeta = {
    runId: run.runId,
    runType: run.runType,
    status: run.status,
    isMock: run.isMock === 1,
    generatedAt,
    steps: run.steps,
    modelCalls: run.modelCalls,
    toolCalls: run.toolCalls,
    totalTokens,
    costUsd: totalCost,
    durationMs: run.totalDurationMs,
    subtask: {
      total: stats.total,
      ok: stats.ok,
      failed: stats.failed,
      cancelled: stats.cancelled,
      limited: stats.limited,
      toolCalls: subUsage.toolCalls,
      totalTokens: subUsage.totalTokens,
      costUsd: subUsage.costUsd,
    },
    gaps,
    stages: stages.map((s) => ({ id: s.id, verdict: s.verdict })),
    headline,
  };

  const L: string[] = [];
  L.push(`# Run 报告：\`${run.runId}\``);
  L.push(`${META_PREFIX}${JSON.stringify(meta)} -->`);
  L.push('');
  L.push(`> 生成时间：**${generatedAt}** ｜ 数据源：\`runs\` 行 + \`events\` 事件流 + \`runs.resultJson\``);
  L.push('> 口径说明：**run 行的 counters 只算主 Agent**（子任务的调用不计入），子任务消耗单列；');
  L.push('> 所有数字由事件/结果字段机械统计，**不信任 `finalAnswer` 的自述**。');
  L.push('');
  L.push('## 0. 一行结论');
  L.push('');
  L.push(`**${headline}**`);
  L.push('');
  L.push(`- 目标：${label(run.goal, 400)}`);
  L.push(`- 创建时间：${run.createdAt}${run.updatedAt ? ` ｜ 最后更新：${run.updatedAt}` : ''}`);
  L.push(`- 是否 mock：${run.isMock === 1 ? '是（Mock 剧本，不代表真实模型能力）' : '否（真实模型）'}`);
  if (run.failureReason) L.push(`- 失败原因：${run.failureReason}${run.triggeredLimit ? `（触发限制：${run.triggeredLimit}）` : ''}`);
  L.push(`- 事件数：${events.length}（` + Object.entries(agg.eventsByType).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}=${v}`).join('、') + '）');
  L.push('');
  L.push('## 1. 分层量化');
  L.push('');
  L.push('| 层 | 步 | 模型调用 | 工具调用 | tokens | 成本 | 耗时 |');
  L.push('|---|---|---|---|---|---|---|');
  L.push(`| **主 Agent**（\`runs\` 行口径） | ${run.steps} | ${run.modelCalls} | ${run.toolCalls} | ${fmtNum(mainUsage.totalTokens)} | ${fmtUsd(mainUsage.costUsd)} | ${fmtMs(run.totalDurationMs)} |`);
  if (stats.total) {
    const subSteps = subtasks.reduce((n, s) => n + s.steps, 0);
    const subModels = subtasks.reduce((n, s) => n + s.modelCalls, 0);
    const subDur = subtasks.reduce((n, s) => n + s.durationMs, 0);
    L.push(`| 子任务合计（${stats.total} 个） | ${subSteps} | ${subModels} | ${subUsage.toolCalls} | ${fmtNum(subUsage.totalTokens)} | ${fmtUsd(subUsage.costUsd)} | ${fmtMs(subDur)}（并行，不与主 Agent 相加） |`);
  }
  L.push(`| **合计** | — | ${run.modelCalls + subtasks.reduce((n, s) => n + s.modelCalls, 0)} | ${run.toolCalls + subUsage.toolCalls} | **${fmtNum(totalTokens)}** | **${fmtUsd(totalCost)}** | ${fmtMs(run.totalDurationMs)}（墙钟） |`);
  L.push('');
  L.push('> 提醒：只看「主 Agent」列会低估消耗——子任务的模型调用/工具调用/tokens 在第二行，');
  L.push('> 这正是 2026-10-15 记账 run 复核里「干净的 3 步完成」的由来。');
  L.push('');
  L.push('## 2. 执行流程图');
  L.push('');
  L.push(mermaidFlow(run, agg));
  L.push('');
  if (subtasks.length) {
    L.push('### 2.1 子任务与汇总');
    L.push('');
    L.push(mermaidSubtasks(run, subtasks));
  }
  L.push('## 3. 分步明细（主 Agent）');
  L.push('');
  if (agg.steps.length) {
    L.push('| step | 模型调用 | 工具 | 工具失败 | tokens | 成本 | 耗时 | 工具名 |');
    L.push('|---|---|---|---|---|---|---|---|');
    for (const s of agg.steps) {
      L.push(`| ${s.step} | ${s.modelCalls} | ${s.tools} | ${s.toolFails} | ${fmtNum(s.tokens)} | ${fmtUsd(s.costUsd)} | ${fmtMs(s.durationMs)} | ${label(s.toolNames.join(', ') || '—', 80)} |`);
    }
  } else {
    L.push('（无分步事件：可能入参即失败，或事件流缺失）');
  }
  L.push('');
  L.push('## 4. 子任务明细');
  L.push('');
  if (subtasks.length) {
    L.push('| subtaskId | spec | 状态 | 步 | 模型 | 工具 | tokens | 成本 | 耗时 | 结构化报告 | 契约/失败 |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const s of subtasks) {
      const state = s.status === 'ok' ? '✅ ok' : s.status === 'failed' ? '❌ failed' : s.status === 'limit_reached' ? '⏱️ limit_reached' : '⛔ cancelled';
      const contract = s.contractViolation ? `⚠️ ${label(s.contractViolation, 40)}` : s.failureReason ? label(s.failureReason, 50) : '—';
      L.push(`| \`${s.subtaskId}\` | ${s.specId} | ${state} | ${s.steps} | ${s.modelCalls} | ${s.toolCalls} | ${fmtNum(s.usage?.totalTokens ?? 0)} | ${fmtUsd(s.usage?.costUsd ?? 0)} | ${fmtMs(s.durationMs)} | ${s.report ? `是（置信度 ${s.report.confidence ?? '—'}、证据 ${s.report.evidence?.length ?? 0}）` : '**否**'} | ${contract} |`);
    }
  } else {
    L.push('（本次未派发子任务）');
  }
  L.push('');
  L.push('## 5. 工具调用聚合');
  L.push('');
  if (agg.tools.length) {
    L.push('| 工具 | 调用 | 失败 | 累计耗时 | 来源 |');
    L.push('|---|---|---|---|---|');
    for (const t of agg.tools.slice(0, 25)) {
      L.push(`| \`${t.name}\` | ${t.calls} | ${t.fails || '—'} | ${fmtMs(t.durationMs)} | ${t.subagent ? '子任务' : '主 Agent'} |`);
    }
  } else {
    L.push('（无工具调用）');
  }
  L.push('');
  L.push('## 6. 六阶段错误归因');
  L.push('');
  L.push('| 阶段 | 结论 | 说明 | 证据 seq |');
  L.push('|---|---|---|---|');
  for (const s of stages) {
    const ev = s.evidence.length ? s.evidence.slice(0, 12).join(', ') + (s.evidence.length > 12 ? ` …(+${s.evidence.length - 12})` : '') : '—';
    L.push(`| ${s.title} | ${verdictIcon(s.verdict)} ${s.verdict} | ${label(s.summary, 260)} | ${ev} |`);
  }
  L.push('');
  for (const s of stages) {
    L.push(`<details><summary>${s.title} — ${verdictIcon(s.verdict)} ${s.verdict}</summary>`);
    L.push('');
    for (const [k, v] of s.metrics) L.push(`- ${k}：${v}`);
    L.push('');
    L.push('</details>');
  }
  L.push('');
  L.push('## 7. 缺口与未解决项');
  L.push('');
  if (gaps) {
    L.push(`- 缺口计数（\`orchestration.gaps\`）：失败 ${gaps.failed}、取消 ${gaps.cancelled}、限流截断 ${gaps.limited}、未解决 ${gaps.unresolved}、**合计 ${gaps.total}**`);
    L.push(`- partial：${orch?.partial ? '**true**（结论只覆盖成功的那部分）' : 'false'}`);
  } else if (stats.total) {
    L.push('- 无 `gaps` 字段（**旧 run 或老口径数据**）：按 `subtasks` 现场统计——' + `失败 ${stats.failed}、取消 ${stats.cancelled}、限流截断 ${stats.limited}`);
  } else if (orch) {
    L.push('- 无 `gaps` 字段（**旧 run 或老口径数据**）且 `resultJson.subtasks` 无明细——只能看到模型自报的统计，无法逐项核对：' + JSON.stringify(orch.subtasks ?? null));
  } else {
    L.push('- 无编排缺口（未走编排路径）');
  }
  const unresolved = orch?.unresolved ?? [];
  if (unresolved.length) {
    L.push('');
    L.push('未解决项（模型自报 + Runtime 自动补漏）：');
    unresolved.forEach((u, i) => L.push(`${i + 1}. ${u}`));
  }
  L.push('');
  L.push('## 8. 原始错误清单');
  L.push('');
  if (agg.errors.length) {
    L.push('| seq | 来源 | 名称 | 错误码 | 消息 |');
    L.push('|---|---|---|---|---|');
    for (const e of agg.errors) L.push(`| ${e.seq} | ${e.source} | ${label(e.name || '—', 40)} | \`${e.code}\` | ${label(e.message, 160)} |`);
  } else {
    L.push('（无 tool_failed / runtime_error / subtask_failed 事件）');
  }
  L.push('');
  L.push('## 9. 诚实清单与盲点');
  L.push('');
  L.push('- `llm_delta`（逐字增量）**不落盘**（`ephemeral`），因此本报告看不到流式抖动，只看事件骨架。');
  L.push('- 审批 diff 全文不进事件流（落 `data/sandbox/<runId>/diffs/*.patch`），本报告只能看到审批请求/决定的摘要。');
  L.push('- `run_command` 落宿主后的副作用无法从沙箱同步（靠 git/备份兜底），本报告不覆盖。');
  L.push('- 主 Agent 与子任务的**耗时不可相加**（子任务并行，且子任务时间包含在墙钟内）。');
  L.push('- 成本/ tokens 来自 Provider 回报或估算（`isEstimate`），不是账单对账值。');
  L.push('- 非终态 run（`running`）生成报告时数字会继续变化。');
  L.push('');
  L.push('## 10. 附录：最终答复（模型文字，不可作证据）');
  L.push('');
  L.push(run.finalAnswer ? '```text\n' + String(run.finalAnswer) + '\n```' : '（无最终答复）');
  L.push('');
  if (misc) {
    L.push('### 附：杂项（misc）结构化结论');
    L.push('');
    L.push(`- summary：${label(misc.summary ?? '', 400)}`);
    if (misc.escalateTo) L.push(`- 建议改派：${misc.escalateTo}（${misc.escalateReason ?? '—'}）`);
    L.push('');
  }
  if (orch) {
    L.push('### 附：编排汇总报告');
    L.push('');
    L.push(`- summary：${label(orch.summary ?? '', 400)}`);
    L.push(`- findings：${orch.findings?.length ?? 0} ｜ conflicts：${orch.conflicts?.length ?? 0} ｜ unresolved：${orch.unresolved?.length ?? 0} ｜ structured：${orch.structured}`);
    if (orch.escalateTo) L.push(`- 建议改派：${orch.escalateTo}（${orch.escalateReason ?? '—'}）`);
    L.push('');
  }

  return { markdown: L.join('\n') + '\n', meta };
}

// ---------------------------------------------------------------------------
// INDEX（reports/runs/INDEX.md）：扫各报告首行的 meta 注释重建
// ---------------------------------------------------------------------------

export function parseRunReportMeta(text: string): RunReportMeta | null {
  for (const line of text.split(/\r?\n/).slice(0, 6)) {
    if (!line.startsWith(META_PREFIX)) continue;
    const json = line.slice(META_PREFIX.length).replace(/\s*-->\s*$/, '');
    try {
      return JSON.parse(json) as RunReportMeta;
    } catch {
      return null;
    }
  }
  return null;
}

export function buildRunReportIndex(metas: RunReportMeta[]): string {
  const sorted = [...metas].sort((a, b) => (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0));
  const lines: string[] = [];
  lines.push('# Run 报告索引（自动生成，勿手改）');
  lines.push('');
  lines.push('> 由 `npm run report:run`（`scripts/gen-run-report.ts`）生成：每个 run 一份 `reports/runs/<runId>.md`。');
  lines.push('> 图例：阶段结论 ✅ ok / ⚠️ gap（有缺口但可解释）/ ❌ fail / · 不适用。');
  lines.push('');
  lines.push('| runId | 类型 | 状态 | 阶段 | 缺口 | 一行结论 |');
  lines.push('|---|---|---|---|---|---|');
  for (const m of sorted) {
    const icons = m.stages.map((s) => verdictIcon(s.verdict)).join('');
    lines.push(`| [\`${m.runId}\`](./${m.runId}.md) | ${m.runType} | ${m.status}${m.isMock ? ' (mock)' : ''} | ${icons} | ${m.gaps ? m.gaps.total : '—'} | ${label(m.headline, 150)} |`);
  }
  lines.push('');
  lines.push(`共 ${sorted.length} 份；生成命令见 \`reports/PROJECT_REPORT.md\` §7。`);
  lines.push('');
  return lines.join('\n');
}
