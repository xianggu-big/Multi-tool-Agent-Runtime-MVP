// src/sandbox/exec.ts — 异步子进程封装（不阻塞 Node 事件循环）
//
// 为什么单独抽出来：沙箱检查阶梯、宿主复验和审批后的宿主命令都可能跑几十秒到几分钟。
// 用 spawnSync 会把整个 HTTP 服务/SSE 流/审批轮询一起冻住；这里统一用 spawn + Promise，
// 保留超时、输出上限、stdin、取消/超时后的 SIGKILL 语义。
import { spawn } from 'node:child_process';

export interface SpawnOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  /** 用户取消：kill 子进程并返回 aborted */
  signal?: AbortSignal;
}

export interface SpawnResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** 可执行文件不存在/不可执行（ENOENT/EACCES） */
  binMissing?: boolean;
  /** 输出超过 maxBuffer，进程已被杀掉 */
  overflowed?: boolean;
  /** 被 AbortSignal 取消 */
  aborted?: boolean;
  error?: string;
  durationMs: number;
}

/**
 * 异步执行一个 argv（不经过 shell）。与 spawnSync 的差异：
 * - 不占住事件循环；
 * - 超时/输出超限时显式 kill，并返回结构化原因；
 * - stdin 通过 `input` 写入，供 `docker exec -i` 使用。
 */
export function spawnAsync(bin: string, args: string[], opts: SpawnOptions = {}): Promise<SpawnResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxBuffer = opts.maxBuffer ?? 16 * 1024 * 1024;
  const started = Date.now();

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, {
        cwd: opts.cwd,
        env: opts.env,
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      resolve({
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: err.message,
        timedOut: false,
        binMissing: err.code === 'ENOENT' || err.code === 'EACCES',
        error: err.message,
        durationMs: Date.now() - started,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let overflowed = false;
    let aborted = false;

    const finish = (exitCode: number | null, error?: NodeJS.ErrnoException): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      const binMissing = !!error && (error.code === 'ENOENT' || error.code === 'EACCES');
      resolve({
        ok: !aborted && !timedOut && !overflowed && !error && exitCode === 0,
        exitCode,
        stdout,
        stderr: stderr || (error ? error.message : ''),
        timedOut,
        ...(binMissing ? { binMissing: true } : {}),
        ...(overflowed ? { overflowed: true } : {}),
        ...(aborted ? { aborted: true } : {}),
        ...(error ? { error: error.message } : {}),
        durationMs: Date.now() - started,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      child.kill('SIGKILL');
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error) => finish(null, error as NodeJS.ErrnoException));
    child.on('close', (code) => finish(code));
    // stdin 关闭时若进程已退出，可能产生 EPIPE；这不是执行失败，忽略。
    child.stdin?.on('error', () => {});
    child.stdout?.on('data', (chunk: Buffer) => {
      if (overflowed) return;
      if (stdout.length + chunk.length > maxBuffer) {
        overflowed = true;
        child.kill('SIGKILL');
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (overflowed) return;
      if (stderr.length + chunk.length > maxBuffer) {
        overflowed = true;
        child.kill('SIGKILL');
        return;
      }
      stderr += chunk.toString('utf8');
    });

    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}