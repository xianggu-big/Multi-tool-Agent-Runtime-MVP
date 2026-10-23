// tests/65_orchestration_gate.test.ts — 编排预筛闸门：规模估算、自动分流降级、显式编排只提示
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { adviseOrchestration, scanRepoFacts } from '../src/runtime/orchestrationGate.js';
import { loadConfig } from '../src/config.js';

function tmpConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'mta-gate-'));
  const config = loadConfig();
  config.sqlitePath = join(dir, 'runtime.db');
  config.log.errorLogPath = join(dir, 'errors.log');
  config.mcp = { servers: [], toolNames: [] };
  return config;
}

async function listen(app: { listen: (port: number) => import('node:http').Server }) {
  const http = app.listen(0);
  await new Promise<void>((ok) => http.once('listening', ok));
  const port = (http.address() as { port: number }).port;
  return { http, base: `http://127.0.0.1:${port}` };
}

function makeRepo(files: Record<string, number>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mta-gate-repo-'));
  for (const [rel, bytes] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, 'x'.repeat(bytes));
  }
  return dir;
}

test('65a) 仓库扫描：统计普通文件、跳过依赖/隐藏目录、达上限标 truncated', () => {
  const repo = makeRepo({ 'src/a.ts': 100, 'src/b.ts': 50, 'node_modules/dep/index.js': 999, '.git/config': 20 });
  const facts = scanRepoFacts(repo);
  assert.equal(facts.files, 2);
  assert.equal(facts.bytes, 150);
  assert.equal(facts.truncated, false);

  const capped = scanRepoFacts(repo, { maxFiles: 1 });
  assert.equal(capped.files, 1);
  assert.equal(capped.truncated, true);
});

test('65b) 建议：小仓库 single、明确分区信号 orchestrate、无仓库 unknown', () => {
  const small = { files: 20, bytes: 100_000, truncated: false, scannedDirs: 5 };
  const single = adviseOrchestration('清点并审计 src 目录', small, { tokenBudget: 200_000 });
  assert.equal(single.recommend, 'single');
  assert.ok((single.estimatedTokens ?? 0) < 200_000);

  const multi = adviseOrchestration('分别审计每个模块并交叉验证', small, { tokenBudget: 200_000 });
  assert.equal(multi.recommend, 'orchestrate');
  assert.match(multi.reason, /交叉验证|分区/);

  const unknown = adviseOrchestration('清点目录', null, { tokenBudget: 200_000 });
  assert.equal(unknown.recommend, 'unknown');

  const big = { files: 5000, bytes: 4_000_000, truncated: true, scannedDirs: 800 };
  assert.equal(adviseOrchestration('清点目录', big, { tokenBudget: 200_000 }).recommend, 'orchestrate');
});

test('65c) 自动分流：小仓库从 orchestrator 降为 codebase；preview=1 只展示建议', { timeout: 30_000 }, async () => {
  const { createApp } = await import('../src/server.js');
  const config = tmpConfig();
  const { app } = createApp(config);
  const { http, base } = await listen(app);
  const repo = resolve('demo/codebase-sample');
  try {
    const auto = await (await fetch(`${base}/api/task-router?goal=${encodeURIComponent('清点并审计 src 与 test 目录')}&repoPath=${encodeURIComponent(repo)}`)).json() as any;
    assert.equal(auto.runType, 'codebase');
    assert.equal(auto.orchestrationAdvice.recommend, 'single');
    assert.match(auto.reason, /编排预筛/);

    const preview = await (await fetch(`${base}/api/task-router?goal=${encodeURIComponent('清点并审计 src 与 test 目录')}&repoPath=${encodeURIComponent(repo)}&preview=1`)).json() as any;
    assert.equal(preview.runType, 'orchestrator');
    assert.equal(preview.orchestrationAdvice.recommend, 'single');
  } finally {
    await new Promise<void>((ok) => http.close(() => ok()));
  }
});

test('65d) 显式编排不降级：响应与 run_started 都带 gate 解释', { timeout: 30_000 }, async () => {
  const { createApp } = await import('../src/server.js');
  const config = tmpConfig();
  const { app } = createApp(config);
  const { http, base } = await listen(app);
  try {
    const res = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runType: 'orchestrator',
        goal: '清点并审计 src 与 test 目录',
        repoPath: resolve('demo/codebase-sample'),
        mockScenario: 'orchestrator-basic',
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as any;
    assert.equal(body.runType, 'orchestrator');
    assert.equal(body.orchestrationGate.recommend, 'single');
    const ev = await (await fetch(`${base}/api/runs/${body.runId}/events`)).json() as any[];
    const started = ev.find((e) => e.type === 'run_started');
    assert.equal(started.data.inputs.orchestrationGate.recommend, 'single');
    await fetch(`${base}/api/runs/${body.runId}/cancel`, { method: 'POST' });
  } finally {
    await new Promise<void>((ok) => http.close(() => ok()));
  }
});
