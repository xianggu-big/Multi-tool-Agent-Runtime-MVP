// tests/64_mcp_config.test.ts — MCP 配置入口：解析/校验、白名单桥接、失败隔离、状态接口
//
// 设计边界：
//   - 默认不连接任何外部 MCP（MTA_MCP_SERVERS 为空 → configured=0）；
//   - names 必填 = 用户显式授权要暴露哪些工具，避免 54 个 schema 全塞进上下文；
//   - 单个 server 失败只标 error + 上报 MCP_UNAVAILABLE，不影响 HTTP 服务与其它 server；
//   - token 只进请求头，不出现在状态接口、错误消息或事件里。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';
import { mcpToolPrefix, parseMcpServers, redactMcpUrl } from '../src/mcp/config.js';
import { McpClientRuntime } from '../src/mcp/bootstrap.js';
import { toolPoolFor } from '../src/runtime/toolPool.js';
import { ToolRegistry } from '../src/tools/Registry.js';
import { okResult } from '../src/tools/types.js';
import { ErrorReporter } from '../src/runtime/errorReporter.js';
import { loadConfig } from '../src/config.js';
import { makeCtx } from './helpers.js';

function tmpConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'mta-mcp-cfg-'));
  const config = loadConfig();
  config.sqlitePath = join(dir, 'runtime.db');
  config.log.errorLogPath = join(dir, 'errors.log');
  // 不读本机环境里的 MCP 配置：本文件只测显式传入的 server。
  config.mcp = { servers: [], toolNames: [] };
  return config;
}

async function listen(app: { listen: (port: number) => import('node:http').Server }) {
  const http = app.listen(0);
  await new Promise<void>((resolve) => http.once('listening', resolve));
  const port = (http.address() as { port: number }).port;
  return { http, base: `http://127.0.0.1:${port}` };
}

test('64a) 配置解析：默认/自定义超时、工具名去重、前缀隔离', () => {
  const specs = parseMcpServers(
    JSON.stringify([
      { name: 'hub', url: 'http://127.0.0.1:9060/mcp', names: ['kb_search', 'kb_search', 'knowledge_stats'] },
      { name: 'docs_2', url: 'https://mcp.example.com/sse', token: 't-1', names: ['search'], timeoutMs: 30000 },
    ]),
  );
  assert.equal(specs.length, 2);
  assert.equal(specs[0].timeoutMs, 15_000);
  assert.deepEqual(specs[0].names, ['kb_search', 'knowledge_stats']);
  assert.equal(specs[0].token, undefined);
  assert.equal(specs[1].timeoutMs, 30_000);
  assert.equal(specs[1].token, 't-1');
  assert.equal(mcpToolPrefix('docs_2'), 'mcp_docs_2_');
  assert.deepEqual(parseMcpServers(undefined), []);
  assert.deepEqual(parseMcpServers('   '), []);
});

test('64b) 配置校验：非法 JSON / 缺 names / 重名 / 内嵌凭据 / 非 http / 超时越界都 fail-fast', () => {
  const cases: Array<[string, RegExp]> = [
    ['{not json', /不是合法 JSON/],
    ['{}', /顶层必须是数组/],
    [JSON.stringify([{ name: 'a', url: 'http://x/mcp' }]), /names 必须是非空数组/],
    [JSON.stringify([{ name: 'a', url: 'http://x/mcp', names: ['t'] }, { name: 'a', url: 'http://y/mcp', names: ['t'] }]), /重复/],
    [JSON.stringify([{ name: 'a', url: 'http://u:p@x/mcp', names: ['t'] }]), /不允许内嵌用户名\/密码/],
    [JSON.stringify([{ name: 'a', url: 'ftp://x/mcp', names: ['t'] }]), /只允许 http\/https/],
    [JSON.stringify([{ name: 'a', url: 'http://x/mcp', names: ['t'], timeoutMs: 10 }]), /timeoutMs/],
    [JSON.stringify([{ name: 'a', url: 'http://x/mcp', names: [] }]), /names 必须是非空数组/],
    [JSON.stringify([{ name: 'bad name', url: 'http://x/mcp', names: ['t'] }]), /name 必须是/],
  ];
  for (const [raw, re] of cases) assert.throws(() => parseMcpServers(raw), re);
});

test('64c) 状态 URL 脱敏：去掉凭据、query 与 hash', () => {
  assert.equal(redactMcpUrl('https://user:pass@mcp.example.com/mcp?token=secret#frag'), 'https://mcp.example.com/mcp');
  assert.equal(redactMcpUrl('http://127.0.0.1:9060/mcp'), 'http://127.0.0.1:9060/mcp');
});

test('64d) 真实 HTTP MCP：只桥接白名单、带 server 前缀、状态不含 token、Registry 用 mcp:call 放行', { timeout: 30_000 }, async () => {
  const { createApp } = await import('../src/server.js');
  const config = tmpConfig();
  const { app } = createApp(config);
  const { http, base } = await listen(app);
  const registry = new ToolRegistry();
  const errors = new ErrorReporter({ console: false });
  let exposed: string[] = [];
  const runtime = new McpClientRuntime(
    [{ name: 'hub', url: `${base}/mcp`, token: 'secret-token-123456', names: ['knowledge_stats', 'does_not_exist'], timeoutMs: 5000 }],
    registry,
    errors,
    (names) => { exposed = names; },
  );
  try {
    await runtime.start();
    const status = runtime.status();
    assert.equal(status.configured, 1);
    assert.equal(status.ready, true);
    assert.equal(status.servers[0].state, 'ready');
    // 白名单只放 knowledge_stats：kb_search 即便 server 提供了也不能被桥接
    assert.deepEqual(status.tools, ['mcp_hub_knowledge_stats']);
    assert.deepEqual(exposed, ['mcp_hub_knowledge_stats']);
    // 白名单里 server 没提供的工具要显式列出来，而不是静默当作成功
    assert.deepEqual(status.servers[0].missing, ['does_not_exist']);
    assert.equal(registry.has('mcp_hub_kb_search'), false);
    // token 不进状态视图（含错误消息）
    assert.equal(JSON.stringify(status).includes('secret-token-123456'), false);

    const denied = await registry.execute('mcp_hub_knowledge_stats', {}, makeCtx({ allowedPermissions: [] }));
    assert.equal(denied.result.ok, false);
    assert.match(denied.result.error?.message ?? '', /权限不足/);
    const ok = await registry.execute('mcp_hub_knowledge_stats', {}, makeCtx({ allowedPermissions: ['mcp:call'] }));
    assert.equal(ok.result.ok, true);
  } finally {
    await runtime.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

test('64e) 失败隔离：不可达 server 只标 error + MCP_UNAVAILABLE，另一个 server 照常 ready', { timeout: 30_000 }, async () => {
  const { createApp } = await import('../src/server.js');
  const config = tmpConfig();
  const { app } = createApp(config);
  const { http, base } = await listen(app);
  const registry = new ToolRegistry();
  const errors = new ErrorReporter({ console: false });
  const runtime = new McpClientRuntime(
    [
      { name: 'dead', url: 'http://127.0.0.1:1/mcp', token: 'dead-secret-987654', names: ['x'], timeoutMs: 1000 },
      { name: 'live', url: `${base}/mcp`, names: ['knowledge_stats'], timeoutMs: 5000 },
    ],
    registry,
    errors,
  );
  try {
    await runtime.start(); // 不抛到进程外
    const status = runtime.status();
    const dead = status.servers.find((s) => s.name === 'dead')!;
    const live = status.servers.find((s) => s.name === 'live')!;
    assert.equal(dead.state, 'error');
    assert.equal(live.state, 'ready');
    assert.deepEqual(live.tools, ['mcp_live_knowledge_stats']);
    assert.equal(JSON.stringify(status).includes('dead-secret-987654'), false);
    const reports = errors.list({ code: 'MCP_UNAVAILABLE' });
    assert.equal(reports.length, 1);
    assert.equal(reports[0].context?.server, 'dead');
  } finally {
    await runtime.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

test('64f) 未配置：GET /api/mcp 返回 configured=0，不发起外部连接', { timeout: 30_000 }, async () => {
  const { createApp } = await import('../src/server.js');
  const config = tmpConfig();
  const { app, mcpRuntime } = createApp(config);
  const { http, base } = await listen(app);
  try {
    const res = await fetch(`${base}/api/mcp`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { configured: number; ready: boolean; toolCount: number; servers: unknown[] };
    assert.equal(body.configured, 0);
    assert.equal(body.ready, true);
    assert.equal(body.toolCount, 0);
    assert.deepEqual(body.servers, []);
    assert.deepEqual(mcpRuntime.status().tools, []);
  } finally {
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

test('64g) 工具池唯一真值：MCP 工具按 runType 注入，orchestrator 受 allowSelfTools 控制', () => {
  const mcpTools = ['mcp_hub_date'];
  assert.deepEqual(toolPoolFor('misc', { runTestsEnabled: false, allowSelfTools: false, mcpTools }).slice(-1), mcpTools);
  assert.ok(!toolPoolFor('orchestrator', { runTestsEnabled: false, allowSelfTools: false, mcpTools }).includes('mcp_hub_date'));
  assert.ok(toolPoolFor('orchestrator', { runTestsEnabled: false, allowSelfTools: true, mcpTools }).includes('mcp_hub_date'));
  // run_tests 默认不进池
  assert.ok(!toolPoolFor('codebase', { runTestsEnabled: false, allowSelfTools: false, mcpTools }).includes('run_tests'));
  assert.ok(toolPoolFor('codebase', { runTestsEnabled: true, allowSelfTools: false, mcpTools }).includes('run_tests'));
});

test('64h) POST /api/runs 的 miscLimits 回显与执行期共用工具池（含已就绪 MCP 工具）', { timeout: 30_000 }, async () => {
  const { createApp } = await import('../src/server.js');
  const config = tmpConfig();
  config.mcp = { servers: [], toolNames: ['mcp_hub_date'] };
  const { app, registry } = createApp(config);
  registry.register({
    name: 'mcp_hub_date',
    description: '测试占位 MCP 工具',
    inputSchema: z.object({}),
    permission: 'mcp:call',
    riskLevel: 'safe',
    timeoutMs: 1000,
    execute: async () => okResult({ ok: true }, 0),
  });
  const { http, base } = await listen(app);
  try {
    const res = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runType: 'misc',
        goal: '现在几号',
        repoPath: resolve('demo/codebase-sample'),
        mockScenario: 'misc-basic',
      }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { runId: string; miscLimits: { allowedTools: string[] } };
    assert.ok(body.miscLimits.allowedTools.includes('mcp_hub_date'));
    assert.ok(body.miscLimits.allowedTools.includes('submit_result'));
    await fetch(`${base}/api/runs/${body.runId}/cancel`, { method: 'POST' });
  } finally {
    await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
  }
});

/** 取一个当前空闲的端口（只 listen/close，不建连接；用于“先失败、后恢复”的重连场景）。 */
async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolvePort(port));
    });
  });
}

test('64i) 手动重连：error → ready 可恢复，重连不产生同名工具冲突', { timeout: 30_000 }, async () => {
  const { createApp } = await import('../src/server.js');
  const config = tmpConfig();
  const { app } = createApp(config);
  const port = await freePort();
  const registry = new ToolRegistry();
  const errors = new ErrorReporter({ console: false });
  const runtime = new McpClientRuntime(
    [{ name: 'hub', url: `http://127.0.0.1:${port}/mcp`, names: ['knowledge_stats'], timeoutMs: 1000 }],
    registry,
    errors,
  );
  let http: import('node:http').Server | null = null;
  try {
    // 先连一个没人监听的端口：失败但进程不崩，状态如实标 error。
    await runtime.start();
    assert.equal(runtime.status().servers[0].state, 'error');
    assert.equal(runtime.status().toolCount, 0);

    // 服务起来后重连 → 恢复 ready（不需要重启本进程）
    http = app.listen(port);
    await new Promise<void>((r) => http!.once('listening', () => r()));
    const recovered = await runtime.reconnect('hub');
    assert.equal(recovered.servers[0].state, 'ready');
    assert.deepEqual(recovered.tools, ['mcp_hub_knowledge_stats']);
    assert.equal(registry.has('mcp_hub_knowledge_stats'), true);

    // 再次重连（正常状态）：先摘工具再注册，不能抛「工具已注册」
    const again = await runtime.reconnect('hub');
    assert.equal(again.tools.length, 1);
    assert.equal(again.servers[0].state, 'ready');
    const call = await registry.execute('mcp_hub_knowledge_stats', {}, makeCtx({ allowedPermissions: ['mcp:call'] }));
    assert.equal(call.result.ok, true, '重连后的工具仍可执行');

    // 未知 server：显式报错（HTTP 层转 404），不能静默返回成功
    await assert.rejects(() => runtime.reconnect('nope'), /未配置 MCP server/);
  } finally {
    await runtime.close();
    if (http) await new Promise<void>((r) => http!.close(() => r()));
  }
});

test('64j) POST /api/mcp/reconnect：参数校验 + 未知 server 404', { timeout: 30_000 }, async () => {
  const { createApp } = await import('../src/server.js');
  const config = tmpConfig();
  const { app } = createApp(config);
  const { http, base } = await listen(app);
  try {
    const bad = await fetch(`${base}/api/mcp/reconnect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 123 }),
    });
    assert.equal(bad.status, 400);

    const unknown = await fetch(`${base}/api/mcp/reconnect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'nope' }),
    });
    assert.equal(unknown.status, 404);

    // 未配置任何 server：全部重连是合法的 no-op
    const all = await fetch(`${base}/api/mcp/reconnect`, { method: 'POST' });
    assert.equal(all.status, 200);
    const body = (await all.json()) as { configured: number; toolCount: number };
    assert.equal(body.configured, 0);
    assert.equal(body.toolCount, 0);
  } finally {
    await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
  }
});
