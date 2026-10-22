// scripts/compaction-ab.ts — 真实模型下的上下文压缩 A/B（rolling vs legacy）
//
// 运行：npm run eval:compaction
// 产出：reports/COMPACTION_AB.md + data/compaction-ab/<stamp>/
//
// 设计取舍：
//   - 5 个只读代码分析任务 × 2 策略 × 3 次，质量与效率同表对照。
//   - 为了在小 fixture 上真正触发压缩，用一个只读 Provider 包装器把“决策窗口”压到 4096 tokens；
//     模型仍是真实 DeepSeek，实际窗口不变。报告必须明确这是窗口假设，不是 1M 窗口实测。
//   - 预算硬停：总预算默认 $1；每 run 另设子预算，避免单次失控。
//   - Key 不可用直接失败退出，不覆盖已有报告；运行中的个别失败保留为证据并计数。

import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { buildRuntime } from '../src/runtime/index.js';
import { createProvider } from '../src/llm/index.js';
import { copyRepoSnapshot } from '../src/sandbox/session.js';
import { recordToResult } from '../src/store/SqliteStore.js';
import type { LLMProvider, RunInput, RunResult, TraceEvent } from '../src/types.js';
import {
  compareCompactionAb,
  extractReadStats,
  matchMustMention,
  renderCompactionAbReport,
  summarizeCompactionAb,
  type CompactionAbCaseResult,
  type CompactionAbCompaction,
  type CompactionStrategy,
} from '../src/evaluation/compactionAb.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..');
const REPO_ROOT = resolve(PROJECT, '..');
const FIXTURE = join(PROJECT, 'eval', 'compaction-fixture', 'base');

interface TaskDef {
  id: string;
  title: string;
  goal: string;
  mustMention: string[];
  /** 第一轮必须读取的核心证据。 */
  round1Files: string[];
  /** 第二轮必须读取的旁证；用于把压缩放到最终回答之前。 */
  round2Files: string[];
  maxSteps?: number;
  maxModelCalls?: number;
  maxToolCalls?: number;
}

const TASKS: TaskDef[] = [
  {
    id: 'incident-chain',
    title: '登录 500 的完整根因链',
    goal:
      '分析登录接口为什么会返回 500，并给出从坏输入到账号被锁的完整根因链。必须交叉核对事故报告、登录实现、HTTP handler 与配置；解释 null 输入为什么绕过校验、500 为什么会被反复计数。不要只复述事故报告，要指出对应代码位置。',
    mustMention: ['normalizeEmail', 'null', 'handleLogin', '500', 'MAX_LOGIN_ATTEMPTS'],
    round1Files: ['docs/incident-2026-10.md', 'src/auth/login.js', 'src/http/handlers.js', 'src/config.js'],
    round2Files: ['src/util/errors.js', 'src/db/audit.js'],
  },
  {
    id: 'audit-gap',
    title: '500 为什么没有审计记录',
    goal:
      '解释登录失败为什么没有进入 audit：定位 handleLogin 的异常处理路径、audit 模块的调用点，并说明普通 500 与登录成功路径的差异。必须给出可直接修改的文件和函数，不要猜测未读到的实现。',
    mustMention: ['src/http/handlers.js', 'recordAudit', 'handleLogin', 'catch', '500'],
    round1Files: ['src/http/handlers.js', 'src/db/audit.js', 'src/auth/login.js', 'src/config.js'],
    round2Files: ['src/util/errors.js', 'src/db/users.js'],
  },
  {
    id: 'legacy-diff',
    title: 'legacy 与主登录路径的输入差异',
    goal:
      '对比 normalizeEmail 与 normalizeEmailLegacy 对 null、空白和大小写的处理差异，并说明这些差异如何改变后续错误。必须同时读取两个实现和事故报告，给出行为差异表。',
    mustMention: ['normalizeEmailLegacy', 'normalizeEmail', 'null', 'trim', 'cookie-v1'],
    round1Files: ['src/auth/login.js', 'src/legacy/login.js', 'docs/incident-2026-10.md', 'src/config.js'],
    round2Files: ['src/util/errors.js', 'src/db/users.js'],
  },
  {
    id: 'constant-audit',
    title: '认证相关常量核对',
    goal:
      '从代码中核对四个认证常量：会话 cookie 名、认证超时毫秒数、登录失败锁定阈值、审计保留天数。必须读取配置与 audit 实现，逐项给出值、来源文件和用途；不要把事故报告当成唯一证据。',
    mustMention: ['acme_sid', '1500', 'MAX_LOGIN_ATTEMPTS', 'AUDIT_RETENTION_DAYS', '30'],
    round1Files: ['src/config.js', 'src/db/audit.js', 'docs/incident-2026-10.md', 'src/auth/session.js'],
    round2Files: ['src/auth/login.js', 'src/db/users.js'],
  },
  {
    id: 'minimal-fix',
    title: '最小修复方案',
    goal:
      '基于事故证据提出最小修复：在 normalizeEmail 之前校验输入、对缺字段返回 400、在异常路径写审计，同时明确不改会话 cookie 名和认证超时。给出要改的文件、函数和验收方式；这是只读分析任务，不要修改仓库。',
    mustMention: ['normalizeEmail', '400', 'recordAudit', 'acme_sid', '1500'],
    round1Files: ['docs/incident-2026-10.md', 'src/auth/login.js', 'src/http/handlers.js', 'src/config.js'],
    round2Files: ['src/util/errors.js', 'src/db/audit.js'],
  },
];

function arg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const pref = `--${name}=`;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith(pref)) return args[i].slice(pref.length);
    if (args[i] === `--${name}` && i + 1 < args.length && !args[i + 1].startsWith('--')) return args[i + 1];
  }
  return undefined;
}

function intArg(name: string, fallback: number, min: number, max: number): number {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${name} 需要数字，收到: ${raw}`);
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function numArg(name: string, fallback: number, min: number, max: number): number {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${name} 需要数字，收到: ${raw}`);
  return Math.min(max, Math.max(min, n));
}

function stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function compactionOf(store: ReturnType<typeof buildRuntime>['store'], runId: string): CompactionAbCompaction | null {
  const c = store.getRunDigest(runId)?.compaction;
  if (!c) return null;
  return {
    count: c.count,
    removedMessages: c.removedMessages,
    maxDepth: c.maxDepth,
    lastSummaryChars: c.lastSummaryChars,
    capReached: c.capReached,
    maxWatermark: c.maxWatermark,
    watermarkSources: c.watermarkSources,
    lastPromptTokens: c.lastPromptTokens,
    contextWindow: c.contextWindow,
  };
}

function countErrors(events: TraceEvent[], result: RunResult) {
  const runtimeErrors = events
    .filter((e) => e.type === 'runtime_error')
    .map((e) => asRecord(e.data))
    .filter((d): d is Record<string, unknown> => !!d);
  const modelErrors = runtimeErrors.filter((d) => d.source === 'provider' || d.code === 'MODEL_ERROR');
  const allMessages = runtimeErrors.map((d) => `${String(d.message ?? '')} ${String(d.failureReason ?? '')}`).join('\n') +
    ' ' + (result.failureReason ?? '');
  const orphanToolErrors = runtimeErrors.filter((d) =>
    /role\s*['"]?tool|tool_calls|preceding message/i.test(`${String(d.message ?? '')} ${String(d.context ?? '')}`),
  );
  return {
    modelErrorCount: modelErrors.length,
    toolErrorCount: events.filter((e) => e.type === 'tool_failed').length,
    orphanToolErrorCount: orphanToolErrors.length || (/role\s*['"]?tool|tool_calls|preceding message/i.test(allMessages) ? 1 : 0),
  };
}

function toResult(
  task: TaskDef,
  strategy: CompactionStrategy,
  iteration: number,
  runId: string,
  result: RunResult,
  events: TraceEvent[],
  compaction: CompactionAbCompaction | null,
): CompactionAbCaseResult {
  const finalAnswer = result.finalAnswer ?? '';
  const { matched, missing } = matchMustMention(finalAnswer, task.mustMention);
  const reads = extractReadStats(events);
  const errors = countErrors(events, result);
  const usage = result.usage;
  return {
    taskId: task.id,
    taskTitle: task.title,
    strategy,
    iteration,
    runId,
    status: result.status,
    completed: result.status === 'completed',
    passed: result.status === 'completed' && missing.length === 0,
    finalAnswer: finalAnswer.slice(0, 12_000),
    mustMention: task.mustMention,
    matched,
    missing,
    steps: result.steps,
    modelCalls: result.modelCalls,
    toolCalls: result.toolCalls,
    readCalls: reads.readCalls,
    uniqueReads: reads.uniqueReads,
    repeatedReads: reads.repeatedReads,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens || usage.promptTokens + usage.completionTokens,
    costUsd: usage.costUsd,
    durationMs: result.totalDurationMs,
    compaction,
    ...errors,
    errorCode: result.errorCode,
    failureReason: result.failureReason,
  };
}

function gitInfo(): { head?: string; dirty?: boolean } {
  try {
    // npm/tsx 在 Windows 下的 PATH 与交互式 PowerShell 不完全一致；用 shell 查找 git 更稳。
    const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', shell: true });
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8', shell: true });
    return {
      head: head.status === 0 ? head.stdout.trim() : undefined,
      dirty: status.status === 0 ? status.stdout.trim().length > 0 : undefined,
    };
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const key = process.env.DEEPSEEK_API_KEY?.trim();
  if (!key) {
    throw new Error('缺少 DEEPSEEK_API_KEY（请使用系统用户级环境变量；本脚本不会把 Key 写入文件）');
  }
  if (!existsSync(FIXTURE)) throw new Error(`fixture 不存在: ${FIXTURE}`);

  const reps = intArg('reps', 3, 1, 10);
  const taskLimit = intArg('tasks', TASKS.length, 1, TASKS.length);
  const budgetUsd = numArg('budget-usd', 1, 0.01, 100);
  const simulatedWindow = intArg('context-window', 4096, 1024, 1_000_000);
  const model = arg('model') ?? 'deepseek-flash';
  const reportArg = arg('report') ?? 'reports/COMPACTION_AB.md';
  const reportPath = isAbsolute(reportArg) ? reportArg : resolve(PROJECT, reportArg);
  const runWaitMs = intArg('wait-ms', 500, 0, 30_000);

  const tasks = TASKS.slice(0, taskLimit);
  const plannedRuns = tasks.length * 2 * reps;
  const runStamp = stamp();
  const evidenceDir = join(PROJECT, 'data', 'compaction-ab', runStamp);
  mkdirSync(evidenceDir, { recursive: true });
  const resultsPath = join(evidenceDir, 'results.jsonl');

  const config = loadConfig();
  config.llmMode = 'openai';
  config.llm.apiKey = key;
  config.codebase.writeEnabled = false;
  config.codebase.runTestsEnabled = false;
  config.stream.liveDeltas = false;
  const dbPath = join(evidenceDir, 'runtime.db');
  config.sqlitePath = dbPath;
  config.log.errorLogPath = join(evidenceDir, 'errors.log');
  config.log.runDigestPath = join(evidenceDir, 'run-digest.jsonl');

  const probeInput: RunInput = {
    runType: 'codebase',
    goal: 'provider probe',
    llm: { mode: 'openai', provider: 'deepseek', model },
  };
  const { provider: baseProvider } = createProvider(config, probeInput);
  const actualContextWindow = baseProvider.contextWindow;
  const provider: LLMProvider = {
    get name() {
      return baseProvider.name;
    },
    get contextWindow() {
      return simulatedWindow;
    },
    chat: (req, onDelta, signal) => baseProvider.chat(req, onDelta, signal),
  };

  const bundle = buildRuntime(config, dbPath);
  const results: CompactionAbCaseResult[] = [];
  let spentUsd = 0;
  let abortedForBudget = false;

  console.log(
    `[compaction-ab] model=${model} simulatedWindow=${simulatedWindow} tasks=${tasks.length} reps=${reps} planned=${plannedRuns} budget=$${budgetUsd.toFixed(2)}`,
  );
  console.log(`[compaction-ab] evidence=${evidenceDir}`);

  try {
    for (const task of tasks) {
      for (const strategy of ['rolling', 'legacy'] as const) {
        for (let iteration = 1; iteration <= reps; iteration++) {
          const remaining = budgetUsd - spentUsd;
          if (remaining < 0.005) {
            abortedForBudget = true;
            console.warn(`[compaction-ab] 预算剩余 $${remaining.toFixed(4)}，停止后续 run`);
            break;
          }

          const runKey = `${task.id}-${strategy}-${iteration}`;
          const repoPath = join(evidenceDir, 'repos', runKey);
          rmSync(repoPath, { recursive: true, force: true });
          mkdirSync(repoPath, { recursive: true });
          copyRepoSnapshot(FIXTURE, repoPath);

          const goal =
            `${task.goal}\n\n` +
            `【验收关键词（最终答案必须原样出现，大小写不敏感）】\n${task.mustMention.join('、')}\n\n` +
            `【工具契约】你只有 read_file。必须严格分两轮读取，第三轮直接输出最终答案：\n` +
            `第一轮（只读下列核心证据，每个文件恰好一次）：\n${task.round1Files.map((f) => `- ${f}`).join('\n')}\n` +
            `第二轮（只读下列旁证，每个文件恰好一次）：\n${task.round2Files.map((f) => `- ${f}`).join('\n')}\n` +
            `第三轮：不要再调用工具，直接输出最终答案。不得把两轮合并，不得重复读取，不得读取清单外文件。\n` +
            `\n\n【工作边界】只读分析，不要修改任何文件；不要猜测未读到的代码。不需要行号，文件路径 + 函数名足够。`;
          const input: RunInput = {
            runType: 'codebase',
            goal,
            repoPath,
            contextFiles: [...task.round1Files, ...task.round2Files],
            allowedTools: ['read_file'],
            maxSteps: task.maxSteps ?? 6,
            maxModelCalls: task.maxModelCalls ?? 6,
            maxToolCalls: task.maxToolCalls ?? 12,
            tokenBudget: 120_000,
            costBudgetUsd: Math.min(0.08, remaining),
            totalTimeoutMs: 180_000,
            compactionStrategy: strategy,
            stream: { liveDeltas: false },
            llm: {
              mode: 'openai',
              provider: 'deepseek',
              model,
              params: { temperature: 0, thinking: 'disabled', maxTokens: 3072 },
              parallelToolCalls: false,
            },
          };

          const runId = bundle.runtime.createRun(input, provider);
          let result: RunResult;
          try {
            result = await bundle.runtime.run(input, runId);
          } catch (e) {
            const rec = bundle.runtime.getRecord(runId);
            result = rec
              ? recordToResult(rec)
              : ({
                  runId,
                  status: 'failed',
                  runType: 'codebase',
                  goal,
                  steps: 0,
                  modelCalls: 0,
                  toolCalls: 0,
                  totalDurationMs: 0,
                  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, isEstimate: true },
                  isMock: false,
                  failureReason: e instanceof Error ? e.message : String(e),
                  errorCode: 'EVAL_EXCEPTION',
                } satisfies RunResult);
          }

          const events = bundle.store.getEvents(runId);
          const row = toResult(task, strategy, iteration, runId, result, events, compactionOf(bundle.store, runId));
          results.push(row);
          spentUsd += row.costUsd;
          appendFileSync(resultsPath, JSON.stringify(row) + '\n', 'utf8');
          console.log(
            `[${results.length}/${plannedRuns}] ${task.id} ${strategy} #${iteration} ${row.status} pass=${row.passed ? 'Y' : 'N'} ` +
              `kw=${row.matched.length}/${row.mustMention.length} tok=${row.totalTokens} $${row.costUsd.toFixed(4)} ` +
              `compact=${row.compaction?.count ?? 0} repeatRead=${row.repeatedReads}/${row.readCalls} ${Math.round(row.durationMs)}ms`,
          );

          if (runWaitMs) await sleep(runWaitMs);
        }
        if (abortedForBudget) break;
      }
      if (abortedForBudget) break;
    }
  } finally {
    bundle.store.close();
  }

  const attemptedRuns = results.length;
  const meta = {
    generatedAt: new Date().toISOString(),
    command: 'npm run eval:compaction',
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    provider: 'deepseek',
    model,
    simulatedContextWindow: simulatedWindow,
    actualContextWindow,
    fixture: 'multi-tool-agent/eval/compaction-fixture/base',
    taskCount: tasks.length,
    reps,
    plannedRuns,
    attemptedRuns,
    budgetUsd,
    spentUsd,
    evidenceDir: evidenceDir.replace(/\\/g, '/'),
    ...gitInfo(),
    notes: [
      `模型真实窗口 ${actualContextWindow ?? 'unknown'}；${simulatedWindow} 只是压缩决策的模拟窗口，不改变模型请求上限。`,
      '关键词全中是结构化验收，不衡量解释是否优雅、是否给出更好的架构建议。',
      abortedForBudget ? '预算在计划跑完前耗尽，实验被标记为不完整。' : '本批计划 run 已全部尝试。',
    ],
  };
  const report = renderCompactionAbReport(meta, results);
  mkdirSync(dirname(reportPath), { recursive: true });
  // 与本仓其它报告一致：CRLF + UTF-8 无 BOM。
  writeFileSync(reportPath, report.replace(/\r?\n/g, '\r\n'), 'utf8');
  const summary = summarizeCompactionAb(results);
  const verdict = compareCompactionAb(results, { plannedRuns });
  writeFileSync(
    join(evidenceDir, 'summary.json'),
    JSON.stringify({ meta, summary, verdict, results }, null, 2),
    'utf8',
  );

  console.log(`[compaction-ab] report=${reportPath}`);
  console.log(`[compaction-ab] verdict=${verdict.status} spent=$${spentUsd.toFixed(4)} runs=${attemptedRuns}/${plannedRuns}`);
  if (attemptedRuns < plannedRuns) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`[compaction-ab] 失败：${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
