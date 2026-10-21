// src/mcp/client.ts — MCP 客户端（initialize → tools/list → tools/call）

import {
  McpProtocolError,
  MCP_PROTOCOL_VERSION,
  type JsonRpcResponse,
  type McpInitializeResult,
  type McpToolCallResult,
  type McpToolDefinition,
} from './protocol.js';
import type { McpTransport } from './transport.js';

export interface McpClientOptions {
  timeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
}

export class McpClient {
  private nextId = 1;
  private pending = new Map<string, Pending>();
  private unsubscribe: (() => void) | null = null;
  private closed = false;
  private initialized = false;
  readonly timeoutMs: number;

  constructor(
    private readonly transport: McpTransport,
    private readonly opts: McpClientOptions = {},
  ) {
    this.timeoutMs = Math.max(1000, opts.timeoutMs ?? 15_000);
  }

  async connect(): Promise<McpInitializeResult> {
    if (this.initialized) throw new Error('MCP client 已初始化');
    this.unsubscribe = this.transport.onMessage((msg) => this.onMessage(msg));
    const result = (await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: this.opts.clientName ?? 'multi-tool-agent',
        version: this.opts.clientVersion ?? '0.1.0',
      },
    })) as McpInitializeResult;
    if (!result || typeof result !== 'object' || !result.serverInfo) {
      throw new Error('MCP initialize 响应缺少 serverInfo');
    }
    await this.notify('notifications/initialized');
    this.initialized = true;
    return result;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const result = (await this.request('tools/list', {})) as { tools?: unknown };
    if (!Array.isArray(result.tools)) throw new Error('tools/list 响应缺少 tools 数组');
    return result.tools as McpToolDefinition[];
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    opts: { signal?: AbortSignal } = {},
  ): Promise<McpToolCallResult> {
    const result = (await this.request('tools/call', { name, arguments: args }, opts)) as McpToolCallResult;
    if (!result || !Array.isArray(result.content)) {
      throw new Error(`tools/call(${name}) 响应缺少 content`);
    }
    return result;
  }

  async ping(): Promise<void> {
    await this.request('ping', {});
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    opts: { signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.closed) throw new Error('MCP client 已关闭');
    if (opts.signal?.aborted) throw abortError(method);
    const id = this.nextId++;
    const key = String(id);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(key);
        opts.signal?.removeEventListener('abort', onAbort);
        fn();
      };
      timer = setTimeout(() => {
        settle(() => reject(new Error(`MCP 请求超时：${method} (${this.timeoutMs}ms)`)));
        // 超时也要通知 server 取消，否则远端工具会继续执行（尤其是长任务/有副作用的工具）。
        this.notify('notifications/cancelled', { requestId: id, reason: 'timeout' }).catch(() => {});
      }, this.timeoutMs);
      const onAbort = () => {
        settle(() => reject(abortError(method)));
        // MCP 约定：客户端主动取消时发 notifications/cancelled，server 可转给工具。
        this.notify('notifications/cancelled', { requestId: id, reason: 'client aborted' }).catch(() => {});
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(key, {
        resolve: (v) => settle(() => resolve(v as T)),
        reject: (e) => settle(() => reject(e)),
        timer,
        cleanup: () => opts.signal?.removeEventListener('abort', onAbort),
      });
      this.transport.send({ jsonrpc: '2.0', id, method, params }).catch((e) => {
        settle(() => reject(e));
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) throw new Error('MCP client 已关闭');
    await this.transport.send({ jsonrpc: '2.0', method, params });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      p.cleanup();
      clearTimeout(p.timer);
      p.reject(new Error('MCP client 已关闭'));
    }
    this.pending.clear();
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.transport.close();
  }

  private onMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const res = msg as Partial<JsonRpcResponse>;
    if (res.id === undefined || res.id === null) return; // notification
    const key = String(res.id);
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);
    p.cleanup();
    clearTimeout(p.timer);
    if ('error' in res && res.error) {
      p.reject(new McpProtocolError(res.error.code, res.error.message, res.error.data));
    } else if ('result' in res) {
      p.resolve(res.result);
    } else {
      p.reject(new Error('无效的 JSON-RPC 响应'));
    }
  }
}

function abortError(method: string): Error {
  const e = new Error(`MCP 请求已取消：${method}`);
  e.name = 'AbortError';
  return e;
}

/** 取 MCP 工具结果中的纯文本（多个 content 块用换行拼接）。 */
export function mcpToolText(result: McpToolCallResult): string {
  return result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

/** 取结构化结果；没有 structuredContent 时尝试把文本解析成 JSON。 */
export function mcpToolJson(result: McpToolCallResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = mcpToolText(result);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
