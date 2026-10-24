// src/codex/runner.ts — 本机 Codex CLI 适配器（exec --json）
//
// 设计要点：
//   1) 只解析 stdout 的 JSONL；stderr 只留尾部做错误摘要（本机实测 stderr 有大量 INFO/插件告警）。
//   2) 提示词走 stdin（命令末尾传 `-`），避免提示词进入 Windows 命令行；参数只含受控值。
//   3) Windows 下 codex 是 .cmd shim：优先解析出包内 codex.js，用当前 node 直接 spawn
//      （cmd.exe 遇到中文路径会报「文件名、目录名或卷标语法不正确」）；解析失败才回退 cmd.exe。
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface CodexUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface CodexCommandItem {
  id: string;
  command: string;
  output?: string;
  exitCode?: number | null;
  status?: string;
}

export type CodexEvent =
  | { type: 'thread'; threadId: string }
  | { type: 'message'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'command_started'; item: CodexCommandItem }
  | { type: 'command_completed'; item: CodexCommandItem }
  | { type: 'usage'; usage: CodexUsage }
  /** item 级 error（例如模型元数据缺失的提示）——不是致命错误，不能把成功的 turn 判失败 */
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string };

export interface CodexRunOptions {
  bin: string;
  model?: string;
  cwd: string;
  prompt: string;
  mode: 'read_only' | 'write';
  resumeThreadId?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  onEvent?: (ev: CodexEvent) => void;
}

export interface CodexRunResult {
  ok: boolean;
  threadId?: string;
  finalAnswer: string;
  messages: string[];
  commands: CodexCommandItem[];
  usage?: CodexUsage;
  warnings: string[];
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  error?: string;
  stderrTail: string;
  durationMs: number;
}

/** 组装 argv（不含 bin；提示词统一用 `-` 从 stdin 读）。 */
export function buildCodexArgs(opts: Pick<CodexRunOptions, 'mode' | 'cwd' | 'model' | 'resumeThreadId'>): string[] {
  const args = opts.resumeThreadId
    ? ['exec', 'resume', opts.resumeThreadId, '--json', '--skip-git-repo-check']
    : [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--sandbox',
        opts.mode === 'write' ? 'workspace-write' : 'read-only',
        '-C',
        opts.cwd,
      ];
  if (opts.model) args.push('-m', opts.model);
  args.push('-');
  return args;
}

/** 解析一行 JSONL；非 JSON/未知类型返回 null（向前兼容 CLI 新事件）。 */
export function parseCodexLine(line: string): CodexEvent | null {
  const text = line.trim();
  if (!text) return null;
  let obj: any;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const type = String(obj.type ?? '');
  if (type === 'thread.started' && typeof obj.thread_id === 'string') {
    return { type: 'thread', threadId: obj.thread_id };
  }
  if (type === 'item.started' || type === 'item.completed') {
    const item = obj.item ?? {};
    const t = String(item.type ?? '');
    const id = String(item.id ?? '');
    if (t === 'agent_message' && typeof item.text === 'string') {
      return { type: 'message', text: item.text };
    }
    if (t === 'reasoning') {
      const text = typeof item.text === 'string' ? item.text : '';
      if (text) return { type: 'reasoning', text };
    }
    if (t === 'command_execution') {
      const command = typeof item.command === 'string' ? item.command : '';
      if (type === 'item.started') {
        return { type: 'command_started', item: { id, command } };
      }
      return {
        type: 'command_completed',
        item: {
          id,
          command,
          output: typeof item.aggregated_output === 'string' ? item.aggregated_output : '',
          exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
          status: typeof item.status === 'string' ? item.status : undefined,
        },
      };
    }
    if (t === 'error' && typeof item.message === 'string') {
      // item 级 error：CLI 用它报告「模型元数据缺失」这类非致命提示；turn 仍可能成功
      return { type: 'warning', message: item.message };
    }
    return null;
  }
  if (type === 'turn.completed' && obj.usage && typeof obj.usage === 'object') {
    const u = obj.usage;
    return {
      type: 'usage',
      usage: {
        inputTokens: Number(u.input_tokens ?? 0) || 0,
        cachedInputTokens: Number(u.cached_input_tokens ?? 0) || 0,
        outputTokens: Number(u.output_tokens ?? 0) || 0,
        reasoningOutputTokens: Number(u.reasoning_output_tokens ?? 0) || 0,
      },
    };
  }
  if (type === 'error' || type === 'turn.failed') {
    const msg =
      typeof obj.message === 'string'
        ? obj.message
        : typeof obj.error?.message === 'string'
          ? obj.error.message
          : '';
    return msg ? { type: 'error', message: msg } : null;
  }
  return null;
}

/** Windows 下给 cmd.exe 的每个参数加引号（只用于受控参数，不含用户原文）。 */
function quoteWinArg(s: string): string {
  return `"${s.replace(/"/g, '')}"`;
}

/** Windows 下把 `codex` / `codex.cmd` 解析成真实路径（优先 .cmd/.exe）。 */
function resolveBinPath(bin: string): string {
  if (process.platform !== 'win32') return bin;
  if (/[\\/]/.test(bin) || /\.(exe|cmd|bat|ps1)$/i.test(bin)) return bin;
  try {
    const out = execFileSync('where.exe', [bin], { encoding: 'utf8' });
    const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return lines.find((l) => /\.cmd$/i.test(l)) ?? lines.find((l) => /\.exe$/i.test(l)) ?? lines[0] ?? bin;
  } catch {
    return bin;
  }
}

/**
 * `.cmd` shim → 直接 spawn node + 包内 codex.js。
 * 为什么不用 cmd.exe：参数里有中文路径时 cmd 的代码页/引号解析会报
 * 「文件名、目录名或卷标语法不正确」，实测导致 Codex 直接退出 1。
 */
function resolveNodeEntry(bin: string): { file: string; prefix: string[] } | null {
  if (process.platform !== 'win32' || !/\.cmd$/i.test(bin)) return null;
  try {
    const text = readFileSync(bin, 'utf8');
    const m = /"%dp0%[\\/]([^"\r\n]*codex\.js)"/i.exec(text);
    if (!m) return null;
    return { file: process.execPath, prefix: [join(dirname(bin), m[1])] };
  } catch {
    return null;
  }
}

function spawnCodexProcess(bin: string, args: string[]): ChildProcess {
  const resolved = resolveBinPath(bin);
  const entry = resolveNodeEntry(resolved);
  if (entry) {
    return spawn(entry.file, [...entry.prefix, ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  if (process.platform === 'win32' && !/\.exe$/i.test(resolved)) {
    const cmd = [quoteWinArg(resolved), ...args.map(quoteWinArg)].join(' ');
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', cmd], {
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  return spawn(resolved, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* ignore */
  }
}

/** 执行一次 Codex（新会话或 resume）。流式回调事件，最终返回结构化结果。 */
export function runCodex(opts: CodexRunOptions): Promise<CodexRunResult> {
  const started = Date.now();
  const args = buildCodexArgs(opts);
  const messages: string[] = [];
  const commands: CodexCommandItem[] = [];
  const warnings: string[] = [];
  let finalAnswer = '';
  let threadId: string | undefined;
  let usage: CodexUsage | undefined;
  let error: string | undefined;
  let stderr = '';
  let stdoutBytes = 0;
  let timedOut = false;
  let aborted = false;
  let overflowed = false;

  return new Promise<CodexRunResult>((resolvePromise) => {
    let child: ChildProcess;
    try {
      child = spawnCodexProcess(opts.bin, args);
    } catch (e) {
      resolvePromise({
        ok: false,
        finalAnswer: '',
        messages,
        commands,
        warnings,
        exitCode: null,
        timedOut: false,
        aborted: false,
        error: `无法启动 Codex（${opts.bin}）：${(e as Error).message}`,
        stderrTail: '',
        durationMs: Date.now() - started,
      });
      return;
    }

    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      const ok = !timedOut && !aborted && !overflowed && !error && exitCode === 0;
      resolvePromise({
        ok,
        threadId,
        finalAnswer,
        messages,
        commands,
        usage,
        warnings,
        exitCode,
        timedOut,
        aborted,
        error:
          error ??
          (overflowed
            ? `Codex 输出超过上限（${opts.maxOutputBytes} 字节），已终止`
            : timedOut
              ? `Codex 执行超时（>${opts.timeoutMs}ms）`
              : aborted
                ? '任务已取消'
                : exitCode !== 0
                  ? `Codex 退出码 ${exitCode ?? '?'}：${stderr.trim().slice(-2000)}`
                  : undefined),
        stderrTail: stderr.slice(-4000),
        durationMs: Date.now() - started,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, Math.max(1000, opts.timeoutMs));
    timer.unref?.();

    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    let buf = '';
    const handleLine = (line: string) => {
      const ev = parseCodexLine(line);
      if (!ev) return;
      switch (ev.type) {
        case 'thread':
          threadId = ev.threadId;
          break;
        case 'message':
          messages.push(ev.text);
          finalAnswer = ev.text;
          break;
        case 'command_started':
          commands.push(ev.item);
          break;
        case 'command_completed': {
          const idx = commands.findIndex((c) => c.id === ev.item.id);
          if (idx >= 0) commands[idx] = ev.item;
          else commands.push(ev.item);
          break;
        }
        case 'usage':
          usage = ev.usage;
          break;
        case 'warning':
          warnings.push(ev.message);
          break;
        case 'error':
          error = error ?? ev.message;
          break;
        case 'reasoning':
          break;
      }
      try {
        opts.onEvent?.(ev);
      } catch {
        /* 回调失败不影响主流程 */
      }
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > opts.maxOutputBytes) {
        overflowed = true;
        killTree(child);
        return;
      }
      buf += chunk;
      let idx = buf.indexOf('\n');
      while (idx >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        handleLine(line);
        idx = buf.indexOf('\n');
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
    });
    child.on('error', (e) => {
      error = error ?? `Codex 进程错误：${e.message}`;
      finish(null);
    });
    child.on('close', (code) => {
      if (buf.trim()) handleLine(buf);
      finish(code);
    });
    // 子进程可能提前退出（不读 stdin）→ 避免 EPIPE 变成未捕获异常
    child.stdin?.on('error', () => {});
    try {
      child.stdin?.write(opts.prompt);
      child.stdin?.end();
    } catch {
      /* 进程可能已退出 */
    }
  });
}
