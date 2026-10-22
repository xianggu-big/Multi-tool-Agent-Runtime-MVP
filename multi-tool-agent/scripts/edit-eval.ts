// scripts/edit-eval.ts — 可复现的编辑管线评测（真 Docker / 真审批 / 真落盘 / 真复验）
//
// 运行：npm run eval:edit
// 产出：reports/EDIT_EVAL.md + data/edit-eval/<stamp>/（逐场景证据）
//
// 设计取舍：
//   - 不用 LLM：场景由脚本确定性驱动，衡量的是管线是否按设计拦住坏改动、
//     放行好改动、宿主复验失败能回滚，而不是模型编辑智力。
//   - 每个场景复制独立 fixture，不污染 demo/codebase-sample / 用户仓库。
//   - 宿主复验需要 fixture 里能解析 tsx：临时仓库用 junction 指向本项目的 node_modules。
//   - 不做“跳过即通过”：Docker/镜像不可用时直接失败退出，不覆盖已有报告。

import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { buildRegistry } from '../src/tools/index.js';
import { SandboxSession, copyRepoSnapshot } from '../src/sandbox/session.js';
import { dockerAvailableAsync } from '../src/sandbox/docker.js';
import type { ToolContext, ToolRuntimeConfig } from '../src/tools/types.js';
import type { ApprovalDecision, ApprovalRequest } from '../src/types.js';
import {
  classifyEditOutcome,
  renderEditEvalReport,
  type EditEvalAssertion,
  type EditEvalCaseResult,
  type EditEvalCheck,
  type EditEvalExpected,
} from '../src/evaluation/editEval.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..');
const REPO_ROOT = resolve(PROJECT, '..');
const FIXTURE = join(PROJECT, 'eval', 'edit-fixture', 'base');

interface StepSpec {
  tool: string;
  args: Record<string, unknown>;
}

interface Facts {
  repo: string;
  post: Record<string, string | null>;
  result: { ok: boolean; error?: { code?: string; message?: string }; data?: Record<string, any> };
  approvals: ApprovalRequest[];
  rolledBack: string[];
  baseline: (rel: string) => string | null;
  events: Array<{ type: string; data?: Record<string, any> }>;
  sandbox: { ran: boolean; ok: boolean; steps: EditEvalCheck[] };
  host: { ran: boolean; ok: boolean; mode?: string; coverage?: string; note?: string } | null;
}

interface Scenario {
  id: string;
  title: string;
  expected: EditEvalExpected;
  steps: StepSpec[];
  /** 场景开始前写入的基线（覆盖 fixture；用于让除 E1 外的场景从绿色开始） */
  setup?: Array<{ path: string; content: string }>;
  approval: 'allow_once' | 'deny' | 'mutate_before_allow';
  mutation?: { rel: string; content: string };
  assert: (f: Facts) => EditEvalAssertion[];
  /** 返回非空字符串 = 本环境跳过（例如宿主不是 Windows） */
  skipReason?: () => string | null;
}

const GREEN_CALC = 'export function add(a: number, b: number): number {\n  return a + b;\n}\n';
const EXTERNAL_CALC = 'export function add(a: number, b: number): number {\n  return 999;\n}\n';

const SCENARIOS: Scenario[] = [
  {
    id: 'E1',
    title: '单文件正确修复',
    expected: 'applied',
    approval: 'allow_once',
    steps: [{ tool: 'edit_file', args: { path: 'src/calc.ts', oldString: 'return a - b;', newString: 'return a + b;' } }],
    assert: (f) => [
      { name: '审批恰好 1 次', ok: f.approvals.length === 1, detail: `实际 ${f.approvals.length}` },
      { name: '修复内容已落盘', ok: f.post['src/calc.ts']?.includes('return a + b;') === true },
      { name: '沙箱检查全部通过', ok: f.sandbox.ran && f.sandbox.ok },
      { name: '宿主复验通过', ok: f.host?.ran === true && f.host?.ok === true, detail: f.host?.note },
    ],
  },
  {
    id: 'E2',
    title: '新增模块 + 测试（批量一次审批）',
    expected: 'applied',
    setup: [{ path: 'src/calc.ts', content: GREEN_CALC }],
    approval: 'allow_once',
    steps: [
      {
        tool: 'create_file',
        args: {
          path: 'src/slug.ts',
          content:
            "export function slugify(input: string): string {\n  return input.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');\n}\n",
        },
      },
      {
        tool: 'create_file',
        args: {
          path: 'tests/slug.test.ts',
          content:
            "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from '../src/slug.js';\n\ntest('slugify normalizes words', () => {\n  assert.equal(slugify('Hello World'), 'hello-world');\n});\n",
        },
      },
    ],
    assert: (f) => [
      { name: '两文件合并为 1 次审批', ok: f.approvals.length === 1, detail: `实际 ${f.approvals.length}` },
      { name: '模块已落盘', ok: f.post['src/slug.ts']?.includes('export function slugify') === true },
      { name: '测试已落盘', ok: f.post['tests/slug.test.ts']?.includes('slugify') === true },
      { name: '宿主复验通过', ok: f.host?.ran === true && f.host?.ok === true, detail: f.host?.note },
    ],
  },
  {
    id: 'E3',
    title: '语法错误在沙箱被拦下',
    expected: 'sandbox_rejected',
    setup: [{ path: 'src/calc.ts', content: GREEN_CALC }],
    approval: 'allow_once',
    steps: [{ tool: 'edit_file', args: { path: 'src/calc.ts', oldString: 'return a + b;', newString: 'return a + ;' } }],
    assert: (f) => [
      { name: '错误码为 SANDBOX_CHECK_FAILED', ok: f.result.error?.code === 'SANDBOX_CHECK_FAILED', detail: f.result.error?.code },
      { name: '没有触发审批', ok: f.approvals.length === 0, detail: `实际 ${f.approvals.length}` },
      { name: '沙箱检查失败', ok: f.sandbox.ran && !f.sandbox.ok },
      { name: '真实仓库未被修改', ok: f.post['src/calc.ts'] === f.baseline('src/calc.ts') },
    ],
  },
  {
    id: 'E4',
    title: '行为错误（测试失败）在沙箱被拦下',
    expected: 'sandbox_rejected',
    setup: [{ path: 'src/calc.ts', content: GREEN_CALC }],
    approval: 'allow_once',
    steps: [{ tool: 'edit_file', args: { path: 'src/calc.ts', oldString: 'return a + b;', newString: 'return a * b;' } }],
    assert: (f) => [
      { name: '错误码为 SANDBOX_CHECK_FAILED', ok: f.result.error?.code === 'SANDBOX_CHECK_FAILED', detail: f.result.error?.code },
      { name: '没有触发审批', ok: f.approvals.length === 0, detail: `实际 ${f.approvals.length}` },
      { name: '沙箱测试失败', ok: f.sandbox.ran && !f.sandbox.ok },
      { name: '真实仓库未被修改', ok: f.post['src/calc.ts'] === f.baseline('src/calc.ts') },
    ],
  },
  {
    id: 'E5',
    title: '用户拒绝审批',
    expected: 'approval_denied',
    setup: [{ path: 'src/calc.ts', content: GREEN_CALC }],
    approval: 'deny',
    steps: [{ tool: 'edit_file', args: { path: 'src/calc.ts', oldString: 'return a + b;', newString: 'return b + a;' } }],
    assert: (f) => [
      { name: '错误码为 APPROVAL_DENIED', ok: f.result.error?.code === 'APPROVAL_DENIED', detail: f.result.error?.code },
      { name: '审批恰好 1 次', ok: f.approvals.length === 1, detail: `实际 ${f.approvals.length}` },
      { name: '拒绝后未落盘', ok: f.post['src/calc.ts'] === f.baseline('src/calc.ts') },
      { name: '未运行宿主复验', ok: f.host === null },
    ],
  },
  {
    id: 'E6',
    title: '沙箱绿、宿主红 → 自动回滚',
    expected: 'rolled_back',
    setup: [{ path: 'src/calc.ts', content: GREEN_CALC }],
    approval: 'allow_once',
    skipReason: () => (process.platform === 'win32' ? null : '该场景依赖“沙箱 Linux / 宿主非 Linux”的平台差异'),
    steps: [
      {
        tool: 'create_file',
        args: {
          path: 'tests/platform.test.ts',
          content:
            "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n\ntest('linux-only assumption', () => {\n  assert.equal(process.platform, 'linux');\n});\n",
        },
      },
    ],
    assert: (f) => [
      { name: '宿主复验运行且失败', ok: f.host?.ran === true && f.host?.ok === false, detail: f.host?.note },
      { name: '失败文件被自动回滚', ok: f.rolledBack.includes('tests/platform.test.ts'), detail: f.rolledBack.join(',') },
      { name: '回滚后新增文件不存在', ok: f.post['tests/platform.test.ts'] === null },
      { name: '没有把失败当成成功', ok: f.result.data?.rolledBack?.includes('tests/platform.test.ts') === true },
    ],
  },
  {
    id: 'E7',
    title: '审批期间外部改动 → TOCTOU 拒绝落盘',
    expected: 'apply_refused',
    setup: [{ path: 'src/calc.ts', content: GREEN_CALC }],
    approval: 'mutate_before_allow',
    mutation: { rel: 'src/calc.ts', content: EXTERNAL_CALC },
    steps: [{ tool: 'edit_file', args: { path: 'src/calc.ts', oldString: 'return a + b;', newString: 'return b + a;' } }],
    assert: (f) => [
      { name: '错误码为 APPLY_FAILED', ok: f.result.error?.code === 'APPLY_FAILED', detail: f.result.error?.code },
      { name: '错误信息包含 TOCTOU', ok: /TOCTOU/i.test(f.result.error?.message ?? ''), detail: f.result.error?.message },
      { name: '外部改动未被覆盖', ok: f.post['src/calc.ts'] === EXTERNAL_CALC },
      { name: '审批仍恰好 1 次', ok: f.approvals.length === 1, detail: `实际 ${f.approvals.length}` },
    ],
  },
];

function readFixture(rel: string): string {
  return readFileSync(join(FIXTURE, rel), 'utf8');
}

function stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function toolConfig(image: string, hostNodePath: string): ToolRuntimeConfig {
  return {
    search: { provider: 'offline', apiKey: undefined, baseUrl: 'https://example.invalid' },
    codebase: { runTestsEnabled: true, allowedTestCommands: ['node --test', 'npm test'], writeEnabled: true },
    misc: { scanLimit: 5000, maxFileBytes: 262144 },
    subagent: { maxConcurrency: 4, maxWidth: 4, maxDepth: 1, resultChars: 800 },
    maxOutputBytes: 256 * 1024,
    log: { maxContentChars: 2000, toolResults: false },
    approval: { maxFilesPerRequest: 10 },
    sandbox: { image, hostNodePath, execTimeoutMs: 600_000, l2BeforeApproval: false },
  };
}

function safeRemoveNodeModulesLink(repo: string): void {
  const link = join(repo, 'node_modules');
  if (!existsSync(link)) return;
  try {
    if (process.platform === 'win32') rmdirSync(link);
    else unlinkSync(link);
  } catch {
    try {
      rmSync(link, { recursive: false, force: true });
    } catch {
      // 证据目录可手动清理；这里不让清理失败掩盖评测结果。
    }
  }
}

async function runCase(
  sc: Scenario,
  ctxBase: { stamp: string; image: string; hostNodePath: string; evidenceRoot: string },
): Promise<EditEvalCaseResult> {
  const caseDir = join(ctxBase.evidenceRoot, sc.id);
  const repo = join(caseDir, 'repo');
  const dataDir = join(caseDir, 'sandbox-data');
  rmSync(caseDir, { recursive: true, force: true });
  mkdirSync(caseDir, { recursive: true });
  // 不用 fs.cpSync：本机 Node 24.14.1 上最小用例会 STATUS_STACK_BUFFER_OVERRUN 崩进程。
  copyRepoSnapshot(FIXTURE, repo);
  for (const s of sc.setup ?? []) {
    mkdirSync(dirname(join(repo, s.path)), { recursive: true });
    writeFileSync(join(repo, s.path), s.content, 'utf8');
  }
  symlinkSync(join(PROJECT, 'node_modules'), join(repo, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  mkdirSync(dataDir, { recursive: true });

  const skip = sc.skipReason?.();
  if (skip) {
    safeRemoveNodeModulesLink(repo);
    return {
      id: sc.id,
      title: sc.title,
      expected: sc.expected,
      status: 'skipped',
      skipReason: skip,
      wallMs: 0,
      approvalCount: 0,
      applied: [],
      rolledBack: [],
      sandbox: { ran: false, ok: false, steps: [] },
      host: null,
      postFiles: {},
      assertions: [],
      notes: [],
      tokens: 0,
      costUsd: 0,
    };
  }

  const approvals: ApprovalRequest[] = [];
  const events: Array<{ type: string; data?: Record<string, any> }> = [];
  const registry = buildRegistry();
  const session = new SandboxSession({ image: ctxBase.image, repoPath: repo, dataDir }, `eval_${ctxBase.stamp}_${sc.id}`);
  const config = toolConfig(ctxBase.image, ctxBase.hostNodePath);
  const started = Date.now();
  let result: Facts['result'] = { ok: false, error: { code: 'NOT_RUN', message: '未执行 submit_changes' } };
  let applied: string[] = [];
  let rolledBack: string[] = [];
  let sandbox: Facts['sandbox'] = { ran: false, ok: false, steps: [] };
  let host: Facts['host'] = null;
  const notes: string[] = [];
  try {
    const ensured = await session.ensure();
    if (!ensured.ok) {
      notes.push(`沙箱不可用：${ensured.reason}`);
      return {
        id: sc.id,
        title: sc.title,
        expected: sc.expected,
        status: 'failed',
        wallMs: Date.now() - started,
        approvalCount: 0,
        applied: [],
        rolledBack: [],
        sandbox: { ran: false, ok: false, steps: [] },
        host: null,
        errorCode: 'SANDBOX_UNAVAILABLE',
        errorMessage: ensured.reason,
        postFiles: {},
        assertions: [{ name: '沙箱可用', ok: false, detail: ensured.reason }],
        notes,
        tokens: 0,
        costUsd: 0,
      };
    }

    const ctx: ToolContext = {
      runId: `eval_${ctxBase.stamp}_${sc.id}`,
      runType: 'codebase',
      allowedPermissions: ['codebase:read', 'codebase:test', 'codebase:write'],
      repoPath: repo,
      maxOutputBytes: 256 * 1024,
      config,
      sandbox: session,
      emitEvent: (type, data) => events.push({ type, data }),
      requestApproval: async (req): Promise<ApprovalDecision> => {
        approvals.push(req);
        if (sc.approval === 'deny') {
          return {
            approvalId: req.approvalId,
            value: 'deny',
            reason: '评测：模拟用户拒绝',
            decidedAt: new Date().toISOString(),
          };
        }
        if (sc.approval === 'mutate_before_allow' && sc.mutation) {
          writeFileSync(join(repo, sc.mutation.rel), sc.mutation.content, 'utf8');
        }
        return { approvalId: req.approvalId, value: 'allow_once', decidedAt: new Date().toISOString() };
      },
    };

    for (const step of sc.steps) {
      const out = await registry.execute(step.tool, step.args, ctx);
      if (!out.result.ok) notes.push(`${step.tool} 失败：${out.result.error?.code ?? 'UNKNOWN'} ${out.result.error?.message ?? ''}`);
    }
    const submitted = await registry.execute('submit_changes', { summary: `${sc.id} ${sc.title}` }, ctx);
    result = submitted.result as unknown as Facts['result'];
    const data = (result.data ?? {}) as Record<string, any>;
    applied = Array.isArray(data.applied) ? data.applied.map(String) : [];
    rolledBack = Array.isArray(data.rolledBack) ? data.rolledBack.map(String) : [];

    const sandboxEvent = [...events].reverse().find((e) => e.type === 'verification_completed' && e.data?.phase === 'sandbox');
    if (sandboxEvent) {
      sandbox = {
        ran: true,
        ok: sandboxEvent.data?.ok === true,
        steps: Array.isArray(sandboxEvent.data?.steps)
          ? sandboxEvent.data!.steps.map((x: any) => ({ source: String(x.source), ok: x.ok === true, summary: String(x.summary ?? '') }))
          : [],
      };
    }
    const hostEvent = [...events].reverse().find((e) => e.type === 'verification_completed' && e.data?.phase === 'host');
    if (hostEvent) {
      host = {
        ran: hostEvent.data?.ran === true,
        ok: hostEvent.data?.ok === true,
        mode: hostEvent.data?.mode ? String(hostEvent.data.mode) : undefined,
        coverage: hostEvent.data?.coverage ? String(hostEvent.data.coverage) : undefined,
        note: hostEvent.data?.note ? String(hostEvent.data.note) : undefined,
      };
    }
  } catch (e) {
    notes.push(`执行异常：${(e as Error).message}`);
    result = { ok: false, error: { code: 'EVAL_EXCEPTION', message: (e as Error).message } };
  } finally {
    try {
      await session.disposeAsync();
    } catch {
      // 容器清理失败不改变评测结论。
    }
  }

  const post: Record<string, string | null> = {};
  const paths = new Set<string>(['src/calc.ts', 'src/slug.ts', 'tests/slug.test.ts', 'tests/platform.test.ts']);
  for (const s of sc.steps) {
    const p = s.args.path;
    if (typeof p === 'string') paths.add(p);
  }
  for (const p of paths) {
    try {
      post[p] = existsSync(join(repo, p)) ? readFileSync(join(repo, p), 'utf8') : null;
    } catch {
      post[p] = null;
    }
  }
  safeRemoveNodeModulesLink(repo);

  const actual = classifyEditOutcome({ applied, rolledBack, errorCode: result.error?.code });
  const facts: Facts = {
    repo,
    post,
    result,
    approvals,
    rolledBack,
    events,
    sandbox,
    host,
    baseline: (rel) => sc.setup?.find((s) => s.path === rel)?.content ?? (existsSync(join(FIXTURE, rel)) ? readFixture(rel) : null),
  };
  const assertions: EditEvalAssertion[] = [
    {
      name: `实际结果符合期望（${sc.expected}）`,
      ok: actual === sc.expected,
      detail: `实际 ${actual}`,
    },
    ...sc.assert(facts),
  ];
  const status = assertions.every((a) => a.ok) ? 'passed' : 'failed';
  const out: EditEvalCaseResult = {
    id: sc.id,
    title: sc.title,
    expected: sc.expected,
    status,
    wallMs: Date.now() - started,
    approvalCount: approvals.length,
    applied,
    rolledBack,
    sandbox,
    host,
    errorCode: result.error?.code,
    errorMessage: result.error?.message,
    postFiles: post,
    assertions,
    notes,
    tokens: 0,
    costUsd: 0,
  };
  writeFileSync(join(caseDir, 'result.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  return out;
}

function parseArgs(): { only: string[]; out: string; evidence: string | null; outExplicit: boolean } {
  const args = process.argv.slice(2);
  const only: string[] = [];
  let out = join(PROJECT, 'reports', 'EDIT_EVAL.md');
  let outExplicit = false;
  let evidence: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--only' && args[i + 1]) only.push(...args[++i].split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--out' && args[i + 1]) { out = resolve(args[++i]); outExplicit = true; }
    else if (a === '--evidence' && args[i + 1]) evidence = resolve(args[++i]);
    else if (a === '--help' || a === '-h') {
      console.log('用法：npm run eval:edit -- [--only E1,E3] [--out reports/EDIT_EVAL.md] [--evidence data/edit-eval/run]');
      process.exit(0);
    }
  }
  return { only, out, evidence, outExplicit };
}

async function main(): Promise<void> {
  const parsed = parseArgs();
  const { only, evidence, outExplicit } = parsed;
  let out = parsed.out;
  if (only.length && !outExplicit) out = join(PROJECT, 'reports', 'EDIT_EVAL.partial.md');
  if (!existsSync(FIXTURE)) throw new Error(`fixture 不存在：${FIXTURE}`);
  const docker = await dockerAvailableAsync();
  if (!docker) throw new Error('Docker 不可用：编辑管线评测需要真沙箱。启动 Docker Desktop 后重试。');
  const cfg = loadConfig();
  const image = process.env.SANDBOX_IMAGE ?? cfg.sandbox.image;
  const imageCheck = spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8' });
  if (imageCheck.status !== 0) {
    throw new Error(`沙箱镜像不存在：${image}。先运行 node scripts/sandbox/build-image.mjs。`);
  }
  const hostNodePath = existsSync(cfg.sandbox.hostNodePath) ? cfg.sandbox.hostNodePath : process.execPath;
  const runStamp = stamp();
  const evidenceRoot = evidence ?? join(PROJECT, 'data', 'edit-eval', runStamp);
  mkdirSync(evidenceRoot, { recursive: true });

  const selected = only.length ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS;
  if (!selected.length) throw new Error(`--only 没有匹配到场景：${only.join(',')}（可选 ${SCENARIOS.map((s) => s.id).join(',')}）`);

  const results: EditEvalCaseResult[] = [];
  for (const sc of selected) {
    process.stdout.write(`[edit-eval] ${sc.id} ${sc.title} ... `);
    const r = await runCase(sc, { stamp: runStamp, image, hostNodePath, evidenceRoot });
    results.push(r);
    console.log(`${r.status}${r.errorCode ? ` (${r.errorCode})` : ''} ${r.wallMs}ms`);
  }

  const gitHead = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const gitStatus = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const report = renderEditEvalReport(
    {
      generatedAt: new Date().toISOString(),
      command: 'npm run eval:edit',
      platform: `${process.platform} ${process.arch}`,
      node: process.version,
      hostNodePath,
      dockerImage: image,
      gitHead: gitHead.status === 0 ? gitHead.stdout.trim() : undefined,
      gitDirty: gitStatus.status === 0 ? gitStatus.stdout.trim().length > 0 : undefined,
      evidenceDir: relative(REPO_ROOT, evidenceRoot).replace(/\\/g, '/'),
      notes: ['场景 E6 只在宿主非 Linux 时运行；其余场景跨平台。'],
    },
    results,
  );
  writeFileSync(out, report.replace(/[ \t]+$/gm, '').replace(/\r?\n/g, '\r\n'), 'utf8');
  console.log(`[edit-eval] 报告：${relative(REPO_ROOT, out)}`);
  console.log(`[edit-eval] 证据：${relative(REPO_ROOT, evidenceRoot)}`);
  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length) {
    console.error(`[edit-eval] ${failed.length} 个场景未达预期：${failed.map((r) => r.id).join(', ')}`);
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) {
  main().catch((e) => {
    console.error(`[edit-eval] 失败：${(e as Error).message}`);
    process.exitCode = 1;
  });
}
