// src/sandbox/applyJournal.ts — 落盘意图日志（崩溃对账的持久化依据）
//
// 为什么需要它：applyToRepo 是「逐文件 rm → rename」，change_applied 却在整批结束后才发。
// 进程若在中间被杀，仓库会处于「部分文件已改、零事件」的状态，单靠事件流无法复原。
// 本日志在**碰任何文件之前**写入意图（baseHash/workHash/op），每个文件落盘后再更新状态；
// 启动时据此与仓库现状对账，才能说清楚「哪些已落盘、哪些该恢复」。
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type JournalOp = 'create' | 'edit' | 'delete';
export type JournalStatus = 'pending' | 'applied' | 'rolled_back' | 'failed';

export interface ApplyJournalEntry {
  relPath: string;
  op: JournalOp;
  /** 落盘前原文哈希；create 无原文 */
  baseHash?: string;
  /** 沙箱新内容哈希；delete 无新内容 */
  workHash?: string;
  status: JournalStatus;
  approvalId: string;
  note?: string;
  updatedAt: string;
}

export interface ApplyJournal {
  version: 1;
  runId: string;
  repoPath: string;
  createdAt: string;
  updatedAt: string;
  entries: ApplyJournalEntry[];
}

export interface JournalFileInput {
  relPath: string;
  op: JournalOp;
  baseHash?: string;
  workHash?: string;
}

export function applyJournalPath(dataDir: string, runId: string): string {
  return join(dataDir, 'backups', runId, 'apply-journal.json');
}

export async function readApplyJournal(dataDir: string, runId: string): Promise<ApplyJournal | null> {
  try {
    const text = await readFile(applyJournalPath(dataDir, runId), 'utf8');
    const parsed = JSON.parse(text) as ApplyJournal;
    if (parsed?.version !== 1 || parsed.runId !== runId || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 在**任何文件落盘之前**登记本批改动。失败必须让调用方中止落盘（fail-closed）：
 * 没有意图日志的写入，在崩溃后无法对账。
 */
export async function beginApplyJournal(
  dataDir: string,
  runId: string,
  repoPath: string,
  approvalId: string,
  files: JournalFileInput[],
): Promise<ApplyJournal> {
  const now = new Date().toISOString();
  const existing = await readApplyJournal(dataDir, runId);
  if (existing && existing.repoPath !== repoPath) {
    throw new Error(`apply journal 仓库不一致：已有 ${existing.repoPath}，本次 ${repoPath}`);
  }
  const journal: ApplyJournal =
    existing ?? { version: 1, runId, repoPath, createdAt: now, updatedAt: now, entries: [] };
  for (const f of files) {
    journal.entries.push({ ...f, approvalId, status: 'pending', updatedAt: now });
  }
  journal.updatedAt = now;
  await writeApplyJournal(dataDir, runId, journal);
  return journal;
}

/** 更新某批某文件的落盘状态；找不到日志时静默跳过（老 run 没有日志）。 */
export async function updateApplyEntry(
  dataDir: string,
  runId: string,
  approvalId: string,
  relPath: string,
  patch: { status?: JournalStatus; note?: string },
): Promise<boolean> {
  const journal = await readApplyJournal(dataDir, runId);
  if (!journal) return false;
  const now = new Date().toISOString();
  for (let i = journal.entries.length - 1; i >= 0; i--) {
    const e = journal.entries[i];
    if (e.approvalId === approvalId && e.relPath === relPath) {
      if (patch.status) e.status = patch.status;
      if (patch.note !== undefined) e.note = patch.note;
      e.updatedAt = now;
      journal.updatedAt = now;
      await writeApplyJournal(dataDir, runId, journal);
      return true;
    }
  }
  return false;
}

export async function writeApplyJournal(dataDir: string, runId: string, journal: ApplyJournal): Promise<void> {
  await writeFileAtomic(applyJournalPath(dataDir, runId), JSON.stringify(journal, null, 2));
}

/**
 * 原子写文本：tmp + rename；Windows 上目标被占用时退避重试，最后才 rm+rename。
 * 恢复仓库文件也复用它（原始备份仍在，失败可重试）。
 */
export async function writeFileAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, text, 'utf8');
  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      await rename(tmp, path);
      return;
    } catch (e) {
      lastErr = e;
      try {
        await rm(path, { force: true });
        await rename(tmp, path);
        return;
      } catch (e2) {
        lastErr = e2;
        await new Promise((r) => setTimeout(r, 80 * (i + 1)));
      }
    }
  }
  await rm(tmp, { force: true });
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
