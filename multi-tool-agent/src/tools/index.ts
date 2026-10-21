// src/tools/index.ts — 注册全部工具
import { ToolRegistry } from './Registry.js';
import { searchFiles } from './codebase/searchFiles.js';
import { readFile } from './codebase/readFile.js';
import { listFiles } from './codebase/listFiles.js';
import { runTests } from './codebase/runTests.js';
import { webSearch } from './research/webSearch.js';
import { fetchPage } from './research/fetchPage.js';
import { extractEvidence } from './research/extractEvidence.js';
import { compareSources } from './research/compareSources.js';
import { dirStats } from './misc/dirStats.js';
import { submitResult } from './misc/submitResult.js';
import { submitFinding } from './orchestrator/submitFinding.js';
import { delegateSubtasks } from './orchestrator/delegateSubtasks.js';
import { submitOrchestration } from './orchestrator/submitOrchestration.js';
import { WRITE_TOOLS } from './codebase/writeTools.js';
import { createKnowledgeSearchTool } from './knowledge/searchKnowledge.js';
import { askUser } from './shared/askUser.js';
import type { KnowledgeHub } from '../knowledge/index.js';

export function buildRegistry(knowledge?: KnowledgeHub): ToolRegistry {
  const r = new ToolRegistry();
  r.register(searchFiles);
  r.register(readFile);
  r.register(listFiles);
  r.register(runTests);
  r.register(webSearch);
  r.register(fetchPage);
  r.register(extractEvidence);
  r.register(compareSources);
  // 杂项 Agent 专用：只读目录统计 + 结构化结论提交（终结性工具）
  r.register(dirStats);
  r.register(submitResult);
  // 多 Agent 编排：子 Agent 上报 + 主 Agent 扇出/汇总
  r.register(submitFinding);
  r.register(delegateSubtasks);
  r.register(submitOrchestration);
  // 人机协同：模型显式向用户提问（终态 awaiting_user，不是 completed）
  r.register(askUser);
  // 写能力（M1）：create/edit/delete/copy/run_command/submit_changes
  // 三重门禁：① 权限 codebase:write（只读 Agent 的工具池里没有它们 → 派生不出该权限）
  //          ② CODEBASE_WRITE_ENABLED=false 时返回 DISABLED
  //          ③ 未注入沙箱/审批通道（非 code-edit 契约）时返回 WRITE_UNAVAILABLE
  for (const t of WRITE_TOOLS) r.register(t);
  // RAG 主链路：lint/独立 Registry 没有 KnowledgeHub 时也能看到该工具（调用时明确报未装配）。
  r.register(createKnowledgeSearchTool(knowledge));
  return r;
}

export { ToolRegistry } from './Registry.js';
