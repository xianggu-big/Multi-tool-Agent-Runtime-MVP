// src/scheduler/types.ts — 定时任务与待确认高危操作的持久化结构
import type { LLMGenerationParams, RunLimits, RunType } from '../types.js';

export type ScheduleFrequency = 'once' | 'daily';

/** 定时任务的非敏感运行参数（**绝不含 API Key**） */
export interface ScheduleOptions {
  limits?: RunLimits;
  /** Provider/模型覆盖；Key 一律来自服务端环境变量 */
  llm?: { provider?: string; model?: string; params?: LLMGenerationParams };
  orchestration?: {
    maxWidth?: number;
    allowedSpecs?: string[];
    allowSelfTools?: boolean;
    allowWriteSpecs?: boolean;
    strictVerify?: boolean;
  };
  misc?: { subtask?: 'inventory' | 'locate' | 'read' | 'lint' | 'other' };
  /** Codex 专属覆盖（与 runType='codex' 的 input.codex 合并） */
  codex?: {
    allowWrite?: boolean;
    model?: string;
    safetyPrompt?: string;
    dangerPatterns?: string[];
    isolateRead?: boolean;
    workspaceId?: string;
  };
}

export interface ScheduleRecord {
  id: string;
  name: string;
  agent: RunType;
  goal: string;
  repoPath?: string;
  frequency: ScheduleFrequency;
  /** once: ISO 本地时间；daily: HH:mm */
  runAt?: string;
  enabled: boolean;
  allowWrite: boolean;
  autoApprove: boolean;
  /** 注入 Codex/子 Agent 的安全边界说明（只作引导） */
  safetyPrompt?: string;
  /** 结构化危险模式（代码判定用） */
  dangerPatterns: string[];
  allowRunTests: boolean;
  skipIfRunning: boolean;
  options: ScheduleOptions;
  nextRunAt?: string;
  lastRunAt?: string;
  lastRunId?: string;
  lastStatus?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export type PendingActionKind = 'delete' | 'command' | 'mcp';
export type PendingActionStatus = 'pending' | 'executed' | 'dismissed' | 'failed';

export interface PendingActionRecord {
  id: string;
  runId: string;
  scheduleId?: string;
  kind: PendingActionKind;
  payload: Record<string, unknown>;
  status: PendingActionStatus;
  createdAt: string;
  decidedAt?: string;
  result?: Record<string, unknown>;
}
