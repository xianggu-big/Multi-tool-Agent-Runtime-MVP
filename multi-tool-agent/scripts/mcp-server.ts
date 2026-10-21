// scripts/mcp-server.ts — 最小 MCP stdio server（演示/联调用）
//
// 启动：
//   node --import tsx scripts/mcp-server.ts
// 协议：stdin/stdout 每行一个 JSON-RPC 2.0 消息；日志只写 stderr。

import { McpServer } from '../src/mcp/server.js';
import { serveStdio } from '../src/mcp/transport.js';

const server = new McpServer({
  name: 'mta-mcp-demo',
  version: '0.1.0',
  instructions: '演示用 MCP server：echo / add / now。',
});

server.registerTool({
  name: 'echo',
  description: '原样返回 text，用于验证 transport 与 JSON-RPC 链路。',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: '要回显的文本' } },
    required: ['text'],
    additionalProperties: false,
  },
  handler: (args) => ({ echo: String(args.text ?? '') }),
});

server.registerTool({
  name: 'add',
  description: '两个数字相加。',
  inputSchema: {
    type: 'object',
    properties: {
      a: { type: 'number' },
      b: { type: 'number' },
    },
    required: ['a', 'b'],
    additionalProperties: false,
  },
  handler: (args) => {
    const a = Number(args.a);
    const b = Number(args.b);
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('a/b 必须是数字');
    return { sum: a + b };
  },
});

server.registerTool({
  name: 'now',
  description: '返回服务器当前 ISO 时间。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: () => ({ now: new Date().toISOString() }),
});

serveStdio(server);
console.error('[mcp] stdio server ready');
