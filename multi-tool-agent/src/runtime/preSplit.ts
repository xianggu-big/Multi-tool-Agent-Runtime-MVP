// src/runtime/preSplit.ts — 规则式「预筛」：把任务按天然分区切成候选子任务（零 token）
// 为什么需要它：拆分质量决定整个编排的成败，而"从零想怎么拆"既贵又不稳定。
// 规则先给出「按目录 / 按来源」的候选分区，主 Agent 在此基础上增删改——
// 这与 misc 的 router.ts 是同一口味：确定性、可解释、可单测、不花模型钱。
//
// 边界（诚实声明）：规则只认关键词与目录结构，**不做语义理解**；它给的是"建议"，
// 主 Agent 有权合并/调整；真正决定最终拆分的是主 Agent（见 AgentRuntime 的编排系统提示词）。

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SubtaskRequest } from '../types.js';
import { EXCLUDED_DIRS } from '../tools/codebase/security.js';

/** 列出工作区顶层目录（只读、忽略依赖/构建目录、按名称排序保证确定性） */
export function pickTopLevelDirs(repoPath: string, limit = 6): string[] {
  try {
    return readdirSync(repoPath)
      .filter((name) => !name.startsWith('.') && !EXCLUDED_DIRS.has(name))
      .filter((name) => {
        try {
          return statSync(join(repoPath, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort()
      .slice(0, limit);
  } catch {
    return [];
  }
}

export interface PreSplitOptions {
  /** 候选目录（通常是工作区顶层目录） */
  dirs?: string[];
  /** 候选主题（调研类任务用；通常来自 RunInput.research.topics 或从目标里拆分） */
  topics?: string[];
  /** 最多产出多少条建议 */
  maxWidth?: number;
}

/** 从目标文本里粗略抽取调研主题（按常见分隔符切分） */
export function extractTopics(goal: string, limit = 4): string[] {
  const cleaned = goal
    .replace(/^.*?(调研|搜索|检索|对比|比较|查一下|了解)/, '')
    .replace(/[。；;！!?？]/g, '，');
  const parts = cleaned
    .split(/[、,，]|\s+vs\s+|\s+和\s+|\s+与\s+|\s+and\s+/i)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s.length <= 40);
  return [...new Set(parts)].slice(0, limit);
}

/**
 * 规则式预筛：按「任务形状 → 分区方式」产出候选子任务。
 * 返回的每一条都是可直接交给主 Agent 参考的 SubtaskRequest（主 Agent 可改）。
 */
export function preSplitSubtasks(goal: string, opts: PreSplitOptions = {}): SubtaskRequest[] {
  const text = (goal ?? '').toLowerCase();
  const maxWidth = Math.max(1, Math.min(opts.maxWidth ?? 4, 8));
  const dirs = (opts.dirs ?? []).slice(0, maxWidth);
  const topics = (opts.topics ?? []).slice(0, maxWidth);
  const out: SubtaskRequest[] = [];

  const looksInventory = /清点|多少|统计|文件数|大小|分布|概览|清单/.test(text);
  const looksAudit = /todo|fixme|审计|检查|遗留|硬编码|可疑|规范|风险/.test(text);
  const looksResearch = /调研|搜索|检索|对比|比较|最新|版本|来源|资料|文档/.test(text);
  const looksCode = /代码|实现|函数|模块|调用|依赖/.test(text);

  // ① 清点类：每个目录一个子任务（天然零依赖）
  if (looksInventory && dirs.length) {
    for (const d of dirs) {
      out.push({
        specId: 'dir-inventory',
        objective: `清点目录 ${d} 的文件数、总大小与扩展名分布`,
        inputs: { dir: d },
        boundary: `只统计 ${d} 目录，不递归到其它顶层目录`,
        expectedOutput: '文件数、总大小、扩展名分布（Top 5）、最大的若干文件',
      });
    }
  }

  // ② 审计类：按目录分片（同样零依赖）
  if (looksAudit && dirs.length) {
    for (const d of dirs) {
      out.push({
        specId: 'code-audit',
        objective: `审计 ${d} 目录：找出 TODO/FIXME、可疑硬编码与缺失校验`,
        inputs: { dir: d },
        boundary: `只读 ${d}，不要跨界；每条发现必须给 文件:行号`,
        expectedOutput: '带文件:行号的发现清单 + 证据指针',
      });
    }
  }

  // ③ 调研类：每个主题一个子任务
  if (looksResearch && topics.length) {
    for (const t of topics) {
      out.push({
        specId: 'doc-research',
        objective: `调研「${t}」，给出带来源的结论`,
        inputs: { topic: t },
        boundary: '结论必须带来源；离线资料需标注为 OFFLINE_MOCK',
        expectedOutput: '结论 + 来源列表（标题/URL/摘要）',
      });
    }
  }

  // ④ 代码类但没有明确清点/审计信号：至少给一个代码审计候选（让主 Agent 决定怎么切）
  if (!out.length && looksCode && dirs.length) {
    out.push({
      specId: 'code-audit',
      objective: `审计 ${dirs[0]} 目录的关键实现与可疑模式`,
      inputs: { dir: dirs[0] },
      expectedOutput: '关键实现说明 + 带路径的发现',
    });
  }

  // 去重（同 spec + 同 objective）并截断
  const seen = new Set<string>();
  return out
    .filter((t) => {
      const k = `${t.specId}::${t.objective}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, maxWidth);
}
