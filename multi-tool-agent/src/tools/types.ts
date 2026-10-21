// src/tools/types.ts — 工具接口定义与运行时上下文

import { z } from 'zod';
import type {
  ApprovalDecision,
  ApprovalRequest,
  RiskLevel,
  RunType,
  SubtaskOutcome,
  SubtaskRequest,
  ToolResult,
  TraceEventType,
} from '../types.js';

/**
 * 派发一个子 Agent 并等待结果（由 Runtime 注入，工具本身不实现并发/取消）。
 * 隔离约定：子 Agent 独立上下文、独立预算、独立权限；只回传结构化结果。
 */
/** opts.signal：批次级取消（delegate 工具超时/丢弃该批时传入），与 run 级 signal 取并集 */
export type SpawnSubAgent = (req: SubtaskRequest, opts?: { signal?: AbortSignal }) => Promise<SubtaskOutcome>;

/** 工具在运行时能安全读取的最小配置子集（避免循环依赖） */
export interface ToolRuntimeConfig {
  search: { provider: 'offline' | 'serper'; apiKey?: string; baseUrl: string };
  codebase: { runTestsEnabled: boolean; allowedTestCommands: string[]; writeEnabled: boolean };
  /** 杂项 Agent 的只读边界参数 */
  misc: { scanLimit: number; maxFileBytes: number };
  /** 多 Agent 编排的并发与宽度上限 */
  subagent: {
    maxConcurrency: number;
    maxWidth: number;
    maxDepth: number;
    /** 回传给主 Agent 的单个子任务结果字符上限（上下文纪律） */
    resultChars: number;
  };
  maxOutputBytes: number;
  log: { maxContentChars: number; toolResults: boolean };
  /** 审批（M1）：单请求最大文件数（change set 批量） */
  approval: { maxFilesPerRequest: number };
  /** 沙箱（M1）：宿主复验的 Node 绝对路径 + 命令超时 */
  sandbox: { image: string; hostNodePath: string; execTimeoutMs: number; l2BeforeApproval: boolean };
}

/** 工具执行上下文：由 Runtime 在每个工具调用时构造并传入 */
export interface ToolContext {
  runId: string;
  runType: RunType;
  /** 本任务被允许的权限集合；Registry 据此拒绝越权调用 */
  allowedPermissions: string[];
  /** Codebase 任务：被分析仓库绝对根目录 */
  repoPath?: string;
  /** Research 任务配置 */
  research?: { allowedDomains?: string[]; topics?: string[] };
  /** 取消信号：工具应周期性检查以尽快退出 */
  signal?: AbortSignal;
  /** 工具输出最大字节数（超过则截断并记录 truncated） */
  maxOutputBytes: number;
  /** 运行时配置子集 */
  config: ToolRuntimeConfig;
  /** 编排专用：派发子 Agent 的能力（仅 orchestrator 任务注入；子 Agent 自身不注入 → 无法再委派） */
  spawnSubAgent?: SpawnSubAgent;
  /** 当前深度：主 Agent = 0，子 Agent = 1（用于深度守卫，防止递归扇出） */
  depth?: number;
  /** 本次允许使用的子 Agent 规格白名单（来自 RunInput.orchestration.allowedSpecs） */
  allowedSpecs?: string[];
  /**
   * 写能力（M1'）：本 run 是否允许派发「可写子 Agent（code-edit）」。
   * 由 Runtime 注入**最终判定**（请求授权 `allowWriteSpecs` && 部署门禁 `CODEBASE_WRITE_ENABLED`）；
   * delegate_subtasks 对写 spec fail-closed（未注入 / 非 true → 拒绝派发）。
   */
  writeSpecsAllowed?: boolean;
  /**
   * 批次回调：工具在一批子任务**全部返回后**，按派发顺序把结果交回 Runtime 记录。
   * 为什么不按完成顺序记录：并行完成顺序是随机的，会导致「事件流/汇总里的子任务顺序」
   * 每次都不一样，破坏可复现性；批次回调保证记录顺序 = 派发顺序。
   */
  onSubtasksDelegated?: (outcomes: SubtaskOutcome[]) => void;
  /**
   * 错误上报通道（由 Runtime 注入）：工具内部遇到「值得留痕」的错误时调用。
   * 与把错误作为 ToolResult 返回是两件事：前者进统一错误报告（可 grep / 可过滤），后者回喂模型。
   */
  reportError?: (parts: {
    phase: string;
    error?: unknown;
    code?: string;
    message?: string;
    subtaskId?: string;
    specId?: string;
    toolName?: string;
    context?: Record<string, unknown>;
  }) => void;
  /** 结构化事件通道（由 Runtime 注入）：写工具用它上报验证阶梯/落盘/回滚进度，供 UI 与报告取证。 */
  emitEvent?: (type: TraceEventType, data?: Record<string, unknown>) => void;
  /**
   * 写能力（M1）：请求人工审批。由 Runtime 注入；**未注入时写工具必须拒绝执行**（fail-closed）。
   * 超时/取消由 Runtime 处理（超时按拒绝）。
   */
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /**
   * 写能力（M1）：本 run 的沙箱会话（按 parentRunId 复用——子任务失败重派不丢半成品）。
   * 未注入 = 写能力不可用；`ensure()` 返回失败（如 Docker 未启动）时写工具必须拒绝执行。
   * 结构化类型：避免 tools → sandbox 的硬模块依赖。
   */
  sandbox?: SandboxAccess;
}

/** 写工具需要的沙箱能力（结构性子集；实现见 src/sandbox/session.ts 的 SandboxSession） */
export interface SandboxAccess {
  readonly name: string;
  ensure(): Promise<{ ok: true } | { ok: false; reason: string }>;
  isStarted(): boolean;
  readRepoFile(rel: string): string | null;
  /** 沙箱当前内容（已 staged 读 work 副本，否则读真实仓库；delete 后为 null） */
  readWorkFile(rel: string): string | null;
  /** 可选：读前获取沙箱当前文件的字节数（未实现时调用方回退到 readWorkFile） */
  workFileSize?(rel: string): number | null;
  stage(
    rel: string,
    op: 'create' | 'edit' | 'delete',
    content?: string,
    opts?: { signal?: AbortSignal },
  ): unknown | Promise<unknown>;
  mark(rel: string, status: string): void;
  consumeRound(rel: string): number;
  getChanges(): Array<{
    relPath: string;
    op: 'create' | 'edit' | 'delete';
    status: string;
    retriesLeft: number;
    baseHash?: string;
    newHash?: string;
  }>;
  runLadder(level?: 'L0' | 'L1' | 'L2', opts?: { signal?: AbortSignal }): Promise<{
    ok: boolean;
    level: string;
    steps: Array<{
      source: string;
      verdict: { ok: boolean; class?: string; summary: string; repairHint?: string; excerpt?: string };
    }>;
  }>;
  diffPatch(rel: string, name?: string): string | Promise<string>;
  /** diff 全文落点目录（data/sandbox/<runId>/diffs/；评审 P1-6：diff 落文件、不进事件流） */
  diffDir(): string;
  /** 落盘前登记意图日志（崩溃对账）；失败应让调用方中止落盘。 */
  beginApply(
    approvalId: string,
    files: Array<{ relPath: string; op: 'create' | 'edit' | 'delete'; baseHash?: string; workHash?: string }>,
  ): void | Promise<void>;
  applyToRepo(rel: string, approvalId?: string): { ok: true } | { ok: false; reason: string } | Promise<{ ok: true } | { ok: false; reason: string }>;
  rollbackFromBackup(rel: string, approvalId?: string): boolean | Promise<boolean>;
  backupsDir(): string;
  stageCommand(cmd: {
    command: string;
    shell: 'bash' | 'powershell' | 'cmd';
    cwdRel: string;
    sandboxOutput: string | null;
    sandboxExitCode: number | null;
  }): unknown;
  getCommands(): Array<{
    command: string;
    shell: 'bash' | 'powershell' | 'cmd';
    cwdRel: string;
    sandboxOutput: string | null;
    sandboxExitCode: number | null;
    status: string;
  }>;
  markCommand(index: number, status: string, host?: { output: string; exitCode: number | null }): void;
}

export interface Tool {
  name: string;
  description: string;
  /** Zod schema，用于参数校验 */
  inputSchema: z.ZodTypeAny;
  /**
   * 可选：直接暴露给模型的 JSON Schema。
   * MCP 等外部工具已经带 JSON Schema，不能可靠地反向转成 Zod；有该字段时 Registry 优先使用它。
   */
  jsonSchema?: Record<string, unknown>;
  /**
   * 正确调用示例（可选）：当参数校验失败时，Registry 会把它附在错误信息里。
   * 作用：真实模型经常"形状写错"（把对象数组写成字符串数组），带上示例能一次改对，
   * 而不是反复试错吃光子 Agent 的步数预算。
   */
  inputExample?: Record<string, unknown>;
  /** 单次执行超时（毫秒） */
  timeoutMs: number;
  /** 所需权限（如 'codebase:read' / 'research:web'） */
  permission: string;
  /** 风险等级，用于决定默认可重试性与是否需要副作用确认 */
  riskLevel: RiskLevel;
  /**
   * 终结性工具：执行成功后，Runtime 立即以它的返回数据结束本次任务
   * （用于「结构化提交结论」，例如 misc 的 submit_result）。
   * 注意：仍会走完整的权限/Schema/超时校验，只是它标记了任务的终点。
   */
  terminal?: boolean;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult> | ToolResult;
}

export function okResult(data: unknown, durationMs: number, truncated = false): ToolResult {
  return { ok: true, data, durationMs, truncated };
}

export function errResult(
  code: string,
  message: string,
  durationMs: number,
  opts: { retryable?: boolean; truncated?: boolean } = {},
): ToolResult {
  return {
    ok: false,
    error: { code, message },
    durationMs,
    retryable: opts.retryable ?? false,
    truncated: opts.truncated,
  };
}
