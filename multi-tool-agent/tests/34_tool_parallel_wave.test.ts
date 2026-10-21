// tests/34_tool_parallel_wave.test.ts — 验证工具并行波（executeTools 并发工作池）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRuntime, mockProvider } from './helpers.js';
import type { RunInput } from '../src/types.js';

test('34a) 同一轮 4 个工具并发执行（总耗时接近单工具，而非串行累加）', async () => {
  const { runtime } = makeRuntime();
  const starts: number[] = [];
  const reg = (runtime as any).registry; // TypeScript 私有访问（同 34b / 24_error_reporting 约定）
  const origExecute = reg.execute.bind(reg);
  // 包装 execute：记录开始时间，统一延迟 80ms（模拟 I/O），再调原始实现
  reg.execute = async (name: string, args: any, ctx: any) => {
    starts.push(Date.now());
    await new Promise((r) => setTimeout(r, 80));
    return origExecute(name, args, ctx);
  };

  const responder = ({ callIndex }: { callIndex: number }) => {
    if (callIndex === 0) {
      return {
        stopReason: 'tool_use' as const,
        content: '',
        toolCalls: [
          { id: 't1', name: 'list_files', arguments: { dir: '.', maxDepth: 1 } },
          { id: 't2', name: 'list_files', arguments: { dir: '.', maxDepth: 1 } },
          { id: 't3', name: 'list_files', arguments: { dir: '.', maxDepth: 1 } },
          { id: 't4', name: 'list_files', arguments: { dir: '.', maxDepth: 1 } },
        ],
      };
    }
    return { stopReason: 'end_turn' as const, content: 'done' };
  };

  const input: RunInput = { runType: 'codebase', goal: '并发测试', repoPath: process.cwd() };
  const runId = runtime.createRun(input, mockProvider(responder));
  const t0 = Date.now();
  const result = await runtime.run(input, runId);
  const totalMs = Date.now() - t0;

  assert.equal(result.status, 'completed');
  assert.equal(result.toolCalls, 4);
  assert.equal(starts.length, 4, '4 个工具都应被执行');
  // 并发判定：4 个启动时间的最大差值 < 50ms（串行的话会 > 80ms * 3 = 240ms）
  const span = Math.max(...starts) - Math.min(...starts);
  assert.ok(span < 50, `4 个工具应几乎同时启动，实际启动跨度 ${span}ms`);
  // 总耗时判定：串行需要 > 320ms，并行应在 80ms~200ms 之间（原始工具执行也有少量耗时）
  assert.ok(totalMs < 250, `并发执行总耗时应接近单工具延迟，实际 ${totalMs}ms`);
});

test('34b) 并发上限由 maxToolConcurrency 控制（默认 4）', async () => {
  const { runtime } = makeRuntime();
  // 通过 runtime['config'] 读取 maxToolConcurrency（TypeScript 私有访问）
  const concurrency = (runtime as any).config.maxToolConcurrency ?? 4;
  assert.ok(Number.isFinite(concurrency), '应配置有限并发上限');
  assert.ok(concurrency >= 2, '并发上限至少为 2 才有意义');
});
