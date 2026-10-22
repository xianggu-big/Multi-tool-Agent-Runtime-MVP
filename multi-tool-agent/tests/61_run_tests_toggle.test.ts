// tests/61_run_tests_toggle.test.ts — 运行测试能力的显式开关
//
// 背景：CODEBASE_RUN_TESTS_ENABLED 默认 false（执行代码是高风险能力）。
// 旧行为下模型仍能看到并调用 run_tests，拿到 DISABLED 后复盘显示「完成但过程有问题」。
// 现在：未开启 → run_tests 不进工具池；本 run 可显式勾选开启。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { buildRuntime } from '../src/runtime/index.js';
import { validateRunRequest } from '../src/server.js';
import { codebaseDemoResponder } from '../src/llm/scenarios.js';
import type { ChatMessage } from '../src/types.js';

function allowedToolsFor(allowRunTests: boolean | undefined, deployDefault = false): string[] {
  const config = loadConfig();
  config.codebase.runTestsEnabled = deployDefault;
  const bundle = buildRuntime(config, ':memory:');
  return (bundle.runtime as any).resolveAllowedTools({
    runType: 'codebase',
    goal: '分析仓库',
    repoPath: process.cwd(),
    allowRunTests,
  });
}

test('61a) 默认关闭时 run_tests 不进工具池（模型看不到，也就不会白调）', () => {
  const allowed = allowedToolsFor(undefined, false);
  assert.ok(!allowed.includes('run_tests'), `不应包含 run_tests，实际: ${allowed.join(',')}`);
  assert.ok(allowed.includes('read_file') && allowed.includes('search_files'));
});

test('61b) 本 run 显式开启可覆盖部署默认', () => {
  assert.ok(allowedToolsFor(true, false).includes('run_tests'), '显式 true 应开启');
  assert.ok(!allowedToolsFor(false, true).includes('run_tests'), '显式 false 应关闭');
  assert.ok(allowedToolsFor(undefined, true).includes('run_tests'), '未显式指定时跟随部署默认');
});

test('61c) HTTP 层只接受显式布尔；非布尔直接 400 文案', () => {
  const config = loadConfig();
  const base = { runType: 'codebase', goal: '分析仓库', repoPath: process.cwd() };
  const bad = validateRunRequest({ ...base, allowRunTests: 'true' }, config);
  assert.match(bad.error ?? '', /allowRunTests/);
  const ok = validateRunRequest({ ...base, allowRunTests: true }, config);
  assert.equal(ok.error, undefined);
  assert.equal(ok.input?.allowRunTests, true);
  const absent = validateRunRequest(base, config);
  assert.equal(absent.error, undefined);
  assert.equal(absent.input?.allowRunTests, undefined);
});

test('61d) Mock 剧本按工具池自适应：没有 run_tests 就直接收尾', () => {
  const responder = codebaseDemoResponder('分析仓库');
  const messages: ChatMessage[] = [
    { role: 'assistant', content: '读取文件', toolCalls: [] } as ChatMessage,
    { role: 'tool', content: '{"ok":true,"data":{"path":"src/calc.js","content":"export function add(){}"}}', toolName: 'read_file' } as ChatMessage,
  ];
  const without = responder({ messages, tools: [{ name: 'search_files' }, { name: 'read_file' }], goal: '分析仓库', callIndex: 2 });
  assert.equal(without.stopReason, 'end_turn');
  assert.match(without.content, /未启用运行测试/);

  const withTests = responder({
    messages,
    tools: [{ name: 'search_files' }, { name: 'read_file' }, { name: 'run_tests' }],
    goal: '分析仓库',
    callIndex: 2,
  });
  assert.equal(withTests.stopReason, 'tool_use');
  assert.equal(withTests.toolCalls?.[0]?.name, 'run_tests');
});

test('61e) 前端有开关，并且提交时按 codebase 类型透传', () => {
  const html = readFileSync('public/index.html', 'utf8');
  assert.ok(html.includes('id="allowRunTests"'), '缺少「允许运行测试」开关');
  assert.ok(html.includes("body.allowRunTests = $('allowRunTests').checked"), '提交载荷未透传 allowRunTests');
  assert.ok(html.includes("$('runTestsWrap').classList.toggle('hide', t === 'misc')"), '杂项任务应隐藏该开关');
});