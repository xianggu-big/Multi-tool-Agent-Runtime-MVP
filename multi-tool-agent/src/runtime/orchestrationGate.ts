// src/runtime/orchestrationGate.ts — 编排预筛闸门（零 token、可解释）
//
// 背景（reports/PARALLEL_AB.md）：同任务「编排并行」曾用 7× token / 6× 墙钟，
// 而单 Agent 在 221k token 内完成了同一任务。结论不是“不要编排”，而是：
// **先判断一个上下文装不装得下，装得下就别默认编排。**
//
// 本模块只做两件事：
//   1) 以受限扫描估算仓库规模（文件数/字节数，不读内容）；
//   2) 给出 single / orchestrate / unknown 的建议与可读理由。
// 它不改变显式用户选择；只在“自动分流”路径上把默认建议从编排降为单 Agent。

import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { EXCLUDED_DIRS } from '../tools/codebase/security.js';
import type { OrchestrationGate } from '../types.js';

export interface RepoFacts {
  files: number;
  bytes: number;
  /** 达到扫描上限（结果只是下界） */
  truncated: boolean;
  scannedDirs: number;
}

export interface ScanOptions {
  maxFiles?: number;
  maxBytes?: number;
  maxDirs?: number;
  maxDepth?: number;
}

/**
 * 受限扫描：跳过依赖/构建目录与符号链接；只统计普通文件。
 * 不做内容读取，几毫秒级；达到上限即停并标 truncated（不假装完整）。
 */
export function scanRepoFacts(repoPath: string, opts: ScanOptions = {}): RepoFacts {
  const maxFiles = opts.maxFiles ?? 4000;
  const maxBytes = opts.maxBytes ?? 32 * 1024 * 1024;
  const maxDirs = opts.maxDirs ?? 800;
  const maxDepth = opts.maxDepth ?? 12;
  const facts: RepoFacts = { files: 0, bytes: 0, truncated: false, scannedDirs: 0 };
  const stack: Array<{ dir: string; depth: number }> = [{ dir: repoPath, depth: 0 }];

  while (stack.length) {
    const { dir, depth } = stack.pop()!;
    if (facts.scannedDirs >= maxDirs) {
      facts.truncated = true;
      break;
    }
    facts.scannedDirs += 1;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.startsWith('.') || EXCLUDED_DIRS.has(name)) continue;
      const abs = join(dir, name);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (depth + 1 <= maxDepth) stack.push({ dir: abs, depth: depth + 1 });
        continue;
      }
      if (!st.isFile()) continue;
      facts.files += 1;
      facts.bytes += st.size;
      if (facts.files >= maxFiles || facts.bytes >= maxBytes) {
        facts.truncated = true;
        return facts;
      }
    }
  }
  return facts;
}

export interface GateOptions {
  /** 单 Agent 的任务 token 预算（默认 200k） */
  tokenBudget: number;
  /** 单上下文建议占用上限（默认 0.8；留 20% 给工具结果与输出） */
  budgetRatio?: number;
}

/** 明确需要分区的信号：交叉验证、独立评审、多来源、逐分区覆盖。 */
const MULTI_SIGNAL = /交叉验证|独立评审|多路|多来源|分别审计|逐个(目录|模块)|每个(目录|模块)|分区(审计|清点)|并行/;

/**
 * 给出编排建议。经验换算：代码约 3.2 字符/token，另加 8k 目标/工具开销。
 * 这是**估算**，不是计费；用于“先别默认编排”的门槛，不用于对外承诺成本。
 */
export function adviseOrchestration(
  goal: string,
  facts: RepoFacts | null,
  opts: GateOptions,
): OrchestrationGate {
  const budget = Math.max(1, opts.tokenBudget);
  const ratio = Math.min(1, Math.max(0.1, opts.budgetRatio ?? 0.8));
  const multi = MULTI_SIGNAL.test(goal);

  if (!facts) {
    return {
      recommend: multi ? 'orchestrate' : 'unknown',
      reason: multi
        ? '目标要求分区/交叉验证；未提供工作区，无法估算仓库规模'
        : '未提供工作区，无法估算单上下文能否装下；保留原选择',
    };
  }

  const estimatedTokens = Math.ceil(facts.bytes / 3.2) + 8000;
  const budgetShare = estimatedTokens / budget;
  const base = {
    estimatedTokens,
    budgetShare: Number(budgetShare.toFixed(3)),
    files: facts.files,
    bytes: facts.bytes,
    truncated: facts.truncated,
  };

  if (multi) {
    return { recommend: 'orchestrate', reason: '目标明确要求分区/交叉验证，单 Agent 不满足证据形态', ...base };
  }
  if (facts.truncated) {
    return { recommend: 'orchestrate', reason: `仓库超过扫描上限（已见 ${facts.files} 文件 / ${facts.bytes} 字节），单上下文风险高`, ...base };
  }
  if (budgetShare <= ratio) {
    return {
      recommend: 'single',
      reason: `单上下文预计约 ${estimatedTokens} tokens（预算 ${budget} 的 ${(budgetShare * 100).toFixed(0)}%），优先单 Agent`,
      ...base,
    };
  }
  return {
    recommend: 'orchestrate',
    reason: `单上下文预计约 ${estimatedTokens} tokens，超过预算 ${budget} 的 ${(ratio * 100).toFixed(0)}%，建议分区`,
    ...base,
  };
}

/** 把建议压成一行（系统提示/事件里用） */
export function formatGate(gate: OrchestrationGate): string {
  const facts = gate.files != null ? `；仓库 ${gate.files} 文件 / ${gate.bytes} 字节` : '';
  return `${gate.recommend}：${gate.reason}${facts}`;
}
