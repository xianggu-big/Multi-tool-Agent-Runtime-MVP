// tests/44_mcp.test.ts — MCP P1：JSON-RPC 生命周期 / 三种 transport / 桥接进 Tool Registry
//
// 关系一句话：MCP 是「工具从哪来、怎么发现与跨进程调用」的协议；
// function calling 是「模型如何选择工具」的模型能力。桥接后两者共用一份 ToolDefinition。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { McpServer } from '../src/mcp/server.js';
import { McpClient } from '../src/mcp/client.js';
import { HttpTransport, StdioTransport, createInMemoryTransportPair } from '../src/mcp/transport.js';
import { registerMcpTools } from '../src/mcp/bridge.js';
import { JSON_RPC_ERRORS, type McpToolCallResult } from '../src/mcp/protocol.js';
import { ToolRegistry } from '../src/tools/Registry.js';
import { makeCtx } from './helpers.js';
import { loadConfig } from '../src/config.js';

function makeServer(): McpServer {
  const server = new McpServer({ name: 'test-mcp', version: '0.0.1', instructions: 'test' });
  server.registerTool({
    name: 'echo',
    description: '回显',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    handler: (args) => ({ echo: String(args.text ?? '') }),
  });
  server.registerTool({
    name: 'add',
    description: '相加',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
      additionalProperties: false,
    },
    handler: (args) => {
      if (typeof args.a !== 'number' || typeof args.b !== 'number') throw new Error('a/b 必须是数字');
      return { sum: args.a + args.b };
    },
  });
  return server;
}

async function connectInMemory(): Promise<{ client: McpClient; server: McpServer }> {
  const server = makeServer();
  const [clientT, serverT] = createInMemoryTransportPair();
  serverT.onMessage(async (msg) => {
    const out = Array.isArray(msg) ? await server.handleBatch(msg) : await server.handle(msg);
    if (out !== null) await serverT.send(out);
  });
  const client = new McpClient(clientT, { timeoutMs: 2000 });
  return { client, server };
}

test('44a) in-memory：initialize → tools/list → tools/call；错误分层符合 MCP 约定', async () => {
  const { client } = await connectInMemory();
  try {
    const init = await client.connect();
    assert.equal(init.protocolVersion, '2024-11-05');
    assert.equal(init.serverInfo.name, 'test-mcp');

    const tools = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['add', 'echo']);
    assert.deepEqual(tools.find((t) => t.name === 'add')!.inputSchema.required, ['a', 'b']);

    const echo = await client.callTool('echo', { text: '你好' });
    assert.equal(echo.structuredContent && (echo.structuredContent as { echo: string }).echo, '你好');
    const sum = await client.callTool('add', { a: 1, b: 2 });
    assert.deepEqual(sum.structuredContent, { sum: 3 });

    // 缺必填参数 = 协议层 INVALID_PARAMS
    await assert.rejects(
      () => client.callTool('add', { a: 1 }),
      (e: unknown) => (e as { code?: number }).code === JSON_RPC_ERRORS.INVALID_PARAMS,
    );
    // 工具执行抛错 = result.isError（不是 JSON-RPC error）
    const bad: McpToolCallResult = await client.callTool('add', { a: 'x', b: 2 });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /执行失败/);
    // 未知方法 = METHOD_NOT_FOUND
    await assert.rejects(
      () => client.request('tools/nope'),
      (e: unknown) => (e as { code?: number }).code === JSON_RPC_ERRORS.METHOD_NOT_FOUND,
    );
  } finally {
    await client.close();
  }
});

test('44b) 桥接：MCP 工具变成普通 Tool，JSON Schema 原样暴露，权限仍由 Registry 把关', async () => {
  const { client } = await connectInMemory();
  try {
    await client.connect();
    const registry = new ToolRegistry();
    const names = await registerMcpTools(registry, client, { prefix: 'mcp_', permission: 'mcp:call' });
    assert.deepEqual(names.sort(), ['mcp_add', 'mcp_echo']);

    const def = registry.toDefinitions().find((d) => d.name === 'mcp_add')!;
    assert.equal((def.inputSchema as { required?: string[] }).required?.join(','), 'a,b');

    const denied = await registry.execute('mcp_add', { a: 1, b: 2 }, makeCtx({ allowedPermissions: [] }));
    assert.equal(denied.result.ok, false);
    assert.match(denied.result.error?.message ?? '', /权限不足/);

    const ok = await registry.execute('mcp_add', { a: 2, b: 5 }, makeCtx({ allowedPermissions: ['mcp:call'] }));
    assert.equal(ok.result.ok, true);
    assert.deepEqual(ok.result.data, { sum: 7 });
  } finally {
    await client.close();
  }
});

test('44c) stdio transport：真实子进程 JSON Lines，listTools + add', { timeout: 30_000 }, async () => {
  const transport = new StdioTransport({
    command: process.execPath,
    args: ['--import', 'tsx', join(process.cwd(), 'scripts', 'mcp-server.ts')],
    cwd: process.cwd(),
    env: process.env,
  });
  const client = new McpClient(transport, { timeoutMs: 15_000 });
  try {
    const init = await client.connect();
    assert.equal(init.serverInfo.name, 'mta-mcp-demo');
    const tools = await client.listTools();
    assert.ok(tools.some((t) => t.name === 'add'));
    const sum = await client.callTool('add', { a: 40, b: 2 });
    assert.deepEqual(sum.structuredContent, { sum: 42 });
  } finally {
    await client.close();
  }
});

test('44d) Streamable HTTP：同一 McpServer 走 POST /mcp，客户端可用 HttpTransport', async () => {
  const { createApp } = await import('../src/server.js');
  const config = loadConfig();
  const dir = mkdtempSync(join(tmpdir(), 'mta-mcp-http-'));
  config.sqlitePath = join(dir, 'runtime.db');
  config.log.errorLogPath = join(dir, 'errors.log');
  const { app, knowledge } = createApp(config);
  const http = app.listen(0);
  await new Promise<void>((resolve) => http.once('listening', resolve));
  const port = (http.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    knowledge.putData({
      collection: 'notes',
      itemId: 'rag-note',
      type: 'finding',
      content: { title: '审批', body: '审批超时后按拒绝处理，并记录原因。' },
      createdBy: 'test',
    });

    const raw = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(raw.status, 200);
    const payload = await raw.json() as { result?: { tools?: Array<{ name: string }> } };
    assert.ok(payload.result?.tools?.some((t) => t.name === 'knowledge_stats'));

    const client = new McpClient(new HttpTransport({ url: `${base}/mcp`, timeoutMs: 5000 }), { timeoutMs: 5000 });
    try {
      await client.connect();
      const stats = await client.callTool('knowledge_stats', {});
      assert.ok(stats.content.length > 0);

      // kb_search 必须走切块级 RAG 管线（返回 chunkId/docId），而不是旧的 FTS5 混合结果。
      const kb = await client.callTool('kb_search', { query: '审批超时', limit: 3 });
      const kbData = kb.structuredContent as { hits?: Array<{ chunkId?: string; docId?: string; text?: string }> };
      assert.ok((kbData.hits?.length ?? 0) >= 1);
      assert.ok(kbData.hits?.[0]?.chunkId);
      assert.ok(kbData.hits?.[0]?.docId);
      assert.match(kbData.hits?.[0]?.text ?? '', /审批超时/);
    } finally {
      await client.close();
    }

    const getRes = await fetch(`${base}/mcp`);
    assert.equal(getRes.status, 405);

    // 切块级 RAG 路由：重建（HNSW）→ 检索 → 状态
    const rebuilt = await fetch(`${base}/api/rag/rebuild`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ indexKind: 'hnsw', chunkSize: 128, overlap: 16 }),
    });
    assert.equal(rebuilt.status, 200);
    const stats = await rebuilt.json() as { chunks?: number; index?: { kind?: string } };
    assert.ok((stats.chunks ?? 0) >= 1);
    assert.equal(stats.index?.kind, 'hnsw');

    const searched = await fetch(`${base}/api/rag/search?q=${encodeURIComponent('审批超时')}&mode=hybrid_rerank&k=3`);
    assert.equal(searched.status, 200);
    const payloadSearch = await searched.json() as { count?: number; results?: Array<{ docId: string; text: string }> };
    assert.ok((payloadSearch.count ?? 0) >= 1);
    assert.ok(payloadSearch.results?.some((h) => h.text.includes('审批超时')));
    const ragStats = await fetch(`${base}/api/rag/stats`);
    assert.equal(ragStats.status, 200);
    assert.ok((await ragStats.json() as { chunks?: number }).chunks);
  } finally {
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

test('44e) 桥接风险按 annotations 推断；取消信号能穿透 client/server', async () => {
  const server = new McpServer({ name: 'risk-mcp', version: '0.0.1' });
  const schema = { type: 'object', properties: {}, additionalProperties: false };
  server.registerTool({ name: 'read', description: '只读', inputSchema: schema, annotations: { readOnlyHint: true }, handler: () => ({ ok: true }) });
  server.registerTool({ name: 'destroy', description: '危险', inputSchema: schema, annotations: { destructiveHint: true }, handler: () => ({ ok: true }) });
  server.registerTool({ name: 'plain', description: '未声明', inputSchema: schema, handler: () => ({ ok: true }) });
  server.registerTool({
    name: 'slow',
    description: '慢工具',
    inputSchema: schema,
    handler: (_args, ctx) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ done: true }), 2000);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error('aborted by client'));
        };
        if (ctx.signal?.aborted) return onAbort();
        ctx.signal?.addEventListener('abort', onAbort, { once: true });
      }),
  });

  const [clientT, serverT] = createInMemoryTransportPair();
  serverT.onMessage(async (msg) => {
    const out = Array.isArray(msg) ? await server.handleBatch(msg) : await server.handle(msg);
    if (out !== null) await serverT.send(out);
  });
  const client = new McpClient(clientT, { timeoutMs: 5000 });
  try {
    await client.connect();
    const registry = new ToolRegistry();
    await registerMcpTools(registry, client, { permission: 'mcp:call' });
    assert.equal(registry.get('mcp_read')!.riskLevel, 'safe', 'readOnlyHint → safe');
    assert.equal(registry.get('mcp_destroy')!.riskLevel, 'high', 'destructiveHint → high');
    assert.equal(registry.get('mcp_plain')!.riskLevel, 'medium', '未声明时不能默认 safe（避免自动重试副作用）');

    const ac = new AbortController();
    const started = Date.now();
    const pending = registry.execute('mcp_slow', {}, makeCtx({ allowedPermissions: ['mcp:call'], signal: ac.signal }));
    setTimeout(() => ac.abort(), 20);
    const out = await pending;
    assert.equal(out.result.ok, false);
    assert.ok(Date.now() - started < 1000, '取消应在超时/完成前返回');
    assert.match(out.result.error?.message ?? '', /取消|中止|abort/i);
  } finally {
    await client.close();
  }
});

test('44g) McpClient 超时会发 notifications/cancelled，server 主动 abort 工具', async () => {
  const server = new McpServer({ name: 'timeout-mcp', version: '0.0.1' });
  let aborted = false;
  server.registerTool({
    name: 'hang',
    description: '挂起工具',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (_args, ctx) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ done: true }), 5000);
        const onAbort = () => {
          aborted = true;
          clearTimeout(timer);
          reject(new Error('server aborted'));
        };
        if (ctx.signal?.aborted) return onAbort();
        ctx.signal?.addEventListener('abort', onAbort, { once: true });
      }),
  });
  const [clientT, serverT] = createInMemoryTransportPair();
  serverT.onMessage(async (msg) => {
    const out = Array.isArray(msg) ? await server.handleBatch(msg) : await server.handle(msg);
    if (out !== null) await serverT.send(out);
  });
  const client = new McpClient(clientT, { timeoutMs: 1000 });
  try {
    await client.connect();
    const started = Date.now();
    await assert.rejects(() => client.callTool('hang', {}), /超时/);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(aborted, true, '超时后 server 端工具应收到 abort');
    assert.ok(Date.now() - started < 2500, '超时路径不应等到工具自然结束');
  } finally {
    await client.close();
  }
});

test('44f) HttpTransport：SSE 增量解析（首帧先到）+ 自动回传 Mcp-Session-Id', async () => {
  const encoder = new TextEncoder();
  const first = encoder.encode('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"step":1}}\n\n');
  const second = encoder.encode('data: {"jsonrpc":"2.0","id":2,"result":{"step":2}}\n\n');
  let call = 0;
  const initSeen: Array<Record<string, string>> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    call += 1;
    initSeen.push(init.headers as Record<string, string>);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(call === 1 ? first : encoder.encode('data: {"jsonrpc":"2.0","id":9,"result":{}}\n\n'));
        setTimeout(() => {
          if (call === 1) controller.enqueue(second);
          controller.close();
        }, 40);
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' },
    });
  }) as unknown as typeof fetch;

  const transport = new HttpTransport({ url: 'http://example.test/mcp', fetchImpl, timeoutMs: 5000 });
  const seen: Array<{ id: unknown; at: number }> = [];
  const t0 = Date.now();
  transport.onMessage((m) => {
    const r = m as { id?: unknown };
    seen.push({ id: r.id, at: Date.now() - t0 });
  });
  const sending = transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(seen.length, 1, '第一帧解析后应立即回调，而不是等整个响应结束');
  await sending;
  assert.equal(seen.length, 2);
  assert.equal(transport.session, 'sess-1');

  await transport.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
  assert.equal(call, 2);
  assert.equal(initSeen[1]['mcp-session-id'], 'sess-1', '后续请求必须带上会话 id');
});
