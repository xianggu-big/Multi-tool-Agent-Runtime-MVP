import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRuntime, mockProvider } from './helpers.js';
import type { MockResponder } from '../src/llm/MockProvider.js';
import type { RunInput } from '../src/types.js';

test('10) 用户主动取消任务', async () => {
  const { runtime } = makeRuntime();
  const origFetch = (globalThis as any).fetch;
  // 伪造一个会挂起、直到 AbortSignal 中止的 fetch
  (globalThis as any).fetch = ((_url: string, opts: any) => {
    const sig = opts?.signal as AbortSignal | undefined;
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => resolve(new Response('<html>hi</html>', { status: 200, headers: { 'content-type': 'text/html' } })),
        5000,
      );
      sig?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
  }) as any;

  try {
    const responder: MockResponder = ({ callIndex }) => {
      if (callIndex === 0) {
        return { stopReason: 'tool_use', content: '获取页面', toolCalls: [{ id: 'c1', name: 'fetch_page', arguments: { url: 'https://example.com' } }] };
      }
      return { stopReason: 'end_turn', content: '完成。' };
    };
    const input: RunInput = { runType: 'research', goal: '取消测试' };
    const runId = runtime.createRun(input, mockProvider(responder));
    const p = runtime.run(input, runId); // 不 await，模拟后台运行
    setTimeout(() => runtime.cancel(runId), 200);
    const result = await p;
    assert.equal(result.status, 'cancelled');
  } finally {
    (globalThis as any).fetch = origFetch;
  }
});
