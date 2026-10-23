// src/mcp/config.ts — MCP 客户端配置解析（不回显 token）
//
// 主路径通过 MTA_MCP_SERVERS 显式 opt-in。默认不连接任何外部 MCP，
// 避免测试/本地演示在后台产生网络请求。

export interface McpServerConfig {
  /** 本地唯一名；用于生成工具前缀 mcp_<name>_ */
  name: string;
  /** Streamable HTTP 端点（http/https） */
  url: string;
  /** Bearer token；只放进请求头，不进入事件、日志或状态接口 */
  token?: string;
  /** 必须显式给出工具白名单，避免把 54 个 schema 全量塞进上下文 */
  names: string[];
  timeoutMs: number;
}

const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_SERVERS = 8;
const MAX_TOOLS_PER_SERVER = 100;
const MAX_TOOL_NAME_CHARS = 128;
const MAX_TOKEN_CHARS = 8192;

function configError(message: string): Error {
  return new Error(`MTA_MCP_SERVERS 配置错误：${message}`);
}

/** 解析 JSON 数组；空值 = 不启用 MCP。配置错误 fail-fast，避免“看起来启用了”。 */
export function parseMcpServers(raw: string | undefined): McpServerConfig[] {
  if (!raw || !raw.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw configError('不是合法 JSON（期望数组）');
  }
  if (!Array.isArray(parsed)) throw configError('顶层必须是数组');
  if (parsed.length > MAX_SERVERS) throw configError(`最多 ${MAX_SERVERS} 个 server`);

  const seen = new Set<string>();
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw configError(`第 ${index + 1} 项必须是对象`);
    }
    const obj = entry as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    if (!SERVER_NAME_RE.test(name)) {
      throw configError(`第 ${index + 1} 项的 name 必须是 1~40 位字母/数字/_/-`);
    }
    if (seen.has(name)) throw configError(`server name 重复：${name}`);
    seen.add(name);

    const rawUrl = typeof obj.url === 'string' ? obj.url.trim() : '';
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw configError(`${name}.url 不是合法 URL`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw configError(`${name}.url 只允许 http/https`);
    }
    if (url.username || url.password) {
      throw configError(`${name}.url 不允许内嵌用户名/密码，请用 token 字段`);
    }

    const token = typeof obj.token === 'string' ? obj.token.trim() : '';
    if (token.length > MAX_TOKEN_CHARS) throw configError(`${name}.token 过长`);

    if (!Array.isArray(obj.names) || obj.names.length === 0) {
      throw configError(`${name}.names 必须是非空数组（显式工具白名单）`);
    }
    if (obj.names.length > MAX_TOOLS_PER_SERVER) {
      throw configError(`${name}.names 最多 ${MAX_TOOLS_PER_SERVER} 项`);
    }
    const names: string[] = [];
    for (const rawName of obj.names) {
      const toolName = typeof rawName === 'string' ? rawName.trim() : '';
      if (!toolName || toolName.length > MAX_TOOL_NAME_CHARS) {
        throw configError(`${name}.names 含空值或超长工具名`);
      }
      if (!names.includes(toolName)) names.push(toolName);
    }

    const timeoutMs = Number(obj.timeoutMs ?? 15_000);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
      throw configError(`${name}.timeoutMs 必须是 1000~120000 的整数`);
    }

    return {
      name,
      url: url.toString(),
      token: token || undefined,
      names,
      timeoutMs: Math.trunc(timeoutMs),
    };
  });
}

/** 状态接口/日志用的安全 URL：去掉凭据、query 与 hash。 */
export function redactMcpUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return raw.split('?')[0].split('#')[0];
  }
}

/** 多 server 必须隔离命名，避免同名工具互相覆盖。 */
export function mcpToolPrefix(serverName: string): string {
  return `mcp_${serverName.replace(/[^A-Za-z0-9_-]/g, '_')}_`;
}
