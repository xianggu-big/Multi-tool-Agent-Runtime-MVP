// src/runtime/PendingActionService.ts — 无人值守高危操作的「事后确认」执行器
//
// 定时任务在无人值守时会跳过删除/宿主命令，落进 pending_actions；
// 用户事后在界面点「执行」后才真正生效（必须显式 confirm）。
// 安全约束：
//   - 删除执行前复核 baseHash（文件在任务结束后被改过 → 拒绝，要求重跑）；
//   - 命令只允许在 repoPath 内执行，沿用写工具的 shell 语义与超时；
//   - 任何执行都会写回原 run 的事件流与审计（便于复盘）。
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { assertRelPath } from '../sandbox/session.js';
import { shortSha256 } from '../sandbox/hash.js';
import { spawnAsync } from '../sandbox/exec.js';
import type { RuntimeConfig } from '../config.js';
import type { SqliteStore } from '../store/SqliteStore.js';
import type { PendingActionRecord } from '../scheduler/types.js';

const MAX_CMD_OUTPUT = 16 * 1024;

export interface PendingActionResult {
  ok: boolean;
  status: 'executed' | 'failed';
  message: string;
  detail?: Record<string, unknown>;
}

export interface McpPendingCall {
  server: string;
  tool: string;
  args: Record<string, unknown>;
}

export type McpPendingExecutor = (
  call: McpPendingCall,
) => Promise<{ ok: boolean; message: string; detail?: Record<string, unknown> }>;

export class PendingActionService {
  private mcpExecutor?: McpPendingExecutor;

  constructor(
    private readonly store: SqliteStore,
    private readonly config: RuntimeConfig,
    private readonly emit: (runId: string, type: 'pending_action_decided', data: Record<string, unknown>) => void,
    /** 终态 run 追加事件前的序号校准（避免与历史 seq 冲突） */
    private readonly prepareEvent?: (runId: string) => void,
  ) {}

  list(opts: { status?: 'pending' | 'executed' | 'dismissed' | 'failed'; runId?: string; scheduleId?: string; limit?: number } = {}) {
    return this.store.listPendingActions(opts);
  }

  get(id: string): PendingActionRecord | null {
    return this.store.getPendingAction(id);
  }

  /** 由 createApp 在 MCP runtime 建好后注入（两者构造顺序不同，避免循环依赖）。 */
  setMcpExecutor(executor: McpPendingExecutor): void {
    this.mcpExecutor = executor;
  }

  dismiss(id: string): { ok: boolean; error?: string } {
    const rec = this.store.getPendingAction(id);
    if (!rec) return { ok: false, error: '待确认操作不存在' };
    if (rec.status !== 'pending') return { ok: false, error: `该操作已是 ${rec.status}，不能重复处理` };
    this.store.updatePendingAction(id, { status: 'dismissed', decidedAt: new Date().toISOString() });
    this.emitDecided(rec, 'dismissed', { message: '用户忽略' });
    return { ok: true };
  }

  async execute(id: string, opts: { confirm: boolean }): Promise<PendingActionResult> {
    if (!opts?.confirm) {
      return { ok: false, status: 'failed', message: '必须显式带 confirm:true 才能执行高危操作' };
    }
    const rec = this.store.getPendingAction(id);
    if (!rec) return { ok: false, status: 'failed', message: '待确认操作不存在' };
    if (rec.status !== 'pending') return { ok: false, status: 'failed', message: `该操作已是 ${rec.status}，不能重复处理` };

    const result =
      rec.kind === 'delete'
        ? await this.executeDelete(rec)
        : rec.kind === 'command'
          ? await this.executeCommand(rec)
          : rec.kind === 'mcp'
            ? await this.executeMcp(rec)
            : { ok: false, status: 'failed' as const, message: `未知待确认操作类型：${(rec as PendingActionRecord).kind}` };
    this.store.updatePendingAction(id, {
      status: result.status,
      decidedAt: new Date().toISOString(),
      result: result.detail,
    });
    this.emitDecided(rec, result.status, { ...result.detail, message: result.message });
    return result;
  }

  private emitDecided(rec: PendingActionRecord, status: string, detail: Record<string, unknown>): void {
    this.prepareEvent?.(rec.runId);
    this.emit(rec.runId, 'pending_action_decided', {
      actionId: rec.id,
      kind: rec.kind,
      status,
      relPath: typeof rec.payload.relPath === 'string' ? rec.payload.relPath : undefined,
      command: typeof rec.payload.command === 'string' ? rec.payload.command.slice(0, 500) : undefined,
      server: typeof rec.payload.server === 'string' ? rec.payload.server : undefined,
      tool: typeof rec.payload.tool === 'string' ? rec.payload.tool : undefined,
      ...detail,
    });
  }

  private dataDir(): string {
    const p = this.config.sqlitePath;
    return p && p !== ':memory:' ? dirname(resolve(p)) : resolve('./data');
  }

  private async executeDelete(rec: PendingActionRecord): Promise<PendingActionResult> {
    const repoPath = typeof rec.payload.repoPath === 'string' ? rec.payload.repoPath : '';
    const relPath = typeof rec.payload.relPath === 'string' ? rec.payload.relPath : '';
    if (!repoPath || !relPath) return { ok: false, status: 'failed', message: '删除操作缺少 repoPath/relPath' };
    const abs = resolve(repoPath, assertRelPath(relPath));
    if (!existsSync(abs)) {
      return { ok: false, status: 'failed', message: `文件已不存在：${relPath}` };
    }
    let current: string;
    try {
      current = readFileSync(abs, 'utf8');
    } catch (e) {
      return { ok: false, status: 'failed', message: `读取失败：${(e as Error).message}` };
    }
    const baseHash = typeof rec.payload.baseHash === 'string' ? rec.payload.baseHash : undefined;
    if (baseHash && shortSha256(current) !== baseHash) {
      return {
        ok: false,
        status: 'failed',
        message: `STALE_ACTION：${relPath} 在任务结束后被改动过（哈希不一致），请重新运行任务再决定。`,
        detail: { code: 'STALE_ACTION', relPath },
      };
    }
    // 备份原文（与沙箱落盘同一备份目录约定）
    const bak = join(this.dataDir(), 'backups', rec.runId, relPath);
    try {
      await mkdir(dirname(bak), { recursive: true });
      await writeFile(bak, current, 'utf8');
      await rm(abs, { force: true });
    } catch (e) {
      return { ok: false, status: 'failed', message: `删除失败：${(e as Error).message}`, detail: { relPath } };
    }
    return {
      ok: true,
      status: 'executed',
      message: `已删除 ${relPath}（备份在 ${bak}）`,
      detail: { relPath, backupPath: bak },
    };
  }

  private async executeCommand(rec: PendingActionRecord): Promise<PendingActionResult> {
    const repoPath = typeof rec.payload.repoPath === 'string' ? rec.payload.repoPath : '';
    const command = typeof rec.payload.command === 'string' ? rec.payload.command : '';
    const shell = rec.payload.shell === 'powershell' || rec.payload.shell === 'cmd' ? rec.payload.shell : 'bash';
    const cwdRel = typeof rec.payload.cwdRel === 'string' ? rec.payload.cwdRel : '.';
    if (!repoPath || !command) return { ok: false, status: 'failed', message: '命令操作缺少 repoPath/command' };
    const cwd = resolve(repoPath, cwdRel);
    if (!cwd.startsWith(resolve(repoPath))) {
      return { ok: false, status: 'failed', message: `cwd 越界：${cwdRel}` };
    }
    const bin = shell === 'bash' ? 'bash' : shell === 'powershell' ? 'powershell.exe' : 'cmd.exe';
    const args =
      shell === 'bash' ? ['-lc', command] : shell === 'powershell' ? ['-NoProfile', '-Command', command] : ['/d', '/s', '/c', command];
    const r = await spawnAsync(bin, args, {
      cwd,
      timeoutMs: Math.min(this.config.sandbox.execTimeoutMs, 600_000),
      maxBuffer: 4 * 1024 * 1024,
    });
    const raw = `${r.stdout}${r.stderr}${r.error ? `\n(进程错误: ${r.error})` : ''}`.trim();
    const output = raw.length > MAX_CMD_OUTPUT ? raw.slice(-MAX_CMD_OUTPUT) : raw;
    return {
      ok: r.ok,
      status: r.ok ? 'executed' : 'failed',
      message: r.ok ? `命令执行完成（exit=${r.exitCode ?? '?'}）` : `命令执行失败（exit=${r.exitCode ?? '?'}）`,
      detail: { command, shell, cwd, exitCode: r.exitCode, output, timedOut: r.timedOut },
    };
  }

  private async executeMcp(rec: PendingActionRecord): Promise<PendingActionResult> {
    const server = typeof rec.payload.server === 'string' ? rec.payload.server : '';
    const tool = typeof rec.payload.tool === 'string' ? rec.payload.tool : '';
    const args = rec.payload.args;
    if (!server || !tool) {
      return { ok: false, status: 'failed', message: 'MCP 待确认操作缺少 server/tool' };
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return { ok: false, status: 'failed', message: 'MCP 待确认操作的 args 必须是对象' };
    }
    if (!this.mcpExecutor) {
      return { ok: false, status: 'failed', message: 'MCP executor 未注入（服务尚未完成 MCP 初始化）' };
    }
    try {
      const r = await this.mcpExecutor({ server, tool, args: args as Record<string, unknown> });
      return {
        ok: r.ok,
        status: r.ok ? 'executed' : 'failed',
        message: r.message,
        detail: { server, tool, ...r.detail },
      };
    } catch (e) {
      return {
        ok: false,
        status: 'failed',
        message: `MCP 待确认操作执行失败：${(e as Error).message}`,
        detail: { server, tool },
      };
    }
  }
}
