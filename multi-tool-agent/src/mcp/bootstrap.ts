// src/mcp/bootstrap.ts — 把配置的 MCP server 接到主 Runtime 的 ToolRegistry
//
// 设计取舍：
//   - 每个 server 独立连接；一个失败只影响它自己，不拖垮 HTTP 服务；
//   - names 白名单必填并透传给 bridge，避免全量 schema 污染上下文；
//   - 状态只暴露安全 URL 与工具名，token 永不回传。

import type { ErrorReporter } from '../runtime/errorReporter.js';
import type { ToolRegistry } from '../tools/Registry.js';
import { registerMcpTools } from './bridge.js';
import { McpClient } from './client.js';
import { mcpToolPrefix, redactMcpUrl, type McpServerConfig } from './config.js';
import { HttpTransport } from './transport.js';

export type McpServerState = 'idle' | 'connecting' | 'ready' | 'error';

export interface McpServerStatus {
  name: string;
  url: string;
  state: McpServerState;
  toolCount: number;
  tools: string[];
  /** names 白名单里 server 实际没提供的工具（其余工具仍可用） */
  missing?: string[];
  error?: string;
  connectedAt?: string;
}

export interface McpRuntimeStatus {
  configured: number;
  ready: boolean;
  connecting: boolean;
  toolCount: number;
  tools: string[];
  servers: McpServerStatus[];
}

/** 错误消息里若回显了 token，统一打码（状态接口与错误报告都不应出现密钥）。 */
function redactSecret(text: string, secret: string | undefined): string {
  if (!secret) return text;
  return text.split(secret).join('<redacted>');
}

export class McpClientRuntime {
  private startPromise: Promise<void> | null = null;
  private clients: McpClient[] = [];
  private closed = false;
  private readonly statuses: McpServerStatus[];

  constructor(
    private readonly specs: McpServerConfig[],
    private readonly registry: ToolRegistry,
    private readonly errors: ErrorReporter,
    private readonly onTools: (names: string[]) => void = () => {},
  ) {
    this.statuses = specs.map((spec) => ({
      name: spec.name,
      url: redactMcpUrl(spec.url),
      state: 'idle',
      toolCount: 0,
      tools: [],
    }));
  }

  /** 幂等启动；重复调用返回同一个 Promise。 */
  start(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.startPromise) this.startPromise = this.connectAll();
    return this.startPromise;
  }

  /**
   * POST /api/runs 在入队前等待配置的 MCP 完成（成功或失败都放行）。
   * 有界等待：server 挂住时不把 HTTP 请求一起挂住；超时后 run 先跑，status 仍可查。
   */
  async ready(timeoutMs = 10_000): Promise<void> {
    const start = this.startPromise;
    if (!start) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      start,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
  }

  status(): McpRuntimeStatus {
    const servers = this.statuses.map((s) => ({ ...s, tools: [...s.tools] }));
    const tools = servers.flatMap((s) => s.tools);
    return {
      configured: this.specs.length,
      ready: servers.every((s) => s.state === 'ready' || s.state === 'error'),
      connecting: servers.some((s) => s.state === 'connecting'),
      toolCount: tools.length,
      tools,
      servers,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all(this.clients.map((c) => c.close().catch(() => {})));
    this.clients = [];
  }

  private async connectAll(): Promise<void> {
    if (!this.specs.length) {
      this.onTools([]);
      return;
    }
    await Promise.all(this.specs.map((spec) => this.connectOne(spec)));
  }

  private async connectOne(spec: McpServerConfig): Promise<void> {
    const status = this.statuses.find((s) => s.name === spec.name)!;
    status.state = 'connecting';
    status.error = undefined;
    const client = new McpClient(
      new HttpTransport({
        url: spec.url,
        timeoutMs: spec.timeoutMs,
        headers: spec.token ? { authorization: `Bearer ${spec.token}` } : {},
      }),
      { timeoutMs: spec.timeoutMs, clientName: 'multi-tool-agent' },
    );

    try {
      await client.connect();
      const tools = await registerMcpTools(this.registry, client, {
        prefix: mcpToolPrefix(spec.name),
        permission: 'mcp:call',
        names: spec.names,
        timeoutMs: spec.timeoutMs,
        onMissing: (missing) => {
          status.missing = missing;
          console.warn(`[mcp] server「${spec.name}」缺少白名单工具：${missing.join(', ')}`);
        },
      });
      if (!tools.length) throw new Error('names 白名单没有匹配到任何工具');
      this.clients.push(client);
      status.state = 'ready';
      status.tools = tools;
      status.toolCount = tools.length;
      status.connectedAt = new Date().toISOString();
      // 增量回填：一个 server 慢/挂不影响其它 server 的工具先可用。
      this.onTools(this.statuses.flatMap((s) => s.tools));
    } catch (e) {
      await client.close().catch(() => {});
      status.state = 'error';
      status.error = redactSecret(e instanceof Error ? e.message : String(e), spec.token);
      this.errors.report({
        source: 'server',
        phase: 'startup:mcp',
        code: 'MCP_UNAVAILABLE',
        runId: 'startup:mcp',
        // 启动期没有真实 run：只进内存环 + JSONL + 控制台，不伪造一条 run 事件。
        skipEvent: true,
        message: `MCP server「${spec.name}」不可用：${status.error}`,
        context: {
          server: spec.name,
          url: redactMcpUrl(spec.url),
          requestedTools: spec.names,
        },
      });
    }
  }
}
