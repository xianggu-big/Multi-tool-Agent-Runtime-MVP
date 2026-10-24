// src/tools/codebase/writeTools.ts — 写能力工具（M1 Step3；唯一带副作用的工具族）
//
// 管线（对照两轮评审）：
//   ① create_file / edit_file / delete_file / copy_path / run_command **只暂存到沙箱**
//      ——不落盘、不弹审批（"其它均在沙箱内修改并试运行"）；run_command 的 bash 类命令
//      在 Linux 容器里**真跑一次**作为证据（powershell/cmd 无法在容器预演 → 审批卡如实标注）。
//   ② submit_changes 触发**一次**批量提交：跑检查阶梯 L1（L0 逐文件 + tsc --incremental +
//      受影响测试，找不到映射则全量兜底）→ 一个 change set 一次人工审批（P1-5/P2-g 防打断疲劳）。
//   ③ 审批三态：allow_file（本 run 内该文件的后续改动沙箱全绿即自动放行；敏感文件永久逐次）
//      / allow_once / deny（理由按文件回喂 + 连续拒绝按文件计数，v3-3）。
//   ④ 落盘：TOCTOU 哈希守卫 + 原文备份 + 原子写（短重试）；落盘后**宿主复验**（钉死系统 Node 24
//      绝对路径，评审 P1-8），失败自动回滚并如实记录。
//
// 默认关闭：CODEBASE_WRITE_ENABLED=false 时全部返回 DISABLED（fail-closed，仿 run_tests 先例）。
import { spawnAsync } from '../../sandbox/exec.js';
import { runHostFullSuite } from '../../sandbox/hostVerify.js';
export { sanitizeHostVerifyEnv } from '../../sandbox/hostVerify.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Tool, ToolContext } from '../types.js';
import type { ApprovalDecision, ApprovalRequest, ToolResult } from '../../types.js';
import { okResult, errResult } from '../types.js';
import { resolveWorkspacePath } from '../shared/workspacePath.js';
import { isSensitive } from './security.js';
import { applyEdit, diffStat } from '../shared/textEdit.js';
import { execInAsync } from '../../sandbox/docker.js';
import { shortSha256 } from '../../sandbox/hash.js';
import { assessApprovalRisk } from '../../security/approvalRisk.js';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_CMD_OUTPUT = 4000;

// ------------------------------------------------------------------ 共用门禁/工具函数

/** 写能力前置门禁：开关 → repoPath → 沙箱/审批通道（任一缺失即 fail-closed） */
function gate(ctx: ToolContext, toolName: string): ToolResult | null {
  if (!ctx.config.codebase.writeEnabled) {
    return errResult(
      'DISABLED',
      '写能力未启用：CODEBASE_WRITE_ENABLED=false（默认关闭）。启用前需保证 Docker 沙箱镜像可用（node scripts/sandbox/build-image.mjs）。',
      0,
    );
  }
  if (!ctx.repoPath) return errResult('CONFIG', '未配置 repoPath', 0);
  if (!ctx.sandbox || !ctx.requestApproval) {
    return errResult(
      'WRITE_UNAVAILABLE',
      `写工具 ${toolName} 仅对「可写子 Agent（code-edit）」可用：当前上下文未注入沙箱与审批通道（fail-closed）。`,
      0,
    );
  }
  return null;
}

/** 目标路径解析 + 敏感文件拒写（大小写不敏感判定，与只读工具共用同一份清单） */
function resolveTarget(
  ctx: ToolContext,
  raw: string,
  opts: { requireExists: boolean },
): { ok: true; rel: string; abs: string } | { ok: false; code: string; message: string } {
  const res = resolveWorkspacePath(ctx.repoPath!, raw, { requireExists: opts.requireExists });
  if (!res.ok) {
    return { ok: false, code: res.escaped ? 'PATH_ESCAPE' : 'PATH_NOT_FOUND', message: `${res.reason}。${res.hint}` };
  }
  const base = res.rel.split('/').pop() ?? res.rel;
  if (isSensitive(base)) {
    return { ok: false, code: 'SENSITIVE', message: `敏感文件拒写：${res.rel}（.env/密钥/凭据类；判定大小写不敏感）` };
  }
  return { ok: true, rel: res.rel, abs: res.abs };
}

async function ensureSandbox(ctx: ToolContext): Promise<{ ok: true } | { ok: false; result: ToolResult }> {
  const r = await ctx.sandbox!.ensure();
  if (!r.ok) return { ok: false, result: errResult('SANDBOX_UNAVAILABLE', r.reason, 0) };
  return { ok: true };
}

function safeName(rel: string): string {
  return rel.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80);
}

// ------------------------------------------------------------------ 1) create_file
const createSchema = z.object({
  path: z.string().min(1).describe('仓库内相对路径（新建文件，如 "src/utils/foo.ts"）'),
  content: z.string().describe('文件完整内容'),
  note: z.string().optional().describe('这次改动要解决什么（一句话；进审计与审批卡）'),
});

export const createFile: Tool = {
  name: 'create_file',
  description: '在沙箱中新建文件（暂存；落盘需经 submit_changes 批量审批）。敏感文件一律拒写。',
  inputSchema: createSchema,
  inputExample: { path: 'src/example.ts', content: 'export const x = 1;\n', note: '新增示例' },
  timeoutMs: 30_000,
  permission: 'codebase:write',
  riskLevel: 'high',
  async execute(input, ctx): Promise<ToolResult> {
    const g = gate(ctx, 'create_file');
    if (g) return g;
    const args = input as z.infer<typeof createSchema>;
    if (Buffer.byteLength(args.content, 'utf8') > MAX_FILE_BYTES) {
      return errResult('OUTPUT_LIMIT', `内容超过 ${MAX_FILE_BYTES} 字节上限（分文件拆小）`, 0);
    }
    const t = resolveTarget(ctx, args.path, { requireExists: false });
    if (!t.ok) return errResult(t.code, t.message, 0);
    if (existsSync(t.abs)) return errResult('INVALID_ARGS', `目标已存在：${t.rel}（改用 edit_file）`, 0);
    const s = await ensureSandbox(ctx);
    if (!s.ok) return s.result;
    try {
      await ctx.sandbox!.stage(t.rel, 'create', args.content, { signal: ctx.signal });
    } catch (e) {
      return errResult('STAGE_FAILED', (e as Error).message, 0);
    }
    return okResult(
      { staged: t.rel, op: 'create', next: '继续改动，完成后调用 submit_changes 一次性检查 + 审批' },
      0,
    );
  },
};

// ------------------------------------------------------------------ 2) edit_file
const editSchema = z.object({
  path: z.string().min(1).describe('仓库内相对路径'),
  oldString: z.string().min(1).describe('要被替换的原文片段（必须唯一命中；忽略 CRLF/LF 差异）'),
  newString: z.string().describe('替换后的内容（可为空 = 删除该片段）'),
  note: z.string().optional().describe('这次改动要解决什么（一句话）'),
});

export const editFile: Tool = {
  name: 'edit_file',
  description: '精确替换文件片段（oldString 必须唯一命中；忽略行尾差异，写回保持原文件行尾）。暂存到沙箱，落盘需 submit_changes 审批。',
  inputSchema: editSchema,
  inputExample: { path: 'src/a.ts', oldString: 'const a = 1;', newString: 'const a = 2;', note: '修默认值' },
  timeoutMs: 30_000,
  permission: 'codebase:write',
  riskLevel: 'high',
  async execute(input, ctx): Promise<ToolResult> {
    const g = gate(ctx, 'edit_file');
    if (g) return g;
    const args = input as z.infer<typeof editSchema>;
    const t = resolveTarget(ctx, args.path, { requireExists: true });
    if (!t.ok) return errResult(t.code, t.message, 0);
    const s = await ensureSandbox(ctx);
    if (!s.ok) return s.result;
    const current = ctx.sandbox!.readWorkFile(t.rel);
    if (current === null) return errResult('PATH_NOT_FOUND', `文件不存在或不可读：${t.rel}`, 0);
    const outcome = applyEdit(current, args.oldString, args.newString);
    if (!outcome.ok) return errResult('EDIT_MISMATCH', outcome.reason, 0);
    if (Buffer.byteLength(outcome.content, 'utf8') > MAX_FILE_BYTES) {
      return errResult('OUTPUT_LIMIT', `结果超过 ${MAX_FILE_BYTES} 字节上限`, 0);
    }
    try {
      await ctx.sandbox!.stage(t.rel, 'edit', outcome.content, { signal: ctx.signal });
    } catch (e) {
      return errResult('STAGE_FAILED', (e as Error).message, 0);
    }
    return okResult(
      { staged: t.rel, op: 'edit', eol: outcome.eol === '\r\n' ? 'CRLF' : 'LF', next: '完成后调用 submit_changes' },
      0,
    );
  },
};

// ------------------------------------------------------------------ 3) delete_file
const deleteSchema = z.object({
  path: z.string().min(1).describe('要删除的文件（仓库内相对路径；目录删除请用 run_command）'),
  note: z.string().optional(),
});

export const deleteFile: Tool = {
  name: 'delete_file',
  description: '删除文件（软删：原文先备份到 data/backups/<runId>/，可回滚）。暂存到沙箱，落盘需 submit_changes 审批。',
  inputSchema: deleteSchema,
  inputExample: { path: 'src/obsolete.ts', note: '废弃模块' },
  timeoutMs: 30_000,
  permission: 'codebase:write',
  riskLevel: 'high',
  async execute(input, ctx): Promise<ToolResult> {
    const g = gate(ctx, 'delete_file');
    if (g) return g;
    const args = input as z.infer<typeof deleteSchema>;
    const t = resolveTarget(ctx, args.path, { requireExists: true });
    if (!t.ok) return errResult(t.code, t.message, 0);
    const s = await ensureSandbox(ctx);
    if (!s.ok) return s.result;
    try {
      await ctx.sandbox!.stage(t.rel, 'delete', undefined, { signal: ctx.signal });
    } catch (e) {
      return errResult('STAGE_FAILED', (e as Error).message, 0);
    }
    return okResult({ staged: t.rel, op: 'delete', note: '原文已进备份，可回滚' }, 0);
  },
};

// ------------------------------------------------------------------ 4) copy_path
const copySchema = z.object({
  from: z.string().min(1).describe('源文件（仓库内相对路径）'),
  to: z.string().min(1).describe('目标文件（仓库内相对路径；必须不存在）'),
  note: z.string().optional(),
});

export const copyPath: Tool = {
  name: 'copy_path',
  description: '复制文件（备份/派生新文件的常用操作；目录请用 run_command）。暂存到沙箱，落盘需 submit_changes 审批。',
  inputSchema: copySchema,
  inputExample: { from: 'src/a.ts', to: 'src/a.bak.ts', note: '派生备份副本' },
  timeoutMs: 30_000,
  permission: 'codebase:write',
  riskLevel: 'high',
  async execute(input, ctx): Promise<ToolResult> {
    const g = gate(ctx, 'copy_path');
    if (g) return g;
    const args = input as z.infer<typeof copySchema>;
    const from = resolveTarget(ctx, args.from, { requireExists: true });
    if (!from.ok) return errResult(from.code, from.message, 0);
    const to = resolveTarget(ctx, args.to, { requireExists: false });
    if (!to.ok) return errResult(to.code, to.message, 0);
    if (existsSync(to.abs)) return errResult('INVALID_ARGS', `目标已存在：${to.rel}`, 0);
    const s = await ensureSandbox(ctx);
    if (!s.ok) return s.result;
    const content = ctx.sandbox!.readWorkFile(from.rel);
    if (content === null) return errResult('PATH_NOT_FOUND', `源不是普通文件或不可读：${from.rel}`, 0);
    try {
      await ctx.sandbox!.stage(to.rel, 'create', content, { signal: ctx.signal });
    } catch (e) {
      return errResult('STAGE_FAILED', (e as Error).message, 0);
    }
    return okResult({ staged: to.rel, from: from.rel, op: 'create', next: '完成后调用 submit_changes' }, 0);
  },
};

// ------------------------------------------------------------------ 5) run_command
const cmdSchema = z.object({
  command: z.string().min(1).describe('要执行的命令'),
  shell: z.enum(['bash', 'powershell', 'cmd']).default('bash').describe('bash=可在沙箱预演；powershell/cmd 无法在 Linux 沙箱预演，审批卡会如实标注'),
  cwd: z.string().optional().describe('工作目录（仓库内相对路径；默认仓库根）'),
  note: z.string().optional(),
});

export const runCommand: Tool = {
  name: 'run_command',
  description: '暂存一条命令：bash 类先在 Linux 沙箱真跑取证，随后与文件改动一起进入同一次审批并在宿主执行。powershell/cmd 无法沙箱预演（审批卡标注风险）。',
  inputSchema: cmdSchema,
  inputExample: { command: 'npm run typecheck', shell: 'bash', cwd: '.', note: '类型检查' },
  timeoutMs: 660_000,
  permission: 'codebase:write',
  riskLevel: 'high',
  async execute(input, ctx): Promise<ToolResult> {
    const g = gate(ctx, 'run_command');
    if (g) return g;
    const args = input as z.infer<typeof cmdSchema>;
    const cwd = resolveTarget(ctx, args.cwd ?? '.', { requireExists: true });
    if (!cwd.ok) return errResult(cwd.code, cwd.message, 0);
    const s = await ensureSandbox(ctx);
    if (!s.ok) return s.result;

    let sandboxOutput: string | null = null;
    let sandboxExitCode: number | null = null;
    if (args.shell === 'bash') {
      const workdir = cwd.rel === '.' ? '/work' : `/work/${cwd.rel}`;
      const r = await execInAsync(ctx.sandbox!.name, ['bash', '-lc', args.command], {
        workdir,
        timeoutMs: Math.min(ctx.config.sandbox.execTimeoutMs, 600_000),
        signal: ctx.signal,
      });
      sandboxExitCode = r.exitCode;
      const raw = `${r.stdout}${r.stderr}`.trim();
      sandboxOutput = raw.length > MAX_CMD_OUTPUT ? raw.slice(-MAX_CMD_OUTPUT) : raw;
    }
    ctx.sandbox!.stageCommand({
      command: args.command,
      shell: args.shell,
      cwdRel: cwd.rel,
      sandboxOutput,
      sandboxExitCode,
    });
    return okResult(
      {
        staged: true,
        shell: args.shell,
        sandboxExitCode,
        sandboxOutput: sandboxOutput ?? '（未预演：Linux 沙箱无法执行 powershell/cmd——审批卡会标注此风险）',
        next: '完成后调用 submit_changes 一次性审批并执行',
      },
      0,
    );
  },
};

// ------------------------------------------------------------------ 6) submit_changes
const submitSchema = z.object({
  summary: z.string().optional().describe('这批改动的一句话说明（进审批卡与审计）'),
});

/** 宿主执行命令（审批通过后）：bash → Git Bash；powershell/cmd → 原生 */
async function execHostCommand(
  ctx: ToolContext,
  c: { command: string; shell: 'bash' | 'powershell' | 'cmd'; cwdRel: string },
): Promise<{ ok: boolean; output: string; exitCode: number | null }> {
  const cwd = resolve(ctx.repoPath!, c.cwdRel);
  const bin = c.shell === 'bash' ? 'bash' : c.shell === 'powershell' ? 'powershell.exe' : 'cmd.exe';
  const args =
    c.shell === 'bash' ? ['-lc', c.command] : c.shell === 'powershell' ? ['-NoProfile', '-Command', c.command] : ['/d', '/s', '/c', c.command];
  const r = await spawnAsync(bin, args, {
    cwd,
    timeoutMs: Math.min(ctx.config.sandbox.execTimeoutMs, 600_000),
    maxBuffer: 4 * 1024 * 1024,
    signal: ctx.signal,
  });
  const raw = `${r.stdout}${r.stderr}${r.error ? `\n(进程错误: ${r.error})` : ''}`.trim();
  const output = raw.length > MAX_CMD_OUTPUT ? raw.slice(-MAX_CMD_OUTPUT) : raw;
  return { ok: r.ok, output, exitCode: r.exitCode };
}

/** 宿主复验（评审 P1-8）：落盘后用系统 Node 跑全量测试；失败由调用方回滚。 */
async function hostVerify(ctx: ToolContext) {
  return runHostFullSuite({
    repoPath: ctx.repoPath!,
    nodePath: ctx.config.sandbox.hostNodePath,
    signal: ctx.signal,
    label: '宿主全量测试',
  });
}

export const submitChanges: Tool = {
  name: 'submit_changes',
  description:
    '提交本批暂存改动：① 沙箱检查阶梯（语法/类型/测试）② 一个 change set 一次人工审批（三选一：完全同意此文件/仅同意本次/拒绝）③ 通过则落盘并跑宿主复验（失败自动回滚）。',
  inputSchema: submitSchema,
  inputExample: { summary: '修复 add 的边界问题并补测试' },
  timeoutMs: 900_000,
  permission: 'codebase:write',
  riskLevel: 'high',
  async execute(input, ctx): Promise<ToolResult> {
    const started = Date.now();
    const g = gate(ctx, 'submit_changes');
    if (g) return g;
    const args = input as z.infer<typeof submitSchema>;
    const s = await ensureSandbox(ctx);
    if (!s.ok) return s.result;
    const session = ctx.sandbox!;
    const emit = ctx.emitEvent ?? (() => {});
    const startedMs = Date.now();

    const auto = ctx.autoPolicy?.enabled ? ctx.autoPolicy : undefined;
    const allStaged = session.getChanges().filter((c) => c.status === 'staged' || c.status === 'verified');
    const pendingCmds = session.getCommands().filter((c) => c.status === 'pending');
    if (!allStaged.length && !pendingCmds.length) {
      return errResult('NOTHING_TO_SUBMIT', '没有待提交的改动或命令：先 create_file / edit_file / delete_file / copy_path / run_command', Date.now() - started);
    }

    // 无人值守（仅定时任务）：危险操作不进审批，登记待确认队列（不落盘 / 不执行）。
    const autoDeferred: Array<{ id: string; kind: 'delete' | 'command'; relPath?: string; command?: string }> = [];
    let all = allStaged;
    let cmds = pendingCmds;
    if (auto) {
      if (ctx.untrustedTainted) {
        for (const c of allStaged) session.mark(c.relPath, 'denied');
        const cmdsAll = session.getCommands();
        for (let i = 0; i < cmdsAll.length; i++) {
          if (cmdsAll[i].status === 'pending') session.markCommand(i, 'denied');
        }
        return errResult(
          'AUTO_DEFERRED_TAINT',
          '本 run 读取过疑似注入内容：无人值守自动放行已禁用，改动未落盘。请人工检查后重跑。',
          Date.now() - started,
        );
      }
      // 删除 → 待确认；create/edit 继续走阶梯与落盘
      all = allStaged.filter((c) => {
        if (c.op !== 'delete') return true;
        const id = auto.createPending({
          kind: 'delete',
          payload: { repoPath: ctx.repoPath, relPath: c.relPath, baseHash: c.baseHash },
        });
        session.mark(c.relPath, 'deferred');
        autoDeferred.push({ id, kind: 'delete', relPath: c.relPath });
        return false;
      });
      // 宿主命令 → 一律待确认，不执行
      const cmdsAll = session.getCommands();
      for (let i = 0; i < cmdsAll.length; i++) {
        const c = cmdsAll[i];
        if (c.status !== 'pending') continue;
        const id = auto.createPending({
          kind: 'command',
          payload: { repoPath: ctx.repoPath, command: c.command, shell: c.shell, cwdRel: c.cwdRel },
        });
        session.markCommand(i, 'deferred');
        autoDeferred.push({ id, kind: 'command', command: c.command });
      }
      cmds = [];
    }

    if (!all.length && !cmds.length) {
      if (autoDeferred.length) {
        emit('change_deferred', { files: autoDeferred.filter((d) => d.kind === 'delete').map((d) => d.relPath), commands: autoDeferred.filter((d) => d.kind === 'command').length });
        return okResult(
          { stagedBefore: allStaged.length, applied: [], refused: [], deferred: autoDeferred, autoApproved: true },
          Date.now() - startedMs,
        );
      }
      return errResult('NOTHING_TO_SUBMIT', '没有待提交的改动或命令', Date.now() - started);
    }

    const maxFiles = ctx.config.approval.maxFilesPerRequest;
    const changes = all.slice(0, maxFiles);
    const deferred = all.length - changes.length;

    const changedRels = changes.map((c) => c.relPath);

    // ① 检查阶梯（默认 L1：L0 逐文件语法 + tsc --incremental + 受影响测试/全量兜底；
    //    严格模式 L2：再跑一次容器内全量。落盘后仍有宿主全量复验，所以默认不双跑。）
    const ladderLevel = ctx.config.sandbox.l2BeforeApproval ? 'L2' : 'L1';
    const checkStarted = Date.now();
    emit('verification_started', { level: ladderLevel, phase: 'sandbox', files: changedRels });
    const ladder = await session.runLadder(ladderLevel, { signal: ctx.signal });
    const checks = ladder.steps.map((st) => ({ level: ladder.level, source: st.source, ok: st.verdict.ok, summary: st.verdict.summary }));
    emit('verification_completed', {
      level: ladderLevel,
      phase: 'sandbox',
      ok: ladder.ok,
      durationMs: Date.now() - checkStarted,
      cancelled: !!ctx.signal?.aborted,
      files: changedRels,
      steps: checks,
    });
    if (!ladder.ok) {
      const bad = ladder.steps.find((st) => !st.verdict.ok)!;
      for (const c of changes) session.consumeRound(c.relPath);
      const zero = changes.filter((c) => session.getChanges().find((x) => x.relPath === c.relPath)?.retriesLeft === 0);
      return errResult(
        'SANDBOX_CHECK_FAILED',
        `沙箱校验未通过：${bad.verdict.summary}\n` +
          `修复提示：${bad.verdict.repairHint ?? '（无）'}\n` +
          `证据（截断）：\n${(bad.verdict.excerpt ?? '').slice(0, 1200)}\n` +
          (zero.length
            ? `\n⚠️ 以下文件重生成轮次已用尽（沙箱会话内计数，重派不重置）：${zero.map((c) => c.relPath).join(', ')}——请停止重试并在结论里如实上报 unresolved。`
            : `\n（每文件剩余重生成轮次已扣减；修好后再次 submit_changes）`),
        Date.now() - started,
      );
    }

    // ② 组装 change set + 审批请求（diff 落文件，事件只带摘要）
    const approvalId = `ap_${randomUUID().slice(0, 8)}`;
    const files = await Promise.all(changes.map(async (c) => {
      const patch = await session.diffPatch(c.relPath, `${approvalId}-${safeName(c.relPath)}`);
      const st = diffStat(patch);
      return {
        relPath: c.relPath,
        op: c.op,
        addedLines: st.added,
        removedLines: st.removed,
        diffPath: join(session.diffDir(), `${approvalId}-${safeName(c.relPath)}.patch`),
      };
    }));
    const nonSandboxed = cmds.filter((c) => c.shell !== 'bash');
    const risk = assessApprovalRisk({
      ops: changes.map((c) => c.op),
      hasCommands: cmds.length > 0,
    });
    const highRiskWarnings: string[] = [];
    if (risk.reasons.includes('delete')) {
      highRiskWarnings.push('本批含删除操作：需在当前审批卡完成二次确认，且不适用「完全同意此文件」的粘性自动放行。');
    }
    if (risk.reasons.includes('host-command')) {
      highRiskWarnings.push(`本批含 ${cmds.length} 条宿主命令：命令副作用无法从沙箱同步，需二次确认且粘性自动放行已禁用。`);
    }
    const request: ApprovalRequest = {
      approvalId,
      runId: ctx.runId,
      toolName: 'submit_changes',
      files,
      checks,
      riskNote:
        nonSandboxed.length > 0
          ? `⚠️ 有 ${nonSandboxed.length} 条命令（${nonSandboxed.map((c) => c.shell).join('/')}）无法在 Linux 沙箱预演，将通过审批后在宿主直接执行——副作用靠 git/备份兜底，无法从沙箱同步。`
          : undefined,
      warnings: highRiskWarnings.length ? highRiskWarnings : undefined,
      hasCommands: cmds.length > 0 || undefined,
      highRisk: risk.highRisk || undefined,
      riskReasons: risk.reasons.length ? risk.reasons : undefined,
      requiresExplicitConfirmation: risk.highRisk || undefined,
      requestedAt: new Date().toISOString(),
    };
    let decision: ApprovalDecision;
    if (auto) {
      const decidedAt = new Date().toISOString();
      emit('approval_decided', {
        approvalId,
        value: 'allow_once',
        actor: 'auto-policy',
        autoByPolicy: true,
        files: changes.map((c) => c.relPath),
      });
      decision = { approvalId, value: 'allow_once', actor: 'auto-policy', decidedAt, autoByPolicy: true };
    } else {
      decision = await ctx.requestApproval!(request);
    }

    if (decision.value === 'deny') {
      for (const c of changes) session.mark(c.relPath, 'denied');
      cmds.forEach((_c, i) => session.markCommand(i, 'denied'));
      return errResult(
        'APPROVAL_DENIED',
        `审批被拒绝${decision.reason ? `：${decision.reason}` : '（未给理由）'}` +
          (decision.denyLimitReached ? '\n⚠️ 该文件连续拒绝已达上限：停止重试，在结论里如实上报（unresolved）。' : '\n可按拒绝理由修正后重新 submit_changes。'),
        Date.now() - started,
      );
    }

    // ②.5 落盘意图日志：必须在碰任何文件之前写成功。
    // 崩溃窗口：applyToRepo 是逐文件 rm→rename，change_applied 在整批后才发；
    // 没有这份日志，进程被杀后无法判断「哪些已落盘、哪些该恢复」。
    try {
      await session.beginApply(
        approvalId,
        changes.map((c) => ({
          relPath: c.relPath,
          op: c.op,
          baseHash: c.baseHash,
          // 以落盘时实际 work 副本为准：newHash 是 stage 时算的，若之后内容有变化会与写入不一致。
          workHash: c.op === 'delete' ? undefined : shortSha256(session.readWorkFile(c.relPath) ?? ''),
        })),
      );
    } catch (e) {
      return errResult(
        'APPLY_JOURNAL_FAILED',
        `落盘意图日志写入失败，已中止落盘（仓库未改动）：${(e as Error).message}`,
        Date.now() - started,
      );
    }

    // ③ 落盘（逐文件：TOCTOU 哈希守卫 + 备份 + 原子写）
    const applied: string[] = [];
    const refused: string[] = [];
    for (const c of changes) {
      try {
        const r = await session.applyToRepo(c.relPath, approvalId);
        if (r.ok) applied.push(c.relPath);
        else {
          refused.push(`${c.relPath}：${r.reason}`);
          session.mark(c.relPath, 'denied');
        }
      } catch (e) {
        // 单个文件抛异常（磁盘满/权限/短路径等）不能中断整批：否则后面的文件既不落盘、
        // 也不进 change_applied，崩溃对账之外又出现一个「状态说不清」的窗口。
        refused.push(`${c.relPath}：${(e as Error).message}`);
        session.mark(c.relPath, 'denied');
      }
    }
    emit('change_applied', { approvalId, applied, refused, files: changes.map((c) => ({ relPath: c.relPath, op: c.op })) });
    if (applied.length === 0 && refused.length > 0) {
      return errResult(
        'APPLY_FAILED',
        `本批 ${refused.length} 个文件全部未落盘（仓库未被本次提交修改）：\n${refused.join('\n')}`,
        Date.now() - started,
      );
    }

    // ④ 命令宿主执行（审批通过后）
    const cmdResults: Array<{ command: string; shell: string; ok: boolean; exitCode: number | null; output: string }> = [];
    for (let i = 0; i < cmds.length; i++) {
      const c = cmds[i];
      const r = await execHostCommand(ctx, c);
      session.markCommand(i, r.ok ? 'executed' : 'failed', { output: r.output, exitCode: r.exitCode });
      cmdResults.push({ command: c.command, shell: c.shell, ok: r.ok, exitCode: r.exitCode, output: r.output.slice(0, MAX_CMD_OUTPUT) });
    }

    // ⑤ 宿主复验（沙箱 Linux ≠ 宿主 Windows；这是落盘后的 L2 全量检查）+ 失败自动回滚
    const verifyStarted = Date.now();
    emit('verification_started', { level: 'L2', phase: 'host', approvalId, files: applied });
    const verify = await hostVerify(ctx);
    emit('verification_completed', {
      level: 'L2',
      phase: 'host',
      approvalId,
      ok: verify.ok,
      ran: verify.ran,
      mode: verify.mode,
      coverage: verify.coverage,
      blocking: verify.blocking,
      durationMs: verify.durationMs || Date.now() - verifyStarted,
      exitCode: verify.exitCode,
      timedOut: verify.timedOut,
      aborted: verify.aborted,
      files: applied,
      note: verify.note.slice(0, 500),
    });
    let rolledBack: string[] = [];
    if (verify.blocking && applied.length) {
      for (const rel of applied) {
        if (await session.rollbackFromBackup(rel, approvalId)) rolledBack.push(rel);
      }
      if (rolledBack.length) {
        emit('change_rolled_back', { approvalId, files: rolledBack, reason: verify.note.slice(0, 500) });
      }
    }

    return okResult(
      {
        approvalId,
        decision: decision.value,
        stagedBefore: all.length,
        applied,
        refused,
        deferredNote: deferred > 0 ? `另有 ${deferred} 个改动未纳入本批（上限 ${maxFiles}/批）：本批通过后再 submit_changes` : undefined,
        commands: cmdResults,
        hostVerify: verify,
        rolledBack: rolledBack.length ? rolledBack : undefined,
        summary: args.summary,
        autoApproved: auto ? true : undefined,
        deferred: autoDeferred.length ? autoDeferred : undefined,
      },
      Date.now() - started,
    );
  },
};

export const WRITE_TOOLS: Tool[] = [createFile, editFile, deleteFile, copyPath, runCommand, submitChanges];
