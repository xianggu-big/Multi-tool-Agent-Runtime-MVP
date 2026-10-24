// src/codex/importChanges.ts — 把 Codex 在副本里做的改动，转成现有写管线可消费的 change set
//
// 只做「差异检测 + 文本内容读取」，不做落盘：调用方逐文件 session.stage()，
// 之后仍走 submit_changes（阶梯 → 审批/暂缓 → journal → 落盘 → 宿主复验 → 回滚）。
import { readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { isSnapshotExcluded } from '../sandbox/session.js';

export interface ImportedChange {
  relPath: string;
  op: 'create' | 'edit' | 'delete';
  /** create/edit 的新内容（UTF-8 文本）；delete 为 undefined */
  content?: string;
}

export interface SkippedChange {
  relPath: string;
  reason: 'binary' | 'too_large' | 'unreadable';
}

export interface ScanResult {
  changes: ImportedChange[];
  skipped: SkippedChange[];
}

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;

async function walk(root: string, out: Map<string, string>): Promise<void> {
  const walkDir = async (dir: string) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (isSnapshotExcluded(ent.name)) continue;
      if (ent.isSymbolicLink()) continue;
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        await walkDir(abs);
      } else if (ent.isFile()) {
        out.set(relative(root, abs).split('\\').join('/'), abs);
      }
    }
  };
  await walkDir(root);
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * 比较 copyDir（Codex 工作副本）与 repoPath（真实仓库）的差异。
 * 排除项与沙箱快照一致（node_modules/data/.git/.workbuddy/.zcode/.env*），避免把
 * 「本来就没进副本的文件」误判成删除。
 */
export async function scanCodexChanges(opts: {
  repoPath: string;
  copyDir: string;
  maxFileBytes?: number;
}): Promise<ScanResult> {
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const [repoFiles, copyFiles] = await Promise.all([
    (async () => {
      const m = new Map<string, string>();
      await walk(opts.repoPath, m);
      return m;
    })(),
    (async () => {
      const m = new Map<string, string>();
      await walk(opts.copyDir, m);
      return m;
    })(),
  ]);

  const changes: ImportedChange[] = [];
  const skipped: SkippedChange[] = [];

  for (const [rel, absCopy] of copyFiles) {
    const absRepo = repoFiles.get(rel);
    try {
      const st = await stat(absCopy);
      if (st.size > maxBytes) {
        skipped.push({ relPath: rel, reason: 'too_large' });
        continue;
      }
      const buf = await readFile(absCopy);
      if (looksBinary(buf)) {
        skipped.push({ relPath: rel, reason: 'binary' });
        continue;
      }
      if (!absRepo) {
        changes.push({ relPath: rel, op: 'create', content: buf.toString('utf8') });
        continue;
      }
      const repoBuf = await readFile(absRepo);
      if (sha256(buf) !== sha256(repoBuf)) {
        changes.push({ relPath: rel, op: 'edit', content: buf.toString('utf8') });
      }
    } catch {
      skipped.push({ relPath: rel, reason: 'unreadable' });
    }
  }

  for (const rel of repoFiles.keys()) {
    if (!copyFiles.has(rel)) {
      changes.push({ relPath: rel, op: 'delete' });
    }
  }

  changes.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { changes, skipped };
}