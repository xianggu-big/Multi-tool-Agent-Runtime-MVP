// tests/41_run_report.test.ts — run 级报告生成器（流程图 + 分层量化 + 六阶段归因）
//
// 覆盖（含三条实测缺陷的回归守卫）：
//   ① 子任务消耗必须单列：run 行 counters 只算主 Agent，"合计"要加上子任务；
//   ② 子任务的 step 号（子循环自己从 4 开始数）**不得**串进主 Agent 流程图；
//   ③ 子任务工具归属：tool_completed/tool_failed **不自带 parentId**（只有 started 侧有），
//      且 name 是裸名（`fetch_page`）——必须按 span 树回溯，否则会被误记成主 Agent；
//   ④ 六阶段归因：失败被后续成功覆盖 → gap（不是 fail）；limit_reached → fail；partial → gap；
//   ⑤ meta 可解析 + INDEX 幂等重建 + 落盘原子（tmp 文件 rename）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRunReport,
  buildRunReportIndex,
  parseRunReportMeta,
  type RunReportMeta,
  type RunReportRun,
} from '../src/report/runReport.js';
import { listRunReportMetas, regenerateRunReportIndex, writeRunReport } from '../src/report/runReportFiles.js';
import type { TraceEvent, TraceEventType } from '../src/types.js';

const RUN_ID = 'run_test_1';
const TS = '2026-10-16T00:00:00.000Z';

/** 合成一条事件（seq 自增，模拟持久化事件的严格连续序号） */
function makeEvents(): TraceEvent[] {
  let seq = 0;
  const ev = (type: TraceEventType, data: Record<string, unknown>): TraceEvent => {
    seq += 1;
    return { runId: RUN_ID, seq, type, timestamp: TS, data };
  };
  return [
    ev('run_started', {
      spanId: 'R',
      kind: 'run',
      name: 'run',
      inputs: { goal: '调研主流记账 App 功能并汇总', runType: 'orchestrator', isMock: false },
      allowedTools: ['delegate_subtasks', 'submit_orchestration'],
      limits: { maxSteps: 40, maxModelCalls: 20 },
    }),
    // step 1：一次模型调用 + delegate_subtasks 参数错误（随后重试成功）
    ev('model_request', { spanId: 'm1', parentId: 'R', kind: 'llm', name: 'openai', step: 1 }),
    ev('model_completed', {
      spanId: 'm1',
      step: 1,
      durationMs: 1000,
      status: 'ok',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, costUsd: 0.001 },
    }),
    ev('tool_started', {
      spanId: 't1',
      parentId: 'R',
      kind: 'tool',
      name: 'delegate_subtasks',
      step: 1,
      inputs: { toolCallId: 'c1', name: 'delegate_subtasks', arguments: {} },
    }),
    ev('tool_failed', {
      spanId: 't1',
      step: 1,
      durationMs: 5,
      status: 'error',
      outputs: { toolCallId: 'c1', name: 'delegate_subtasks', ok: false },
      error: { code: 'INVALID_ARGS', message: 'subtasks 必须是数组' },
    }),
    // step 2：重试成功
    ev('model_request', { spanId: 'm2', parentId: 'R', kind: 'llm', name: 'openai', step: 2 }),
    ev('model_completed', {
      spanId: 'm2',
      step: 2,
      durationMs: 1200,
      status: 'ok',
      usage: { promptTokens: 200, completionTokens: 60, totalTokens: 260, costUsd: 0.0006 },
    }),
    ev('tool_started', {
      spanId: 't2',
      parentId: 'R',
      kind: 'tool',
      name: 'delegate_subtasks',
      step: 2,
      inputs: { toolCallId: 'c2', name: 'delegate_subtasks' },
    }),
    ev('tool_completed', {
      spanId: 't2',
      step: 2,
      durationMs: 58000,
      status: 'ok',
      outputs: { toolCallId: 'c2', name: 'delegate_subtasks', ok: true },
    }),
    // 子任务（父 span 是 subtask；子循环自己的 step 从 4 起算）
    ev('subtask_started', { spanId: 'sp_sub', kind: 'subtask', subtaskId: 'st_1', specId: 'doc-research', objective: '调研记账功能' }),
    ev('model_request', { spanId: 'm3', parentId: 'sp_sub', kind: 'llm', name: 'doc-research/openai', step: 4 }),
    ev('model_completed', {
      spanId: 'm3',
      step: 4,
      durationMs: 2000,
      status: 'ok',
      usage: { promptTokens: 3000, completionTokens: 400, totalTokens: 3400, costUsd: 0.0004 },
    }),
    ev('tool_started', {
      spanId: 't3',
      parentId: 'sp_sub',
      kind: 'tool',
      name: 'doc-research/fetch_page',
      step: 4,
      inputs: { toolCallId: 'c3', specId: 'doc-research', name: 'fetch_page' },
    }),
    ev('tool_failed', {
      spanId: 't3',
      step: 4,
      durationMs: 100,
      status: 'error',
      outputs: { toolCallId: 'c3', specId: 'doc-research', name: 'fetch_page', ok: false },
      error: { code: 'NETWORK_ERROR', message: 'ECONNRESET' },
    }),
    // 子任务内重试成功（真实 run 的形态：fetch_page 失败后被后续成功覆盖）
    ev('tool_started', {
      spanId: 't4',
      parentId: 'sp_sub',
      kind: 'tool',
      name: 'doc-research/fetch_page',
      step: 4,
      inputs: { toolCallId: 'c4', specId: 'doc-research', name: 'fetch_page' },
    }),
    ev('tool_completed', {
      spanId: 't4',
      step: 4,
      durationMs: 900,
      status: 'ok',
      outputs: { toolCallId: 'c4', specId: 'doc-research', name: 'fetch_page', ok: true },
    }),
    ev('subtask_failed', {
      spanId: 'sp_sub',
      kind: 'subtask',
      subtaskId: 'st_1',
      specId: 'doc-research',
      status: 'limit_reached',
      errorCode: 'maxToolCalls',
      failureReason: '子任务达到最大工具调用数 16',
    }),
    // step 3：汇总
    ev('model_request', { spanId: 'm4', parentId: 'R', kind: 'llm', name: 'openai', step: 3 }),
    ev('model_completed', {
      spanId: 'm4',
      step: 3,
      durationMs: 1500,
      status: 'ok',
      usage: { promptTokens: 600, completionTokens: 190, totalTokens: 790, costUsd: 0.0009 },
    }),
    ev('orchestration_submitted', { structured: true, findingCount: 0, conflictCount: 0, unresolvedCount: 1 }),
    ev('run_completed', { spanId: 'R', kind: 'run', status: 'ok', durationMs: 60000 }),
  ];
}

function makeRun(overrides: Partial<RunReportRun> = {}): RunReportRun {
  return {
    runId: RUN_ID,
    runType: 'orchestrator',
    status: 'completed',
    goal: '调研主流记账 App 功能并汇总',
    createdAt: TS,
    updatedAt: TS,
    finalAnswer: '汇总：建议做记账网页。',
    failureReason: null,
    errorCode: null,
    triggeredLimit: null,
    steps: 3,
    modelCalls: 3,
    toolCalls: 3,
    totalDurationMs: 60000,
    usageJson: JSON.stringify({ promptTokens: 900, completionTokens: 300, totalTokens: 1200, costUsd: 0.002, isEstimate: false }),
    isMock: 0,
    resultJson: JSON.stringify({
      v: 1,
      orchestration: {
        summary: '汇总',
        structured: true,
        partial: true,
        unresolved: ['doc-research 子任务被截断，未产出报告'],
        subtasks: { total: 1, ok: 0, failed: 0, cancelled: 0, limited: 1, ids: ['st_1'] },
        gaps: { failed: 0, cancelled: 0, limited: 1, unresolved: 1, total: 2 },
      },
      subtasks: [
        {
          subtaskId: 'st_1',
          specId: 'doc-research',
          specTitle: '资料调研',
          objective: '调研记账功能',
          status: 'limit_reached',
          failureReason: '子任务达到最大工具调用数 16',
          steps: 7,
          modelCalls: 6,
          toolCalls: 16,
          durationMs: 58000,
          usage: { promptTokens: 20000, completionTokens: 8439, totalTokens: 28439, costUsd: 0.0015, isEstimate: false },
        },
      ],
    }),
    ...overrides,
  };
}

test('41a) 分层量化：子任务消耗单列，"合计"= 主 Agent + 子任务', () => {
  const { markdown, meta } = buildRunReport({ run: makeRun(), events: makeEvents(), generatedAt: TS });
  assert.equal(meta.steps, 3);
  assert.equal(meta.modelCalls, 3);
  assert.equal(meta.toolCalls, 3);
  assert.equal(meta.subtask.toolCalls, 16, '子任务工具调用必须单列');
  assert.equal(meta.subtask.limited, 1);
  assert.equal(meta.totalTokens, 1200 + 28439, '合计 tokens = 主 Agent + 子任务');
  assert.ok(Math.abs(meta.costUsd - (0.002 + 0.0015)) < 1e-9);
  // headline 用 `3+16 工具` 这种写法，避免"干净的 3 步完成"错觉
  assert.match(meta.headline, /3\+16 工具/);
  assert.match(markdown, /\| \*\*合计\*\* \|/);
  assert.match(markdown, /29,639/);
});

test('41b) 流程图只画主 Agent 的 step；子任务单画一张，且按 span 树归属工具', () => {
  const { markdown } = buildRunReport({ run: makeRun(), events: makeEvents(), generatedAt: TS });
  const flow = markdown.slice(markdown.indexOf('## 2. 执行流程图'), markdown.indexOf('### 2.1 子任务与汇总'));
  assert.ok(flow.includes('S1') && flow.includes('S2') && flow.includes('S3'), '主流程含 step 1..3');
  assert.ok(!flow.includes('S4'), '子任务自己的 step 4 不得出现在主流程图（实测缺陷回归）');
  // 子任务工具：tool_completed/tool_failed 是裸名 + 无 parentId → 必须回溯到子任务
  assert.match(markdown, /\| `doc-research\/fetch_page` \| 2 \| 1 \| [^|]+ \| 子任务 \|/);
  assert.match(markdown, /\| `delegate_subtasks` \| 2 \| 1 \| [^|]+ \| 主 Agent \|/);
  // 分步明细表只有 3 行（不含子任务的 step）
  const stepTable = markdown.slice(markdown.indexOf('## 3. 分步明细'), markdown.indexOf('## 4. 子任务明细'));
  assert.equal((stepTable.match(/^\| \d+ \|/gm) ?? []).length, 3);
});

test('41c) 六阶段归因：自愈的失败记 gap、限流截断记 fail、partial 记 gap、未审批记 na', () => {
  const { markdown, meta } = buildRunReport({ run: makeRun(), events: makeEvents(), generatedAt: TS });
  const byId = new Map(meta.stages.map((s) => [s.id, s.verdict]));
  assert.equal(byId.get('intake'), 'ok');
  assert.equal(byId.get('model'), 'ok');
  assert.equal(byId.get('tool'), 'gap', 'INVALID_ARGS 被后续成功覆盖 → gap 而非 fail');
  assert.equal(byId.get('subtask'), 'fail', 'limit_reached 子任务 → fail');
  assert.equal(byId.get('approval'), 'na');
  assert.equal(byId.get('delivery'), 'gap', 'partial + 未解决项 → gap');
  assert.match(markdown, /## 7. 缺口与未解决项/);
  assert.match(markdown, /缺口计数（`orchestration.gaps`）：[^\n]*合计 2/);
  assert.match(markdown, /partial：\*\*true\*\*/);
});

test('41d) meta 可解析（首行注释）且与 buildRunReport 返回的一致', () => {
  const { markdown, meta } = buildRunReport({ run: makeRun(), events: makeEvents(), generatedAt: TS });
  const parsed = parseRunReportMeta(markdown);
  assert.deepEqual(parsed, meta);
  assert.equal(parsed?.runId, RUN_ID);
});

test('41e) 旧口径数据（无 gaps / 无 subtasks）不报错，走现场统计与回退文案', () => {
  const run = makeRun({
    resultJson: JSON.stringify({
      v: 1,
      orchestration: { summary: '汇总', structured: true, subtasks: { total: 1, ok: 1, failed: 0, cancelled: 0, ids: ['st_x'] } },
    }),
  });
  const { markdown, meta } = buildRunReport({ run, events: makeEvents(), generatedAt: TS });
  assert.equal(meta.gaps, null);
  assert.equal(meta.subtask.total, 0, 'resultJson 里没有 subtasks 明细 → 子任务层为空');
  assert.match(markdown, /无 `gaps` 字段（\*\*旧 run 或老口径数据\*\*）且 `resultJson.subtasks` 无明细/);
});

test('41f) INDEX 重建：排序 + 图例 + 幂等', () => {
  const base = buildRunReport({ run: makeRun(), events: makeEvents(), generatedAt: TS }).meta;
  const older: RunReportMeta = { ...base, runId: 'run_aaa', headline: 'orchestrator · completed' };
  const index = buildRunReportIndex([older, base]);
  const lines = index.trimEnd().split('\n');
  assert.match(index, /阶段/);
  const firstDataRow = lines.find((l) => l.startsWith('| [`run_'));
  assert.ok(firstDataRow?.includes(RUN_ID), 'runId 倒序：新的在前');
  assert.equal(index, buildRunReportIndex([older, base]), '同样输入 → 同样字节（幂等）');
});

test('41g) 落盘：写文件 + 全量重建 INDEX + 重复写不产生漂移', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mta-runreport-'));
  try {
    const run = makeRun();
    const first = writeRunReport({ dir, run, events: makeEvents(), generatedAt: TS });
    assert.ok(existsSync(first.file));
    assert.equal(first.meta.runId, RUN_ID);
    const bytes1 = readFileSync(first.file, 'utf8');
    // 再写一次（同输入）→ 字节相同（幂等），且临时文件不残留
    writeRunReport({ dir, run, events: makeEvents(), generatedAt: TS });
    assert.equal(readFileSync(first.file, 'utf8'), bytes1);
    assert.ok(!existsSync(`${first.file}.tmp`), '临时文件必须被 rename 掉');
    const idx = regenerateRunReportIndex(dir);
    assert.equal(idx.count, 1);
    assert.ok(existsSync(join(dir, 'INDEX.md')));
    assert.equal(listRunReportMetas(dir).length, 1);
    // 坏文件不影响索引重建
    writeFileSync(join(dir, 'broken.md'), '# 没有 meta 的报告', 'utf8');
    assert.equal(listRunReportMetas(dir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('41h) 审批阶段归因：verification / change 事件进入报告，失败验证与回滚可见', () => {
  const withChanges = (ok: boolean): TraceEvent[] => {
    const events = makeEvents();
    let seq = Math.max(...events.map((e) => e.seq));
    const add = (type: TraceEventType, data: Record<string, unknown>) => {
      seq += 1;
      events.push({ runId: RUN_ID, seq, type, timestamp: TS, data });
    };
    add('approval_requested', { approvalId: 'ap_41h', files: [{ relPath: 'src/a.ts', op: 'edit' }] });
    add('verification_started', { level: 'L2', phase: 'host', files: ['src/a.ts'] });
    add('verification_completed', { level: 'L2', phase: 'host', ok });
    add('change_applied', { approvalId: 'ap_41h', applied: ['src/a.ts'], refused: [] });
    if (!ok) add('change_rolled_back', { approvalId: 'ap_41h', files: ['src/a.ts'], reason: 'tests failed' });
    return events;
  };

  const ok = buildRunReport({ run: makeRun(), events: withChanges(true), generatedAt: TS });
  const okStage = ok.meta.stages.find((s) => s.id === 'approval')!;
  assert.equal(okStage.verdict, 'ok');
  assert.match(ok.markdown, /验证 1 次（失败 0、取消 0）；落盘 1 个文件、回滚 0 个/);
  assert.match(ok.markdown, /验证开始：1/);
  assert.match(ok.markdown, /落盘文件：1/);

  const bad = buildRunReport({ run: makeRun(), events: withChanges(false), generatedAt: TS });
  const badStage = bad.meta.stages.find((s) => s.id === 'approval')!;
  assert.equal(badStage.verdict, 'fail');
  assert.match(bad.markdown, /验证 1 次（失败 1、取消 0）；落盘 1 个文件、回滚 1 个/);
  assert.match(bad.markdown, /验证失败\/取消：1\/0/);
});
