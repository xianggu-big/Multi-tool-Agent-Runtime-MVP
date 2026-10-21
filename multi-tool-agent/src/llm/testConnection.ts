// src/llm/testConnection.ts — 「测试连接」：用你的 Key 验证 Base URL / 模型是否可用
// 设计要点：
//  1) **默认可注入 fetch**，因此可以在不联网的情况下做单元测试；
//  2) 目标地址做 SSRF 防护：只允许公网 + 回环（本地 Ollama 等本地模型服务），
//     禁止云元数据（169.254.169.254）与其它私网段，避免这个接口变成内网探测器；
//  3) 任一环节失败都给出**明确原因**（HTTP 状态 + 响应片段），不笼统地说“失败”。
//
// ⚠️ 本模块会真实发起网络请求（由调用方决定是否调用）；返回值中**不含 API Key**。

import { URL } from 'node:url';
import { isIP } from 'node:net';
import { isPrivateV4, isPrivateV6, isLoopbackHost } from '../tools/research/ssrf.js';

export interface LlmTestInput {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  /** 是否在 /models 不可用时用一次最小 chat 请求兜底（会消耗极少量 token） */
  allowChatFallback?: boolean;
}

export interface LlmTestResult {
  ok: boolean;
  /** 检测方式：models=列出模型；chat=最小对话请求；blocked=被安全策略拦截 */
  method: 'models' | 'chat' | 'blocked';
  status?: number;
  latencyMs?: number;
  /** /models 返回的模型 id 列表（截断到 50 个） */
  models?: string[];
  /** 模型是否出现在可用列表中（若 /models 可用） */
  modelAvailable?: boolean;
  detail?: string;
}

export interface TargetCheck {
  ok: boolean;
  reason?: string;
}

/**
 * 「测试连接」的目标地址策略：
 *  - 允许 http/https；
 *  - 允许回环地址（127.0.0.1 / localhost / ::1）——本地模型服务需要；
 *  - 禁止云元数据 169.254.169.254、link-local、以及其它私网段与 .internal 域名。
 */
export function checkLlmTestTarget(raw: string): TargetCheck {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'Base URL 非法（需要形如 https://api.deepseek.com 或 http://localhost:11434/v1）' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `不允许的协议: ${u.protocol}` };
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host.includes('169.254.169.254')) return { ok: false, reason: '云元数据地址被禁止' };
  if (host === 'metadata.google.internal' || host.endsWith('.internal')) {
    return { ok: false, reason: '内网域名被禁止' };
  }
  if (isLoopbackHost(host)) return { ok: true }; // 本地模型服务允许
  const ver = isIP(host);
  if (ver === 4 && isPrivateV4(host)) return { ok: false, reason: `私网 IPv4 被禁止: ${host}` };
  if (ver === 6 && isPrivateV6(host)) return { ok: false, reason: `私网 IPv6 被禁止: ${host}` };
  return { ok: true };
}

/** 规范化 Base URL：去掉结尾斜杠 */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

/**
 * 测试连接：优先 `GET {base}/models`（免费、不消耗 token）。
 * 若该端点不存在（404/405），可用 `allowChatFallback` 退化为一次最小 `chat/completions` 请求。
 */
export async function testLlmConnection(
  input: LlmTestInput,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10000,
): Promise<LlmTestResult> {
  const base = normalizeBaseUrl(input.baseUrl || '');
  if (!base) {
    return { ok: false, method: 'blocked', detail: 'Base URL 不能为空' };
  }
  const target = checkLlmTestTarget(base);
  if (!target.ok) {
    return { ok: false, method: 'blocked', detail: target.reason };
  }

  const started = Date.now();
  const signal = AbortSignal.timeout(timeoutMs);

  // ① 列出模型（多数 OpenAI 兼容服务支持）
  let modelsRes: Response;
  try {
    modelsRes = await fetchImpl(`${base}/models`, { headers: authHeaders(input.apiKey), signal });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    return {
      ok: false,
      method: 'models',
      latencyMs: Date.now() - started,
      detail: /timeout|timed out|aborted/i.test(msg)
        ? `连接超时（${timeoutMs}ms）：Base URL 可能不可达${/localhost|127\.0\.0\.1/.test(base) ? '，或本地模型服务未启动' : '，或当前网络无法直连'}: ${msg}`
        : `请求失败: ${msg}`,
    };
  }

  if (modelsRes.ok) {
    let ids: string[] = [];
    try {
      const json = (await modelsRes.json()) as { data?: { id?: string }[] };
      ids = (json.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean);
    } catch {
      /* 响应不是 JSON：仍视为连通 */
    }
    return {
      ok: true,
      method: 'models',
      status: modelsRes.status,
      latencyMs: Date.now() - started,
      models: ids.slice(0, 50),
      modelAvailable: input.model && ids.length ? ids.includes(input.model) : undefined,
      detail: ids.length
        ? `连通成功，返回 ${ids.length} 个模型`
        : '连通成功（未解析到模型列表）',
    };
  }

  if (modelsRes.status === 401 || modelsRes.status === 403) {
    const body = await modelsRes.text().catch(() => '');
    return {
      ok: false,
      method: 'models',
      status: modelsRes.status,
      latencyMs: Date.now() - started,
      detail: `鉴权失败（HTTP ${modelsRes.status}）：API Key 无效或无权限。${body.slice(0, 200)}`,
    };
  }

  // ② /models 不可用时：可选的最小对话请求兜底
  if ((modelsRes.status === 404 || modelsRes.status === 405) && input.allowChatFallback) {
    const chatStarted = Date.now();
    try {
      const chatRes = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(input.apiKey) },
        body: JSON.stringify({
          model: input.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await chatRes.text().catch(() => '');
      return {
        ok: chatRes.ok,
        method: 'chat',
        status: chatRes.status,
        latencyMs: Date.now() - chatStarted,
        detail: chatRes.ok
          ? '连通成功（该服务不支持 /models，已用最小对话请求验证；会消耗少量 token）'
          : `对话请求失败（HTTP ${chatRes.status}）：${text.slice(0, 300)}`,
      };
    } catch (e) {
      return {
        ok: false,
        method: 'chat',
        latencyMs: Date.now() - chatStarted,
        detail: `对话请求异常: ${(e as Error).message}`,
      };
    }
  }

  const body = await modelsRes.text().catch(() => '');
  return {
    ok: false,
    method: 'models',
    status: modelsRes.status,
    latencyMs: Date.now() - started,
    detail: `HTTP ${modelsRes.status}：${body.slice(0, 300) || '（无响应体）'}${
      modelsRes.status === 404 ? '；该服务可能不支持 /models，可勾选「用最小对话请求兜底」再试' : ''
    }`,
  };
}
