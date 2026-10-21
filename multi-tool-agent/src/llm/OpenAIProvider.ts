// src/llm/OpenAIProvider.ts — OpenAI 兼容的 Chat Completions Provider
// 使用原生 fetch，不依赖任何模型 SDK，从而把 Runtime 与具体供应商解耦。
// 需要 OPENAI_API_KEY；所有密钥仅来自运行时配置，禁止硬编码。
//
// 流式支持：当调用方提供 onDelta 时，请求带 stream:true，按 SSE 逐块增量解析，
// 实时回调 content / reasoning_content（DeepSeek 等兼容实现）并把 tool_call 分片聚合。
// ⚠️ 诚实声明：真实供应商的流式路径在本环境**未做端到端验证**（缺少 API Key）；
//    已验证的是纯函数 accumulateOpenAIStreamChunk 的解析逻辑（见 tests/19）。
//    若流式请求失败，不会静默降级为「非流式假装成功」——错误会正常抛出。

import type {
  ChatMessage,
  LLMChatRequest,
  LLMDelta,
  LLMDeltaHandler,
  LLMGenerationParams,
  LLMProvider,
  LLMResponse,
  ParamAdjustment,
  StopReason,
  ToolCall,
  ToolDefinition,
  TokenUsage,
} from '../types.js';
import type { LLMModelPreset, ModelPricing } from './presets.js';
import { sanitizeParamsForModel } from './presets.js';

/** 供应商返回的 usage 明细（可选字段） */
interface UsageDetails {
  cachedPromptTokens?: number;
  reasoningTokens?: number;
}

interface OpenAIConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  /** 模型表价（用于费用估算；缺省时退化到固定比率） */
  pricing?: ModelPricing;
  /** 默认生成参数（可被单次请求的 req.params 覆盖） */
  params?: LLMGenerationParams;
  /** 模型能力（用于丢弃不支持的参数） */
  modelPreset?: LLMModelPreset;
  /** 单次模型调用的超时（毫秒）。缺省 120s——避免某个调用挂起时整个运行被拖到总超时才失败 */
  timeoutMs?: number;
  /**
   * 重试预算：可重试错误（429/5xx/网络瞬断/流空闲）的最多重试次数。缺省 2。
   * 取舍：重试发生在适配层（吸收厂商噪声，ZCode 同款策略）；流式一旦已向用户吐过增量就不再重试
   * （否则会造成内容重复），只在「尚未发出任何增量」时安全重试。
   */
  retryBudget?: number;
  /** 流式空闲超时（毫秒）：超过此时长没有任何增量则中止本次。缺省 30s。 */
  streamIdleTimeoutMs?: number;
}

/**
 * 费用估算（纯函数，可单测）：
 *  - 有表价时按「输入（含缓存命中价）+ 输出」分别计价，并把依据写进 estimateNote；
 *  - 无表价时退化到固定 $1/1M 的粗略比率，并明确标注这是粗略估算。
 * 注意：价格表会变，这里得到的始终是**估算**，真实账单以供应商为准。
 */
export function estimateCost(
  usage: { promptTokens: number; completionTokens: number; cachedPromptTokens?: number },
  pricing: ModelPricing | undefined,
  fallbackPerToken: number,
): { costUsd: number; isEstimate: boolean; estimateNote: string } {
  const total = usage.promptTokens + usage.completionTokens;
  if (!pricing) {
    return {
      costUsd: total * fallbackPerToken,
      isEstimate: true,
      estimateNote: '未配置表价，按固定比率 $1/1M tokens 粗略估算（偏差可能很大）',
    };
  }
  const cached = Math.min(usage.cachedPromptTokens ?? 0, usage.promptTokens);
  const uncached = usage.promptTokens - cached;
  const cachedRate = pricing.cachedInputPerM ?? pricing.inputPerM;
  const costUsd =
    (uncached * pricing.inputPerM + cached * cachedRate + usage.completionTokens * pricing.outputPerM) / 1_000_000;
  return {
    costUsd,
    isEstimate: true,
    // 注意：这里只描述「费率」，缓存命中的 token 数由 usage.cachedPromptTokens 单独累计，
    // 避免把「单次调用的缓存命中数」和「整任务累计值」混在一起看。
    estimateNote:
      `按表价估算：输入 $${pricing.inputPerM}/1M` +
      (pricing.cachedInputPerM !== undefined ? `（缓存命中 $${pricing.cachedInputPerM}/1M）` : '') +
      `、输出 $${pricing.outputPerM}/1M。价格可能变动，真实账单以供应商为准。`,
  };
}

/** 供应商原始 usage（字段随厂商不同，全部按可选处理） */
export interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** DeepSeek：命中输入缓存的 token 数 */
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

/** 把供应商 usage 归一化为本项目的 TokenUsage（含费用估算依据） */
export function toTokenUsage(
  raw: RawUsage | undefined,
  pricing: ModelPricing | undefined,
  fallbackPerToken: number,
): TokenUsage {
  const promptTokens = raw?.prompt_tokens ?? 0;
  const completionTokens = raw?.completion_tokens ?? 0;
  const totalTokens = raw?.total_tokens ?? promptTokens + completionTokens;
  const cachedPromptTokens = raw?.prompt_cache_hit_tokens ?? raw?.prompt_tokens_details?.cached_tokens ?? 0;
  const reasoningTokens = raw?.completion_tokens_details?.reasoning_tokens;
  const cost = estimateCost({ promptTokens, completionTokens, cachedPromptTokens }, pricing, fallbackPerToken);
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    costUsd: cost.costUsd,
    isEstimate: cost.isEstimate,
    // 真实 API 每次响应都返回 usage（prompt/completion/total_tokens）→ token 数是真实的，不带"估"
    tokensEstimated: false,
    estimateNote: cost.estimateNote,
    cachedPromptTokens,
    reasoningTokens,
  };
}

/** 这些键由 Runtime 自己掌控，禁止通过 params.extra 覆盖，否则会破坏 Agent 循环契约 */
export const PROTECTED_BODY_KEYS = new Set([
  'model',
  'messages',
  'tools',
  'tool_choice',
  'stream',
  'stream_options',
]);

/** 参数清洗结果：实际发送的字段与被丢弃的字段（供界面诚实提示） */
export interface BuiltParams {
  body: Record<string, unknown>;
  dropped: string[];
  /** 被自动调整的参数（如 thinking×maxTokens 防护），调用方应如实披露 */
  adjusted: ParamAdjustment[];
}

/**
 * 把生成参数装配成 Chat Completions 请求体（纯函数，可离线单测）。
 * 规则：
 *  - 未设置的字段**不发送**（交给厂商默认值），便于对照「参数是否真的生效」；
 *  - 该模型不支持的字段（如思考模式下的 temperature）直接丢弃，并在 dropped 中报告；
 *  - params.extra 可直通厂商新参数，但保护键被拦截。
 */
export function buildParamsBody(
  params: LLMGenerationParams | undefined,
  modelPreset?: LLMModelPreset,
): BuiltParams {
  const body: Record<string, unknown> = {};
  const dropped: string[] = [];
  if (!params) return { body, dropped, adjusted: [] };

  const { params: clean, dropped: ignored, adjusted } = sanitizeParamsForModel(params, modelPreset);
  dropped.push(...ignored);

  if (clean.maxTokens !== undefined) body.max_tokens = clean.maxTokens;
  if (clean.temperature !== undefined) body.temperature = clean.temperature;
  if (clean.topP !== undefined) body.top_p = clean.topP;
  if (clean.frequencyPenalty !== undefined) body.frequency_penalty = clean.frequencyPenalty;
  if (clean.presencePenalty !== undefined) body.presence_penalty = clean.presencePenalty;
  if (clean.thinking) body.thinking = { type: clean.thinking };
  if (clean.reasoningEffort) body.reasoning_effort = clean.reasoningEffort;

  if (clean.extra) {
    for (const [k, v] of Object.entries(clean.extra)) {
      if (PROTECTED_BODY_KEYS.has(k)) {
        dropped.push(k);
        continue;
      }
      body[k] = v;
    }
  }
  return { body, dropped, adjusted };
}

/**
 * 组装完整请求体（纯函数，可离线单测）。
 * @param stream 是否流式
 */
export function buildRequestBody(
  cfg: { model: string; params?: LLMGenerationParams; modelPreset?: LLMModelPreset },
  req: LLMChatRequest,
  stream: boolean,
): BuiltParams {
  // 合并：单次请求参数 > 构造函数默认参数
  const merged: LLMGenerationParams = { ...cfg.params, ...req.params };
  const { body: paramBody, dropped, adjusted } = buildParamsBody(merged, cfg.modelPreset);

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: toOpenAIMessages(req.messages),
    ...paramBody,
    tools: req.tools.length ? toOpenAITools(req.tools) : undefined,
    tool_choice: req.tools.length ? (req.toolChoice ?? 'auto') : undefined,
    parallel_tool_calls:
      req.tools.length && req.parallelToolCalls !== undefined ? req.parallelToolCalls : undefined,
  };
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  return { body, dropped, adjusted };
}

interface OpenAIChatCompletion {
  choices: {
    message: {
      content: string | null;
      /** DeepSeek 等推理模型的思考内容（非流式返回时也带） */
      reasoning_content?: string | null;
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
    };
    finish_reason: 'stop' | 'tool_calls' | 'length' | string;
  }[];
  usage?: RawUsage;
  model?: string;
}

// ---------------------------------------------------------------------------
// 流式聚合（纯函数，便于离线单测）
// ---------------------------------------------------------------------------

export interface OpenAIStreamState {
  content: string;
  reasoning: string;
  /** 按 index 聚合 tool_call 分片（流式协议中 name/arguments 可能被切成多块） */
  toolCalls: { id: string; name: string; args: string }[];
  finishReason: string | null;
  usage?: RawUsage;
  model?: string;
}

export function newOpenAIStreamState(): OpenAIStreamState {
  return { content: '', reasoning: '', toolCalls: [], finishReason: null };
}

/** 增量解析结果：本块新增的文本（用于即时回调） */
export interface OpenAIStreamDelta {
  contentText: string;
  reasoningText: string;
  toolCallStarted: { index: number; id: string; name: string } | null;
}

/**
 * 把一个 SSE 数据块（已 JSON.parse）合并进聚合状态。
 * 返回本块「新增」的文本，供调用方实时推送。
 */
export function accumulateOpenAIStreamChunk(state: OpenAIStreamState, chunk: any): OpenAIStreamDelta {
  const out: OpenAIStreamDelta = { contentText: '', reasoningText: '', toolCallStarted: null };
  if (!chunk || typeof chunk !== 'object') return out;

  if (typeof chunk.model === 'string') state.model = chunk.model;
  if (chunk.usage) state.usage = chunk.usage;

  const choice = chunk.choices?.[0];
  if (!choice) return out;
  if (choice.finish_reason) state.finishReason = choice.finish_reason;

  const delta = choice.delta ?? {};

  const reasoningPiece: string =
    typeof delta.reasoning_content === 'string'
      ? delta.reasoning_content
      : typeof delta.reasoning === 'string'
        ? delta.reasoning
        : '';
  if (reasoningPiece) {
    state.reasoning += reasoningPiece;
    out.reasoningText = reasoningPiece;
  }

  if (typeof delta.content === 'string' && delta.content) {
    state.content += delta.content;
    out.contentText = delta.content;
  }

  const tcs = delta.tool_calls;
  if (Array.isArray(tcs)) {
    for (const tc of tcs) {
      const idx = typeof tc.index === 'number' ? tc.index : 0;
      let entry = state.toolCalls[idx];
      let isNew = false;
      if (!entry) {
        entry = { id: '', name: '', args: '' };
        state.toolCalls[idx] = entry;
        isNew = true;
      }
      if (tc.id) entry.id = tc.id;
      if (tc.function?.name) entry.name += tc.function.name;
      if (tc.function?.arguments) entry.args += tc.function.arguments;
      // 仅在首次创建 entry 且已具备 name + id 时上报 started（避免后续分片重复触发）
      if (isNew && entry.name && entry.id) {
        out.toolCallStarted = { index: idx, id: entry.id, name: entry.name };
      }
    }
  }

  return out;
}

/** 从聚合状态构造标准响应（含 stopReason 判定与 tool_call 参数解析） */
export function buildResponseFromStreamState(
  state: OpenAIStreamState,
  fallbackModel: string,
  latencyMs: number,
  costPerToken: number,
  pricing?: ModelPricing,
): LLMResponse {
  const toolCalls: ToolCall[] = state.toolCalls
    .filter((t) => t && t.name)
    .map((t, i) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(t.args || '{}');
      } catch {
        args = {};
      }
      return { id: t.id || `call_${i}`, name: t.name, arguments: args };
    });

  let stopReason: StopReason;
  if (toolCalls.length) stopReason = 'tool_use';
  else if (state.finishReason === 'length') stopReason = 'max_tokens';
  else stopReason = 'end_turn';

  const usage = toTokenUsage(state.usage, pricing, costPerToken);

  return {
    stopReason,
    content: state.content,
    toolCalls,
    usage,
    latencyMs,
    model: state.model ?? fallbackModel,
    reasoning: state.reasoning || undefined,
  };
}

// ---------------------------------------------------------------------------

function toOpenAIMessages(messages: ChatMessage[]) {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: m.content,
      };
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

function toOpenAITools(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

// ---- 重试预算辅助（模块级纯函数）-------------------------------------------
// 把「供应商噪声」拦在适配层，核心循环只见干净事件流（对标 ZCode model adapter）。

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

/** 解析 Retry-After 头：秒数或 HTTP 日期 → 毫秒 */
export function parseRetryAfterMs(v: string | null | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n) * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : undefined;
}

/** 判断是否可重试：429 / 5xx / 网络瞬断 / 流空闲。4xx（除429）不可重试（请求本身有问题）。 */
export function isRetryableProviderError(e: unknown): boolean {
  if (!e) return false;
  const status = (e as { status?: number }).status;
  if (status === 429 || (typeof status === 'number' && status >= 500)) return true;
  if ((e as { network?: boolean }).network) return true;
  if ((e as { streamIdle?: boolean }).streamIdle) return true;
  const msg = String((e as Error)?.message ?? '');
  return /fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|terminated|other side|STREAM_IDLE/i.test(msg);
}

/** 构造带 status/retryAfterMs 的 HTTP 错误（供重试判定用） */
function httpError(scope: string, status: number, text: string, retryAfterMs?: number): Error {
  const err = new Error(`${scope} 返回 ${status}: ${text.slice(0, 300)}`);
  (err as Error & { status: number; retryAfterMs?: number }).status = status;
  if (retryAfterMs) (err as Error & { retryAfterMs?: number }).retryAfterMs = retryAfterMs;
  return err;
}

/** 构造网络错误（fetch 抛出的 TypeError 等，可重试） */
function networkError(scope: string, e: unknown): Error {
  const err = new Error(`${scope} 请求失败: ${(e as Error)?.message ?? String(e)}`);
  (err as Error & { network: boolean }).network = true;
  return err;
}

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  /** 模型上下文窗口（来自预设）；预设没写时保持未知，由运行时显式回退。 */
  readonly contextWindow?: number;
  private readonly costPerToken: number;
  private readonly timeoutMs: number;
  private readonly retryBudget: number;
  private readonly streamIdleTimeoutMs: number;

  constructor(private readonly cfg: OpenAIConfig) {
    if (!cfg.apiKey) {
      throw new Error('OpenAIProvider 需要 OPENAI_API_KEY，但未提供。');
    }
    // 费用估算比率（美元/ token），仅用于预算演示，真实账单以供应商为准。
    this.costPerToken = 0.000001; // ~$1 / 1M tokens
    this.timeoutMs = cfg.timeoutMs ?? 120_000;
    this.retryBudget = cfg.retryBudget ?? 2;
    this.streamIdleTimeoutMs = cfg.streamIdleTimeoutMs ?? 30_000;
    const cw = cfg.modelPreset?.contextTokens;
    this.contextWindow = typeof cw === 'number' && Number.isFinite(cw) && cw > 0 ? cw : undefined;
  }

  // ---- 重试预算辅助（吸收厂商噪声：429/5xx/网络瞬断/流空闲）-------------------

  private get maxAttempts(): number {
    return 1 + this.retryBudget;
  }

  private async backoffDelay(attempt: number, err: unknown): Promise<void> {
    const ra = (err as { retryAfterMs?: number })?.retryAfterMs;
    if (ra) {
      await sleep(Math.min(ra, 30_000));
      return;
    }
    // 指数退避 + 抖动：500ms / 1s / 2s ...（attempt 从 1 起算，第一次重试等待 base）
    const base = 500 * Math.pow(2, attempt - 1);
    const jitter = Math.floor(Math.random() * 200);
    await sleep(base + jitter);
  }

  /**
   * 把「调用方 signal（运行级取消/总超时）」与「单次调用超时」合并。
   * 单次调用超时独立于运行总超时：某一次模型调用挂起时，不会等到整个运行的总超时才失败。
   */
  private withCallTimeout(signal?: AbortSignal): { signal: AbortSignal; clear: () => void } {
    const ctrl = new AbortController();
    const reason = new Error(`模型调用超过 ${this.timeoutMs}ms 未返回（已中止，请检查网络/供应商）`);
    const timer = setTimeout(() => ctrl.abort(reason), this.timeoutMs);
    const onAbort = () => ctrl.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        return { signal, clear: () => {} };
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    return {
      signal: ctrl.signal,
      clear: () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      },
    };
  }

  async chat(
    req: LLMChatRequest,
    onDelta?: LLMDeltaHandler,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    // 重试预算：可重试错误（429/5xx/网络/流空闲）指数退避重试，最多 retryBudget 次。
    // 取舍：流式一旦已向用户吐过增量（emitted=true）就不再重试，否则会造成内容重复——
    //       此时直接失败，交给上层（运行级总超时/用户取消）处理。
    let emitted = false;
    const guardedDelta = onDelta ? (d: LLMDelta) => { emitted = true; onDelta(d); } : undefined;
    let lastErr: unknown;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      if (signal?.aborted) throw signal.reason ?? new Error('已取消');
      if (attempt > 0) await this.backoffDelay(attempt, lastErr);
      emitted = false;
      try {
        return onDelta
          ? await this.chatStreaming(req, guardedDelta!, signal)
          : await this.chatOnce(req, signal);
      } catch (e) {
        lastErr = e;
        const canRetry = !emitted && isRetryableProviderError(e) && attempt < this.maxAttempts - 1;
        if (!canRetry) {
          if (this.retryBudget > 0 && isRetryableProviderError(e) && !emitted) {
            throw new Error(`${(e as Error).message}（已重试 ${attempt} 次仍失败）`);
          }
          throw e;
        }
        // 可重试且未吐增量 → 静默重试
      }
    }
    throw lastErr;
  }

  // ---- 非流式（既有路径，保持不变）------------------------------------------

  private async chatOnce(req: LLMChatRequest, signal?: AbortSignal): Promise<LLMResponse> {
    const started = Date.now();
    const { body, adjusted } = buildRequestBody(this.cfg, req, false);
    const t = this.withCallTimeout(signal);
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: t.signal,
      });
    } catch (e) {
      throw networkError('OpenAIProvider', e);
    } finally {
      t.clear();
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw httpError('OpenAIProvider', res.status, text, parseRetryAfterMs(res.headers.get('retry-after')));
    }

    const json = (await res.json()) as OpenAIChatCompletion;
    const choice = json.choices?.[0];
    if (!choice) throw new Error('OpenAIProvider 响应缺少 choices[0]');

    const msg = choice.message;
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        args = {};
      }
      return { id: tc.id, name: tc.function.name, arguments: args };
    });

    let stopReason: StopReason;
    if (toolCalls.length) stopReason = 'tool_use';
    else if (choice.finish_reason === 'length') stopReason = 'max_tokens';
    else stopReason = 'end_turn';

    const usage = toTokenUsage(json.usage, this.cfg.pricing, this.costPerToken);

    return {
      stopReason,
      content: msg.content ?? '',
      toolCalls,
      usage,
      latencyMs: Date.now() - started,
      model: json.model ?? this.cfg.model,
      reasoning: typeof msg.reasoning_content === 'string' && msg.reasoning_content ? msg.reasoning_content : undefined,
      paramAdjustments: adjusted.length ? adjusted : undefined,
    };
  }

  // ---- 流式（SSE 增量解析）--------------------------------------------------

  private async chatStreaming(
    req: LLMChatRequest,
    onDelta: LLMDeltaHandler,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    const started = Date.now();
    const { body, adjusted } = buildRequestBody(this.cfg, req, true);
    const t = this.withCallTimeout(signal); // 总超时保持到流结束（不只是请求头阶段）
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: t.signal,
      });
    } catch (e) {
      t.clear();
      throw networkError('OpenAIProvider(流式)', e);
    }

    if (!res.ok) {
      t.clear();
      const text = await res.text().catch(() => '');
      throw httpError('OpenAIProvider(流式)', res.status, text, parseRetryAfterMs(res.headers.get('retry-after')));
    }
    if (!res.body) {
      t.clear();
      throw new Error('OpenAIProvider(流式) 响应缺少 body（运行环境不支持流式读取）');
    }

    const state = newOpenAIStreamState();
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // 流空闲超时：reader.read() 与 idle 计时赛跑；超时则中止本次（未吐增量时可被上层重试）
    const readOnce = async (): Promise<{ done: boolean; value?: Uint8Array }> => {
      if (!this.streamIdleTimeoutMs) return reader.read();
      let idleTimer!: ReturnType<typeof setTimeout>;
      const idle = new Promise<{ done: boolean; value?: Uint8Array }>((_, rej) => {
        idleTimer = setTimeout(() => {
          const err = new Error(`STREAM_IDLE: 流式空闲超过 ${this.streamIdleTimeoutMs}ms 无增量`);
          (err as Error & { streamIdle: boolean }).streamIdle = true;
          rej(err);
        }, this.streamIdleTimeoutMs);
      });
      try {
        return await Promise.race([reader.read(), idle]);
      } finally {
        clearTimeout(idleTimer);
      }
    };

    try {
      while (true) {
        const { done, value } = await readOnce();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const rawLine = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          const line = rawLine.trim();
          if (!line || line.startsWith(':')) continue;
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;

          let json: unknown;
          try {
            json = JSON.parse(payload);
          } catch {
            continue; // 单个坏帧不中断整条流
          }
          const d = accumulateOpenAIStreamChunk(state, json);
          if (d.reasoningText) onDelta({ channel: 'reasoning', text: d.reasoningText });
          if (d.contentText) onDelta({ channel: 'content', text: d.contentText });
          // 流式 tool_call 首帧反馈：一检测到新工具调用分片立即上报，前端可提前渲染骨架
          if (d.toolCallStarted) {
            onDelta({ channel: 'tool_call', text: JSON.stringify(d.toolCallStarted) });
          }
        }
      }
    } catch (e) {
      try { await reader.cancel(); } catch { /* 忽略 */ }   // 取消底层流，避免连接泄漏
      throw e;
    } finally {
      try { reader.releaseLock(); } catch { /* 忽略 */ }
      t.clear();
    }

    const resp = buildResponseFromStreamState(state, this.cfg.model, Date.now() - started, this.costPerToken, this.cfg.pricing);
    return adjusted.length ? { ...resp, paramAdjustments: adjusted } : resp;
  }
}
