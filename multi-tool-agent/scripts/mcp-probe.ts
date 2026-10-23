// scripts/mcp-probe.ts — 用真实 MCP server 验证「配置 → 连接 → 列工具 → 调工具」
//
// 用途：换了一个外部 MCP server（或轮换了 token）后，先用它确认链路，再写进 MTA_MCP_SERVERS。
// token 只从环境变量读，不落盘、不打印。
//
// 用法：
//   MTA_MCP_PROBE_URL=http://127.0.0.1:8900/mcp MTA_MCP_PROBE_TOKEN=<token> \
//     npm run mcp:probe
//   ... npm run mcp:probe -- --names=kb_search,knowledge_stats
//   ... npm run mcp:probe -- --call=kb_search --args='{"query":"审批超时"}'
//
// 退出码：0 成功；1 连接/调用失败；2 参数错误。

import { McpClient } from '../src/mcp/client.js';
import { HttpTransport } from '../src/mcp/transport.js';

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf('=');
  return eq >= 0 ? hit.slice(eq + 1) : 'true';
}

const url = process.env.MTA_MCP_PROBE_URL ?? arg('url');
const token = process.env.MTA_MCP_PROBE_TOKEN ?? '';
const timeoutMs = Number(arg('timeout-ms', '15000')) || 15_000;
const names = (arg('names') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const callTool = arg('call');
const callArgs = arg('args', '{}')!;

if (!url) {
  console.error('缺少 MTA_MCP_PROBE_URL（或 --url=）');
  process.exit(2);
}

let parsedArgs: unknown;
try {
  parsedArgs = JSON.parse(callArgs);
} catch {
  console.error('--args 必须是合法 JSON');
  process.exit(2);
}

const client = new McpClient(
  new HttpTransport({ url, timeoutMs, headers: token ? { authorization: `Bearer ${token}` } : {} }),
  { timeoutMs, clientName: 'mta-mcp-probe' },
);

try {
  const init = await client.connect();
  console.log(`[mcp-probe] connected: ${init.serverInfo.name} ${init.serverInfo.version} (protocol ${init.protocolVersion})`);
  const tools = await client.listTools();
  console.log(`[mcp-probe] tools: ${tools.length}`);
  const selected = names.length ? tools.filter((t) => names.includes(t.name)) : tools;
  const missing = names.filter((n) => !tools.some((t) => t.name === n));
  for (const t of selected) {
    const required = (t.inputSchema as { required?: string[] })?.required ?? [];
    console.log(`  - ${t.name}${required.length ? ` (required: ${required.join(', ')})` : ''} — ${(t.description ?? '').slice(0, 120)}`);
  }
  if (missing.length) console.log(`[mcp-probe] missing: ${missing.join(', ')}`);

  if (callTool) {
    if (!tools.some((t) => t.name === callTool)) {
      console.error(`[mcp-probe] 工具不存在：${callTool}`);
      process.exit(1);
    }
    const started = Date.now();
    const res = await client.callTool(callTool, (parsedArgs ?? {}) as Record<string, unknown>);
    const text = res.content.map((c) => ('text' in c ? c.text : '')).join('\n').slice(0, 2000);
    console.log(`[mcp-probe] call ${callTool} ${res.isError ? 'FAILED' : 'ok'} in ${Date.now() - started}ms`);
    console.log(text);
    if (res.isError) process.exitCode = 1;
  }
} catch (e) {
  console.error(`[mcp-probe] 失败：${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
