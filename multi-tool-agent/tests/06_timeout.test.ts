import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ToolRegistry } from '../src/tools/Registry.js';
import { okResult } from '../src/tools/types.js';
import { makeCtx } from './helpers.js';

test('6) 工具执行超时由 Registry 统一处理为 TIMEOUT', async () => {
  const reg = new ToolRegistry();
  reg.register({
    name: 'sleep_tool',
    description: 'sleep',
    inputSchema: z.object({ ms: z.number() }),
    timeoutMs: 100,
    permission: 'codebase:read',
    riskLevel: 'safe',
    execute: async (input: any) => {
      await new Promise((r) => setTimeout(r, input.ms));
      return okResult('done', 1);
    },
  });
  const res = await reg.execute('sleep_tool', { ms: 500 }, makeCtx());
  assert.equal(res.result.ok, false);
  assert.equal(res.result.error?.code, 'TIMEOUT');
  assert.ok(res.result.durationMs >= 90 && res.result.durationMs < 500, `耗时应在超时附近，实际 ${res.result.durationMs}`);
});
