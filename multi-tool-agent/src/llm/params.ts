// src/llm/params.ts — 生成参数的解析与校验（纯函数，便于测试）
// 约定：**只有显式提供的字段才会进入请求体**；未提供的字段一律不发送（交给厂商默认值）。
//       数值一律做范围校验：超出范围直接报错（而不是静默改成别的值），便于学习者发现自己填错了。

import type { LLMGenerationParams } from '../types.js';
import { PROTECTED_BODY_KEYS } from './OpenAIProvider.js';

export interface ParamParseResult {
  params?: LLMGenerationParams;
  error?: string;
}

/** 浮点比较容差（滑杆等控件可能产生 1.0000000000000002 这类值） */
const EPS = 1e-9;

/** 读取一个可选数值字段并做范围校验 */
function readNumber(
  obj: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  integer = false,
): { value?: number; error?: string } {
  const raw = obj[key];
  if (raw === undefined || raw === null || raw === '') return {};
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return { error: `${key} 必须是数字（收到: ${JSON.stringify(raw)}）` };
  if (n < min - EPS || n > max + EPS) {
    return { error: `${key} 超出允许范围 [${min}, ${max}]（收到: ${n}）` };
  }
  const clamped = Math.min(max, Math.max(min, n));
  return { value: integer ? Math.floor(clamped) : clamped };
}

const MAX_TOKENS_LIMIT = 384000; // DeepSeek V4 的硬上限；其它厂商更小，超出会由厂商报错

/**
 * 从请求体解析生成参数。
 * 返回 { params } 或 { error }（error 为面向用户的中文提示）。
 */
export function parseGenerationParams(raw: unknown): ParamParseResult {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'llm.params 必须是对象' };
  }
  const obj = raw as Record<string, unknown>;
  const params: LLMGenerationParams = {};

  const specs: [string, number, number, boolean][] = [
    ['maxTokens', 1, MAX_TOKENS_LIMIT, true],
    ['temperature', 0, 2, false],
    ['topP', 0, 1, false],
    ['frequencyPenalty', -2, 2, false],
    ['presencePenalty', -2, 2, false],
  ];
  for (const [key, min, max, int] of specs) {
    const { value, error } = readNumber(obj, key, min, max, int);
    if (error) return { error };
    if (value !== undefined) (params as Record<string, unknown>)[key] = value;
  }

  const thinking = obj.thinking;
  if (thinking !== undefined && thinking !== '') {
    if (thinking !== 'enabled' && thinking !== 'disabled') {
      return { error: `thinking 只能是 enabled / disabled（收到: ${JSON.stringify(thinking)}）` };
    }
    params.thinking = thinking;
  }

  const effort = obj.reasoningEffort;
  if (effort !== undefined && effort !== '') {
    if (effort !== 'low' && effort !== 'high' && effort !== 'max') {
      return { error: `reasoningEffort 只能是 low / high / max（收到: ${JSON.stringify(effort)}）` };
    }
    params.reasoningEffort = effort;
  }

  if (obj.extra !== undefined && obj.extra !== null) {
    if (typeof obj.extra !== 'object' || Array.isArray(obj.extra)) {
      return { error: 'llm.params.extra 必须是对象（原样并入请求体，用于试验厂商新参数）' };
    }
    const bad = Object.keys(obj.extra as Record<string, unknown>).filter((k) => PROTECTED_BODY_KEYS.has(k));
    if (bad.length) {
      return { error: `llm.params.extra 不允许覆盖由 Runtime 掌控的字段: ${bad.join(', ')}` };
    }
    params.extra = { ...(obj.extra as Record<string, unknown>) };
  }

  return { params };
}

/** 数值裁剪（配置文件等场景使用：尽量不因为一个笔误让服务起不来） */
export function clampNumber(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}
