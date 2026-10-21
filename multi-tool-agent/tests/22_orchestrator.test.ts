// tests/22_orchestrator.test.ts — 多 Agent 编排（主 Agent 调度 + 并行子 Agent）
// 覆盖：规则式预筛、契约校验（防偷偷提权）、宽度/深度守卫、并行执行与等价性、
//       部分失败显式化、契约未履行标注、级联取消、父子 trace 关联、
//       汇总上报的业务校验、HTTP 端到端与契约目录接口。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildRuntime } from '../src/runtime/index.js';
import { createApp, validateRunRequest } from '../src/server.js';
import { TOOL_PERMISSION } from '../src/runtime/AgentRuntime.js';
import { summarizeSubtasks, summarizeSubtaskUsage, toOrchestrationReport } from '../src/runtime/AgentRuntime.js';
import { buildRegistry } from '../src/tools/index.js';
import { SubAgentPool, effectiveConcurrency } from '../src/runtime/SubAgentPool.js';
import { preSplitSubtasks, extractTopics, pickTopLevelDirs } from '../src/runtime/preSplit.js';
import { classifyTask, looksMultiPartition } from '../src/runtime/router.js';
import { SUB_AGENT_SPECS, getSpec, listSpecIds, validateSpecs, type SubAgentSpec } from '../src/agents/specs.js';
import { submitFinding } from '../src/tools/orchestrator/submitFinding.js';
import { submitOrchestration } from '../src/tools/orchestrator/submitOrchestration.js';
import { buildTraceSnapshot } from '../src/trace/Tracer.js';
import { makeCtx, mockProvider } from './helpers.js';
import type { MockResponder } from '../src/llm/MockProvider.js';
import type { RunInput, SubtaskOutcome } from '../src/types.js';

const WORKSPACE = resolve('demo/codebase-sample');

function orchRuntime() {
  const config = loadConfig();
  config.stream.liveDeltas = false;
  return buildRuntime(config, ':memory:');
}

/** 子 Agent 的工具池：应从子任务的 tool_started 事件推断（主 Agent 的池里才有 delegate_subtasks） */
function offeredToolNames(events: { type: string; data?: unknown }[]): string[] {
  return events.filter((e) => e.type === 'tool_started').map((e) => String((e.data as any)?.name ?? ''));
}

function orchInput(over: Partial<RunInput> = {}): RunInput {
  return { runType: 'orchestrator', goal: '清点并审计仓库', repoPath: WORKSPACE, ...over };
}

const orchestratorResponder: MockResponder = (ctx) => {
  const names = ctx.tools.map((t) => t.name);
  if (names.includes('delegate_subtasks')) {
    if (ctx.callIndex === 0) {
      return {
        stopReason: 'tool_use',
        content: '拆分',
        toolCalls: [
          {
            id: 'c1',
            name: 'delegate_subtasks',
            arguments: {
              subtasks: [
                { specId: 'dir-inventory', objective: '清点 src', inputs: { dir: 'src' } },
                { specId: 'code-audit', objective: '审计 src', inputs: { dir: 'src' } },
              ],
            },
          },
        ],
      };
    }
    return {
      stopReason: 'tool_use',
      content: '汇总',
      toolCalls: [
        {
          id: 'c2',
          name: 'submit_orchestration',
          arguments: {
            summary: '两个子任务完成',
            findings: [{ from: 'dir-inventory', note: 'src 有若干文件' }],
          },
        },
      ],
    };
  }
  if (names.includes('dir_stats')) {
    return ctx.callIndex === 0
      ? { stopReason: 'tool_use', content: '统计', toolCalls: [{ id: 's1', name: 'dir_stats', arguments: { dir: 'src', maxDepth: 2 } }] }
      : {
          stopReason: 'tool_use',
          content: '上报',
          toolCalls: [
            {
              id: 's2',
              name: 'submit_finding',
              arguments: { summary: 'src 清点完成', items: [{ label: '文件数', value: 3 }], evidence: ['dir_stats:src'], confidence: 'high' },
            },
          ],
        };
  }
  if (names.includes('search_files')) {
    return {
      stopReason: 'tool_use',
      content: '上报',
      toolCalls: [
        {
          id: 's3',
          name: 'submit_finding',
          arguments: { summary: '未发现硬编码', findings: [{ path: 'src/calc.js', note: '无异常' }], evidence: ['src/calc.js:1'], confidence: 'medium' },
        },
      ],
    };
  }
  return { stopReason: 'end_turn', content: '（兜底）' };
};

// ---------------------------------------------------------------------------
// 1. 规则式预筛（零 token）
// ---------------------------------------------------------------------------

test('22a) 预筛：按目录/主题切出候选子任务，去重且不超过宽度上限', () => {
  const dirs = ['src', 'test'];
  const inventory = preSplitSubtasks('清点这个仓库有多少文件、大小分布如何', { dirs, maxWidth: 4 });
  assert.ok(inventory.length >= 2);
  assert.ok(inventory.every((s) => s.specId === 'dir-inventory'));
  assert.deepEqual(inventory.map((s) => s.inputs?.dir), ['src', 'test']);
  assert.ok(inventory[0].objective.length > 0 && inventory[0].boundary, '每条建议都应带目标与边界');

  const audit = preSplitSubtasks('审计代码里的 TODO 与可疑硬编码', { dirs, maxWidth: 3 });
  assert.ok(audit.every((s) => s.specId === 'code-audit'));
  assert.ok(audit.length <= 3, '不得超过宽度上限');

  const research = preSplitSubtasks('调研 esbuild、rollup、vite 的差异', { topics: ['esbuild', 'rollup', 'vite'], maxWidth: 4 });
  assert.equal(research.length, 3);
  assert.ok(research.every((s) => s.specId === 'doc-research'));

  // 无信号 → 不给建议（而不是硬造）
  assert.deepEqual(preSplitSubtasks('你好', { dirs, maxWidth: 4 }), []);
});

test('22a2) 分流器升级判定：多分区只读任务 → 建议多 Agent 编排；出现改代码信号则仍交 Codebase', () => {
  const orch = classifyTask('分别清点 src 和 test 目录的文件数与 TODO');
  assert.equal(orch.runType, 'orchestrator', `应建议编排，实际 ${orch.runType}`);
  assert.match(orch.reason, /可拆成多个相互独立的子任务/);

  const multi = classifyTask('逐个检查每个目录的代码规范');
  assert.equal(multi.runType, 'orchestrator');

  // 有改代码信号 → 不抢 Codebase 的活
  const code = classifyTask('分别重构 src 和 test 目录并跑测试');
  assert.equal(code.runType, 'codebase');

  // 单分区琐事 → 仍是 misc（不要过度编排：并列连接词本身不足以判定可扇出）
  assert.equal(classifyTask('这个目录有多少文件').runType, 'misc');
  assert.equal(classifyTask('清点一下 demo 目录有多少文件、总大小多少').runType, 'misc');
  assert.equal(looksMultiPartition('这个目录有多少文件'), false);
  assert.equal(looksMultiPartition('清点 demo 目录有多少文件、总大小多少'), false);
  assert.equal(looksMultiPartition('分别清点 src 和 test'), true);
  assert.equal(looksMultiPartition('对比 src 和 test 的文件数'), true);
});

test('22b) 预筛：提取主题 & 列举顶层目录（忽略依赖/隐藏目录）', () => {
  const topics = extractTopics('帮我调研 esbuild 和 rollup 的增量构建差异');
  assert.ok(topics.includes('esbuild'));
  assert.ok(topics.length >= 2);

  const dirs = pickTopLevelDirs(WORKSPACE);
  assert.ok(dirs.includes('src'), `示例仓库应有 src，实际: ${dirs.join(',')}`);
  assert.ok(!dirs.includes('node_modules'));

  // 取一个不存在的目录：返回空而不是抛错
  assert.deepEqual(pickTopLevelDirs(resolve('no/such/dir')), []);
});

// ---------------------------------------------------------------------------
// 2. 契约校验（防偷偷提权）
// ---------------------------------------------------------------------------

test('22c) 契约自校验：内置三个 spec 与工具表完全一致（0 error）', () => {
  const registry = buildRegistry();
  const issues = validateSpecs(SUB_AGENT_SPECS, TOOL_PERMISSION, registry.names(), { maxStepsHardLimit: 20 });
  const errors = issues.filter((i) => i.level === 'error');
  assert.deepEqual(errors, [], `契约不应有 error，实际: ${JSON.stringify(errors)}`);
  assert.ok(listSpecIds().length >= 3);
});

test('22d) 契约自校验能抓出「权限超集」（偷偷提权）与「工具未注册」', () => {
  const registry = buildRegistry();
  const bad: SubAgentSpec = {
    ...SUB_AGENT_SPECS[0],
    id: 'bad-spec',
    tools: ['dir_stats', 'submit_finding', 'run_tests'], // run_tests 未声明权限 + 权限超集
    permissions: ['misc:read', 'agent:report', 'codebase:test', 'research:web'],
  };
  const issues = validateSpecs([bad], TOOL_PERMISSION, registry.names(), {});
  const msgs = issues.map((i) => i.message).join(' | ');
  assert.match(msgs, /权限超集/);
  assert.ok(!getSpec('bad-spec'));

  const missingTool: SubAgentSpec = { ...SUB_AGENT_SPECS[0], id: 'x', tools: ['dir_stats', 'submit_finding', 'not_registered'] };
  const issues2 = validateSpecs([missingTool], TOOL_PERMISSION, registry.names(), {});
  assert.ok(issues2.some((i) => i.level === 'error' && /工具未注册/.test(i.message)));

  const noReport: SubAgentSpec = { ...SUB_AGENT_SPECS[0], id: 'y', tools: ['dir_stats'], permissions: ['misc:read'] };
  const issues3 = validateSpecs([noReport], TOOL_PERMISSION, registry.names(), {});
  assert.ok(issues3.some((i) => /缺少终结性上报工具/.test(i.message)));
});

// ---------------------------------------------------------------------------
// 3. 结构层守卫（宽度 / 深度 / 规格）
// ---------------------------------------------------------------------------

test('22e) 宽度守卫：单次派发超过 maxWidth 被结构层拒绝', async () => {
  const { runtime, store } = orchRuntime();
  const responder: MockResponder = (ctx) => {
    if (ctx.tools.some((t) => t.name === 'delegate_subtasks') && ctx.callIndex === 0) {
      return {
        stopReason: 'tool_use',
        content: '超宽派发',
        toolCalls: [
          {
            id: 'c1',
            name: 'delegate_subtasks',
            arguments: {
              subtasks: Array.from({ length: 5 }, (_, i) => ({ specId: 'dir-inventory', objective: `清点分区 ${i}`, inputs: { dir: `d${i}` } })),
            },
          },
        ],
      };
    }
    return { stopReason: 'end_turn', content: '结束' };
  };
  const input = orchInput();
  const runId = runtime.createRun(input, mockProvider(responder));
  const result0 = await runtime.run(input, runId);

  const events = runtime.getEvents(runId);
  const failed = events.filter((e) => e.type === 'tool_failed');
  assert.ok(failed.some((e) => (e.data as any).code === 'WIDTH_LIMIT'), `应出现 WIDTH_LIMIT，实际: ${JSON.stringify(failed.map((f) => (f.data as any).code))}`);
  // 宽度被拒 → 不应产生任何子任务记录（主 Agent 只拿到错误，随后自己结束）
  assert.equal((result0?.subtasks ?? []).length, 0, '宽度被拒时不应有子任务');
  const persisted = store.getRun(runId)!;
  assert.equal((JSON.parse(persisted.resultJson ?? '{}').subtasks ?? []).length, 0);
});

test('22f) 深度守卫：子 Agent 结构上无法再委派（上下文不注入 spawnSubAgent）', async () => {
  const { runtime } = orchRuntime();
  /** 子 Agent 角色被调用时它「看得到」的工具清单（用于验证披露层） */
  let subAgentOfferedTools: string[] = [];
  // 让「子 Agent」尝试调用 delegate_subtasks：它的工具池里根本没有这个工具 → UNKNOWN_TOOL
  const responder: MockResponder = (ctx) => {
    const isMain = ctx.tools.some((t) => t.name === 'delegate_subtasks');
    if (isMain && ctx.callIndex === 0) {
      return {
        stopReason: 'tool_use',
        content: '派发',
        toolCalls: [{ id: 'c1', name: 'delegate_subtasks', arguments: { subtasks: [{ specId: 'dir-inventory', objective: '清点 src', inputs: { dir: 'src' } }] } }],
      };
    }
    if (isMain) return { stopReason: 'tool_use', content: '汇总', toolCalls: [{ id: 'c2', name: 'submit_orchestration', arguments: { summary: '完成' } }] };
    // 子 Agent：记录它被披露的工具清单，并试图递归委派
    subAgentOfferedTools = ctx.tools.map((t) => t.name);
    if (ctx.callIndex === 0) {
      return {
        stopReason: 'tool_use',
        content: '我想再派个子 Agent',
        toolCalls: [{ id: 'r1', name: 'delegate_subtasks', arguments: { subtasks: [{ specId: 'dir-inventory', objective: 'x' }] } }],
      };
    }
    return { stopReason: 'tool_use', content: '放弃', toolCalls: [{ id: 'r2', name: 'submit_finding', arguments: { summary: '无法递归委派' } }] };
  };
  const input = orchInput();
  const runId = runtime.createRun(input, mockProvider(responder));
  const result = await runtime.run(input, runId);

  const codes = runtime
    .getEvents(runId)
    .filter((e) => e.type === 'tool_failed')
    .map((e) => (e.data as any).code);
  // 两道防线：① 披露层——子 Agent 的工具定义里根本没有 delegate_subtasks；
  //            ② 授权层——即使模型硬调，也会因缺少 orchestrator:delegate 权限被拒（注册≠授权）
  assert.ok(
    codes.includes('PERMISSION_DENIED') || codes.includes('UNKNOWN_TOOL'),
    `子 Agent 的递归委派必须被拒绝，实际错误码: ${codes.join(',')}`,
  );
  assert.equal(result.subtasks?.length, 1, '只应有一个层级的子任务（深度=1）');
  // 披露层：子 Agent 的工具定义里不应出现 delegate_subtasks / submit_orchestration
  assert.ok(subAgentOfferedTools.length > 0, '应捕获到子 Agent 的工具清单');
  assert.ok(!subAgentOfferedTools.includes('delegate_subtasks'), `子 Agent 不应看到委派工具，实际: ${subAgentOfferedTools.join(',')}`);
  assert.ok(!subAgentOfferedTools.includes('submit_orchestration'));
  assert.deepEqual([...subAgentOfferedTools].sort(), [...(getSpec('dir-inventory')!.tools)].sort(), '子 Agent 只应看到自己契约里的工具');
});

test('22g) 规格守卫：未知 specId / 白名单外的 spec 被拒绝', async () => {
  const { runtime } = orchRuntime();
  const responder: MockResponder = (ctx) => {
    if (ctx.tools.some((t) => t.name === 'delegate_subtasks') && ctx.callIndex === 0) {
      return {
        stopReason: 'tool_use',
        content: '派发不存在的规格',
        toolCalls: [{ id: 'c1', name: 'delegate_subtasks', arguments: { subtasks: [{ specId: 'no-such-spec', objective: 'x' }] } }],
      };
    }
    return { stopReason: 'end_turn', content: '结束' };
  };
  const input = orchInput();
  const runId = runtime.createRun(input, mockProvider(responder));
  await runtime.run(input, runId);
  const codes = runtime.getEvents(runId).filter((e) => e.type === 'tool_failed').map((e) => (e.data as any).code);
  assert.ok(codes.includes('UNKNOWN_SPEC'));
});

// ---------------------------------------------------------------------------
// 4. 并行执行 / 等价性 / 部分失败
// ---------------------------------------------------------------------------

test('22h) 并行执行：多个子任务各自独立完成，结果顺序稳定且带证据', async () => {
  const { runtime } = orchRuntime();
  const input = orchInput();
  const runId = runtime.createRun(input, mockProvider(orchestratorResponder));
  const result = await runtime.run(input, runId);

  assert.equal(result.status, 'completed');
  const subtasks = result.subtasks ?? [];
  assert.equal(subtasks.length, 2);
  assert.deepEqual(subtasks.map((s) => s.specId), ['dir-inventory', 'code-audit'], '顺序应与派发顺序一致');
  assert.ok(subtasks.every((s) => s.status === 'ok'));
  assert.ok(subtasks.every((s) => s.report?.structured === true), '子 Agent 必须按契约结构化上报');
  assert.ok(subtasks.every((s) => (s.report?.evidence?.length ?? 0) > 0), '应带证据指针');
  assert.ok(subtasks.every((s) => s.modelCalls >= 1 && s.usage.totalTokens >= 0));

  // 子任务用的是各自的工具池（清点子 Agent 走了 dir_stats；审计子 Agent 没走 dir_stats）
  const events = runtime.getEvents(runId);
  // 子 Agent 的工具 span 名带 spec 前缀（dir-inventory/dir_stats），主 Agent 的不带
  const toolStartNames = events.filter((e) => e.type === 'tool_started').map((e) => String((e.data as any).name));
  assert.ok(toolStartNames.includes('dir-inventory/dir_stats'), `清点子 Agent 应调用 dir_stats，实际: ${toolStartNames.join(',')}`);
  assert.ok(!toolStartNames.some((n) => n.includes('web_search')), '不应出现未被委派的工具');
  assert.ok(!toolStartNames.some((n) => n.includes('run_tests')), '子 Agent 不应能跑命令');

  // 汇总报告：统计口径来自 Runtime（不采信模型自报）
  const orch = result.orchestration!;
  assert.equal(orch.structured, true);
  assert.deepEqual(orch.subtasks, { total: 2, ok: 2, failed: 0, cancelled: 0, limited: 0, ids: subtasks.map((s) => s.subtaskId) });
  assert.ok((orch.findings ?? []).some((f) => f.from === 'dir-inventory'));
});

test('22i) 部分失败显式化：失败子任务不会被隐藏，Runtime 统计会覆盖模型自报', async () => {
  const { runtime } = orchRuntime();
  const responder: MockResponder = (ctx) => {
    const names = ctx.tools.map((t) => t.name);
    if (names.includes('delegate_subtasks')) {
      if (ctx.callIndex === 0) {
        return {
          stopReason: 'tool_use',
          content: '派发两个',
          toolCalls: [
            {
              id: 'c1',
              name: 'delegate_subtasks',
              arguments: {
                subtasks: [
                  { specId: 'dir-inventory', objective: '这个子任务会失败', inputs: { dir: 'src' } },
                  { specId: 'code-audit', objective: '这个是好的', inputs: { dir: 'src' } },
                ],
              },
            },
          ],
        };
      }
      // 模型在汇总里「只报成功」——Runtime 必须把失败补回 unresolved
      return {
        stopReason: 'tool_use',
        content: '汇总',
        toolCalls: [{ id: 'c2', name: 'submit_orchestration', arguments: { summary: '全部完成（其实不是）' } }],
      };
    }
    if (names.includes('dir_stats')) {
      // 该子 Agent 什么都不做、直接空文本结束 → EMPTY_RESULT 失败
      return { stopReason: 'end_turn', content: '' };
    }
    return {
      stopReason: 'tool_use',
      content: '上报',
      toolCalls: [{ id: 's3', name: 'submit_finding', arguments: { summary: '审计完成', evidence: ['src/calc.js:1'] } }],
    };
  };
  const input = orchInput();
  const runId = runtime.createRun(input, mockProvider(responder));
  const result = await runtime.run(input, runId);

  const subtasks = result.subtasks ?? [];
  assert.equal(subtasks.length, 2);
  const failedOne = subtasks.find((s) => s.status === 'failed');
  assert.ok(failedOne, `应有一个失败子任务，实际: ${JSON.stringify(subtasks.map((s) => s.status))}`);
  assert.equal(failedOne!.errorCode, 'EMPTY_RESULT');

  const orch = result.orchestration!;
  assert.equal(orch.subtasks?.failed, 1, 'Runtime 统计必须反映真实失败数');
  assert.ok(
    (orch.unresolved ?? []).some((u) => /子任务失败/.test(u)),
    '模型没提失败时，Runtime 应自动补一条 unresolved',
  );
});

test('22j) 契约未履行：子 Agent 用自由文本结束时标注 contractViolation', async () => {
  const { runtime } = orchRuntime();
  const responder: MockResponder = (ctx) => {
    const names = ctx.tools.map((t) => t.name);
    if (names.includes('delegate_subtasks')) {
      if (ctx.callIndex === 0) {
        return {
          stopReason: 'tool_use',
          content: '派发',
          toolCalls: [{ id: 'c1', name: 'delegate_subtasks', arguments: { subtasks: [{ specId: 'dir-inventory', objective: '不按契约上报', inputs: { dir: 'src' } }] } }],
        };
      }
      return { stopReason: 'tool_use', content: '汇总', toolCalls: [{ id: 'c2', name: 'submit_orchestration', arguments: { summary: '汇总' } }] };
    }
    return { stopReason: 'end_turn', content: '我觉得大概有十几个文件吧（没调用 submit_finding）' };
  };
  const input = orchInput();
  const runId = runtime.createRun(input, mockProvider(responder));
  const result = await runtime.run(input, runId);

  const st = result.subtasks![0];
  assert.equal(st.status, 'ok');
  assert.equal(st.report?.structured, false, '未按契约上报 → structured=false');
  assert.match(st.contractViolation!, /未调用 submit_finding/);
});

test('22k) 并发池：有界并发 + 级联取消 + 单任务异常不打断其他任务', async () => {
  const pool = new SubAgentPool(2);
  const seen: number[] = [];
  const results = await pool.map(
    [1, 2, 3, 4, 5],
    async (i) => {
      seen.push(i);
      return `ok-${i}`;
    },
    { concurrency: 2, abortedResult: () => 'cancelled' },
  );
  assert.deepEqual(results, ['ok-1', 'ok-2', 'ok-3', 'ok-4', 'ok-5'], '结果顺序应与入参一致');
  assert.equal(seen.length, 5);

  // 异常被转成结果，不打断整批
  const withError = await pool.map([1, 2, 3], async (i) => {
    if (i === 2) throw new Error('boom');
    return `ok-${i}`;
  }, { concurrency: 3, abortedResult: () => 'cancelled', errorResult: (_it, _i, e) => `err:${e.message}` });
  assert.deepEqual(withError, ['ok-1', 'err:boom', 'ok-3']);

  // 级联取消：并发 1，第一个任务里取消 → 后续全部走 abortedResult
  const ac = new AbortController();
  const cancelled = await pool.map([1, 2, 3], async (i) => {
    ac.abort();
    return `ok-${i}`;
  }, { concurrency: 1, signal: ac.signal, abortedResult: () => 'cancelled' });
  assert.equal(cancelled[0], 'ok-1');
  assert.deepEqual(cancelled.slice(1), ['cancelled', 'cancelled']);

  // 并行度计算：受配置与剩余预算共同约束
  assert.equal(effectiveConcurrency({ taskCount: 3, maxConcurrency: 4, perTaskTokenBudget: 1000 }).concurrency, 3);
  assert.equal(effectiveConcurrency({ taskCount: 8, maxConcurrency: 4, perTaskTokenBudget: 1000 }).concurrency, 4);
  const budgetLimited = effectiveConcurrency({ taskCount: 4, maxConcurrency: 4, remainingTokenBudget: 1500, perTaskTokenBudget: 1000 });
  assert.equal(budgetLimited.concurrency, 1);
  assert.match(budgetLimited.reason, /预算/);
});

// ---------------------------------------------------------------------------
// 5. trace 关联与汇总结构
// ---------------------------------------------------------------------------

test('22l) 父子 trace：子任务 span 挂在父 run 下，可在流程图/瀑布图中看到', async () => {
  const { runtime } = orchRuntime();
  const input = orchInput();
  const runId = runtime.createRun(input, mockProvider(orchestratorResponder));
  const result = await runtime.run(input, runId);

  const snap = buildTraceSnapshot(runId, result.status, runtime.getEvents(runId));
  const subtaskSpans = snap.spans.filter((s) => s.kind === 'subtask');
  assert.equal(subtaskSpans.length, 2, '两个子任务应产出两个 subtask span');
  assert.ok(subtaskSpans.every((s) => s.parentId === runId), 'subtask span 的父节点应是 run');
  assert.ok(subtaskSpans.every((s) => s.status === 'ok'));

  // 子任务内部的 llm/tool span 应挂在 subtask span 下
  const childOfSubtask = snap.spans.filter((s) => subtaskSpans.some((st) => st.spanId === s.parentId));
  assert.ok(childOfSubtask.length >= 2, '子任务的模型/工具调用应挂在 subtask span 之下');
});

test('22m) summarizeSubtasks / toOrchestrationReport：统计口径与自动补漏', () => {
  const base: SubtaskOutcome = {
    subtaskId: 'st_1',
    specId: 'dir-inventory',
    specTitle: 'x',
    objective: 'o',
    status: 'ok',
    steps: 1,
    modelCalls: 1,
    toolCalls: 1,
    durationMs: 1,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0, isEstimate: true },
  };
  const stats = summarizeSubtasks([base, { ...base, subtaskId: 'st_2', status: 'failed' }, { ...base, subtaskId: 'st_3', status: 'cancelled' }]);
  assert.deepEqual(stats, { total: 3, ok: 1, failed: 1, cancelled: 1, limited: 0, ids: ['st_1', 'st_2', 'st_3'] });

  const report = toOrchestrationReport({ summary: '汇总', findings: [{ from: 'a', note: 'n' }] }, [{ ...base, status: 'failed' }]);
  assert.equal(report.structured, true);
  assert.equal(report.subtasks?.failed, 1);
  assert.ok((report.unresolved ?? []).some((u) => /失败/.test(u)), '有失败时应自动补 unresolved');

  const noFail = toOrchestrationReport({ summary: '汇总' }, [base]);
  assert.equal(noFail.unresolved, undefined, '全部成功时不应无中生有');

  // 模型瞎报 subtasks 也无效：以 Runtime 统计为准
  const overridden = toOrchestrationReport({ summary: 's', subtasks: { total: 99, ok: 99, failed: 0, cancelled: 0, ids: [] } }, [base]);
  assert.equal(overridden.subtasks?.total, 1);
  assert.equal(overridden.subtaskUsage?.totalTokens, 2, 'Runtime 侧也要带上子任务消耗合计');

  // 2026-10-16 口径修正：limit_reached 独立成桶（不再并进 cancelled）
  const limitedStats = summarizeSubtasks([
    base,
    { ...base, subtaskId: 'st_2', status: 'failed' },
    { ...base, subtaskId: 'st_3', status: 'cancelled' },
    { ...base, subtaskId: 'st_4', status: 'limit_reached' },
  ]);
  assert.deepEqual(limitedStats, {
    total: 4,
    ok: 1,
    failed: 1,
    cancelled: 1,
    limited: 1,
    ids: ['st_1', 'st_2', 'st_3', 'st_4'],
  }, 'limit_reached 必须单列：并进 cancelled 会让 headline 看起来「0 失败」');

  // gaps：三类非 ok 子任务 + 模型自报的未解决问题（Runtime 自动补的那条不计入）
  const gapsReport = toOrchestrationReport({ summary: '汇总', unresolved: ['缺口 A'] }, [
    base,
    { ...base, subtaskId: 'st_2', status: 'failed' },
    { ...base, subtaskId: 'st_3', status: 'limit_reached' },
  ]);
  assert.deepEqual(gapsReport.gaps, { failed: 1, cancelled: 0, limited: 1, unresolved: 1, total: 3 });
  assert.equal(gapsReport.partial, true, '有非 ok 子任务时必须置 partial');

  // 只有模型自报 unresolved、无子任务缺口时不置 partial
  const unresolvedOnly = toOrchestrationReport({ summary: 's', unresolved: ['缺口 A'] }, [base]);
  assert.equal(unresolvedOnly.partial, undefined);
  assert.deepEqual(unresolvedOnly.gaps, { failed: 0, cancelled: 0, limited: 0, unresolved: 1, total: 1 });

  // subtaskUsage：run 级 counters 只算主 Agent，子任务消耗必须单独合计
  const usage = summarizeSubtaskUsage([
    base,
    {
      ...base,
      subtaskId: 'st_2',
      modelCalls: 3,
      toolCalls: 4,
      usage: { promptTokens: 5, completionTokens: 6, totalTokens: 11, costUsd: 0.25, isEstimate: false },
    },
  ]);
  assert.deepEqual(usage, { modelCalls: 4, toolCalls: 5, totalTokens: 13, costUsd: 0.25 });
});

// ---------------------------------------------------------------------------
// 6. 上报工具的业务校验
// ---------------------------------------------------------------------------

test('22n) submit_finding：high 置信度 + findings 必须有 evidence；escalateTo 必须带理由', async () => {
  const ctx = makeCtx({ allowedPermissions: ['misc:read', 'agent:report'] });

  const noEvidence = await submitFinding.execute(
    { summary: 'x', findings: [{ path: 'a.ts', note: 'n' }], confidence: 'high' },
    ctx,
  );
  assert.equal(noEvidence.ok, false);
  assert.equal(noEvidence.error?.code, 'EVIDENCE_REQUIRED');

  const okWithEvidence = await submitFinding.execute(
    { summary: 'x', findings: [{ path: 'a.ts', note: 'n' }], evidence: ['a.ts:1'], confidence: 'high' },
    ctx,
  );
  assert.equal(okWithEvidence.ok, true);

  const missingReason = await submitFinding.execute({ summary: 'x', escalateTo: 'codebase' }, ctx);
  assert.equal(missingReason.ok, false);
  assert.equal(missingReason.error?.code, 'MISSING_ESCALATE_REASON');
});

test('22o) submit_orchestration：升级人工必须写清未解决项', async () => {
  const ctx = makeCtx({ allowedPermissions: ['orchestrator:delegate', 'orchestrator:report'] });

  // 缺理由 → 先被 MISSING_ESCALATE_REASON 拦
  const noReason = await submitOrchestration.execute({ summary: 'x', escalateTo: 'human' }, ctx);
  assert.equal(noReason.ok, false);
  assert.equal(noReason.error?.code, 'MISSING_ESCALATE_REASON');

  // 有理由但没写未解决项 → UNRESOLVED_REQUIRED（不许「甩锅给人工」）
  const bad = await submitOrchestration.execute({ summary: 'x', escalateTo: 'human', escalateReason: '需要人工决策' }, ctx);
  assert.equal(bad.ok, false);
  assert.equal(bad.error?.code, 'UNRESOLVED_REQUIRED');

  const good = await submitOrchestration.execute(
    { summary: 'x', escalateTo: 'human', escalateReason: '需要人工决定', unresolved: ['A 子任务证据不足'] },
    ctx,
  );
  assert.equal(good.ok, true);
});

// ---------------------------------------------------------------------------
// 7. 服务端：校验 + HTTP 端到端 + 契约目录
// ---------------------------------------------------------------------------

test('22p) validateRunRequest：orchestrator 校验（工作区、spec 白名单、宽度收紧）', () => {
  const config = loadConfig();

  assert.match(validateRunRequest({ runType: 'orchestrator', goal: 'g' }, config).error!, /repoPath/);
  assert.match(
    validateRunRequest({ runType: 'orchestrator', goal: 'g', repoPath: 'no/such/dir' }, config).error!,
    /repoPath 不存在/,
  );
  assert.match(
    validateRunRequest({ runType: 'orchestrator', goal: 'g', repoPath: WORKSPACE, orchestration: { allowedSpecs: ['nope'] } }, config).error!,
    /未知的子 Agent 规格/,
  );

  const ok = validateRunRequest(
    { runType: 'orchestrator', goal: '清点并审计 src 目录', repoPath: WORKSPACE, orchestration: { maxWidth: 3, allowedSpecs: ['dir-inventory'] } },
    config,
  );
  assert.equal(ok.error, undefined);
  assert.equal(ok.input!.orchestration?.maxWidth, 3);
  // 预筛只保留白名单内的 spec
  assert.ok((ok.input!.orchestration?.suggestedSubtasks ?? []).every((s) => s.specId === 'dir-inventory'));

  const widened = validateRunRequest(
    { runType: 'orchestrator', goal: 'g', repoPath: WORKSPACE, orchestration: { maxWidth: 999 } },
    config,
  );
  assert.equal(widened.input!.orchestration?.maxWidth, config.subagent.maxWidth, '宽度只能收紧不能放宽');
});

async function withServer(config: ReturnType<typeof loadConfig>, fn: (base: string) => Promise<void>) {
  const { app, store } = createApp(config);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as any).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections?.();
    });
    store.close();
  }
}

test('22q) HTTP 端到端：orchestrator 任务返回汇总报告 + 子任务明细；契约目录接口无 error', async () => {
  const config = loadConfig();
  config.sqlitePath = ':memory:';
  config.stream.liveDeltas = false;
  await withServer(config, async (base) => {
    // 契约目录
    const specsRes = await fetch(`${base}/api/agents/specs`);
    assert.equal(specsRes.status, 200);
    const specsData = (await specsRes.json()) as any;
    // M1：新增 code-edit 契约（写能力）→ 数量不再是固定 3；改为稳健断言（含既有三个 + 无校验错误）
    assert.ok(specsData.specs.length >= 3, `至少应有 3 个契约（实际 ${specsData.specs.length}）`);
    for (const id of ['dir-inventory', 'code-audit', 'doc-research']) {
      assert.ok(specsData.specs.some((s: any) => s.id === id), `契约目录应含 ${id}`);
    }
    assert.deepEqual(specsData.issues.filter((i: any) => i.level === 'error'), []);
    assert.equal(specsData.limits.maxWidth, config.subagent.maxWidth);

    // 创建编排任务
    const createRes = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runType: 'orchestrator', goal: '清点并审计仓库', repoPath: WORKSPACE, mockScenario: 'orchestrator-basic' }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as any;

    let result: any = null;
    for (let i = 0; i < 200; i++) {
      const r = (await (await fetch(`${base}/api/runs/${created.runId}`)).json()) as any;
      if (['completed', 'failed', 'cancelled', 'limit_reached', 'awaiting_user'].includes(r.status)) {
        result = r;
        break;
      }
      await new Promise((r2) => setTimeout(r2, 50));
    }
    assert.equal(result.status, 'completed');
    assert.equal(result.orchestration?.structured, true);
    assert.equal(result.orchestration?.subtasks?.total, 2);
    assert.equal(result.subtasks?.length, 2);
    assert.ok(result.subtasks.every((s: any) => s.report?.structured === true));

    // trace 接口应能看到 subtask span（前端流程图/瀑布图直接消费）
    const snap = (await (await fetch(`${base}/api/runs/${created.runId}/trace`)).json()) as any;
    assert.equal(snap.spans.filter((s: any) => s.kind === 'subtask').length, 2);

    // 单 run 报告接口：默认 JSON（meta + markdown），?format=md → text/markdown；未知 run → 404
    const reportJson = (await (await fetch(`${base}/api/runs/${created.runId}/report`)).json()) as any;
    assert.equal(reportJson.meta.runId, created.runId);
    assert.equal(reportJson.meta.status, 'completed');
    assert.ok(typeof reportJson.markdown === 'string' && reportJson.markdown.includes('```mermaid'), '报告应含 Mermaid 流程图');
    assert.ok(reportJson.markdown.includes('<!-- run-report-meta '), '报告应带可解析的 meta 注释');
    const mdRes = await fetch(`${base}/api/runs/${created.runId}/report?format=md`);
    assert.equal(mdRes.status, 200);
    assert.match(mdRes.headers.get('content-type') ?? '', /text\/markdown/);
    assert.ok((await mdRes.text()).includes('<!-- run-report-meta '));
    assert.equal((await fetch(`${base}/api/runs/no-such-run/report`)).status, 404);
  });
});

test('22r) task-router：编排建议附带的预筛子任务（需 repoPath）', async () => {
  const config = loadConfig();
  config.sqlitePath = ':memory:';
  await withServer(config, async (base) => {
    const res = await fetch(`${base}/api/task-router?goal=${encodeURIComponent('清点并审计 src 与 test 目录')}&repoPath=${encodeURIComponent('demo/codebase-sample')}&preview=1`);
    const data = (await res.json()) as any;
    assert.ok(Array.isArray(data.suggestedSubtasks));
    assert.ok(data.suggestedSubtasks.length > 0);
    assert.ok(data.suggestedSubtasks.every((s: any) => typeof s.specId === 'string' && typeof s.objective === 'string'));
  });
});
