// src/mcp/protocol.ts — MCP 的最小 JSON-RPC 2.0 协议类型
//
// MCP（Model Context Protocol）不是“另一个 function calling”，而是“工具/资源/提示词
// 的发现与调用协议”。模型仍然通过 function calling 决定调用哪个工具；MCP 解决的是
// “工具从哪里来、如何发现、如何跨进程/跨网络调用”。

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  /** 通知（notification）没有 id */
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpToolCallResult {
  content: McpTextContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: {
    tools?: { listChanged?: boolean };
    resources?: { subscribe?: boolean; listChanged?: boolean };
    prompts?: { listChanged?: boolean };
  };
  serverInfo: { name: string; version: string };
  instructions?: string;
}

export const MCP_PROTOCOL_VERSION = '2024-11-05';

export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export class McpProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'McpProtocolError';
  }
}

export function isJsonRpcRequest(x: unknown): x is JsonRpcRequest {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return o.jsonrpc === '2.0' && typeof o.method === 'string';
}
