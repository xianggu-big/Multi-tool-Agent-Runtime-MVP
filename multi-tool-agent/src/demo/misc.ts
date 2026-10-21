// src/demo/misc.ts — 杂项 Agent 端到端演示（Mock 模式，无 API Key）
// 演示链路：dir_stats（只读清点）→ submit_result（终结性工具，结构化提交）→ 任务立即完成
import { resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { buildRuntime } from '../runtime/index.js';
import type { RunInput } from '../types.js';

const config = loadConfig();
const { runtime, store, tracer } = buildRuntime(config, ':memory:');

const input: RunInput = {
  runType: 'misc',
  goal: '清点 demo/codebase-sample 目录：有多少文件、总大小多少、按扩展名怎么分布？',
  repoPath: resolve('demo/codebase-sample'),
  misc: { subtask: 'inventory' },
  mockScenario: 'misc-basic',
};

const runId = runtime.createRun(input);
const result = await runtime.run(input, runId);

console.log('=== 杂项 Agent 演示（Mock）===');
console.log('runId      :', result.runId);
console.log('status     :', result.status);
console.log('steps      :', result.steps, '| modelCalls:', result.modelCalls, '| toolCalls:', result.toolCalls);
console.log('totalMs    :', result.totalDurationMs);
console.log('isMock     :', result.isMock);
console.log('finalAnswer:', result.finalAnswer);
if (result.misc) {
  console.log('--- 结构化结论（submit_result）---');
  console.log('structured :', result.misc.structured);
  console.log('summary    :', result.misc.summary);
  for (const it of result.misc.items ?? []) {
    console.log(`  · ${it.label}: ${it.value}${it.detail ? ` (${it.detail})` : ''}`);
  }
  console.log('escalateTo :', result.misc.escalateTo ?? '（无，任务在能力范围内）');
}
tracer.flush();
store.close();
