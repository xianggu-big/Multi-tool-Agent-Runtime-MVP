// src/runtime/toolPool.ts — 各 runType 的工具池唯一真值
//
// 之前工具池在 AgentRuntime.resolveAllowedTools() 与 server.ts 的 miscLimits 回显里各写一份，
// 接 MCP 后立刻漂移（回显里没有 mcp_*）。这里收口成一个纯函数：执行与回显共用。

import type { RunType } from '../types.js';

export interface ToolPoolOptions {
  /** codebase 的 run_tests 是否开启（默认关闭时不进池） */
  runTestsEnabled: boolean;
  /** orchestrator 是否给主 Agent 只读自检工具 */
  allowSelfTools: boolean;
  /** 已就绪的 MCP 工具（mcp_<server>_<tool>） */
  mcpTools: string[];
}

export function toolPoolFor(runType: RunType, opts: ToolPoolOptions): string[] {
  if (runType === 'codebase') {
    return [
      'search_files',
      'read_file',
      'list_files',
      ...(opts.runTestsEnabled ? ['run_tests'] : []),
      'knowledge_search',
      'ask_user',
      ...opts.mcpTools,
    ];
  }
  if (runType === 'misc') {
    // 只读：无写文件、无命令执行、无联网；submit_result 是唯一的「产出」通道
    return ['list_files', 'search_files', 'read_file', 'dir_stats', 'submit_result', 'ask_user', ...opts.mcpTools];
  }
  if (runType === 'orchestrator') {
    // 主 Agent 的默认能力：只「派发」与「汇总」；可选开自检工具（只读）
    return [
      'delegate_subtasks',
      'submit_orchestration',
      ...(opts.allowSelfTools
        ? ['list_files', 'search_files', 'read_file', 'dir_stats', 'knowledge_search', ...opts.mcpTools]
        : []),
      'ask_user',
    ];
  }
  return ['web_search', 'fetch_page', 'extract_evidence', 'compare_sources', 'knowledge_search', 'ask_user', ...opts.mcpTools];
}
