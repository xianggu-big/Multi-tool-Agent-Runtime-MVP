// scripts/mcp-e2e.ts — 真实模型自主选择 MCP 工具的端到端探针（T5）
//
// 与 `mcp:probe` 的区别：
//   - mcp:probe 直接调 MCP client，验证「协议/传输」；不经过模型；
//   - 本脚本跑一个真实 run：模型必须自己看见 mcp_* 工具、自己发起 tool call，
//     我们再从落盘事件里核对（不是看最终答案像不像）。
//
// 流程：本进程起 HTTP 服务（自带 /mcp）→ 先连/重连 MCP → POST /api/runs（真实 DeepSeek）
//      → 轮询终态 → 断言事件里有 mcp_hub_knowledge_stats 的 tool_call_requested。
//
// 用法：DEEPSEEK_API_KEY=... npm run mcp:e2e
// 退出码：0 通过；1 模型没调用 MCP / run 失败；2 前置条件缺失。

import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';

const TOOL = 'mcp_hub_knowledge_stats';
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'limit_reached', 'awaiting_user']);

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolvePort(port));
    });
  });
}

async function main(): Promise<number> {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error('[mcp-e2e] 缺少 DEEPSEEK_API_KEY');
    return 2;
  }
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'mta-mcp-e2e-'));
  const config = loadConfig();
  config.sqlitePath = join(dir, 'runtime.db');
  config.log.errorLogPath = join(dir, 'errors.log');
  config.stream.liveDeltas = false;
  config.mcp = {
    servers: [{ name: 'hub', url: `http://127.0.0.1:${port}/mcp`, names: ['knowledge_stats'], timeoutMs: 5000 }],
    toolNames: [],
  };

  const { app, store } = createApp(config);
  const http = app.listen(port);
  await new Promise<void>((r) => http.once('listening', () => r()));
  const base = `http://127.0.0.1:${port}`;
  try {
    // 启动时 /mcp 还没监听（createApp 先跑），这里用 T4 的重连把它接上。
    const rc = await fetch(`${base}/api/mcp/reconnect`, { method: 'POST' });
    const mcpStatus = (await rc.json()) as { toolCount: number; tools: string[]; servers: Array<{ state: string }> };
    console.log(`[mcp-e2e] mcp state=${mcpStatus.servers[0]?.state} tools=${mcpStatus.tools.join(',')}`);
    if (mcpStatus.toolCount !== 1 || !mcpStatus.tools.includes(TOOL)) {
      console.error('[mcp-e2e] MCP 工具未就绪');
      return 2;
    }

    const res = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runType: 'misc',
        goal:
          `先用 MCP 工具 ${TOOL} 获取知识库统计，再用 submit_result 汇报。` +
          `要求：必须先真实调用 ${TOOL}，不允许凭记忆或编造数字；items 里至少包含文档数与 chunk 数（字段名不同就按原样报）。`,
        repoPath: resolve('demo/codebase-sample'),
        llm: { mode: 'openai', provider: 'deepseek' },
        maxSteps: 6,
        maxModelCalls: 6,
        maxToolCalls: 6,
        tokenBudget: 50_000,
      }),
    });
    if (res.status !== 201) {
      console.error(`[mcp-e2e] 创建 run 失败：HTTP ${res.status} ${await res.text()}`);
      return 2;
    }
    const { runId } = (await res.json()) as { runId: string };
    console.log(`[mcp-e2e] runId=${runId}，等待终态…`);

    let status = '';
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const rec = store.getRun(runId);
      status = rec?.status ?? '';
      if (TERMINAL.has(status)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const rec = store.getRun(runId);
    const events = store.getEvents(runId);
    const requested = events.filter((e) => e.type === 'tool_call_requested');
    const names = requested.map((e) => String((e.data as { name?: unknown })?.name ?? ''));
    const calledMcp = names.includes(TOOL);
    console.log(`[mcp-e2e] status=${status} toolCalls=${names.join(' → ')}`);
    console.log(
      `[mcp-e2e] tokens=${rec?.usageJson ? JSON.parse(rec.usageJson).totalTokens : '?'} ` +
        `cost=$${rec?.usageJson ? Number(JSON.parse(rec.usageJson).costUsd ?? 0).toFixed(6) : '?'} ` +
        `duration=${rec ? Math.round(rec.totalDurationMs) + 'ms' : '?'}`,
    );
    console.log(`[mcp-e2e] answer=${(rec?.finalAnswer ?? '').slice(0, 300)}`);

    if (status !== 'completed') {
      console.error('[mcp-e2e] FAIL：run 未完成');
      return 1;
    }
    if (!calledMcp) {
      console.error(`[mcp-e2e] FAIL：模型没有发起 ${TOOL} 调用（工具池里有工具但没被选择）`);
      return 1;
    }
    console.log('[mcp-e2e] PASS：模型自主调用 MCP 工具，事件可复核');
    return 0;
  } finally {
    await new Promise<void>((r) => http.close(() => r()));
    store.close();
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`[mcp-e2e] 异常：${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    process.exit(1);
  },
);
