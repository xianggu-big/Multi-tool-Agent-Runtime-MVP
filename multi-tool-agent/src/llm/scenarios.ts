// src/llm/scenarios.ts — 演示用 Mock 剧本响应器
// 这是一个“按上下文做出决策”的 Mock：它会读取上一轮工具结果，决定下一步调用，
// 用于在没有真实模型 Key 时展示多轮工具调用流程。
// 注意：这仅用于演示，结果明确标注为 MOCK。

import type { ChatMessage, ToolCall } from '../types.js';
import type { MockResponder } from './MockProvider.js';

function lastToolResult(messages: ChatMessage[]): { toolName?: string; content: string; isError: boolean } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'tool') {
      return { toolName: m.toolName, content: m.content, isError: !!m.isError };
    }
  }
  return null;
}

function safeParse(content: string): any {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function firstPathFromSearch(content: string): string | null {
  const parsed = safeParse(content);
  const matches: any[] = parsed?.data?.matches ?? [];
  for (const m of matches) {
    if (typeof m.file === 'string' && (m.file.endsWith('.ts') || m.file.endsWith('.js'))) return m.file;
  }
  const re = /([A-Za-z0-9_.\-/\\]+\.(?:ts|js))/g;
  const hit = re.exec(content);
  return hit ? hit[1] : null;
}

function firstUrl(content: string): string {
  const re = /(https?:\/\/[^\s"')\]]+)/;
  const hit = re.exec(content);
  return hit ? hit[1] : 'https://example.com/offline-source';
}

function tc(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, name, arguments: args };
}

/** Codebase 演示：search -> read -> run_tests -> 最终答案 */
export function codebaseDemoResponder(goal: string): MockResponder {
  return ({ messages, callIndex }) => {
    const last = lastToolResult(messages);
    if (callIndex === 0 || !last) {
      return {
        stopReason: 'tool_use',
        content: `我将先在仓库中搜索相关代码，定位目标文件。`,
        toolCalls: [tc('call_1', 'search_files', { pattern: 'export function', kind: 'content', limit: 20 })],
      };
    }
    if (last.toolName === 'search_files') {
      const file = firstPathFromSearch(last.content) ?? 'src/calc.ts';
      return {
        stopReason: 'tool_use',
        content: `搜索得到 ${file}，接下来读取该文件确认实现。`,
        toolCalls: [tc('call_2', 'read_file', { path: file, maxLines: 80 })],
      };
    }
    if (last.toolName === 'read_file') {
      return {
        stopReason: 'tool_use',
        content: `已读取实现，运行受限测试验证行为。`,
        toolCalls: [tc('call_3', 'run_tests', { command: 'node --test' })],
      };
    }
    // run_tests 之后给出最终答案
    const parsed = safeParse(last.content);
    const passed = parsed?.data?.exitCode === 0;
    return {
      stopReason: 'end_turn',
      content:
        `【Codebase 分析完成】\n目标：${goal}\n` +
        `1) 通过 search_files 定位到相关源文件。\n` +
        `2) 通过 read_file 阅读了实现细节。\n` +
        `3) 通过 run_tests 执行受限测试，结果：${passed ? '通过' : '见执行摘要'}。\n` +
        `结论：该仓库代码结构清晰，核心函数在测试覆盖范围内工作正常。`,
    };
  };
}

/** Research 演示：web_search -> extract_evidence -> compare_sources -> 最终答案 */
export function researchDemoResponder(goal: string): MockResponder {
  return ({ messages, callIndex }) => {
    const last = lastToolResult(messages);
    if (callIndex === 0 || !last) {
      return {
        stopReason: 'tool_use',
        content: `我先检索关于这两个开源项目的公开资料。`,
        toolCalls: [tc('call_1', 'web_search', { query: goal || 'compare esbuild vs rollup bundlers', limit: 8 })],
      };
    }
    if (last.toolName === 'web_search') {
      const url = firstUrl(last.content);
      return {
        stopReason: 'tool_use',
        content: `检索到资料，提取与问题相关的证据并保留来源。`,
        toolCalls: [
          tc('call_2', 'extract_evidence', {
            text: last.content,
            question: goal,
            sourceUrl: url,
          }),
        ],
      };
    }
    if (last.toolName === 'extract_evidence') {
      const parsed = safeParse(last.content);
      const items = Array.isArray(parsed?.data?.evidence)
        ? parsed.data.evidence.map((e: any) => ({
            claim: typeof e.claim === 'string' ? e.claim : String(e.claim ?? ''),
            sourceUrl: e.sourceUrl ?? 'unknown',
            support: 'supported',
          }))
        : [{ claim: '（无法从上一结果解析证据）', sourceUrl: 'unknown', support: 'unknown' }];
      return {
        stopReason: 'tool_use',
        content: `基于证据进行结构化比较。`,
        toolCalls: [tc('call_3', 'compare_sources', { items })],
      };
    }
    return {
      stopReason: 'end_turn',
      content:
        `【Research 报告】（基于 MOCK 离线资料，非实时联网）\n目标：${goal}\n` +
        `已通过 web_search 检索、extract_evidence 提取证据、compare_sources 形成比较。` +
        `详见上方 compare_sources 结构化结果与来源引用。`,
    };
  };
}

/** 杂项演示：dir_stats 清点 → submit_result 提交结构化结论（终结性工具） */
export function miscDemoResponder(goal: string): MockResponder {
  return ({ messages, callIndex }) => {
    const last = lastToolResult(messages);
    if (callIndex === 0 || !last) {
      return {
        stopReason: 'tool_use',
        content: '这是清点类小事，直接用目录统计工具拿事实。',
        toolCalls: [tc('call_1', 'dir_stats', { dir: '.', maxDepth: 4, topN: 5 })],
      };
    }
    const parsed = safeParse(last.content);
    const data = parsed?.data ?? {};
    const fileCount = data.fileCount ?? '未知';
    const totalSize = data.totalSizeHuman ?? '未知';
    const extensions = Array.isArray(data.extensions) ? data.extensions.slice(0, 3) : [];
    return {
      stopReason: 'tool_use',
      content: '拿到统计结果，提交结构化结论。',
      toolCalls: [
        tc('call_2', 'submit_result', {
          summary: `（MOCK）该目录共 ${fileCount} 个文件，合计 ${totalSize}；统计只覆盖未忽略的目录。`,
          items: [
            { label: '文件总数', value: fileCount },
            { label: '总大小', value: String(totalSize) },
            ...extensions.map((e: any, i: number) => ({
              label: `扩展名 ${i + 1}`,
              value: `${e.ext} × ${e.count}`,
            })),
          ],
          findings: [],
        }),
      ],
    };
  };
}

/**
 * 编排演示：主 Agent 扇出 2 个子 Agent → 子 Agent 各自用自己的工具 → 主 Agent 汇总。
 * 同一个 MockProvider 实例会被主/子 Agent 共用，因此按「可用工具名」区分当前是谁在说话：
 *   delegate_subtasks → 主 Agent；dir_stats → 清点子 Agent；search_files → 审计子 Agent；web_search → 调研子 Agent。
 */
export function orchestratorDemoResponder(goal: string): MockResponder {
  return (ctx) => {
    const names = ctx.tools.map((t) => t.name);

    // ---- 主 Agent ----
    if (names.includes('delegate_subtasks')) {
      if (ctx.callIndex === 0) {
        return {
          stopReason: 'tool_use',
          content: '先按目录把活切成两个独立子任务：清点 + 审计。',
          toolCalls: [
            tc('call_1', 'delegate_subtasks', {
              subtasks: [
                {
                  specId: 'dir-inventory',
                  objective: '清点 src 目录的文件数与扩展名分布',
                  inputs: { dir: 'src' },
                  expectedOutput: '文件数、总大小、扩展名 Top3',
                },
                {
                  specId: 'code-audit',
                  objective: '审计 src 目录：找出 TODO/FIXME 与可疑硬编码',
                  inputs: { dir: 'src' },
                  expectedOutput: '带文件:行号的发现清单',
                },
              ],
            }),
          ],
        };
      }
      return {
        stopReason: 'tool_use',
        content: '两个子任务都回来了，汇总并核验证据。',
        toolCalls: [
          tc('call_2', 'submit_orchestration', {
            summary: '（MOCK）两个子任务均已完成：src 目录已完成清点与审计，结论见 findings。',
            findings: [
              { from: 'dir-inventory', note: '（MOCK）src 下共统计到若干源文件，扩展名以 .ts/.js 为主' },
              { from: 'code-audit', note: '（MOCK）未发现硬编码密钥；存在 TODO 标记', path: 'src/' },
            ],
            unresolved: ['（MOCK 演示）未做跨目录交叉验证'],
          }),
        ],
      };
    }

    // ---- 清点子 Agent（dir-inventory）----
    if (names.includes('dir_stats')) {
      if (ctx.callIndex === 0) {
        return {
          stopReason: 'tool_use',
          content: '用 dir_stats 清点目标目录。',
          toolCalls: [tc('call_1', 'dir_stats', { dir: 'src', maxDepth: 3, topN: 3 })],
        };
      }
      return {
        stopReason: 'tool_use',
        content: '拿到统计结果，按契约上报。',
        toolCalls: [
          tc('call_2', 'submit_finding', {
            summary: '（MOCK）src 目录清点完成',
            items: [{ label: '文件数', value: 5 }],
            evidence: ['dir_stats:src'],
            confidence: 'high',
          }),
        ],
      };
    }

    // ---- 审计子 Agent（code-audit）----
    if (names.includes('search_files')) {
      if (ctx.callIndex === 0) {
        return {
          stopReason: 'tool_use',
          content: '先搜 TODO/FIXME。',
          toolCalls: [tc('call_1', 'search_files', { pattern: 'TODO', kind: 'content' })],
        };
      }
      return {
        stopReason: 'tool_use',
        content: '上报带证据的发现。',
        toolCalls: [
          tc('call_2', 'submit_finding', {
            summary: '（MOCK）未发现硬编码密钥，发现 1 处 TODO',
            findings: [{ path: 'src/calc.js', note: '（MOCK）存在 TODO 标记' }],
            evidence: ['src/calc.js:1'],
            confidence: 'medium',
          }),
        ],
      };
    }

    // ---- 调研子 Agent（doc-research）----
    if (names.includes('web_search')) {
      return {
        stopReason: 'tool_use',
        content: '（MOCK）直接上报检索结论。',
        toolCalls: [
          tc('call_1', 'submit_finding', {
            summary: '（MOCK）已检索到相关公开资料',
            evidence: ['OFFLINE_MOCK: 离线资料，非实时'],
            confidence: 'low',
          }),
        ],
      };
    }

    // 兜底：不认识的上下文，直接结束（避免演示卡死）
    return { stopReason: 'end_turn', content: '（MOCK）未匹配到演示剧本分支。' };
  };
}

export function makeDemoResponder(scenario: string, goal: string): MockResponder {
  if (scenario === 'orchestrator-basic') return orchestratorDemoResponder(goal);
  if (scenario === 'misc-basic') return miscDemoResponder(goal);
  if (scenario === 'research-basic') return researchDemoResponder(goal);
  // 默认按 codebase 演示
  return codebaseDemoResponder(goal);
}

/** 无剧本时的安全默认：直接给出简短最终答案，不触发任何工具调用。 */
export const defaultMockResponder: MockResponder = () => ({
  stopReason: 'end_turn',
  content: '（MOCK）未提供演示剧本，返回占位最终答案。',
});
