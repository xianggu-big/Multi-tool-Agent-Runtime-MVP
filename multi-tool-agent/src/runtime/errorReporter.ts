// src/runtime/errorReporter.ts — 统一错误检测与报告
//
// 背景（真实事故驱动）：多 Agent 编排首次用真实模型跑时，只有 `tool_failed` 事件里一行 `code+message`，
// 排查者拿不到「**在哪**（文件行）、**什么类型**、**为什么**、**上下文是什么**」四要素；
// 更糟的是：执行循环若抛出未预期异常，`void executeLoop().finally()` 会把 rejection 吞掉，
// 任务**永远停在 running**，界面上什么都不显示 —— 这是最需要堵住的报告缺口。
//
// 本模块提供：
//   ① 结构化错误报告（id / 时间 / 来源 / 阶段 / 位置 file:line / 类型 / 码 / 消息 / 上下文 / 栈）；
//   ② 三个落点：**持久化事件**（`runtime_error`，前端实时可见）、**JSONL 日志**（data/errors.log，便于 grep）、
//      以及返回值（调用方可直接回给用户/模型）；
//   ③ 纯函数 `parseErrorLocation()`：从栈里提取第一处「项目内」代码位置。

import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TraceEventType } from '../types.js';

export type ErrorSource =
  | 'agent-loop' // 主 Agent 执行循环
  | 'subagent' // 子 Agent 执行
  | 'delegation' // 委派（扇出）环节
  | 'tool' // 工具执行
  | 'provider' // 模型 Provider
  | 'store' // 持久化
  | 'server' // HTTP 层 / 进程级未捕获
  | 'client'; // 浏览器侧上报

export interface RuntimeErrorReportInput {
  source: ErrorSource;
  /** 阶段：例如 'executeLoop' / 'delegate_subtasks' / 'llm.chat' / 'route:/api/runs' */
  phase: string;
  error?: unknown;
  /** 稳定的机器可读错误码（如 INTERNAL_ERROR / MODEL_ERROR / WIDTH_LIMIT） */
  code?: string;
  /** 覆盖式消息（不给则从 error 里取） */
  message?: string;
  runId?: string;
  subtaskId?: string;
  specId?: string;
  toolName?: string;
  /** 显式提供的调用栈（浏览器上报没有 Error 对象，可把栈文本直接传进来用于解析位置） */
  stack?: string;
  /** 键值上下文：目标、参数、step、budget 等（**不要放密钥**，会被脱敏） */
  context?: Record<string, unknown>;
  /**
   * 不产生 runtime_error 事件（调用方自行管理事件落点）。
   * 用例：启动期孤儿运行回收——事件序号必须接续历史（max+1），不能走内存计数器（会从 1 起撞号），
   * 因此由 SqliteStore.finalizeInterruptedRun 直接写库，ErrorReporter 只负责日志/内存环/控制台三落点。
   */
  skipEvent?: boolean;
}

export interface RuntimeErrorReport {
  id: string;
  at: string;
  source: ErrorSource;
  phase: string;
  errorType: string;
  code: string;
  message: string;
  /** 第一处项目内代码位置（file:line），来自 stack */
  location?: string;
  stack?: string;
  runId?: string;
  subtaskId?: string;
  specId?: string;
  toolName?: string;
  context?: Record<string, unknown>;
  /** 人类可读的「怎么排查」建议 */
  hint: string;
}

const SECRET_KEY_RE = /(apikey|api_key|key|token|secret|password|authorization)/i;
const SECRET_VALUE_RE = /(sk-[A-Za-z0-9]{12,})|(Bearer\s+[A-Za-z0-9._-]+)/g;

/** 从错误栈里提取第一处「项目内」代码位置；过滤掉 node 内部与依赖包 */
export function parseErrorLocation(stack?: string): string | undefined {
  if (!stack) return undefined;
  const lines = stack.split('\n').slice(0, 30);
  const candidates: string[] = [];
  for (const line of lines) {
    // ① 浏览器上报的栈是 URL 形态（http://host:port/path:line:col）——优先整段捕获，
    //    否则通用的「以 / 开头」规则会把 http 的 "htt" 切掉，解析出 p://host 这种残骸
    const url = line.match(/(https?:\/\/[^\s()]+?):(\d+)(?::\d+)?\)?$/);
    if (url) {
      candidates.push(`${url[1]}:${url[2]}`);
      continue;
    }
    const m = line.match(/\(?([A-Za-z]:[\\/][^()]+?|\/[^()]+?):(\d+):(\d+)\)?$/);
    if (!m) continue;
    candidates.push(`${m[1]}:${m[2]}`);
  }
  const isInternal = (p: string) =>
    /node_modules|[\\/]node:[\\/]|internal[\\/]|node:internal/.test(p) || /<anonymous>/.test(p);
  const project = candidates.find((p) => !isInternal(p));
  return (project ?? candidates[0])?.replace(/\\/g, '/');
}

/** 错误类型：优先 Error.name，否则 typeof / 构造名 */
export function errorTypeOf(e: unknown): string {
  if (e instanceof Error) return e.name || 'Error';
  if (e === null) return 'null';
  if (e === undefined) return 'undefined';
  return typeof e;
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return '…';
  if (typeof value === 'string') return value.replace(SECRET_VALUE_RE, '***REDACTED***').slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? '***REDACTED***' : sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** 按 source+code 给出「接下来该看哪里」的建议（排查入口） */
export function hintFor(source: ErrorSource, code: string): string {
  const table: Record<string, string> = {
    INTERNAL_ERROR: '这是未预期异常（代码缺陷）：看 location 定位到源文件行号，再看 context 里的阶段与参数。',
    MODEL_ERROR: '模型调用失败：先看 context 的 status / suspect / messageCount。若 status=400 且 suspect=invalid_message_sequence（或文案含 tool_calls），说明**消息序列非法**（常见于上下文压缩切坏 assistant+tool 配对），不是 Key/网络问题——对比相邻 step 的 messageCount 是否突降；否则查 API Key / Base URL / 模型名 / 网络。',
    UNKNOWN_SPEC: '委派用了不存在的子 Agent 契约：看 GET /api/agents/specs 的 id 清单。',
    WIDTH_LIMIT: '单次派发超过 SUBAGENT_MAX_WIDTH：拆成多批，或合并同类子任务。',
    SPEC_NOT_ALLOWED: '子 Agent 不在本次 allowedSpecs 白名单内：改请求或去掉白名单。',
    DUPLICATE_OBJECTIVE: '同一 objective 重复派发被拒绝：改写 objective（体现不同视角）或在 unresolved 里标注缺口。',
    MISSING_ARGS: '工具缺必填参数：看 message 里的示例。',
    INVALID_ARGS: '工具参数不符合 schema：看 message 里逐字段的校验失败原因。',
    NOT_FOUND: '路径不存在或不可解析：message 里会列出仓库内实际可用的条目。',
    PERMISSION_DENIED: '该 Agent 没有这个工具的权限（注册≠授权）：确认 spec.permissions 与工具所需权限。',
    TIMEOUT: '工具超时：检查目标是否过大（缩小范围）或调大该工具/子任务的超时。',
    tokenBudget: '任务累计 token 超预算：调大「任务 Token 预算」，或收窄目标范围。',
    RUN_INTERRUPTED: '运行在上次服务进程退出时被中断（不是代码缺陷）：这是流程性中断，重跑该任务即可；已记入审计日志，见 GET /api/history?action=run_interrupted。',
  };
  return table[code] ?? `来源 ${source}：查看 message / location / context 三项即可定位。`;
}

export interface ErrorReporterOptions {
  /** 落盘路径（JSONL）；留空则不落盘 */
  logPath?: string;
  /** 事件出口（由 Tracer/EventLogger 提供）：产生一条 runtime_error 持久化事件 */
  emit?: (runId: string, type: TraceEventType, data: Record<string, unknown>) => void;
  /** 是否把报告打到控制台（默认 true，便于开发时直接看到） */
  console?: boolean;
  /** errors.log 单文件上限（字节）；超过后轮转为 `<logPath>.1`（0/未设 = 不轮转） */
  maxLogBytes?: number;
}

export class ErrorReporter {
  /** 最近若干条报告（内存环形缓冲，供 /api/errors 立即查询，避免读盘） */
  private recent: RuntimeErrorReport[] = [];

  constructor(private readonly opts: ErrorReporterOptions = {}) {}

  report(input: RuntimeErrorReportInput): RuntimeErrorReport {
    const e = input.error;
    const stack = (e instanceof Error ? e.stack : undefined) ?? input.stack;
    const report: RuntimeErrorReport = {
      id: `err_${randomUUID().slice(0, 8)}`,
      at: new Date().toISOString(),
      source: input.source,
      phase: input.phase,
      errorType: errorTypeOf(e),
      code: input.code ?? (e instanceof Error && 'code' in e ? String((e as any).code) : 'UNKNOWN'),
      message:
        input.message ??
        (e instanceof Error ? e.message : e === undefined ? '（无错误对象）' : String(e)),
      location: parseErrorLocation(stack),
      stack: stack ? stack.split('\n').slice(0, 12).join('\n') : undefined,
      runId: input.runId,
      subtaskId: input.subtaskId,
      specId: input.specId,
      toolName: input.toolName,
      context: input.context ? (sanitize(input.context) as Record<string, unknown>) : undefined,
      hint: hintFor(input.source, input.code ?? 'UNKNOWN'),
    };

    // 落点 ①：持久化事件（前端实时可见 + 可回放）
    if (report.runId && this.opts.emit && !input.skipEvent) {
      try {
        this.opts.emit(report.runId, 'runtime_error', {
          errorId: report.id,
          source: report.source,
          phase: report.phase,
          errorType: report.errorType,
          code: report.code,
          message: report.message,
          location: report.location,
          subtaskId: report.subtaskId,
          specId: report.specId,
          toolName: report.toolName,
          context: report.context,
          hint: report.hint,
          stack: report.stack,
        });
      } catch {
        /* 事件出口失败不得影响主流程 */
      }
    }

    // 落点 ②：JSONL 日志（便于 grep / 事后取证）
    if (this.opts.logPath) {
      try {
        mkdirSync(dirname(this.opts.logPath), { recursive: true });
        this.rotateIfNeeded();
        appendFileSync(this.opts.logPath, JSON.stringify(report) + '\n', 'utf8');
      } catch {
        /* 日志写失败不得影响主流程 */
      }
    }

    // 落点 ③：内存环形缓冲
    this.recent.push(report);
    if (this.recent.length > 200) this.recent.shift();

    if (this.opts.console !== false) {
      console.error(
        `[error] ${report.at} id=${report.id} source=${report.source} phase=${report.phase} ` +
          `${report.errorType}/${report.code} @ ${report.location ?? 'unknown'}\n  ${report.message}` +
          (report.runId ? `\n  run=${report.runId}${report.subtaskId ? ` subtask=${report.subtaskId}` : ''}${report.specId ? ` spec=${report.specId}` : ''}` : '') +
          `\n  hint: ${report.hint}`,
      );
    }
    return report;
  }

  /** 单文件轮转：只保留一份 .1 备份，避免长期运行把磁盘写满。 */
  private rotateIfNeeded(): void {
    const max = this.opts.maxLogBytes ?? 0;
    if (!this.opts.logPath || max <= 0 || !existsSync(this.opts.logPath)) return;
    const size = statSync(this.opts.logPath).size;
    if (size < max) return;
    const backup = `${this.opts.logPath}.1`;
    rmSync(backup, { force: true });
    renameSync(this.opts.logPath, backup);
  }

  /** 最近报告（可按 runId / source / code 过滤） */
  list(filter: { runId?: string; source?: ErrorSource; code?: string; limit?: number } = {}): RuntimeErrorReport[] {
    let out = this.recent.slice().reverse();
    if (filter.runId) out = out.filter((r) => r.runId === filter.runId);
    if (filter.source) out = out.filter((r) => r.source === filter.source);
    if (filter.code) out = out.filter((r) => r.code === filter.code);
    return out.slice(0, filter.limit ?? 50);
  }

  /**
   * 按「code + location」聚合计数——「高频错误 TOP」视图。
   * 解决 R5：同错误各记一条会淹没日志，看不出「最常犯的是什么、集中在哪一行」。
   * 排序：次数降序 → 最近发生时间降序；runIds 保留最近至多 5 个关联 run（便于点进去复现）。
   */
  summary(opts: { limit?: number; runId?: string; source?: ErrorSource } = {}): {
    groups: Array<{
      key: string;
      code: string;
      location?: string;
      errorType: string;
      count: number;
      firstAt: string;
      lastAt: string;
      sampleMessage: string;
      hint: string;
      runIds: string[];
    }>;
    scanned: number;
  } {
    type Group = {
      key: string;
      code: string;
      location?: string;
      errorType: string;
      count: number;
      firstAt: string;
      lastAt: string;
      sampleMessage: string;
      hint: string;
      runIds: string[];
    };
    const items = this.list({ runId: opts.runId, source: opts.source, limit: 200 });
    const map = new Map<string, Group>();
    for (const r of items) {
      const key = `${r.code} @ ${r.location ?? '(无位置)'}`;
      const hit = map.get(key);
      if (hit) {
        hit.count++;
        if (r.at > hit.lastAt) {
          hit.lastAt = r.at;
          hit.sampleMessage = r.message;
          hit.errorType = r.errorType;
        }
        if (r.at < hit.firstAt) hit.firstAt = r.at;
        if (r.runId && !hit.runIds.includes(r.runId) && hit.runIds.length < 5) hit.runIds.push(r.runId);
      } else {
        map.set(key, {
          key,
          code: r.code,
          location: r.location,
          errorType: r.errorType,
          count: 1,
          firstAt: r.at,
          lastAt: r.at,
          sampleMessage: r.message,
          hint: r.hint,
          runIds: r.runId ? [r.runId] : [],
        });
      }
    }
    const groups = [...map.values()]
      .sort((a, b) => b.count - a.count || (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0))
      .slice(0, opts.limit ?? 20);
    return { groups, scanned: items.length };
  }

  count(): number {
    return this.recent.length;
  }
}
