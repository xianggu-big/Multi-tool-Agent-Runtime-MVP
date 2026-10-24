// tests/69_scheduler.test.ts — 定时任务：时间计算 / tick / 重叠跳过 / 停服错过 / 请求校验
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/store/SqliteStore.js';
import { SchedulerService, buildScheduleRunInput } from '../src/scheduler/service.js';
import { computeNextRunAt, isMissed, parseDailyTime } from '../src/scheduler/time.js';
import type { ScheduleRecord } from '../src/scheduler/types.js';
import { loadConfig } from '../src/config.js';
import { parseScheduleRequest } from '../src/server.js';

function schedule(over: Partial<ScheduleRecord>): ScheduleRecord {
  const now = new Date().toISOString();
  return {
    id: 'sch_test',
    name: 't',
    agent: 'codex',
    goal: 'g',
    repoPath: undefined,
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
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

test('69a) computeNextRunAt：daily 当天未到→今天，已过→明天；once 过去→null', () => {
  const from = new Date(2026, 0, 1, 8, 0, 0);
  const next = new Date(computeNextRunAt({ frequency: 'daily', runAt: '09:30' }, from)!);
  assert.equal(next.getDate(), 1);
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 30);

  const later = new Date(2026, 0, 1, 10, 0, 0);
  const tomorrow = new Date(computeNextRunAt({ frequency: 'daily', runAt: '09:30' }, later)!);
  assert.equal(tomorrow.getDate(), 2);

  assert.equal(computeNextRunAt({ frequency: 'once', runAt: new Date(2026, 0, 1, 8, 0, 0).toISOString() }, later), null);
  assert.equal(parseDailyTime('25:00'), null);
  assert.deepEqual(parseDailyTime('09:05'), { hh: 9, mm: 5 });
  assert.equal(isMissed(new Date(Date.now() - 5 * 60_000).toISOString(), new Date()), true);
  assert.equal(isMissed(new Date(Date.now() - 10_000).toISOString(), new Date()), false);
});

test('69b) tick：到点入队并推进 nextRunAt；一次性任务执行后停用', () => {
  const store = new SqliteStore(':memory:');
  const now = new Date();
  const due = new Date(now.getTime() - 1000).toISOString();
  store.saveSchedule(schedule({ id: 'sch_daily', nextRunAt: due, frequency: 'daily', runAt: '09:30' }));
  store.saveSchedule(
    schedule({ id: 'sch_once', nextRunAt: due, frequency: 'once', runAt: new Date(now.getTime() + 3600_000).toISOString() }),
  );
  const enqueued: string[] = [];
  const svc = new SchedulerService({
    store,
    enqueue: (input) => {
      enqueued.push(input.scheduleId ?? '?');
      return 'run_' + input.scheduleId;
    },
  });
  const results = svc.tick(now);
  assert.equal(enqueued.length, 2);
  assert.equal(results.length, 2);
  const daily = store.getSchedule('sch_daily')!;
  assert.equal(daily.lastRunId, 'run_sch_daily');
  assert.ok(daily.nextRunAt && new Date(daily.nextRunAt).getTime() > now.getTime());
  const once = store.getSchedule('sch_once')!;
  assert.equal(once.enabled, false);
  assert.equal(once.nextRunAt, undefined);
  store.close();
});

test('69c) tick：上一次仍在运行 → 重叠跳过；停服错过的一次性任务 → 不补跑并停用', () => {
  const store = new SqliteStore(':memory:');
  const now = new Date();
  store.createRun({
    runId: 'run_running',
    runType: 'codex',
    status: 'running',
    goal: 'g',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    steps: 0,
    modelCalls: 0,
    toolCalls: 0,
    totalDurationMs: 0,
    usageJson: '{}',
    isMock: 0,
  });
  store.saveSchedule(
    schedule({ id: 'sch_overlap', nextRunAt: new Date(now.getTime() - 1000).toISOString(), lastRunId: 'run_running' }),
  );
  store.saveSchedule(
    schedule({
      id: 'sch_missed',
      frequency: 'once',
      nextRunAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
      runAt: new Date(now.getTime() + 3600_000).toISOString(),
    }),
  );
  const enqueued: string[] = [];
  const svc = new SchedulerService({ store, enqueue: (i) => (enqueued.push(i.scheduleId ?? '?'), 'run_x') });
  const results = svc.tick(now);
  assert.equal(enqueued.length, 0);
  assert.equal(results.find((r) => r.scheduleId === 'sch_overlap')?.skipped, 'overlap');
  assert.equal(results.find((r) => r.scheduleId === 'sch_missed')?.missed, true);
  assert.equal(store.getSchedule('sch_missed')!.enabled, false);
  assert.match(store.getSchedule('sch_missed')!.lastError ?? '', /missed/);
  store.close();
});

test('69d) runNow：立即触发但不改变 nextRunAt；buildScheduleRunInput 透传 policy', () => {
  const store = new SqliteStore(':memory:');
  const future = new Date(Date.now() + 3600_000).toISOString();
  store.saveSchedule(schedule({ id: 'sch_now', nextRunAt: future, allowWrite: true, autoApprove: true }));
  const svc = new SchedulerService({ store, enqueue: () => 'run_now_1' });
  const r = svc.runNow('sch_now');
  assert.equal(r.ok, true);
  assert.equal(store.getSchedule('sch_now')!.lastRunId, 'run_now_1');
  assert.equal(store.getSchedule('sch_now')!.nextRunAt, future);
  const input = buildScheduleRunInput(store.getSchedule('sch_now')!);
  assert.equal(input.scheduleId, 'sch_now');
  assert.equal(input.autoApprove, true);
  assert.equal(input.codex?.allowWrite, true);
  store.close();
});

test('69e) parseScheduleRequest：Codex 定时任务校验 + 危险组合 fail-closed', () => {
  const cfg = loadConfig();
  cfg.codex.enabled = true;
  const repo = mkdtempSync(join(tmpdir(), 'mta-sched-req-'));
  try {
    const ok = parseScheduleRequest(
      { agent: 'codex', goal: '检查 TODO', repoPath: repo, frequency: 'daily', runAt: '09:30', allowWrite: true, autoApprove: true },
      cfg,
    );
    assert.equal(ok.error, undefined);
    assert.ok(ok.record);
    assert.equal(ok.record!.autoApprove, true);
    assert.ok(ok.record!.nextRunAt);

    const badAuto = parseScheduleRequest({ agent: 'codex', goal: 'g', repoPath: repo, frequency: 'daily', runAt: '09:30', autoApprove: true }, cfg);
    assert.match(badAuto.error ?? '', /autoApprove/);

    const badWrite = parseScheduleRequest({ agent: 'codebase', goal: 'g', repoPath: repo, frequency: 'daily', runAt: '09:30', allowWrite: true }, cfg);
    assert.match(badWrite.error ?? '', /allowWrite/);

    const past = parseScheduleRequest({ agent: 'codex', goal: 'g', repoPath: repo, frequency: 'once', runAt: '2000-01-01T00:00:00Z' }, cfg);
    assert.match(past.error ?? '', /未来/);

    const badDaily = parseScheduleRequest({ agent: 'codex', goal: 'g', repoPath: repo, frequency: 'daily', runAt: '25:00' }, cfg);
    assert.match(badDaily.error ?? '', /HH:mm/);

    cfg.codex.enabled = false;
    const disabled = parseScheduleRequest({ agent: 'codex', goal: 'g', repoPath: repo, frequency: 'daily', runAt: '09:30' }, cfg);
    assert.match(disabled.error ?? '', /Codex 已禁用/);
    cfg.codex.enabled = true;

    // 非敏感参数：options 里的 apiKey 不会进入记录
    const withKey = parseScheduleRequest(
      {
        agent: 'codex',
        goal: 'g',
        repoPath: repo,
        frequency: 'daily',
        runAt: '09:30',
        options: { llm: { provider: 'deepseek', model: 'deepseek-flash', apiKey: 'sk-secret' } },
      },
      cfg,
    );
    assert.equal(withKey.error, undefined);
    assert.equal(JSON.stringify(withKey.record).includes('sk-secret'), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('69f) 定时任务预算/生成参数/编排宽度与普通 API 同一套边界', () => {
  const cfg = loadConfig();
  const repo = mkdtempSync(join(tmpdir(), 'mta-sched-limits-'));
  const base = { agent: 'codebase', goal: 'g', repoPath: repo, frequency: 'daily', runAt: '09:30' };
  try {
    for (const limits of [
      { maxSteps: -1 },
      { maxSteps: 'abc' },
      { maxSteps: 0 },
      { totalTimeoutMs: 1 },
      { tokenBudget: 9_999_999_999 },
      { costBudgetUsd: 0 },
    ]) {
      const r = parseScheduleRequest({ ...base, options: { limits } }, cfg);
      assert.match(r.error ?? '', /options\.limits/, '必须拒绝: ' + JSON.stringify(limits));
    }
    const badParams = parseScheduleRequest({ ...base, options: { llm: { params: { temperature: 9 } } } }, cfg);
    assert.match(badParams.error ?? '', /options\.llm\.params/);
    const badWidth = parseScheduleRequest({ ...base, options: { orchestration: { maxWidth: 99 } } }, cfg);
    assert.match(badWidth.error ?? '', /maxWidth/);
    const ok = parseScheduleRequest({ ...base, options: { limits: { maxSteps: '12', costBudgetUsd: 0.5 } } }, cfg);
    assert.equal(ok.error, undefined);
    assert.equal(ok.record!.options.limits?.maxSteps, 12);
    assert.equal(ok.record!.options.limits?.costBudgetUsd, 0.5);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('69g) runNow：上一次 run 仍活动 → overlap_skipped，不重复入队', () => {
  const store = new SqliteStore(':memory:');
  const now = new Date();
  store.createRun({
    runId: 'run_still_running',
    runType: 'codex',
    status: 'running',
    goal: 'g',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    steps: 0,
    modelCalls: 0,
    toolCalls: 0,
    totalDurationMs: 0,
    usageJson: '{}',
    isMock: 0,
  });
  store.saveSchedule(
    schedule({
      id: 'sch_overlap_now',
      nextRunAt: new Date(now.getTime() + 3600_000).toISOString(),
      lastRunId: 'run_still_running',
    }),
  );
  let enqueued = 0;
  const svc = new SchedulerService({ store, enqueue: () => { enqueued += 1; return 'run_x'; } });
  const r = svc.runNow('sch_overlap_now');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /overlap_skipped/);
  assert.equal(enqueued, 0);
  store.close();
});

test('69h) 历史脏预算在执行前被收敛，不会进入 Budget', () => {
  const dirty = {
    ...schedule({ id: 'sch_dirty' }),
    options: { limits: { maxSteps: -3, maxModelCalls: 5, tokenBudget: 'abc', costBudgetUsd: -1 } },
  } as unknown as ScheduleRecord;
  const input = buildScheduleRunInput(dirty);
  assert.equal(input.maxSteps, undefined);
  assert.equal(input.maxModelCalls, 5);
  assert.equal(input.tokenBudget, undefined);
  assert.equal(input.costBudgetUsd, undefined);
});
