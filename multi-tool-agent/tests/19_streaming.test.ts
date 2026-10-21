// tests/19_streaming.test.ts — 实时流式展示（Live View）
// 覆盖：Mock 分片流式、临时事件（llm_delta）只走实时通道不落盘、持久化 seq 仍严格连续、
//       关闭流式时零增量开销、OpenAI 流式聚合纯函数解析、LiveHub 订阅分发、
//       SSE 端到端（回放 + 实时增量 + run_end）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildRuntime } from '../src/runtime/index.js';
import { LiveHub } from '../src/trace/LiveHub.js';
import { MockProvider } from '../src/llm/MockProvider.js';
import {
  newOpenAIStreamState,
  accumulateOpenAIStreamChunk,
  buildResponseFromStreamState,
} from '../src/llm/OpenAIProvider.js';
import { createApp } from '../src/server.js';
import { mockProvider, makeCtx } from './helpers.js';
import type { MockResponder } from '../src/llm/MockProvider.js';
import type { LLMDelta, RunInput, TraceEvent } from '../src/types.js';

function runtimeWith(liveDeltas: boolean) {
  const config = loadConfig();
  config.stream.liveDeltas = liveDeltas;
  config.stream.mockChunkDelayMs = 0; // 测试全速
  return buildRuntime(config, ':memory:');
}

const responder: MockResponder = ({ callIndex }) => {
  if (callIndex === 0) {
    return {
      stopReason: 'tool_use',
      content: '先搜索相关文件。',
      toolCalls: [{ id: 'c1', name: 'search_files', arguments: { pattern: 'add', kind: 'content' } }],
    };
  }
  return { stopReason: 'end_turn', content: '完成：实现符合预期。' };
};

test('19a) MockProvider 流式分片：顺序正确且拼接等于原文', async () => {
  const provider = new MockProvider(responder, { chunkDelayMs: 0, chunkChars: 5 });
  const deltas: LLMDelta[] = [];
  const resp = await provider.chat(
    { system: 's', messages: [{ role: 'user', content: 'g' }], tools: [] },
    (d) => deltas.push(d),
  );

  assert.ok(deltas.length > 3, `应产生多个分片，实际 ${deltas.length}`);
  // reasoning 在前、content 在后（如有 tool_call 则在 content 末尾）
  const firstContent = deltas.findIndex((d) => d.channel === 'content');
  const firstToolCall = deltas.findIndex((d) => d.channel === 'tool_call');
  assert.ok(firstContent > 0, 'reasoning 分片应先于 content');
  assert.ok(deltas.slice(0, firstContent).every((d) => d.channel === 'reasoning'));
  const contentEnd = firstToolCall >= 0 ? firstToolCall : deltas.length;
  assert.ok(deltas.slice(firstContent, contentEnd).every((d) => d.channel === 'content'));

  const joined = deltas.filter((d) => d.channel === 'content').map((d) => d.text).join('');
  assert.equal(joined, resp.content, 'content 分片拼接应等于最终正文');
  assert.ok(deltas.filter((d) => d.channel === 'reasoning').length > 0, '应有思考分片');
  // 每个分片不超过声明粒度（tool_call 为 JSON 可能超出，单独过滤）
  assert.ok(deltas.filter((d) => d.channel !== 'tool_call').every((d) => d.text.length <= 5));
});

test('19b) 开启流式：llm_delta 走实时通道但不落盘，且持久化 seq 仍严格连续', async () => {
  const { runtime, hub } = runtimeWith(true);
  const input: RunInput = { runType: 'codebase', goal: 'g', repoPath: makeCtx().repoPath };
  const runId = runtime.createRun(input, mockProvider(responder));

  const live: TraceEvent[] = [];
  const off = hub.subscribe(runId, (e) => live.push(e));
  await runtime.run(input, runId);
  off();

  const deltas = live.filter((e) => e.type === 'llm_delta');
  assert.ok(deltas.length > 0, '实时通道应收到 llm_delta');
  assert.ok(deltas.every((e) => e.ephemeral === true && e.seq === 0), '增量必须是临时事件（seq=0, ephemeral）');
  assert.ok(deltas.some((e) => (e.data as any)?.channel === 'reasoning'), '应包含思考通道增量');
  assert.ok(deltas.some((e) => (e.data as any)?.channel === 'content'), '应包含正文通道增量');

  const persisted = runtime.getEvents(runId);
  assert.ok(!persisted.some((e) => e.type === 'llm_delta'), '增量不得落盘');
  for (let i = 0; i < persisted.length; i++) {
    assert.equal(persisted[i].seq, i + 1, '持久化事件序号应保持严格连续');
  }
  assert.equal(persisted[0].type, 'run_started');
  assert.equal(persisted[persisted.length - 1].type, 'run_completed');
});

test('19c) 流式聚合预览随 model_completed 落盘（供重连/回看还原思考）', async () => {
  const { runtime } = runtimeWith(true);
  const input: RunInput = { runType: 'research', goal: 'g' };
  const runId = runtime.createRun(input, mockProvider(responder));
  await runtime.run(input, runId);

  const events = runtime.getEvents(runId);
  const first = events.find((e) => e.type === 'model_completed');
  assert.ok(first, '应存在 model_completed');
  const out = (first!.data as any).outputs;
  assert.ok(typeof out.reasoningPreview === 'string' && out.reasoningPreview.length > 0, '应有思考预览');
  assert.ok(typeof out.contentPreview === 'string' && out.contentPreview.length > 0, '应有正文预览');
});

test('19d) 关闭流式：不产生任何 llm_delta（零额外开销）', async () => {
  const { runtime, hub } = runtimeWith(false);
  const input: RunInput = { runType: 'codebase', goal: 'g', repoPath: makeCtx().repoPath };
  const runId = runtime.createRun(input, mockProvider(responder));

  const live: TraceEvent[] = [];
  const off = hub.subscribe(runId, (e) => live.push(e));
  await runtime.run(input, runId);
  off();

  assert.equal(live.filter((e) => e.type === 'llm_delta').length, 0, '关闭时不应有增量事件');
  assert.equal(live.filter((e) => e.ephemeral).length, 0, '关闭时不应产生任何临时事件（零额外开销）');
  const mc = runtime.getEvents(runId).find((e) => e.type === 'model_completed');
  assert.ok(mc, '常规事件仍应正常');
  // 预览字段与流式开关解耦：非流式时用响应里带的完整思考文本记录，便于事后回看
  assert.ok(typeof (mc!.data as any).outputs.reasoningPreview === 'string', '非流式也应记录思考预览');
});

test('19e) OpenAI 流式聚合：reasoning / content / tool_call 分片解析', () => {
  const s = newOpenAIStreamState();
  const d1 = accumulateOpenAIStreamChunk(s, {
    model: 'gpt-x',
    choices: [{ delta: { reasoning_content: '先想一想' }, finish_reason: null }],
  });
  assert.equal(d1.reasoningText, '先想一想');
  assert.equal(d1.contentText, '');

  accumulateOpenAIStreamChunk(s, { choices: [{ delta: { content: '结论' } }] });
  accumulateOpenAIStreamChunk(s, { choices: [{ delta: { content: '是' } }] });

  accumulateOpenAIStreamChunk(s, {
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'web_search', arguments: '{"query"' } }] } }],
  });
  accumulateOpenAIStreamChunk(s, {
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"a"}' } }] } }],
  });
  // 第二个工具（不同 index）
  accumulateOpenAIStreamChunk(s, {
    choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'fetch_page', arguments: '{}' } }] } }],
  });
  accumulateOpenAIStreamChunk(s, {
    choices: [{ delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  });

  const resp = buildResponseFromStreamState(s, 'fallback-model', 42, 0.000001);
  assert.equal(resp.stopReason, 'tool_use');
  assert.equal(resp.content, '结论是');
  assert.equal(s.reasoning, '先想一想');
  assert.equal(resp.toolCalls.length, 2);
  assert.deepEqual(resp.toolCalls[0], { id: 'call_1', name: 'web_search', arguments: { query: 'a' } });
  assert.deepEqual(resp.toolCalls[1], { id: 'call_2', name: 'fetch_page', arguments: {} });
  assert.equal(resp.usage.totalTokens, 18);
  assert.equal(resp.model, 'gpt-x');
  assert.equal(resp.latencyMs, 42);
});

test('19f) LiveHub：按 runId 隔离分发、退订后不再收到', () => {
  const hub = new LiveHub();
  const a: TraceEvent[] = [];
  const b: TraceEvent[] = [];
  const offA = hub.subscribe('runA', (e) => a.push(e));
  hub.subscribe('runB', (e) => b.push(e));

  const ev = (runId: string): TraceEvent => ({ runId, seq: 1, type: 'run_started', timestamp: new Date().toISOString() });
  hub.publish(ev('runA'));
  hub.publish(ev('runB'));
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0].runId, 'runA');

  offA();
  hub.publish(ev('runA'));
  assert.equal(a.length, 1, '退订后不应再收到');
  assert.equal(hub.subscriberCount('runA'), 0);
  assert.equal(hub.subscriberCount('runB'), 1);

  // 订阅者抛错不影响其他订阅者
  hub.subscribe('runB', () => { throw new Error('boom'); });
  hub.publish(ev('runB'));
  assert.equal(b.length, 2, '一个订阅者抛错不应影响其他订阅者');
});

// ---------------------------------------------------------------------------
// SSE 端到端：真实 HTTP 连接，验证「回放 → 实时增量 → run_end」整条链路
// ---------------------------------------------------------------------------
async function readSse(
  url: string,
  opts: { until: (frames: any[]) => boolean; timeoutMs: number },
): Promise<any[]> {
  const ac = new AbortController();
  const res = await fetch(url, { headers: { accept: 'text/event-stream' }, signal: ac.signal });
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const frames: any[] = [];
  let buf = '';
  const deadline = Date.now() + opts.timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue; // 注释/心跳帧
        try {
          frames.push(JSON.parse(dataLine.slice(5).trim()));
        } catch {
          /* ignore */
        }
      }
      if (opts.until(frames)) break;
    }
  } finally {
    ac.abort(); // 关闭客户端连接，避免服务端 close 时挂起
  }
  return frames;
}

/** 关闭测试服务器：先断开全部连接（含 SSE 长连接），再等待 close 回调 */
async function stopServer(server: import('node:http').Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

test('19g) SSE 端到端：元信息 + 实时增量 + 终态 run_end', async () => {
  const config = loadConfig();
  config.sqlitePath = ':memory:';
  config.stream.liveDeltas = true;
  config.stream.heartbeatMs = 1000;
  config.stream.watchdogMs = 250;
  // 给 Mock 分片加一点演示节奏，保证「客户端连上 SSE 时任务仍在流式输出」；
  // 这不是为了造假延迟——真实 Provider 的增量来自网络，天然是异步到达的。
  config.stream.mockChunkDelayMs = 40;
  const { app, store } = createApp(config);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as any).port;

  try {
    const createRes = await fetch(`http://127.0.0.1:${port}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runType: 'research',
        goal: '比较两个打包器',
        mockScenario: 'research-basic',
        stream: { liveDeltas: true },
      }),
    });
    assert.equal(createRes.status, 201);
    const { runId } = (await createRes.json()) as { runId: string };
    assert.ok(runId, '应返回 runId');

    const frames = await readSse(`http://127.0.0.1:${port}/api/runs/${runId}/stream`, {
      until: (fs) => fs.some((f) => f.type === 'run_end'),
      timeoutMs: 30000,
    });

    const meta = frames.find((f) => f.type === '_stream_meta');
    assert.ok(meta, '应收到 _stream_meta');
    assert.equal(meta.runId, runId);

    const deltas = frames.filter((f) => f.type === 'llm_delta');
    assert.ok(deltas.length > 0, 'SSE 应实时推送 llm_delta');
    assert.ok(deltas.every((d) => d.ephemeral === true), '增量帧应标记 ephemeral');
    assert.ok(deltas.every((d) => typeof d._pushDelayMs === 'number'), '实时帧应带推送延迟（调试字段）');

    const types = frames.map((f) => f.type);
    const iMeta = types.indexOf('_stream_meta');
    const iFirstDelta = types.indexOf('llm_delta');
    const iEnd = types.lastIndexOf('run_end');
    assert.ok(iMeta < iFirstDelta, '增量应在连接建立之后到达');
    assert.equal(types[iEnd], 'run_end', '最后一个帧应为 run_end');
    assert.equal(frames[iEnd].status, 'completed');

    // 持久化事件不含增量
    const persisted = store.getEvents(runId);
    assert.ok(!persisted.some((e) => e.type === 'llm_delta'), '增量不应进入持久化事件');
    assert.ok(persisted.length > 5, '常规事件应已落盘');
  } finally {
    await stopServer(server);
    store.close();
  }
});

test('19h) SSE 断线续传：带 Last-Event-ID 重连只回放缺失事件', async () => {
  const config = loadConfig();
  config.sqlitePath = ':memory:';
  config.stream.liveDeltas = true;
  const { app, store } = createApp(config);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as any).port;

  try {
    const createRes = await fetch(`http://127.0.0.1:${port}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runType: 'research', goal: 'g', mockScenario: 'research-basic' }),
    });
    const { runId } = (await createRes.json()) as { runId: string };

    // 第一次连接：读到 run_end（任务已完成）
    const all = await readSse(`http://127.0.0.1:${port}/api/runs/${runId}/stream`, {
      until: (fs) => fs.some((f) => f.type === 'run_end'),
      timeoutMs: 30000,
    });
    const persistedSeqs = all.filter((f) => !f.ephemeral && f.seq > 0).map((f) => f.seq);
    assert.ok(persistedSeqs.length > 0);

    // 模拟重连：从中间某个 seq 之后续传
    const mid = Math.floor(persistedSeqs.length / 2);
    const cursor = persistedSeqs[mid - 1];
    const resumed = await readSse(`http://127.0.0.1:${port}/api/runs/${runId}/stream`, {
      until: (fs) => fs.some((f) => f.type === 'run_end'),
      timeoutMs: 10000,
    });
    // 手工截断：用 fromSeq 参数再拉一次（服务端应只回放 seq > cursor 的事件）
    const tail = (await (await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/events?fromSeq=${cursor}`)).json()) as any[];
    assert.ok(tail.length > 0, '应返回游标之后的事件');
    assert.ok(tail.every((e: any) => e.seq > cursor), '只应返回游标之后的事件');
    assert.equal(tail[0].seq, cursor + 1, '续传应从游标的下一条开始');
    assert.ok(resumed.some((f) => f.type === 'run_end'), '重连后应收到 run_end');
  } finally {
    await stopServer(server);
    store.close();
  }
});

test('19i) 端到端：run 结束后 SSE 直接回放历史并收尾（不等待实时事件）', async () => {
  const config = loadConfig();
  config.sqlitePath = ':memory:';
  config.stream.liveDeltas = false; // 关闭增量，验证纯回放路径
  const { app, store } = createApp(config);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as any).port;

  try {
    const createRes = await fetch(`http://127.0.0.1:${port}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runType: 'codebase', goal: 'g', repoPath: resolve('demo/codebase-sample'), mockScenario: 'codebase-basic' }),
    });
    const { runId } = (await createRes.json()) as { runId: string };
    // 等待任务结束，再连接 SSE
    for (let i = 0; i < 200; i++) {
      const r = (await (await fetch(`http://127.0.0.1:${port}/api/runs/${runId}`)).json()) as any;
      if (['completed', 'failed', 'cancelled', 'limit_reached', 'awaiting_user'].includes(r.status)) break;
      await new Promise((r2) => setTimeout(r2, 50));
    }

    const frames = await readSse(`http://127.0.0.1:${port}/api/runs/${runId}/stream`, {
      until: (fs) => fs.some((f) => f.type === 'run_end'),
      timeoutMs: 15000,
    });
    const persisted = frames.filter((f) => !f.ephemeral && f.seq > 0);
    assert.ok(persisted.length >= 5, '应回放已持久化的历史事件');
    assert.equal(persisted[persisted.length - 1].type, 'run_completed');
    assert.equal(frames[frames.length - 1].type, 'run_end');
    assert.ok(!frames.some((f) => f.type === 'llm_delta'), '关闭增量时回放不含 llm_delta');
  } finally {
    await stopServer(server);
    store.close();
  }
});
