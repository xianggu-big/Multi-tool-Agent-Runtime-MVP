// 安全边界：仅允许执行白名单内的测试命令；不通过 shell 执行，禁止任意命令注入；
//           限制运行时长、输出长度；明确记录命令/退出码/摘要/耗时。
// 风险：medium（有副作用）。默认不在仓库外启用，仅在隔离/专用测试仓库运行。

import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { Tool, ToolContext } from '../types.js';
import type { ToolResult } from '../../types.js';
import { okResult, errResult } from '../types.js';

const inputSchema = z.object({
  command: z.string().min(1).describe('测试命令，必须位于服务端白名单内（如 "node --test"）'),
});

const MAX_OUTPUT = 8000;
const DEFAULT_TIMEOUT = 20000;

function resolveExe(command: string): { exe: string; args: string[] } {
  const parts = command.trim().split(/\s+/);
  let exe = parts[0];
  const args = parts.slice(1);
  // Windows 上 npm/npx 为 .cmd，需经 node 执行以避免使用 shell
  if ((exe === 'npm' || exe === 'npx') && process.env.npm_execpath) {
    return { exe: process.execPath, args: [process.env.npm_execpath, ...args] };
  }
  return { exe, args };
}

/**
 * 校验 `node --test` 后面的附加参数是否是一个合法的「仓库内相对测试路径」。
 * 只允许相对路径（禁止绝对路径、盘符、`..`），且路径必须指向测试文件或测试目录。
 */
function isSafeNodeTestArg(rest: string): boolean {
  const arg = rest.trim();
  if (!arg) return true;
  const tokens = arg.split(/\s+/);
  if (tokens.length !== 1) return false;
  const raw = tokens[0];
  if (raw.startsWith('/') || raw.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(raw)) return false;
  const lower = raw.replace(/\\/g, '/');
  if (lower.split('/').includes('..')) return false;
  if (lower.endsWith('/')) return true;
  const segs = lower.split('/');
  if (segs.some((s) => ['test', 'tests', '__tests__', 'spec', 'specs'].includes(s))) return true;
  const base = segs[segs.length - 1];
  return /\.(test|spec)\b/.test(base) || /(test|spec)\.[^./]+$/.test(base);
}

type Verdict = { ok: true } | { ok: false; reason: string };

/**
 * 白名单判定：命令本身需精确匹配或符合参数模板。
 * - 精确相等：允许。
 * - `node --test` + 仓库内相对测试路径：允许（经 isSafeNodeTestArg 严格校验）。
 * - 其他命令一律禁止追加参数，避免前缀匹配逃逸。
 */
function verdictFor(command: string, allowed: string[]): Verdict {
  const trimmed = command.trim();
  if (allowed.includes(trimmed)) return { ok: true };
  for (const a of allowed) {
    const prefix = a + ' ';
    if (!trimmed.startsWith(prefix)) continue;
    if (a === 'node --test') {
      const rest = trimmed.slice(prefix.length);
      if (isSafeNodeTestArg(rest)) return { ok: true };
      return { ok: false, reason: `node --test 的附加参数不是合法的仓库内测试路径：${rest.trim()}` };
    }
    return { ok: false, reason: `命令 "${a}" 不允许追加参数` };
  }
  return { ok: false, reason: `命令不在白名单：${trimmed}` };
}

export const runTests: Tool = {
  name: 'run_tests',
  description: '运行白名单内的测试命令（绝不允许任意 Shell 命令）。记录命令、退出码、标准输出/错误摘要与耗时。仅应在隔离环境启用。',
  inputSchema,
  timeoutMs: DEFAULT_TIMEOUT + 2000,
  permission: 'codebase:test',
  riskLevel: 'medium',
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult> | ToolResult {
    const started = Date.now();
    if (!ctx.config.codebase.runTestsEnabled) {
      return errResult(
        'DISABLED',
        'run_tests 未启用：CODEBASE_RUN_TESTS_ENABLED=false。仅在隔离/专用测试仓库启用。',
        Date.now() - started,
      );
    }
    const allowed = ctx.config.codebase.allowedTestCommands;
    const args = input as z.infer<typeof inputSchema>;
    const verdict = verdictFor(args.command, allowed);
    if (!verdict.ok) {
      return errResult('FORBIDDEN', verdict.reason, Date.now() - started);
    }

    const { exe, args: cmdArgs } = resolveExe(args.command);
    const stdout: string[] = [];
    const stderr: string[] = [];
    let timedOut = false;

    return new Promise<ToolResult>((resolve) => {
      let child;
      try {
        child = spawn(exe, cmdArgs, {
          cwd: ctx.repoPath,
          shell: false,
          windowsHide: true,
          env: { ...process.env, CI: '1' },
        });
      } catch (e) {
        resolve(errResult('SPAWN_ERROR', `无法启动命令: ${(e as Error).message}`, Date.now() - started));
        return;
      }

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }, DEFAULT_TIMEOUT);

      const finish = (exitCode: number | null) => {
        clearTimeout(timer);
        const outText = stdout.join('').slice(-MAX_OUTPUT);
        const errText = stderr.join('').slice(-MAX_OUTPUT);
        const truncated = outText.length >= MAX_OUTPUT || errText.length >= MAX_OUTPUT;
        resolve(
          okResult(
            {
              command: args.command,
              exitCode,
              timedOut,
              stdout: outText,
              stderr: errText,
              durationMs: Date.now() - started,
              truncated,
            },
            Date.now() - started,
            truncated,
          ),
        );
      };

      child.stdout?.on('data', (d: Buffer) => stdout.push(d.toString('utf8')));
      child.stderr?.on('data', (d: Buffer) => stderr.push(d.toString('utf8')));
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve(errResult('SPAWN_ERROR', `执行错误: ${(e as Error).message}`, Date.now() - started));
      });
      child.on('close', (code) => finish(code));
    });
  },
};