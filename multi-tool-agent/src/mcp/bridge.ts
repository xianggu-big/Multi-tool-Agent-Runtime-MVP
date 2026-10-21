// src/mcp/bridge.ts — 把 MCP 工具注册进本项目的 Tool Registry
//
// 关系：MCP 负责“发现/调用外部工具”，function calling 负责“让模型选择工具”。
// 桥接后，MCP 工具和本地工具在模型眼里完全一样：同一份 ToolDefinition + 同一个执行入口。

import { z } from 'zod';
import type { RiskLevel } from '../types.js';
import type { ToolRegistry } from '../tools/Registry.js';
import { errResult, okResult, type Tool } from '../tools/types.js';
import { mcpToolJson, mcpToolText, type McpClient } from './client.js';

export interface McpBridgeOptions {
  /** 本地工具名前缀，避免与内置工具冲突；默认 `mcp_` */
  prefix?: string;
  /** 需要的权限名；Agent spec 必须显式授予 */
  permission?: string;
  /** 未声明 annotations 时的兜底风险等级；默认 medium（不自动重试，避免副作用被放大）。 */
  riskLevel?: RiskLevel;
  timeoutMs?: number;
  /** 只桥接指定 MCP 工具名（不填 = 全部） */
  names?: string[];
}

export async function registerMcpTools(
  registry: ToolRegistry,
  client: McpClient,
  opts: McpBridgeOptions = {},
): Promise<string[]> {
  const defs = await client.listTools();
  const selected = opts.names ? defs.filter((d) => opts.names!.includes(d.name)) : defs;
  const registered: string[] = [];
  for (const def of selected) {
    const localName = `${opts.prefix ?? 'mcp_'}${def.name}`.slice(0, 64);
    const tool: Tool = {
      name: localName,
      description: def.description ?? `MCP tool: ${def.name}`,
      // 参数先按 object 接收；真正的字段约束由 MCP server 的 JSON Schema 暴露给模型。
      inputSchema: z.record(z.unknown()),
      jsonSchema: def.inputSchema,
      timeoutMs: opts.timeoutMs ?? 30_000,
      permission: opts.permission ?? 'mcp:call',
      riskLevel: inferRiskLevel(def.annotations, opts.riskLevel ?? 'medium'),
      execute: async (input, ctx) => {
        const started = Date.now();
        try {
          const res = await client.callTool(def.name, asObject(input), { signal: ctx.signal });
          if (res.isError) {
            return errResult('MCP_TOOL_ERROR', mcpToolText(res) || `MCP 工具 ${def.name} 执行失败`, Date.now() - started);
          }
          return okResult(mcpToolJson(res), Date.now() - started);
        } catch (e) {
          return errResult(
            'MCP_CALL_FAILED',
            `MCP 工具 ${def.name} 调用失败：${e instanceof Error ? e.message : String(e)}`,
            Date.now() - started,
            { retryable: true },
          );
        }
      },
    };
    registry.register(tool);
    registered.push(localName);
  }
  return registered;
}

/** 按 MCP annotations 推断风险：destructive > readOnly > 调用方兜底值。 */
function inferRiskLevel(annotations: Record<string, unknown> | undefined, fallback: RiskLevel): RiskLevel {
  if (annotations?.destructiveHint === true) return 'high';
  if (annotations?.readOnlyHint === true) return 'safe';
  return fallback;
}

function asObject(x: unknown): Record<string, unknown> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return {};
  return x as Record<string, unknown>;
}
