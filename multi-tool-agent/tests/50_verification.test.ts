// tests/50_verification.test.ts — 手动 L2 深度验证：异步任务 / 状态机 / 取消 / 事件序号
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { VerificationService } from '../src/runtime/VerificationService.js';
import { EventLogger } from '../src/trace/EventLogger.js';
import { SqliteStore } from '../src/store/SqliteStore.js';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mta-verify-'));
  mkdirSync(join(dir, 'tests'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

async function waitStatus(svc: VerificationService, runId: string, want: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const j = svc.get(runId);
    if (j?.status === want) return;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`等待验证状态 ${want} 超时（当前：${svc.get(runId)?.status ?? 'null'}）`);
}

test('50a) 深度验证：异步跑通 Node 测试并记录 passed + started/completed 事件', async () => {
  const dir = fixture({
    'tests/ok.test.js': `const test=require('node:test');const assert=require('node:assert');test('ok',()=>assert.equal(1,1));\n`,
  });
  const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
  const svc = new VerificationService({
    nodePath: process.execPath,
    nodeArgs: ['--test', 'tests/ok.test.js'],
    emit: (_runId, type, data) => events.push({ type, data }),
    timeoutMs: 10_000,
  });
  try {
    const start = svc.start('run_ver_ok', dir);
    assert.equal(start.ok, true);
    await waitStatus(svc, 'run_ver_ok', 'passed');
    const job = svc.get('run_ver_ok')!;
    assert.equal(job.status, 'passed');
    assert.ok((job.durationMs ?? 0) >= 0);
    assert.ok(events.some((e) => e.type === 'verification_started'));
    const done = events.find((e) => e.type === 'verification_completed');
    assert.ok(done);
    assert.equal(done!.data?.ok, true);
  } finally {
    svc.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('50b) 深度验证失败：failed + excerpt 保留失败证据（不是静默通过）', async () => {
  const dir = fixture({
    'tests/bad.test.js': `const test=require('node:test');const assert=require('node:assert');test('bad',()=>assert.equal(1,2));\n`,
  });
  const svc = new VerificationService({
    nodePath: process.execPath,
    nodeArgs: ['--test', 'tests/bad.test.js'],
    timeoutMs: 10_000,
  });
  try {
    svc.start('run_ver_bad', dir);
    await waitStatus(svc, 'run_ver_bad', 'failed');
    const job = svc.get('run_ver_bad')!;
    assert.equal(job.status, 'failed');
    assert.ok((job.excerpt ?? '').length > 0, '失败必须带可读证据');
    assert.match(job.excerpt!, /失败|not ok|assert/i);
  } finally {
    svc.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('50c) 深度验证可取消：running → cancelled，且不会挂住队列', async () => {
  const dir = fixture({
    'tests/slow.test.js':
      `const test=require('node:test');test('slow',async()=>{await new Promise(r=>setTimeout(r,10000));});\n`,
  });
  const svc = new VerificationService({
    nodePath: process.execPath,
    nodeArgs: ['--test', 'tests/slow.test.js'],
    timeoutMs: 30_000,
  });
  try {
    svc.start('run_ver_cancel', dir);
    await waitStatus(svc, 'run_ver_cancel', 'running', 3000);
    const c = svc.cancel('run_ver_cancel');
    assert.equal(c.cancelled, true);
    await waitStatus(svc, 'run_ver_cancel', 'cancelled', 5000);
    assert.equal(svc.get('run_ver_cancel')!.status, 'cancelled');
  } finally {
    svc.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('50d) 终态 run 追加验证事件：run_completed 删掉序号后必须恢复到 max+1（不主键冲突）', () => {
  const store = new SqliteStore(':memory:');
  const logger = new EventLogger({
    maxContentChars: 200,
    onPersistBatch: (events) => store.appendEvents(events),
    console: false,
  });
  try {
    logger.emit('run_seq', 'run_started', { kind: 'run' });
    logger.emit('run_seq', 'run_completed', { status: 'ok' });
    logger.flush(); // 终态事件先落盘，模拟 Runtime 收尾
    // run_completed 会 FORGET_SEQ_ON 删除计数；模拟 VerificationService.prepareEvent
    const maxSeq = store.getEvents('run_seq').reduce((m, e) => Math.max(m, e.seq), 0);
    logger.ensureSeqAtLeast('run_seq', maxSeq);
    logger.emit('run_seq', 'verification_started', { level: 'L2' });
    logger.emit('run_seq', 'verification_completed', { level: 'L2', ok: true });
    logger.flush();
    const events = store.getEvents('run_seq');
    // run_started(1) + run_completed(2) 后追加验证事件必须是 3、4（不能回到 1 撞主键）
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4]);
    assert.equal(events[3].type, 'verification_completed');
  } finally {
    store.close();
  }
});

test('50e) 同一 run 重复启动：返回 ALREADY_RUNNING，不并发跑两份全量', async () => {
  const dir = fixture({
    'tests/slow.test.js':
      `const test=require('node:test');test('slow',async()=>{await new Promise(r=>setTimeout(r,5000));});\n`,
  });
  const svc = new VerificationService({
    nodePath: process.execPath,
    nodeArgs: ['--test', 'tests/slow.test.js'],
    timeoutMs: 30_000,
  });
  try {
    const a = svc.start('run_ver_dup', dir);
    const b = svc.start('run_ver_dup', dir);
    assert.equal(a.ok, true);
    assert.equal(b.ok, false);
    if (!b.ok) assert.equal(b.code, 'ALREADY_RUNNING');
    svc.cancel('run_ver_dup');
    await waitStatus(svc, 'run_ver_dup', 'cancelled', 5000);
  } finally {
    svc.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function withServer50(
  cfg: ReturnType<typeof loadConfig>,
  fn: (base: string, store: SqliteStore, verification: VerificationService) => Promise<void>,
): Promise<void> {
  const { app, store, verification } = createApp(cfg);
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`, store, verification);
  } finally {
    verification.dispose();
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
}

function seedRun(store: SqliteStore, runId: string, status: 'running' | 'completed', repoPath?: string): void {
  const now = new Date().toISOString();
  store.createRun({
    runId,
    runType: 'misc',
    status,
    goal: 'manual L2 boundary test',
    createdAt: now,
    updatedAt: now,
    steps: 0,
    modelCalls: 0,
    toolCalls: 0,
    totalDurationMs: 0,
    usageJson: '{}',
    isMock: 1,
  });
  store.appendEvent({
    runId,
    seq: 1,
    type: 'run_started',
    timestamp: now,
    data: repoPath ? { inputs: { repoPath } } : { inputs: {} },
  });
}

test('50f) HTTP 手动 L2：404 / 非终态 409 / 无 repoPath 400 / 合法启动 202', async () => {
  const dir = fixture({
    // 必须是真实会运行的慢测试，才能覆盖「运行中取消」；否则验证会在 HTTP 取消到达前结束。
    'tests/slow.test.js': `const test=require('node:test');test('slow',async()=>{await new Promise(r=>setTimeout(r,10000));});\n`,
  });
  const cfg = loadConfig();
  cfg.sqlitePath = ':memory:';
  cfg.sandbox.hostNodePath = process.execPath;
  cfg.sandbox.execTimeoutMs = 30_000;
  try {
    await withServer50(cfg, async (base, store, verification) => {
      const missing = await fetch(`${base}/api/runs/run_missing/verify`, { method: 'POST' });
      assert.equal(missing.status, 404);

      seedRun(store, 'run_running_50f', 'running', dir);
      const pending = await fetch(`${base}/api/runs/run_running_50f/verify`, { method: 'POST' });
      assert.equal(pending.status, 409);

      seedRun(store, 'run_no_repo_50f', 'completed');
      const noRepo = await fetch(`${base}/api/runs/run_no_repo_50f/verify`, { method: 'POST' });
      assert.equal(noRepo.status, 400);

      seedRun(store, 'run_ok_50f', 'completed', dir);
      const started = await fetch(`${base}/api/runs/run_ok_50f/verify`, { method: 'POST' });
      assert.equal(started.status, 202);
      const body = (await started.json()) as { job?: { runId?: string; status?: string } };
      assert.equal(body.job?.runId, 'run_ok_50f');
      assert.ok(body.job?.status === 'queued' || body.job?.status === 'running');

      const status = await fetch(`${base}/api/runs/run_ok_50f/verification`);
      assert.equal(status.status, 200);
      const statusBody = (await status.json()) as { job?: { runId?: string } };
      assert.equal(statusBody.job?.runId, 'run_ok_50f');

      const cancelled = await fetch(`${base}/api/runs/run_ok_50f/verification/cancel`, { method: 'POST' });
      assert.equal(cancelled.status, 200);
      await waitStatus(verification, 'run_ok_50f', 'cancelled', 5000);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
