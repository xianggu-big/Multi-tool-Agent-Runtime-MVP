// tests/63_streaming_coalesce.test.ts — 高频文本增量按帧合并，避免 SSE/浏览器被逐字帧打爆
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventLogger } from '../src/trace/EventLogger.js';
import { Tracer } from '../src/trace/Tracer.js';
import type { TraceEvent } from '../src/types.js';

test('63a) 同一 span/channel 的增量合并，并在 model_completed 前一次性送达', () => {
  const live: TraceEvent[] = [];
  const logger = new EventLogger({
    maxContentChars: 1000,
    console: false,
    onLive: (e) => live.push(e),
  });
  const tracer = new Tracer(logger);
  const spanId = tracer.start('run_test', 'llm', 'mock');
  for (let i = 0; i < 100; i += 1) tracer.delta('run_test', spanId, 'content', 'x');
  tracer.finish('run_test', spanId, 'llm');

  const deltas = live.filter((e) => e.type === 'llm_delta');
  assert.equal(deltas.length, 1, `100 个分片应合并为 1 帧，实际 ${deltas.length}`);
  assert.equal((deltas[0].data as Record<string, unknown>).text, 'x'.repeat(100));
  const completedAt = live.findIndex((e) => e.type === 'model_completed');
  const deltaAt = live.findIndex((e) => e.type === 'llm_delta');
  assert.ok(deltaAt >= 0 && deltaAt < completedAt, '增量必须先于 model_completed');
  tracer.flush();
});

test('63b) reasoning/content/tool_call 分通道合并，不串文本', () => {
  const live: TraceEvent[] = [];
  const logger = new EventLogger({ maxContentChars: 1000, console: false, onLive: (e) => live.push(e) });
  const tracer = new Tracer(logger);
  const spanId = tracer.start('run_channels', 'llm', 'mock');
  tracer.delta('run_channels', spanId, 'reasoning', '思');
  tracer.delta('run_channels', spanId, 'reasoning', '考');
  tracer.delta('run_channels', spanId, 'content', '答');
  tracer.delta('run_channels', spanId, 'content', '案');
  tracer.finish('run_channels', spanId, 'llm');

  const deltas = live.filter((e) => e.type === 'llm_delta');
  assert.equal(deltas.length, 2);
  const byChannel = Object.fromEntries(deltas.map((e) => [(e.data as any).channel, (e.data as any).text]));
  assert.deepEqual(byChannel, { reasoning: '思考', content: '答案' });
  tracer.flush();
});
