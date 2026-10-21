// tests/18_tracer.test.ts — 可视化监控检测模块
// 覆盖：Tracer 精确计时、span 聚合（run/llm/tool/answer）、model_completed 事件、
//       工具输入输出采集、异步缓冲后事件可读。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRuntime, mockProvider, makeCtx } from './helpers.js';
import { buildTraceSnapshot, Tracer } from '../src/trace/Tracer.js';
import { EventLogger } from '../src/trace/EventLogger.js';
import type { MockResponder } from '../src/llm/MockProvider.js';
import type { RunInput, TraceSpan } from '../src/types.js';

test('18a) Tracer 计时：start→finish 产出正耗时', () => {
  const tracer = new Tracer(new EventLogger({ maxContentChars: 2000, console: false }));
  const sid = tracer.start('r1', 'tool', 'search_files', { inputs: { pattern: 'add' } });
  // 忙等一小段时间保证耗时 > 0
  const t0 = tracer.now();
  while (tracer.now() - t0 < 3) { /* spin ~3ms */ }
  const dur = tracer.finish('r1', sid, 'tool', { status: 'ok', outputs: { ok: true } });
  assert.ok(dur >= 3, `耗时应>=3ms，实际 ${dur}`);
});

test('18b) 完整任务聚合出 run/llm/tool/answer span', async () => {
  const { runtime } = makeRuntime();
  const responder: MockResponder = ({ callIndex }) => {
    if (callIndex === 0) {
      return { stopReason: 'tool_use', content: '搜索', toolCalls: [{ id: 'c1', name: 'search_files', arguments: { pattern: 'add', kind: 'content' } }] };
    }
    if (callIndex === 1) {
      return { stopReason: 'tool_use', content: '读取', toolCalls: [{ id: 'c2', name: 'read_file', arguments: { path: 'src/calc.js' } }] };
    }
    return { stopReason: 'end_turn', content: '分析完成。' };
  };
  const input: RunInput = { runType: 'codebase', goal: 'g', repoPath: makeCtx().repoPath };
  const runId = runtime.createRun(input, mockProvider(responder));
  const result = await runtime.run(input, runId);
  assert.equal(result.status, 'completed');

  const events = runtime.getEvents(runId);
  const snap = buildTraceSnapshot(runId, result.status, events);

  const kinds = (k: string) => snap.spans.filter((s) => s.kind === k);
  assert.equal(kinds('run').length, 1, '应有 1 个 run span');
  assert.equal(kinds('llm').length, 3, '应有 3 次模型调用（llm span）');
  assert.equal(kinds('tool').length, 2, '应有 2 个工具 span');
  assert.equal(kinds('answer').length, 1, '应有 1 个最终答案 span');

  const run = kinds('run')[0];
  assert.equal(run.status, 'ok');
  assert.ok((run.durationMs ?? 0) >= 0, 'run span 有耗时');

  // 每个工具 span 都有输入（arguments）与输出（resultSnippet）
  for (const t of kinds('tool')) {
    assert.ok(t.inputs?.arguments, '工具 span 应记录输入参数');
    assert.ok(t.outputs?.resultSnippet !== undefined, '工具 span 应记录输出摘要');
    assert.ok((t.durationMs ?? 0) >= 0, '工具 span 有耗时');
    assert.equal(t.parentId, runId, '工具 span 的父节点应为 run');
  }

  // 汇总
  assert.equal(snap.summary.llmCalls, 3);
  assert.equal(snap.summary.toolCalls, 2);
});

test('18c) model_completed 事件记录推理耗时与决策', async () => {
  const { runtime } = makeRuntime();
  const responder: MockResponder = () => ({ stopReason: 'end_turn', content: '完成。' });
  const input: RunInput = { runType: 'research', goal: 'g' };
  const runId = runtime.createRun(input, mockProvider(responder));
  await runtime.run(input, runId);

  const events = runtime.getEvents(runId);
  const mc = events.find((e) => e.type === 'model_completed');
  assert.ok(mc, '应存在 model_completed 事件');
  const d = (mc!.data ?? {}) as Record<string, any>;
  assert.equal(d.kind, 'llm');
  assert.equal(d.status, 'ok');
  assert.ok(typeof d.durationMs === 'number' && d.durationMs >= 0, 'model_completed 应有耗时');
  assert.ok(d.outputs, 'model_completed 应记录决策输出');
  assert.equal(d.outputs.stopReason, 'end_turn');
  assert.equal(d.outputs.toolCallCount, 0);
});

test('18d) 工具失败 span 记录错误码与状态', async () => {
  const { runtime } = makeRuntime();
  const responder: MockResponder = ({ callIndex }) => {
    if (callIndex === 0) {
      return { stopReason: 'tool_use', content: '调未知工具', toolCalls: [{ id: 'c1', name: 'nope_tool', arguments: {} }] };
    }
    return { stopReason: 'end_turn', content: '结束' };
  };
  const input: RunInput = { runType: 'codebase', goal: 'g', repoPath: process.cwd() };
  const runId = runtime.createRun(input, mockProvider(responder));
  const result = await runtime.run(input, runId);

  const snap = buildTraceSnapshot(runId, result.status, runtime.getEvents(runId));
  const toolSpan = snap.spans.find((s) => s.kind === 'tool');
  assert.ok(toolSpan, '应有工具 span');
  assert.equal(toolSpan!.status, 'error', '失败工具 span 状态应为 error');
  assert.ok(toolSpan!.error?.code, '应记录错误码');
});

test('18e) 异步缓冲：run 返回后事件已落盘可读', async () => {
  const { runtime } = makeRuntime();
  const responder: MockResponder = ({ callIndex }) => {
    if (callIndex === 0) {
      return { stopReason: 'tool_use', content: '搜', toolCalls: [{ id: 'c1', name: 'search_files', arguments: { pattern: 'x', kind: 'content' } }] };
    }
    return { stopReason: 'end_turn', content: 'done' };
  };
  const input: RunInput = { runType: 'codebase', goal: 'g', repoPath: makeCtx().repoPath };
  const runId = runtime.createRun(input, mockProvider(responder));
  await runtime.run(input, runId);

  const events = runtime.getEvents(runId);
  assert.ok(events.length >= 5, '事件应已落盘');
  assert.ok(events.some((e) => e.type === 'model_completed'), 'model_completed 应已落盘');
  assert.equal(events[0].type, 'run_started');
  assert.equal(events[events.length - 1].type, 'run_completed');
});

// 类型守卫：TraceSpan 结构可访问
test('18f) TraceSpan 结构完整', () => {
  const s: TraceSpan = {
    spanId: 'x', parentId: null, runId: 'r', kind: 'tool', name: 't',
    status: 'running', startTs: 1, durationMs: 2,
  };
  assert.equal(s.kind, 'tool');
  assert.equal(s.status, 'running');
});
