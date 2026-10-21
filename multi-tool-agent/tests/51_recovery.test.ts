// tests/51_recovery.test.ts — 崩溃对账：意图日志 / 五态判定 / 自动恢复 / 手动回滚 / 冲突保护
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SqliteStore } from '../src/store/SqliteStore.js';
import { RecoveryService } from '../src/runtime/RecoveryService.js';
import { beginApplyJournal, readApplyJournal, updateApplyEntry } from '../src/sandbox/applyJournal.js';
import { shortSha256 } from '../src/sandbox/hash.js';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';

function fixture(): {
  root: string;
  repo: string;
  data: string;
  store: SqliteStore;
  close: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'mta-recovery-'));
  const repo = join(root, 'repo');
  const data = join(root, 'data');
  mkdirSync(repo, { recursive: true });
  mkdirSync(data, { recursive: true });
  const store = new SqliteStore(join(data, 'runtime.db'));
  return {
    root,
    repo,
    data,
    store,
    close: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function baseRun(store: SqliteStore, runId: string, repoPath: string, status: 'running' | 'completed'): void {
  const at = new Date().toISOString();
  store.createRun({
    runId,
    runType: 'codebase',
    status,
    goal: 'crash recovery fixture',
    createdAt: at,
    updatedAt: at,
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
    timestamp: at,
    data: { inputs: { repoPath } },
  });
}

function interrupt(store: SqliteStore, runId: string, repoPath: string): void {
  baseRun(store, runId, repoPath, 'running');
  const at = new Date().toISOString();
  store.finalizeInterruptedRun(runId, {
    at,
    errorCode: 'RUN_INTERRUPTED',
    failureReason: '测试模拟：进程在落盘窗口内被杀',
    eventData: { code: 'RUN_INTERRUPTED' },
  });
}

function backup(dataDir: string, runId: string, rel: string, content: string): void {
  const p = join(dataDir, 'backups', runId, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf8');
}

test('51a) 启动对账：五态判定 + 自动恢复消失文件 + 手动回滚 + 冲突不覆盖', async () => {
  const f = fixture();
  try {
    const runId = 'run_crash_a';
    // 仓库现状：a 已落盘；b 在 rm 后 rename 前消失（只剩 tmp）；c 被用户改过；d 是新增；e 未落盘
    writeFileSync(join(f.repo, 'a.txt'), 'A1', 'utf8');
    writeFileSync(join(f.repo, 'c.txt'), 'C-user', 'utf8');
    writeFileSync(join(f.repo, 'd.txt'), 'D1', 'utf8');
    writeFileSync(join(f.repo, 'e.txt'), 'E0', 'utf8');
    writeFileSync(join(f.repo, 'b.txt.mta-tmp-123'), 'B1', 'utf8');

    backup(f.data, runId, 'a.txt', 'A0');
    backup(f.data, runId, 'b.txt', 'B0');
    backup(f.data, runId, 'c.txt', 'C0');
    backup(f.data, runId, 'e.txt', 'E0');

    await beginApplyJournal(f.data, runId, f.repo, 'ap_1', [
      { relPath: 'a.txt', op: 'edit', baseHash: shortSha256('A0'), workHash: shortSha256('A1') },
      { relPath: 'b.txt', op: 'edit', baseHash: shortSha256('B0'), workHash: shortSha256('B1') },
      { relPath: 'c.txt', op: 'edit', baseHash: shortSha256('C0'), workHash: shortSha256('C1') },
      { relPath: 'd.txt', op: 'create', workHash: shortSha256('D1') },
      { relPath: 'e.txt', op: 'edit', baseHash: shortSha256('E0'), workHash: shortSha256('E1') },
    ]);
    interrupt(f.store, runId, f.repo);

    const svc = new RecoveryService({ dataDir: f.data, store: f.store, autoRestoreMissing: true });
    const reports = await svc.startupSweep();
    const r = reports.find((x) => x.runId === runId)!;
    assert.ok(r, '启动扫描必须产出该 run 的报告');
    assert.equal(r.status, 'conflict');
    assert.equal(r.counts.applied, 2, 'a/d 已落盘');
    assert.equal(r.counts.conflict, 1, 'c 与原文、本次写入都不一致');
    assert.equal(r.counts.not_applied, 2, 'b 已自动恢复，e 未落盘');
    assert.deepEqual(r.autoRestored, ['b.txt']);
    assert.equal(readFileSync(join(f.repo, 'b.txt'), 'utf8'), 'B0', '消失的文件必须从备份恢复');
    assert.equal(existsSync(join(f.repo, 'b.txt.mta-tmp-123')), false, '崩溃残留的 tmp 必须清理');

    const rr = await svc.rollback(runId);
    assert.equal(rr.ok, true);
    assert.deepEqual([...rr.rolledBack].sort(), ['a.txt', 'd.txt']);
    assert.deepEqual(rr.conflicts, ['c.txt']);
    assert.equal(readFileSync(join(f.repo, 'a.txt'), 'utf8'), 'A0', '已落盘编辑回滚到原文');
    assert.equal(existsSync(join(f.repo, 'd.txt')), false, '已落盘新增回滚为删除');
    assert.equal(readFileSync(join(f.repo, 'c.txt'), 'utf8'), 'C-user', '冲突文件绝不覆盖');
    assert.equal(rr.report?.status, 'conflict');

    const acc = await svc.accept(runId);
    assert.equal(acc.ok, true);
    assert.equal(acc.report?.status, 'accepted');
    const listed = await svc.list();
    assert.ok(listed.some((x) => x.runId === runId && x.status === 'accepted'));
  } finally {
    f.close();
  }
});

test('51b) 正常完成的 run 不进入恢复：已落盘是审批后的预期结果', async () => {
  const f = fixture();
  try {
    const runId = 'run_done';
    writeFileSync(join(f.repo, 'a.txt'), 'A1', 'utf8');
    backup(f.data, runId, 'a.txt', 'A0');
    await beginApplyJournal(f.data, runId, f.repo, 'ap_1', [
      { relPath: 'a.txt', op: 'edit', baseHash: shortSha256('A0'), workHash: shortSha256('A1') },
    ]);
    baseRun(f.store, runId, f.repo, 'completed');

    const svc = new RecoveryService({ dataDir: f.data, store: f.store, autoRestoreMissing: true });
    const report = await svc.inspect(runId);
    assert.equal(report.status, 'not_needed');
    const rr = await svc.rollback(runId);
    assert.equal(rr.ok, false);
    assert.equal(readFileSync(join(f.repo, 'a.txt'), 'utf8'), 'A1');
  } finally {
    f.close();
  }
});

test('51c) 旧 run 没有意图日志：legacy + 人工比对，绝不动文件', async () => {
  const f = fixture();
  try {
    const runId = 'run_legacy';
    writeFileSync(join(f.repo, 'x.txt'), 'NEW', 'utf8');
    backup(f.data, runId, 'x.txt', 'OLD');
    interrupt(f.store, runId, f.repo);

    const svc = new RecoveryService({ dataDir: f.data, store: f.store, autoRestoreMissing: true });
    const report = await svc.inspect(runId);
    assert.equal(report.status, 'legacy');
    assert.equal(report.files.length, 1);
    assert.equal(report.files[0].action, 'manual_review');
    assert.equal(report.files[0].observed, 'unknown');

    const swept = await svc.startupSweep();
    assert.ok(swept.some((x) => x.runId === runId && x.status === 'legacy'));
    assert.equal(readFileSync(join(f.repo, 'x.txt'), 'utf8'), 'NEW', 'legacy 不得自动改文件');
  } finally {
    f.close();
  }
});

test('51d) 关闭自动恢复：文件保持缺失，由手动回滚恢复', async () => {
  const f = fixture();
  try {
    const runId = 'run_manual';
    backup(f.data, runId, 'b.txt', 'B0');
    await beginApplyJournal(f.data, runId, f.repo, 'ap_1', [
      { relPath: 'b.txt', op: 'edit', baseHash: shortSha256('B0'), workHash: shortSha256('B1') },
    ]);
    interrupt(f.store, runId, f.repo);

    const svc = new RecoveryService({ dataDir: f.data, store: f.store, autoRestoreMissing: false });
    const report = await svc.inspect(runId);
    assert.equal(report.status, 'pending');
    assert.equal(report.files[0].observed, 'missing');
    assert.equal(report.files[0].action, 'restore_backup');
    assert.equal(existsSync(join(f.repo, 'b.txt')), false);

    const rr = await svc.rollback(runId);
    assert.equal(rr.ok, true);
    assert.deepEqual(rr.rolledBack, ['b.txt']);
    assert.equal(readFileSync(join(f.repo, 'b.txt'), 'utf8'), 'B0');
  } finally {
    f.close();
  }
});

test('51e) 意图日志：多批追加、仓库不一致拒绝、状态更新', async () => {
  const f = fixture();
  try {
    const runId = 'run_journal';
    await beginApplyJournal(f.data, runId, f.repo, 'ap_1', [
      { relPath: 'a.txt', op: 'edit', baseHash: 'b1', workHash: 'w1' },
    ]);
    await beginApplyJournal(f.data, runId, f.repo, 'ap_2', [
      { relPath: 'a.txt', op: 'edit', baseHash: 'w1', workHash: 'w2' },
    ]);
    const j = await readApplyJournal(f.data, runId);
    assert.equal(j?.entries.length, 2);
    await updateApplyEntry(f.data, runId, 'ap_2', 'a.txt', { status: 'applied' });
    const j2 = await readApplyJournal(f.data, runId);
    assert.equal(j2?.entries[0].status, 'pending');
    assert.equal(j2?.entries[1].status, 'applied');
    await assert.rejects(() =>
      beginApplyJournal(f.data, runId, join(f.repo, 'other'), 'ap_3', []),
    );
  } finally {
    f.close();
  }
});

test('51f) HTTP 恢复入口：GET 报告 / POST 回滚 / POST 保留 / 列表 / 404', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mta-recovery-http-'));
  const repo = join(root, 'repo');
  const data = join(root, 'data');
  mkdirSync(repo, { recursive: true });
  mkdirSync(data, { recursive: true });
  const cfg = loadConfig();
  cfg.sqlitePath = join(data, 'runtime.db');
  cfg.codebase.writeEnabled = false;
  cfg.llmMode = 'mock';
  cfg.recovery.autoRestoreMissing = true;
  const { app, store, recovery, verification } = createApp(cfg);
  const runId = 'run_http_recovery';
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    writeFileSync(join(repo, 'a.txt'), 'A1', 'utf8');
    backup(data, runId, 'a.txt', 'A0');
    await beginApplyJournal(data, runId, repo, 'ap_http', [
      { relPath: 'a.txt', op: 'edit', baseHash: shortSha256('A0'), workHash: shortSha256('A1') },
    ]);
    interrupt(store, runId, repo);
    await recovery.startupSweep();

    const get = await fetch(`${base}/api/runs/${runId}/recovery`);
    assert.equal(get.status, 200);
    const body = (await get.json()) as { report: { status: string; counts: { applied: number } } };
    assert.equal(body.report.status, 'pending');
    assert.equal(body.report.counts.applied, 1);

    const missing = await fetch(`${base}/api/runs/run_missing/recovery`);
    assert.equal(missing.status, 404);
    const missingRollback = await fetch(`${base}/api/runs/run_missing/recovery/rollback`, { method: 'POST' });
    assert.equal(missingRollback.status, 404);

    const rollback = await fetch(`${base}/api/runs/${runId}/recovery/rollback`, { method: 'POST' });
    assert.equal(rollback.status, 200);
    const rb = (await rollback.json()) as { rolledBack: string[]; report: { status: string } };
    assert.deepEqual(rb.rolledBack, ['a.txt']);
    assert.equal(rb.report.status, 'rolled_back');
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'A0');

    const accept = await fetch(`${base}/api/runs/${runId}/recovery/accept`, { method: 'POST' });
    assert.equal(accept.status, 200);
    const ab = (await accept.json()) as { report: { status: string } };
    assert.equal(ab.report.status, 'accepted');

    const list = await fetch(`${base}/api/recovery`);
    assert.equal(list.status, 200);
    const lb = (await list.json()) as { reports: Array<{ runId: string; status: string }> };
    assert.ok(lb.reports.some((r) => r.runId === runId && r.status === 'accepted'));
  } finally {
    verification.dispose();
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('51g) 真实进程杀进程：落盘窗口内 SIGKILL，启动扫描从备份恢复', async () => {
  const f = fixture();
  try {
    const runId = 'run_real_kill';
    const childPath = join(process.cwd(), 'tests', 'fixtures', 'crash-apply-child.ts');
    assert.ok(existsSync(childPath), `缺少崩溃夹具：${childPath}`);

    const child = spawn(process.execPath, ['--import', 'tsx', childPath, f.repo, f.data, runId], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += String(d); });

    const code = await new Promise<number | null>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`崩溃夹具 20s 未退出（stderr：${stderr.slice(-500)}）`));
      }, 20_000);
      child.once('exit', (c) => {
        clearTimeout(timer);
        resolvePromise(c);
      });
      child.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    // Windows 用 exit=1 表示强杀；Unix 用 signal=SIGKILL（code=null）。两者都不是 0。
    assert.notEqual(code, 0, `子进程必须非正常退出（stderr：${stderr.slice(-500)}）`);

    // 确认真的进入了危险窗口：目标文件消失，tmp 残留，意图日志存在。
    assert.equal(existsSync(join(f.repo, 'src', 'crash.txt')), false, '窗口内目标文件必须已删除');
    assert.ok(
      readdirSync(join(f.repo, 'src')).some((n) => n.includes('.mta-tmp-kill')),
      '窗口内必须留下 tmp 文件（证明 rename 尚未发生）',
    );
    const journal = await readApplyJournal(f.data, runId);
    assert.equal(journal?.entries[0]?.status, 'pending');

    interrupt(f.store, runId, f.repo);
    const svc = new RecoveryService({ dataDir: f.data, store: f.store, autoRestoreMissing: true });
    const reports = await svc.startupSweep();
    const r = reports.find((x) => x.runId === runId);
    assert.ok(r, '启动扫描必须回收被强杀的 run');
    assert.deepEqual(r!.autoRestored, ['src/crash.txt']);
    assert.equal(readFileSync(join(f.repo, 'src', 'crash.txt'), 'utf8'), 'export const value = 1;\n');
    assert.equal(
      readdirSync(join(f.repo, 'src')).some((n) => n.includes('.mta-tmp-kill')),
      false,
      '恢复后必须清掉崩溃残留的 tmp',
    );
  } finally {
    f.close();
  }
});
