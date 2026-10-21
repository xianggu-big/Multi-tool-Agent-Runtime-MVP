// src/server.ts — HTTP API（含 SSE 实时事件）
import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { RuntimeConfig } from './config.js';
import { buildRuntime } from './runtime/index.js';
import { recordToResult } from './store/SqliteStore.js';
import { buildTraceSnapshot } from './trace/Tracer.js';
import { buildRunReport, toReportRun } from './report/runReport.js';
import { listRunReportMetas } from './report/runReportFiles.js';
import type { RunInput, RunType, TraceEvent, TraceEventType, LLMGenerationParams, ApprovalDecisionValue, ToolChoice } from './types.js';
import { LLM_PRESETS, PARAM_META, getPreset } from './llm/presets.js';
import { testLlmConnection, normalizeBaseUrl } from './llm/testConnection.js';
import { createProvider } from './llm/index.js';
import { classifyTask } from './runtime/router.js';
import { preSplitSubtasks, pickTopLevelDirs, extractTopics } from './runtime/preSplit.js';
import { SUB_AGENT_SPECS, listSpecIds, validateSpecs } from './agents/specs.js';
import { TOOL_PERMISSION } from './runtime/AgentRuntime.js';
import { getEnv } from './env.js';
import { clampNumber, parseGenerationParams } from './llm/params.js';
import { diagnoseRun } from './observability/latency.js';
import { McpServer } from './mcp/server.js';

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
  if (runType !== 'codebase' && runType !== 'research' && runType !== 'misc' && runType !== 'orchestrator') {
    return { error: 'runType 必须为 codebase、research、misc 或 orchestrator' };
  }
  if (typeof body.goal !== 'string' || !body.goal.trim()) {
    return { error: 'goal 不能为空' };
  }
  // 上限防止 1MB 级 goal 原样入库/进 prompt，挤爆预算与日志。
  if (body.goal.length > 20_000) {
    return { error: `goal 过长（${body.goal.length} 字符，最多 20000）` };
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
  if (effectiveLlmMode === 'openai' && !effectiveLlmKey && !presetKeyOptional) {
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

export function createApp(config: RuntimeConfig) {
  const { store, runtime, hub, logger, registry, errors, knowledge, verification, recovery } = buildRuntime(config);

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
  const specIssues = validateSpecs(SUB_AGENT_SPECS, TOOL_PERMISSION, registry.names(), { maxStepsHardLimit: 20 });
  const specErrors = specIssues.filter((i) => i.level === 'error');
  if (specErrors.length) {
    for (const issue of specErrors) console.error(`[agents] 契约错误 ${issue.specId}: ${issue.message}`);
  }
  for (const issue of specIssues.filter((i) => i.level === 'warn')) {
    console.warn(`[agents] 契约提醒 ${issue.specId}: ${issue.message}`);
  }
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      llmMode: config.llmMode,
      mockDefault: config.llmMode === 'mock',
      stream: {
        liveDeltas: config.stream.liveDeltas,
        mockChunkDelayMs: config.stream.mockChunkDelayMs,
        heartbeatMs: config.stream.heartbeatMs,
        watchdogMs: config.stream.watchdogMs,
      },
    });
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
    // 编排建议：规则式预筛（只有建议交给编排时才产出，避免无关噪音）
    let suggestedSubtasks: unknown[] = [];
    const repoPath = typeof req.query.repoPath === 'string' ? req.query.repoPath.trim() : '';
    if (routing.runType === 'orchestrator' || req.query.preview === '1') {
      const dirs = repoPath && existsSync(resolve(repoPath)) ? pickTopLevelDirs(resolve(repoPath)) : [];
      suggestedSubtasks = preSplitSubtasks(goal, {
        dirs,
        topics: extractTopics(goal),
        maxWidth: config.subagent.maxWidth,
      });
    }
    res.json({ ...routing, suggestedSubtasks });
  });

  /**
   * 子 Agent 契约目录（供前端展示与 lint 使用）。**单一事实来源 = src/agents/specs.ts**；
   * `agents/*.agent.md` 由 `npm run agents:docs` 从同一份契约生成，两者由 `npm run agents:lint` 校验一致。
   */
  app.get('/api/agents/specs', (_req, res) => {
    const issues = validateSpecs(SUB_AGENT_SPECS, TOOL_PERMISSION, registry.names(), { maxStepsHardLimit: 20 });
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

  app.post('/api/runs', (req, res) => {
    const { input, error } = validateRunRequest((req.body ?? {}) as Record<string, unknown>, config);
    if (error || !input) {
      return res.status(400).json({ error: error ?? '请求无效' });
    }

    let runId: string;
    let resolved: unknown;
    try {
      // 先在服务端解析预设与参数（含「无 Key 不静默降级」等校验），再入队执行。
      const bundle = createProvider(config, input);
      resolved = bundle.resolved;
      runId = runtime.enqueue(input, bundle.provider);
    } catch (e) {
      // 例如 createProvider 在校验失败时抛错
      return res.status(400).json({ error: `创建任务失败: ${(e as Error).message}` });
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
              allowedTools: ['list_files', 'search_files', 'read_file', 'dir_stats', 'submit_result', 'ask_user'],
            },
          }
        : {}),
    });
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
        res.write(chunk);
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
    const collection = str(req.query.collection);
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
   * 知识库检索（关键词 / 语义 / 混合）：
   *   ?q=不安全的常量&mode=keyword   → FTS5 关键词
   *   ?q=不安全的常量&mode=semantic  → 向量近邻（sqlite-vec kNN；不可用降级 FTS5 候选+重排）
   *   ?q=不安全的常量&mode=hybrid    → 两者并集去重，标注 matchedBy
   */
  app.get('/api/knowledge/search', (req, res) => {
    const q = str(req.query.q);
    if (!q) return res.status(400).json({ error: '缺少 q 检索词' });
    const mode = (req.query.mode === 'semantic' || req.query.mode === 'hybrid' ? req.query.mode : 'keyword') as 'keyword' | 'semantic' | 'hybrid';
    const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 20) || 20));
    if (mode === 'semantic') {
      return res.json({ mode, count: 0, hits: knowledge.searchSemantic(q, { limit }) });
    }
    if (mode === 'hybrid') {
      return res.json({ mode, count: 0, hits: knowledge.searchHybrid(q, { limit }) });
    }
    return res.json({ mode, count: 0, items: knowledge.searchData(q, { limit }) });
  });

  return { app, store, runtime, errors, knowledge, verification, recovery, mcp };
}

interface ParsedRunLimits {
  values: {
    maxSteps?: number;
    maxModelCalls?: number;
    maxToolCalls?: number;
    totalTimeoutMs?: number;
    tokenBudget?: number;
    costBudgetUsd?: number;
  };
  error?: string;
}

/**
 * 运行预算必须是正整数（金额为正数）。0/负数/非数字直接 400，
 * 不能依赖 `??` 落回默认值——否则 tokenBudget=0 会变成“无上限”。
 */
export function parseRunLimits(body: Record<string, unknown>): ParsedRunLimits {
  const values: ParsedRunLimits['values'] = {};
  const intFields: Array<[keyof ParsedRunLimits['values'], unknown, number, number]> = [
    ['maxSteps', body.maxSteps, 1, 200],
    ['maxModelCalls', body.maxModelCalls, 1, 200],
    ['maxToolCalls', body.maxToolCalls, 1, 500],
    ['totalTimeoutMs', body.totalTimeoutMs, 1000, 3_600_000],
    ['tokenBudget', body.tokenBudget, 1, 100_000_000],
  ];
  for (const [name, raw, min, max] of intFields) {
    if (raw === undefined || raw === null || raw === '') continue;
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
      return { values, error: `${name} 必须是 ${min}~${max} 的整数` };
    }
    values[name] = n;
  }
  const costRaw = body.costBudgetUsd;
  if (costRaw !== undefined && costRaw !== null && costRaw !== '') {
    const n = typeof costRaw === 'number' ? costRaw : typeof costRaw === 'string' ? Number(costRaw) : NaN;
    if (!Number.isFinite(n) || n <= 0 || n > 1000) {
      return { values, error: 'costBudgetUsd 必须是 (0, 1000] 的正数' };
    }
    values.costBudgetUsd = n;
  }
  return { values };
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
