// tests/78_runtime_guard.test.ts — 活动 run 上限：第二个 enqueue 必须 429 语义错误
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { buildRuntime } from '../src/runtime/index.js';
import { loadConfig } from '../src/config.js';
import type { LLMProvider } from '../src/types.js';

test('78a) MAX_ACTIVE_RUNS：超过上限抛 TOO_MANY_ACTIVE_RUNS；取消后可再入队', async () => {
  const config = loadConfig();
  config.maxActiveRuns = 1;
  config.codebase.writeEnabled = false;
  const { runtime, store } = buildRuntime(config, ':memory:');
  const hanging: LLMProvider = {
    name: 'hang-test',
    chat: (_req, _onDelta, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
  };
  const input = { runType: 'codebase' as const, goal: 'x', repoPath: resolve('demo/codebase-sample') };
  const first = runtime.enqueue(input, hanging);
  assert.throws(() => runtime.enqueue(input, hanging), /TOO_MANY_ACTIVE_RUNS/);
  assert.equal(runtime.cancelAllActive(), 1);
  const left = await runtime.waitForIdle(2000);
  assert.equal(left, 0, '取消后应退出活动集合');
  const second = runtime.enqueue(input, hanging);
  assert.notEqual(second, first);
  runtime.cancelAllActive();
  await runtime.waitForIdle(2000);
  store.close();
});
