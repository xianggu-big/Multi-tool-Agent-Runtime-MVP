// tests/64_mcp_config.test.ts — MCP 配置入口：解析/校验、白名单桥接、失败隔离、状态接口
//
// 设计边界：
//   - 默认不连接任何外部 MCP（MTA_MCP_SERVERS 为空 → configured=0）；
//   - names 必填 = 用户显式授权要暴露哪些工具，避免 54 个 schema 全塞进上下文；
//   - 单个 server 失败只标 error + 上报 MCP_UNAVAILABLE，不影响 HTTP 服务与其它 server；
//   - token 只进请求头，不出现在状态接口、错误消息或事件里。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpToolPrefix, parseMcpServers, redactMcpUrl } from '../src/mcp/config.js';
import { McpClientRuntime } from '../src/mcp/bootstrap.js';
import { ToolRegistry } from '../src/tools/Registry.js';
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
