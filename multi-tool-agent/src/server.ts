// src/server.ts — HTTP API（含 SSE 实时事件）
import express from 'express';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { assertHttpSecurity, type RuntimeConfig } from './config.js';
import { buildRuntime } from './runtime/index.js';
import { recordToResult } from './store/SqliteStore.js';
import { buildTraceSnapshot } from './trace/Tracer.js';
import { buildRunReport, toReportRun } from './report/runReport.js';
import { listRunReportMetas } from './report/runReportFiles.js';
import type { RunInput, RunType, TraceEvent, TraceEventType, ApprovalDecisionValue, ToolChoice, OrchestrationGate } from './types.js';
import { LLM_PRESETS, PARAM_META, getPreset } from './llm/presets.js';
import { testLlmConnection, normalizeBaseUrl } from './llm/testConnection.js';
import { createProvider } from './llm/index.js';
import { classifyTask } from './runtime/router.js';
import { preSplitSubtasks, pickTopLevelDirs, extractTopics } from './runtime/preSplit.js';
import { SUB_AGENT_SPECS, listSpecIds, validateSpecs } from './agents/specs.js';
import { TOOL_PERMISSION } from './runtime/AgentRuntime.js';
import { toolPoolFor } from './runtime/toolPool.js';
import { adviseOrchestration, scanRepoFacts } from './runtime/orchestrationGate.js';
import { aggregateSubtaskStats } from './runtime/subtaskStats.js';
import { parseRunLimits } from './runtime/runLimits.js';
import { FixedWindowLimiter } from './runtime/rateLimit.js';
import { getEnv } from './env.js';
import { clampNumber, parseGenerationParams } from './llm/params.js';
import { diagnoseRun } from './observability/latency.js';
import { McpServer } from './mcp/server.js';
import { McpClientRuntime } from './mcp/bootstrap.js';
import { SchedulerService } from './scheduler/service.js';
import { computeNextRunAt, parseDailyTime } from './scheduler/time.js';
import type { ScheduleOptions, ScheduleRecord } from './scheduler/types.js';

/** 任务终态事件（收到即关闭 SSE 连接） */
const TERMINAL_EVENT_TYPES = new Set<TraceEventType>([
  'run_awaiting_user',
  'run_completed',
  'run_failed',
  'run_cancelled',
  'run_limit_reached',
]);

/** 任务终态状态 */
const TERMINAL_RUN_STATUS = new Set(['completed', 'failed', 'cancelled', 'limit_reached', 'awaiting_user']);

export interface RunRequestValidation {
  input?: RunInput;
  error?: string;
}

/**
 * 解析并校验「创建任务」请求体（纯函数，便于测试，不发任何请求）。
 * 服务端不信任前端：路径/工具/预算全部在此校验，密钥绝不持久化。
 */
export function validateRunRequest(body: Record<string, unknown>, config: RuntimeConfig): RunRequestValidation {
  const runType = body.runType as RunType;
  if (runType !== 'codebase' && runType !== 'research' && runType !== 'misc' && runType !== 'orchestrator' && runType !== 'codex') {
    return { error: 'runType 必须为 codebase、research、misc、orchestrator 或 codex' };
  }
  // 无人值守自动放行 / schedule 归属只能由服务端定时任务设置，不接受客户端伪造
  if (body.autoApprove !== undefined || body.scheduleId !== undefined) {
    return { error: 'autoApprove / scheduleId 只能由服务端定时任务设置，不能通过 API 提交' };
  }
  if (typeof body.goal !== 'string' || !body.goal.trim()) {
    return { error: 'goal 不能为空' };
  }
  // 上限防止 1MB 级 goal 原样入库/进 prompt，挤爆预算与日志。
  if (body.goal.length > 20_000) {
    return { error: `goal 过长（${body.goal.length} 字符，最多 20000）` };
  }
  // 运行测试是「在目标仓库执行代码」的能力：必须是显式布尔，避免字符串 "false" 被误当真
  if (body.allowRunTests !== undefined && typeof body.allowRunTests !== 'boolean') {
    return { error: 'allowRunTests 必须是布尔值' };
  }
  const limits = parseRunLimits(body);
  if (limits.error) return { error: limits.error };

  // ---- 单次任务的 LLM 覆盖（兼容旧字段 body.llmMode）----
  const llmModeRaw =
    (body.llm as any)?.mode ??
    (body.llmMode === 'openai' || body.llmMode === 'mock' ? body.llmMode : undefined);

  // 生成参数（temperature / max_tokens / thinking …）：越界直接报错，不静默改值
  const parsedParams = parseGenerationParams((body.llm as any)?.params);
  if (parsedParams.error) return { error: parsedParams.error };

  // Provider 预设：必须是已知预设 id（未知 id 明确拒绝，避免拼错后悄悄走错接口）
  const providerRaw = (body.llm as any)?.provider;
  if (providerRaw !== undefined && providerRaw !== '' && !getPreset(String(providerRaw))) {
    return {
      error: `未知的 LLM Provider 预设: ${JSON.stringify(providerRaw)}。可选: ${LLM_PRESETS.map((p) => p.id).join(', ')}`,
    };
  }

  // ---- 工具选择策略（function calling 的 tool_choice / parallel_tool_calls）----
  // 注意：这里必须显式白名单校验，不能把 body.llm 原样透传（HTTP 输入不可信）。
  const toolChoice = parseToolChoice((body.llm as any)?.toolChoice, body.allowedTools);
  if (toolChoice.error) return { error: toolChoice.error };
  const parallelToolCalls = parseParallelToolCalls((body.llm as any)?.parallelToolCalls);
  if (parallelToolCalls.error) return { error: parallelToolCalls.error };

  const llm =
    llmModeRaw ||
    providerRaw ||
    (body.llm as any)?.apiKey ||
    (body.llm as any)?.baseUrl ||
    (body.llm as any)?.model ||
    parsedParams.params ||
    toolChoice.value !== undefined ||
    parallelToolCalls.value !== undefined
      ? {
          mode: llmModeRaw as 'mock' | 'openai' | undefined,
          provider: providerRaw ? String(providerRaw) : undefined,
          apiKey: str((body.llm as any)?.apiKey),
          baseUrl: str((body.llm as any)?.baseUrl),
          model: str((body.llm as any)?.model),
          params: parsedParams.params,
          toolChoice: toolChoice.value,
          parallelToolCalls: parallelToolCalls.value,
        }
      : undefined;

  // ---- 单次任务的搜索覆盖 ----
  const searchProviderRaw = (body.search as any)?.provider;
  const search =
    searchProviderRaw || (body.search as any)?.apiKey || (body.search as any)?.baseUrl
      ? {
          provider: (searchProviderRaw === 'serper'
            ? 'serper'
            : searchProviderRaw === 'offline'
              ? 'offline'
              : undefined) as 'offline' | 'serper' | undefined,
          apiKey: str((body.search as any)?.apiKey),
          baseUrl: str((body.search as any)?.baseUrl),
        }
      : undefined;

  // 前置校验：显式选择真实 Provider 但无 Key 时明确拒绝（不静默降级为 Mock）
  const effectiveLlmMode = llm?.mode ?? config.llmMode;
  // Key 解析顺序与 createProvider 保持一致：单次任务 > 全局配置 > 预设对应的环境变量
  const presetKeyEnv = getPreset(llm?.provider ?? config.llm.presetId)?.apiKeyEnv;
  const presetEnvKey = presetKeyEnv ? getEnv(presetKeyEnv) || undefined : undefined;
  const presetKeyOptional = getPreset(llm?.provider ?? config.llm.presetId)?.keyOptional ?? false;
  const effectiveLlmKey =
    llm?.apiKey ?? config.llm.apiKey ?? presetEnvKey ?? config.openai.apiKey;
  if (effectiveLlmMode === 'openai' && runType !== 'codex' && !effectiveLlmKey && !presetKeyOptional) {
    const preset = getPreset(llm?.provider ?? config.llm.presetId);
    return {
      error: `已选择 ${preset?.label ?? 'OpenAI 兼容'} 模式但未提供 API Key：请在界面填写，或设置 ${
        preset?.apiKeyEnv ?? 'OPENAI_API_KEY'
      } 环境变量。`,
    };
  }
  const effectiveSearchProvider = search?.provider ?? config.search.provider;
  const effectiveSearchKey = search?.apiKey ?? config.search.apiKey;
  if (effectiveSearchProvider === 'serper' && !effectiveSearchKey) {
    return { error: '已选择 Serper 真实搜索但未提供 API Key：请在界面填写，或设置 SEARCH_API_KEY 环境变量。' };
  }

  // ---- 单次任务的实时流式覆盖 ----
  // 注意：mockChunkDelayMs 由客户端传入但会被钳制在上限内，避免被用来人为拖慢服务端。
  const streamRaw = (body.stream ?? {}) as Record<string, unknown>;
  const streamDelayRaw = num(streamRaw.mockChunkDelayMs);
  const stream =
    typeof streamRaw.liveDeltas === 'boolean' || streamDelayRaw !== undefined
      ? {
          liveDeltas: typeof streamRaw.liveDeltas === 'boolean' ? streamRaw.liveDeltas : undefined,
          mockChunkDelayMs:
            streamDelayRaw === undefined ? undefined : clampNumber(streamDelayRaw, 0, 200),
        }
      : undefined;

  const input: RunInput = {
    runType,
    goal: body.goal,
    allowedTools: Array.isArray(body.allowedTools) ? body.allowedTools.map(String) : undefined,
    maxSteps: limits.values.maxSteps,
    maxModelCalls: limits.values.maxModelCalls,
    maxToolCalls: limits.values.maxToolCalls,
    totalTimeoutMs: limits.values.totalTimeoutMs,
    tokenBudget: limits.values.tokenBudget,
    costBudgetUsd: limits.values.costBudgetUsd,
    mockScenario: typeof body.mockScenario === 'string' ? body.mockScenario : undefined,
    allowRunTests: typeof body.allowRunTests === 'boolean' ? body.allowRunTests : undefined,
    llm,
    search,
    stream,
    // 多轮上下文：前端把之前若干轮问答带上，模型据此做 follow-up。服务端裁剪到安全范围。
    contextHistory: Array.isArray(body.contextHistory)
      ? (body.contextHistory as Array<Record<string, unknown>>)
          .slice(-10)
          .map((t) => ({
            role: (t?.role === 'assistant' ? 'assistant' : 'user') as 'assistant' | 'user',
            content: typeof t?.content === 'string' ? t.content.slice(0, 2000) : '',
          }))
          .filter((t) => t.content)
      : undefined,
    contextSummary: typeof body.contextSummary === 'string' ? body.contextSummary.slice(0, 4000) : undefined,
    contextFiles: Array.isArray(body.contextFiles)
      ? [...new Set(body.contextFiles.filter((f): f is string => typeof f === 'string' && f.trim() !== '').map((f) => f.trim()))].slice(0, 20)
      : undefined,
  };

  if (runType === 'orchestrator') {
    // 编排任务需要工作区：内置子 Agent 里 dir-inventory / code-audit 都以 repoPath 为只读边界
    if (typeof body.repoPath !== 'string' || !body.repoPath.trim()) {
      return { error: 'orchestrator 任务必须提供 repoPath（工作区根目录）：子 Agent 只在这个目录内工作' };
    }
    const abs = resolve(body.repoPath.trim());
    if (!existsSync(abs)) {
      return { error: `repoPath 不存在: ${abs}（收到输入: "${body.repoPath}"）。编排任务需要一个真实存在的工作区。` };
    }
    input.repoPath = abs;

    const orchRaw = (body.orchestration ?? {}) as Record<string, unknown>;
    const maxWidthRaw = num(orchRaw.maxWidth);
    const allowedSpecsRaw = Array.isArray(orchRaw.allowedSpecs) ? orchRaw.allowedSpecs.map(String) : undefined;
    if (allowedSpecsRaw) {
      const unknown = allowedSpecsRaw.filter((id) => !listSpecIds().includes(id));
      if (unknown.length) {
        return { error: `未知的子 Agent 规格: ${unknown.join(', ')}。可用: ${listSpecIds().join(', ')}` };
      }
    }
    // 预筛建议：由服务端按规则生成（也可由前端传入，但不接受越权的 specId）
    const dirs = pickTopLevelDirs(abs, Math.min(maxWidthRaw ?? config.subagent.maxWidth, config.subagent.maxWidth));
    const topics = Array.isArray((body.research as any)?.topics)
      ? (body.research as any).topics.map(String)
      : extractTopics(String(body.goal ?? ''));
    const suggested = preSplitSubtasks(String(body.goal ?? ''), {
      dirs,
      topics,
      maxWidth: Math.min(maxWidthRaw ?? config.subagent.maxWidth, config.subagent.maxWidth),
    }).filter((sg) => !allowedSpecsRaw || allowedSpecsRaw.includes(sg.specId));

    // 显式编排不自动降级（用户已选定）；但把“单上下文是否装得下”的估算随任务记录下来，
    // 由响应、run_started 事件与（可读工具开启时的）系统提示共同解释。
    const gate = adviseOrchestration(String(body.goal ?? ''), scanRepoFacts(abs), {
      tokenBudget: input.tokenBudget ?? config.limits.tokenBudget,
    });

    input.orchestration = {
      // 宽度只允许收紧（真正的上限在 Runtime/工具里再取 min）
      maxWidth: maxWidthRaw === undefined ? undefined : clampNumber(maxWidthRaw, 1, config.subagent.maxWidth),
      allowedSpecs: allowedSpecsRaw,
      allowSelfTools: orchRaw.allowSelfTools === true,
      // M1（fail-closed）：写能力必须显式开启；未开启时 code-edit 不可派发
      allowWriteSpecs: orchRaw.allowWriteSpecs === true,
      // 严格模式：提交前跑 L2 全量（默认 false；落盘后仍有宿主全量复验）
      strictVerify: orchRaw.strictVerify === true,
      suggestedSubtasks: suggested,
      gate,
    };
    return { input };
  }

  if (runType === 'misc') {
    // 杂项任务需要一个明确的工作区边界（只读范围就是它）
    if (typeof body.repoPath !== 'string' || !body.repoPath.trim()) {
      return { error: 'misc 任务必须提供 repoPath（工作区根目录）：杂项 Agent 只在这个目录内只读' };
    }
    const abs = resolve(body.repoPath.trim());
    if (!existsSync(abs)) {
      return {
        error: `repoPath 不存在: ${abs}（收到输入: "${body.repoPath}"）。杂项任务需要一个真实存在的工作区目录。`,
      };
    }
    input.repoPath = abs;
    const miscRaw = (body.misc ?? {}) as Record<string, unknown>;
    const subtaskRaw = miscRaw.subtask;
    const SUBTASKS = ['inventory', 'locate', 'read', 'lint', 'other'];
    if (subtaskRaw !== undefined && (typeof subtaskRaw !== 'string' || !SUBTASKS.includes(subtaskRaw))) {
      return { error: `misc.subtask 只能是 ${SUBTASKS.join(' / ')}` };
    }
    const scanLimit = num(miscRaw.scanLimit);
    const maxFileBytes = num(miscRaw.maxFileBytes);
    input.misc = {
      subtask: subtaskRaw as RunInput['misc'] extends undefined ? never : 'inventory' | 'locate' | 'read' | 'lint' | 'other' | undefined,
      // 只允许收紧，不允许放宽（真正的上限在 Runtime 里再取 min）
      scanLimit: scanLimit === undefined ? undefined : clampNumber(scanLimit, 100, config.misc.scanLimit),
      maxFileBytes: maxFileBytes === undefined ? undefined : clampNumber(maxFileBytes, 1024, config.misc.maxFileBytes),
    };
    return { input };
  }

  if (runType === 'codex') {
    if (!config.codex.enabled) {
      return { error: 'Codex 已禁用（MTA_CODEX_ENABLED=false）' };
    }
    if (typeof body.repoPath !== 'string' || !body.repoPath.trim()) {
      return { error: 'codex 任务必须提供 repoPath（工作区根目录）' };
    }
    const abs = resolve(body.repoPath.trim());
    if (!existsSync(abs)) {
      return { error: `repoPath 不存在: ${abs}（收到输入: "${body.repoPath}"）。` };
    }
    input.repoPath = abs;
    const c = (body.codex ?? {}) as Record<string, unknown>;
    input.codex = {
      allowWrite: c.allowWrite === true,
      resumeThreadId: typeof c.resumeThreadId === 'string' ? c.resumeThreadId.slice(0, 100) : undefined,
      workspaceId: typeof c.workspaceId === 'string' ? c.workspaceId.slice(0, 100) : undefined,
      model: typeof c.model === 'string' ? c.model.slice(0, 100) : undefined,
      safetyPrompt: typeof c.safetyPrompt === 'string' ? c.safetyPrompt.slice(0, 4000) : undefined,
      dangerPatterns: Array.isArray(c.dangerPatterns)
        ? c.dangerPatterns.filter((x): x is string => typeof x === 'string' && !!x.trim()).slice(0, 50)
        : undefined,
    };
    return { input };
  }

  if (runType === 'codebase') {
    if (typeof body.repoPath !== 'string' || !body.repoPath.trim()) {
      return { error: 'codebase 任务必须提供 repoPath' };
    }
    const abs = resolve(body.repoPath.trim());
    if (!existsSync(abs)) {
      return {
        error: `repoPath 不存在: ${abs}（收到输入: "${body.repoPath}"）。请填仓库根目录，例如 demo/codebase-sample 或 D:/path/to/repo。`,
      };
    }
    input.repoPath = abs;
  } else {
    input.research = {
      topics: Array.isArray((body.research as any)?.topics) ? (body.research as any).topics.map(String) : undefined,
      allowedDomains: Array.isArray((body.research as any)?.allowedDomains)
        ? (body.research as any).allowedDomains.map(String)
        : undefined,
    };
  }

  return { input };
}

export interface ScheduleValidation {
  record?: ScheduleRecord;
  error?: string;
}

const SCHEDULE_AGENTS: RunType[] = ['codebase', 'research', 'misc', 'orchestrator', 'codex'];

/**
 * 解析/校验定时任务请求体（纯函数，便于测试）。
 * 安全约束：**不接受 apiKey**；autoApprove 必须与 allowWrite 同时开启；allowWrite 只对
 * orchestrator / codex 有意义；repoPath 必须是真实存在的目录。
 */
export function parseScheduleRequest(
  body: Record<string, unknown>,
  config: RuntimeConfig,
  existing: ScheduleRecord | null = null,
): ScheduleValidation {
  const now = new Date();
  const nowIso = now.toISOString();
  const b = (body ?? {}) as Record<string, unknown>;

  const agentRaw = b.agent ?? existing?.agent;
  if (!SCHEDULE_AGENTS.includes(agentRaw as RunType)) {
    return { error: 'agent 必须是 codebase / research / misc / orchestrator / codex' };
  }
  const agent = agentRaw as RunType;
  if (agent === 'codex' && !config.codex.enabled) {
    return { error: 'Codex 已禁用（MTA_CODEX_ENABLED=false）' };
  }

  const goal = typeof b.goal === 'string' ? b.goal.trim() : existing?.goal ?? '';
  if (!goal) return { error: 'goal 不能为空' };
  if (goal.length > 20_000) return { error: 'goal 过长（最多 20000 字符）' };

  let repoPath = existing?.repoPath;
  if (b.repoPath !== undefined) {
    repoPath = typeof b.repoPath === 'string' && b.repoPath.trim() ? resolve(b.repoPath.trim()) : undefined;
  }
  if (['codebase', 'misc', 'orchestrator', 'codex'].includes(agent)) {
    if (!repoPath) return { error: `${agent} 定时任务必须提供 repoPath（工作区根目录）` };
    if (!existsSync(repoPath)) return { error: `repoPath 不存在: ${repoPath}` };
  }

  const frequencyRaw = b.frequency ?? existing?.frequency ?? 'once';
  if (frequencyRaw !== 'once' && frequencyRaw !== 'daily') return { error: 'frequency 必须是 once 或 daily' };
  const frequency = frequencyRaw as 'once' | 'daily';
  const runAtRaw = b.runAt !== undefined ? b.runAt : existing?.runAt;
  if (typeof runAtRaw !== 'string' || !runAtRaw.trim()) {
    return { error: 'runAt 不能为空（once: ISO 时间；daily: HH:mm）' };
  }
  const runAt = runAtRaw.trim();
  if (frequency === 'daily') {
    if (!parseDailyTime(runAt)) return { error: 'daily 的 runAt 必须是 HH:mm（例如 09:30）' };
  } else {
    const t = new Date(runAt);
    if (Number.isNaN(t.getTime())) return { error: 'once 的 runAt 必须是合法 ISO 时间' };
    if (!existing && t.getTime() <= now.getTime()) return { error: 'once 的 runAt 必须在未来' };
  }

  const bool = (k: string, fallback: boolean): boolean =>
    typeof b[k] === 'boolean' ? (b[k] as boolean) : fallback;
  const allowWrite = bool('allowWrite', existing?.allowWrite ?? false);
  const autoApprove = bool('autoApprove', existing?.autoApprove ?? false);
  if (allowWrite && agent !== 'orchestrator' && agent !== 'codex') {
    return { error: 'allowWrite 仅支持 orchestrator 或 codex（其他 Agent 是只读的）' };
  }
  if (autoApprove && !allowWrite) return { error: 'autoApprove 必须同时开启 allowWrite' };
  const allowRunTests = bool('allowRunTests', existing?.allowRunTests ?? false);
  const skipIfRunning = bool('skipIfRunning', existing?.skipIfRunning ?? true);
  const enabled = bool('enabled', existing?.enabled ?? true);

  const safetyPromptRaw = b.safetyPrompt !== undefined ? b.safetyPrompt : existing?.safetyPrompt;
  if (safetyPromptRaw !== undefined && typeof safetyPromptRaw !== 'string') {
    return { error: 'safetyPrompt 必须是字符串' };
  }
  const safetyPrompt = typeof safetyPromptRaw === 'string' ? safetyPromptRaw.slice(0, 4000) : undefined;
  const dangerPatterns = Array.isArray(b.dangerPatterns)
    ? (b.dangerPatterns as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim()).slice(0, 50)
    : existing?.dangerPatterns ?? [];

  // 非敏感运行参数（**绝不含 apiKey**；Key 一律来自服务端环境变量）
  const optRaw = (b.options ?? {}) as Record<string, unknown>;
  const options: ScheduleOptions = { ...(existing?.options ?? {}) };
  if (optRaw.limits !== undefined) {
    if (!optRaw.limits || typeof optRaw.limits !== 'object' || Array.isArray(optRaw.limits)) {
      return { error: 'options.limits 必须是对象' };
    }
    // 与 POST /api/runs 共用同一套预算边界，禁止定时任务绕过（负数/超大值/字符串）。
    const parsedLimits = parseRunLimits(optRaw.limits as Record<string, unknown>);
    if (parsedLimits.error) return { error: `options.limits.${parsedLimits.error}` };
    options.limits = { ...(existing?.options.limits ?? {}), ...parsedLimits.values };
  }
  if (optRaw.llm && typeof optRaw.llm === 'object') {
    const l = optRaw.llm as Record<string, unknown>;
    const prev = existing?.options.llm ?? {};
    const provider = typeof l.provider === 'string' ? l.provider : prev.provider;
    let params = prev.params;
    if (l.params !== undefined) {
      const parsedParams = parseGenerationParams(l.params);
      if (parsedParams.error) return { error: `options.llm.params.${parsedParams.error}` };
      params = parsedParams.params;
    }
    options.llm = {
      ...prev,
      provider,
      model: typeof l.model === 'string' ? l.model.slice(0, 100) : prev.model,
      params,
    };
    if (options.llm.provider && !getPreset(options.llm.provider)) {
      return { error: `未知的 LLM Provider 预设: ${options.llm.provider}` };
    }
  }
  if (optRaw.orchestration && typeof optRaw.orchestration === 'object') {
    const o = optRaw.orchestration as Record<string, unknown>;
    const prev = existing?.options.orchestration ?? {};
    let maxWidth = prev.maxWidth;
    if (o.maxWidth !== undefined) {
      const n = Number(o.maxWidth);
      if (!Number.isInteger(n) || n < 1 || n > config.subagent.maxWidth) {
        return { error: `orchestration.maxWidth 必须是 1~${config.subagent.maxWidth} 的整数` };
      }
      maxWidth = n;
    }
    const allowedSpecs = Array.isArray(o.allowedSpecs)
      ? (o.allowedSpecs as unknown[]).filter((x): x is string => typeof x === 'string')
      : prev.allowedSpecs;
    options.orchestration = {
      ...prev,
      maxWidth,
      allowedSpecs,
      allowSelfTools: typeof o.allowSelfTools === 'boolean' ? o.allowSelfTools : prev.allowSelfTools,
      allowWriteSpecs: typeof o.allowWriteSpecs === 'boolean' ? o.allowWriteSpecs : prev.allowWriteSpecs,
      strictVerify: typeof o.strictVerify === 'boolean' ? o.strictVerify : prev.strictVerify,
    };
    if (options.orchestration.allowedSpecs) {
      const unknown = options.orchestration.allowedSpecs.filter((id) => !listSpecIds().includes(id));
      if (unknown.length) return { error: `未知的子 Agent 规格: ${unknown.join(', ')}` };
    }
  }
  if (optRaw.misc && typeof optRaw.misc === 'object') {
    const m = optRaw.misc as Record<string, unknown>;
    const st = m.subtask;
    if (st !== undefined && !['inventory', 'locate', 'read', 'lint', 'other'].includes(String(st))) {
      return { error: 'misc.subtask 只能是 inventory / locate / read / lint / other' };
    }
    options.misc = { subtask: st as ScheduleOptions['misc'] extends undefined ? never : 'inventory' | 'locate' | 'read' | 'lint' | 'other' | undefined };
  }
  if (optRaw.codex && typeof optRaw.codex === 'object') {
    const c = optRaw.codex as Record<string, unknown>;
    options.codex = {
      allowWrite: typeof c.allowWrite === 'boolean' ? c.allowWrite : undefined,
      model: typeof c.model === 'string' ? c.model.slice(0, 100) : undefined,
      safetyPrompt: typeof c.safetyPrompt === 'string' ? c.safetyPrompt.slice(0, 4000) : undefined,
      dangerPatterns: Array.isArray(c.dangerPatterns)
        ? (c.dangerPatterns as unknown[]).filter((x): x is string => typeof x === 'string')
        : undefined,
      isolateRead: typeof c.isolateRead === 'boolean' ? c.isolateRead : undefined,
      workspaceId: typeof c.workspaceId === 'string' ? c.workspaceId.slice(0, 100) : undefined,
    };
  }

  const nextRunAt =
    existing && existing.frequency === frequency && existing.runAt === runAt
      ? existing.nextRunAt
      : computeNextRunAt({ frequency, runAt }, now) ?? undefined;
  if (!nextRunAt && enabled) {
    return { error: '无法计算下次运行时间（一次性任务的 runAt 已过去？）' };
  }

  const nameRaw = b.name !== undefined ? b.name : existing?.name;
  const name =
    typeof nameRaw === 'string' && nameRaw.trim()
      ? nameRaw.trim().slice(0, 200)
      : `${agent} · ${goal.slice(0, 40)}`;

  const record: ScheduleRecord = {
    id: existing?.id ?? `sch_${randomUUID().slice(0, 8)}`,
    name,
    agent,
    goal,
    repoPath,
    frequency,
    runAt,
    enabled,
    allowWrite,
    autoApprove,
    safetyPrompt,
    dangerPatterns,
    allowRunTests,
    skipIfRunning,
    options,
    nextRunAt,
    lastRunAt: existing?.lastRunAt,
    lastRunId: existing?.lastRunId,
    lastStatus: existing?.lastStatus,
    lastError: existing?.lastError,
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
  return { record };
}

export function createApp(config: RuntimeConfig) {
  assertHttpSecurity(config);
  const { store, runtime, hub, logger, registry, errors, knowledge, verification, recovery, pendingActions } = buildRuntime(config);

  // 定时任务：只在这里组装，由 src/index.ts 显式 start()（测试/演示不触发真实 run）。
  const scheduler = new SchedulerService({
    store,
    enqueue: (input) => {
      if (input.runType === 'codex') return runtime.enqueue(input);
      return runtime.enqueue(input, createProvider(config, input).provider);
    },
    log: (msg) => console.log(msg),
  });

  // MCP 客户端（Streamable HTTP）：默认关闭；配置了 MTA_MCP_SERVERS 才连接。
  // 单个 server 失败只标 error，不阻塞 HTTP 服务；工具名回填后由 AgentRuntime 按 runType 暴露。
  const mcpRuntime = new McpClientRuntime(
    config.mcp.servers,
    registry,
    errors,
    (names) => { config.mcp.toolNames = names; },
  );
  void mcpRuntime.start();
  // 待确认 MCP 操作：用户确认后直接走已连接 client，不再重复审批。
  pendingActions.setMcpExecutor(async (call) => mcpRuntime.callTool(call.server, call.tool, call.args));

  /** 从 run_started 事件里取仓库路径（RunRecord 不持久化 repoPath；事件是唯一真值） */
  const repoPathOfRun = (runId: string): string | null => {
    const ev = store.getEvents(runId).find((e) => e.type === 'run_started');
    const repo = (ev?.data?.inputs as Record<string, unknown> | undefined)?.repoPath;
    return typeof repo === 'string' && existsSync(repo) ? repo : null;
  };

  // MCP over Streamable HTTP：与 stdio 共用同一个 McpServer 实现。
  const mcp = new McpServer({
    name: 'multi-tool-agent',
    version: '0.1.0',
    instructions: '只读知识库工具：kb_search / knowledge_stats。',
  });
  mcp.registerTool({
    name: 'kb_search',
    description: '在知识库中做切块级混合检索（BM25 + 向量 + RRF/rerank，只读）。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索问题' },
        limit: { type: 'number', description: '返回条数，默认 10' },
        collection: { type: 'string', description: '可选：限定 collection' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const query = String(args.query ?? '').trim();
      if (!query) throw new Error('query 不能为空');
      const limit = Math.max(1, Math.min(50, Number(args.limit ?? 10) || 10));
      const collection = typeof args.collection === 'string' ? args.collection : undefined;
      // 与 Agent 的 knowledge_search 共用同一条 RAG 管线（不再走旧的 FTS5+sqlite-vec 混合）。
      const result = await knowledge.searchRag(query, {
        k: limit,
        filter: collection ? (m) => m.collection === collection : undefined,
      });
      return {
        query,
        mode: result.mode,
        count: result.results.length,
        hits: result.results.map((h) => ({
          chunkId: h.chunkId,
          docId: h.docId,
          title: h.title,
          heading: h.heading,
          chunkIndex: h.chunkIndex,
          score: h.normalizedScore,
          sources: h.sources,
          text: h.text.slice(0, 4000),
        })),
      };
    },
  });
  mcp.registerTool({
    name: 'knowledge_stats',
    description: '返回知识库/向量层统计（只读）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => knowledge.stats(),
  });

  // 装配期契约自校验：spec 与工具表不一致属于配置错误，必须显式暴露（而不是运行时才发现）
  const toolPolicy = registry.policySnapshot();
  const specIssues = validateSpecs(SUB_AGENT_SPECS, TOOL_PERMISSION, registry.names(), {
    maxStepsHardLimit: 20,
    toolPermissionByName: toolPolicy.permissions,
    toolRiskLevel: toolPolicy.riskLevels,
  });
  const specErrors = specIssues.filter((i) => i.level === 'error');
  if (specErrors.length) {
    for (const issue of specErrors) console.error(`[agents] 契约错误 ${issue.specId}: ${issue.message}`);
  }
  for (const issue of specIssues.filter((i) => i.level === 'warn')) {
    console.warn(`[agents] 契约提醒 ${issue.specId}: ${issue.message}`);
  }
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  // 基础安全响应头：不引入 CSP（当前 UI 是内联脚本/样式，CSP 需要先改造构建）。
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Robots-Tag', 'noindex');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // 浏览器错误上报是无需认证也可到达的写入口（health 之外），单独限流。
  const clientErrorLimiter = new FixedWindowLimiter(config.clientErrorsPerMinute);
  const streamState = { connections: 0, droppedEphemeral: 0 };

  // 认证中间件（可选）：只有配置 MTA_AUTH_TOKEN 时启用。
  // 默认 host=127.0.0.1；一旦监听非回环地址，assertHttpSecurity 会强制要求 token。
  // 浏览器首次可用 `/?token=<token>` 引导写入 HttpOnly Cookie，之后同源 fetch 自动携带。
  if (config.authToken) {
    app.use((req, res, next) => {
      const token = config.authToken!;
      if (req.path === '/api/health') return next();

      // 浏览器引导：token 只出现在一次 GET /?token=... 中，随后写 Cookie 并重定向。
      if (req.method === 'GET' && req.path === '/' && typeof req.query.token === 'string') {
        if (!tokenMatches(req.query.token, token)) {
          return res.status(401).json({ error: '无效的访问 token' });
        }
        res.cookie('mta_token', token, {
          httpOnly: true,
          sameSite: 'strict',
          secure: false,
          maxAge: 30 * 24 * 60 * 60 * 1000,
          path: '/',
        });
        return res.redirect(302, '/');
      }

      const provided =
        bearerToken(req.headers.authorization) ??
        (typeof req.headers['x-mta-token'] === 'string' ? req.headers['x-mta-token'] : undefined) ??
        cookieValue(req.headers.cookie, 'mta_token');

      if (provided && tokenMatches(provided, token)) return next();

      if (req.path.startsWith('/api/') || req.path === '/mcp') {
        res.setHeader('WWW-Authenticate', 'Bearer');
        return res.status(401).json({ error: '需要认证：Authorization: Bearer <MTA_AUTH_TOKEN>' });
      }
      return next();
    });
  }

  app.get('/api/health', (_req, res) => {
    const db = store.ping();
    const mcp = mcpRuntime.status();
    const rag = knowledge.ragStatus();
    const sch = scheduler.status();
    const warnings: string[] = [];
    if (!db.ok) warnings.push('db');
    const mcpErrors = mcp.servers.filter((s) => s.state === 'error').map((s) => s.name);
    if (mcpErrors.length) warnings.push(`mcp:${mcpErrors.join(',')}`);
    if (sch.lastError) warnings.push('scheduler');
    res.status(db.ok ? 200 : 503).json({
      ok: db.ok,
      degraded: warnings.length > 0,
      warnings,
      llmMode: config.llmMode,
      mockDefault: config.llmMode === 'mock',
      components: {
        db,
        mcp: {
          configured: mcp.configured,
          ready: mcp.ready,
          connecting: mcp.connecting,
          toolCount: mcp.toolCount,
          errors: mcpErrors,
        },
        rag: {
          built: rag.built,
          indexing: rag.indexing,
          backgroundIndex: rag.backgroundIndex,
          docs: rag.cache?.docs ?? 0,
        },
        scheduler: sch,
      },
      stream: {
        liveDeltas: config.stream.liveDeltas,
        mockChunkDelayMs: config.stream.mockChunkDelayMs,
        heartbeatMs: config.stream.heartbeatMs,
        watchdogMs: config.stream.watchdogMs,
      },
    });
  });

  const parseRetentionDays = (raw: unknown, fallback: number): number | null => {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : null;
  };

  /** 数据保留概览（只读，不删除任何东西）。 */
  app.get('/api/maintenance', (req, res) => {
    const days = parseRetentionDays(req.query.days, config.dataRetentionDays);
    if (days === null) return res.status(400).json({ error: 'days 必须是 1~3650 的整数' });
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const candidates = store.pruneRunsOlderThan(cutoff, { dryRun: true });
    const sizeOf = (p: string): number => {
      try {
        return existsSync(p) ? statSync(p).size : 0;
      } catch {
        return 0;
      }
    };
    res.json({
      retentionDays: days,
      cutoff,
      candidates,
      files: {
        dbBytes: config.sqlitePath === ':memory:' ? 0 : sizeOf(config.sqlitePath),
        dbWalBytes: config.sqlitePath === ':memory:' ? 0 : sizeOf(`${config.sqlitePath}-wal`),
        errorLogBytes: sizeOf(config.log.errorLogPath),
        errorLogBackupBytes: sizeOf(`${config.log.errorLogPath}.1`),
      },
      note: '候选只含终态 run，且跳过 awaiting_user、仍有待确认操作、被定时任务引用的记录；删除必须显式 confirm:true。',
    });
  });

  /** 手动清理旧 run（数据保留）。默认只算候选；确认后才删。 */
  app.post('/api/maintenance/prune', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.confirm !== true) return res.status(400).json({ error: '必须显式带 confirm:true 才能清理数据' });
    const days = parseRetentionDays(b.olderThanDays, config.dataRetentionDays);
    if (days === null) return res.status(400).json({ error: 'olderThanDays 必须是 1~3650 的整数' });
    const limitRaw = b.limit === undefined ? 5000 : Number(b.limit);
    if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 50_000) {
      return res.status(400).json({ error: 'limit 必须是 1~50000 的整数' });
    }
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const deleted = store.pruneRunsOlderThan(cutoff, { limit: limitRaw });
    res.json({ ok: true, cutoff, olderThanDays: days, deleted });
  });

  /**
   * 非敏感的默认配置（供前端预填与展示）。
   * 绝不返回任何 Key 本身，只返回「是否已配置」。
   */
  app.get('/api/config', (_req, res) => {
    res.json({
      llmMode: config.llmMode,
      hasOpenAIKey: !!config.openai.apiKey,
      openaiBaseUrl: config.openai.baseUrl,
      openaiModel: config.openai.model,
      // LLM 预设默认值（前端下拉框的初始选择；不含任何 Key）
      llmPresetId: config.llm.presetId,
      llmParams: config.llm.params,
      hasLlmKey: !!(config.llm.apiKey || config.openai.apiKey),
      searchProvider: config.search.provider,
      hasSearchKey: !!config.search.apiKey,
      searchBaseUrl: config.search.baseUrl,
      runTestsEnabled: config.codebase.runTestsEnabled,
      // 写能力（M1'）：供前端同步「允许修改文件」开关的可用性（false = 被部署配置显式禁用）
      writeEnabled: config.codebase.writeEnabled,
      stream: {
        liveDeltas: config.stream.liveDeltas,
        mockChunkDelayMs: config.stream.mockChunkDelayMs,
        heartbeatMs: config.stream.heartbeatMs,
        watchdogMs: config.stream.watchdogMs,
        debug: config.stream.debug,
      },
    });
  });

  /**
   * LLM 预设目录 + 参数元数据（供前端渲染下拉框/滑杆与说明文案）。
   * 只回传「Key 是否已在环境变量里配置」，**绝不回传 Key 本身**。
   */
  app.get('/api/llm/presets', (_req, res) => {
    res.json({
      presets: LLM_PRESETS.map((p) => ({
        ...p,
        // 环境变量里是否已有 Key（只给布尔值）
        envKeyConfigured: p.keyOptional ? true : !!getEnv(p.apiKeyEnv),
      })),
      params: PARAM_META,
      current: {
        presetId: config.llm.presetId,
        mode: config.llmMode,
        params: config.llm.params,
        model: config.openai.model,
        baseUrl: config.openai.baseUrl,
      },
    });
  });

  /**
   * 测试连接：用提交的 Key / Base URL / 模型真实发一次请求，验证配置是否可用。
   * 安全：目标地址做 SSRF 防护（允许回环以便本地模型服务，禁止云元数据与其它私网）；
   *       响应与日志都不会包含 Key 本身。
   */
  app.post('/api/llm/test', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const presetId = typeof body.provider === 'string' ? body.provider : config.llm.presetId;
    const preset = getPreset(presetId);
    const baseUrlRaw =
      str(body.baseUrl) ?? preset?.baseUrl ?? config.openai.baseUrl;
    const apiKey =
      str(body.apiKey) ?? config.llm.apiKey ?? (preset?.apiKeyEnv ? getEnv(preset.apiKeyEnv) || undefined : undefined) ?? config.openai.apiKey;
    const model = str(body.model) ?? preset?.defaultModel ?? preset?.models[0]?.id ?? config.openai.model;

    if (!baseUrlRaw) {
      return res.status(400).json({ ok: false, detail: '缺少 Base URL（选择「自定义」时必须填写）' });
    }

    const result = await testLlmConnection({
      baseUrl: baseUrlRaw,
      apiKey: preset?.keyOptional ? apiKey || 'not-needed' : apiKey,
      model,
      allowChatFallback: body.allowChatFallback !== false,
    });
    res.status(result.ok ? 200 : 502).json({
      ...result,
      target: { presetId, baseUrl: normalizeBaseUrl(baseUrlRaw), model, hasKey: !!apiKey },
    });
  });

  /**
   * 任务分流建议（规则式、不调用 LLM）：前端「自动分流」与「一键改派」都用它。
   * 纯函数 classifyTask，可离线单测；返回 runType + 置信度 + 理由 + 命中信号词。
   */
  app.get('/api/task-router', (req, res) => {
    const goal = typeof req.query.goal === 'string' ? req.query.goal : '';
    if (!goal.trim()) return res.status(400).json({ error: '缺少 goal 参数' });
    const allowMisc = req.query.allowMisc !== '0';
    const routing = classifyTask(goal, { allowMisc });
    const preview = req.query.preview === '1';
    // 编排建议：规则式预筛（只有建议交给编排时才产出，避免无关噪音）
    let suggestedSubtasks: unknown[] = [];
    let orchestrationAdvice: OrchestrationGate | undefined;
    let runType = routing.runType;
    let reason = routing.reason;
    const repoPath = typeof req.query.repoPath === 'string' ? req.query.repoPath.trim() : '';
    if (routing.runType === 'orchestrator' || req.query.preview === '1') {
      const abs = repoPath && existsSync(resolve(repoPath)) ? resolve(repoPath) : null;
      const dirs = abs ? pickTopLevelDirs(abs) : [];
      suggestedSubtasks = preSplitSubtasks(goal, {
        dirs,
        topics: extractTopics(goal),
        maxWidth: config.subagent.maxWidth,
      });
      const facts = abs ? scanRepoFacts(abs) : null;
      orchestrationAdvice = adviseOrchestration(goal, facts, { tokenBudget: config.limits.tokenBudget });
      // 自动分流路径：单上下文装得下就降为 codebase；preview=1 只展示建议、不改变结果。
      if (routing.runType === 'orchestrator' && !preview && orchestrationAdvice.recommend === 'single') {
        runType = 'codebase';
        reason = `${routing.reason}；编排预筛：${orchestrationAdvice.reason}`;
      }
    }
    res.json({ ...routing, runType, reason, suggestedSubtasks, ...(orchestrationAdvice ? { orchestrationAdvice } : {}) });
  });

  /**
   * 子 Agent 契约目录（供前端展示与 lint 使用）。**单一事实来源 = src/agents/specs.ts**；
   * `agents/*.agent.md` 由 `npm run agents:docs` 从同一份契约生成，两者由 `npm run agents:lint` 校验一致。
   */
  app.get('/api/agents/specs', (_req, res) => {
    const toolPolicy = registry.policySnapshot();
    const issues = validateSpecs(SUB_AGENT_SPECS, TOOL_PERMISSION, registry.names(), {
      maxStepsHardLimit: 20,
      toolPermissionByName: toolPolicy.permissions,
      toolRiskLevel: toolPolicy.riskLevels,
    });
    res.json({
      specs: SUB_AGENT_SPECS.map((sp) => ({
        id: sp.id,
        title: sp.title,
        responsibilities: sp.responsibilities,
        notDo: sp.notDo,
        tools: sp.tools,
        permissions: sp.permissions,
        budget: sp.budget,
        escalateTo: sp.escalateTo,
        examples: sp.examples,
        requiredInputs: sp.requiredInputs ?? [],
        modelParams: sp.modelParams ?? {},
      })),
      limits: config.subagent,
      orchestrator: config.orchestrator,
      /** 契约自校验结果（装配期检查；有 error 说明 spec 与工具表不一致） */
      issues,
    });
  });

  app.post('/api/runs', async (req, res) => {
    // 首启时给 MCP 一个有界等待窗口：连上就带工具跑，超时/失败则先跑（status 可查）。
    await mcpRuntime.ready().catch(() => {});
    const { input, error } = validateRunRequest((req.body ?? {}) as Record<string, unknown>, config);
    if (error || !input) {
      return res.status(400).json({ error: error ?? '请求无效' });
    }

    let runId: string;
    let resolved: unknown;
    try {
      // Codex 直连不走内置 LLM：不解析 Provider（也不因缺 Key 被拦）。
      if (input.runType === 'codex') {
        runId = runtime.enqueue(input);
      } else {
        // 先在服务端解析预设与参数（含「无 Key 不静默降级」等校验），再入队执行。
        const bundle = createProvider(config, input);
        resolved = bundle.resolved;
        runId = runtime.enqueue(input, bundle.provider);
      }
    } catch (e) {
      // 例如 createProvider 在校验失败时抛错
      const msg = (e as Error).message;
      if (msg.startsWith('TOO_MANY_ACTIVE_RUNS')) return res.status(429).json({ error: msg });
      return res.status(400).json({ error: `创建任务失败: ${msg}` });
    }
    res.status(201).json({
      runId,
      runType: input.runType,
      goal: input.goal,
      llm: resolved,
      // 杂项任务回显实际生效的边界（让用户知道这次用了多小的预算）
      ...(input.runType === 'misc'
        ? {
            miscLimits: {
              maxSteps: input.maxSteps ?? config.misc.maxSteps,
              maxModelCalls: input.maxModelCalls ?? config.misc.maxModelCalls,
              maxToolCalls: input.maxToolCalls ?? config.misc.maxToolCalls,
              tokenBudget: input.tokenBudget ?? config.misc.tokenBudget,
              hardMaxSteps: config.misc.hardMaxSteps,
              scanLimit: input.misc?.scanLimit ?? config.misc.scanLimit,
              maxFileBytes: input.misc?.maxFileBytes ?? config.misc.maxFileBytes,
              // 与执行期共用同一份工具池定义（含已就绪的 MCP 工具），避免回显漂移。
              allowedTools: toolPoolFor('misc', {
                runTestsEnabled: false,
                allowSelfTools: false,
                mcpTools: config.mcp.toolNames,
              }).filter((t) => registry.has(t)),
            },
          }
        : {}),
      ...(input.runType === 'orchestrator' && input.orchestration?.gate
        ? { orchestrationGate: input.orchestration.gate }
        : {}),
    });
  });

  /** MCP 客户端状态（安全视图：不含 token；未配置时 configured=0）。 */
  app.get('/api/mcp', (_req, res) => {
    res.json(mcpRuntime.status());
  });

  /**
   * 手动重连 MCP（T4）：远端 server 重启/升级后，不必重启本进程。
   * body 空对象 = 全部重连；{ name } = 只重连一个。失败仍按 server 隔离。
   */
  app.post('/api/mcp/reconnect', async (req, res) => {
    const raw = (req.body ?? {}) as { name?: unknown };
    if (raw.name !== undefined && (typeof raw.name !== 'string' || !raw.name.trim())) {
      return res.status(400).json({ error: 'name 必须是字符串（省略 = 全部重连）' });
    }
    const name = typeof raw.name === 'string' ? raw.name.trim() : undefined;
    try {
      const status = await mcpRuntime.reconnect(name);
      res.json(status);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      res.status(message.startsWith('未配置 MCP server') ? 404 : 500).json({ error: message });
    }
  });

  /**
   * 子任务历史（T7 轻量版）：按 spec 聚合成功率/耗时/token，默认排除 Mock。
   * 数据源是 runs.resultJson（Runtime 已累积每次 run 的全部子任务），不需要新表。
   */
  app.get('/api/subtasks/stats', (req, res) => {
    const limit = Math.max(1, Math.min(5000, Number(req.query.limit ?? 500) || 500));
    const includeMock = ['1', 'true'].includes(String(req.query.includeMock ?? ''));
    res.json(aggregateSubtaskStats(store.listRuns(limit), { includeMock }));
  });

  app.get('/api/runs/:id', (req, res) => {
    const rec = store.getRun(req.params.id);
    if (!rec) return res.status(404).json({ error: '任务不存在' });
    res.json(recordToResult(rec));
  });

  /**
   * 事件查询（持久化事件）。支持增量拉取：?fromSeq=N&limit=M
   * 响应头 X-Next-Cursor 返回本批最后一条的 seq，供轮询兜底使用。
   */
  /**
   * 单 run 报告（流程图 + 分层量化 + 六阶段归因）——按需生成，**不落盘**。
   * 落盘版走 `npm run report:run`（写 reports/runs/）；这里返回同一份内容，便于前端/脚本直接取。
   * format=md → text/markdown；默认 → JSON（meta + markdown）。
   */
  app.get('/api/runs/:id/report', (req, res) => {
    const rec = store.getRun(req.params.id);
    if (!rec) return res.status(404).json({ error: '任务不存在' });
    const { markdown, meta } = buildRunReport({
      run: toReportRun(rec),
      events: store.getEvents(req.params.id),
      generatedAt: new Date().toISOString(),
    });
    if (String(req.query.format ?? '') === 'md') {
      res.type('text/markdown; charset=utf-8').send(markdown);
      return;
    }
    res.json({ meta, markdown, reportCount: listRunReportMetas(resolve('reports/runs')).length });
  });

  /**
   * 单个 run 的复盘摘要（**每次终态都有**，成功也写）。
   * 与 `/report` 的分工：report 是按需渲染的长报告（流程图/Mermaid）；digest 是终态那一刻
   * 自动落库的短摘要（结论 + 过程问题聚合 + 首个问题），可直接喂给列表/告警。
   */
  app.get('/api/runs/:id/digest', (req, res) => {
    if (!store.getRun(req.params.id)) return res.status(404).json({ error: '任务不存在' });
    const digest = store.getRunDigest(req.params.id);
    if (!digest) return res.status(404).json({ error: '该任务还没有复盘摘要（可能产生于本功能上线前）' });
    res.json(digest);
  });

  /**
   * 复盘摘要列表（按结束时间倒序）。
   * `?onlyProblems=1` → 只看「非 completed 或过程有错误」的 run（默认复盘视角）；
   * `?status=failed` / `?runType=orchestrator` / `?limit=20` 可组合。
   */
  app.get('/api/digests', (req, res) => {
    const q = req.query as Record<string, unknown>;
    const onlyProblems = String(q.onlyProblems ?? '') === '1' || String(q.onlyProblems ?? '') === 'true';
    const digests = store.listRunDigests({
      status: typeof q.status === 'string' ? q.status : undefined,
      runType: typeof q.runType === 'string' ? q.runType : undefined,
      onlyProblems,
      limit: Number(q.limit ?? 50) || 50,
    });
    res.json({ count: digests.length, onlyProblems, digests });
  });

  app.get('/api/runs/:id/events', (req, res) => {
    const rec = store.getRun(req.params.id);
    if (!rec) return res.status(404).json({ error: '任务不存在' });
    const fromSeq = Math.max(0, Number(req.query.fromSeq ?? 0) || 0);    const limitRaw = Number(req.query.limit ?? 1000);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, Math.floor(limitRaw))) : 1000;
    const list = store.getEvents(req.params.id).filter((e) => e.seq > fromSeq);
    const page = list.slice(0, limit);
    res.setHeader('X-Next-Cursor', String(page.length ? page[page.length - 1].seq : fromSeq));
    res.setHeader('X-Remaining', String(Math.max(0, list.length - page.length)));
    res.json(page);
  });

  // 聚合 trace 快照：span 列表（含耗时/状态/输入输出）+ 根 + 摘要，供瀑布图 / 流程图直接消费
  app.get('/api/runs/:id/trace', (req, res) => {
    const rec = store.getRun(req.params.id);
    if (!rec) return res.status(404).json({ error: '任务不存在' });
    const events = store.getEvents(req.params.id);
    res.json(buildTraceSnapshot(req.params.id, rec.status, events));
  });

  /** 慢回答诊断：模型/工具/空转占比 + token 热点 + 建议 */
  app.get('/api/runs/:id/diagnosis', (req, res) => {
    const rec = store.getRun(req.params.id);
    if (!rec) return res.status(404).json({ error: '任务不存在' });
    res.json(diagnoseRun(store.getEvents(req.params.id), rec));
  });

  app.post('/api/runs/:id/cancel', (req, res) => {
    const ok = runtime.cancel(req.params.id);
    res.json({ cancelled: ok });
  });

  app.post('/api/runs/:id/resume', (req, res) => {
    try {
      const result = runtime.resume(req.params.id, req.body?.raiseLimits !== false);
      // resume 为异步但未 await（HTTP 即时返回）；结果通过轮询获取
      res.json({ resumed: true, runId: req.params.id });
      // 防御性 catch 对齐 enqueue：resume 内部已显式 .catch，这里再兜底一次，
      // 确保任何残余 rejection 都不会因 `void` 变成 unhandledRejection 拖垮进程。
      result.catch((e) => {
        errors.report({
          source: 'server',
          phase: 'route:POST /api/runs/:id/resume',
          error: e,
          code: 'RESUME_REJECTION',
          runId: req.params.id,
        });
      });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  /**
   * M1 写能力：审批决定（三选一：allow_file 完全同意此文件 / allow_once 仅同意本次 / deny 拒绝）。
   * 删除 / 宿主命令批次批准时必须额外带 confirmHighRisk=true；该门禁在 HTTP 与 Runtime
   * 两层都执行，前端禁用按钮不是安全边界。与 cancel/resume 对称的普通 POST。
   */
  app.post('/api/runs/:id/approvals/:approvalId', (req, res) => {
    const b = (req.body ?? {}) as { decision?: string; reason?: string; actor?: string; confirmHighRisk?: boolean };
    const value = b.decision as ApprovalDecisionValue | undefined;
    if (value !== 'allow_file' && value !== 'allow_once' && value !== 'deny') {
      res.status(400).json({ error: `decision 必须是 allow_file | allow_once | deny（收到: ${String(b.decision)}）` });
      return;
    }
    const pending = runtime.getPendingApproval(req.params.id, req.params.approvalId);
    if (!pending) {
      res.status(404).json({ error: '审批不存在或已决定（可能已超时按拒绝处理）' });
      return;
    }
    const highRisk = pending.highRisk === true || pending.requiresExplicitConfirmation === true;
    if (highRisk && value !== 'deny' && b.confirmHighRisk !== true) {
      res.status(400).json({
        error: '该批次含删除或宿主命令，批准前必须完成当前批次的二次确认',
        code: 'HIGH_RISK_CONFIRMATION_REQUIRED',
        reasons: pending.riskReasons ?? [],
      });
      return;
    }
    const d = runtime.decideApproval(req.params.id, req.params.approvalId, value, {
      reason: typeof b.reason === 'string' ? b.reason.slice(0, 2000) : undefined,
      actor: typeof b.actor === 'string' ? b.actor.slice(0, 80) : undefined,
      confirmHighRisk: b.confirmHighRisk === true,
    });
    if (!d) {
      res.status(404).json({ error: '审批不存在或已决定（可能已超时按拒绝处理）' });
      return;
    }
    res.json({ ok: true, decision: d });
  });

  /** M1：挂起中的审批 + diff 全文（前端刷新后重建待批卡；评审 P1-6：diff 走这里拉，不进事件流） */
  app.get('/api/runs/:id/approvals', (req, res) => {
    const pending = runtime.listPendingApprovals(req.params.id).map((r) => ({
      ...r,
      files: r.files.map((f) => {
        let diff = '';
        try {
          diff = readFileSync(f.diffPath, 'utf8');
        } catch {
          diff = '（diff 文件不可读：可能已被清理）';
        }
        return { ...f, diff };
      }),
    }));
    res.json({
      runId: req.params.id,
      count: pending.length,
      pending,
      stickyFiles: runtime.getStickyFiles(req.params.id),
    });
  });

  /**
   * 待确认高危操作（定时任务无人值守时暂缓的删除/命令）。
   * 执行必须显式 confirm:true；删除会复核 baseHash，命令会在宿主执行并回写事件。
   */
  app.get('/api/pending-actions', (req, res) => {
    const statusRaw = typeof req.query.status === 'string' ? req.query.status : '';
    const status = ['pending', 'executed', 'dismissed', 'failed'].includes(statusRaw)
      ? (statusRaw as 'pending' | 'executed' | 'dismissed' | 'failed')
      : undefined;
    const limit = Number(req.query.limit);
    const actions = pendingActions.list({
      status,
      runId: typeof req.query.runId === 'string' ? req.query.runId : undefined,
      scheduleId: typeof req.query.scheduleId === 'string' ? req.query.scheduleId : undefined,
      limit: Number.isFinite(limit) ? limit : 100,
    });
    res.json({ count: actions.length, actions });
  });

  app.post('/api/pending-actions/:id/execute', async (req, res) => {
    if ((req.body as any)?.confirm !== true) {
      return res.status(400).json({ error: '必须显式带 confirm:true 才能执行高危操作' });
    }
    const r = await pendingActions.execute(req.params.id, { confirm: true });
    res.status(r.ok ? 200 : 400).json(r);
  });

  app.post('/api/pending-actions/:id/dismiss', (req, res) => {
    const r = pendingActions.dismiss(req.params.id);
    res.status(r.ok ? 200 : 400).json(r);
  });

  /**
   * 手动 L2 深度验证（终态 run）：异步跑宿主全量测试，状态经 GET 查询。
   * 这是落盘后 hostVerify 的可重复版本——给用户「改完后再确认一次」的入口。
   */
  app.post('/api/runs/:id/verify', (req, res) => {
    const rec = store.getRun(req.params.id);
    if (!rec) return res.status(404).json({ error: '任务不存在' });
    if (!TERMINAL_RUN_STATUS.has(rec.status)) {
      return res.status(409).json({ error: `任务尚未结束（status=${rec.status}）：请等 run 进入终态后再发起深度验证` });
    }
    const repoPath = repoPathOfRun(req.params.id);
    if (!repoPath) {
      return res.status(400).json({ error: '该任务没有可验证的仓库（run_started 里没有 repoPath，或目录已不存在）' });
    }
    const r = verification.start(req.params.id, repoPath);
    if (!r.ok) {
      return res.status(409).json({ error: '已有一个深度验证在排队/运行', job: r.job });
    }
    res.status(202).json({ job: r.job });
  });

  app.get('/api/runs/:id/verification', (req, res) => {
    const rec = store.getRun(req.params.id);
    if (!rec) return res.status(404).json({ error: '任务不存在' });
    res.json({ runId: req.params.id, job: verification.get(req.params.id) });
  });

  app.post('/api/runs/:id/verification/cancel', (req, res) => {
    const rec = store.getRun(req.params.id);
    if (!rec) return res.status(404).json({ error: '任务不存在' });
    res.json(verification.cancel(req.params.id));
  });

  /**
   * 崩溃对账（启动扫描的结果 / 手动回滚）。
   * 只对「被中断」的 run 生效：正常完成的任务，已落盘就是审批后的预期结果，不当作垃圾。
   */
  app.get('/api/recovery', async (_req, res) => {
    try {
      res.json({ reports: await recovery.list() });
    } catch (e) {
      res.status(500).json({ error: `读取恢复报告失败：${(e as Error).message}` });
    }
  });

  app.get('/api/runs/:id/recovery', async (req, res) => {
    try {
      const rec = store.getRun(req.params.id);
      if (!rec) return res.status(404).json({ error: '任务不存在' });
      res.json({ runId: req.params.id, report: await recovery.inspect(req.params.id) });
    } catch (e) {
      res.status(500).json({ error: `对账失败：${(e as Error).message}` });
    }
  });

  app.post('/api/runs/:id/recovery/rollback', async (req, res) => {
    try {
      const rec = store.getRun(req.params.id);
      if (!rec) return res.status(404).json({ error: '任务不存在' });
      const r = await recovery.rollback(req.params.id);
      if (!r.ok) return res.status(409).json({ error: r.error, report: r.report });
      res.json(r);
    } catch (e) {
      res.status(500).json({ error: `回滚失败：${(e as Error).message}` });
    }
  });

  app.post('/api/runs/:id/recovery/accept', async (req, res) => {
    try {
      const rec = store.getRun(req.params.id);
      if (!rec) return res.status(404).json({ error: '任务不存在' });
      const r = await recovery.accept(req.params.id);
      if (!r.ok) return res.status(409).json({ error: r.error });
      res.json(r);
    } catch (e) {
      res.status(500).json({ error: `保留失败：${(e as Error).message}` });
    }
  });

  app.get('/api/runs', (_req, res) => {
    res.json(store.listRuns(50).map((r) => recordToResult(r)));
  });
  // ---------------------------------------------------------------------------
  // SSE 实时事件流（实时流式展示的传输层）
  // 三段式：① 回放已持久化事件（支持 Last-Event-ID 断线续传）
  //        ② 订阅 LiveHub 实时快车道（毫秒级，不等落盘）
  //        ③ 看门狗轮询补漏 + 终态收尾；心跳保持连接
  // ---------------------------------------------------------------------------
  app.get('/api/runs/:id/stream', (req, res) => {
    const id = req.params.id;
    const rec0 = store.getRun(id);
    if (!rec0) return res.status(404).json({ error: '任务不存在' });
    if (streamState.connections >= config.stream.maxConnections) {
      res.setHeader('Retry-After', '5');
      return res.status(429).json({ error: `SSE 连接数已达上限 ${config.stream.maxConnections}，请关闭闲置页面后重试` });
    }
    streamState.connections += 1;
    let counted = true;

    const debug = req.query.debug === '1' || config.stream.debug;
    const fromRaw = Number(req.headers['last-event-id'] ?? req.query.fromSeq ?? 0);
    const fromSeq = Number.isFinite(fromRaw) && fromRaw > 0 ? Math.floor(fromRaw) : 0;

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // 关闭 nginx 等反代的响应缓冲
    res.flushHeaders?.();
    res.write('retry: 1000\n\n');

    let lastSeq = fromSeq;
    let closed = false;
    let frames = 0;
    let heartbeats = 0;
    let dedupedFrames = 0;
    let replayCount = 0;
    let backpressured = false;
    let drainBound = false;
    const openedAt = Date.now();
    // 提前声明为 no-op，避免 cleanup 在变量初始化前被触发（TDZ）
    let unsubscribe: () => void = () => {};
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let watchdogTimer: ReturnType<typeof setInterval> | undefined;

    const log = (msg: string) => {
      if (debug) console.log(`[sse] run=${id} ${msg}`);
    };

    const write = (chunk: string): boolean => {
      if (closed) return false;
      try {
        const ok = res.write(chunk);
        if (!ok) {
          // 客户端消费慢：先丢弃后续 ephemeral（llm_delta），持久化事件仍按序写。
          backpressured = true;
          if (!drainBound) {
            drainBound = true;
            res.once('drain', () => { backpressured = false; drainBound = false; });
          }
        }
        return true;
      } catch {
        cleanup();
        return false;
      }
    };

    /** SSE 帧：id 只对持久化事件设置（ephemeral 事件不参与断线续传） */
    const toFrame = (e: Record<string, unknown> & { seq?: number; ephemeral?: boolean }): string => {
      const idLine = !e.ephemeral && typeof e.seq === 'number' && e.seq > 0 ? `id: ${e.seq}\n` : '';
      return `${idLine}data: ${JSON.stringify(e)}\n\n`;
    };

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (counted) {
        counted = false;
        streamState.connections = Math.max(0, streamState.connections - 1);
      }
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (watchdogTimer) clearInterval(watchdogTimer);
      unsubscribe();
      try {
        res.end();
      } catch {
        /* ignore */
      }
      log(
        `closed frames=${frames} heartbeats=${heartbeats} replay=${replayCount} dedup=${dedupedFrames} uptimeMs=${Date.now() - openedAt}`,
      );
    };

    /** 发送终态帧并关闭连接 */
    const finishRun = () => {
      if (closed) return;
      const rec = store.getRun(id);
      write(`data: ${JSON.stringify({ type: 'run_end', status: rec?.status ?? 'unknown', runId: id })}\n\n`);
      log(`run_end status=${rec?.status}`);
      cleanup();
    };

    /** 处理一个事件（回放 / 实时 / 补漏共用）：去重 → 写帧 → 终态收尾 */
    const handleEvent = (e: TraceEvent) => {
      if (closed) return;
      if (!e.ephemeral) {
        if (typeof e.seq === 'number' && e.seq > 0) {
          if (e.seq <= lastSeq) {
            dedupedFrames += 1; // 去重（实时推送与看门狗补漏可能重叠）
            return;
          }
          lastSeq = e.seq;
        }
      }
      if (e.ephemeral && backpressured) {
        streamState.droppedEphemeral += 1;
        return;
      }
      frames += 1;
      write(toFrame(e as unknown as Record<string, unknown>));
      if (TERMINAL_EVENT_TYPES.has(e.type)) finishRun();
    };

    /** 实时帧：附带服务端推送时间戳（调试用，可算出「事件产生 → 推送」延迟） */
    const handleLive = (e: TraceEvent) => {
      if (closed) return;
      const at = Date.now();
      const wrapped = { ...e, _sentTs: at, _pushDelayMs: at - Date.parse(e.timestamp) };
      handleEvent(wrapped as unknown as TraceEvent);
    };

    // ① + ②：先订阅（避免回放与订阅之间的空窗丢事件），再同步回放（无 await，不会乱序）
    unsubscribe = hub.subscribe(id, handleLive);
    write(
      `data: ${JSON.stringify({
        type: '_stream_meta',
        runId: id,
        resumedFrom: fromSeq,
        heartbeatMs: config.stream.heartbeatMs,
        watchdogMs: config.stream.watchdogMs,
        liveDeltas: config.stream.liveDeltas,
        debug,
      })}\n\n`,
    );
    for (const e of store.getEvents(id)) {
      if (e.seq <= lastSeq) continue;
      replayCount += 1;
      handleEvent(e);
      if (closed) break;
    }

    // 客户端断开时立即清理（cleanup 幂等，重复调用安全）
    req.on('close', cleanup);
    req.on('error', cleanup);

    // ③ 心跳与看门狗
    // 注意：必须在创建定时器之前判断连接是否已结束（回放终态事件会提前 cleanup），
    //       否则已关闭的连接会留下两个永不清理的 interval（进程无法退出）。
    if (!closed) {
      heartbeatTimer = setInterval(() => {
        heartbeats += 1;
        write(`: hb ${Date.now()} frames=${frames} lastSeq=${lastSeq}\n\n`);
        log(`heartbeat #${heartbeats} frames=${frames} lastSeq=${lastSeq}`);
      }, config.stream.heartbeatMs);

      watchdogTimer = setInterval(() => {
        if (closed) return;
        try {
          // 补漏：异步批量落盘可能晚于实时推送；按 seq 去重后补齐
          for (const e of store.getEvents(id)) {
            if (closed) break;
            if (e.seq <= lastSeq) continue;
            handleEvent(e);
          }
        } catch {
          /* ignore */
        }
        if (closed) return;
        const rec = store.getRun(id);
        if (rec && TERMINAL_RUN_STATUS.has(rec.status)) finishRun();
      }, config.stream.watchdogMs);

      // 连接建立时若任务已结束（回放已完成），直接收尾
      const rec = store.getRun(id);
      if (rec && TERMINAL_RUN_STATUS.has(rec.status)) finishRun();
    }
  });

  // 流式诊断：订阅者数量、临时事件计数、待落盘队列长度（开发调试用）
  app.get('/api/stream/stats', (_req, res) => {
    res.json({
      liveDeltas: config.stream.liveDeltas,
      heartbeatMs: config.stream.heartbeatMs,
      watchdogMs: config.stream.watchdogMs,
      activeStreams: hub.activeRuns(),
      connections: streamState.connections,
      maxConnections: config.stream.maxConnections,
      droppedEphemeral: streamState.droppedEphemeral,
      ephemeralEvents: logger.ephemeralTotal(),
      pendingPersistence: logger.pendingCount(),
      uptimeSec: Math.round(process.uptime()),
    });
  });

  // ---------------------------------------------------------------------------
  // 错误报告接口
  // ---------------------------------------------------------------------------

  /** 查询最近的结构化错误报告（内存环形缓冲，最近 200 条；落盘副本见 data/errors.log） */
  app.get('/api/errors', (req, res) => {
    const q = req.query;
    const filter = {
      runId: typeof q.runId === 'string' ? q.runId : undefined,
      code: typeof q.code === 'string' ? q.code : undefined,
      source: typeof q.source === 'string' ? (q.source as any) : undefined,
    };
    // 聚合视图（?view=summary）：按「code + location」计数，供前端「错误」页签显示高频 TOP（解决 R5）
    if (q.view === 'summary') {
      res.json({
        total: errors.count(),
        logPath: config.log.errorLogPath,
        ...errors.summary({ ...filter, limit: Math.min(100, Math.max(1, Number(q.limit ?? 20) || 20)) }),
      });
      return;
    }
    const list = errors.list({ ...filter, limit: Math.min(200, Math.max(1, Number(q.limit ?? 50) || 50)) });
    res.json({ total: errors.count(), count: list.length, errors: list, logPath: config.log.errorLogPath });
  });

  /**
   * 浏览器侧错误上报：前端 window.onerror / unhandledrejection 直接 POST 过来，
   * 让「前端静默失效」也能被服务端记录（否则 UI 不更新时无从查起）。
   */
  app.post('/api/client-errors', (req, res) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const decision = clientErrorLimiter.take(key);
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.retryAfterSec));
      return res.status(429).json({ error: '客户端错误上报过于频繁，请稍后重试' });
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const s = (k: string, max = 2000) => (typeof b[k] === 'string' ? (b[k] as string).slice(0, max) : undefined);
    const report = errors.report({
      source: 'client',
      phase: s('phase', 100) ?? 'browser',
      code: s('code', 60) ?? 'CLIENT_ERROR',
      message: s('message', 1000) ?? '（浏览器上报了空错误）',
      runId: s('runId', 80),
      // 浏览器没有 Error 对象，栈是文本：传进去以便解析出「哪一行」
      stack: s('stack', 1500),
      context: {
        url: s('url', 300),
        line: b.line,
        column: b.column,
        stack: s('stack', 1500),
        userAgent: s('userAgent', 200),
        extra: b.extra,
      },
    });
    res.json({ ok: true, errorId: report.id });
  });

  // 兜底：路由内未捕获的同步/异步异常 → 统一报告 + 结构化 500（而不是 Express 默认 HTML 500）
  app.use((err: unknown, req: any, res: any, _next: any) => {
    const report = errors.report({
      source: 'server',
      phase: `route:${req.method} ${req.path}`,
      error: err,
      code: 'HTTP_HANDLER_ERROR',
      runId: typeof req.params?.id === 'string' ? req.params.id : undefined,
      context: { method: req.method, path: req.path, query: req.query },
    });
    if (res.headersSent) return;
    res.status(500).json({ error: `服务器内部错误（${report.id}）：${report.message}`, errorId: report.id });
  });

  // 前端静态资源
  app.get('/', (_req, res) => {
    res.sendFile(resolve('public/index.html'));
  });

  // ---------------------------------------------------------------------------
  // 知识系统：数据仓库 / 历史与变更追踪 / 上下文管理（三模块互通，correlationId 可追溯）
  // ---------------------------------------------------------------------------

  // ---- 数据仓库 ----
  /** 查询数据（按集合/类型/标签/全文）；POST 创建/更新 */
  app.get('/api/data', (req, res) => {
    const q = req.query;
    const items = q.q
      ? knowledge.searchData(String(q.q), { limit: num(q.limit, 50), collection: str(q.collection) })
      : knowledge.queryData({
          collection: str(q.collection),
          type: str(q.type),
          tag: str(q.tag),
          limit: num(q.limit, 50),
          offset: num(q.offset, 0),
        });
    res.json({ count: items.length, items });
  });

  app.post('/api/data', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!b.collection) return res.status(400).json({ error: '缺少 collection（分类命名空间）' });
    try {
      const result = knowledge.putData(
        {
          collection: String(b.collection),
          itemId: b.itemId ? String(b.itemId) : undefined,
          type: b.type ? String(b.type) : undefined,
          tags: Array.isArray(b.tags) ? b.tags.map(String) : undefined,
          content: b.content,
          createdBy: b.actor ? String(b.actor) : undefined,
        },
        { actor: b.actor ? String(b.actor) : undefined, runId: b.runId ? String(b.runId) : undefined },
      );
      res.status(201).json({ ok: true, ...result });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? '创建失败' });
    }
  });

  app.get('/api/data/:collection/:itemId', (req, res) => {
    const item = knowledge.getData(req.params.collection, req.params.itemId);
    if (!item) return res.status(404).json({ error: '未找到' });
    res.json({ item });
  });

  app.put('/api/data/:collection/:itemId', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const result = knowledge.putData(
        {
          collection: req.params.collection,
          itemId: req.params.itemId,
          type: b.type ? String(b.type) : undefined,
          tags: Array.isArray(b.tags) ? b.tags.map(String) : undefined,
          content: b.content,
          createdBy: b.actor ? String(b.actor) : undefined,
        },
        { actor: b.actor ? String(b.actor) : undefined, runId: b.runId ? String(b.runId) : undefined },
      );
      res.json({ ok: true, ...result });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? '更新失败' });
    }
  });

  app.delete('/api/data/:collection/:itemId', (req, res) => {
    const result = knowledge.deleteData(req.params.collection, req.params.itemId, {
      actor: typeof req.query.actor === 'string' ? String(req.query.actor) : undefined,
    });
    if (!result.deleted) return res.status(404).json({ error: '未找到' });
    res.json({ ok: true, ...result });
  });

  // ---- 历史与变更追踪 ----
  app.get('/api/history', (req, res) => {
    const q = req.query;
    const entries = knowledge.queryHistory({
      from: str(q.from),
      to: str(q.to),
      actor: str(q.actor),
      action: str(q.action),
      resourceType: str(q.resourceType),
      resourceId: str(q.resourceId),
      correlationId: str(q.correlationId),
      limit: num(q.limit, 100),
      offset: num(q.offset, 0),
    });
    res.json({ count: entries.length, entries });
  });

  /** 统一时间线：把会话记录(runs) + 变更追踪(audit) + 可选事件流 按时间合并 */
  app.get('/api/history/timeline', (req, res) => {
    const q = req.query;
    const entries = knowledge.timeline(
      {
        runId: str(q.runId),
        actor: str(q.actor),
        from: str(q.from),
        to: str(q.to),
        includeEvents: q.includeEvents === '1' || q.includeEvents === 'true',
        limit: num(q.limit, 200),
      },
      (f) => store.listRuns(2000).filter((r) => (!f.actor || r.runId === f.actor) && (!f.from || r.createdAt >= f.from!) && (!f.to || r.createdAt <= f.to!)),
      (runId) => store.getEvents(runId),
    );
    res.json({ count: entries.length, entries });
  });

  app.get('/api/history/trace/:correlationId', (req, res) => {
    const entries = knowledge.traceByCorrelation(req.params.correlationId);
    res.json({ correlationId: req.params.correlationId, count: entries.length, entries });
  });

  // ---- 上下文管理 ----
  /** 列出最近会话；带 ?q= 时改为跨会话全文检索相关历史上下文 */
  app.get('/api/context', (req, res) => {
    const q = req.query;
    if (q.q) {
      const turns = knowledge.searchContext(String(q.q), { limit: num(q.limit, 50), sessionId: str(q.sessionId) });
      return res.json({ mode: 'search', count: turns.length, turns });
    }
    const sessions = knowledge.context.listSessions(num(q.limit, 50));
    res.json({ mode: 'list', count: sessions.length, sessions });
  });

  app.post('/api/context', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      const result = knowledge.openSession(
        { sessionId: b.sessionId ? String(b.sessionId) : undefined, title: b.title ? String(b.title) : undefined, meta: b.meta as any },
        { actor: b.actor ? String(b.actor) : undefined },
      );
      res.status(201).json({ ok: true, ...result });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? '创建会话失败' });
    }
  });

  app.get('/api/context/:sessionId', (req, res) => {
    const r = knowledge.context.getWithRecent(req.params.sessionId, num(req.query.recent as any, 10));
    if (!r.session) return res.status(404).json({ error: '会话不存在' });
    res.json(r);
  });

  app.delete('/api/context/:sessionId', (req, res) => {
    const ok = knowledge.context.deleteSession(req.params.sessionId);
    if (!ok) return res.status(404).json({ error: '会话不存在' });
    res.json({ ok: true });
  });

  app.get('/api/context/:sessionId/turns', (req, res) => {
    const turns = knowledge.context.getTurns(req.params.sessionId, num(req.query.limit as any, 1000));
    res.json({ count: turns.length, turns });
  });

  app.post('/api/context/:sessionId/turns', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const role = b.role as any;
    if (!['user', 'assistant', 'tool', 'system'].includes(role)) {
      return res.status(400).json({ error: 'role 必须是 user/assistant/tool/system' });
    }
    try {
      const result = knowledge.appendTurn(
        req.params.sessionId,
        { role, content: b.content, tokens: b.tokens != null ? Number(b.tokens) : undefined },
        { actor: b.actor ? String(b.actor) : undefined, runId: b.runId ? String(b.runId) : undefined },
      );
      res.status(201).json({ ok: true, ...result });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? '追加失败' });
    }
  });

  /** 知识系统总览（健康检查/报告用） */
  app.get('/api/knowledge/stats', (_req, res) => {
    res.json(knowledge.stats());
  });

  /** 切块级 RAG 索引状态（未构建时为 null） */
  app.get('/api/rag/stats', (_req, res) => {
    res.json(knowledge.ragStats());
  });

  /** RAG 索引运行状态：是否构建过、是否正在刷新、持久化层规模、是否开启后台补算 */
  app.get('/api/rag/status', (_req, res) => {
    res.json(knowledge.ragStatus());
  });

  /** 重建切块级 RAG 索引：?indexKind=flat|hnsw|ivf&chunkSize=512&overlap=64 */
  app.post('/api/rag/rebuild', async (req, res) => {
    const indexKind = req.body?.indexKind ?? req.query.indexKind;
    const kind = indexKind === 'hnsw' || indexKind === 'ivf' ? indexKind : 'flat';
    const chunkSizeRaw = Number(req.body?.chunkSize ?? req.query.chunkSize ?? 512);
    const chunkSize = Number.isFinite(chunkSizeRaw)
      ? Math.max(64, Math.min(4096, Math.floor(chunkSizeRaw)))
      : 512;
    const overlapRaw = Number(req.body?.overlap ?? req.query.overlap ?? 64);
    const overlap = Number.isFinite(overlapRaw)
      ? Math.max(0, Math.min(Math.floor(chunkSize / 2) - 1, Math.floor(overlapRaw)))
      : 64;
    try {
      const pipeline = await knowledge.rebuildRag({ indexKind: kind, chunk: { chunkSize, overlap } });
      res.json(pipeline.stats());
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /** 切块级检索：?q=...&mode=hybrid_rerank&k=5&collection=... */
  app.get('/api/rag/search', async (req, res) => {
    const q = str(req.query.q);
    if (!q) return res.status(400).json({ error: '缺少 q 检索词' });
    const modeRaw = String(req.query.mode ?? 'hybrid_rerank');
    const allowed = new Set(['keyword', 'vector', 'hybrid', 'hybrid_weighted', 'hybrid_rerank']);
    const mode = (allowed.has(modeRaw) ? modeRaw : 'hybrid_rerank') as
      | 'keyword'
      | 'vector'
      | 'hybrid'
      | 'hybrid_weighted'
      | 'hybrid_rerank';
    const k = Math.max(1, Math.min(50, Number(req.query.k ?? 5) || 5));
    const collection = str(req.query.collection) || undefined;
    try {
      const result = await knowledge.searchRag(q, {
        mode,
        k,
        filter: collection ? (m) => m.collection === collection : undefined,
      });
      res.json({ ...result, count: result.results.length });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /** MCP Streamable HTTP：POST JSON-RPC（单条或 batch）。 */
  app.post('/mcp', async (req, res) => {
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) ac.abort(new Error('MCP HTTP 连接已关闭'));
    });
    try {
      const body = req.body as unknown;
      const method =
        !Array.isArray(body) && body && typeof body === 'object'
          ? (body as { method?: unknown }).method
          : undefined;
      const incomingSession = req.get('mcp-session-id');
      if (method === 'initialize' && !incomingSession) {
        res.setHeader('Mcp-Session-Id', randomUUID());
      } else if (incomingSession) {
        res.setHeader('Mcp-Session-Id', incomingSession);
      }
      if (Array.isArray(body)) {
        const out = await mcp.handleBatch(body, { signal: ac.signal });
        if (!out.length) return res.status(202).end();
        return res.json(out);
      }
      const out = await mcp.handle(body, { signal: ac.signal });
      if (!out) return res.status(202).end();
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/mcp', (_req, res) => {
    res.setHeader('Allow', 'POST, DELETE');
    res.status(405).json({ error: '当前实现使用 Streamable HTTP；请 POST JSON-RPC 消息。' });
  });

  /** 客户端结束会话（MCP Streamable HTTP 的 DELETE）；本实现无服务端会话状态，直接 200。 */
  app.delete('/mcp', (_req, res) => {
    res.status(200).end();
  });

  /**
   * 知识库检索（关键词 / 语义 / 混合）——三种 mode 都走同一条切块级 RAG 管线：
   *   ?q=不安全的常量&mode=keyword   → BM25
   *   ?q=不安全的常量&mode=semantic  → 向量近邻（Flat/HNSW/IVF）
   *   ?q=不安全的常量&mode=hybrid    → BM25 + 向量 → RRF → rerank
   * 可选 `collection` 下推元数据过滤；响应按文档去重，附 matchedBy / chunkId / 耗时。
   */
  app.get('/api/knowledge/search', async (req, res) => {
    const q = str(req.query.q);
    if (!q) return res.status(400).json({ error: '缺少 q 检索词' });
    const mode = (req.query.mode === 'semantic' || req.query.mode === 'hybrid' ? req.query.mode : 'keyword') as 'keyword' | 'semantic' | 'hybrid';
    const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 20) || 20));
    const collection = str(req.query.collection) || undefined;
    try {
      const result = await knowledge.searchKnowledge(q, { mode, limit, collection });
      const base = {
        mode,
        engine: 'rag',
        ragMode: result.ragMode,
        collection: result.collection,
        count: result.count,
        latencyMs: result.latencyMs,
        timings: result.timings,
      };
      // keyword 的历史响应字段是 items；semantic/hybrid 是 hits。两者都保留，避免破坏调用方。
      return mode === 'keyword'
        ? res.json({ ...base, items: result.hits })
        : res.json({ ...base, hits: result.hits });
    } catch (e) {
      return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // -------------------------------------------------------------------------
  // 定时任务（进程内调度；只在 src/index.ts 启动）
  // -------------------------------------------------------------------------
  app.get('/api/schedules', (_req, res) => {
    const items = store.listSchedules().map((s) => {
      const last = s.lastRunId ? store.getRun(s.lastRunId) : null;
      const pendingCount = pendingActions.list({ status: 'pending', scheduleId: s.id, limit: 500 }).length;
      return {
        ...s,
        lastRun: last
          ? {
              runId: last.runId,
              status: last.status,
              createdAt: last.createdAt,
              finalAnswer: last.finalAnswer?.slice(0, 200),
              failureReason: last.failureReason?.slice(0, 200),
            }
          : null,
        pendingCount,
      };
    });
    res.json({ count: items.length, schedules: items });
  });

  app.post('/api/schedules', (req, res) => {
    const v = parseScheduleRequest((req.body ?? {}) as Record<string, unknown>, config, null);
    if (v.error || !v.record) return res.status(400).json({ error: v.error ?? '请求无效' });
    store.saveSchedule(v.record);
    res.status(201).json({ schedule: v.record });
  });

  app.patch('/api/schedules/:id', (req, res) => {
    const existing = store.getSchedule(req.params.id);
    if (!existing) return res.status(404).json({ error: '定时任务不存在' });
    const v = parseScheduleRequest((req.body ?? {}) as Record<string, unknown>, config, existing);
    if (v.error || !v.record) return res.status(400).json({ error: v.error ?? '请求无效' });
    store.saveSchedule(v.record);
    res.json({ schedule: v.record });
  });

  app.delete('/api/schedules/:id', (req, res) => {
    const existing = store.getSchedule(req.params.id);
    if (!existing) return res.status(404).json({ error: '定时任务不存在' });
    store.deleteSchedule(req.params.id);
    res.json({ ok: true });
  });

  app.post('/api/schedules/:id/run-now', (req, res) => {
    if (!store.getSchedule(req.params.id)) return res.status(404).json({ error: '定时任务不存在' });
    const r = scheduler.runNow(req.params.id);
    const status = r.ok ? 201 : r.error?.startsWith('overlap_skipped') ? 409 : 400;
    res.status(status).json(r);
  });

  app.get('/api/schedules/:id/runs', (req, res) => {
    if (!store.getSchedule(req.params.id)) return res.status(404).json({ error: '定时任务不存在' });
    const runs = store.listRunsBySchedule(req.params.id, 20).map((r) => recordToResult(r));
    res.json({ count: runs.length, runs });
  });

  return { app, store, runtime, registry, errors, knowledge, verification, recovery, mcp, mcpRuntime, scheduler, pendingActions, logger };
}

/** 常量时间比较，避免 token 通过响应时间被逐字符试探。 */
export function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1]?.trim() || undefined;
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

function num(v: unknown, def?: number): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return def;
}

/** 仅接受非空字符串；用于可能包含 API Key 的字段（空串视为未提供） */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function parseToolChoice(
  v: unknown,
  allowedTools: unknown,
): { value?: ToolChoice; error?: string } {
  if (v === undefined) return {};
  if (typeof v === 'string') {
    if (v === 'auto' || v === 'none' || v === 'required') return { value: v };
    return { error: `llm.toolChoice 非法：${JSON.stringify(v)}。只允许 auto、none、required 或 {type:'function',function:{name}}` };
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return { error: "llm.toolChoice 非法：只允许 auto、none、required 或 {type:'function',function:{name}}" };
  }
  const o = v as { type?: unknown; function?: unknown };
  const fn = o.function as { name?: unknown } | undefined;
  if (o.type !== 'function' || !fn || typeof fn.name !== 'string' || !fn.name.trim()) {
    return { error: "llm.toolChoice 非法：指定工具必须是 {type:'function',function:{name}}，且 name 非空" };
  }
  const name = fn.name.trim();
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
    return { error: `llm.toolChoice.function.name 非法：${JSON.stringify(name)}（1~64 个字母/数字/_.-）` };
  }
  // 请求显式给了 allowedTools 时，forced tool 必须在其白名单内；未给时留给运行时按 spec/工具表裁剪。
  if (Array.isArray(allowedTools)) {
    const allowed = new Set(allowedTools.map((x) => String(x)));
    if (!allowed.has(name)) {
      return { error: `llm.toolChoice 指定的工具 ${name} 不在 allowedTools 白名单内` };
    }
  }
  return { value: { type: 'function', function: { name } } };
}

function parseParallelToolCalls(v: unknown): { value?: boolean; error?: string } {
  if (v === undefined) return {};
  if (typeof v === 'boolean') return { value: v };
  return { error: `llm.parallelToolCalls 必须是布尔值（收到 ${JSON.stringify(v)}）` };
}
