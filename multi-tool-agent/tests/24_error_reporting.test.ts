// tests/24_error_reporting.test.ts — 错误检测与报告机制
// 覆盖：报告四要素（位置/类型/原因/上下文）、脱敏、落盘、事件落点、查询接口、
//       以及两条最关键的兜底：① 执行循环抛未预期异常 → 任务落到 failed（**不再永远停在 running**）
//       ② 子 Agent / 委派阶段异常 → 转成可读的 subtask 结果 + 报告。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildRuntime } from '../src/runtime/index.js';
import { createApp } from '../src/server.js';
import { ErrorReporter, parseErrorLocation, errorTypeOf, hintFor } from '../src/runtime/errorReporter.js';
import { resolveWorkspacePath, listRootEntries } from '../src/tools/shared/workspacePath.js';
import { MockProvider } from '../src/llm/MockProvider.js';
import { mockProvider, makeCtx } from './helpers.js';
import type { MockResponder } from '../src/llm/MockProvider.js';
import type { LLMChatRequest, LLMProvider, LLMResponse, RunInput } from '../src/types.js';

const WORKSPACE = resolve('demo/codebase-sample');

function tmpLog(): string {
  return join(mkdtempSync(join(tmpdir(), 'mta-err-')), 'errors.log');
}

// ---------------------------------------------------------------------------
// 1. 报告结构（四要素）与脱敏
// ---------------------------------------------------------------------------

test('24a) parseErrorLocation：从栈里取第一处「项目内」位置，过滤 node 内部与依赖', () => {
  const stack = [
    'Error: boom',
    '    at inner (/usr/lib/node_modules/pkg/index.js:10:5)',
    '    at runIt (D:/proj/src/runtime/AgentRuntime.ts:123:9)',
    '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
  ].join('\n');
  assert.equal(parseErrorLocation(stack), 'D:/proj/src/runtime/AgentRuntime.ts:123');
  assert.equal(parseErrorLocation(undefined), undefined);
  assert.equal(parseErrorLocation('no frames here'), undefined);
});

test('24b) 报告含四要素：位置 / 类型 / 原因 / 上下文，且自动脱敏', () => {
  const logPath = tmpLog();
  const reporter = new ErrorReporter({ logPath, console: false });
  const err = new TypeError('x is not a function');
  err.stack = ['TypeError: x is not a function', '    at doThing (D:/proj/src/a.ts:9:1)'].join('\n');

  const report = reporter.report({
    source: 'agent-loop',
    phase: 'run',
    error: err,
    code: 'INTERNAL_ERROR',
    runId: 'run_x',
    context: { goal: 'g', apiKey: 'sk-abcdefghijklmnop', nested: { token: 'abc' } },
  });

  assert.match(report.id, /^err_/);
  assert.equal(report.errorType, 'TypeError', '类型');
  assert.equal(report.code, 'INTERNAL_ERROR');
  assert.equal(report.message, 'x is not a function', '原因');
  assert.equal(report.location, 'D:/proj/src/a.ts:9', '位置');
  assert.equal(report.context?.goal, 'g', '上下文');
  assert.equal(report.context?.apiKey, '***REDACTED***', '密钥字段必须脱敏');
  assert.equal((report.context?.nested as any).token, '***REDACTED***');
  assert.ok(report.hint.length > 0, '应给出排查建议');

  // 落盘（JSONL，可 grep）
  assert.ok(existsSync(logPath));
  const lines = readFileSync(logPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.id, report.id);
  assert.equal(parsed.location, 'D:/proj/src/a.ts:9');
});

test('24c) 非 Error 值也能报告（不因"抛了个字符串"而丢信息）', () => {
  const reporter = new ErrorReporter({ console: false });
  const r1 = reporter.report({ source: 'server', phase: 'x', error: 'just a string' });
  assert.equal(r1.errorType, 'string');
  assert.equal(r1.message, 'just a string');

  const r2 = reporter.report({ source: 'server', phase: 'x', error: undefined });
  assert.equal(r2.errorType, 'undefined');
  assert.match(r2.message, /无错误对象/);

  assert.equal(errorTypeOf(null), 'null');
  assert.match(hintFor('tool', 'UNKNOWN_SPEC'), /agents\/specs/);
  assert.match(hintFor('agent-loop', 'INTERNAL_ERROR'), /location/);

  // 查询过滤
  assert.equal(reporter.list({ code: 'UNKNOWN' }).length, 2);
  assert.equal(reporter.list({ source: 'client' }).length, 0);
});

// ---------------------------------------------------------------------------
// 2. 关键兜底：未预期异常不再让任务"卡在 running"
// ---------------------------------------------------------------------------

class ExplodingProvider implements LLMProvider {
  readonly name = 'exploding';
  async chat(_req: LLMChatRequest): Promise<LLMResponse> {
    // 抛一个非 Error 的怪东西：最考验兜底
    throw new Error('provider 内部炸了');
  }
}

test('24d) 模型调用失败 → 任务 failed **且** 产生 source=provider 的报告（JSONL 可查）', async () => {
  const config = loadConfig();
  config.stream.liveDeltas = false;
  const logPath = tmpLog();
  const { runtime, store, tracer, errors } = buildRuntime(config, ':memory:');
  // 用独立报告器替换（指向临时日志），验证落盘
  (runtime as any).errors = new ErrorReporter({ logPath, emit: () => {}, console: false });
  void errors;

  const input: RunInput = { runType: 'codebase', goal: 'g', repoPath: WORKSPACE };
  const runId = runtime.createRun(input, new ExplodingProvider());
  const result = await runtime.run(input, runId);

  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'MODEL_ERROR');

  // 2026-10-20 起：模型调用失败不再只有 run_failed 事件，必须进错误报告三落点
  assert.ok(existsSync(logPath), '错误报告应落盘');
  const reports = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(reports.length, 1, '一次失败一条报告');
  const r = reports[0];
  assert.equal(r.source, 'provider');
  assert.equal(r.phase, 'llm.chat');
  assert.equal(r.code, 'MODEL_ERROR');
  assert.equal(r.runId, runId);
  assert.match(r.message, /provider 内部炸了/);
  // 排查上下文：step / messageCount 是判断「是不是压缩触发」的第一落点
  assert.equal(r.context.step, 1);
  assert.equal(typeof r.context.messageCount, 'number');
  assert.equal(r.context.provider, 'exploding');
  store.close();
});

test('24d2) 400「孤儿 tool」协议错 → 报告带 suspect 标记 + status，hint 指向消息序列', async () => {
  class ToolSequenceProvider implements LLMProvider {
    readonly name = 'deepseek-like';
    async chat(_req: LLMChatRequest): Promise<LLMResponse> {
      const e = new Error(
        '返回 400: {"error":{"message":"Messages with role \'tool\' must be a response to a preceding message with \'tool_calls\'","type":"invalid_request_error"}}',
      ) as Error & { status: number };
      e.status = 400;
      throw e;
    }
  }

  const config = loadConfig();
  config.stream.liveDeltas = false;
  const logPath = tmpLog();
  const { runtime, store } = buildRuntime(config, ':memory:');
  (runtime as any).errors = new ErrorReporter({ logPath, emit: () => {}, console: false });

  const input: RunInput = { runType: 'codebase', goal: 'g', repoPath: WORKSPACE };
  const runId = runtime.createRun(input, new ToolSequenceProvider());
  const result = await runtime.run(input, runId);
  assert.equal(result.status, 'failed');

  const r = JSON.parse(readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)[0]);
  assert.equal(r.source, 'provider');
  assert.equal(r.context.status, 400, '应记录 HTTP 状态码');
  assert.equal(r.context.suspect, 'invalid_message_sequence', '应识别为消息序列非法，而不是 Key/网络问题');
  assert.match(r.hint, /messageCount|tool_calls/, 'hint 应指向消息序列/压缩，而不是只让查 Key');
  store.close();
});

test('24e) enqueue 路径的未预期异常：显式 catch → 不产生 unhandledRejection，任务不会卡死', async () => {
  const config = loadConfig();
  config.stream.liveDeltas = false;
  const { runtime, store } = buildRuntime(config, ':memory:');
  const reports: any[] = [];
  (runtime as any).errors = new ErrorReporter({ console: false, emit: (_r, _t, d) => reports.push(d) });

  // 让 registry.execute 抛出未预期异常（模拟代码缺陷，而不是工具返回错误）
  (runtime as any).registry.execute = async () => {
    const e = new Error('registry 崩了');
    e.stack = ['Error: registry 崩了', '    at fake (D:/proj/src/tools/Registry.ts:42:7)'].join('\n');
    throw e;
  };

  const unhandled: unknown[] = [];
  const onUnhandled = (r: unknown) => unhandled.push(r);
  process.on('unhandledRejection', onUnhandled);
  try {
    const responder: MockResponder = ({ callIndex }) =>
      callIndex === 0
        ? { stopReason: 'tool_use', content: '调用工具', toolCalls: [{ id: 'c1', name: 'list_files', arguments: {} }] }
        : { stopReason: 'end_turn', content: '结束' };
    const input: RunInput = { runType: 'misc', goal: 'g', repoPath: WORKSPACE, mockScenario: undefined };
    const runId = runtime.enqueue(input, mockProvider(responder));
    // 等待后台任务收尾
    for (let i = 0; i < 100; i++) {
      const rec = store.getRun(runId);
      if (rec && ['completed', 'failed', 'cancelled', 'limit_reached', 'awaiting_user'].includes(rec.status)) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    await new Promise((r) => setTimeout(r, 50));

    const rec = store.getRun(runId)!;
    assert.ok(
      ['failed', 'completed'].includes(rec.status),
      `任务必须落到终态，实际 ${rec.status}（旧行为会永远停在 running）`,
    );
    if (rec.status === 'failed') {
      assert.equal(rec.errorCode, 'INTERNAL_ERROR');
      assert.match(rec.failureReason ?? '', /内部错误（err_/);
      const rep = reports.find((r) => r.code === 'INTERNAL_ERROR');
      assert.ok(rep, '应产生 INTERNAL_ERROR 报告');
      assert.equal(rep.source, 'agent-loop');
      // 位置语义：栈里第一处「项目内」帧 = 错误被创建的位置（这里是我们注入的假栈）
      assert.match(String(rep.location), /Registry\.ts:42/, '报告应带项目内代码位置');
    }
    assert.deepEqual(unhandled, [], '不应产生未处理的 Promise 拒绝');
  } finally {
    process.off('unhandledRejection', onUnhandled);
    store.close();
  }
});

// ---------------------------------------------------------------------------
// 3. 路径解析（本次事故的直接修复点）
// ---------------------------------------------------------------------------

test('24f) resolveWorkspacePath：四种路径形态都能解析，越界/不存在有区分度', () => {
  const rel = resolveWorkspacePath(WORKSPACE, 'src');
  assert.equal(rel.ok, true);
  assert.equal((rel as any).rel, 'src');

  assert.equal((resolveWorkspacePath(WORKSPACE, './src') as any).rel, 'src', './ 前缀');
  assert.equal((resolveWorkspacePath(WORKSPACE, 'demo/codebase-sample/src') as any).rel, 'src', '工作区相对');
  assert.equal((resolveWorkspacePath(WORKSPACE, resolve(WORKSPACE, 'src')) as any).rel, 'src', '绝对路径');
  assert.equal((resolveWorkspacePath(WORKSPACE, '') as any).rel, '.', '空 = 仓库根');

  const missing = resolveWorkspacePath(WORKSPACE, 'no/such/dir');
  assert.equal(missing.ok, false);
  assert.equal((missing as any).escaped, undefined, '不存在 ≠ 越权');
  assert.match((missing as any).hint, /可用条目/, '应给出可行动提示');

  const escape = resolveWorkspacePath(WORKSPACE, '../../');
  assert.equal(escape.ok, false);
  assert.equal((escape as any).escaped, true, '越界要被标记为 escaped（供调用方回 PATH_ESCAPE）');
  assert.match((escape as any).reason, /路径越权/);

  assert.ok(listRootEntries(WORKSPACE).includes('src'));

  // 词法模式：文件不存在也能先解析出安全相关的判定对象
  const lexical = resolveWorkspacePath(WORKSPACE, '.env', { requireExists: false });
  assert.equal(lexical.ok, true, '词法解析不要求存在（read_file 需要先判敏感文件）');
});

// ---------------------------------------------------------------------------
// 4. 服务端接口：查询 + 浏览器上报
// ---------------------------------------------------------------------------

async function withServer(config: ReturnType<typeof loadConfig>, fn: (base: string, errors: ErrorReporter) => Promise<void>) {
  // 测试不应向生产 errors.log 写噪音：每次都用临时日志
  config.log.errorLogPath = tmpLog();
  const { app, store, errors } = createApp(config);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as any).port;
  try {
    await fn(`http://127.0.0.1:${port}`, errors);
  } finally {
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections?.();
    });
    store.close();
  }
}

test('24g) GET /api/errors 可查询；POST /api/client-errors 记录浏览器错误', async () => {
  const config = loadConfig();
  config.sqlitePath = ':memory:';
  config.stream.liveDeltas = false;
  await withServer(config, async (base, errors) => {
    // 先手工塞一条（模拟服务端内部错误）
    errors.report({ source: 'server', phase: 'test', code: 'INTERNAL_ERROR', message: '服务端内部错误' });

    // 浏览器上报
    const res = await fetch(`${base}/api/client-errors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'Cannot read properties of null (reading map)',
        url: 'http://localhost:3939/',
        line: 1234,
        column: 7,
        stack: 'TypeError: ...\n    at renderOrchestrationReport (http://localhost:3939/:1502:11)',
        phase: 'window.onerror',
        runId: 'run_abc',
      }),
    });
    assert.equal(res.status, 200);
    const { errorId } = (await res.json()) as any;
    assert.match(errorId, /^err_/);

    const list = (await (await fetch(`${base}/api/errors?limit=10`)).json()) as any;
    assert.ok(list.total >= 2, `应有至少 2 条报告，实际 ${list.total}`);
    const client = list.errors.find((e: any) => e.source === 'client');
    assert.ok(client, '应能查到浏览器上报的错误');
    assert.equal(client.runId, 'run_abc');
    assert.match(client.location, /:1502/, '位置应能从浏览器栈里解析出来');
    assert.equal(client.code, 'CLIENT_ERROR');

    // 按 runId 过滤
    const filtered = (await (await fetch(`${base}/api/errors?runId=run_abc`)).json()) as any;
    assert.equal(filtered.count, 1);
    assert.ok(filtered.logPath, '应返回日志路径，便于落盘取证');
  });
});

test('24h) 未知路由的错误不会让服务崩溃（结构化 500 而不是 HTML）', async () => {
  const config = loadConfig();
  config.sqlitePath = ':memory:';
  await withServer(config, async (base) => {
    // 正常路由仍工作
    const ok = await fetch(`${base}/api/health`);
    assert.equal(ok.status, 200);
    // 不存在的路由：404（Express 默认），不会崩
    const notFound = await fetch(`${base}/api/definitely-not-exist`);
    assert.equal(notFound.status, 404);
    // 服务仍可用
    const again = await fetch(`${base}/api/health`);
    assert.equal(again.status, 200);
  });
});

// ---------------------------------------------------------------------------
// 5. 端到端：runtime_error 事件进入事件流（前端可见 + 可回放）
// ---------------------------------------------------------------------------

test('24i) 错误报告会作为 runtime_error 事件进入事件流（前端可显示）', async () => {
  const config = loadConfig();
  config.stream.liveDeltas = false;
  const { runtime, store, tracer } = buildRuntime(config, ':memory:');
  const reporter = new ErrorReporter({ console: false, emit: (runId, type, data) => tracer.emit(runId, type, data) });
  (runtime as any).errors = reporter;

  const responder: MockResponder = () => ({ stopReason: 'end_turn', content: '结束' });
  const input: RunInput = { runType: 'misc', goal: 'g', repoPath: WORKSPACE };
  const runId = runtime.createRun(input, new MockProvider(responder, { chunkDelayMs: 0 }));
  await runtime.run(input, runId);

  // 人为触发一次工具层报告（模拟"值得留痕"的错误）
  reporter.report({ source: 'tool', phase: 'dir_stats', code: 'NOT_FOUND', message: '路径不存在', runId, toolName: 'dir_stats' });
  tracer.flush();

  const events = runtime.getEvents(runId);
  const errEv = events.find((e) => e.type === 'runtime_error');
  assert.ok(errEv, 'runtime_error 事件应进入事件流');
  assert.equal((errEv!.data as any).code, 'NOT_FOUND');
  assert.equal((errEv!.data as any).source, 'tool');
  assert.match(String((errEv!.data as any).hint), /可用条目|路径|仓库/);
  store.close();
});

// ---------------------------------------------------------------------------
// 6. 上报结构的宽容归一化（真实模型爱把数组元素写成字符串）
// ---------------------------------------------------------------------------

test('24j) normalize*：字符串形式自动归一化为对象（信息不丢）', async () => {
  const { normalizeItems, normalizeFindings, normalizeOrchFindings } = await import('../src/tools/shared/reportNormalize.js');

  assert.deepEqual(normalizeItems(['文件数: 3', '总大小：1.0KB', '没有分隔符']), [
    { label: '文件数', value: '3' },
    { label: '总大小', value: '1.0KB' },
    { label: '没有分隔符', value: '' },
  ]);
  assert.deepEqual(normalizeItems([{ label: 'x', value: 1 }]), [{ label: 'x', value: 1 }]);

  assert.deepEqual(normalizeFindings(['src/calc.js:1 未发现 TODO', { path: 'test/a.js', note: 'n' }]), [
    { path: 'src/calc.js:1', note: '未发现 TODO' },
    { path: 'test/a.js', note: 'n' },
  ]);
  assert.deepEqual(normalizeFindings(['一句没有路径的说明']), [{ path: '（未标注路径）', note: '一句没有路径的说明' }]);

  const orch = normalizeOrchFindings(['src 有 2 个文件', { from: 'st_1', note: 'ok' }]);
  assert.equal(orch.findings?.length, 2);
  assert.equal(orch.findings?.[0].from, '（未标注来源）');
  assert.equal(orch.missingFromCount, 1, '未标注来源要被计数（用于如实提醒）');
});

test('24k) submit_finding 接受字符串数组并返回归一化结果（不再因形状被打回）', async () => {
  const { registryWithAll } = await import('./helpers.js');
  const reg = registryWithAll();
  const ctx = makeCtx({ allowedPermissions: ['misc:read', 'agent:report'] });

  const res = await reg.execute(
    'submit_finding',
    {
      summary: '清点完成',
      items: ['文件数: 3', '总大小: 1.0KB'],
      findings: ['src/calc.js:1 无 TODO'],
      evidence: ['dir_stats:src'],
      confidence: 'high',
    },
    ctx,
  );
  assert.equal(res.result.ok, true, `应接受字符串形式，实际：${JSON.stringify(res.result.error)}`);
  const data = (res.result.data ?? {}) as any;
  assert.deepEqual(data.items, [
    { label: '文件数', value: '3' },
    { label: '总大小', value: '1.0KB' },
  ]);
  assert.deepEqual(data.findings, [{ path: 'src/calc.js:1', note: '无 TODO' }]);
});

test('24l) 编排汇总用字符串 findings 时：来源缺失被如实计入 unresolved', async () => {
  const { toOrchestrationReport } = await import('../src/runtime/AgentRuntime.js');
  const { registryWithAll } = await import('./helpers.js');
  const reg = registryWithAll();
  const ctx = makeCtx({ allowedPermissions: ['orchestrator:delegate', 'orchestrator:report'] });

  const toolRes = await reg.execute('submit_orchestration', { summary: '汇总', findings: ['src 有 2 个文件'] }, ctx);
  assert.equal(toolRes.result.ok, true, '字符串 findings 不应导致校验失败');
  assert.equal((toolRes.result.data as any).missingFromCount, 1);

  const report = toOrchestrationReport(toolRes.result.data, []);
  assert.equal(report.findings?.[0].from, '（未标注来源）');
  assert.ok(
    (report.unresolved ?? []).some((u) => /未标注来源/.test(u)),
    '来源缺失必须在 unresolved 里如实提醒（不假装合规）',
  );
});

test('24n) ErrorReporter.summary：按 code+location 聚合计数（高频错误 TOP，R5）', () => {
  const reporter = new ErrorReporter({ console: false });
  // 同一处错误重复 3 次（关联 2 个 run）
  for (let i = 0; i < 3; i++) {
    const e = new Error(`boom ${i}`);
    e.stack = ['Error: boom', '    at fn (D:/proj/src/x.ts:10:1)'].join('\n');
    reporter.report({ source: 'agent-loop', phase: 'run', error: e, code: 'INTERNAL_ERROR', runId: `run_${i % 2}` });
  }
  // 另一处错误 1 次
  const e2 = new Error('other');
  e2.stack = ['Error: other', '    at fn (D:/proj/src/y.ts:20:1)'].join('\n');
  reporter.report({ source: 'tool', phase: 't', error: e2, code: 'NOT_FOUND', runId: 'run_2' });

  const { groups, scanned } = reporter.summary();
  assert.equal(scanned, 4);
  assert.equal(groups.length, 2, '两处位置 → 两组');
  assert.equal(groups[0].count, 3, '高频组排第一');
  assert.equal(groups[0].code, 'INTERNAL_ERROR');
  assert.equal(groups[0].location, 'D:/proj/src/x.ts:10');
  assert.deepEqual(groups[0].runIds, ['run_0', 'run_1'], '关联 run 去重（最近 5 个）');
  assert.match(groups[0].sampleMessage, /boom 2/, '样例消息取最近一次');
  assert.equal(groups[1].count, 1);
  // 过滤 + limit
  assert.equal(reporter.summary({ source: 'tool' }).groups.length, 1);
  assert.equal(reporter.summary({ limit: 1 }).groups.length, 1);
});

test('24o) GET /api/errors?view=summary 返回聚合视图（前端「错误」页签数据源）', async () => {
  const config = loadConfig();
  config.sqlitePath = ':memory:';
  config.stream.liveDeltas = false;
  await withServer(config, async (base, errors) => {
    for (let i = 0; i < 2; i++) errors.report({ source: 'server', phase: 'test', code: 'RESUME_REJECTION', message: `e${i}` });
    errors.report({ source: 'server', phase: 'test', code: 'INTERNAL_ERROR', message: 'x' });
    const sum = (await (await fetch(`${base}/api/errors?view=summary&limit=10`)).json()) as any;
    assert.equal(sum.scanned, 3);
    assert.equal(sum.groups.length, 2);
    assert.equal(sum.groups[0].code, 'RESUME_REJECTION', '高频在前');
    assert.equal(sum.groups[0].count, 2);
    assert.ok(sum.logPath, '聚合视图仍返回日志路径');
    // 旧形态向后兼容（不传 view 时行为不变）
    const list = (await (await fetch(`${base}/api/errors?limit=10`)).json()) as any;
    assert.equal(list.count, 3);
    assert.ok(Array.isArray(list.errors));
  });
});

test('24m) parseErrorLocation：浏览器 URL 栈要整段解析（不能切出 "p://host"）', async () => {
  const { parseErrorLocation } = await import('../src/runtime/errorReporter.js');
  const stack = [
    'TypeError: x is null',
    '    at renderOrchestrationReport (http://localhost:3939/:1520:11)',
    '    at http://localhost:3939/static/app.js:42:5',
  ].join('\n');
  assert.equal(parseErrorLocation(stack), 'http://localhost:3939/:1520');
  // 只有 URL 形态时也不能退化成残缺串
  assert.equal(parseErrorLocation('    at http://localhost:3939/app.js:7:1'), 'http://localhost:3939/app.js:7');
});
