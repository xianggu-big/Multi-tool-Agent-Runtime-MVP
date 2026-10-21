// tests/38_approval.test.ts — 审批门禁与预算暂停语义（M1 写能力；**不连 Docker**）
//
// 本文件是「审批相关安全行为」的回归守卫，三组断言：
//   ① Budget.pause()/resume()：等待人工审批的时间不计入 totalTimeoutMs（评审 P2-a：
//      "人还没点，任务先超时"）；对照组证明不暂停时确实会超时。
//   ② 写工具三层门禁：CODEBASE_WRITE_ENABLED → repoPath → 沙箱/审批通道是否存在
//      （任一缺失即 fail-closed，绝不静默降级为"非沙箱直写"）。
//   ③ submit_changes 三态 + 无内容态：
//      allow_once（落盘） / deny（理由回喂 + mark denied，不落盘） /
//      阶梯失败（**先验后批**：不弹审批、不落盘，这是安全底线） / NOTHING_TO_SUBMIT。
//
// 假沙箱：结构化实现 SandboxAccess（src/tools/types.ts），本文件完全不碰 Docker、不碰真实落盘。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Budget } from '../src/runtime/Budget.js';
import { loadConfig } from '../src/config.js';
import { buildRuntime } from '../src/runtime/index.js';
import type { SandboxAccess } from '../src/tools/types.js';
import type { ApprovalDecision, ApprovalRequest } from '../src/types.js';
import { baseToolConfig, makeCtx, registryWithAll } from './helpers.js';

const REPO = resolve('demo/codebase-sample');
const TMP = mkdtempSync(join(tmpdir(), 'mta-38-'));

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 假沙箱（离线，确定性）
type ChangeRow = { relPath: string; op: 'create' | 'edit' | 'delete'; status: string; retriesLeft: number };
type CmdRow = {
  command: string;
  shell: 'bash' | 'powershell' | 'cmd';
  cwdRel: string;
  sandboxOutput: string | null;
  sandboxExitCode: number | null;
  status: string;
};
type Step = {
  source: string;
  verdict: { ok: boolean; class?: string; summary: string; repairHint?: string; excerpt?: string };
};

class FakeSandbox implements SandboxAccess {
  readonly name = 'mta-sb-fake38';
  readonly staged: Array<{ rel: string; op: 'create' | 'edit' | 'delete'; content?: string }> = [];
  readonly marks: Array<{ rel: string; status: string }> = [];
  readonly applied: string[] = [];
  readonly consumed: string[] = [];
  readonly hostRuns: Array<{ index: number; output: string; exitCode: number | null }> = [];
  readonly ladderLevels: string[] = [];
  readonly commands: CmdRow[];
  private readonly changes: ChangeRow[];

  constructor(
    private readonly opts: {
      changes?: ChangeRow[];
      commands?: CmdRow[];
      ladderOk?: boolean;
      steps?: Step[];
      workFiles?: Record<string, string>;
      journalError?: boolean;
      applyError?: boolean;
    } = {},
  ) {
    this.changes = (opts.changes ?? []).map((c) => ({ ...c }));
    this.commands = (opts.commands ?? []).map((c) => ({ ...c }));
  }

  async ensure(): Promise<{ ok: true }> {
    return { ok: true };
  }
  isStarted(): boolean {
    return true;
  }
  readRepoFile(rel: string): string | null {
    try {
      return readFileSync(resolve(REPO, rel), 'utf8');
    } catch {
      return null;
    }
  }
  readWorkFile(rel: string): string | null {
    const wf = this.opts.workFiles;
    if (wf && Object.prototype.hasOwnProperty.call(wf, rel)) return wf[rel];
    return this.readRepoFile(rel);
  }
  stage(rel: string, op: 'create' | 'edit' | 'delete', content?: string): void {
    this.staged.push({ rel, op, content });
  }
  mark(rel: string, status: string): void {
    this.marks.push({ rel, status });
    const c = this.changes.find((x) => x.relPath === rel);
    if (c) c.status = status;
  }
  consumeRound(rel: string): number {
    this.consumed.push(rel);
    const c = this.changes.find((x) => x.relPath === rel);
    if (c) c.retriesLeft = Math.max(0, c.retriesLeft - 1);
    return c?.retriesLeft ?? 0;
  }
  getChanges(): ChangeRow[] {
    return this.changes;
  }
  /** 崩溃对账日志：本测试不关心磁盘，留空实现即可（真实实现见 SandboxSession.beginApply）。 */
  async beginApply(): Promise<void> {
    if (this.opts.journalError) throw new Error('模拟磁盘写入失败');
  }
  async runLadder(level: 'L0' | 'L1' | 'L2' = 'L1') {
    this.ladderLevels.push(level);
    return {
      ok: this.opts.ladderOk ?? true,
      level: String(level),
      steps: this.opts.steps ?? [
        { source: 'l1-tsc', verdict: { ok: true, summary: 'l1-tsc 通过' } },
        { source: 'l1-tests', verdict: { ok: true, summary: 'l1-tests 通过' } },
      ],
    };
  }
  diffPatch(_rel: string, _name = 'pending'): string {
    // 2 增 1 删的假 patch（diffStat 会被 submit_changes 用来填审批卡摘要）
    return '--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-old line\n+new line\n+extra line\n';
  }
  diffDir(): string {
    return TMP;
  }
  applyToRepo(rel: string): { ok: true } {
    if (this.opts.applyError) throw new Error('模拟落盘异常（磁盘满/权限）');
    this.applied.push(rel);
    return { ok: true };
  }
  rollbackFromBackup(_rel: string): boolean {
    return true;
  }
  backupsDir(): string {
    return TMP;
  }
  stageCommand(cmd: {
    command: string;
    shell: 'bash' | 'powershell' | 'cmd';
    cwdRel: string;
    sandboxOutput: string | null;
    sandboxExitCode: number | null;
  }): void {
    this.commands.push({ ...cmd, status: 'pending' });
  }
  getCommands(): CmdRow[] {
    return this.commands;
  }
  markCommand(index: number, status: string, host?: { output: string; exitCode: number | null }): void {
    const c = this.commands[index];
    if (c) c.status = status;
    if (host) this.hostRuns.push({ index, ...host });
  }
}

/** 注入假沙箱 + 审批通道的 ctx；approvalCalls 记录所有审批请求（供断言"是否/几次弹审批"） */
function writeCtx(
  sb: SandboxAccess,
  opts: {
    writeEnabled?: boolean;
    approval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  } = {},
): { ctx: ReturnType<typeof makeCtx>; approvalCalls: ApprovalRequest[] } {
  const base = baseToolConfig();
  const approvalCalls: ApprovalRequest[] = [];
  const approval =
    opts.approval ??
    (async (req: ApprovalRequest): Promise<ApprovalDecision> => ({
      approvalId: req.approvalId,
      value: 'allow_once',
      decidedAt: new Date().toISOString(),
    }));
  const ctx = makeCtx({
    runType: 'codebase',
    allowedPermissions: ['codebase:read', 'codebase:test', 'codebase:write'],
    repoPath: REPO,
    config: {
      ...base,
      codebase: { ...base.codebase, writeEnabled: opts.writeEnabled ?? true },
      // 宿主复验（hostVerify）默认关掉：本文件只测审批门禁；真跑会 spawn 整个测试套件（递归且慢）。
      // 指向不存在的 Node 路径 → verify.ran=false（该分支已显式断言），审批三态不受影响。
      sandbox: { ...base.sandbox, hostNodePath: 'Z:/mta-test/nonexistent-node.exe' },
    },
    sandbox: sb,
    requestApproval: async (req: ApprovalRequest) => {
      approvalCalls.push(req);
      return approval(req);
    },
  });
  return { ctx, approvalCalls };
}

// ---------------------------------------------------------------- ① Budget 暂停语义
test('38a) Budget 暂停语义：审批等待不计入 totalTimeoutMs（人还没点，任务不该先超时）', async () => {
  const limits = { maxSteps: 10, maxModelCalls: 10, maxToolCalls: 10, tokenBudget: 0, costBudgetUsd: 0, totalTimeoutMs: 50 };

  // 对照组：不暂停 → 墙钟 120ms > 50ms → 必须判超时（证明下面的断言前提成立）
  const ctl = new Budget({ ...limits });
  await sleep(120);
  assert.equal(ctl.checkTimeout(Date.now()), 'totalTimeout', '对照组：不暂停时应按墙钟判超时');

  // 实验组：暂停期间等待 120ms → 暂停时间不计入 → 不得判超时
  const b = new Budget({ ...limits });
  b.pause();
  const t0 = Date.now();
  await sleep(120);
  b.resume();
  const wall = Date.now() - t0;
  assert.ok(b.activePausedMs >= 100, `暂停时长应 ≥100ms（实际 ${b.activePausedMs}ms）`);
  assert.equal(b.checkTimeout(Date.now()), null, '安全行为：审批等待（暂停）时间不得导致 totalTimeout');
  assert.ok(b.activeElapsedMs() < 50, `有效耗时 ${b.activeElapsedMs()}ms 应远小于墙钟 ${wall}ms`);

  // 可重入：连续两次 pause 只计一次（第二次是 no-op）
  const before = b.activePausedMs;
  b.pause();
  b.pause();
  await sleep(40);
  b.resume();
  const delta = b.activePausedMs - before;
  assert.ok(delta >= 30 && delta < 200, `一次暂停区间只应累计一次（实际 +${delta}ms）`);
});

// ---------------------------------------------------------------- ② 三层门禁
const EDIT_ONE = { path: 'src/calc.js', oldString: 'export function sub(a, b) {', newString: 'export function subtract(a, b) {' };

test('38b) 门禁①：writeEnabled=false → DISABLED（默认关闭，fail-closed）', async () => {
  const sb = new FakeSandbox();
  const { ctx } = writeCtx(sb, { writeEnabled: false });
  const r = await registryWithAll().execute('edit_file', EDIT_ONE, ctx);
  assert.equal(r.result.ok, false);
  assert.equal(r.result.error?.code, 'DISABLED', '写能力默认关闭时必须 DISABLED（不是静默降级为直写）');
  assert.equal(sb.staged.length, 0, 'DISABLED 时不得有任何暂存动作');
});

test('38c) 门禁②：未注入沙箱/审批通道 → WRITE_UNAVAILABLE（fail-closed）', async () => {
  const base = baseToolConfig();
  const cfg = { ...base, codebase: { ...base.codebase, writeEnabled: true } };

  // 只缺沙箱
  const noSandbox = makeCtx({
    runType: 'codebase',
    allowedPermissions: ['codebase:write'],
    repoPath: REPO,
    config: cfg,
  });
  const r1 = await registryWithAll().execute('edit_file', EDIT_ONE, noSandbox);
  assert.equal(r1.result.ok, false);
  assert.equal(r1.result.error?.code, 'WRITE_UNAVAILABLE', '缺沙箱时必须拒绝执行（不降级为直接写盘）');

  // 只缺审批通道
  const noApproval = makeCtx({
    runType: 'codebase',
    allowedPermissions: ['codebase:write'],
    repoPath: REPO,
    config: cfg,
    sandbox: new FakeSandbox(),
  });
  const r2 = await registryWithAll().execute('create_file', { path: 'src/__x38.ts', content: 'export const x = 1;\n' }, noApproval);
  assert.equal(r2.result.ok, false);
  assert.equal(r2.result.error?.code, 'WRITE_UNAVAILABLE', '缺审批通道时必须拒绝执行（不能改完没人批）');
});

test('38d) 门禁③：三层齐备 → edit_file 暂存成功（只暂存，不落盘、不弹审批）', async () => {
  const sb = new FakeSandbox();
  const { ctx, approvalCalls } = writeCtx(sb);
  const r = await registryWithAll().execute('edit_file', EDIT_ONE, ctx);
  assert.equal(r.result.ok, true, `三层齐备时应成功暂存（实际错误：${JSON.stringify(r.result.error)}）`);
  const data = (r.result.data ?? {}) as Record<string, unknown>;
  assert.equal(data.staged, 'src/calc.js');
  assert.equal(data.op, 'edit');
  assert.equal(sb.staged.length, 1, '应暂存到沙箱一次');
  assert.equal(sb.staged[0].op, 'edit');
  assert.ok(String(sb.staged[0].content).includes('export function subtract(a, b) {'), '暂存内容应含替换后的文本');
  assert.equal(approvalCalls.length, 0, '安全行为：暂存阶段不弹审批（一个 change set 只弹一次）');
});

// ---------------------------------------------------------------- ③ submit_changes 三态
test('38e) submit_changes allow_once → 先验后批：跑阶梯 + 一次审批 + 落盘 applied', async () => {
  const sb = new FakeSandbox({ changes: [{ relPath: 'src/__fake38.ts', op: 'create', status: 'staged', retriesLeft: 3 }] });
  const { ctx, approvalCalls } = writeCtx(sb);
  const r = await registryWithAll().execute('submit_changes', { summary: '新增示例文件' }, ctx);
  assert.equal(r.result.ok, true, `allow_once 后应成功（实际错误：${JSON.stringify(r.result.error)}）`);
  const data = r.result.data as Record<string, any>;
  assert.deepEqual(data.applied, ['src/__fake38.ts'], '落盘的 applied 应含该文件');
  assert.deepEqual(sb.applied, ['src/__fake38.ts'], '落盘必须走沙箱 applyToRepo（TOCTOU 哈希守卫 + 备份 + 原子写）');
  assert.deepEqual(sb.ladderLevels, ['L1'], '提交前必须跑 L1 检查阶梯（先验后批）');
  assert.equal(approvalCalls.length, 1, '一个 change set 只弹一次审批（防打断疲劳）');
  assert.equal(approvalCalls[0].files.length, 1);
  assert.equal(approvalCalls[0].files[0].relPath, 'src/__fake38.ts');
  assert.equal(approvalCalls[0].files[0].op, 'create');
  assert.equal(approvalCalls[0].files[0].addedLines, 2, '审批卡文件摘要来自 diffStat（+2）');
  assert.equal(approvalCalls[0].files[0].removedLines, 1, '审批卡文件摘要来自 diffStat（-1）');
  assert.equal(approvalCalls[0].checks.length, 2, '审批卡应带上沙箱检查结论（成品 + 质量）');
  assert.ok(approvalCalls[0].checks.every((c) => c.ok), '通过时检查结论应全绿');
  assert.equal(data.hostVerify.ran, false, '本文件把 hostNodePath 指向不存在路径 → 宿主复验不执行（该分支不在本文件覆盖范围）');
});

test('38f) submit_changes deny → APPROVAL_DENIED（理由回喂 + 标记 denied，绝不落盘）', async () => {
  const sb = new FakeSandbox({ changes: [{ relPath: 'src/__fake38.ts', op: 'edit', status: 'staged', retriesLeft: 3 }] });
  const { ctx } = writeCtx(sb, {
    approval: async (req: ApprovalRequest): Promise<ApprovalDecision> => ({
      approvalId: req.approvalId,
      value: 'deny',
      reason: '兼容性风险：这个接口先不动',
      decidedAt: new Date().toISOString(),
    }),
  });
  const r = await registryWithAll().execute('submit_changes', {}, ctx);
  assert.equal(r.result.ok, false);
  assert.equal(r.result.error?.code, 'APPROVAL_DENIED');
  assert.ok(
    String(r.result.error?.message).includes('兼容性风险：这个接口先不动'),
    '安全行为：拒绝理由必须回喂给模型（否则它会重试同样的改动）',
  );
  assert.deepEqual(sb.applied, [], 'deny 后绝不落盘');
  assert.deepEqual(sb.marks, [{ rel: 'src/__fake38.ts', status: 'denied' }], '被拒文件必须标记 denied（拒绝计数/粘性策略依赖它）');
});

test('38g) submit_changes 阶梯失败 → 先验后批：不弹审批、不落盘（SANDBOX_CHECK_FAILED）', async () => {
  const sb = new FakeSandbox({
    changes: [{ relPath: 'src/__fake38.ts', op: 'edit', status: 'staged', retriesLeft: 3 }],
    ladderOk: false,
    steps: [
      {
        source: 'l1-tsc',
        verdict: {
          ok: false,
          class: 'TYPE',
          summary: 'l1-tsc 失败：TYPE（exit=2）',
          repairHint: 'REPAIR_HINT_38G：按 tsc 报错逐条修类型标注/导入',
          excerpt: 'error TS2345: Argument of type ...',
        },
      },
    ],
  });
  const { ctx, approvalCalls } = writeCtx(sb);
  const r = await registryWithAll().execute('submit_changes', {}, ctx);
  assert.equal(r.result.ok, false);
  assert.equal(r.result.error?.code, 'SANDBOX_CHECK_FAILED');
  assert.ok(String(r.result.error?.message).includes('REPAIR_HINT_38G'), '失败必须带修复提示（回喂模型自我纠正）');
  assert.equal(approvalCalls.length, 0, '安全底线：沙箱校验没过就绝不能弹审批（先验后批）');
  assert.deepEqual(sb.applied, [], '安全底线：沙箱校验没过就绝不能落盘');
  assert.deepEqual(sb.consumed, ['src/__fake38.ts'], '失败应扣减该文件的重生成轮次');
});

test('38g2) 落盘意图日志失败 → APPLY_JOURNAL_FAILED，审批后也绝不碰仓库', async () => {
  const sb = new FakeSandbox({
    changes: [{ relPath: 'src/__fake38.ts', op: 'create', status: 'staged', retriesLeft: 3 }],
    journalError: true,
  });
  const { ctx, approvalCalls } = writeCtx(sb);
  const r = await registryWithAll().execute('submit_changes', {}, ctx);
  assert.equal(r.result.ok, false);
  assert.equal(r.result.error?.code, 'APPLY_JOURNAL_FAILED');
  assert.equal(approvalCalls.length, 1, '审批已完成；失败点应在审批后的落盘意图日志');
  assert.deepEqual(sb.applied, [], '日志写失败时绝不能落盘（没有日志就无法崩溃对账）');
});

test('38g3) 单文件落盘抛异常 → APPLY_FAILED（不是 ok:true + 空 applied）', async () => {
  const sb = new FakeSandbox({
    changes: [{ relPath: 'src/__fake38.ts', op: 'create', status: 'staged', retriesLeft: 3 }],
    applyError: true,
  });
  const { ctx } = writeCtx(sb);
  const r = await registryWithAll().execute('submit_changes', {}, ctx);
  assert.equal(r.result.ok, false);
  assert.equal(r.result.error?.code, 'APPLY_FAILED');
  assert.ok(String(r.result.error?.message).includes('全部未落盘'));
  assert.deepEqual(sb.applied, [], '异常文件不得被记为已落盘');
});

test('38h) 无待提交内容 → NOTHING_TO_SUBMIT（不弹审批、不跑阶梯）', async () => {
  const sb = new FakeSandbox();
  const { ctx, approvalCalls } = writeCtx(sb);
  const r = await registryWithAll().execute('submit_changes', {}, ctx);
  assert.equal(r.result.ok, false);
  assert.equal(r.result.error?.code, 'NOTHING_TO_SUBMIT');
  assert.equal(approvalCalls.length, 0, '无内容时不得弹审批');
  assert.deepEqual(sb.ladderLevels, [], '无内容时不必跑检查阶梯');
});

// ---------------------------------------------------------------- ② 写上下文读文件（R15-①）与审批语义（R15-⑤）
test('38i) 写上下文 read_file 优先读沙箱 work 副本（R15-① 回归守卫）', async () => {
  const reg = registryWithAll();

  // 对照：无沙箱 → 读真实仓库（demo 文件内容）
  const plain = await reg.execute('read_file', { path: 'src/calc.js' }, makeCtx({ allowedPermissions: ['codebase:read'] }));
  assert.equal(plain.result.ok, true);
  const p = plain.result.data as { content: string; source?: string };
  assert.equal(p.source, 'repo', '无沙箱时应读真实仓库');
  assert.ok(p.content.includes('export function add'), '对照：真实仓库内容');

  // 主断言：写上下文（注入沙箱，且该文件已有 staged 版本）→ 必须优先读副本
  const sb = new FakeSandbox({ workFiles: { 'src/calc.js': '// sandbox 版本（刚 staged 的新内容）\n' } });
  const { ctx } = writeCtx(sb);
  const staged = await reg.execute('read_file', { path: 'src/calc.js' }, ctx);
  assert.equal(staged.result.ok, true);
  const s = staged.result.data as { content: string; source?: string };
  assert.equal(s.source, 'sandbox', '写上下文必须优先读沙箱副本');
  assert.ok(s.content.includes('sandbox 版本'), '应读到子 Agent 刚暂存的新内容，而不是真实仓库旧版本');
  assert.ok(!s.content.includes('export function add'), '不应回落到真实仓库旧内容');
});

// Runtime 级审批语义（R15-⑤）：直接对 AgentRuntime 的审批服务断言（不经工具层）
function approvalRuntime(timeoutMs = 300000) {
  const config = loadConfig();
  config.stream.liveDeltas = false;
  config.approval.timeoutMs = timeoutMs;
  return buildRuntime(config, ':memory:');
}

function apReq(runId: string, approvalId: string, rels: string[]): ApprovalRequest {
  return {
    approvalId,
    runId,
    toolName: 'submit_changes',
    files: rels.map((relPath) => ({
      relPath,
      op: 'create' as const,
      addedLines: 1,
      removedLines: 0,
      diffPath: `data/sandbox/run_test/diffs/${approvalId}.patch`,
    })),
    checks: [],
    requestedAt: new Date().toISOString(),
  };
}

test('38j) 连续拒绝按文件计数：第 3 次达上限 denyLimitReached；不同文件计数独立（R15-⑤）', async () => {
  const { runtime } = approvalRuntime();
  const rt = runtime as any; // 直调 private 审批服务（运行时可达；本文件专测其语义）
  const run = 'run_test_38j';
  for (let i = 1; i <= 3; i++) {
    const pending = rt.requestApproval(run, apReq(run, `ap_38j_${i}`, ['a.md']));
    const d = runtime.decideApproval(run, `ap_38j_${i}`, 'deny', { actor: 'human' });
    assert.ok(d, `第 ${i} 次拒绝应命中挂起项`);
    await pending;
    if (i < 3) assert.notEqual(d!.denyLimitReached, true, `第 ${i} 次拒绝不应达上限`);
    else assert.equal(d!.denyLimitReached, true, '第 3 次拒绝同一文件应达上限');
  }
  const pb = rt.requestApproval(run, apReq(run, 'ap_38j_b1', ['b.md']));
  const db = runtime.decideApproval(run, 'ap_38j_b1', 'deny', { actor: 'human' });
  assert.notEqual(db!.denyLimitReached, true, '不同文件的拒绝计数相互独立');
  await pb;
});

test('38k) 粘性 allow_file：同文件第二次请求自动放行（autoByPolicy），不再挂起（R15-⑤）', async () => {
  const { runtime } = approvalRuntime();
  const rt = runtime as any;
  const run = 'run_test_38k';
  const p1 = rt.requestApproval(run, apReq(run, 'ap_38k_1', ['docs/x.md']));
  runtime.decideApproval(run, 'ap_38k_1', 'allow_file', { actor: 'human' });
  const d1 = await p1;
  assert.equal(d1.value, 'allow_file');

  const d2 = await rt.requestApproval(run, apReq(run, 'ap_38k_2', ['docs/x.md']));
  assert.equal(d2.value, 'allow_file');
  assert.equal(d2.actor, 'sticky-policy', '第二次应走粘性策略而非人工');
  assert.equal(d2.autoByPolicy, true);
  assert.equal(runtime.decideApproval(run, 'ap_38k_2', 'deny'), null, '第二次从未挂起：decide 应为 null');
});

test('38l) 敏感文件不进粘性 + 超时按拒绝：.env 第二次仍需人工（超时 deny/actor=timeout）（R15-⑤）', async () => {
  const { runtime } = approvalRuntime(150);
  const rt = runtime as any;
  const run = 'run_test_38l';
  const p1 = rt.requestApproval(run, apReq(run, 'ap_38l_1', ['.env']));
  runtime.decideApproval(run, 'ap_38l_1', 'allow_file', { actor: 'human' });
  await p1;

  const t0 = Date.now();
  const d2 = await rt.requestApproval(run, apReq(run, 'ap_38l_2', ['.env']));
  assert.equal(d2.value, 'deny', '敏感文件第二次不得自动放行，超时按拒绝');
  assert.equal(d2.actor, 'timeout');
  assert.ok(Date.now() - t0 >= 120, '应真实等待超时（未被粘性短路）');
});
