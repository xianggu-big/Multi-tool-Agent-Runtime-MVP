// src/llm/presets.ts — LLM Provider 预设目录与生成参数元数据
// 目的：把「baseUrl + 模型名」从手填变成可选，并提供每个可调参数的取值范围/默认值/说明，
//       供前端渲染下拉框、滑杆与提示文案（单一事实来源，避免前后端各写一份）。
//
// ⚠️ 诚实声明：
//  1) 各家的模型清单与价格变动频繁，这里的清单是**示例**，可能已过期；界面上始终保留「自定义」入口。
//  2) 真实 Provider 的验证状态（2026-10-13 更新）：
//     - **DeepSeek 已端到端验证**：`npm run smoke:llm` 用真实 Key 跑通完整 Agent Loop（含工具调用、
//       流式 reasoning_content、参数装配、缓存命中与费用估算），实测记录见 docs/LLM_CONFIG.md §5；
//     - 其余预设（openai / qwen / moonshot / zhipu / ollama）**仍未实测**（本环境无对应 Key）。
//  3) DeepSeek 的旧模型名 deepseek-chat / deepseek-reasoner 已于 2026-07-24 15:59 UTC 停用，
//     继续调用会报错；预设只提供 v4 系列。

import type { LLMGenerationParams } from '../types.js';

/** 表价（美元 / 1M tokens）。价格会变，仅用于「估算并给出依据」，实际以账单为准 */
export interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
  /** 命中上下文的输入缓存价（很多厂商廉价得多） */
  cachedInputPerM?: number;
}

export interface LLMModelPreset {
  id: string;
  label: string;
  /** 表价（可选）：提供后会用于费用估算，并把「按什么价估的」写进 estimateNote */
  pricing?: ModelPricing;
  /**
   * 上下文窗口（token）：现在用于压缩水位计算（promptTokens / contextWindow），不再只是展示。
   * 不确定就不要填：运行时会把「未知窗口」显式回退到累计预算代理，并标记 source=unknown。
   */
  contextTokens?: number;
  /** 单次输出上限（token），仅供参考 */
  maxOutputTokens?: number;
  /** 该模型不支持 / 会被忽略的参数（前端置灰并提示，服务端也会丢弃） */
  ignoredParams?: (keyof LLMGenerationParams)[];
  /** 展示给用户的备注 */
  notes?: string;
}

export interface LLMProviderPreset {
  id: string;
  label: string;
  /** OpenAI 兼容 Base URL（Provider 会拼 /chat/completions） */
  baseUrl: string;
  /** 是否无需 API Key（如本地 Ollama） */
  keyOptional?: boolean;
  /** 对应的环境变量名（展示与解析用） */
  apiKeyEnv: string;
  /** 申请 Key 的地址 */
  apiKeyUrl?: string;
  docsUrl?: string;
  /** 是否支持自定义 Base URL 之外的额外路径段 */
  models: LLMModelPreset[];
  /** 默认模型（models[0] 之外的偏好） */
  defaultModel?: string;
  /** 该 Provider 的能力开关 */
  features?: {
    tools?: boolean;
    thinking?: boolean;
    reasoningEffort?: boolean;
  };
  notes?: string;
}

// ---------------------------------------------------------------------------
// 参数元数据（供前端渲染控件 + 说明文案）
// ---------------------------------------------------------------------------

export interface ParamMeta {
  key: keyof LLMGenerationParams;
  label: string;
  /** 简短说明（为什么调它 / 调大调小会怎样） */
  help: string;
  type: 'number' | 'enum';
  min?: number;
  max?: number;
  step?: number;
  /** 建议取值（前端可做滑杆刻度/提示） */
  suggest?: string;
  /** 何时使用（真实 Provider 列表，用于置灰判断） */
  enumValues?: { value: string; label: string }[];
  /** 默认值（不填 = 不发送该字段，由厂商默认值决定） */
  default?: number | string;
}

export const PARAM_META: ParamMeta[] = [
  {
    key: 'maxTokens',
    label: '单次最大输出 tokens（max_tokens）',
    help: '限制**这一次模型回复**最多生成多少 token（含思考链，视厂商而定）。太小会导致答案/工具参数被截断（表现为 JSON 解析失败或 stopReason=max_tokens）。DeepSeek V4 上限 384000；留空 = 厂商默认。',
    type: 'number',
    min: 1,
    max: 384000,
    step: 1,
    suggest: 'Agent 场景建议 2048~8192',
  },
  {
    key: 'temperature',
    label: 'temperature（随机性）',
    help: '0 = 尽可能确定（同一输入更可能得到同一输出，适合 Agent/工具调用）；越大越发散。DeepSeek 官方推荐：代码/数学 0.0、数据分析 1.0、对话/翻译 1.3、创作 1.5。**思考模式下可能被忽略**。',
    type: 'number',
    min: 0,
    max: 2,
    step: 0.1,
    suggest: 'Agent 建议 0.0~0.3',
  },
  {
    key: 'topP',
    label: 'top_p（核采样）',
    help: '只从累计概率前 top_p 的词里采样。与 temperature 二选一调整即可，不建议同时大改。1.0 = 不裁剪。',
    type: 'number',
    min: 0,
    max: 1,
    step: 0.05,
    suggest: '一般保持 0.95~1.0',
  },
  {
    key: 'frequencyPenalty',
    label: 'frequency_penalty（重复词惩罚）',
    help: '正值会按「出现次数」惩罚已出现的词，减少复读；范围 -2~2，默认 0。',
    type: 'number',
    min: -2,
    max: 2,
    step: 0.1,
  },
  {
    key: 'presencePenalty',
    label: 'presence_penalty（新话题倾向）',
    help: '正值会惩罚「已出现过」的词（不论次数），鼓励引入新内容；范围 -2~2，默认 0。',
    type: 'number',
    min: -2,
    max: 2,
    step: 0.1,
  },
  {
    key: 'thinking',
    label: '思考模式（thinking.type）',
    help: 'DeepSeek V4 支持「思考/非思考」两种模式，思考模式会先产出 reasoning_content（本项目的「实时」视图会逐字展示它）。思考更准但更慢更贵。',
    type: 'enum',
    enumValues: [
      { value: '', label: '不指定（用厂商默认）' },
      { value: 'enabled', label: 'enabled（开启思考）' },
      { value: 'disabled', label: 'disabled（关闭思考）' },
    ],
    default: '',
  },
  {
    key: 'reasoningEffort',
    label: '思考深度（reasoning_effort）',
    help: '仅 DeepSeek 思考模式有效：low 更快更省，high 是官方默认，max 最深。设 max 时记得把 max_tokens 放宽（官方建议 ≥ 32768），否则思考链可能吃光额度、正文为空。',
    type: 'enum',
    enumValues: [
      { value: '', label: '不指定（用厂商默认）' },
      { value: 'low', label: 'low（最快最省）' },
      { value: 'high', label: 'high（默认）' },
      { value: 'max', label: 'max（最深）' },
    ],
    default: '',
  },
];

// ---------------------------------------------------------------------------
// Provider 预设
// ---------------------------------------------------------------------------

export const LLM_PRESETS: LLMProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek（推荐）',
    baseUrl: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    docsUrl: 'https://api-docs.deepseek.com/',
    features: { tools: true, thinking: true, reasoningEffort: true },
    defaultModel: 'deepseek-flash',
    models: [
      {
        id: 'deepseek-flash',
        label: 'deepseek-flash（DeepSeek-V4.1-Flash，推荐）',
        contextTokens: 1048576,
        maxOutputTokens: 393216,
        // 官方价目表（2026-10 抓取，可能变动）
        pricing: { inputPerM: 0.14, cachedInputPerM: 0.0028, outputPerM: 0.28 },
        notes: '默认即思考模式；输入支持文本+图片（本项目只发文本）',
      },
      {
        id: 'deepseek-v4-pro',
        label: 'deepseek-v4-pro（DeepSeek-V4-Pro，更强）',
        contextTokens: 1048576,
        maxOutputTokens: 393216,
        pricing: { inputPerM: 0.435, cachedInputPerM: 0.003625, outputPerM: 0.87 },
        notes: '质量更高、成本更高',
      },
    ],
    notes:
      '以上清单于 2026-10-13 用真实 API 校验（GET /models 当前只返回 deepseek-flash 与 deepseek-v4-pro）。' +
      '旧别名 deepseek-chat / deepseek-reasoner / deepseek-v4-flash 实测仍可用（分别路由到 deepseek-flash 的非思考/思考模式），但已属弃用，建议直接用正式 ID。' +
      '思考会消耗 max_tokens 额度：额度太小会出现「思考写完、正文为空、finish_reason=length」。',
  },
  {
    id: 'openai',
    label: 'OpenAI / 官方兼容',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
    features: { tools: true },
    defaultModel: 'gpt-4o-mini',
    models: [
      {
        id: 'gpt-4o-mini',
        label: 'gpt-4o-mini（便宜）',
        pricing: { inputPerM: 0.15, cachedInputPerM: 0.075, outputPerM: 0.6 },
        notes: '模型清单与表价均为示例，可能已更新；请以官方为准',
      },
      { id: 'gpt-4o', label: 'gpt-4o' },
    ],
    notes: '模型清单仅作示例，请以官方文档为准，或切到「自定义模型」填写。',
  },
  {
    id: 'qwen',
    label: '通义千问（DashScope 兼容模式）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    apiKeyUrl: 'https://bailian.console.aliyun.com/',
    features: { tools: true },
    defaultModel: 'qwen-plus',
    models: [
      { id: 'qwen-plus', label: 'qwen-plus' },
      { id: 'qwen-max', label: 'qwen-max' },
      { id: 'qwen-turbo', label: 'qwen-turbo（便宜）' },
    ],
    notes: '模型清单为示例；本预设使用阿里云的 OpenAI 兼容端点。',
  },
  {
    id: 'moonshot',
    label: '月之暗面 Kimi（Moonshot）',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys',
    features: { tools: true },
    defaultModel: 'moonshot-v1-8k',
    models: [
      { id: 'moonshot-v1-8k', label: 'moonshot-v1-8k' },
      { id: 'moonshot-v1-32k', label: 'moonshot-v1-32k' },
      { id: 'moonshot-v1-128k', label: 'moonshot-v1-128k' },
    ],
    notes: '模型清单为示例；长上下文型号更贵。',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM（BigModel）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyEnv: 'ZHIPU_API_KEY',
    apiKeyUrl: 'https://bigmodel.cn/usercenter/apikeys',
    features: { tools: true },
    defaultModel: 'glm-4-flash',
    models: [
      { id: 'glm-4-flash', label: 'glm-4-flash（便宜）' },
      { id: 'glm-4-plus', label: 'glm-4-plus' },
    ],
    notes: '模型清单为示例。',
  },
  {
    id: 'ollama',
    label: '本地 Ollama（http://localhost:11434/v1）',
    baseUrl: 'http://localhost:11434/v1',
    keyOptional: true,
    apiKeyEnv: 'OLLAMA_API_KEY',
    features: { tools: true },
    defaultModel: 'qwen2.5:7b',
    models: [
      { id: 'qwen2.5:7b', label: 'qwen2.5:7b' },
      { id: 'llama3.1:8b', label: 'llama3.1:8b' },
    ],
    notes: '需要本机已运行 Ollama 且已 pull 对应模型；无需真实 Key。模型名必须与本地已安装的一致。',
  },
  {
    id: 'custom',
    label: '自定义（手填 Base URL 与模型）',
    baseUrl: '',
    apiKeyEnv: 'LLM_API_KEY',
    features: { tools: true },
    models: [],
    notes: '任何 OpenAI 兼容的 /chat/completions 网关都可以用这里接入。',
  },
];

export const DEFAULT_PRESET_ID = 'deepseek';

export function getPreset(id: string | undefined): LLMProviderPreset | undefined {
  if (!id) return undefined;
  return LLM_PRESETS.find((p) => p.id === id);
}

export function getModelPreset(
  preset: LLMProviderPreset | undefined,
  modelId: string | undefined,
): LLMModelPreset | undefined {
  if (!preset || !modelId) return undefined;
  return preset.models.find((m) => m.id === modelId);
}

/** 一次参数调整的披露记录（不是静默改写：调用方应把它写进事件/界面）。类型定义在 types.ts */
export type { ParamAdjustment } from '../types.js';
import type { ParamAdjustment } from '../types.js';

/** thinking 模式下 max_tokens 的安全下限：思考 token 计入 max_tokens，过低会被思考独占导致正文为空 */
export const THINKING_MIN_MAX_TOKENS = 8192;

/**
 * 按模型能力清洗生成参数：丢弃该模型不支持/会被忽略的字段，避免把无效配置发出去。
 * 返回 { params, dropped, adjusted }：
 *   - dropped：被丢弃的字段（界面上诚实提示「哪些参数被忽略了」）；
 *   - adjusted：被抬升的字段（如 thinking 模式下 maxTokens 过小），必须展示而不是静默。
 */
export function sanitizeParamsForModel(
  params: LLMGenerationParams,
  model?: LLMModelPreset,
): { params: LLMGenerationParams; dropped: string[]; adjusted: ParamAdjustment[] } {
  const dropped: string[] = [];
  const adjusted: ParamAdjustment[] = [];
  const out: LLMGenerationParams = { ...params };

  const ignored = new Set<string>(model?.ignoredParams ?? []);
  // DeepSeek 等厂商在「思考模式」下会忽略采样参数（官方文档说明），这里按需剔除
  if (params.thinking === 'enabled') {
    if (params.temperature !== undefined) ignored.add('temperature');
    if (params.topP !== undefined) ignored.add('topP');
    if (params.frequencyPenalty !== undefined) ignored.add('frequencyPenalty');
    if (params.presencePenalty !== undefined) ignored.add('presencePenalty');

    // 事故驱动（run_mv6afboo）：maxTokens=2000 + thinking=enabled → 2000 token 全被思考吃掉，
    // 正文为空（stop=max_tokens, content=''）→ 子任务全部 EMPTY_RESULT、主 Agent 答案残缺。
    // 显式给小了就抬到安全下限，并如实记录（adjusted），不静默。
    if (out.maxTokens !== undefined && out.maxTokens < THINKING_MIN_MAX_TOKENS) {
      adjusted.push({
        param: 'maxTokens',
        from: out.maxTokens,
        to: THINKING_MIN_MAX_TOKENS,
        reason: `thinking 模式下思考 token 计入 max_tokens，${out.maxTokens} 会被思考独占导致正文为空；已抬升到 ${THINKING_MIN_MAX_TOKENS}`,
      });
      out.maxTokens = THINKING_MIN_MAX_TOKENS;
    }
  }

  for (const key of ignored) {
    if ((out as Record<string, unknown>)[key] !== undefined) {
      delete (out as Record<string, unknown>)[key];
      dropped.push(key);
    }
  }
  return { params: out, dropped, adjusted };
}
