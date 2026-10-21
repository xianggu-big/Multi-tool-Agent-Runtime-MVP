// src/sandbox/docker.ts — 沙箱专用 Docker CLI 薄封装（M1 Step2）
//
// 约定（对照评审）：
//   - 全部经 argv 数组 + shell:false 调 docker（宿主侧不做 shell 拼接，避免注入）；
//   - 统一超时与 maxBuffer；超时明确标记（timedOut）；
//   - 容器命名 mta-sb-<runIdHash>，便于「启动孤儿回收」（评审 P1-4：run 终态/重启时清理）；
//   - 一切"不可用"状态返回 ok:false/reason，由上层 fail-closed（不静默降级为非沙箱执行）。
import { spawnSync } from 'node:child_process';
import { spawnAsync } from './exec.js';
import { createHash } from 'node:crypto';

const DOCKER_BIN = process.env.SANDBOX_DOCKER_BIN ?? 'docker';

export interface ExecResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** docker 二进制本身不可用（未安装/未在 PATH） */
  binMissing?: boolean;
  /** 被 AbortSignal 取消 */
  aborted?: boolean;
}

export function dockerExec(args: string[], opts: { timeoutMs?: number; input?: string } = {}): ExecResult {
  const r = spawnSync(DOCKER_BIN, args, {
    timeout: opts.timeoutMs ?? 120_000,
    encoding: 'utf8',
    input: opts.input,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  const err = r.error as NodeJS.ErrnoException | undefined;
  const binMissing = !!err && (err.code === 'ENOENT' || err.code === 'EACCES');
  const timedOut = !!err && err.code === 'ETIMEDOUT';
  return {
    ok: !r.error && r.status === 0,
    exitCode: r.status,
    stdout: r.stdout ?? '',
    stderr: (r.stderr ?? '') || (err ? err.message : ''),
    timedOut,
    binMissing,
  };
}

/** 守护进程是否可用（写能力 fail-closed 的第一道门） */
export function dockerAvailable(timeoutMs = 20_000): boolean {
  const r = dockerExec(['info', '--format', '{{.ServerVersion}}'], { timeoutMs });
  return r.ok;
}

export function containerName(runId: string): string {
  const h = createHash('sha1').update(runId).digest('hex').slice(0, 10);
  return `mta-sb-${h}`;
}

export function runDetached(image: string, name: string, timeoutMs = 120_000): ExecResult {
  // --rm：退出即清理；sleep infinity 常驻（由 SandboxSession 用 docker exec 驱动）
  return dockerExec(['run', '-d', '--name', name, '--rm', image, 'sleep', 'infinity'], { timeoutMs });
}

export function cpIn(name: string, hostDir: string, containerPath: string, timeoutMs = 120_000): ExecResult {
  // 目录内容合并拷贝（不删除容器内已有文件 → 镜像里烧好的 node_modules 会保留，评审 P0-1）
  return dockerExec(['cp', `${hostDir}${process.platform === 'win32' ? '\\\\.' : '/.'}`, `${name}:${containerPath}`], {
    timeoutMs,
  });
}

export function execIn(
  name: string,
  cmd: string[],
  opts: { timeoutMs?: number; input?: string; workdir?: string; asRoot?: boolean; signal?: AbortSignal } = {},
): ExecResult {
  const args = ['exec'];
  // asRoot：容器默认以 node 用户运行（评审 P2-d）；chown 等需要 root 的操作显式提权，
  // 只用于"把 /work 交回 node"这种一次性授权动作。
  if (opts.asRoot) args.push('-u', 'root');
  if (opts.workdir) args.push('-w', opts.workdir);
  if (opts.input !== undefined) args.push('-i');
  args.push(name, ...cmd);
  return dockerExec(args, { timeoutMs: opts.timeoutMs ?? 120_000, input: opts.input });
}

/** 容器内写文件（内容走 stdin，路径由调用方校验 + 单引号包裹防注入） */
export function writeInContainer(name: string, absPath: string, content: string, timeoutMs = 60_000): ExecResult {
  const q = `'${absPath.replace(/'/g, `'\\''`)}'`;
  return dockerExec(['exec', '-i', name, 'bash', '-c', `mkdir -p "$(dirname ${q})" && cat > ${q}`], {
    timeoutMs,
    input: content,
  });
}

export function rmContainer(name: string, timeoutMs = 60_000): ExecResult {
  return dockerExec(['rm', '-f', name], { timeoutMs });
}

/** 列出本项目的沙箱容器（孤儿回收用） */
export function listSandboxContainers(): string[] {
  const r = dockerExec(['ps', '-a', '--filter', 'name=mta-sb-', '--format', '{{.Names}}'], { timeoutMs: 30_000 });
  if (!r.ok) return [];
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('mta-sb-'));
}

/** 启动期孤儿回收：所有 mta-sb-* 容器都属于"上一次进程"（沙箱会话不跨进程），可全部清理 */
export function removeOrphanSandboxContainers(): number {
  const names = listSandboxContainers();
  let n = 0;
  for (const name of names) {
    if (rmContainer(name).ok) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// 异步版本：长任务（docker cp / 检查阶梯 / 测试）必须走这里，避免冻结事件循环。
// 同步版本保留给启动探测和测试中的短探针。
// ---------------------------------------------------------------------------
export function dockerExecAsync(args: string[], opts: { timeoutMs?: number; input?: string; maxBuffer?: number; signal?: AbortSignal } = {}): Promise<ExecResult> {
  return spawnAsync(DOCKER_BIN, args, {
    timeoutMs: opts.timeoutMs ?? 120_000,
    input: opts.input,
    maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
    signal: opts.signal,
  });
}

export async function dockerAvailableAsync(timeoutMs = 20_000): Promise<boolean> {
  const r = await dockerExecAsync(['info', '--format', '{{.ServerVersion}}'], { timeoutMs });
  return r.ok;
}

export function runDetachedAsync(image: string, name: string, timeoutMs = 120_000): Promise<ExecResult> {
  return dockerExecAsync(['run', '-d', '--name', name, '--rm', image, 'sleep', 'infinity'], { timeoutMs });
}

export function cpInAsync(name: string, hostDir: string, containerPath: string, timeoutMs = 120_000): Promise<ExecResult> {
  return dockerExecAsync(['cp', `${hostDir}${process.platform === 'win32' ? '\\\\.' : '/.'}`, `${name}:${containerPath}`], { timeoutMs });
}

export function execInAsync(
  name: string,
  cmd: string[],
  opts: { timeoutMs?: number; input?: string; workdir?: string; asRoot?: boolean; signal?: AbortSignal } = {},
): Promise<ExecResult> {
  const args = ['exec'];
  if (opts.asRoot) args.push('-u', 'root');
  if (opts.workdir) args.push('-w', opts.workdir);
  if (opts.input !== undefined) args.push('-i');
  args.push(name, ...cmd);
  return dockerExecAsync(args, { timeoutMs: opts.timeoutMs ?? 120_000, input: opts.input, signal: opts.signal });
}

export function writeInContainerAsync(
  name: string,
  absPath: string,
  content: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ExecResult> {
  const q = `'${absPath.replace(/'/g, `'\\''`)}'`;
  return dockerExecAsync(['exec', '-i', name, 'bash', '-c', `mkdir -p "$(dirname ${q})" && cat > ${q}`], {
    timeoutMs: opts.timeoutMs ?? 60_000,
    input: content,
    signal: opts.signal,
  });
}

export function rmContainerAsync(name: string, timeoutMs = 60_000): Promise<ExecResult> {
  return dockerExecAsync(['rm', '-f', name], { timeoutMs });
}
