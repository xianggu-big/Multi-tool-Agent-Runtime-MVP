// tests/45_observability.test.ts — LLM 可观测：一次回答为什么慢、token 花在哪
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseRun, formatDiagnosis } from '../src/observability/latency.js';
import type { TraceEvent, TraceEventType } from '../src/types.js';

const BASE = Date.parse('2026-10-19T00:00:00.000Z');
const RUN = 'run_diag';

function ev(type: TraceEventType, offsetMs: number, data: Record<string, unknown>): TraceEvent {
  return { runId: RUN, seq: 0, type, timestamp: new Date(BASE + offsetMs).toISOString(), data };
}

test('45a) 并行工具：sum > union，报告并发节省；模型/工具/空转可分层', () => {
  const events: TraceEvent[] = [
    ev('run_started', 0, { spanId: 'R', startTs: BASE }),
    ev('model_request', 0, { spanId: 'm1', name: 'deepseek', step: 1, startTs: BASE }),
    ev('llm_delta', 150, { spanId: 'm1', channel: 'content', text: '思' }),
    ev('model_completed', 400, {
      spanId: 'm1', step: 1, endTs: BASE + 400, durationMs: 400, status: 'ok', model: 'deepseek-flash',
      usage: { promptTokens: 8000, completionTokens: 500, totalTokens: 8500, reasoningTokens: 300, costUsd: 0.01 },
    }),
    ev('tool_started', 400, { spanId: 't1', name: 'read_file', step: 1, startTs: BASE + 400 }),
    ev('tool_started', 400, { spanId: 't2', name: 'search_files', step: 1, startTs: BASE + 400 }),
    ev('tool_completed', 700, { spanId: 't1', endTs: BASE + 700 }),
    ev('tool_completed', 800, { spanId: 't2', endTs: BASE + 800 }),
    ev('model_request', 800, { spanId: 'm2', name: 'deepseek', step: 2, startTs: BASE + 800 }),
    ev('model_completed', 1000, {
      spanId: 'm2', step: 2, endTs: BASE + 1000, durationMs: 200, status: 'ok', model: 'deepseek-flash',
      usage: { promptTokens: 2000, completionTokens: 100, totalTokens: 2100, costUsd: 0.002 },
    }),
    ev('run_completed', 1000, { spanId: 'R', endTs: BASE + 1000 }),
  ];

  const d = diagnoseRun(events);
  assert.equal(d.status, 'completed');
  assert.equal(d.wallMs, 1000);
  assert.equal(d.modelMs, 600);
  assert.equal(d.toolMs, 700);
  assert.equal(d.modelUnionMs, 600);
  assert.equal(d.toolUnionMs, 400);
  assert.equal(d.busyMs, 1000);
  assert.equal(d.overheadMs, 0);
  assert.equal(d.concurrencySavedMs, 300);
  assert.equal(d.firstTokenMs, 150);
  assert.equal(d.slowest[0].name, 'deepseek');

  assert.equal(d.tokenHotspots[0].step, 1);
  assert.equal(d.tokenHotspots[0].totalTokens, 8500);
  assert.ok(d.advice.some((a) => /输入 token/.test(a)));
  assert.ok(d.advice.some((a) => /思考 token/.test(a)));
  assert.match(formatDiagnosis(d), /并发节省=/);
});

test('45b) 空转/事件循环阻塞：墙钟明显大于 span 并集时给出 30% 提示', () => {
  const events: TraceEvent[] = [
    ev('run_started', 0, { spanId: 'R', startTs: BASE }),
    ev('model_request', 500, { spanId: 'm1', name: 'mock', step: 1, startTs: BASE + 500 }),
    ev('model_completed', 900, {
      spanId: 'm1', step: 1, endTs: BASE + 900, durationMs: 400, status: 'ok',
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, costUsd: 0 },
    }),
    ev('run_completed', 1000, { spanId: 'R', endTs: BASE + 1000 }),
  ];
  const d = diagnoseRun(events);
  assert.equal(d.wallMs, 1000);
  assert.equal(d.busyMs, 400);
  assert.equal(d.overheadMs, 600);
  assert.equal(d.overheadPct, 0.6);
  assert.ok(d.advice.some((a) => /超过 30%/.test(a)));
});