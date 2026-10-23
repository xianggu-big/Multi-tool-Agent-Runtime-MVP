// tests/66_tool_input_compat.test.ts — 真实模型输入兼容层（T6 实测驱动）
//
// 2026-10-23 的真实 run 里反复出现三类「格式不完全符合 schema」的调用：
//   - delegate_subtasks：把数组序列化成 JSON 字符串传入；
//   - submit_orchestration：conflicts 传字符串数组；
//   - code-edit 子 Agent：看到 run_tests 但调用只得到 DISABLED。
// 这些都不是模型「理解错任务」，而是工具边界太硬、白烧调用。本套件钉死兼容行为。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delegateSubtasks, normalizeSubtasks } from '../src/tools/orchestrator/delegateSubtasks.js';
import { submitOrchestration } from '../src/tools/orchestrator/submitOrchestration.js';
import { subAgentToolNames } from '../src/runtime/subAgentTools.js';
import { makeCtx } from './helpers.js';
import type { SubtaskOutcome } from '../src/types.js';

test('66a) delegate_subtasks 接受 JSON 字符串，并按同一份 schema 校验', async () => {
  const calls: unknown[] = [];
  const ctx = makeCtx({
    allowedPermissions: ['orchestrator:delegate'],
    spawnSubAgent: async (req) => {
      calls.push(req);
      return {
        subtaskId: 'st_test',
        specId: req.specId,
        specTitle: '目录清点子 Agent',
        objective: req.objective,
        status: 'ok',
        report: { summary: 'ok', structured: true, confidence: 'high', evidence: ['dir_stats:src'] },
        steps: 1,
        modelCalls: 1,
        toolCalls: 1,
        durationMs: 5,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0, isEstimate: true },
      } as SubtaskOutcome;
    },
  });

  const res = await delegateSubtasks.execute(
    { subtasks: JSON.stringify([{ specId: 'dir-inventory', objective: '清点 src', inputs: { dir: 'src' } }]) },
    ctx,
  );
  assert.equal(res.ok, true, res.error?.message);
  assert.equal(calls.length, 1, '字符串必须被解析成 1 个子任务');

  const bad = await delegateSubtasks.execute({ subtasks: '[{specId:' }, ctx);
  assert.equal(bad.ok, false);
  assert.equal(bad.error?.code, 'INVALID_ARGS');
  assert.match(bad.error?.message ?? '', /不是合法 JSON/);

  const wrongShape = normalizeSubtasks(JSON.stringify([{ specId: 'dir-inventory' }]));
  assert.ok('error' in wrongShape, '解析后仍要做契约校验（缺 objective 必须拒绝）');
});

test('66b) submit_orchestration 接受字符串 conflicts：保留原文并诚实标为未结构化', async () => {
  const ctx = makeCtx({ allowedPermissions: ['orchestrator:report'] });
  const res = await submitOrchestration.execute(
    {
      summary: '两个子任务结论冲突',
      conflicts: ['A 说测试通过、B 说测试失败；用 B 的复跑结果为准'],
    },
    ctx,
  );
  assert.equal(res.ok, true, res.error?.message);
  const conflicts = (res.data as any).conflicts as Array<{ between: string[]; topic: string; resolution: string }>;
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].between, ['（未标注）'], '不能编造冲突方 id');
  assert.match(conflicts[0].topic, /A 说测试通过/);
  assert.match(conflicts[0].resolution, /人工复核/);
});

test('66c) 子 Agent 工具列表与部署开关一致：run_tests 关闭时不可见', () => {
  const names = ['read_file', 'run_tests', 'not_registered'];
  assert.deepEqual(
    subAgentToolNames(names, { registryHas: (n) => n !== 'not_registered', runTestsEnabled: false }),
    ['read_file'],
  );
  assert.deepEqual(
    subAgentToolNames(names, { registryHas: (n) => n !== 'not_registered', runTestsEnabled: true }),
    ['read_file', 'run_tests'],
  );
});
