// src/codex/workspace.ts — Codex 的只读工作副本（宿主侧，不需要 Docker）
//
// 为什么不直接让 Codex 读真实仓库：快照会排除 .env* / .git / data / node_modules，
// 避免 Codex 绕过读工具层的敏感文件拒读（与 M1 沙箱同一安全取向）。
// 目录按 workspaceId 稳定：`codex exec resume` 不接受 -C，依赖原会话 cwd。
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { copyRepoSnapshotAsync } from '../sandbox/session.js';

export function codexWorkspaceDir(dataDir: string, workspaceId: string): string {
  return join(resolve(dataDir), 'codex', workspaceId, 'repo');
}

/** 重建只读副本（先清空，避免已删除文件残留）。返回副本绝对路径。 */
export async function prepareCodexWorkspace(opts: {
  repoPath: string;
  dataDir: string;
  workspaceId: string;
}): Promise<string> {
  const dir = codexWorkspaceDir(opts.dataDir, opts.workspaceId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await copyRepoSnapshotAsync(opts.repoPath, dir);
  return dir;
}

export async function removeCodexWorkspace(dataDir: string, workspaceId: string): Promise<void> {
  await rm(join(resolve(dataDir), 'codex', workspaceId), { recursive: true, force: true });
}
