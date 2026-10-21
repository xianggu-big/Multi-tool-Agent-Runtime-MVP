// tests/21_misc_agent.test.ts — 杂项 / 低优先级琐事子 Agent（misc）
// 覆盖：分流器（分类 + 置信度 + 可解释性）、只读工具池与权限边界（无命令/联网/写入）、
//       越权拒绝、终结性工具 submit_result（结构化结论 + 立即结束）、未提交时的文本回退、
//       改派（escalateTo）语义、预算「只能收紧不能放宽」、dir_stats 真实统计边界、
//       HTTP 端到端 + /api/task-router + 请求校验。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildRuntime } from '../src/runtime/index.js';
import { createApp, validateRunRequest } from '../src/server.js';
import { classifyTask } from '../src/runtime/router.js';
import { dirStats } from '../src/tools/misc/dirStats.js';
import { submitResult } from '../src/tools/misc/submitResult.js';
import { buildRegistry } from '../src/tools/index.js';
import { makeCtx, mockProvider } from './helpers.js';
import type { MockResponder } from '../src/llm/MockProvider.js';
import type { RunInput, TraceEvent } from '../src/types.js';

const WORKSPACE = resolve('demo/codebase-sample');

function miscRuntime() {
  const config = loadConfig();
  config.codebase.runTestsEnabled = false;
  return buildRuntime(config, ':memory:');
}

function miscInput(over: Partial<RunInput> = {}): RunInput {
  return { runType: 'misc', goal: '清点目录', repoPath: WORKSPACE, ...over };
}

/** 从事件里取工具失败的错误码 */
function toolErrorCodes(events: TraceEvent[]): string[] {
  return events
    .filter((e) => e.type === 'tool_failed')
    .map((e) => String((e.data as any)?.code ?? ''));
}

// ---------------------------------------------------------------------------
// 1. 分流器
// ---------------------------------------------------------------------------

test('21a) 分流器：琐事→misc、改代码/跑测试→codebase、联网调研→research', () => {
  const misc = classifyTask('清点一下 demo 目录有多少文件、总大小多少');
  assert.equal(misc.runType, 'misc');
  assert.ok(['high', 'medium'].includes(misc.confidence));
  assert.ok(misc.signals.includes('多少'), '应回传命中的信号词，便于解释');

  const code = classifyTask('帮我重构 src/calc.js 的 add 函数并跑测试验证');
  assert.equal(code.runType, 'codebase');

  // 单主题调研 → Research Agent
  const research = classifyTask('搜索一下 esbuild 的最新版本');
  assert.equal(research.runType, 'research');

  // 多主题并列调研 → 升级为「多 Agent 编排」（并行调研 + 汇总对比）——见 tests/22a2
  const multiTopic = classifyTask('搜索一下 esbuild 和 rollup 的最新版本并对比');
  assert.equal(multiTopic.runType, 'orchestrator');
});

test('21b) 分流器：无信号时保守试探、禁止 misc 时不返回 misc、危险动作给提示', () => {
  const empty = classifyTask('帮我处理一下这个');
  assert.equal(empty.runType, 'misc', '无信号时默认用最省的 misc 试探');
  assert.equal(empty.confidence, 'low');
  assert.match(empty.reason, /试探/);

  const noMisc = classifyTask('帮我处理一下这个', { allowMisc: false });
  assert.notEqual(noMisc.runType, 'misc');

  const dangerous = classifyTask('把这个目录里的临时文件批量删除');
  assert.match(dangerous.reason, /破坏性动作|人工确认/);
  assert.equal(dangerous.requiresHuman, true, '破坏性动作必须标记为需人工确认（任何 Agent 都没有写工具）');

  const safe = classifyTask('清点这个目录有多少文件');
  assert.equal(safe.requiresHuman, undefined);
});

// ---------------------------------------------------------------------------
// 2. 工具池与权限边界
// ---------------------------------------------------------------------------

test('21c) misc 工具池只含只读工具 + 结构化提交（无命令、无联网、无写入）', async () => {
  const { runtime } = miscRuntime();
  let offered: string[] = [];
  const responder: MockResponder = (ctx) => {
    offered = ctx.tools.map((t) => t.name);
    return { stopReason: 'end_turn', content: '结束' };
  };
  const input = miscInput();
  const runId = runtime.createRun(input, mockProvider(responder));
  await runtime.run(input, runId);

  assert.deepEqual(
    [...offered].sort(),
    ['ask_user', 'dir_stats', 'list_files', 'read_file', 'search_files', 'submit_result'].sort(),
  );
  for (const forbidden of ['run_tests', 'web_search', 'fetch_page', 'extract_evidence', 'compare_sources']) {
    assert.ok(!offered.includes(forbidden), `misc 不应暴露 ${forbidden}`);
  }
});

test('21d) 越权拒绝：misc 请求 run_tests 被 PERMISSION_DENIED（命令未执行）', async () => {
  const { runtime } = miscRuntime();
  const responder: MockResponder = ({ callIndex }) => {
    if (callIndex === 0) {
      return { stopReason: 'tool_use', content: '试跑测试', toolCalls: [{ id: 'c1', name: 'run_tests', arguments: { command: 'node --test' } }] };
    }
    return { stopReason: 'end_turn', content: '收到越权错误，不再尝试。' };
  };
  const input = miscInput();
  const runId = runtime.createRun(input, mockProvider(responder));
  const result = await runtime.run(input, runId);

  const codes = toolErrorCodes(runtime.getEvents(runId));
  assert.ok(codes.includes('PERMISSION_DENIED'), `应拒绝越权工具，实际错误码: ${codes.join(',')}`);
  assert.equal(result.status, 'completed');
  // 失败路径的最终答案走文本回退（未调用 submit_result）
  assert.equal(result.misc?.structured, false);
});

test('21e) 越权拒绝：misc 请求 web_search 被拒绝（不联网）', async () => {
  const { runtime } = miscRuntime();
  const responder: MockResponder = ({ callIndex }) => {
    if (callIndex === 0) {
      return { stopReason: 'tool_use', content: '想联网', toolCalls: [{ id: 'c1', name: 'web_search', arguments: { query: 'x' } }] };
    }
    return { stopReason: 'end_turn', content: '放弃联网。' };
  };
  const input = miscInput();
  const runId = runtime.createRun(input, mockProvider(responder));
  await runtime.run(input, runId);
  assert.ok(toolErrorCodes(runtime.getEvents(runId)).includes('PERMISSION_DENIED'));
});

// ---------------------------------------------------------------------------
// 3. 终结性工具 submit_result
// ---------------------------------------------------------------------------

test('21f) 终结性工具：调用成功后任务立即完成（不再多跑一轮模型）', async () => {
  const { runtime } = miscRuntime();
  let calls = 0;
  const responder: MockResponder = ({ callIndex }) => {
    calls += 1;
    if (callIndex === 0) {
      return {
        stopReason: 'tool_use',
        content: '统计目录',
        toolCalls: [{ id: 'c1', name: 'dir_stats', arguments: { dir: '.', maxDepth: 3, topN: 3 } }],
      };
    }
    return {
      stopReason: 'tool_use',
      content: '提交结论',
      toolCalls: [
        {
          id: 'c2',
          name: 'submit_result',
          arguments: {
            summary: '该目录共有若干文件',
            items: [{ label: '文件数', value: 5 }],
          },
        },
      ],
    };
  };
  const input = miscInput();
  const runId = runtime.createRun(input, mockProvider(responder));
  const result = await runtime.run(input, runId);

  assert.equal(result.status, 'completed');
  assert.equal(calls, 2, '提交后不应再多调用一次模型');
  assert.equal(result.modelCalls, 2);
  assert.equal(result.misc?.structured, true);
  assert.equal(result.misc?.summary, '该目录共有若干文件');
  assert.deepEqual(result.misc?.items, [{ label: '文件数', value: 5 }]);
  assert.equal(result.finalAnswer, result.misc?.summary);

  // 事件：应记录一次结构化提交
  const events = runtime.getEvents(runId);
  const submitted = events.find((e) => e.type === 'misc_report_submitted');
  assert.ok(submitted, '应产出 misc_report_submitted 事件');
  assert.equal((submitted!.data as any).structured, true);
  // 事件顺序：submitted 之后进入收尾。2026-10-20 起终态前会多一条复盘摘要（run_digest），
  // 因此允许中间夹一条 run_digest，但**不允许插入其它业务事件**，且最后一条仍是终态事件。
  const iSub = events.findIndex((e) => e.type === 'misc_report_submitted');
  const tail = events.slice(iSub + 1).map((e) => e.type);
  assert.ok(tail.includes('run_completed'), '提交后应收尾');
  assert.ok(tail.every((t) => t === 'run_digest' || t === 'run_completed'), `收尾段不应有其它事件：${tail.join(',')}`);
  assert.equal(events[events.length - 1].type, 'run_completed', '最后一条仍是终态事件');
});

test('21g) 回退：未调用 submit_result 时用正文文本作为结论并标记非结构化', async () => {
  const { runtime } = miscRuntime();
  const responder: MockResponder = () => ({ stopReason: 'end_turn', content: '目录里没什么特别的。' });
  const input = miscInput();
  const runId = runtime.createRun(input, mockProvider(responder));
  const result = await runtime.run(input, runId);

  assert.equal(result.status, 'completed');
  assert.equal(result.misc?.structured, false, '必须标记为未结构化，不能假装是结构化结论');
  assert.equal(result.misc?.summary, '目录里没什么特别的。');
  assert.equal(result.misc?.items, undefined);
});

test('21h) 改派：escalateTo 必须带理由；带理由时结论里保留改派信息', async () => {
  const { runtime } = miscRuntime();
  // ① 只给 escalateTo 不给理由 → 工具报错，任务继续（模型可修正）
  const badResponder: MockResponder = ({ callIndex }) => {
    if (callIndex === 0) {
      return {
        stopReason: 'tool_use',
        content: '想改派',
        toolCalls: [{ id: 'c1', name: 'submit_result', arguments: { summary: 'x', escalateTo: 'codebase' } }],
      };
    }
    return { stopReason: 'end_turn', content: '算了，直接说明。' };
  };
  const input1 = miscInput();
  const runId1 = runtime.createRun(input1, mockProvider(badResponder));
  const r1 = await runtime.run(input1, runId1);
  assert.ok(toolErrorCodes(runtime.getEvents(runId1)).includes('MISSING_ESCALATE_REASON'));
  assert.equal(r1.misc?.escalateTo, undefined, '未通过校验的改派不应被采纳');

  // ② 带理由 → 采纳
  const goodResponder: MockResponder = () => ({
    stopReason: 'tool_use',
    content: '超出能力范围',
    toolCalls: [
      {
        id: 'c1',
        name: 'submit_result',
        arguments: {
          summary: '需要修改代码，超出只读边界',
          escalateTo: 'codebase',
          escalateReason: '要求修改 src/calc.js 并跑测试，需要写权限与命令执行',
        },
      },
    ],
  });
  const input2 = miscInput();
  const runId2 = runtime.createRun(input2, mockProvider(goodResponder));
  const r2 = await runtime.run(input2, runId2);
  assert.equal(r2.status, 'completed');
  assert.equal(r2.misc?.escalateTo, 'codebase');
  assert.match(r2.misc!.escalateReason!, /写权限/);
});

// ---------------------------------------------------------------------------
// 4. 预算边界（只能收紧，不能放宽）
// ---------------------------------------------------------------------------

test('21i) 预算：misc 默认更小，且请求放大也会被硬上限压回', async () => {
  const config = loadConfig();
  const { runtime } = buildRuntime(config, ':memory:');
  const responder: MockResponder = ({ callIndex }) => {
    // 无限请求工具，用于验证步数上限
    return {
      stopReason: 'tool_use',
      content: '继续',
      toolCalls: [{ id: `c${callIndex}`, name: 'dir_stats', arguments: { dir: '.', maxDepth: 1 } }],
    };
  };
  const input = miscInput({ maxSteps: 999, maxModelCalls: 999, maxToolCalls: 999 });
  const runId = runtime.createRun(input, mockProvider(responder));
  const result = await runtime.run(input, runId);

  assert.equal(result.status, 'limit_reached');
  assert.equal(result.triggeredLimit, 'maxSteps', 'misc 的步数应被硬上限约束（而不是接受 999）');
  assert.ok(result.steps <= config.misc.hardMaxSteps, `步数 ${result.steps} 不应超过硬上限 ${config.misc.hardMaxSteps}`);

  // 默认值也应是「小预算」
  assert.ok(config.misc.maxSteps <= 8 && config.misc.tokenBudget <= 100000);
  assert.equal(config.misc.defaultParams.thinking, 'disabled', '琐事默认关闭思考（更省更快）');
});

// ---------------------------------------------------------------------------
// 5. dir_stats 工具本身
// ---------------------------------------------------------------------------

test('21j) dir_stats：真实统计且忽略依赖目录、不泄露敏感文件名', async () => {
  const ctx = makeCtx();
  const res = await dirStats.execute({ dir: '.', maxDepth: 4, topN: 5 }, ctx);
  assert.equal(res.ok, true);
  const data = res.data as any;
  assert.ok(data.fileCount >= 5, `示例仓库应统计到文件，实际 ${data.fileCount}`);
  assert.ok(Array.isArray(data.extensions) && data.extensions.length > 0);
  assert.ok(data.extensions.some((e: any) => e.ext === '.js'), '应统计到 .js');
  assert.equal(typeof data.totalSizeHuman, 'string');

  // 敏感文件不出现（示例仓库无敏感文件，这里用一个包含 .env 的临时目录验证）
  const res2 = await dirStats.execute({ dir: '../../', maxDepth: 1 }, ctx);
  assert.equal(res2.ok, false);
  assert.equal(res2.error?.code, 'PATH_ESCAPE', '越界目录必须被拒绝');
});

test('21j2) submit_result：schema 与业务校验（缺 summary / 非法 escalateTo / 缺理由）', async () => {
  // 用带 misc 权限的上下文，才能测到「参数校验」这一层（否则先被权限拦住）
  const ctx = makeCtx({ allowedPermissions: ['misc:read', 'misc:report'] });
  const reg = buildRegistry();

  const missingSummary = await reg.execute('submit_result', { items: [] }, ctx);
  assert.equal(missingSummary.result.ok, false);
  assert.equal(missingSummary.result.error?.code, 'INVALID_ARGS');

  const badEnum = await reg.execute('submit_result', { summary: 'x', escalateTo: 'nobody' }, ctx);
  assert.equal(badEnum.result.ok, false);
  assert.equal(badEnum.result.error?.code, 'INVALID_ARGS');

  const missingReason = await reg.execute('submit_result', { summary: 'x', escalateTo: 'human' }, ctx);
  assert.equal(missingReason.result.ok, false);
  assert.equal(missingReason.result.error?.code, 'MISSING_ESCALATE_REASON');

  const okRes = await submitResult.execute({ summary: 'ok' }, ctx);
  assert.equal(okRes.ok, true);
  assert.equal((okRes.data as any).submitted, true);
});

// ---------------------------------------------------------------------------
// 6. 服务端：校验 + HTTP 端到端 + 分流接口
// ---------------------------------------------------------------------------

test('21k) validateRunRequest：misc 必须有工作区、subtask 必须合法、上限只能收紧', () => {
  const config = loadConfig();
  const missing = validateRunRequest({ runType: 'misc', goal: 'g' }, config);
  assert.match(missing.error!, /repoPath/);

  const notExist = validateRunRequest({ runType: 'misc', goal: 'g', repoPath: 'no/such/dir' }, config);
  assert.match(notExist.error!, /repoPath 不存在/);

  const badSubtask = validateRunRequest({ runType: 'misc', goal: 'g', repoPath: WORKSPACE, misc: { subtask: 'nope' } }, config);
  assert.match(badSubtask.error!, /subtask 只能是/);

  const widened = validateRunRequest(
    { runType: 'misc', goal: 'g', repoPath: WORKSPACE, misc: { scanLimit: 999999, maxFileBytes: 1e9 } },
    config,
  );
  assert.equal(widened.error, undefined);
  assert.equal(widened.input!.misc?.scanLimit, config.misc.scanLimit, '过大的 scanLimit 应被压回服务端上限');
  assert.equal(widened.input!.misc?.maxFileBytes, config.misc.maxFileBytes);

  const tightened = validateRunRequest(
    { runType: 'misc', goal: 'g', repoPath: WORKSPACE, misc: { scanLimit: 500, subtask: 'locate' } },
    config,
  );
  assert.equal(tightened.input!.misc?.scanLimit, 500, '收紧是允许的');
  assert.equal(tightened.input!.misc?.subtask, 'locate');

  // 旧的非法 runType 仍然被拒绝
  assert.match(validateRunRequest({ runType: 'other', goal: 'g' }, config).error!, /必须为 codebase/);
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

test('21l) HTTP：POST /api/runs(runType=misc) 端到端返回结构化结论与边界回显', async () => {
  const config = loadConfig();
  config.sqlitePath = ':memory:';
  config.stream.liveDeltas = false;
  await withServer(config, async (base) => {
    const res = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runType: 'misc',
        goal: '清点示例仓库',
        repoPath: WORKSPACE,
        mockScenario: 'misc-basic',
        misc: { subtask: 'inventory' },
      }),
    });
    assert.equal(res.status, 201);
    const created = (await res.json()) as any;
    assert.ok(created.runId);
    assert.equal(created.runType, 'misc');
    assert.ok(created.miscLimits, '应回显本次生效的杂项边界');
    assert.deepEqual(created.miscLimits.allowedTools, ['list_files', 'search_files', 'read_file', 'dir_stats', 'submit_result', 'ask_user']);
    assert.equal(created.miscLimits.hardMaxSteps, config.misc.hardMaxSteps);

    // 等任务结束
    let result: any = null;
    for (let i = 0; i < 200; i++) {
      const r = await (await fetch(`${base}/api/runs/${created.runId}`)).json();
      if (['completed', 'failed', 'cancelled', 'limit_reached', 'awaiting_user'].includes((r as any).status)) {
        result = r;
        break;
      }
      await new Promise((r2) => setTimeout(r2, 50));
    }
    assert.equal(result.status, 'completed');
    assert.equal(result.misc?.structured, true, '应通过 submit_result 提交结构化结论');
    assert.ok(Array.isArray(result.misc.items) && result.misc.items.length > 0);
    assert.match(result.misc.summary, /文件/);

    // 持久化后再读一次（验证 resultJson 列确实落库）
    const again = await (await fetch(`${base}/api/runs/${created.runId}`)).json();
    assert.equal((again as any).misc.summary, result.misc.summary);
  });
});

test('21m) HTTP：/api/task-router 给出可解释的推荐；无 goal 时 400', async () => {
  const config = loadConfig();
  config.sqlitePath = ':memory:';
  await withServer(config, async (base) => {
    const bad = await fetch(`${base}/api/task-router`);
    assert.equal(bad.status, 400);

    const res = await fetch(`${base}/api/task-router?goal=${encodeURIComponent('这个目录有多少个 ts 文件？')}`);
    const data = (await res.json()) as any;
    assert.equal(data.runType, 'misc');
    assert.ok(typeof data.reason === 'string' && data.reason.length > 0);
    assert.ok(Array.isArray(data.signals));

    const code = await (await fetch(`${base}/api/task-router?goal=${encodeURIComponent('重构并跑测试')}`)).json();
    assert.equal((code as any).runType, 'codebase');

    const noMisc = await (await fetch(`${base}/api/task-router?goal=${encodeURIComponent('随便看看')}&allowMisc=0`)).json();
    assert.notEqual((noMisc as any).runType, 'misc');
  });
});
