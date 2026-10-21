// tests/27_thinking_guard.test.ts — thinking×maxTokens 防护与截断失败的可定位性
// 事故驱动（run_mv6afboo）：maxTokens=2000 + thinking=enabled → 思考 token 独占上限，
// 正文为空（stop=max_tokens, content=''）→ 子任务全部 EMPTY_RESULT、主 Agent 答案残缺。
// 覆盖：① sanitize 防护抬升+披露 ② Provider 透传 ③ 子 Agent 截断失败给出可定位的 errorCode/消息
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { buildRuntime } from '../src/runtime/index.js';
import { sanitizeParamsForModel, THINKING_MIN_MAX_TOKENS } from '../src/llm/presets.js';
import { buildParamsBody, buildRequestBody } from '../src/llm/OpenAIProvider.js';
import { runSubAgent } from '../src/runtime/subAgentLoop.js';
import { SUB_AGENT_SPECS } from '../src/agents/specs.js';
import { mockProvider } from './helpers.js';
import type { MockResponder } from '../src/llm/MockProvider.js';
import { resolve } from 'node:path';

const WORKSPACE = resolve('demo/codebase-sample');

// ---------------------------------------------------------------------------
// 1. sanitizeParamsForModel：thinking 模式下 maxTokens 过小被抬升并披露
// ---------------------------------------------------------------------------

test('27a) sanitizeParamsForModel：thinking+小 maxTokens → 抬到安全下限并报 adjusted', () => {
  // thinking enabled + maxTokens 2000（事故配置）→ 抬到 8192
  const r1 = sanitizeParamsForModel({ thinking: 'enabled', maxTokens: 2000, temperature: 0 });
  assert.equal(r1.params.maxTokens, THINKING_MIN_MAX_TOKENS);
  assert.equal(r1.adjusted.length, 1);
  assert.equal(r1.adjusted[0].param, 'maxTokens');
  assert.equal(r1.adjusted[0].from, 2000);
  assert.equal(r1.adjusted[0].to, THINKING_MIN_MAX_TOKENS);
  // 思考模式下 temperature 被丢弃（既有行为，不应受影响）
  assert.ok(r1.dropped.includes('temperature'));

  // thinking 关闭 + maxTokens 2000 → 不抬升（小 maxTokens 是用户自由，只有 thinking 才有独占风险）
  const r2 = sanitizeParamsForModel({ thinking: 'disabled', maxTokens: 2000 });
  assert.equal(r2.params.maxTokens, 2000);
  assert.equal(r2.adjusted.length, 0);

  // thinking enabled + maxTokens 已达安全下限 → 不抬升
  const r3 = sanitizeParamsForModel({ thinking: 'enabled', maxTokens: THINKING_MIN_MAX_TOKENS });
  assert.equal(r3.params.maxTokens, THINKING_MIN_MAX_TOKENS);
  assert.equal(r3.adjusted.length, 0);

  // thinking enabled + maxTokens 未设（交厂商默认）→ 不强行塞值
  const r4 = sanitizeParamsForModel({ thinking: 'enabled' });
  assert.equal(r4.params.maxTokens, undefined);
  assert.equal(r4.adjusted.length, 0);
});

// ---------------------------------------------------------------------------
// 2. Provider 透传：buildParamsBody / buildRequestBody 把 adjusted 带出来，body 用抬升后的值
// ---------------------------------------------------------------------------

test('27b) buildParamsBody/buildRequestBody：thinking+小 maxTokens → body.max_tokens=8192 且 adjusted 非空', () => {
  const bp = buildParamsBody({ thinking: 'enabled', maxTokens: 2000, temperature: 0 });
  assert.equal(bp.body.max_tokens, THINKING_MIN_MAX_TOKENS, '请求体用抬升后的值');
  assert.equal(bp.adjusted.length, 1, 'adjusted 必须带出来供事件披露');
  assert.ok(!('temperature' in bp.body), '思考模式下 temperature 应被丢弃');

  const req = buildRequestBody(
    { model: 'deepseek-flash', params: { thinking: 'enabled', maxTokens: 1500 } },
    { system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [], params: {} } as any,
    false,
  );
  assert.equal(req.body.max_tokens, THINKING_MIN_MAX_TOKENS);
  assert.equal(req.adjusted.length, 1);
  assert.equal(req.adjusted[0].from, 1500);
});

// ---------------------------------------------------------------------------
// 3. 子 Agent 截断失败：给出可定位的 OUTPUT_TRUNCATED（而不是笼统的 EMPTY_RESULT）
// ---------------------------------------------------------------------------

test('27c) 子 Agent 输出被 max_tokens 截断 → failed + OUTPUT_TRUNCATED + 可定位消息', async () => {
  const config = loadConfig();
  config.stream.liveDeltas = false;
  const { store, tracer, registry } = buildRuntime(config, ':memory:');
  // Mock：始终返回 stop=max_tokens、正文为空、无工具调用（复刻事故 run_mv6afboo 的子任务收尾）
  const responder: MockResponder = () => ({ stopReason: 'max_tokens' as any, content: '', toolCalls: [] });
  const provider = mockProvider(responder);

  const spec = SUB_AGENT_SPECS.find((s) => s.id === 'code-audit')!;
  const outcome = await runSubAgent({
    parentRunId: 'run_test_trunc',
    request: { specId: 'code-audit', objective: '审计 src', inputs: { dir: 'src' } },
    spec,
    provider,
    registry,
    tracer,
    config,
    repoPath: WORKSPACE,
    signal: new AbortController().signal,
    streamDeltas: false,
  });

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.errorCode, 'OUTPUT_TRUNCATED', '要用可定位的码，不是笼统的 EMPTY_RESULT');
  assert.match(outcome.failureReason ?? '', /max_tokens|截断/, '消息要点出根因');
  assert.match(outcome.failureReason ?? '', /thinking|思考/, '消息要提示思考独占');

  tracer.flush();
  store.close();
});
