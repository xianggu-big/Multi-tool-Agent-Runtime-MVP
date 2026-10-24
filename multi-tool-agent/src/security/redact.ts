// src/security/redact.ts — 递归脱敏（用于审批摘要 / 待确认队列的展示与落库前检查）
//
// 两类命中：
//   1) 键名本身是凭据（token/apiKey/password/authorization/cookie …）；
//   2) 字符串值长得像常见密钥（sk-… / ghp_… / Bearer …）。
// 返回 redacted=true 表示确实改动了内容；调用方据此决定是“仅展示脱敏版”还是 fail-closed。

const SENSITIVE_SEGMENTS = new Set([
  'token',
  'tokens',
  'key',
  'keys',
  'secret',
  'secrets',
  'password',
  'passwd',
  'authorization',
  'cookie',
  'cookies',
  'credential',
  'credentials',
]);
const SECRET_VALUE_RE = /\b(?:sk-|gh[pousr]_|xox[baprs]-)[A-Za-z0-9._-]{8,}\b/g;
const BEARER_VALUE_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * 按键名判断是否为凭据。按“非字母数字 + 驼峰”切词，避免 tokenizer / monkey 这类
 * 只含子串的普通字段被误伤，同时覆盖 authToken / api_key / X-Api-Key 等写法。
 */
export function isSensitiveKey(key: string): boolean {
  const parts = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((s) => s.toLowerCase())
    .filter(Boolean);
  return parts.some((p) => SENSITIVE_SEGMENTS.has(p));
}

export interface RedactResult {
  value: unknown;
  redacted: boolean;
}

function redactString(text: string): RedactResult {
  let out = text.replace(SECRET_VALUE_RE, '[redacted]').replace(BEARER_VALUE_RE, 'Bearer [redacted]');
  return { value: out, redacted: out !== text };
}

export function redactSecretsDeep(input: unknown, depth = 0): RedactResult {
  if (depth > 20) return { value: '[depth-limit]', redacted: true };
  if (typeof input === 'string') return redactString(input);
  if (Array.isArray(input)) {
    let changed = false;
    const value = input.map((item) => {
      const r = redactSecretsDeep(item, depth + 1);
      changed ||= r.redacted;
      return r.value;
    });
    return { value, redacted: changed };
  }
  if (input && typeof input === 'object') {
    let changed = false;
    const value: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        value[key] = '[redacted]';
        changed = true;
        continue;
      }
      const r = redactSecretsDeep(item, depth + 1);
      changed ||= r.redacted;
      value[key] = r.value;
    }
    return { value, redacted: changed };
  }
  return { value: input, redacted: false };
}

/** 是否存在需要脱敏的内容（不返回脱敏后的值）。 */
export function hasSensitiveData(input: unknown): boolean {
  return redactSecretsDeep(input).redacted;
}
