// src/demo/orchestrator.ts — 多 Agent 编排演示（Mock 模式，无 API Key）
// 链路：主 Agent 拆分 → delegate_subtasks 并行派发 → 子 Agent 各自执行并上报 →
//       主 Agent 汇总核验 → submit_orchestration 结束
import { resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { buildRuntime } from '../runtime/index.js';
import { preSplitSubtasks, pickTopLevelDirs } from '../runtime/preSplit.js';
import type { RunInput } from '../types.js';

const config = loadConfig();
const { runtime, store, tracer } = buildRuntime(config, ':memory:');
const repoPath = resolve('demo/codebase-sample');
const goal = '清点并审计这个仓库：src 目录有多少文件/怎么分布，有没有 TODO 或可疑硬编码？';

// 规则式预筛（零 token）：先按天然分区给出候选子任务，主 Agent 在此基础上细化
const suggested = preSplitSubtasks(goal, {
  dirs: pickTopLevelDirs(repoPath),
  maxWidth: config.subagent.maxWidth,
});

const input: RunInput = {
  runType: 'orchestrator',
  goal,
  repoPath,
  mockScenario: 'orchestrator-basic',
  orchestration: { suggestedSubtasks: suggested },
};

console.log('=== 预筛候选子任务（规则式，零 token）===');
for (const [i, s] of suggested.entries()) {
  console.log(`  ${i + 1}. [${s.specId}] ${s.objective}  输入=${JSON.stringify(s.inputs ?? {})}`);
}

const runId = runtime.createRun(input);
const result = await runtime.run(input, runId);

console.log('\n=== 编排结果 ===');
console.log('runId      :', result.runId);
console.log('status     :', result.status);
console.log('steps      :', result.steps, '| modelCalls:', result.modelCalls, '| toolCalls:', result.toolCalls);
console.log('totalMs    :', result.totalDurationMs, '| isMock:', result.isMock);

console.log('\n--- 子任务（并行执行）---');
for (const st of result.subtasks ?? []) {
  console.log(
    `  [${st.status}] ${st.specId}｜${st.objective}\n` +
      `      ${st.durationMs}ms · ${st.modelCalls} 次模型调用 · ${st.usage.totalTokens} tokens` +
      `${st.report?.confidence ? ` · 置信度 ${st.report.confidence}` : ''}` +
      `${st.report?.evidence?.length ? ` · 证据 ${st.report.evidence.length} 条` : ''}` +
      `${st.contractViolation ? `\n      ⚠️ ${st.contractViolation}` : ''}`,
  );
}

const orch = result.orchestration;
if (orch) {
  console.log('\n--- 汇总报告 ---');
  console.log('structured :', orch.structured);
  console.log('summary    :', orch.summary);
  console.log('subtasks   :', JSON.stringify(orch.subtasks));
  for (const f of orch.findings ?? []) console.log(`  · [${f.from}] ${f.note}${f.path ? ` (${f.path})` : ''}`);
  for (const c of orch.conflicts ?? []) console.log(`  ⚡ 冲突: ${c.topic} — ${c.resolution}`);
  for (const u of orch.unresolved ?? []) console.log(`  ⚠️ 未解决: ${u}`);
}

tracer.flush();
store.close();
