// scripts/edit-eval-real.ts — 真实模型编辑评测（20 条小任务）
//
// 与 eval:edit 的分工：
//   - eval:edit        = 确定性管线（脚本扮演模型），tokens=0，证明「门禁/审批/回滚」可靠；
//   - eval:edit:real   = 真实模型（DeepSeek），证明「模型能不能在这个管线里把活干成」。
//
// 每条任务：复制独立 fixture → 注入一个缺陷（或要求新增能力）→ 真实 code-edit 子 Agent 在
// Docker 沙箱里改 → 自动审批放行 → 落盘 → 宿主跑 4 个测试文件 → 断言目标文件内容。
//
// 运行：npm run eval:edit:real [-- --tasks=20 --budget-usd=1 --timeout-ms=240000]
// 产物：reports/EDIT_EVAL_REAL.md + data/edit-eval-real/<stamp>/

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { buildRegistry } from '../src/tools/index.js';
import { SandboxSession, copyRepoSnapshot } from '../src/sandbox/session.js';
import { runSubAgent } from '../src/runtime/subAgentLoop.js';
import { getSpec } from '../src/agents/specs.js';
import { createProvider } from '../src/llm/index.js';
import { EventLogger } from '../src/trace/EventLogger.js';
import { Tracer } from '../src/trace/Tracer.js';
import type { ApprovalDecision, ApprovalRequest, RunInput, SubtaskOutcome } from '../src/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..');
const FIXTURE = join(PROJECT, 'eval', 'edit-fixture', 'real');
const TEST_FILES = ['tests/calc.test.ts', 'tests/strings.test.ts', 'tests/arrays.test.ts', 'tests/validate.test.ts'];

interface Task {
  id: string;
  title: string;
  goal: string;
  setup?: Array<{ path: string; find: string; replace: string }>;
  expect: Array<{ path: string; includes?: string; notIncludes?: string; regex?: string }>;
}

const TASKS: Task[] = [
  {
    id: 'R01',
    title: '修复 add 的减法错误',
    goal: 'src/calc.ts 里的 add(a, b) 现在返回 a - b，导致 tests/calc.test.ts 失败。把它修成算术加法，只改实现，不要改测试。',
    setup: [{ path: 'src/calc.ts', find: 'return a + b;', replace: 'return a - b;' }],
    expect: [{ path: 'src/calc.ts', includes: 'return a + b;' }],
  },
  {
    id: 'R02',
    title: '修复 sub 的加法错误',
    goal: 'src/calc.ts 里的 sub(a, b) 现在返回 a + b，导致测试失败。把它修成减法，只改实现。',
    setup: [{ path: 'src/calc.ts', find: 'return a - b;', replace: 'return a + b;' }],
    expect: [{ path: 'src/calc.ts', includes: 'return a - b;' }],
  },
  {
    id: 'R03',
    title: '修复 mul 的实现',
    goal: 'src/calc.ts 里的 mul(a, b) 用了加法，导致 mul(4, 3) 不是 12。修成乘法，只改实现。',
    setup: [{ path: 'src/calc.ts', find: 'return a * b;', replace: 'return a + b;' }],
    expect: [{ path: 'src/calc.ts', includes: 'return a * b;' }],
  },
  {
    id: 'R04',
    title: '补回除零检查',
    goal: 'src/calc.ts 的 div(a, b) 缺少除零检查，tests/calc.test.ts 要求 b=0 时抛 /divide by zero/。补回检查。',
    setup: [{ path: 'src/calc.ts', find: "  if (b === 0) throw new Error('divide by zero');\n  return a / b;", replace: '  return a / b;' }],
    expect: [{ path: 'src/calc.ts', regex: "b\\s*===\\s*0[\\s\\S]{0,80}divide by zero" }],
  },
  {
    id: 'R05',
    title: '修复 clamp 忽略上限',
    goal: 'src/calc.ts 的 clamp(n, min, max) 现在只保证下界、不保证上界，clamp(11, 0, 10) 返回 11。修复为同时夹在 [min, max]。',
    setup: [{ path: 'src/calc.ts', find: 'return Math.min(max, Math.max(min, n));', replace: 'return Math.max(min, n);' }],
    expect: [{ path: 'src/calc.ts', includes: 'Math.min' }],
  },
  {
    id: 'R06',
    title: '修复 capitalize 未大写',
    goal: 'src/strings.ts 的 capitalize 返回原串、没有大写首字母。修复它，空串仍应返回空串。',
    setup: [{ path: 'src/strings.ts', find: 'return s[0].toUpperCase() + s.slice(1);', replace: 'return s[0] + s.slice(1);' }],
    expect: [{ path: 'src/strings.ts', includes: 'toUpperCase()' }],
  },
  {
    id: 'R07',
    title: '修复 truncate 短串被截断',
    goal: 'src/strings.ts 的 truncate 对短串也追加省略号。修复为：长度 <= max 时原样返回，否则截断并加 …。',
    setup: [{ path: 'src/strings.ts', find: "return s.length <= max ? s : s.slice(0, max) + '…';", replace: "return s.slice(0, max) + '…';" }],
    expect: [{ path: 'src/strings.ts', regex: 's\\.length\\s*<=\\s*max' }],
  },
  {
    id: 'R08',
    title: '修复 slugify 未替换空格',
    goal: 'src/strings.ts 的 slugify 没有把空白替换成连字符，slugify("  Hello World  ") 不等于 "hello-world"。修复它。',
    setup: [{ path: 'src/strings.ts', find: ".replace(/\\s+/g, '-')", replace: ".replace(/\\s+/g, ' ')" }],
    expect: [{ path: 'src/strings.ts', regex: "replace\\(/\\\\s\\+/g,\\s*'-'\\)" }],
  },
  {
    id: 'R09',
    title: '修复 sum 空数组崩溃',
    goal: 'src/arrays.ts 的 sum 对空数组会抛错（reduce 没有初始值）。修复为返回 0。',
    setup: [{ path: 'src/arrays.ts', find: 'return nums.reduce((acc, n) => acc + n, 0);', replace: 'return nums.reduce((acc, n) => acc + n);' }],
    expect: [{ path: 'src/arrays.ts', includes: ', 0)' }],
  },
  {
    id: 'R10',
    title: '修复 unique 未去重',
    goal: 'src/arrays.ts 的 unique 直接返回原数组，没有去重。修复为保持首次出现顺序的去重。',
    setup: [{ path: 'src/arrays.ts', find: 'return [...new Set(items)];', replace: 'return [...items];' }],
    expect: [{ path: 'src/arrays.ts', includes: 'new Set' }],
  },
  {
    id: 'R11',
    title: '补回 chunk 的 size 校验',
    goal: 'src/arrays.ts 的 chunk 缺少 size<=0 的校验，chunk([1], 0) 不再抛错。补回校验（错误信息含 size must be > 0）。',
    setup: [{ path: 'src/arrays.ts', find: "  if (size <= 0) throw new Error('size must be > 0');\n", replace: '' }],
    expect: [
      { path: 'src/arrays.ts', regex: 'size\\s*<=\\s*0|!\\s*\\(\\s*size\\s*>\\s*0\\s*\\)' },
      { path: 'src/arrays.ts', includes: 'size must be > 0' },
    ],
  },
  {
    id: 'R12',
    title: '修复 name 校验条件反向',
    goal: 'src/validate.ts 的 validateUser 在 name 非空时反而报 name is required。修复判断条件。',
    setup: [{ path: 'src/validate.ts', find: "if (!input.name || input.name.trim() === '')", replace: "if (input.name && input.name.trim() !== '')" }],
    expect: [{ path: 'src/validate.ts', regex: "trim\\(\\)\\s*===\\s*''" }],
  },
  {
    id: 'R13',
    title: '修复 age 上限',
    goal: 'src/validate.ts 的 age 校验上限被写成 200，但契约要求 0..150。修复上限。',
    setup: [{ path: 'src/validate.ts', find: 'input.age > 150', replace: 'input.age > 200' }],
    expect: [{ path: 'src/validate.ts', includes: '150' }],
  },
  {
    id: 'R14',
    title: '恢复 email 校验',
    goal: 'src/validate.ts 的 email 正则被放宽成匹配一切，导致 nope 也通过。恢复为要求 local@domain.tld 的校验。',
    setup: [{ path: 'src/validate.ts', find: "!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(input.email)", replace: 'false' }],
    expect: [{ path: 'src/validate.ts', regex: '@' }],
  },
  {
    id: 'R15',
    title: '新增 average 函数',
    goal: '在 src/calc.ts 新增并导出 average(nums: number[]): number，空数组返回 0。不要改动已有函数。',
    expect: [{ path: 'src/calc.ts', regex: 'export function average\\s*\\(' }],
  },
  {
    id: 'R16',
    title: '新增 has 函数',
    goal: '在 src/arrays.ts 新增并导出 has<T>(items: T[], value: T): boolean，用 includes 判断。不要改动已有函数。',
    expect: [{ path: 'src/arrays.ts', regex: 'export function has' }],
  },
  {
    id: 'R17',
    title: '新增 reverse 函数',
    goal: '在 src/strings.ts 新增并导出 reverse(s: string): string，返回反转后的字符串。不要改动已有函数。',
    expect: [{ path: 'src/strings.ts', regex: 'export function reverse' }],
  },
  {
    id: 'R18',
    title: '新增并导出 isEmail',
    goal: '在 src/validate.ts 新增并导出 isEmail(s: string): boolean，复用与 validateUser 相同的邮箱规则。不要改动已有函数的行为。',
    expect: [{ path: 'src/validate.ts', regex: 'export function isEmail' }],
  },
  {
    id: 'R19',
    title: '提取邮箱正则常量',
    goal: '把 src/validate.ts 里重复的邮箱正则提取为模块级常量 EMAIL_RE（并导出），validateUser 使用它；行为不变，测试必须仍全绿。',
    expect: [{ path: 'src/validate.ts', regex: 'const EMAIL_RE|EMAIL_RE\\s*=' }],
  },
  {
    id: 'R20',
    title: '收紧 sum 参数类型',
    goal: '把 src/arrays.ts 的 sum 参数类型从 number[] 改为 readonly number[]；行为不变，测试必须仍全绿。',
    expect: [{ path: 'src/arrays.ts', includes: 'readonly number[]' }],
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
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(`--${name} 需要 ${min}..${max} 的整数，收到: ${raw}`);
  }
  return n;
}

function numArg(name: string, fallback: number, min: number, max: number): number {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`--${name} 需要 ${min}..${max} 的数字，收到: ${raw}`);
  return n;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function applySetup(repo: string, task: Task): { notes: string[]; missed: string[] } {
  const notes: string[] = [];
  const missed: string[] = [];
  for (const s of task.setup ?? []) {
    const abs = join(repo, s.path);
    // fixture 在 Windows 工作区是 CRLF；统一成 LF 再匹配，否则 setup 会静默不生效。
    const before = readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
    const after = before.replace(s.find.replace(/\r\n/g, '\n'), s.replace);
    if (after === before) missed.push(`${s.path}: ${s.find.slice(0, 40)}`);
    writeFileSync(abs, after, 'utf8');
  }
  return { notes, missed };
}

function runHostTests(repo: string): { ok: boolean; output: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...TEST_FILES], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 120_000,
    shell: false,
  });
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
  return { ok: r.status === 0, output };
}

function runFixtureBaseline(): { ok: boolean; output: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...TEST_FILES.map((f) => join(FIXTURE, f))], {
    cwd: PROJECT,
    encoding: 'utf8',
    timeout: 120_000,
    shell: false,
  });
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
  return { ok: r.status === 0, output };
}

function wilsonLowerBound(passed: number, total: number): number {
  if (total <= 0) return 0;
  const z = 1.96;
  const p = passed / total;
  const denom = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return Math.max(0, centre - margin);
}

function checkExpect(repo: string, task: Task): Array<{ ok: boolean; detail: string }> {
  const out: Array<{ ok: boolean; detail: string }> = [];
  for (const e of task.expect) {
    const abs = join(repo, e.path);
    if (!existsSync(abs)) {
      out.push({ ok: false, detail: `${e.path} 不存在` });
      continue;
    }
    const text = readFileSync(abs, 'utf8');
    if (e.includes !== undefined) out.push({ ok: text.includes(e.includes), detail: `${e.path} 应包含 ${JSON.stringify(e.includes)}` });
    if (e.notIncludes !== undefined) out.push({ ok: !text.includes(e.notIncludes), detail: `${e.path} 不应包含 ${JSON.stringify(e.notIncludes)}` });
    if (e.regex !== undefined) out.push({ ok: new RegExp(e.regex).test(text), detail: `${e.path} 应匹配 /${e.regex}/` });
  }
  return out;
}

interface TaskResult {
  id: string;
  title: string;
  status: 'passed' | 'failed' | 'invalid';
  applied: string[];
  approvals: number;
  hostOk: boolean;
  expectOk: boolean;
  steps: number;
  modelCalls: number;
  toolCalls: number;
  tokens: number;
  costUsd: number;
  wallMs: number;
  failure?: string;
  notes: string[];
}

async function main(): Promise<void> {
  const key = process.env.DEEPSEEK_API_KEY?.trim();
  if (!key) throw new Error('缺少 DEEPSEEK_API_KEY（不会写入文件）');
  if (!existsSync(FIXTURE)) throw new Error(`fixture 不存在: ${FIXTURE}`);

  const limit = intArg('tasks', TASKS.length, 1, TASKS.length);
  const budgetUsd = numArg('budget-usd', 1, 0.01, 50);
  const timeoutMs = intArg('timeout-ms', 240_000, 10_000, 900_000);
  const model = arg('model') ?? 'deepseek-flash';
  const preflightOnly = process.argv.includes('--preflight-only');

  const baseline = runFixtureBaseline();
  if (!baseline.ok) throw new Error(`fixture 基线不绿，拒绝开始评测：\n${baseline.output.slice(-2000)}`);
  console.log('[eval:edit:real] fixture 基线：15/15 通过');
  if (preflightOnly) return;

  const tasks = TASKS.slice(0, limit);
  const runStamp = stamp();
  const evidenceDir = join(PROJECT, 'data', 'edit-eval-real', runStamp);
  mkdirSync(evidenceDir, { recursive: true });

  const config = loadConfig();
  config.llmMode = 'openai';
  config.llm.apiKey = key;
  config.codebase.writeEnabled = true;
  config.codebase.runTestsEnabled = true;
  config.codebase.hostNodePath = process.execPath;
  config.stream.liveDeltas = false;
  config.sqlitePath = join(evidenceDir, 'runtime.db');
  config.log.errorLogPath = join(evidenceDir, 'errors.log');
  config.log.runDigestPath = join(evidenceDir, 'run-digest.jsonl');

  const probe: RunInput = { runType: 'codebase', goal: 'probe', llm: { mode: 'openai', provider: 'deepseek', model } };
  const { provider } = createProvider(config, probe);
  const registry = buildRegistry();
  const spec = getSpec('code-edit');
  if (!spec) throw new Error('缺少 code-edit 契约');

  const logger = new EventLogger({ maxContentChars: 2000 });
  const tracer = new Tracer(logger);
  const results: TaskResult[] = [];
  let spent = 0;

  for (const task of tasks) {
    if (spent >= budgetUsd) {
      results.push({
        id: task.id, title: task.title, status: 'failed', applied: [], approvals: 0, hostOk: false, expectOk: false,
        steps: 0, modelCalls: 0, toolCalls: 0, tokens: 0, costUsd: 0, wallMs: 0,
        failure: `预算用尽（$${spent.toFixed(4)} >= $${budgetUsd}）`, notes: [],
      });
      continue;
    }
    const started = Date.now();
    const taskDir = join(evidenceDir, task.id);
    mkdirSync(taskDir, { recursive: true });
    const repo = join(taskDir, 'repo');
    copyRepoSnapshot(FIXTURE, repo);
    const setup = applySetup(repo, task);
    const setupNotes = setup.notes;
    if (setup.missed.length) {
      // 缺陷没注入成功 → 任务无效，不能算通过（否则模型看到的是正确代码）
      results.push({
        id: task.id, title: task.title, status: 'invalid', applied: [], approvals: 0, hostOk: false, expectOk: false,
        steps: 0, modelCalls: 0, toolCalls: 0, tokens: 0, costUsd: 0, wallMs: Date.now() - started,
        failure: `setup 未命中：${setup.missed.join('; ')}`, notes: setupNotes,
      });
      continue;
    }
    const nm = join(repo, 'node_modules');
    let junction = false;
    try {
      symlinkSync(join(PROJECT, 'node_modules'), nm, 'junction');
      junction = true;
    } catch (e) {
      setupNotes.push(`junction 失败: ${(e as Error).message}`);
    }

    const approvals: ApprovalRequest[] = [];
    const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
    const session = new SandboxSession({ image: config.sandbox.image, repoPath: repo, dataDir: join(evidenceDir, 'sandbox') }, `real_${runStamp}_${task.id}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const runId = `real_${runStamp}_${task.id}`;
    let outcome: SubtaskOutcome | null = null;
    let failure: string | undefined;

    try {
      const ensured = await session.ensure();
      if (!ensured.ok) throw new Error(`沙箱不可用: ${ensured.reason}`);
      outcome = await runSubAgent({
        parentRunId: runId,
        request: {
          specId: spec.id,
          objective: task.goal,
          inputs: { dir: '.' },
          boundary: '只改 src/ 下需要的实现；不要改 tests/ 里的断言来让测试变绿。',
          expectedOutput: '改动通过沙箱检查、经审批落盘、宿主测试全绿；用 submit_changes 提交。',
        },
        spec,
        provider,
        registry,
        tracer,
        config,
        repoPath: repo,
        signal: controller.signal,
        streamDeltas: false,
        sandbox: session,
        requestApproval: async (req): Promise<ApprovalDecision> => {
          approvals.push(req);
          return { approvalId: req.approvalId, value: 'allow_once', decidedAt: new Date().toISOString() };
        },
        emitEvent: (type, data) => events.push({ type, data }),
      });
    } catch (e) {
      failure = (e as Error).message;
    } finally {
      clearTimeout(timer);
      await session.dispose?.();
    }

    const host = runHostTests(repo);
    const checks = checkExpect(repo, task);
    const expectOk = checks.every((c) => c.ok);
    const applied = events
      .filter((e) => e.type === 'verification_completed' && (e.data as any)?.phase === 'host')
      .flatMap((e) => (Array.isArray((e.data as any)?.files) ? ((e.data as any).files as string[]) : []));
    const usage = outcome?.usage;
    const tokens = usage?.totalTokens ?? 0;
    const costUsd = usage?.costUsd ?? 0;
    spent += costUsd;
    if (!host.ok) failure = failure ?? '宿主测试未全绿';
    if (!expectOk) failure = failure ?? checks.filter((c) => !c.ok).map((c) => c.detail).join('; ');

    results.push({
      id: task.id,
      title: task.title,
      status: host.ok && expectOk ? 'passed' : 'failed',
      applied,
      approvals: approvals.length,
      hostOk: host.ok,
      expectOk,
      steps: outcome?.steps ?? 0,
      modelCalls: outcome?.modelCalls ?? 0,
      toolCalls: outcome?.toolCalls ?? 0,
      tokens,
      costUsd,
      wallMs: Date.now() - started,
      failure,
      notes: [...setupNotes, ...(outcome?.report?.summary ? [`report: ${outcome.report.summary.slice(0, 200)}`] : [])],
    });

    writeFileSync(join(taskDir, 'result.json'), JSON.stringify({ task, result: results[results.length - 1], hostOutput: host.output.slice(-4000), checks }, null, 2), 'utf8');
    if (junction) {
      try { unlinkSync(nm); } catch {}
    }
  }

  const valid = results.filter((r) => r.status !== 'invalid');
  const invalid = results.length - valid.length;
  const passed = valid.filter((r) => r.status === 'passed').length;
  const totalTokens = results.reduce((a, r) => a + r.tokens, 0);
  const totalCost = results.reduce((a, r) => a + r.costUsd, 0);
  const hostPass = valid.filter((r) => r.hostOk).length;
  const passRate = passed / Math.max(1, valid.length);
  const lower = wilsonLowerBound(passed, valid.length);
  const avgSteps = results.reduce((a, r) => a + r.steps, 0) / Math.max(1, results.length);
  const avgModelCalls = results.reduce((a, r) => a + r.modelCalls, 0) / Math.max(1, results.length);
  const avgToolCalls = results.reduce((a, r) => a + r.toolCalls, 0) / Math.max(1, results.length);
  const p95Ms = [...results.map((r) => r.wallMs)].sort((a, b) => a - b)[Math.max(0, Math.ceil(results.length * 0.95) - 1)] ?? 0;

  const lines: string[] = [];
  lines.push('# 真实模型编辑评测（EDIT_EVAL_REAL）', '');
  lines.push(`> 生成时间：${new Date().toISOString()} ｜ 模型：\`${model}\` ｜ fixture：\`eval/edit-fixture/real/\`（4 源文件 + 4 测试文件，基线 15/15）`);
  lines.push('> 衡量的是**真实模型在编辑管线里的完成能力**，与 `EDIT_EVAL.md`（确定性管线，tokens=0）分开汇报。', '');
  lines.push('> 复现：`cd multi-tool-agent && npm.cmd run eval:edit:real -- --tasks=' + results.length + ' --budget-usd=' + budgetUsd + ' --timeout-ms=' + timeoutMs + '` ｜ 证据：`' + relative(PROJECT, evidenceDir).replace(/\\/g, '/') + '`', '');
  lines.push('## 汇总', '');
  lines.push('| 指标 | 值 |');
  lines.push('|---|---|');
  lines.push(`| 任务数 | ${results.length}（有效 ${valid.length} / 无效 ${invalid}） |`);
  lines.push(`| 通过（宿主全绿 + 断言全中） | **${passed}/${valid.length}（${(passRate * 100).toFixed(1)}%）** |`);
  lines.push(`| 95% Wilson 下界（单轮） | **${(lower * 100).toFixed(1)}%**（不是稳定能力承诺） |`);
  lines.push(`| 宿主测试通过率（L2） | **${hostPass}/${valid.length}（${((hostPass / Math.max(1, valid.length)) * 100).toFixed(1)}%）** |`);
  lines.push(`| 审批次数 | ${results.reduce((a, r) => a + r.approvals, 0)} |`);
  lines.push(`| tokens | ${totalTokens} |`);
  lines.push(`| 成本 | $${totalCost.toFixed(4)} |`);
  lines.push(`| 平均耗时 | ${(results.reduce((a, r) => a + r.wallMs, 0) / results.length / 1000).toFixed(1)}s |`);
  lines.push(`| P95 耗时 | ${(p95Ms / 1000).toFixed(1)}s |`);
  lines.push(`| 平均步骤 / 模型调用 / 工具调用 | ${avgSteps.toFixed(1)} / ${avgModelCalls.toFixed(1)} / ${avgToolCalls.toFixed(1)} |`);
  lines.push(`| 每题平均 tokens / 成本 | ${Math.round(totalTokens / Math.max(1, results.length))} / $${(totalCost / Math.max(1, results.length)).toFixed(4)} |`);
  lines.push('', '## 逐条结果', '');
  lines.push('| ID | 任务 | 结果 | 落盘 | 审批 | L2 | 断言 | tokens | 失败原因 |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const mark = r.status === 'passed' ? '通过' : r.status === 'invalid' ? '无效' : '失败';
    lines.push(`| ${r.id} | ${r.title} | ${mark} | ${r.applied.join('<br>') || '—'} | ${r.approvals} | ${r.hostOk ? '✅' : '❌'} | ${r.expectOk ? '✅' : '❌'} | ${r.tokens} | ${(r.failure ?? '').slice(0, 120) || '—'} |`);
  }
  lines.push('', '## 口径与边界', '');
  lines.push('- 每条任务复制独立 fixture；`setup` 注入的缺陷会让基线测试先失败（R15~R20 是新增/重构任务，不注入缺陷）。');
  lines.push('- 审批是**自动 allow_once**：评测的是模型能否改对，不是人工审批体验；审批次数仍记录。');
  lines.push('- 判定要求同时满足：宿主 4 个测试文件全绿 + `expect` 断言命中。只看「模型说改好了」不算通过。');
  lines.push('- `setup` 未命中的任务标记为 `invalid` 并从分母排除；R11 接受 `size <= 0` 或等价的 `!(size > 0)`，同时要求错误文案含 `size must be > 0`。');
  lines.push('- 成本按 Provider 返回值累计；预算用尽后剩余任务记失败并标原因，不重试。');
  lines.push(`- 单轮 ${results.length} 条，95% Wilson 下界 **${(lower * 100).toFixed(1)}%**；不能把 100% 点估计当成稳定能力，需重复跑与扩样本。`);
  lines.push('- 只覆盖小函数级修改；不代表大型重构、多文件架构调整或模糊需求。');

  const reportPath = join(PROJECT, 'reports', 'EDIT_EVAL_REAL.md');
  writeFileSync(reportPath, lines.join('\n'), 'utf8');
  writeFileSync(join(evidenceDir, 'summary.json'), JSON.stringify({ runStamp, model, results, totals: { passed, totalTokens, totalCost } }, null, 2), 'utf8');
  const manifest = {
    schemaVersion: 1,
    runStamp,
    model,
    fixture: 'eval/edit-fixture/real/',
    generatedAt: new Date().toISOString(),
    totals: { tasks: results.length, valid: valid.length, invalid, passed, hostPass, totalTokens, totalCost, passRate, wilson95Lower: lower },
    policy: { approval: 'auto allow_once', scoring: 'host L2 green AND expect checks pass', setupMiss: 'invalid/excluded' },
    results,
  };
  writeFileSync(join(PROJECT, 'reports', 'EDIT_EVAL_REAL_EVIDENCE.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log(`[eval:edit:real] ${passed}/${results.length} 通过 · L2 ${hostPass}/${results.length} · ${totalTokens} tokens · $${totalCost.toFixed(4)}`);
  console.log(`[eval:edit:real] 报告: ${reportPath}`);
  console.log(`[eval:edit:real] 证据: ${evidenceDir}`);
}

main().catch((e) => {
  console.error(`[eval:edit:real] 失败: ${(e as Error).message}`);
  process.exit(1);
});
