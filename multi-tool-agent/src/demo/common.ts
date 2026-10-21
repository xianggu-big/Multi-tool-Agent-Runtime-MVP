// src/demo/common.ts — 端到端演示共享逻辑（Mock 模式，无 API Key）
import { resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { buildRuntime } from '../runtime/index.js';
import type { RunInput, RunResult } from '../types.js';

export function demoConfig() {
  const config = loadConfig();
  // 演示中允许 run_tests 在隔离的示例仓库执行
  config.codebase.runTestsEnabled = true;
  return config;
}

export async function runCodebaseDemo(): Promise<RunResult> {
  const config = demoConfig();
  const { runtime } = buildRuntime(config, ':memory:');
  const repoPath = resolve('demo/codebase-sample');
  const input: RunInput = {
    runType: 'codebase',
    goal: '分析这个仓库的加法与字符串工具实现，并运行受限测试验证其行为。',
    repoPath,
    mockScenario: 'codebase-basic',
    maxSteps: 12,
    maxModelCalls: 20,
    maxToolCalls: 20,
    totalTimeoutMs: 60000,
  };
  const runId = runtime.createRun(input);
  return runtime.run(input, runId);
}

export async function runResearchDemo(): Promise<RunResult> {
  const config = demoConfig();
  const { runtime } = buildRuntime(config, ':memory:');
  const input: RunInput = {
    runType: 'research',
    goal: '比较 esbuild 与 Rollup 这两个开源打包器的定位与特性。',
    research: { topics: ['esbuild', 'rollup'], allowedDomains: [] },
    mockScenario: 'research-basic',
    maxSteps: 12,
    maxModelCalls: 20,
    maxToolCalls: 20,
    totalTimeoutMs: 60000,
  };
  const runId = runtime.createRun(input);
  return runtime.run(input, runId);
}
