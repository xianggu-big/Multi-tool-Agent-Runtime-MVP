// src/runtime/runLimits.ts — 运行预算的统一解析与收敛
//
// 为什么单独抽出来：HTTP /api/runs 和定时任务必须共用同一套边界，
// 否则“普通任务不能传负数，但定时任务可以”会变成绕过预算的后门。
import type { RunLimits } from '../types.js';

export interface ParsedRunLimits {
  values: RunLimits;
  error?: string;
}

const INT_FIELDS: Array<[keyof RunLimits, number, number]> = [
  ['maxSteps', 1, 200],
  ['maxModelCalls', 1, 200],
  ['maxToolCalls', 1, 500],
  ['totalTimeoutMs', 1000, 3_600_000],
  ['tokenBudget', 1, 100_000_000],
];

function asNumber(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw);
  return undefined;
}

/** 严格解析：任一项非法就返回 error（HTTP/定时任务创建时使用）。 */
export function parseRunLimits(body: Record<string, unknown>): ParsedRunLimits {
  const values: RunLimits = {};
  for (const [name, min, max] of INT_FIELDS) {
    const raw = body[name as string];
    if (raw === undefined || raw === null || raw === '') continue;
    const n = asNumber(raw);
    // 字段存在但无法解析时必须报错，不能当成“没传”静默忽略。
    if (n === undefined) return { values, error: `${String(name)} 必须是 ${min}~${max} 的整数` };
    if (!Number.isInteger(n) || n < min || n > max) {
      return { values, error: `${String(name)} 必须是 ${min}~${max} 的整数` };
    }
    values[name] = n;
  }
  const costRaw = body.costBudgetUsd;
  const cost = asNumber(costRaw);
  if (cost !== undefined) {
    if (cost <= 0 || cost > 1000) {
      return { values, error: 'costBudgetUsd 必须是 (0, 1000] 的正数' };
    }
    values.costBudgetUsd = cost;
  } else if (costRaw !== undefined && costRaw !== null && costRaw !== '') {
    return { values, error: 'costBudgetUsd 必须是 (0, 1000] 的正数' };
  }
  return { values };
}

/**
 * 防御性收敛：只保留合法字段，非法字段直接丢弃。
 * 用于执行历史定时任务（数据库里可能残留旧版本写入的脏值），不能让脏值进入 Budget。
 */
export function sanitizeRunLimits(raw: unknown): RunLimits {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const body = raw as Record<string, unknown>;
  const values: RunLimits = {};
  for (const [name, min, max] of INT_FIELDS) {
    const n = asNumber(body[name as string]);
    if (n === undefined) continue;
    if (!Number.isInteger(n) || n < min || n > max) continue;
    values[name] = n;
  }
  const cost = asNumber(body.costBudgetUsd);
  if (cost !== undefined && cost > 0 && cost <= 1000) values.costBudgetUsd = cost;
  return values;
}
