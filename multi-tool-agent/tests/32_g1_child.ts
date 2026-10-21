// tests/32_g1_child.ts — 32g1 的子进程 PoC 载体（不是测试文件，勿匹配 *.test.ts）
//
// 用途：证明「AgentRuntime.resume() 返回的 rejected promise 无人捕获」在真实进程里的后果。
// 用法（由 tests/32_adversarial.test.ts 的 32g1  spawn）：
//   node --import tsx tests/32_g1_child.ts
// 预期现状：执行循环内部抛错 → resume() 的 rejection 无人处理 →
//           Node 默认 --unhandled-rejections=throw → 进程以非零码崩溃，stderr 有 BOOM 栈。
// 修复后（resume 内部显式 .catch，与 enqueue 一致）：进程正常退出（码 0），无崩溃。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { AgentRuntime } from '../src/runtime/AgentRuntime.js';
import { SqliteStore } from '../src/store/SqliteStore.js';
import { EventLogger } from '../src/trace/EventLogger.js';
import { Tracer } from '../src/trace/Tracer.js';
import { ErrorReporter } from '../src/runtime/errorReporter.js';
import { buildRegistry } from '../src/tools/index.js';
import type { RunRecord } from '../src/types.js';

const dbPath = join(mkdtempSync(join(tmpdir(), 'mta-g1-')), 'runtime.db');
const store = new SqliteStore(dbPath);
const logger = new EventLogger({ maxContentChars: 1000, console: false });
const tracer = new Tracer(logger);
const errors = new ErrorReporter({ logPath: join(dbPath, '..', 'errors.log') });
const config = loadConfig();
config.sqlitePath = dbPath;
config.llmMode = 'mock';
const registry = buildRegistry();

const now = new Date().toISOString();
const rec: RunRecord = {
  runId: 'run_g1_child',
  runType: 'misc',
  status: 'failed', // RESUMABLE
  goal: 'resume rejection PoC',
  createdAt: now,
  updatedAt: now,
  steps: 1,
  modelCalls: 0,
  toolCalls: 0,
  totalDurationMs: 0,
  usageJson: '{}',
  isMock: 1,
};
store.createRun(rec);
store.saveCheckpoint({
  runId: rec.runId,
  step: 1,
  status: 'failed',
  messages: [{ role: 'system', content: 'SYS' }],
  modelCalls: 0,
  toolCalls: 0,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, isEstimate: true },
  createdAt: now,
});

// 包装 store：executeLoopFrom 里的那次 updateRun（带 isMock 字段）抛错，
// 模拟「恢复后的执行循环内部失败」——正是 server.ts /resume 端点 void result 不接 catch 的路径。
const wrapped = Object.create(store) as SqliteStore;
wrapped.updateRun = ((patch: { isMock?: number }) => {
  if ('isMock' in patch) throw new Error('BOOM_resume_rejection');
  return store.updateRun(patch as any);
}) as SqliteStore['updateRun'];

const runtime = new AgentRuntime(config, registry, wrapped, tracer, errors);

// 与 server.ts 的 /api/runs/:id/resume 完全一致：拿到 promise 后不接 catch
const result = runtime.resume(rec.runId);
void result;

// 保持事件循环，让 rejection 有机会被（不）处理
setTimeout(() => {
  logger.flush();
  store.close();
  rmSync(dbPath, { force: true });
  rmSync(join(dbPath, '..'), { recursive: true, force: true });
  console.log('[g1-child] 进程正常退出（resume 的 rejection 已被内部消化）');
  process.exit(0);
}, 1500);
