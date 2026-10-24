// tests/71_codex_api.test.ts — Codex run/定时任务/待确认的高危操作 API 门禁
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { validateRunRequest } from '../src/server.js';
import { SqliteStore } from '../src/store/SqliteStore.js';
import { PendingActionService } from '../src/runtime/PendingActionService.js';
import { shortSha256 } from '../src/sandbox/hash.js';

test('71a) validateRunRequest：codex 不需要 API Key；autoApprove/scheduleId 客户端禁传', () => {
  const config = loadConfig();
  config.codex.enabled = true;
  config.llmMode = 'openai';
  config.openai.apiKey = undefined; // 无 Key
  const repo = mkdtempSync(join(tmpdir(), 'mta-codex-api-'));
  try {
    const ok = validateRunRequest({ runType: 'codex', goal: '只回复 ok', repoPath: repo, codex: {} }, config);
    assert.equal(ok.error, undefined);
    assert.ok(ok.input);

    const forged = validateRunRequest({ runType: 'codex', goal: 'g', repoPath: repo, autoApprove: true }, config);
    assert.match(forged.error ?? '', /autoApprove/);
    const forged2 = validateRunRequest({ runType: 'codex', goal: 'g', repoPath: repo, scheduleId: 'x' }, config);
    assert.match(forged2.error ?? '', /scheduleId|autoApprove/);
    const badType = validateRunRequest({ runType: 'nope', goal: 'g' }, config);
    assert.match(badType.error ?? '', /runType/);
    const noRepo = validateRunRequest({ runType: 'codex', goal: 'g' }, config);
    assert.match(noRepo.error ?? '', /repoPath/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('71b) PendingActionService：execute 必须 confirm；删除复核 baseHash → STALE_ACTION', async () => {
  const store = new SqliteStore(':memory:');
  const cfg = loadConfig();
  const repo = mkdtempSync(join(tmpdir(), 'mta-pa-'));
  cfg.sqlitePath = join(repo, 'test.db'); // 备份目录跟随临时库，避免污染仓库 data/
  try {
    const file = join(repo, 'x.txt');
    writeFileSync(file, 'original');
    const svc = new PendingActionService(store, cfg, () => {}, () => {});

    const noConfirm = await svc.execute('nope', { confirm: false });
    assert.equal(noConfirm.ok, false);

    store.createPendingAction({
      id: 'pa_1',
      runId: 'run_x',
      kind: 'delete',
      payload: { repoPath: repo, relPath: 'x.txt', baseHash: shortSha256('original') },
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
    const r1 = await svc.execute('pa_1', { confirm: true });
    assert.equal(r1.ok, true);
    assert.equal(store.getPendingAction('pa_1')!.status, 'executed');

    // 文件被外部改过 → STALE_ACTION
    writeFileSync(file, 'changed');
    store.createPendingAction({
      id: 'pa_2',
      runId: 'run_y',
      kind: 'delete',
      payload: { repoPath: repo, relPath: 'x.txt', baseHash: shortSha256('original') },
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
    const r2 = await svc.execute('pa_2', { confirm: true });
    assert.equal(r2.ok, false);
    assert.equal(r2.detail?.code, 'STALE_ACTION');
    assert.equal(store.getPendingAction('pa_2')!.status, 'failed');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('71c) PendingActionService：dismiss 未知项 → 明确提示', () => {
  const store = new SqliteStore(':memory:');
  const cfg = loadConfig();
  cfg.sqlitePath = ':memory:';
  const svc = new PendingActionService(store, cfg, () => {}, () => {});
  const r = svc.dismiss('nope');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /不存在/);
});
