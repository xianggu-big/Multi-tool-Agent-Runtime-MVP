// src/evaluation/editEval.ts — 编辑管线评测的纯函数核心（无 I/O、可单测）
//
// 为什么把「汇总/渲染」与「真实执行」分开：
//   - 执行层要 Docker / 审批 / 宿主复验，慢且依赖环境；
//   - 汇总层必须能被 tests/ 直接覆盖，防止报告口径随改动漂移。
//
// 诚实边界：这里的场景是**确定性驱动**（脚本扮演模型提出改动），衡量的是
// 「沙箱校验 → 审批 → 落盘 → 宿主复验 → 回滚」这条管线，不是 LLM 的编辑智力。
// 因此 tokens / cost 固定为 0，报告里必须明说。

export type EditEvalExpected =
  | 'applied'
  | 'sandbox_rejected'
  | 'approval_denied'
  | 'rolled_back'
  | 'apply_refused';

export interface EditEvalCheck {
  source: string;
  ok: boolean;
  summary: string;
}

export interface EditEvalAssertion {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface EditEvalCaseResult {
  id: string;
  title: string;
  expected: EditEvalExpected;
  status: 'passed' | 'failed' | 'skipped';
  skipReason?: string;
  wallMs: number;
  approvalCount: number;
  applied: string[];
  rolledBack: string[];
  sandbox: {
    ran: boolean;
    ok: boolean;
    steps: EditEvalCheck[];
  };
  host: {
    ran: boolean;
    ok: boolean;
    mode?: string;
    coverage?: string;
    note?: string;
  } | null;
  errorCode?: string;
  errorMessage?: string;
  postFiles: Record<string, string | null>;
  assertions: EditEvalAssertion[];
  notes: string[];
  /** 确定性场景没有模型调用；保留字段是为了以后接真实模型时同一份报告能容纳。 */
  tokens: number;
  costUsd: number;
}

export interface EditEvalSummary {
  total: number;
  run: number;
  passed: number;
  failed: number;
  skipped: number;
  passRate: number;
  approvals: number;
  appliedFiles: number;
  rollbacks: number;
  sandboxRuns: number;
  sandboxPassed: number;
  sandboxPassRate: number;
  hostRuns: number;
  hostPassed: number;
  hostPassRate: number;
  avgWallMs: number;
  p95WallMs: number;
  tokens: number;
  costUsd: number;
  failureClasses: Array<{ key: string; count: number }>;
}

export function classifyEditOutcome(r: Pick<EditEvalCaseResult, 'applied' | 'rolledBack' | 'errorCode'>): EditEvalExpected | 'unknown' {
  if (r.rolledBack.length > 0) return 'rolled_back';
  if (r.applied.length > 0) return 'applied';
  if (r.errorCode === 'APPROVAL_DENIED') return 'approval_denied';
  if (r.errorCode === 'APPLY_FAILED') return 'apply_refused';
  if (
    r.errorCode === 'SANDBOX_CHECK_FAILED' ||
    r.errorCode === 'NOTHING_TO_SUBMIT' ||
    r.errorCode === 'SENSITIVE' ||
    r.errorCode === 'PATH_ESCAPE' ||
    r.errorCode === 'PATH_NOT_FOUND' ||
    r.errorCode === 'INVALID_ARGS'
  ) {
    return 'sandbox_rejected';
  }
  return 'unknown';
}

function p95(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  return sorted[idx];
}

export function summarizeEditEval(results: EditEvalCaseResult[]): EditEvalSummary {
  const skipped = results.filter((r) => r.status === 'skipped');
  const run = results.filter((r) => r.status !== 'skipped');
  const passed = run.filter((r) => r.status === 'passed');
  const failed = run.filter((r) => r.status === 'failed');
  const sandboxRuns = run.filter((r) => r.sandbox.ran);
  const sandboxPassed = sandboxRuns.filter((r) => r.sandbox.ok);
  const hostRuns = run.filter((r) => r.host?.ran);
  const hostPassed = hostRuns.filter((r) => r.host?.ok);
  const failures = new Map<string, number>();
  for (const r of failed) {
    const key = r.errorCode ?? classifyEditOutcome(r);
    failures.set(key, (failures.get(key) ?? 0) + 1);
  }
  const walls = run.map((r) => r.wallMs);
  return {
    total: results.length,
    run: run.length,
    passed: passed.length,
    failed: failed.length,
    skipped: skipped.length,
    passRate: run.length ? passed.length / run.length : 0,
    approvals: run.reduce((n, r) => n + r.approvalCount, 0),
    appliedFiles: run.reduce((n, r) => n + r.applied.length, 0),
    rollbacks: run.reduce((n, r) => n + r.rolledBack.length, 0),
    sandboxRuns: sandboxRuns.length,
    sandboxPassed: sandboxPassed.length,
    sandboxPassRate: sandboxRuns.length ? sandboxPassed.length / sandboxRuns.length : 0,
    hostRuns: hostRuns.length,
    hostPassed: hostPassed.length,
    hostPassRate: hostRuns.length ? hostPassed.length / hostRuns.length : 0,
    avgWallMs: run.length ? Math.round(walls.reduce((a, b) => a + b, 0) / run.length) : 0,
    p95WallMs: p95(walls),
    tokens: run.reduce((n, r) => n + r.tokens, 0),
    costUsd: run.reduce((n, r) => n + r.costUsd, 0),
    failureClasses: [...failures.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
  };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 300);
}

export interface EditEvalReportMeta {
  generatedAt: string;
  command: string;
  platform: string;
  node: string;
  hostNodePath: string;
  dockerImage: string;
  gitHead?: string;
  gitDirty?: boolean;
  evidenceDir: string;
  notes?: string[];
}

export function renderEditEvalReport(meta: EditEvalReportMeta, results: EditEvalCaseResult[]): string {
  const s = summarizeEditEval(results);
  const lines: string[] = [];
  lines.push('# 编辑管线评测（真 Docker / 真审批 / 真复验）');
  lines.push('');
  lines.push(`> 生成时间：${meta.generatedAt}；命令：\`${meta.command}\`；生成物请重跑命令，不要手改数字。`);
  lines.push('');
  lines.push('## 1. 口径与边界');
  lines.push('');
  lines.push('- 衡量对象：`create_file / edit_file → 沙箱检查阶梯 → 人工审批 → 落盘 → 宿主复验 → 失败回滚` 这条**管线**。');
  lines.push('- **不是模型能力评测**：场景由脚本确定性驱动（脚本扮演模型提出改动），所以 tokens = 0、cost = $0；不要把它解读成“模型改代码成功率”。');
  lines.push('- 每个场景使用独立临时仓库副本；不污染 `demo/codebase-sample`，也不写入用户真实仓库。');
  lines.push('- 沙箱内是 Linux、宿主是当前平台；E6 专门验证“沙箱绿、宿主红”时是否自动回滚。');
  if (meta.notes?.length) for (const n of meta.notes) lines.push(`- ${n}`);
  lines.push('');
  lines.push('## 2. 环境');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('|---|---|');
  lines.push(`| Node | \`${cell(meta.node)}\` |`);
  lines.push(`| 平台 | \`${cell(meta.platform)}\` |`);
  lines.push(`| 宿主复验 Node | \`${cell(meta.hostNodePath)}\` |`);
  lines.push(`| 沙箱镜像 | \`${cell(meta.dockerImage)}\` |`);
  lines.push(`| Git | ${meta.gitHead ? `\`${meta.gitHead}\`${meta.gitDirty ? '（工作区有未提交改动）' : ''}` : '不可用（未初始化或非 git 仓库）'} |`);
  lines.push(`| 证据目录 | \`${cell(meta.evidenceDir)}\` |`);
  lines.push('');
  lines.push('## 3. 汇总');
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('|---|---:|');
  lines.push(`| 场景（运行 / 跳过 / 总计） | ${s.run} / ${s.skipped} / ${s.total} |`);
  lines.push(`| 预期结果命中 | ${s.passed}/${s.run}（${pct(s.passRate)}） |`);
  lines.push(`| 人工审批请求 | ${s.approvals} 次 |`);
  lines.push(`| 成功落盘文件 | ${s.appliedFiles} 个 |`);
  lines.push(`| 失败回滚文件 | ${s.rollbacks} 个 |`);
  lines.push(`| 沙箱检查通过 | ${s.sandboxPassed}/${s.sandboxRuns}（${pct(s.sandboxPassRate)}） |`);
  lines.push(`| 宿主复验通过 | ${s.hostPassed}/${s.hostRuns}（${pct(s.hostPassRate)}） |`);
  lines.push(`| 平均 / P95 墙钟 | ${s.avgWallMs} ms / ${s.p95WallMs} ms |`);
  lines.push(`| Token / 成本 | ${s.tokens} / $${s.costUsd.toFixed(4)}（确定性驱动，无模型调用） |`);
  lines.push('');
  lines.push('**读法**：`预期结果命中` 是“管线是否按设计行事”，不是“代码改得对不对”。沙箱通过率低不一定是坏事——E3/E4 就是故意提交坏改动，期望被拦下。');
  lines.push('');
  lines.push('## 4. 场景结果');
  lines.push('');
  lines.push('| 场景 | 期望 | 实际 | 结果 | 审批 | 落盘 | 回滚 | 宿主复验 | 墙钟 |');
  lines.push('|---|---|---|---|---:|---|---:|---|---:|');
  for (const r of results) {
    const actual = r.status === 'skipped' ? 'skipped' : classifyEditOutcome(r);
    const host = r.host ? (r.host.ran ? (r.host.ok ? '通过' : '失败') : '未运行') : '—';
    lines.push(
      `| ${cell(r.id)} ${cell(r.title)} | ${r.expected} | ${actual} | ${r.status === 'passed' ? '✅' : r.status === 'skipped' ? '⏭️' : '❌'} | ${r.approvalCount} | ${r.applied.length} | ${r.rolledBack.length} | ${host} | ${r.wallMs} ms |`,
    );
  }
  lines.push('');
  lines.push('## 5. 失败分类');
  lines.push('');
  if (s.failureClasses.length) {
    lines.push('| 分类 | 数量 |');
    lines.push('|---|---:|');
    for (const f of s.failureClasses) lines.push(`| \`${cell(f.key)}\` | ${f.count} |`);
  } else {
    lines.push('无（所有运行场景均达到预期）。');
  }
  lines.push('');
  lines.push('## 6. 逐场景证据');
  lines.push('');
  for (const r of results) {
    lines.push(`### ${r.id} ${r.title}`);
    lines.push('');
    lines.push(`- 期望：\`${r.expected}\`；结果：\`${r.status}\`${r.skipReason ? `（跳过：${r.skipReason}）` : ''}`);
    lines.push(`- 审批 ${r.approvalCount} 次；落盘 ${r.applied.length} 个；回滚 ${r.rolledBack.length} 个；墙钟 ${r.wallMs} ms`);
    if (r.errorCode) lines.push(`- 错误：\`${r.errorCode}\` — ${cell(r.errorMessage ?? '')}`);
    if (r.sandbox.ran) {
      lines.push(`- 沙箱检查：${r.sandbox.ok ? '通过' : '失败'}${r.sandbox.steps.length ? `（${r.sandbox.steps.map((x) => `${x.source}:${x.ok ? 'ok' : 'fail'}`).join(' / ')}）` : ''}`);
    } else {
      lines.push('- 沙箱检查：未运行');
    }
    if (r.host) {
      lines.push(`- 宿主复验：${r.host.ran ? (r.host.ok ? '通过' : '失败') : '未运行'}${r.host.mode ? `（mode=${r.host.mode}, coverage=${r.host.coverage ?? '—'}）` : ''}`);
    }
    if (r.assertions.length) {
      lines.push('- 断言：');
      for (const a of r.assertions) lines.push(`  - ${a.ok ? '✅' : '❌'} ${a.name}${a.detail ? `：${cell(a.detail)}` : ''}`);
    }
    if (r.notes.length) {
      lines.push('- 备注：');
      for (const n of r.notes) lines.push(`  - ${n}`);
    }
    lines.push('');
  }
  lines.push('## 7. 复现');
  lines.push('');
  lines.push('```powershell');
  lines.push('cd multi-tool-agent');
  lines.push('npm run eval:edit');
  lines.push('```');
  lines.push('');
  lines.push('前置条件：Docker 可用 + `mta-sandbox:node24` 已构建。缺少任一项时脚本会明确标记 skipped，而不是伪造通过。');
  lines.push('');
  return lines.join('\n');
}
