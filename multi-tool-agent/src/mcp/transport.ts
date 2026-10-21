// src/mcp/transport.ts — MCP 传输层
//
// 当前 MCP 主流传输：
//   1) stdio：本地子进程，客户端写 stdin / 读 stdout，一行一个 JSON-RPC 消息；
//   2) Streamable HTTP：POST JSON-RPC，响应可以是 application/json 或 text/event-stream；
//   3) 旧版 HTTP+SSE（2024-11-05 之前的双端点模式）：已不推荐，新实现不要再走。
// WebSocket 不是 MCP 标准传输。

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { JSON_RPC_ERRORS } from './protocol.js';
import type { JsonRpcRequest, JsonRpcResponse } from './protocol.js';
import type { McpServer } from './server.js';

export interface McpTransport {
  send(message: unknown): Promise<void>;
  onMessage(cb: (message: unknown) => void): () => void;
  close(): Promise<void>;
}

/** 同进程测试/嵌入式场景：一对互相投递的 transport。 */
export function createInMemoryTransportPair(): [McpTransport, McpTransport] {
  const aSubs = new Set<(m: unknown) => void>();
  const bSubs = new Set<(m: unknown) => void>();
  const make = (self: Set<(m: unknown) => void>, peer: Set<(m: unknown) => void>): McpTransport => ({
    async send(message) {
      const copy = JSON.parse(JSON.stringify(message)) as unknown;
      queueMicrotask(() => {
        for (const cb of [...peer]) cb(copy);
      });
    },
    onMessage(cb) {
      self.add(cb);
      return () => self.delete(cb);
    },
    async close() {
      self.clear();
    },
  });
  return [make(aSubs, bSubs), make(bSubs, aSubs)];
}

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onStderr?: (line: string) => void;
}

/** 客户端侧：启动子进程并通过 stdin/stdout 收发 JSON Lines。 */
export class StdioTransport implements McpTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly rl: ReturnType<typeof createInterface>;
  private readonly subs = new Set<(m: unknown) => void>();
  private closed = false;

  constructor(opts: StdioTransportOptions) {
    this.child = spawn(opts.command, opts.args ?? [], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.rl = createInterface({ input: this.child.stdout });
    this.rl.on('line', (line) => {
      const msg = parseJsonLine(line);
      if (msg === undefined) return;
      for (const cb of [...this.subs]) cb(msg);
    });
    if (opts.onStderr) {
      const errRl = createInterface({ input: this.child.stderr });
      errRl.on('line', opts.onStderr);
    }
    this.child.on('exit', () => {
      this.closed = true;
      this.rl.close();
    });
  }

  async send(message: unknown): Promise<void> {
    if (this.closed) throw new Error('stdio transport 已关闭');
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (err) => (err ? reject(err) : resolve()));
    });
  }

  onMessage(cb: (message: unknown) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rl.close();
    this.child.kill();
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null) return resolve();
      this.child.once('exit', () => resolve());
      setTimeout(resolve, 1000).unref();
    });
  }
}

/** 服务端侧：把 stdin 的 JSON Lines 交给 McpServer，把响应写回 stdout。 */
export function serveStdio(server: McpServer): { close: () => void } {
  const rl = createInterface({ input: process.stdin });
  const write = (msg: unknown) => {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  };
  rl.on('line', async (line) => {
    const msg = parseJsonLine(line);
    if (msg === undefined) {
      write({ jsonrpc: '2.0', id: null, error: { code: JSON_RPC_ERRORS.PARSE_ERROR, message: '无法解析 JSON' } });
      return;
    }
    try {
      if (Array.isArray(msg)) {
        const batch = await server.handleBatch(msg);
        if (batch.length) write(batch);
      } else {
        const res = await server.handle(msg);
        if (res) write(res);
      }
    } catch (e) {
      write({
        jsonrpc: '2.0',
        id: null,
        error: { code: JSON_RPC_ERRORS.INTERNAL_ERROR, message: e instanceof Error ? e.message : String(e) },
      });
    }
  });
  return { close: () => rl.close() };
}

export interface HttpTransportOptions {
  url: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Streamable HTTP 客户端：POST JSON-RPC。
 * 兼容两种响应：
 *   - application/json：响应体就是一个/一组 JSON-RPC response；
 *   - text/event-stream：边读边解析 data: {...}（真流式，不是先 res.text() 再切）。
 * 会话：initialize 响应若带 Mcp-Session-Id，后续请求自动回传。
 */
export class HttpTransport implements McpTransport {
  private readonly subs = new Set<(m: unknown) => void>();
  private readonly fetchImpl: typeof fetch;
  private closed = false;
  private sessionId?: string;

  constructor(private readonly opts: HttpTransportOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** 服务端分配的会话 id（测试/诊断用）。 */
  get session(): string | undefined {
    return this.sessionId;
  }

  async send(message: unknown): Promise<void> {
    if (this.closed) throw new Error('http transport 已关闭');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('MCP HTTP 超时')), this.opts.timeoutMs ?? 30_000);
    try {
      const res = await this.fetchImpl(this.opts.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
          ...(this.opts.headers ?? {}),
        },
        body: JSON.stringify(message),
        signal: ctrl.signal,
      });
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
      if (res.status === 202 || res.status === 204) return;
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('text/event-stream') && res.body) {
        await this.readSse(res.body);
        return;
      }
      const text = await res.text();
      if (!text.trim()) return;
      for (const m of parseJsonOrBatch(text)) this.emit(m);
    } finally {
      clearTimeout(timer);
    }
  }

  onMessage(cb: (message: unknown) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.subs.clear();
  }

  private emit(message: unknown): void {
    for (const cb of [...this.subs]) cb(message);
  }

  /** 增量解析 SSE：按空行切帧，data 行可能跨多行。 */
  private async readSse(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match || match.index === undefined) break;
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const parsed = parseSseFrame(frame);
        if (parsed !== undefined) this.emit(parsed);
      }
    }
    buffer += decoder.decode();
    const tail = parseSseFrame(buffer);
    if (tail !== undefined) this.emit(tail);
  }
}
export function parseJsonLine(line: string): unknown | undefined {
  const s = line.trim();
  if (!s) return undefined;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return undefined;
  }
}

export function parseSse(text: string): unknown[] {
  return text
    .split(/\r?\n\r?\n/)
    .map(parseSseFrame)
    .filter((m): m is unknown => m !== undefined);
}

export function parseSseFrame(frame: string): unknown | undefined {
  const data = frame
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trimStart())
    .join('\n');
  if (!data) return undefined;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
}

function parseJsonOrBatch(text: string): unknown[] {
  const parsed = JSON.parse(text) as unknown;
  return Array.isArray(parsed) ? parsed : [parsed];
}

export type { JsonRpcRequest, JsonRpcResponse };
