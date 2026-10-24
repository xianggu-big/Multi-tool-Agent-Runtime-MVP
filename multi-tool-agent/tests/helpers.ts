// tests/helpers.ts — 测试共享工具（非测试文件，不会被 node --test 直接执行）
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildRuntime } from '../src/runtime/index.js';
import type { RuntimeConfig } from '../src/config.js';
import { MockProvider } from '../src/llm/MockProvider.js';
import type { MockResponder } from '../src/llm/MockProvider.js';
import type { LLMProvider } from '../src/types.js';
import { buildRegistry } from '../src/tools/index.js';
import type { ToolContext, ToolRuntimeConfig } from '../src/tools/types.js';

export function makeRuntime(opts: { runTestsEnabled?: boolean; writeEnabled?: boolean } = {}) {
  const config = loadConfig();
  config.codebase.runTestsEnabled = opts.runTestsEnabled ?? false;
  // M1'：显式化测试基线（不依赖环境默认）——默认关闭写能力（测试不碰 Docker/沙箱）；
  // 需要写路径的用例显式传 writeEnabled: true。
  config.codebase.writeEnabled = opts.writeEnabled ?? false;
  const bundle = buildRuntime(config, ':memory:');
  return bundle;
}

export function mockProvider(responder: MockResponder): LLMProvider {
  return new MockProvider(responder);
}

export function registryWithAll(): ReturnType<typeof buildRegistry> {
  return buildRegistry();
}

export function baseToolConfig(runTestsEnabled = false): ToolRuntimeConfig {
  return {
    search: { provider: 'offline', apiKey: undefined, baseUrl: 'https://example.invalid' },
    codebase: { runTestsEnabled, allowedTestCommands: ['node --test', 'npm test'], writeEnabled: false },
    misc: { scanLimit: 5000, maxFileBytes: 262144 },
    subagent: { maxConcurrency: 4, maxWidth: 4, maxDepth: 1, resultChars: 800 },
    maxOutputBytes: 256 * 1024,
    log: { maxContentChars: 2000, toolResults: false },
    approval: { maxFilesPerRequest: 10 },
    sandbox: {
      image: 'mta-sandbox:node24',
      hostNodePath: 'D:/Program Files/nodejs/node.exe',
      execTimeoutMs: 600000,
      l2BeforeApproval: false,
    },
    codex: {
      enabled: false,
      bin: 'codex',
      model: undefined,
      timeoutMs: 600000,
      maxOutputBytes: 4 * 1024 * 1024,
      reasoningTap: false,
      summaryChars: 20000,
    },
  };
}

export function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    runId: 'test',
    runType: 'codebase',
    allowedPermissions: ['codebase:read', 'codebase:test'],
    repoPath: resolve('demo/codebase-sample'),
    signal: undefined,
    maxOutputBytes: 256 * 1024,
    config: baseToolConfig(),
    ...over,
  };
}

export function defaultConfig(): RuntimeConfig {
  return loadConfig();
}
