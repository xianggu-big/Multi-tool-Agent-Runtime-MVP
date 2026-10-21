// src/llm/index.ts — Provider 工厂：解析预设与参数，选择 Mock 或 OpenAI 兼容 Provider
//
// 优先级（高 → 低）：
//   baseUrl / model： input.llm.*（前端面板）> 预设（presets.ts）> config（.env）
//   apiKey：          input.llm.apiKey > config.llm.apiKey / config.openai.apiKey > 预设对应的环境变量
//   生成参数 params： input.llm.params > config.llm.params（env 默认值）
// 显式选择真实 Provider 但缺少 Key 时**不静默降级**为 Mock，而是抛错。

import type { RunInput, LLMProvider, LLMGenerationParams } from '../types.js';
import type { RuntimeConfig } from '../config.js';
import { getEnv } from '../env.js';
import { MockProvider } from './MockProvider.js';
import { OpenAIProvider } from './OpenAIProvider.js';
import { defaultMockResponder, makeDemoResponder } from './scenarios.js';
import { getPreset, getModelPreset, sanitizeParamsForModel, DEFAULT_PRESET_ID, type LLMProviderPreset } from './presets.js';

export interface ProviderBundle {
  provider: LLMProvider;
  isMock: boolean;
  /** 实际生效的配置摘要（不含 Key 本身），用于日志/接口回显 */
  resolved: {
    presetId: string;
    presetLabel: string;
    baseUrl?: string;
    model: string;
    params: LLMGenerationParams;
    /** 因「当前模型不支持 / 思考模式下被忽略」而被丢弃的参数名 */
    droppedParams: string[];
    hasKey: boolean;
  };
}

/**
 * 解析「实际生效的预设 id」。规则（由上到下，先命中者生效）：
 *  1) 单次任务指定（前端下拉框）        input.llm.provider
 *  2) 环境变量显式指定                  LLM_PROVIDER
 *  3) 配了旧版 OpenAI 变量（OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL 任一）→ openai
 *  4) 兜底：默认预设（DeepSeek）
 * 这样既保证「优先 DeepSeek」，又不会破坏老配置。
 */
export function resolveEffectivePresetId(config: RuntimeConfig, input: RunInput): string {
  if (input.llm?.provider) return input.llm.provider;
  if (config.llm.presetExplicit) return config.llm.presetId;
  const legacyOpenAI =
    !!getEnv('OPENAI_API_KEY') || !!getEnv('OPENAI_BASE_URL') || !!getEnv('OPENAI_MODEL');
  if (legacyOpenAI) return 'openai';
  return config.llm.presetId || DEFAULT_PRESET_ID;
}

/** 解析预设对象 */
export function resolvePreset(config: RuntimeConfig, input: RunInput): LLMProviderPreset | undefined {
  return getPreset(resolveEffectivePresetId(config, input));
}

/**
 * 解析生成参数（仅做浅合并；具体的「模型不支持则丢弃」在 Provider 内做）。
 * 优先级：misc 内置默认（最弱，杂项不需要思考链）< 全局 env < 单次任务。
 */
export function resolveParams(config: RuntimeConfig, input: RunInput): LLMGenerationParams {
  const base = input.runType === 'misc' ? config.misc.defaultParams : {};
  return { ...base, ...config.llm.params, ...input.llm?.params };
}

/** 解析 API Key：单次任务 > 全局配置 > 预设对应的环境变量 */
export function resolveApiKey(
  config: RuntimeConfig,
  input: RunInput,
  preset: LLMProviderPreset | undefined,
): string | undefined {
  const fromInput = input.llm?.apiKey;
  if (fromInput) return fromInput;
  if (config.llm.apiKey) return config.llm.apiKey;
  // 预设自身的环境变量（如 DEEPSEEK_API_KEY / DASHSCOPE_API_KEY / MOONSHOT_API_KEY …）
  if (preset?.apiKeyEnv) {
    const v = getEnv(preset.apiKeyEnv);
    if (v) return v;
  }
  return config.openai.apiKey;
}

export function createProvider(config: RuntimeConfig, input: RunInput): ProviderBundle {
  const preset = resolvePreset(config, input);
  const params = resolveParams(config, input);
  // baseUrl / model 优先级：单次任务 > 显式配置的 OPENAI_* 变量 > 预设默认值 > 兜底
  const baseUrl =
    input.llm?.baseUrl ||
    (config.openai.baseUrlExplicit ? config.openai.baseUrl : undefined) ||
    preset?.baseUrl ||
    config.openai.baseUrl;
  const model =
    input.llm?.model ||
    (config.openai.modelExplicit ? config.openai.model : undefined) ||
    preset?.defaultModel ||
    preset?.models[0]?.id ||
    config.openai.model;
  const apiKey = resolveApiKey(config, input, preset);

  const wantOpenAI =
    input.llm?.mode === 'openai' || (config.llmMode === 'openai' && input.llm?.mode !== 'mock');

  if (!wantOpenAI) {
    const responder = input.mockScenario
      ? makeDemoResponder(input.mockScenario, input.goal)
      : defaultMockResponder;
    // Mock 的分片延迟只影响「有 onDelta 的流式演示」；测试/CI 默认为 0（全速）。
    return {
      provider: new MockProvider(responder, {
        chunkDelayMs: input.stream?.mockChunkDelayMs ?? config.stream.mockChunkDelayMs,
        chunkChars: config.stream.chunkChars,
      }),
      isMock: true,
      resolved: {
        presetId: 'mock',
        presetLabel: 'Mock（无需 Key，仅演示）',
        baseUrl: undefined,
        model: 'mock-model',
        // Mock 不真正调用模型，因此参数不会生效——如实标注，避免误以为「调了参数没变化=有 bug」
        params,
        droppedParams: Object.keys(params),
        hasKey: false,
      },
    };
  }

  // 真实 Provider：自定义预设必须显式给出 Base URL，否则明确报错
  if (preset?.id === 'custom' && !input.llm?.baseUrl) {
    throw new Error('已选择「自定义」Provider，但未提供 Base URL（例如 https://api.example.com/v1）。');
  }
  // 「无需 Key」的预设（本地 Ollama）用占位 Key，避免把「没 Key」误判成配置错误
  const effectiveKey = apiKey || (preset?.keyOptional ? 'not-needed' : undefined);
  if (!effectiveKey) {
    const hint = preset?.apiKeyEnv ? `或设置 ${preset.apiKeyEnv} 环境变量` : '或设置 OPENAI_API_KEY 环境变量';
    throw new Error(`已选择 ${preset?.label ?? 'OpenAI 兼容'} 模式但未提供 API Key（请在界面填写，${hint}）。`);
  }

  const modelPreset = getModelPreset(preset, model);
  const { dropped } = sanitizeParamsForModel(params, modelPreset);

  return {
    provider: new OpenAIProvider({
      apiKey: effectiveKey,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      model,
      params,
      modelPreset,
      pricing: getModelPreset(preset, model)?.pricing,
    }),
    isMock: false,
    resolved: {
      presetId: preset?.id ?? 'custom',
      presetLabel: preset?.label ?? '自定义',
      baseUrl: baseUrl.replace(/\/+$/, ''),
      model,
      params,
      droppedParams: dropped,
      hasKey: true,
    },
  };
}
