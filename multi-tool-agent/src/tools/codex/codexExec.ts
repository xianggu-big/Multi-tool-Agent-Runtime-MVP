// src/tools/codex/codexExec.ts — 把一段任务交给本机 Codex CLI（工具入口）
//
// 能力边界：
//   - read_only：在「宿主侧只读副本」上跑（排除 .env*/.git/data/node_modules），不需要 Docker；
//   - write：需要本 run 显式授权（ctx.allowCodexWrite） + Docker 沙箱；Codex 只改副本，
//     改动随后导入现有 submit_changes（阶梯/审批/落盘/宿主复验/回滚）。
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import type { Tool } from '../types.js';
import { okResult, errResult } from '../types.js';
import { runCodex } from '../../codex/runner.js';
import { scanCodexChanges } from '../../codex/importChanges.js';
import { prepareCodexWorkspace, removeCodexWorkspace } from '../../codex/workspace.js';
import { resolveWorkspacePath } from '../shared/workspacePath.js';
import { submitChanges } from '../codebase/writeTools.js';
import { shortSha256 } from '../../sandbox/hash.js';

const schema = z.object({
  prompt: z.string().min(1).max(20_000).describe('交给 Codex 的任务描述（它会自己读文件、决定步骤）'),
  mode: z.enum(['read_only', 'write']).optional().describe('默认 read_only；write 需要本 run 显式写授权'),
  cwdRel: z.string().optional().describe('相对仓库根的工作目录（默认仓库根）'),
  model: z.string().max(100).optional().describe('覆盖 Codex 模型（可选）'),
  timeoutMs: z.number().int().min(1000).max(3_600_000).optional().describe('单次执行上限（毫秒）'),
});

/** 工具侧只读副本放在系统临时目录，调用结束即删（不污染仓库/项目目录） */
function dataDirOf(): string {
  return join(tmpdir(), 'mta-codex');
}

export const codexExec: Tool = {
  name: 'codex_exec',
  description:
    '把一段代码任务交给本机 Codex CLI 执行。read_only（默认）只分析并返回结论；write 会先改副本，' +
    '再由运行时统一走检查阶梯与人工审批后落盘（不会直接生效）。适合需要多步探索/修改的代码任务。',
  inputSchema: schema,
  inputExample: { prompt: '检查 src/utils/calc.ts 的边界问题并给出修复建议', mode: 'read_only', cwdRel: '.' },
  timeoutMs: 900_000,
  permission: 'codex:exec',
  riskLevel: 'high',
  terminal: false,
  async execute(input, ctx) {
    const started = Date.now();
    const args = input as z.infer<typeof schema>;
    const cfg = ctx.config.codex;
    if (!cfg.enabled) return errResult('CODEX_DISABLED', 'Codex 已禁用（MTA_CODEX_ENABLED=false）', Date.now() - started);
    if (!ctx.repoPath) return errResult('NO_WORKSPACE', '缺少 repoPath，无法确定 Codex 工作区', Date.now() - started);

    const mode = args.mode ?? 'read_only';
    if (mode === 'write' && ctx.allowCodexWrite !== true) {
      return errResult(
        'WRITE_DISABLED',
        'Codex 写模式未授权：需要本 run 显式开启写能力（orchestrator 的「允许修改文件」或 codex 任务的 allowWrite）。',
        Date.now() - started,
      );
    }
    if (mode === 'write' && (!ctx.sandbox || !ctx.requestApproval)) {
      return errResult('WRITE_UNAVAILABLE', '写模式需要沙箱与审批通道，当前上下文未注入（fail-closed）', Date.now() - started);
    }

    const cwdRes = resolveWorkspacePath(ctx.repoPath, args.cwdRel ?? '.', { allowRoot: true, requireExists: true });
    if (!cwdRes.ok) {
      return errResult(cwdRes.escaped ? 'PATH_ESCAPE' : 'PATH_NOT_FOUND', `${cwdRes.reason}。${cwdRes.hint}`, Date.now() - started);
    }

    const model = args.model ?? cfg.model;
    const timeoutMs = Math.min(args.timeoutMs ?? cfg.timeoutMs, cfg.timeoutMs);

    if (mode === 'read_only') {
      const workspaceId = `tool_${randomUUID().slice(0, 8)}`;
      const dataDir = dataDirOf();
      let cwd: string;
      try {
        const copyDir = await prepareCodexWorkspace({ repoPath: ctx.repoPath, dataDir, workspaceId });
        cwd = cwdRes.rel === '.' ? copyDir : join(copyDir, cwdRes.rel);
      } catch (e) {
        return errResult('WORKSPACE_COPY_FAILED', `只读副本创建失败：${(e as Error).message}`, Date.now() - started);
      }
      try {
        const r = await runCodex({
          bin: cfg.bin,
          model,
          cwd,
          prompt: args.prompt,
          mode: 'read_only',
          timeoutMs,
          maxOutputBytes: cfg.maxOutputBytes,
          signal: ctx.signal,
        });
        if (r.threadId) ctx.emitEvent?.('codex_thread', { threadId: r.threadId, cwd, mode: 'read_only' });
        if (!r.ok) {
          return errResult('CODEX_FAILED', r.error ?? 'Codex 执行失败', Date.now() - started, { retryable: false });
        }
        return okResult(
          {
            answer: r.finalAnswer.slice(0, cfg.summaryChars),
            threadId: r.threadId,
            usage: r.usage,
            commands: r.commands.map((c) => ({ command: c.command.slice(0, 1000), exitCode: c.exitCode ?? null, status: c.status })),
            durationMs: r.durationMs,
          },
          Date.now() - started,
        );
      } finally {
        await removeCodexWorkspace(dataDir, workspaceId).catch(() => {});
      }
    }

    // write：Codex 只改沙箱副本
    const session = ctx.sandbox!;
    const ready = await session.ensure();
    if (!ready.ok) return errResult('SANDBOX_UNAVAILABLE', ready.reason, Date.now() - started);
    if (!session.copyDir) {
      return errResult('WRITE_UNAVAILABLE', '当前沙箱不支持副本目录（copyDir），Codex 写模式不可用', Date.now() - started);
    }
    const copyDir = session.copyDir();
    const cwd = cwdRes.rel === '.' ? copyDir : join(copyDir, cwdRes.rel);
    const r = await runCodex({
      bin: cfg.bin,
      model,
      cwd,
      prompt: args.prompt,
      mode: 'write',
      timeoutMs,
      maxOutputBytes: cfg.maxOutputBytes,
      signal: ctx.signal,
    });
    if (r.threadId) ctx.emitEvent?.('codex_thread', { threadId: r.threadId, cwd, mode: 'write' });
    if (!r.ok) return errResult('CODEX_FAILED', r.error ?? 'Codex 执行失败', Date.now() - started, { retryable: false });

    const scanned = await scanCodexChanges({ repoPath: ctx.repoPath, copyDir });
    const refused: string[] = [];
    const deferred: Array<{ id: string; kind: string; relPath?: string }> = [];
    let imported = 0;
    for (const c of scanned.changes) {
      if (c.op === 'delete' && ctx.autoPolicy?.enabled) {
        const base = session.readRepoFile(c.relPath);
        const id = ctx.autoPolicy.createPending({
          kind: 'delete',
          payload: { repoPath: ctx.repoPath, relPath: c.relPath, baseHash: base !== null ? shortSha256(base) : undefined },
        });
        deferred.push({ id, kind: 'delete', relPath: c.relPath });
        continue;
      }
      try {
        await session.stage(c.relPath, c.op, c.content, { signal: ctx.signal });
        imported++;
      } catch (e) {
        refused.push(`${c.relPath}：${(e as Error).message}`);
      }
    }
    if (imported === 0) {
      return okResult(
        { answer: r.finalAnswer.slice(0, cfg.summaryChars), threadId: r.threadId, imported: 0, refused, deferred, skipped: scanned.skipped },
        Date.now() - started,
      );
    }
    const submit = await submitChanges.execute({ summary: `Codex 改动（${imported} 个文件）` }, ctx);
    return okResult(
      {
        answer: r.finalAnswer.slice(0, cfg.summaryChars),
        threadId: r.threadId,
        imported,
        refused,
        deferred,
        skipped: scanned.skipped,
        submit: submit.ok ? submit.data : { error: submit.error },
      },
      Date.now() - started,
    );
  },
};
