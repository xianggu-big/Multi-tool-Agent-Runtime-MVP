// src/tools/Registry.ts — 工具注册表与统一执行入口（安全边界）
// 负责：注册/查找、向模型暴露工具定义、未知工具拒绝、参数校验、
//       权限校验、超时控制、异常规范化。工具本身无法绕过这些控制。

import { z } from 'zod';
import type { RiskLevel, ToolDefinition, ToolResult } from '../types.js';
import type { Tool, ToolContext } from './types.js';
import { errResult } from './types.js';
import { zodToJsonSchema } from './zodToJson.js';

class ToolTimeoutError extends Error {
  constructor() {
    super('tool timeout');
    this.name = 'ToolTimeoutError';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ToolTimeoutError()), ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    p.then(
      (v) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

export interface ExecuteOutcome {
  tool: Tool | null;
  result: ToolResult;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具已注册: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  /** 撤销注册（MCP 重连时替换同名工具）；不存在时返回 false，便于调用方幂等处理。 */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** 已注册工具的真实权限与风险快照；契约门禁以此为准，避免静态表漏掉动态工具。 */
  policySnapshot(): { permissions: Record<string, string>; riskLevels: Record<string, RiskLevel> } {
    const permissions: Record<string, string> = {};
    const riskLevels: Record<string, RiskLevel> = {};
    for (const tool of this.tools.values()) {
      permissions[tool.name] = tool.permission;
      riskLevels[tool.name] = tool.riskLevel;
    }
    return { permissions, riskLevels };
  }

  /** 全部工具定义（供模型 tool calling） */
  toDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.jsonSchema ?? zodToJsonSchema(t.inputSchema),
    }));
  }

  /** 仅暴露白名单内的工具定义 */
  toDefinitionsFor(allowed: string[]): ToolDefinition[] {
    return this.toDefinitions().filter((d) => allowed.includes(d.name));
  }

  /**
   * 统一执行入口。
   * 只有确认工具存在、参数合法、权限满足后才会真正执行。
   * 超时与异常都被规范化为统一的 ToolResult。
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ExecuteOutcome> {
    const tool = this.tools.get(name);
    if (!tool) {
      // 未知工具：明确拒绝，返回错误结果（不执行任何逻辑）
      return { tool: null, result: errResult('UNKNOWN_TOOL', `未知工具: ${name}`, 0) };
    }

    // 权限校验（工具无法自行绕过）
    if (!ctx.allowedPermissions.includes(tool.permission)) {
      return {
        tool,
        result: errResult('PERMISSION_DENIED', `权限不足：工具 ${name} 需要权限 ${tool.permission}`, 0),
      };
    }

    // 参数 Schema 校验（失败时附上正确示例，帮模型一次改对）
    const parsed = tool.inputSchema.safeParse(args);
    if (!parsed.success) {
      const msg = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      const example = tool.inputExample ? `。正确示例: ${JSON.stringify(tool.inputExample)}` : '';
      return { tool, result: errResult('INVALID_ARGS', `参数校验失败: ${msg}${example}`, 0) };
    }

    // 超时 + 异常规范化执行
    const started = Date.now();
    try {
      const result = await withTimeout(Promise.resolve(tool.execute(parsed.data, ctx)), tool.timeoutMs, ctx.signal);
      const duration = Date.now() - started;
      return { tool, result: normalize(name, result, duration) };
    } catch (e) {
      const duration = Date.now() - started;
      if (e instanceof ToolTimeoutError) {
        // 超时：仅对 safe 工具默认可重试
        return {
          tool,
          result: errResult('TIMEOUT', `工具 ${name} 执行超时（>${tool.timeoutMs}ms）`, duration, {
            retryable: tool.riskLevel === 'safe',
          }),
        };
      }
      if (e instanceof DOMException && e.name === 'AbortError') {
        return {
          tool,
          result: errResult('CANCELLED', `工具 ${name} 因任务取消而中止`, duration, { retryable: false }),
        };
      }
      const message = e instanceof Error ? e.message : String(e);
      return {
        tool,
        result: errResult('EXECUTION_ERROR', `工具 ${name} 执行异常: ${message}`, duration, {
          // 默认不对未知异常重试，避免放大副作用
          retryable: false,
        }),
      };
    }
  }
}

function normalize(name: string, result: ToolResult, duration: number): ToolResult {
  if (typeof result !== 'object' || result === null) {
    return errResult('BAD_RESULT', `工具 ${name} 返回了非法结果结构`, duration);
  }
  return {
    ok: result.ok !== false,
    data: result.data,
    error: result.error,
    retryable: result.retryable,
    durationMs: typeof result.durationMs === 'number' ? result.durationMs : duration,
    truncated: result.truncated,
  };
}
