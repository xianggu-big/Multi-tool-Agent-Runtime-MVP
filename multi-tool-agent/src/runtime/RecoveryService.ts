// src/runtime/RecoveryService.ts — 崩溃对账与恢复（启动扫描 + 手动回滚）
//
// 解决的问题（不是理论问题）：
//   applyToRepo 是逐文件 rm → rename，而 change_applied 在整批结束后才发。
//   进程在中间被杀时，仓库可能「部分文件已改、零事件」；进程在 rm 与 rename 之间被杀时，
//   文件会暂时消失，只剩 `.mta-tmp-*` 与 data/backups 里的原文备份。
//
// 本服务只做三件事：
//   ① 启动时按 apply-journal 与仓库现状对账，生成可读报告；
//   ② 对「编辑操作 + 文件消失 + 备份存在」这一确定性的坏状态，自动恢复原文；
//   ③ 其余已落盘改动**不自动回滚**，由用户通过 API 明确选择回滚或保留（避免覆盖用户后续修改）。
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  readApplyJournal,
  updateApplyEntry,
  writeFileAtomic,
  type ApplyJournalEntry,
  type JournalOp,
} from '../sandbox/applyJournal.js';
import { shortSha256 } from '../sandbox/hash.js';
import { assertRelPath } from '../sandbox/session.js';
import type { SqliteStore } from '../store/SqliteStore.js';
import type { TraceEventType } from '../types.js';

const TERMINAL_STATUS = new Set(['completed', 'failed', 'cancelled', 'limit_reached', 'awaiting_user']);

export type RecoveryObservation = 'applied' | 'not_applied' | 'missing' | 'conflict' | 'unknown';
export type RecoveryAction = 'none' | 'rollback' | 'restore_backup' | 'manual_review' | 'auto_restored';
export type RecoveryStatus =
  | 'clean'
  | 'pending'
  | 'conflict'
  | 'legacy'
  | 'repo_missing'
  | 'run_missing'
  | 'not_needed'
  | 'accepted'
  | 'rolled_back';

export interface RecoveryFileReport {
  relPath: string;
  op: JournalOp;
  approvalId: string;
  observed: RecoveryObservation;
  action: RecoveryAction;
  currentHash: string | null;
  baseHash?: string;
  workHash?: string;
  backupExists: boolean;
  /** 仓库内相对路径；`.mta-tmp-*` 崩溃残留 */
  tmpLeftovers: string[];
  note?: string;
}

export interface RecoveryReport {
  runId: string;
  status: RecoveryStatus;
  repoPath: string;
  interrupted: boolean;
  runStatus?: string;
  errorCode?: string;
  generatedAt: string;
  journalUpdatedAt?: string;
  counts: {
    applied: number;
    not_applied: number;
    missing: number;
    conflict: number;
    unknown: number;
    tmpLeftovers: number;
    total: number;
  };
  files: RecoveryFileReport[];
  /** 整体说明（如：日志损坏 / 仓库被移动） */
  note?: string;
  autoRestored?: string[];
  rolledBack?: string[];
  conflicts?: string[];
  acceptedAt?: string;
  rolledBackAt?: string;
}

export interface RecoveryServiceOptions {
  /** 与 AgentRuntime / VerificationService 一致：SQLite 所在目录即 data/ 根 */
  dataDir: string;
  store: Pick<SqliteStore, 'getRun' | 'getEvents'>;
  /** 启动时自动恢复「编辑 + 文件消失 + 有备份」；默认 true（这是确定性的坏状态） */
  autoRestoreMissing?: boolean;
  emit?: (runId: string, type: TraceEventType, data: Record<string, unknown>) => void;
  /** 终态 run 追加事件前的序号校准（复用 VerificationService 的做法） */
  prepareEvent?: (runId: string) => void;
}

export interface RecoveryRollbackResult {
  ok: boolean;
  error?: string;
  report?: RecoveryReport;
  rolledBack: string[];
  conflicts: string[];
}

export class RecoveryService {
  private readonly autoRestoreMissing: boolean;

  constructor(private readonly opts: RecoveryServiceOptions) {
    this.autoRestoreMissing = opts.autoRestoreMissing ?? true;
  }

  // ---------------------------------------------------------------- 启动扫描

  /**
   * 只应在服务入口调用（buildRuntime 被测试/演示脚本复用，不应碰真实仓库）。
   * 扫描 data/backups/*，按 run 过滤「本次启动回收的孤儿运行」，生成报告；
   * 可选自动恢复确定性坏状态（文件消失）。绝不自动回滚已落盘的编辑/新增。
   */
  async startupSweep(): Promise<RecoveryReport[]> {
    const root = join(this.opts.dataDir, 'backups');
    if (!existsSync(root)) return [];
    let runIds: string[] = [];
    try {
      runIds = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }

    const reports: RecoveryReport[] = [];
    for (const runId of runIds) {
      const rec = this.opts.store.getRun(runId);
      if (!rec) continue;
      const interrupted = rec.errorCode === 'RUN_INTERRUPTED' || !TERMINAL_STATUS.has(rec.status);
      if (!interrupted) continue;

      let report = await this.inspect(runId);
      if (this.autoRestoreMissing && report.interrupted) {
        report = await this.autoRestore(report);
      }
      const attention =
        report.status === 'pending' ||
        report.status === 'conflict' ||
        report.status === 'legacy' ||
        report.status === 'repo_missing' ||
        (report.autoRestored?.length ?? 0) > 0;
      if (!attention) continue;

      report = await this.inspect(runId, { keepMetaFrom: report });
      await this.persist(report);
      this.emitEvent(runId, 'recovery_detected', {
        status: report.status,
        repoPath: report.repoPath,
        counts: report.counts,
        autoRestored: report.autoRestored,
        files: report.files.map((f) => ({
          relPath: f.relPath,
          op: f.op,
          observed: f.observed,
          action: f.action,
        })),
      });
      if (report.autoRestored?.length) {
        this.emitEvent(runId, 'recovery_auto_restored', { files: report.autoRestored });
        console.warn(`[startup] 崩溃对账：自动恢复 ${report.autoRestored.length} 个被中断的文件（run=${runId}）`);
      }
      if (report.status === 'pending' || report.status === 'conflict') {
        console.warn(
          `[startup] 崩溃对账：run=${runId} 有 ${report.counts.applied} 个文件已落盘、` +
            `${report.counts.conflict} 个冲突——未自动回滚，请查看 GET /api/runs/${runId}/recovery`,
        );
      }
      reports.push(report);
    }
    return reports;
  }

  // ---------------------------------------------------------------- 对账

  async inspect(runId: string, opts: { keepMetaFrom?: RecoveryReport } = {}): Promise<RecoveryReport> {
    const rec = this.opts.store.getRun(runId);
    if (!rec) return baseReport(runId, 'run_missing', '');

    const interrupted = rec.errorCode === 'RUN_INTERRUPTED' || !TERMINAL_STATUS.has(rec.status);
    const journal = await readApplyJournal(this.opts.dataDir, runId);
    if (!journal) {
      return this.inspectLegacy(runId, rec, interrupted);
    }

    const repoPath = resolve(journal.repoPath);
    const files: RecoveryFileReport[] = [];
    for (const e of latestEntries(journal.entries)) {
      files.push(await this.inspectEntry(repoPath, runId, e));
    }

    const report = buildReport(runId, repoPath, interrupted, rec, journal.updatedAt, files);
    if (!existsSync(repoPath)) {
      report.status = 'repo_missing';
      report.note = '仓库目录已不存在（可能被移动/删除），无法对账。';
      return report;
    }
    if (!interrupted) {
      // 正常完成/正常失败的 run：已落盘是审批后的预期结果，不当作崩溃垃圾。
      report.status = 'not_needed';
      return this.applyPersistedMeta(report, opts.keepMetaFrom);
    }
    if (report.counts.conflict > 0) report.status = 'conflict';
    else if (report.counts.applied > 0 || report.counts.missing > 0 || report.counts.tmpLeftovers > 0) {
      report.status = 'pending';
    } else report.status = 'clean';
    return this.applyPersistedMeta(report, opts.keepMetaFrom);
  }

  /** 旧版本没有 apply-journal：只能列出备份并标记人工比对，绝不自动改文件。 */
  private async inspectLegacy(
    runId: string,
    rec: NonNullable<ReturnType<RecoveryServiceOptions['store']['getRun']>>,
    interrupted: boolean,
  ): Promise<RecoveryReport> {
    const dir = join(this.opts.dataDir, 'backups', runId);
    if (!existsSync(dir)) return baseReport(runId, interrupted ? 'clean' : 'not_needed', '');
    const rels = listBackupFiles(dir);
    const repoPath = this.repoPathOfRun(runId);
    const repoOk = !!repoPath && existsSync(repoPath);
    const journalCorrupt = existsSync(join(dir, 'apply-journal.json'));
    if (!rels.length) {
      const r = baseReport(runId, interrupted ? (journalCorrupt ? 'conflict' : 'clean') : 'not_needed', repoPath);
      if (journalCorrupt) r.note = '落盘意图日志损坏，且没有可列出的原文备份；无法自动对账。';
      return r;
    }
    const files: RecoveryFileReport[] = [];
    for (const rel of rels) {
      let currentHash: string | null = null;
      try {
        const cur = repoOk ? await readText(resolve(repoPath, assertRelPath(rel))) : null;
        currentHash = cur === null ? null : shortSha256(cur);
      } catch {
        currentHash = null;
      }
      let backupHash: string | null = null;
      try {
        backupHash = shortSha256(await readFile(join(dir, rel), 'utf8'));
      } catch {
        backupHash = null;
      }
      files.push({
        relPath: rel,
        op: 'edit',
        approvalId: 'legacy',
        observed: currentHash !== null && currentHash === backupHash ? 'not_applied' : 'unknown',
        action: 'manual_review',
        currentHash,
        backupExists: true,
        tmpLeftovers: [],
        note: journalCorrupt
          ? '落盘意图日志损坏，无法对账；请人工比对备份。'
          : '旧版本没有落盘意图日志：无法区分「已落盘」与「用户后续修改」，请人工比对备份。',
      });
    }
    const report = buildReport(runId, repoPath, interrupted, rec, undefined, files);
    report.status = interrupted ? (repoOk ? 'legacy' : 'repo_missing') : 'not_needed';
    return report;
  }

  private async inspectEntry(repoPath: string, runId: string, e: ApplyJournalEntry): Promise<RecoveryFileReport> {
    const base: RecoveryFileReport = {
      relPath: e.relPath,
      op: e.op,
      approvalId: e.approvalId,
      observed: 'unknown',
      action: 'manual_review',
      currentHash: null,
      baseHash: e.baseHash,
      workHash: e.workHash,
      backupExists: false,
      tmpLeftovers: [],
      note: e.note,
    };
    try {
      const rel = assertRelPath(e.relPath);
      const abs = resolve(repoPath, rel);
      const current = await readText(abs);
      const currentHash = current === null ? null : shortSha256(current);
      const backupPath = join(this.opts.dataDir, 'backups', runId, rel);
      const backupExists = existsSync(backupPath);
      base.currentHash = currentHash;
      base.backupExists = backupExists;
      base.tmpLeftovers = await listTmpLeftovers(repoPath, abs);

      if (e.op === 'delete') {
        if (currentHash === null) {
          base.observed = 'applied';
          base.action = backupExists ? 'rollback' : 'manual_review';
          base.note = backupExists ? '删除已生效；回滚将从备份恢复原文。' : '删除已生效，但备份缺失，无法自动恢复。';
        } else if (e.baseHash && currentHash === e.baseHash) {
          base.observed = 'not_applied';
          base.action = 'none';
        } else {
          base.observed = 'conflict';
          base.note = '删除操作未完成，且当前文件与原文不一致（可能被用户改过）。';
        }
      } else if (e.op === 'create') {
        if (currentHash === null) {
          base.observed = 'not_applied';
          base.action = 'none';
        } else if (e.workHash && currentHash === e.workHash) {
          base.observed = 'applied';
          base.action = 'rollback';
          base.note = '新增文件已落盘；回滚将删除它。';
        } else {
          base.observed = 'conflict';
          base.note = '新增文件已存在，但内容不是本次写入的版本（可能被用户改过）。';
        }
      } else {
        if (currentHash === null) {
          base.observed = 'missing';
          base.action = backupExists ? 'restore_backup' : 'manual_review';
          base.note = backupExists
            ? '文件在崩溃窗口内消失（rm 后、rename 前）；可从备份恢复。'
            : '文件消失，但没有原文备份，无法自动恢复。';
        } else if (e.baseHash && currentHash === e.baseHash) {
          base.observed = 'not_applied';
          base.action = 'none';
        } else if (e.workHash && currentHash === e.workHash) {
          base.observed = 'applied';
          base.action = 'rollback';
          base.note = '编辑已落盘；回滚将恢复原文。';
        } else {
          base.observed = 'conflict';
          base.note = '当前内容既不是原文也不是本次写入的版本（可能被用户改过）。';
        }
      }
      if (base.tmpLeftovers.length && base.action === 'none') {
        base.note = `${base.note ?? ''} 检测到 .mta-tmp-* 崩溃残留，可安全清理。`.trim();
      }
      return base;
    } catch (err) {
      base.note = `对账失败：${(err as Error).message}`;
      return base;
    }
  }

  // ---------------------------------------------------------------- 自动恢复

  private async autoRestore(report: RecoveryReport): Promise<RecoveryReport> {
    const restored: string[] = [];
    for (const f of report.files) {
      if (f.observed !== 'missing' || f.op !== 'edit' || !f.backupExists) continue;
      const abs = resolve(report.repoPath, f.relPath);
      const current = await readText(abs);
      if (current !== null) continue; // 已被用户/其他进程恢复，别覆盖
      const backup = await readFile(join(this.opts.dataDir, 'backups', report.runId, f.relPath), 'utf8');
      try {
        await writeFileAtomic(abs, backup);
        await updateApplyEntry(this.opts.dataDir, report.runId, f.approvalId, f.relPath, {
          status: 'rolled_back',
          note: 'startup auto-restore（崩溃窗口内文件消失）',
        });
        restored.push(f.relPath);
        await this.cleanTmp(report.repoPath, f.tmpLeftovers);
      } catch {
        // 单个文件失败不阻断其余恢复；报告里仍会显示 missing。
      }
    }
    if (!restored.length) return report;
    const next = await this.inspect(report.runId, { keepMetaFrom: report });
    next.autoRestored = [...new Set([...(report.autoRestored ?? []), ...restored])];
    return next;
  }

  // ---------------------------------------------------------------- 手动操作

  /** 回滚「已落盘」与「文件消失」的改动；冲突文件一律跳过，不覆盖用户后续修改。 */
  async rollback(runId: string): Promise<RecoveryRollbackResult> {
    const before = await this.inspect(runId);
    if (before.status === 'run_missing') return { ok: false, error: '任务不存在', rolledBack: [], conflicts: [] };
    if (before.status === 'repo_missing') {
      return { ok: false, error: `仓库目录不存在：${before.repoPath}`, report: before, rolledBack: [], conflicts: [] };
    }
    if (before.status === 'legacy') {
      return {
        ok: false,
        error: '旧任务没有可用的落盘意图日志，无法安全自动回滚；请人工比对 data/backups 下的原文备份。',
        report: before,
        rolledBack: [],
        conflicts: [],
      };
    }
    if (!before.interrupted) {
      return { ok: false, error: '只有「被中断」的任务才允许崩溃恢复回滚（正常完成的任务请用审批/备份流程）', report: before, rolledBack: [], conflicts: [] };
    }

    const rolledBack: string[] = [];
    const conflicts: string[] = [];
    const repoPath = before.repoPath;
    for (const f of before.files) {
      const abs = resolve(repoPath, f.relPath);
      const current = await readText(abs);
      const currentHash = current === null ? null : shortSha256(current);

      if (f.observed === 'applied' || f.observed === 'missing') {
        if (f.observed === 'applied' && f.currentHash !== currentHash) {
          conflicts.push(f.relPath);
          continue;
        }
        if (f.observed === 'missing' && current !== null) {
          conflicts.push(f.relPath);
          continue;
        }
        try {
          if (f.op === 'create') {
            if (currentHash === null) {
              // 已经是目标状态，无需动作
            } else if (currentHash === f.workHash) {
              await rm(abs, { force: true });
            } else {
              conflicts.push(f.relPath);
              continue;
            }
          } else if (f.backupExists) {
            const backup = await readFile(join(this.opts.dataDir, 'backups', runId, f.relPath), 'utf8');
            await writeFileAtomic(abs, backup);
          } else {
            conflicts.push(f.relPath);
            continue;
          }
          await updateApplyEntry(this.opts.dataDir, runId, f.approvalId, f.relPath, {
            status: 'rolled_back',
            note: 'manual recovery rollback',
          });
          rolledBack.push(f.relPath);
        } catch (err) {
          conflicts.push(`${f.relPath}（${(err as Error).message}）`);
        }
      } else if (f.observed === 'conflict') {
        // 冲突文件一律不碰：它既不是原文也不是本次写入的版本，很可能是用户后续修改。
        conflicts.push(f.relPath);
      }
      await this.cleanTmp(repoPath, f.tmpLeftovers);
    }

    const after = await this.inspect(runId);
    after.rolledBack = rolledBack;
    after.conflicts = conflicts;
    after.rolledBackAt = new Date().toISOString();
    after.status = conflicts.length ? 'conflict' : 'rolled_back';
    await this.persist(after);
    this.emitEvent(runId, 'recovery_rolled_back', { files: rolledBack, conflicts });
    return { ok: true, report: after, rolledBack, conflicts };
  }

  /** 保留当前仓库状态，结束恢复提示（不触碰任何文件）。 */
  async accept(runId: string): Promise<{ ok: boolean; error?: string; report?: RecoveryReport }> {
    const report = await this.inspect(runId);
    if (report.status === 'run_missing') return { ok: false, error: '任务不存在' };
    report.status = 'accepted';
    report.acceptedAt = new Date().toISOString();
    await this.persist(report);
    this.emitEvent(runId, 'recovery_accepted', { acceptedAt: report.acceptedAt, conflicts: report.counts.conflict });
    return { ok: true, report };
  }

  // ---------------------------------------------------------------- 持久化 / 查询

  async list(): Promise<RecoveryReport[]> {
    const dir = join(this.opts.dataDir, 'recovery');
    if (!existsSync(dir)) return [];
    let names: string[] = [];
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const out: RecoveryReport[] = [];
    for (const n of names) {
      try {
        out.push(JSON.parse(await readFile(join(dir, n), 'utf8')) as RecoveryReport);
      } catch {
        /* 坏报告跳过，不让一个文件影响列表 */
      }
    }
    return out.sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
  }

  private async persist(report: RecoveryReport): Promise<void> {
    await writeFileAtomic(
      join(this.opts.dataDir, 'recovery', `${report.runId}.json`),
      JSON.stringify(report, null, 2),
    );
  }

  private async readPersisted(runId: string): Promise<RecoveryReport | null> {
    try {
      return JSON.parse(await readFile(join(this.opts.dataDir, 'recovery', `${runId}.json`), 'utf8')) as RecoveryReport;
    } catch {
      return null;
    }
  }

  private async applyPersistedMeta(report: RecoveryReport, keepMetaFrom?: RecoveryReport): Promise<RecoveryReport> {
    const prev = keepMetaFrom ?? (await this.readPersisted(report.runId));
    if (!prev || prev.journalUpdatedAt !== report.journalUpdatedAt) return report;
    if (prev.acceptedAt && (report.status === 'clean' || report.status === 'pending')) {
      report.status = 'accepted';
      report.acceptedAt = prev.acceptedAt;
    }
    if (prev.rolledBackAt && report.status === 'clean') {
      report.status = 'rolled_back';
      report.rolledBackAt = prev.rolledBackAt;
      report.rolledBack = prev.rolledBack;
    }
    if (prev.autoRestored?.length) report.autoRestored = prev.autoRestored;
    return report;
  }

  private async cleanTmp(repoPath: string, rels: string[]): Promise<void> {
    for (const rel of rels) {
      try {
        const abs = resolve(repoPath, assertRelPath(rel));
        await rm(abs, { force: true });
      } catch {
        /* 临时文件清理失败不影响对账 */
      }
    }
  }

  private repoPathOfRun(runId: string): string {
    const ev = this.opts.store.getEvents(runId).find((e) => e.type === 'run_started');
    const repo = (ev?.data?.inputs as Record<string, unknown> | undefined)?.repoPath;
    return typeof repo === 'string' ? repo : '';
  }

  private emitEvent(runId: string, type: TraceEventType, data: Record<string, unknown>): void {
    this.opts.prepareEvent?.(runId);
    this.opts.emit?.(runId, type, data);
  }
}

// ---------------------------------------------------------------- helpers

function baseReport(runId: string, status: RecoveryStatus, repoPath: string): RecoveryReport {
  return {
    runId,
    status,
    repoPath,
    interrupted: false,
    generatedAt: new Date().toISOString(),
    counts: { applied: 0, not_applied: 0, missing: 0, conflict: 0, unknown: 0, tmpLeftovers: 0, total: 0 },
    files: [],
  };
}

function buildReport(
  runId: string,
  repoPath: string,
  interrupted: boolean,
  rec: { status: string; errorCode?: string },
  journalUpdatedAt: string | undefined,
  files: RecoveryFileReport[],
): RecoveryReport {
  const counts = {
    applied: files.filter((f) => f.observed === 'applied').length,
    not_applied: files.filter((f) => f.observed === 'not_applied').length,
    missing: files.filter((f) => f.observed === 'missing').length,
    conflict: files.filter((f) => f.observed === 'conflict').length,
    unknown: files.filter((f) => f.observed === 'unknown').length,
    tmpLeftovers: files.reduce((n, f) => n + f.tmpLeftovers.length, 0),
    total: files.length,
  };
  return {
    runId,
    status: 'clean',
    repoPath,
    interrupted,
    runStatus: rec.status,
    errorCode: rec.errorCode,
    generatedAt: new Date().toISOString(),
    journalUpdatedAt,
    counts,
    files,
  };
}

function latestEntries(entries: ApplyJournalEntry[]): ApplyJournalEntry[] {
  const m = new Map<string, ApplyJournalEntry>();
  for (const e of entries) m.set(e.relPath, e);
  return [...m.values()];
}

async function readText(abs: string): Promise<string | null> {
  try {
    if (!statSync(abs).isFile()) return null;
    return await readFile(abs, 'utf8');
  } catch {
    return null;
  }
}

async function listTmpLeftovers(repoPath: string, abs: string): Promise<string[]> {
  try {
    const dir = dirname(abs);
    const prefix = `${basename(abs)}.mta-tmp-`;
    const names = (await readdir(dir)).filter((n) => n.startsWith(prefix));
    return names
      .map((n) => relative(repoPath, join(dir, n)).replace(/\\/g, '/'))
      .filter((p) => p && !p.startsWith('..'));
  } catch {
    return [];
  }
}

function listBackupFiles(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isSymbolicLink()) continue;
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...listBackupFiles(join(dir, ent.name), rel));
    else if (ent.isFile() && rel !== 'apply-journal.json' && !rel.includes('.mta-tmp-')) out.push(rel);
  }
  return out;
}
