// tests/76_maintenance.test.ts — 数据保留：候选计算保守、必须显式确认、只删终态旧 run
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { SqliteStore } from '../src/store/SqliteStore.js';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import type { ScheduleRecord } from '../src/scheduler/types.js';

const OLD = '2020-01-01T00:00:00.000Z';

function putRun(store: SqliteStore, id: string, status: 'completed' | 'running' | 'awaiting_user', createdAt = OLD) {
  store.createRun({
    runId: id,
    runType: 'codebase',
    status,
    goal: 'g',
    createdAt,
    updatedAt: createdAt,
    steps: 0,
    modelCalls: 0,
    toolCalls: 0,
    totalDurationMs: 0,
    usageJson: '{}',
    isMock: 0,
  });
  store.appendEvents([{ runId: id, seq: 1, type: 'run_started', timestamp: createdAt, data: {} }]);
}

function putSchedule(store: SqliteStore, lastRunId: string) {
  const now = new Date().toISOString();
  const s: ScheduleRecord = {
    id: 'sch_keep',
    name: 'keep',
    agent: 'codebase',
    goal: 'g',
    frequency: 'daily',
    runAt: '09:30',
    enabled: true,
    allowWrite: false,
    autoApprove: false,
    dangerPatterns: [],
    allowRunTests: false,
    skipIfRunning: true,
    options: {},
    nextRunAt: now,
    lastRunId,
    createdAt: now,
    updatedAt: now,
  };
  store.saveSchedule(s);
}

test('76a) 候选：只含终态旧 run；跳过活动/待确认/定时任务引用', () => {
  const store = new SqliteStore(':memory:');
  putRun(store, 'run_old', 'completed');
  putRun(store, 'run_running', 'running');
  putRun(store, 'run_awaiting', 'awaiting_user');
  putRun(store, 'run_pending', 'completed');
  putRun(store, 'run_scheduled', 'completed');
  store.createPendingAction({
    id: 'pa_keep',
    runId: 'run_pending',
    kind: 'delete',
    payload: {},
    status: 'pending',
    createdAt: OLD,
  });
  putSchedule(store, 'run_scheduled');

  const dry = store.pruneRunsOlderThan(new Date().toISOString(), { dryRun: true });
  assert.equal(dry.runs, 1);
  assert.equal(dry.events, 1);
  assert.equal(store.getRun('run_old') !== null, true, 'dry-run 不删除');

  const deleted = store.pruneRunsOlderThan(new Date().toISOString());
  assert.equal(deleted.runs, 1);
  assert.equal(store.getRun('run_old'), null);
  assert.equal(store.getEvents('run_old').length, 0);
  assert.ok(store.getRun('run_running'));
  assert.ok(store.getRun('run_awaiting'));
  assert.ok(store.getRun('run_pending'));
  assert.ok(store.getRun('run_scheduled'));
  store.close();
});

test('76b) /api/maintenance：只读概览；prune 必须 confirm:true', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mta-maint-'));
  const config = loadConfig();
  config.sqlitePath = join(dir, 'runtime.db');
  config.log.errorLogPath = join(dir, 'errors.log');
  config.mcp = { servers: [], toolNames: [] };
  config.authToken = '';
  config.dataRetentionDays = 30;
  const { app, store } = createApp(config);
  putRun(store, 'run_old_http', 'completed');

  const http = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => http.once('listening', resolve));
  const base = `http://127.0.0.1:${(http.address() as net.AddressInfo).port}`;
  try {
    const overview = await (await fetch(`${base}/api/maintenance`)).json() as any;
    assert.equal(overview.retentionDays, 30);
    assert.equal(overview.candidates.runs, 1);

    const refused = await fetch(`${base}/api/maintenance/prune`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ olderThanDays: 30 }),
    });
    assert.equal(refused.status, 400);
    assert.ok(store.getRun('run_old_http'));

    const pruned = await (await fetch(`${base}/api/maintenance/prune`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true, olderThanDays: 30 }),
    })).json() as any;
    assert.equal(pruned.ok, true);
    assert.equal(pruned.deleted.runs, 1);
    assert.equal(store.getRun('run_old_http'), null);
  } finally {
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});
