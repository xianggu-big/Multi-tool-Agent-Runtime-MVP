// src/mcp/bootstrap.ts — 把配置的 MCP server 接到主 Runtime 的 ToolRegistry
//
// 设计取舍：
//   - 每个 server 独立连接；一个失败只影响它自己，不拖垮 HTTP 服务；
//   - names 白名单必填并透传给 bridge，避免全量 schema 污染上下文；
//   - 状态只暴露安全 URL 与工具名，token 永不回传。

import type { ErrorReporter } from '../runtime/errorReporter.js';
import type { ToolRegistry } from '../tools/Registry.js';
import { registerMcpTools } from './bridge.js';
import { McpClient, mcpToolJson, mcpToolText } from './client.js';
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
  /** 重连串行化：并发点两次「重连」不能互相 close/register 打架。 */
  private reconnectChain: Promise<unknown> = Promise.resolve();
  private startPromise: Promise<void> | null = null;
  /** 按 server 名保存连接：重连时只替换目标 server，不影响其它 server。 */
  private clients = new Map<string, McpClient>();
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

  /**
   * 直接调用某个已连接 server 的工具（供「待确认 MCP 操作」在执行时复用）。
   * 不经过 ToolRegistry/bridge，避免再次触发审批；调用方必须先完成用户确认。
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; message: string; detail?: Record<string, unknown> }> {
    if (this.closed) return { ok: false, message: 'MCP runtime 已关闭' };
    const spec = this.specs.find((s) => s.name === serverName);
    if (!spec) return { ok: false, message: `未配置 MCP server: ${serverName}` };
    if (!spec.names.includes(toolName)) {
      return { ok: false, message: `MCP 工具 ${toolName} 不在 server ${serverName} 的白名单里` };
    }
    const status = this.statuses.find((s) => s.name === serverName);
    const client = this.clients.get(serverName);
    if (!status || status.state !== 'ready' || !client) {
      return { ok: false, message: `MCP server ${serverName} 当前不可用（state=${status?.state ?? 'missing'}）` };
    }
    try {
      const res = await client.callTool(toolName, args);
      if (res.isError) {
        return { ok: false, message: mcpToolText(res) || `MCP 工具 ${toolName} 执行失败` };
      }
      return { ok: true, message: `MCP 工具 ${toolName} 执行完成`, detail: { result: mcpToolJson(res) } };
    } catch (e) {
      return { ok: false, message: `MCP 工具 ${toolName} 调用失败：${(e as Error).message}` };
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => {})));
    this.clients.clear();
  }

  /**
   * 手动重连（POST /api/mcp/reconnect）：远端 server 重启/换版本后，不必重启本进程。
   * 语义：
   *   - 先摘掉该 server 已注册的工具，再重建连接；失败保持 error 且不影响其它 server；
   *   - 不带 name = 全部重连；name 不存在 → 抛错，由 HTTP 层转 404。
   */
  async reconnect(name?: string): Promise<McpRuntimeStatus> {
    const task = this.reconnectChain.then(() => this.reconnectNow(name));
    this.reconnectChain = task.catch(() => {});
    return task;
  }

  private async reconnectNow(name?: string): Promise<McpRuntimeStatus> {
    if (this.closed) throw new Error('MCP runtime 已关闭');
    const targets = name ? this.specs.filter((s) => s.name === name) : this.specs;
    if (name && !targets.length) throw new Error(`未配置 MCP server: ${name}`);
    // 首次启动可能还在飞：有界等待，避免和 connectOne 并发注册同名工具。
    await this.ready(10_000);
    await Promise.all(targets.map((spec) => this.reconnectOne(spec)));
    this.onTools(this.statuses.flatMap((s) => s.tools));
    return this.status();
  }

  private async reconnectOne(spec: McpServerConfig): Promise<void> {
    const status = this.statuses.find((s) => s.name === spec.name)!;
    const previous = this.clients.get(spec.name);
    if (previous) {
      await previous.close().catch(() => {});
      this.clients.delete(spec.name);
    }
    this.dropTools(status);
    status.state = 'idle';
    status.error = undefined;
    status.missing = undefined;
    status.connectedAt = undefined;
    await this.connectOne(spec);
  }

  /** 清掉某 server 的工具状态并撤销注册（重连前必做；Registry 对同名注册会抛错）。 */
  private dropTools(status: McpServerStatus): void {
    for (const name of status.tools) this.registry.unregister(name);
    status.tools = [];
    status.toolCount = 0;
  }

  private async connectAll(): Promise<void> {
    // 未配置 server：不碰 toolNames（保持调用方给的空数组），也不发任何外部请求。
    if (!this.specs.length) return;
    await Promise.all(this.specs.map((spec) => this.connectOne(spec)));
  }

  private async connectOne(spec: McpServerConfig): Promise<void> {
    const status = this.statuses.find((s) => s.name === spec.name)!;
    status.state = 'connecting';
    status.error = undefined;
    // 上一次连接可能只注册了一部分工具：先清干净，保证重试/重连可重复执行。
    this.dropTools(status);
    const client = new McpClient(
      new HttpTransport({
        url: spec.url,
        timeoutMs: spec.timeoutMs,
        headers: spec.token ? { authorization: `Bearer ${spec.token}` } : {},
      }),
      { timeoutMs: spec.timeoutMs, clientName: 'multi-tool-agent' },
    );

    let registered: string[] = [];
    try {
      await client.connect();
      const tools = await registerMcpTools(this.registry, client, {
        serverName: spec.name,
        prefix: mcpToolPrefix(spec.name),
        permission: 'mcp:call',
        names: spec.names,
        timeoutMs: spec.timeoutMs,
        onMissing: (missing) => {
          status.missing = missing;
          console.warn(`[mcp] server「${spec.name}」缺少白名单工具：${missing.join(', ')}`);
        },
      });
      registered = tools;
      if (!tools.length) throw new Error('names 白名单没有匹配到任何工具');
      this.clients.set(spec.name, client);
      status.state = 'ready';
      status.tools = tools;
      status.toolCount = tools.length;
      status.connectedAt = new Date().toISOString();
      // 增量回填：一个 server 慢/挂不影响其它 server 的工具先可用。
      this.onTools(this.statuses.flatMap((s) => s.tools));
    } catch (e) {
      // 注册到一半失败时不能把半截工具留在 Registry（状态里也没它们，模型却看得到）。
      for (const name of registered) this.registry.unregister(name);
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
