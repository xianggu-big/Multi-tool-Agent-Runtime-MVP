// tests/31_retry_budget.test.ts — 模型调用重试预算（429/5xx/网络瞬断可重试，4xx 不可）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIProvider, isRetryableProviderError, parseRetryAfterMs } from '../src/llm/OpenAIProvider.js';
import type { LLMChatRequest } from '../src/types.js';

const REQ: LLMChatRequest = { system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [], params: {} };

function withFetch(steps: Array<{ status?: number; retryAfter?: string } | 'ok'>, fn: () => Promise<void>): Promise<void> {
  let i = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => {
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    if (step === 'ok' || !step.status) {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, model: 'test' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (step.retryAfter) headers['retry-after'] = step.retryAfter;
    return new Response(JSON.stringify({ error: 'limited' }), { status: step.status, headers });
  }) as typeof globalThis.fetch;
  return fn().finally(() => { globalThis.fetch = orig; });
}

function makeProvider() {
  return new OpenAIProvider({ apiKey: 'sk-test', baseUrl: 'https://example.test/v1', model: 'test', retryBudget: 2, streamIdleTimeoutMs: 0 });
}

test('31a) 429 两次后成功 → 重试预算生效（非流式）', async () => {
  const p = makeProvider();
  await withFetch([{ status: 429, retryAfter: '0' }, { status: 429, retryAfter: '0' }, 'ok'], async () => {
    const resp = await p.chat(REQ);
    assert.equal(resp.content, 'hi');
    assert.equal(resp.stopReason, 'end_turn');
  });
});

test('31b) 400 不可重试 → 立即失败（1 次尝试）', async () => {
  const p = makeProvider();
  await withFetch([{ status: 400 }], async () => {
    await assert.rejects(() => p.chat(REQ), /400/);
  });
});

test('31c) 重试耗尽 → 错误注明已重试次数', async () => {
  const p = makeProvider();
  await withFetch([{ status: 429, retryAfter: '0' }, { status: 429, retryAfter: '0' }, { status: 429, retryAfter: '0' }], async () => {
    await assert.rejects(() => p.chat(REQ), /已重试 2 次仍失败/);
  });
});

test('31d) 5xx 可重试，网络错可重试；isRetryableProviderError 判定', () => {
  const mk = (s: number) => { const e = new Error('x'); (e as any).status = s; return e; };
  assert.equal(isRetryableProviderError(mk(429)), true);
  assert.equal(isRetryableProviderError(mk(503)), true);
  assert.equal(isRetryableProviderError(mk(400)), false);
  const net = new Error('fetch failed'); (net as any).network = true;
  assert.equal(isRetryableProviderError(net), true);
  const idle = new Error('STREAM_IDLE'); (idle as any).streamIdle = true;
  assert.equal(isRetryableProviderError(idle), true);
  assert.equal(parseRetryAfterMs('2'), 2000);
  assert.equal(parseRetryAfterMs(null), undefined);
});
