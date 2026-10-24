// src/mcp/bridge.ts — 把 MCP 工具注册进本项目的 Tool Registry
//
// 关系：MCP 负责“发现/调用外部工具”，function calling 负责“让模型选择工具”。
// 桥接后，MCP 工具和本地工具在模型眼里完全一样：同一份 ToolDefinition + 同一个执行入口。

import { z } from 'zod';
import type { RiskLevel } from '../types.js';
import type { ToolRegistry } from '../tools/Registry.js';
import { errResult, okResult, type Tool } from '../tools/types.js';
import { hasSensitiveData, redactSecretsDeep } from '../security/redact.js';
import { mcpToolJson, mcpToolText, type McpClient } from './client.js';

export interface McpBridgeOptions {
  /** 该 client 对应的 MCP server 名（待确认执行时需要找回 server）。 */
  serverName?: string;
  /** 本地工具名前缀，避免与内置工具冲突；默认 `mcp_` */
  prefix?: string;
  /** 需要的权限名；Agent spec 必须显式授予 */
  permission?: string;
  /** 未声明 annotations 时的兜底风险等级；默认 medium（不自动重试，避免副作用被放大）。 */
  riskLevel?: RiskLevel;
  timeoutMs?: number;
  /** 只桥接指定 MCP 工具名（不填 = 全部） */
  names?: string[];
  /** names 里有、但 server 没提供的工具（不静默忽略，交给调用方暴露） */
  onMissing?: (missing: string[]) => void;
  /**
   * `destructiveHint=true` 是否必须人工批准；默认 true（fail-closed）。
   * MCP 工具在本地沙箱之外执行，写没写、写了哪里都无法复验，所以不能按 riskLevel 自动放行。
   */
  requireApprovalForHighRisk?: boolean;
}

export async function registerMcpTools(
  registry: ToolRegistry,
  client: McpClient,
  opts: McpBridgeOptions = {},
): Promise<string[]> {
  const defs = await client.listTools();
  const selected = opts.names ? defs.filter((d) => opts.names!.includes(d.name)) : defs;
  if (opts.names) {
    const missing = opts.names.filter((name) => !defs.some((d) => d.name === name));
    if (missing.length) opts.onMissing?.(missing);
  }
  const registered: string[] = [];
  const requireApproval = opts.requireApprovalForHighRisk !== false;
  for (const def of selected) {
    const localName = `${opts.prefix ?? 'mcp_'}${def.name}`.slice(0, 64);
    const riskLevel = inferRiskLevel(def.annotations, opts.riskLevel ?? 'medium');
    const tool: Tool = {
      name: localName,
      description: def.description ?? `MCP tool: ${def.name}`,
      // 参数先按 object 接收；真正的字段约束由 MCP server 的 JSON Schema 暴露给模型。
      inputSchema: z.record(z.unknown()),
      jsonSchema: def.inputSchema,
      timeoutMs: opts.timeoutMs ?? 30_000,
      permission: opts.permission ?? 'mcp:call',
      riskLevel,
      execute: async (input, ctx) => {
        const started = Date.now();
        if (riskLevel === 'high' && requireApproval) {
          // 无人值守定时任务：不弹审批（会挂到 300s 超时），改为写入待确认队列。
          if (ctx.autoPolicy?.enabled) {
            let args: Record<string, unknown>;
            try {
              const text = JSON.stringify(input ?? {});
              if (text.length > 16_000) {
                return errResult(
                  'MCP_ARGS_TOO_LARGE',
                  `MCP 工具 ${def.name} 的参数超过 16000 字符，已 fail-closed，未写入待确认队列。`,
                  Date.now() - started,
                );
              }
              args = asObject(input);
            } catch {
              return errResult('MCP_ARGS_INVALID', `MCP 工具 ${def.name} 的参数无法序列化，已拒绝。`, Date.now() - started);
            }
            // 待确认队列会落库并长期保留；凭据类参数不能这样存。
            // 这类调用只能走交互式人工审批，不能“先排队、事后执行”。
            if (hasSensitiveData(args)) {
              return errResult(
                'MCP_ARGS_SENSITIVE',
                `MCP 工具 ${def.name} 的参数包含 token/key/secret/password 等敏感字段，已 fail-closed，不写入待确认队列；请在交互式任务中人工批准。`,
                Date.now() - started,
              );
            }
            const actionId = ctx.autoPolicy.createPending({
              kind: 'mcp',
              payload: {
                server: opts.serverName ?? 'unknown',
                tool: def.name,
                localName,
                args,
                timeoutMs: opts.timeoutMs ?? 30_000,
                tainted: ctx.untrustedTainted === true,
              },
            });
            return errResult(
              'MCP_DEFERRED',
              `MCP 工具 ${def.name} 声明 destructiveHint=true，已暂缓为待确认操作（${actionId}）；用户确认后才会执行。`,
              Date.now() - started,
            );
          }
          if (!ctx.requestApproval) {
            return errResult(
              'MCP_APPROVAL_REQUIRED',
              `MCP 工具 ${def.name} 声明 destructiveHint=true，但当前上下文没有审批通道，已拒绝执行（fail-closed）。`,
              Date.now() - started,
            );
          }
          const decision = await ctx.requestApproval({
            approvalId: `ap_mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            runId: ctx.runId,
            toolName: localName,
            files: [],
            checks: [],
            riskNote: `MCP 工具 ${def.name} 声明 destructiveHint=true，外部副作用无法在本地沙箱内验证。参数：${clipArgs(input)}`,
            riskReasons: ['mcp-destructive'],
            requestedAt: new Date().toISOString(),
          });
          if (decision.value === 'deny') {
            return errResult(
              'MCP_APPROVAL_DENIED',
              `用户拒绝执行 MCP 工具 ${def.name}${decision.reason ? `：${decision.reason}` : ''}`,
              Date.now() - started,
            );
          }
        }
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

/** 审批卡里只放参数摘要（可能含密钥/隐私，限制长度）。 */
function clipArgs(input: unknown, max = 400): string {
  let text: string;
  try {
    // 审批卡可能被截图/持久化，只展示脱敏后的摘要。
    text = JSON.stringify(redactSecretsDeep(input ?? {}).value);
  } catch {
    text = String(input);
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
