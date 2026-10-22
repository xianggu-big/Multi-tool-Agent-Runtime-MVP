// src/types.ts — 全局共享类型定义
// 所有跨模块的结构化类型集中在此，避免循环依赖。

/**
 * 任务类型（= 哪个 Agent 处理）。
 * - codebase：代码仓库分析（可读代码、跑受限测试）
 * - research：公开资料研究（联网检索、证据提取）
 * - misc：杂项与低优先级琐事（只读、单步、本地、失败无严重后果）
 * - orchestrator：多 Agent 编排（主 Agent 拆分 → 并行派发子 Agent → 汇总核验）
 */
export type RunType = 'codebase' | 'research' | 'misc' | 'orchestrator';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_tool'
  | 'awaiting_user'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'limit_reached';

export type RiskLevel = 'safe' | 'low' | 'medium' | 'high';

// ---------------------------------------------------------------------------
// 对话消息（Runtime 内部格式，Provider 负责转换为各家 API 格式）
// ---------------------------------------------------------------------------

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** assistant 消息中的工具调用请求 */
  toolCalls?: ToolCall[];
  /** tool 结果消息：关联的 tool_call id */
  toolCallId?: string;
  /** tool 结果消息：工具名称（便于排查） */
  toolName?: string;
  /** tool 结果是否为错误 */
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// 工具定义（提供给模型的 schema）
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema (draft-07 subset)
}

// ---------------------------------------------------------------------------
// 工具执行结果（统一结构化类型）
// ---------------------------------------------------------------------------

export interface ToolError {
  code: string;
  message: string;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: ToolError;
  /** 是否可重试（仅对明确可重试的错误为 true） */
  retryable?: boolean;
  durationMs: number;
  /** 结果是否被截断（超过输出大小限制） */
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// Token / 费用用量（无法获得精确费用时采用明确标注的估算）
// ---------------------------------------------------------------------------

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 估算费用（美元）。当为估算时，isEstimate=true */
  costUsd: number;
  /** 费用是否估算（真实 API 不返回金额，由表价计算，故恒为 true；仅成本带"估"） */
  isEstimate: boolean;
  /** token 数本身是否估算（真实 API 返回真实 usage → false；Mock 用启发式 → true） */
  tokensEstimated?: boolean;
  /** 费用估算依据（例如「按 deepseek-flash 表价：输入 $0.14/1M…」） */
  estimateNote?: string;
  /** 命中输入缓存的 token 数（厂商返回时才有） */
  cachedPromptTokens?: number;
  /** 思考 token 数（DeepSeek 等会单列） */
  reasoningTokens?: number;
}

// ---------------------------------------------------------------------------
// LLM Provider 接口
// ---------------------------------------------------------------------------

export type StopReason = 'tool_use' | 'end_turn' | 'max_tokens';

/**
 * 工具选择策略（对齐 OpenAI-compatible tool_choice）：
 * - auto：模型自己决定是否调用；
 * - none：禁止调用工具（只回答）；
 * - required：必须调用至少一个工具；
 * - {type:'function', function:{name}}：强制调用指定工具。
 */
export type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

export interface LLMChatRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  /** 生成参数（temperature 等）。缺省表示不发送该字段，由厂商默认值决定。 */
  params?: LLMGenerationParams;
  /** 工具选择策略；缺省 auto（仅当 tools 非空时发送） */
  toolChoice?: ToolChoice;
  /** 是否允许模型在同一轮发起多个工具调用；缺省不发送，由厂商默认值决定 */
  parallelToolCalls?: boolean;
}

/**
 * LLM 生成参数（可直接对照 OpenAI 兼容 API 的请求字段）。
 * 不填 = 不发送该字段（使用厂商默认值）；填了才会出现在请求体里。
 */
export interface LLMGenerationParams {
  /** 单次输出上限（max_tokens）。注意：与任务级 tokenBudget 不是一回事。 */
  maxTokens?: number;
  /** 0~2，越小越确定 */
  temperature?: number;
  /** 0~1，核采样 */
  topP?: number;
  /** -2~2，按出现次数惩罚重复 */
  frequencyPenalty?: number;
  /** -2~2，鼓励新话题 */
  presencePenalty?: number;
  /** DeepSeek V4：思考模式开关（thinking.type） */
  thinking?: 'enabled' | 'disabled';
  /** DeepSeek：思考深度（实测支持 low / high / max） */
  reasoningEffort?: 'low' | 'high' | 'max';
  /**
   * 学习用直通字段：原样并入请求体，便于试验厂商新参数。
   * 服务端会拦截会破坏 Runtime 契约的键（model/messages/tools/stream 等）。
   */
  extra?: Record<string, unknown>;
}

/**
 * 流式增量（Provider → Runtime）。
 * channel=reasoning 表示模型的思考/推理通道（若供应商提供，如 reasoning_content），
 * channel=content 表示对用户可见的正文，
 * channel=tool_call 表示流式装配期间检测到新的工具调用分片（首帧即反馈，供前端提前渲染骨架）。
 */
export interface LLMDelta {
  channel: 'reasoning' | 'content' | 'tool_call';
  text: string;
}

export type LLMDeltaHandler = (delta: LLMDelta) => void;

/** 一次参数调整的披露记录（如 thinking 模式下 maxTokens 过小被抬升）。定义在底层避免循环依赖。 */
export interface ParamAdjustment {
  param: string;
  from: number;
  to: number;
  reason: string;
}

export interface LLMResponse {
  stopReason: StopReason;
  content: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  latencyMs: number;
  model: string;
  /** 思考内容（如 DeepSeek 的 reasoning_content）。不提供流式时，这里给出完整思考文本。 */
  reasoning?: string;
  /** 本次调用中被自动调整的生成参数（如 thinking×maxTokens 防护），供事件/界面如实披露 */
  paramAdjustments?: ParamAdjustment[];
}

export interface LLMProvider {
  readonly name: string;
  /**
   * 模型上下文窗口（token）。只读能力声明，用于计算「当前上下文占窗口」的压缩水位。
   * 未知时不填：运行时必须显式回退并标记来源，不能用任务总预算冒充上下文窗口。
   */
  readonly contextWindow?: number;
  /**
   * 发起一次模型调用。
   * @param onDelta 可选的流式增量回调；提供时 Provider 应尽量以增量方式产出（不支持流式则忽略）。
   * @param signal  可选的取消信号（用于中断长流）。
   */
  chat(req: LLMChatRequest, onDelta?: LLMDeltaHandler, signal?: AbortSignal): Promise<LLMResponse>;
}

// ---------------------------------------------------------------------------
// 可观测性事件
// ---------------------------------------------------------------------------

export type TraceEventType =
  | 'run_started'
  | 'model_request'
  | 'model_completed'
  | 'step_started'
  | 'context_compacted'
  | 'llm_delta'
  | 'tool_call_requested'
  | 'tool_started'
  | 'tool_completed'
  | 'tool_failed'
  | 'misc_report_submitted'
  | 'subtask_started'
  | 'subtask_completed'
  | 'subtask_failed'
  | 'subtask_report_submitted'
  | 'orchestration_submitted'
  | 'runtime_error'
  | 'checkpoint_saved'
  | 'run_awaiting_user'
  | 'run_completed'
  | 'run_failed'
  | 'run_cancelled'
  | 'run_limit_reached'
  // 复盘摘要：**每次** run 终态都发一条（成功也发），携带结论、过程问题聚合与首个问题
  | 'run_digest'
  // 知识系统（Context/History/Repository 三模块的变更事件）
  | 'data_changed'
  | 'data_deleted'
  | 'context_turn_appended'
  | 'audit_recorded'
  // 人工审批（M1 写能力门禁）：请求与决定各一条持久化事件（SSE 实时推 + 断线重放）
  | 'approval_requested'
  | 'approval_decided'
  // 提示注入边界：不可信工具输出命中注入特征（只记录特征与截断样本，不落全文）
  | 'untrusted_content_flagged'
  // 验证闭环（M1/L2）：沙箱阶梯与宿主复验的阶段化证据（UI 显示"检查中/已通过"，报告可归因）
  | 'verification_started'
  | 'verification_completed'
  | 'change_applied'
  | 'change_rolled_back'
  // 崩溃对账（启动扫描 / 手动恢复）：进程被杀后，仓库处于什么状态、用户做了什么选择
  | 'recovery_detected'
  | 'recovery_auto_restored'
  | 'recovery_rolled_back'
  | 'recovery_accepted';

// ---------------------------------------------------------------------------
// 人工审批（M1：写能力门禁）
// ---------------------------------------------------------------------------

export type ApprovalDecisionValue = 'allow_once' | 'allow_file' | 'deny';

/** 高危审批原因（机器可读；前端负责本地化文案） */
export type ApprovalRiskReason = 'delete' | 'host-command';

/**
 * 审批请求里的一项文件改动。
 * 注意（评审 P1-6）：**diff 全文落磁盘**（data/sandbox/<runId>/diffs/<approvalId>.patch），
 * 事件里只带摘要——EventLogger 有脱敏与截断，diff 走事件流会被截断甚至误伤代码行。
 */
export interface ApprovalFileEntry {
  relPath: string;
  op: 'create' | 'edit' | 'delete';
  /** diff 摘要：新增行数 */
  addedLines: number;
  /** diff 摘要：删除行数 */
  removedLines: number;
  /** diff 全文落点（宿主绝对路径；前端经 GET /api/runs/:id/approvals 拉取） */
  diffPath: string;
  /** 该改动来自命令类工具（run_command）时为 true */
  byCommand?: boolean;
}

export interface ApprovalRequest {
  approvalId: string;
  runId: string;
  toolName: string;
  /** change set：本批请求落盘的文件（批量审批，评审 P2-g 防打断疲劳） */
  files: ApprovalFileEntry[];
  /** 沙箱检查结论（逐项；审批卡展示"成品 + 质量"） */
  checks: Array<{ level: string; source: string; ok: boolean; summary: string }>;
  /** 诚实标注（如：run_command 落宿主后的副作用靠 git 兜底） */
  riskNote?: string;
  /** 本批是否含宿主命令（命令副作用无法从沙箱同步；粘性自动放行一律禁用） */
  hasCommands?: boolean;
  /** 本批是否含需要当前批次二次确认的高危动作 */
  highRisk?: boolean;
  /** 高危原因（删除 / 宿主命令） */
  riskReasons?: ApprovalRiskReason[];
  /** true = 批准动作必须显式携带 confirmHighRisk；拒绝不需要确认 */
  requiresExplicitConfirmation?: boolean;
  /** 安全警告（例如：本 run 读取过疑似注入内容，粘性自动放行已禁用） */
  warnings?: string[];
  /** 污点来源摘要（前端审批卡展示；不含原文） */
  untrusted?: { tools: string[]; patterns: string[] };
  requestedAt: string;
}

export interface ApprovalDecision {
  approvalId: string;
  value: ApprovalDecisionValue;
  /** 拒绝理由（按文件回喂给模型，评审 v3-3） */
  reason?: string;
  actor?: string;
  decidedAt: string;
  /** 该请求涉及的文件中，有文件"连续拒绝"已达上限（v3-3：按文件计数；由 Runtime 判定） */
  denyLimitReached?: boolean;
  /** 该决定是否由「粘性策略」自动放行（allow_file 生效后的后续改动；用于事件如实记录） */
  autoByPolicy?: boolean;
  /** 高危批次批准时，用户是否显式完成了当前批次的二次确认 */
  highRiskConfirmed?: boolean;
}

export interface TraceEvent {
  runId: string;
  /** 持久化事件的严格连续序号（从 1 开始）；临时事件固定为 0 */
  seq: number;
  type: TraceEventType;
  timestamp: string; // ISO-8601
  data?: Record<string, unknown>;
  /**
   * 临时事件标记：只走实时通道推送，不落盘（例如高频的 llm_delta 文本增量）。
   * 回放/断线重连时不会重放；seq 固定为 0，不占用持久化序号（保证持久化 seq 连续）。
   */
  ephemeral?: boolean;
}

// ---------------------------------------------------------------------------
// Span（可视化监控用）：Agent Loop 中每个节点的时间跨度
// ---------------------------------------------------------------------------

export type TraceSpanKind = 'run' | 'step' | 'llm' | 'tool' | 'subtask' | 'answer';

export type TraceSpanStatus = 'running' | 'ok' | 'error' | 'cancelled' | 'skipped';

export interface TraceSpan {
  spanId: string;
  /** null 表示 run 根节点 */
  parentId: string | null;
  runId: string;
  kind: TraceSpanKind;
  /** 展示名：工具名 / 模型名 / "step N" / "run" */
  name: string;
  status: TraceSpanStatus;
  /** epoch 毫秒（含小数，用于瀑布图精确对齐） */
  startTs: number;
  endTs?: number;
  durationMs?: number;
  /** 所属步骤序号（step/llm/tool 用） */
  step?: number;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  error?: { code?: string; message?: string };
}

export interface TraceSummary {
  totalDurationMs: number;
  llmCalls: number;
  toolCalls: number;
  llmTotalMs: number;
  toolTotalMs: number;
  perKind: Record<string, { count: number; totalMs: number }>;
}

/** 一次任务的聚合 trace 快照：span 扁平列表 + 根 + 摘要（供前端流程图/瀑布图直接消费） */
export interface TraceSnapshot {
  runId: string;
  status: string;
  rootId: string;
  spans: TraceSpan[];
  summary: TraceSummary;
}

// ---------------------------------------------------------------------------
// 任务输入与结果
// ---------------------------------------------------------------------------

export interface RunLimits {
  maxSteps?: number;
  maxModelCalls?: number;
  maxToolCalls?: number;
  totalTimeoutMs?: number;
  tokenBudget?: number;
  costBudgetUsd?: number;
}

export interface RunInput extends RunLimits {
  runType: RunType;
  goal: string;
  /** 本任务允许使用的工具白名单（Runtime 强制校验） */
  allowedTools?: string[];
  /** 允许的权限范围，例如 ['codebase:read','research:web'] */
  allowedPermissions?: string[];
  /** Codebase 任务：被分析仓库根目录（绝对路径） */
  repoPath?: string;
  /**
   * Codebase 任务：本 run 是否允许在目标仓库执行白名单测试命令（如 node --test / npm test）。
   * 缺省跟随部署配置 CODEBASE_RUN_TESTS_ENABLED（默认 false）；
   * 未开启时 run_tests 不会进入工具池，模型也不会看到它。
   */
  allowRunTests?: boolean;
  /** Research 任务配置 */
  research?: {
    topics?: string[];
    allowedDomains?: string[];
  };
  /**
   * 单次任务的 LLM 覆盖配置（优先于全局 env 配置）。
   * 供前端「API 配置」面板使用：Key 仅用于本次运行，不写入数据库/日志。
   */
  llm?: {
    mode?: 'mock' | 'openai';
    /** Provider 预设 id（见 src/llm/presets.ts，如 deepseek / openai / custom） */
    provider?: string;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    /** 生成参数（temperature / max_tokens / thinking 等），覆盖全局默认 */
    params?: LLMGenerationParams;
    /** 本 run 的工具选择策略（auto/none/required/指定工具）；缺省 auto */
    toolChoice?: ToolChoice;
    /** 是否允许模型同轮并行发起多个工具调用 */
    parallelToolCalls?: boolean;
  };
  /**
   * 单次任务的搜索提供方覆盖（优先于全局 env 配置）。
   * provider=serper 时必须提供 apiKey，否则工具会明确报错而非伪装离线结果。
   */
  search?: {
    provider?: 'offline' | 'serper';
    apiKey?: string;
    baseUrl?: string;
  };
  /**
   * 单次任务的实时流式覆盖（优先于全局 env 配置 config.stream）。
   * liveDeltas=true 时，模型增量（llm_delta）通过实时通道推送，不落盘。
   */
  stream?: {
    liveDeltas?: boolean;
    /** 仅 Mock Provider 使用：分片之间的演示延迟（毫秒）。0 = 全速。 */
    mockChunkDelayMs?: number;
  };
  /**
   * 多轮对话上下文：之前若干轮问答（按时间正序）。Runtime 会把它插到 system 之后、
   * 本次 goal 之前，使模型能「记住」之前的对话（follow-up 提问不丢上下文）。
   * 只读参考，不计入本次任务目标；长度由服务端裁剪（最多 10 轮、每轮 2000 字）。
   */
  contextHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /**
   * 之前对话的归纳摘要（超出活跃窗口、被移出 contextHistory 的部分）。
   * Runtime 会把它作为一条「之前对话摘要」消息注入，防止早期重要上下文丢失。
   */
  contextSummary?: string;
  /** 杂项任务配置（只读边界内的小参数） */
  misc?: {
    /** 任务子类型提示（可选，仅用于提示模型，不做强校验） */
    subtask?: 'inventory' | 'locate' | 'read' | 'lint' | 'other';
    /** 单文件读取上限（字节），默认取 config.misc.maxFileBytes */
    maxFileBytes?: number;
    /** 目录扫描条目上限，默认取 config.misc.scanLimit */
    scanLimit?: number;
  };
  /** 编排任务配置（覆盖默认的宽度/深度/子任务预算） */
  orchestration?: {
    /** 本次最多派发多少个子任务（不得超过 config.subagent.maxWidth） */
    maxWidth?: number;
    /** 只允许使用这些子 Agent 规格（默认全部可用） */
    allowedSpecs?: string[];
    /** 主 Agent 是否允许自己动手（true = 也把只读工具给它，用于简单核对） */
    allowSelfTools?: boolean;
    /**
     * M1：本次是否允许派发「可写子 Agent（code-edit）」。**默认 false（fail-closed）**：
     * 写能力涉及沙箱+人工审批，必须由使用者显式开启（界面开关 / API 传 true）。
     */
    allowWriteSpecs?: boolean;
    /** 提交前是否额外跑 L2 全量（更慢；默认 false，落盘后仍有宿主全量复验） */
    strictVerify?: boolean;
    /** 规则式预筛出来的建议子任务（非强制，主 Agent 可增删改） */
    suggestedSubtasks?: SubtaskRequest[];
  };
  /** Mock 模式下的演示剧本名 */
  mockScenario?: string;
  /**
   * 用户通过 `@路径` 语法指定的上下文文件列表。
   * Runtime 会在 system prompt 后注入「优先读取这些文件」的提示。
   */
  contextFiles?: string[];
  /**
   * 上下文压缩摘要策略：rolling（默认，生产）| legacy（仅 A/B 评测对照）。
   * legacy 复刻 R23 之前的固定切法/200 字截断/3000 字上限，不保留旧摘要与任务目标。
   */
  compactionStrategy?: 'rolling' | 'legacy';
}

// ---------------------------------------------------------------------------
// 多 Agent 编排（主 Agent 调度 + 并行子 Agent）
// ---------------------------------------------------------------------------

/** 子 Agent 的一次委派请求（由主 Agent 通过 delegate_subtasks 提交） */
export interface SubtaskRequest {
  /** 契约 id（见 src/agents/specs.ts） */
  specId: string;
  /** 一句话目标（契约四要素之一） */
  objective: string;
  /** 本次的额外边界（可选的补充约束，不能放宽 spec 的硬边界） */
  boundary?: string;
  /** 输入引用（例如要处理的具体子目录/来源），避免把大段内容塞进上下文 */
  inputs?: Record<string, string>;
  /** 期望输出要点（可选，帮助子 Agent 对齐格式） */
  expectedOutput?: string;
}

/** 子 Agent 的执行结果（回传给主 Agent 的「简要」形态，受长度上限约束） */
export interface SubtaskOutcome {
  subtaskId: string;
  specId: string;
  specTitle: string;
  objective: string;
  status: 'ok' | 'failed' | 'cancelled' | 'limit_reached';
  /** 结构化结论（成功且通过了上报校验时） */
  report?: SubtaskReport;
  /** 失败原因（失败时） */
  failureReason?: string;
  errorCode?: string;
  triggeredLimit?: string;
  steps: number;
  modelCalls: number;
  toolCalls: number;
  durationMs: number;
  usage: TokenUsage;
  /** 被截断的字段（提示主 Agent「还有内容没看到」） */
  truncatedFields?: string[];
  /** 契约未履行标记（例如没有调用 submit_finding 就结束）——主 Agent 必须据此决定是否采信 */
  contractViolation?: string;
}

/** 子 Agent 结构化上报（由终结性工具 submit_finding 提交） */
export interface SubtaskReport {
  summary: string;
  items?: { label: string; value: string | number; detail?: string }[];
  findings?: { path: string; note: string }[];
  /** 证据指针：证明结论来自哪里（V 层核验用，不允许凭空） */
  evidence?: string[];
  /** 自评置信度（低置信应触发主 Agent 复核或升级） */
  confidence?: 'high' | 'medium' | 'low';
  escalateTo?: 'codebase' | 'research' | 'misc' | 'orchestrator' | 'human';
  escalateReason?: string;
  artifacts?: { label: string; content: string }[];
  structured: boolean;
}

/** 编排汇总报告（主 Agent 通过终结性工具 submit_orchestration 提交） */
export interface OrchestrationReport {
  summary: string;
  /** 来自子任务的发现（必须标注来源子任务） */
  findings?: { from: string; note: string; path?: string }[];
  /** 冲突：不同子任务给出不一致结论时显式列出（禁止静默取一个） */
  conflicts?: { between: string[]; topic: string; resolution: string }[];
  /** 未解决/证据不足的部分（诚实标注，不许假装完成） */
  unresolved?: string[];
  /** 部分成功：有子任务失败/被取消时为 true（任务状态仍是 completed，但 UI 必须显著提示） */
  partial?: boolean;
  /** 子任务的执行摘要（成功/失败/被取消/被限流的数量与 id 列表） */
  subtasks?: {
    total: number;
    ok: number;
    failed: number;
    /** 被父任务取消或未启动 */
    cancelled: number;
    /** 因预算/调用上限被截断（limit_reached）——与「被取消」分开计（2026-10-16 口径修正） */
    limited: number;
    ids: string[];
  };
  /** 缺口计数：三类非 ok 子任务 + 模型自报的未解决问题（前端徽标与报告统一用它，避免 headline 出现「0 失败」的假象） */
  gaps?: { failed: number; cancelled: number; limited: number; unresolved: number; total: number };
  /** 子任务资源消耗合计——run 级 modelCalls/toolCalls 只算主 Agent，这里补子任务口径（2026-10-16 口径修正） */
  subtaskUsage?: { modelCalls: number; toolCalls: number; totalTokens: number; costUsd: number };
  escalateTo?: 'codebase' | 'research' | 'misc' | 'human';
  escalateReason?: string;
  structured: boolean;
}

/** 杂项 Agent 的结构化结论（由终结性工具 submit_result 提交） */
export interface MiscReport {
  /** 一句话结论 */
  summary: string;
  /** 结构化清单（例如「文件数: 42」「最大文件: a.log (2.1MB)」） */
  items?: { label: string; value: string | number; detail?: string }[];
  /** 逐条发现（通常带路径） */
  findings?: { path: string; note: string }[];
  /** 超出能力范围时的改派建议 */
  escalateTo?: 'codebase' | 'research' | 'human';
  escalateReason?: string;
  /** 不落盘的文本产物（例如格式化后的片段；仅出现在回答里） */
  artifacts?: { label: string; content: string }[];
  /** true = 由 submit_result 结构化提交；false = 模型未提交，回退用正文文本 */
  structured: boolean;
}

/** 任务分流建议（GET /api/task-router 或界面「自动分流」使用） */
export interface TaskRouting {
  runType: RunType;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  /** 命中的信号词，便于解释与调试 */
  signals: string[];
  /**
   * 命中删除/覆盖等破坏性动作：任何自动 Agent 都不应执行，
   * 需要人工确认（本项目没有写工具，这里只是把边界提前告诉调用方）。
   */
  requiresHuman?: boolean;
}

/** 模型通过 `ask_user` 显式暂停时，等待用户回答的问题（run 状态 = awaiting_user） */
export interface AwaitingUser {
  questions: string[];
  /** 为什么必须暂停（缺哪些信息 / 需要确认什么） */
  reason?: string;
  /** 给用户的简短背景，帮助回答 */
  context?: string;
  askedAt?: string;
}

export interface RunResult {
  runId: string;
  status: RunStatus;
  runType: RunType;
  goal: string;
  finalAnswer?: string;
  failureReason?: string;
  errorCode?: string;
  steps: number;
  modelCalls: number;
  toolCalls: number;
  totalDurationMs: number;
  usage: TokenUsage;
  /** 触发限制的具体名称，例如 'maxSteps' */
  triggeredLimit?: string;
  isMock: boolean;
  /** 研究任务保留的来源引用 */
  sources?: SourceRef[];
  /** 杂项任务的结构化结论（仅 misc 任务、且提交过 submit_result 时有值） */
  misc?: MiscReport;
  /** 编排任务的汇总报告（仅 orchestrator 任务、且提交过 submit_orchestration 时有值） */
  orchestration?: OrchestrationReport;
  /** 本次任务派发过的子任务（编排任务） */
  subtasks?: SubtaskOutcome[];
  /** 等待用户回答（模型调用 ask_user 时存在；status=awaiting_user） */
  awaitingUser?: AwaitingUser;
}

export interface SourceRef {
  title: string;
  url: string;
  snippet?: string;
}

// ---------------------------------------------------------------------------
// 检查点（用于恢复）
// ---------------------------------------------------------------------------

export interface Checkpoint {
  runId: string;
  step: number;
  status: RunStatus;
  messages: ChatMessage[];
  modelCalls: number;
  toolCalls: number;
  usage: TokenUsage;
  createdAt: string;
  /** M1（评审 P2-a）：累计「非任务时间」（等待人工审批等）——resume 时恢复，不重计入超时 */
  pausedMs?: number;
}

// 已持久化的任务记录（SQLite 行映射）
export interface RunRecord {
  runId: string;
  runType: RunType;
  status: RunStatus;
  goal: string;
  createdAt: string;
  updatedAt: string;
  finalAnswer?: string;
  failureReason?: string;
  errorCode?: string;
  steps: number;
  modelCalls: number;
  toolCalls: number;
  totalDurationMs: number;
  usageJson: string;
  triggeredLimit?: string;
  isMock: number; // 0/1
  /** 结构化结果（JSON 字符串，目前用于 misc 任务的 MiscReport） */
  resultJson?: string;
}
