// tests/55_edit_eval.test.ts — 编辑管线评测的汇总/报告口径回归（纯函数，不连 Docker）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyEditOutcome,
  renderEditEvalReport,
  summarizeEditEval,
  type EditEvalCaseResult,
} from '../src/evaluation/editEval.js';

function result(over: Partial<EditEvalCaseResult> = {}): EditEvalCaseResult {
  return {
    id: 'E1',
    title: '样例',
    expected: 'applied',
    status: 'passed',
    wallMs: 100,
    approvalCount: 1,
    applied: ['src/a.ts'],
    rolledBack: [],
    sandbox: { ran: true, ok: true, steps: [{ source: 'l1-tests', ok: true, summary: 'ok' }] },
    host: { ran: true, ok: true, mode: 'full_suite', coverage: 'full', note: 'ok' },
    postFiles: {},
    assertions: [],
    notes: [],
    tokens: 0,
    costUsd: 0,
    ...over,
  };
}

test('55a) 结果分类：回滚优先于落盘，拒绝/沙箱/TOCTOU 可区分', () => {
  assert.equal(classifyEditOutcome({ applied: ['a'], rolledBack: ['a'], errorCode: undefined }), 'rolled_back');
  assert.equal(classifyEditOutcome({ applied: ['a'], rolledBack: [], errorCode: undefined }), 'applied');
  assert.equal(classifyEditOutcome({ applied: [], rolledBack: [], errorCode: 'APPROVAL_DENIED' }), 'approval_denied');
  assert.equal(classifyEditOutcome({ applied: [], rolledBack: [], errorCode: 'APPLY_FAILED' }), 'apply_refused');
  assert.equal(classifyEditOutcome({ applied: [], rolledBack: [], errorCode: 'SANDBOX_CHECK_FAILED' }), 'sandbox_rejected');
  assert.equal(classifyEditOutcome({ applied: [], rolledBack: [], errorCode: 'EVAL_EXCEPTION' }), 'unknown');
});

test('55b) 汇总：跳过不计入分母，审批/落盘/回滚/宿主通过率分别统计', () => {
  const s = summarizeEditEval([
    result({ id: 'E1', wallMs: 100 }),
    result({ id: 'E2', wallMs: 200, applied: ['a', 'b'], approvalCount: 1 }),
    result({
      id: 'E3',
      status: 'failed',
      expected: 'sandbox_rejected',
      approvalCount: 0,
      applied: [],
      sandbox: { ran: true, ok: false, steps: [] },
      host: null,
      errorCode: 'SANDBOX_CHECK_FAILED',
    }),
    result({ id: 'E6', status: 'skipped', applied: [], approvalCount: 0, sandbox: { ran: false, ok: false, steps: [] }, host: null }),
  ]);
  assert.equal(s.total, 4);
  assert.equal(s.run, 3);
  assert.equal(s.passed, 2);
  assert.equal(s.failed, 1);
  assert.equal(s.skipped, 1);
  assert.equal(s.passRate, 2 / 3);
  assert.equal(s.approvals, 2);
  assert.equal(s.appliedFiles, 3);
  assert.equal(s.rollbacks, 0);
  assert.equal(s.sandboxRuns, 3);
  assert.equal(s.sandboxPassed, 2);
  assert.equal(s.hostRuns, 2);
  assert.equal(s.hostPassed, 2);
  assert.equal(s.tokens, 0);
  assert.deepEqual(s.failureClasses, [{ key: 'SANDBOX_CHECK_FAILED', count: 1 }]);
});

test('55c) 报告必须明说不是模型能力评测，且保留 token/cost 口径', () => {
  const md = renderEditEvalReport(
    {
      generatedAt: '2026-10-20T00:00:00.000Z',
      command: 'npm run eval:edit',
      platform: 'win32 x64',
      node: 'v24.14.1',
      hostNodePath: 'D:/node/node.exe',
      dockerImage: 'mta-sandbox:node24',
      evidenceDir: 'multi-tool-agent/data/edit-eval/x',
    },
    [result()],
  );
  assert.match(md, /不是模型能力评测/);
  assert.match(md, /Token \/ 成本 \| 0 \/ \$0\.0000/);
  assert.match(md, /预期结果命中/);
  assert.match(md, /## 5\. 失败分类/);
  assert.match(md, /无（所有运行场景均达到预期）/);
});

test('55d) 报告展示跳过场景，但不把跳过算作通过', () => {
  const md = renderEditEvalReport(
    {
      generatedAt: '2026-10-20T00:00:00.000Z',
      command: 'npm run eval:edit',
      platform: 'linux x64',
      node: 'v24.14.1',
      hostNodePath: '/usr/bin/node',
      dockerImage: 'mta-sandbox:node24',
      evidenceDir: 'evidence',
    },
    [
      result({
        id: 'E6',
        status: 'skipped',
        skipReason: '宿主平台不适用',
        approvalCount: 0,
        applied: [],
        sandbox: { ran: false, ok: false, steps: [] },
        host: null,
      }),
    ],
  );
  assert.match(md, /⏭️/);
  assert.match(md, /宿主平台不适用/);
  assert.match(md, /\| 场景（运行 \/ 跳过 \/ 总计） \| 0 \/ 1 \/ 1 \|/);
  assert.match(md, /\| 预期结果命中 \| 0\/0（0\.0%） \|/);
});

test('55e) 失败分类按错误码聚合且稳定排序', () => {
  const s = summarizeEditEval([
    result({ id: 'E1', status: 'failed', errorCode: 'APPLY_FAILED', applied: [], approvalCount: 1, host: null }),
    result({ id: 'E2', status: 'failed', errorCode: 'SANDBOX_CHECK_FAILED', applied: [], approvalCount: 0, host: null }),
    result({ id: 'E3', status: 'failed', errorCode: 'APPLY_FAILED', applied: [], approvalCount: 1, host: null }),
  ]);
  assert.equal(s.failed, 3);
  assert.deepEqual(s.failureClasses, [
    { key: 'APPLY_FAILED', count: 2 },
    { key: 'SANDBOX_CHECK_FAILED', count: 1 },
  ]);
});