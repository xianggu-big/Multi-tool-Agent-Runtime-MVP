// src/runtime/Budget.ts — 预算与资源限制跟踪
// 由 Runtime 在代码层面强制执行；模型无法自行绕过。

import type { TokenUsage } from '../types.js';

export interface BudgetLimits {
  maxSteps: number;
  maxModelCalls: number;
  maxToolCalls: number;
  tokenBudget: number;
  costBudgetUsd: number;
  totalTimeoutMs: number;
}

export class Budget {
  steps = 0;
  modelCalls = 0;
  toolCalls = 0;
  promptTokens = 0;
  completionTokens = 0;
  costUsd = 0;
  /** 命中输入缓存的 token 数（厂商提供时才有）——Agent 多轮调用下这是最大的省钱杠杆 */
  cachedPromptTokens = 0;
  /** 思考 token 数（DeepSeek 等会单列） */
  reasoningTokens = 0;
  /** token 数是否估算（Mock 启发式 → true；真实 API → false）。聚合任一估算即记为估算 */
  tokensEstimated = false;
  /** 最近一次费用估算依据（说明按什么价估的） */
  lastEstimateNote?: string;
  /**
   * 累计「非任务时间」（如等待人工审批）——M1 评审 P2-a：
   * checkTimeout 用纯墙钟差会把审批等待算进 totalTimeoutMs，导致"人还没点，任务先超时"。
   * pausedMs 随检查点持久化（resume 不重计）。
   */
  pausedMs = 0;
  private pausedAt: number | null = null;
  readonly startedAt: number;

  constructor(public readonly limits: BudgetLimits, startedAt = Date.now()) {
    this.startedAt = startedAt;
  }

  /** 进入暂停（等待审批等非任务时间；可重入：多次 pause 只记一次） */
  pause(): void {
    if (this.pausedAt === null) this.pausedAt = Date.now();
  }
  /** 结束暂停，累计暂停时长 */
  resume(): void {
    if (this.pausedAt !== null) {
      this.pausedMs += Date.now() - this.pausedAt;
      this.pausedAt = null;
    }
  }
  /** 当前有效暂停时长（含正在进行的暂停） */
  get activePausedMs(): number {
    return this.pausedMs + (this.pausedAt !== null ? Date.now() - this.pausedAt : 0);
  }
  /** 任务有效耗时（墙钟 - 暂停） */
  activeElapsedMs(now = Date.now()): number {
    return now - this.startedAt - this.activePausedMs;
  }

  /** 进入新一轮：步骤 +1；超过上限返回触发的限制名 */
  enterStep(): string | null {
    this.steps += 1;
    if (this.steps > this.limits.maxSteps) return 'maxSteps';
    return null;
  }

  /** 模型调用前检查 */
  checkPreModelCall(): string | null {
    if (this.modelCalls >= this.limits.maxModelCalls) return 'maxModelCalls';
    return null;
  }

  recordModelCall(usage: TokenUsage): void {
    this.modelCalls += 1;
    this.promptTokens += usage.promptTokens;
    this.completionTokens += usage.completionTokens;
    this.costUsd += usage.costUsd;
    this.cachedPromptTokens += usage.cachedPromptTokens ?? 0;
    this.reasoningTokens += usage.reasoningTokens ?? 0;
    if (usage.tokensEstimated) this.tokensEstimated = true;
    if (usage.estimateNote) this.lastEstimateNote = usage.estimateNote;
  }

  /** 工具调用前检查 */
  checkPreToolCall(): string | null {
    if (this.toolCalls >= this.limits.maxToolCalls) return 'maxToolCalls';
    return null;
  }

  recordToolCall(): void {
    this.toolCalls += 1;
  }

  checkToken(): string | null {
    if (this.limits.tokenBudget > 0 && this.promptTokens + this.completionTokens > this.limits.tokenBudget) {
      return 'tokenBudget';
    }
    return null;
  }

  checkCost(): string | null {
    if (this.limits.costBudgetUsd > 0 && this.costUsd > this.limits.costBudgetUsd) {
      return 'costBudget';
    }
    return null;
  }

  checkTimeout(now: number): string | null {
    // 评审 P2-a：审批等待等暂停时间不计入 totalTimeoutMs
    if (this.activeElapsedMs(now) > this.limits.totalTimeoutMs) return 'totalTimeout';
    return null;
  }

  usage(): TokenUsage {
    return {
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.promptTokens + this.completionTokens,
      costUsd: this.costUsd,
      isEstimate: true,
      tokensEstimated: this.tokensEstimated,
      estimateNote: this.lastEstimateNote,
      cachedPromptTokens: this.cachedPromptTokens,
      reasoningTokens: this.reasoningTokens,
    };
  }
}
