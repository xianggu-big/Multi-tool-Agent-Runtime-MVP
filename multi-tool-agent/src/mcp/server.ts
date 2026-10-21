// src/mcp/server.ts — 最小 MCP 工具服务器（initialize / tools/list / tools/call / ping）

import {
  JSON_RPC_ERRORS,
  MCP_PROTOCOL_VERSION,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpInitializeResult,
  type McpToolCallResult,
  type McpToolDefinition,
} from './protocol.js';

export interface McpToolContext {
  name: string;
  requestId: JsonRpcId;
  signal?: AbortSignal;
}

export type McpToolHandler = (args: Record<string, unknown>, ctx: McpToolContext) => Promise<unknown> | unknown;

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  handler: McpToolHandler;
}

export interface McpServerOptions {
  name: string;
  version: string;
  instructions?: string;
}

export class McpServer {
  private readonly tools = new Map<string, McpTool>();
  /** 进行中的 tools/call：requestId → AbortController（支持 notifications/cancelled）。 */
  private readonly activeCalls = new Map<string, AbortController>();

  constructor(private readonly opts: McpServerOptions) {}

  registerTool(tool: McpTool): void {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(tool.name)) {
      throw new Error(`MCP 工具名非法：${tool.name}（1~64 个字母/数字/_.-）`);
    }
    if (this.tools.has(tool.name)) throw new Error(`MCP 工具已注册：${tool.name}`);
    if (!tool.inputSchema || (tool.inputSchema as { type?: string }).type !== 'object') {
      throw new Error(`MCP 工具 ${tool.name} 的 inputSchema 必须是 object`);
    }
    this.tools.set(tool.name, tool);
  }

  list(): McpToolDefinition[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    }));
  }

  /** 处理单条 JSON-RPC 消息；通知返回 null。signal 会透传给工具 handler。 */
  async handle(raw: unknown, opts: { signal?: AbortSignal } = {}): Promise<JsonRpcResponse | null> {
    if (!raw || typeof raw !== 'object') {
      return errorResponse(null, JSON_RPC_ERRORS.INVALID_REQUEST, '请求必须是 JSON 对象');
    }
    const msg = raw as Partial<JsonRpcRequest>;
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return errorResponse(isId(msg.id) ? msg.id : null, JSON_RPC_ERRORS.INVALID_REQUEST, '无效的 JSON-RPC 2.0 请求');
    }
    const id = msg.id;
    const isNotification = id === undefined;
    try {
      const result = await this.dispatch(msg.method, msg.params, id ?? null, opts.signal);
      if (isNotification) return null;
      return { jsonrpc: '2.0', id: id ?? null, result };
    } catch (e) {
      if (isNotification) return null;
      const err = e as { code?: number; message?: string; data?: unknown };
      return errorResponse(
        id ?? null,
        typeof err.code === 'number' ? err.code : JSON_RPC_ERRORS.INTERNAL_ERROR,
        err.message ?? String(e),
        err.data,
      );
    }
  }

  /** 批量请求（JSON-RPC batch）。 */
  async handleBatch(raw: unknown[], opts: { signal?: AbortSignal } = {}): Promise<JsonRpcResponse[]> {
    if (!raw.length) {
      return [errorResponse(null, JSON_RPC_ERRORS.INVALID_REQUEST, '空 batch')];
    }
    const out: JsonRpcResponse[] = [];
    for (const item of raw) {
      const r = await this.handle(item, opts);
      if (r) out.push(r);
    }
    return out;
  }

  private async dispatch(
    method: string,
    params: unknown,
    id: JsonRpcId,
    signal?: AbortSignal,
  ): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initializeResult();
      case 'notifications/initialized':
        return {};
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: this.list() };
      case 'resources/list':
        return { resources: [] };
      case 'prompts/list':
        return { prompts: [] };
      case 'tools/call':
        return this.callTool(params, id, signal);
      case 'notifications/cancelled': {
        const p = asRecord(params);
        const rid = p.requestId;
        if (typeof rid === 'string' || typeof rid === 'number') {
          this.activeCalls.get(String(rid))?.abort(new Error('client cancelled'));
        }
        return {};
      }
      default:
        throw Object.assign(new Error(`未知方法：${method}`), { code: JSON_RPC_ERRORS.METHOD_NOT_FOUND });
    }
  }

  private initializeResult(): McpInitializeResult {
    return {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
      },
      serverInfo: { name: this.opts.name, version: this.opts.version },
      instructions: this.opts.instructions,
    };
  }

  private async callTool(params: unknown, id: JsonRpcId, signal?: AbortSignal): Promise<McpToolCallResult> {
    const p = asRecord(params);
    const name = typeof p.name === 'string' ? p.name : '';
    if (!name) throw invalidParams('tools/call 缺少 name');
    const tool = this.tools.get(name);
    if (!tool) throw invalidParams(`未知工具：${name}`);
    const args = p.arguments === undefined ? {} : asRecord(p.arguments);
    const required = Array.isArray(tool.inputSchema.required)
      ? (tool.inputSchema.required as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    const missing = required.filter((k) => !(k in args));
    if (missing.length) {
      throw invalidParams(`工具 ${name} 缺少必填参数：${missing.join(', ')}`);
    }
    if (signal?.aborted) {
      return { content: [{ type: 'text', text: `工具 ${name} 已取消` }], isError: true };
    }
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', forwardAbort, { once: true });
    const key = id === null ? undefined : String(id);
    if (key) this.activeCalls.set(key, controller);
    try {
      const result = await tool.handler(args, { name, requestId: id, signal: controller.signal });
      return normalizeToolResult(result);
    } catch (e) {
      // 工具执行失败按 MCP 约定放进 result.isError，而不是 JSON-RPC error
      return {
        content: [{ type: 'text', text: `工具 ${name} 执行失败：${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      };
    } finally {
      signal?.removeEventListener('abort', forwardAbort);
      if (key) this.activeCalls.delete(key);
    }
  }
}

export function normalizeToolResult(result: unknown): McpToolCallResult {
  if (isToolResult(result)) return result;
  if (typeof result === 'string') {
    return { content: [{ type: 'text', text: result }] };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(result ?? null) }],
    structuredContent: result,
  };
}

function isToolResult(x: unknown): x is McpToolCallResult {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return Array.isArray(o.content);
}

function asRecord(x: unknown): Record<string, unknown> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return {};
  return x as Record<string, unknown>;
}

function invalidParams(message: string): Error {
  return Object.assign(new Error(message), { code: JSON_RPC_ERRORS.INVALID_PARAMS });
}

function isId(x: unknown): x is JsonRpcId {
  return typeof x === 'string' || typeof x === 'number' || x === null;
}

function errorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}
