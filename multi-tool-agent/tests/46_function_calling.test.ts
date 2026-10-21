// tests/46_function_calling.test.ts — P1 function calling：schema / tool_choice / 并行调用
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequestBody } from '../src/llm/OpenAIProvider.js';
import { makeRuntime } from './helpers.js';
import { createApp, validateRunRequest } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import type { LLMChatRequest, LLMProvider, LLMResponse, RunInput, ToolDefinition } from '../src/types.js';

const TOOL: ToolDefinition = {
  name: 'search_files',
  description: '在仓库中搜索',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '模式' },
      kind: { type: 'string', enum: ['content', 'filename'] },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
};

function req(over: Partial<LLMChatRequest> = {}): LLMChatRequest {
  return {
    system: 'system',
    messages: [{ role: 'user', content: '找 add 函数' }],
    tools: [TOOL],
    ...over,
  };
}

test('46a) 请求体：tool schema 原样放进 function.parameters，tool_choice 四种形态', () => {
  const auto = buildRequestBody({ model: 'deepseek-flash' }, req(), false).body;
  assert.equal(auto.tool_choice, 'auto');
  const tools = auto.tools as Array<{ type: string; function: { name: string; parameters: Record<string, unknown> } }>;
  assert.equal(tools[0].type, 'function');
  assert.equal(tools[0].function.name, 'search_files');
  assert.deepEqual(tools[0].function.parameters, TOOL.inputSchema);

  assert.equal(buildRequestBody({ model: 'm' }, req({ toolChoice: 'none' }), false).body.tool_choice, 'none');
  assert.equal(buildRequestBody({ model: 'm' }, req({ toolChoice: 'required' }), false).body.tool_choice, 'required');
  const forced = buildRequestBody({ model: 'm' }, req({
    toolChoice: { type: 'function', function: { name: 'search_files' } },
  }), false).body;
  assert.deepEqual(forced.tool_choice, { type: 'function', function: { name: 'search_files' } });
});

test('46b) 无工具时不发送 tool_choice / parallel_tool_calls；有工具时按显式值发送', () => {
  const noTools = buildRequestBody({ model: 'm' }, req({ tools: [], toolChoice: 'required', parallelToolCalls: true }), false).body;
  assert.equal(noTools.tool_choice, undefined);
  assert.equal(noTools.parallel_tool_calls, undefined);

  const limited = buildRequestBody({ model: 'm' }, req({ parallelToolCalls: false }), false).body;
  assert.equal(limited.parallel_tool_calls, false);
  const allowed = buildRequestBody({ model: 'm' }, req({ parallelToolCalls: true }), false).body;
  assert.equal(allowed.parallel_tool_calls, true);
  const unspecified = buildRequestBody({ model: 'm' }, req(), false).body;
  assert.equal(unspecified.parallel_tool_calls, undefined);
});

class CaptureProvider implements LLMProvider {
  readonly name = 'capture';
  readonly requests: LLMChatRequest[] = [];
  async chat(request: LLMChatRequest): Promise<LLMResponse> {
    this.requests.push(request);
    return {
      stopReason: 'end_turn',
      content: 'ok',
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, costUsd: 0, isEstimate: true },
      latencyMs: 1,
      model: 'capture',
    };
  }
}

test('46c) Runtime 把本 run 的 toolChoice / parallelToolCalls 透传到 Provider', async () => {
  const { runtime } = makeRuntime();
  const provider = new CaptureProvider();
  const input: RunInput = {
    runType: 'misc',
    goal: '验证工具选择策略',
    llm: { toolChoice: 'required', parallelToolCalls: false },
  };
  const runId = runtime.createRun(input, provider);
  const result = await runtime.run(input, runId);
  assert.equal(result.status, 'completed');
  assert.ok(provider.requests.length >= 1);
  assert.equal(provider.requests[0].toolChoice, 'required');
  assert.equal(provider.requests[0].parallelToolCalls, false);

  const second = new CaptureProvider();
  const input2: RunInput = { runType: 'misc', goal: '强制指定工具', llm: { toolChoice: { type: 'function', function: { name: 'list_files' } } } };
  const runId2 = runtime.createRun(input2, second);
  await runtime.run(input2, runId2);
  assert.deepEqual(second.requests[0].toolChoice, { type: 'function', function: { name: 'list_files' } });
});

test('46d) HTTP 边界：validateRunRequest 保留 toolChoice / parallelToolCalls，并拒绝非法值', () => {
  const cfg = loadConfig();
  const valid = validateRunRequest({
    runType: 'misc',
    goal: '验证工具选择策略',
    repoPath: process.cwd(),
    allowedTools: ['list_files', 'submit_result'],
    llm: { mode: 'mock', toolChoice: 'required', parallelToolCalls: false },
  }, cfg);
  assert.equal(valid.error, undefined);
  assert.equal(valid.input?.llm?.toolChoice, 'required');
  assert.equal(valid.input?.llm?.parallelToolCalls, false);

  const forced = validateRunRequest({
    runType: 'misc',
    goal: '强制指定工具',
    repoPath: process.cwd(),
    allowedTools: ['list_files', 'submit_result'],
    llm: { mode: 'mock', toolChoice: { type: 'function', function: { name: 'list_files' } } },
  }, cfg);
  assert.equal(forced.error, undefined);
  assert.deepEqual(forced.input?.llm?.toolChoice, { type: 'function', function: { name: 'list_files' } });

  const badString = validateRunRequest({
    runType: 'misc', goal: 'g', repoPath: process.cwd(), llm: { mode: 'mock', toolChoice: 'sometimes' },
  }, cfg);
  assert.match(badString.error ?? '', /toolChoice/);

  const badName = validateRunRequest({
    runType: 'misc',
    goal: 'g',
    repoPath: process.cwd(),
    allowedTools: ['list_files'],
    llm: { mode: 'mock', toolChoice: { type: 'function', function: { name: 'rm_rf' } } },
  }, cfg);
  assert.match(badName.error ?? '', /白名单/);

  const badParallel = validateRunRequest({
    runType: 'misc', goal: 'g', repoPath: process.cwd(), llm: { mode: 'mock', parallelToolCalls: 'false' },
  }, cfg);
  assert.match(badParallel.error ?? '', /parallelToolCalls/);

  const strict = validateRunRequest({
    runType: 'orchestrator',
    goal: '严格验证',
    repoPath: process.cwd(),
    orchestration: { strictVerify: true },
  }, cfg);
  assert.equal(strict.error, undefined);
  assert.equal(strict.input?.orchestration?.strictVerify, true);

  const defaulted = validateRunRequest({
    runType: 'orchestrator',
    goal: '默认验证',
    repoPath: process.cwd(),
    orchestration: {},
  }, cfg);
  assert.equal(defaulted.error, undefined);
  assert.equal(defaulted.input?.orchestration?.strictVerify, false);
});

async function withServer46(cfg: ReturnType<typeof loadConfig>, fn: (base: string) => Promise<void>) {
  const { app, store } = createApp(cfg);
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
}

test('46f) Runtime：forced tool 不在本 run 工具池时 fail fast，不把配置错误伪装成模型故障', async () => {
  const { runtime } = makeRuntime();
  const provider = new CaptureProvider();
  const input: RunInput = {
    runType: 'misc',
    goal: '强制调用一个不在 misc 工具池里的工具',
    llm: { toolChoice: { type: 'function', function: { name: 'run_tests' } } },
  };
  const runId = runtime.createRun(input, provider);
  const result = await runtime.run(input, runId);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'INVALID_TOOL_CHOICE');
  assert.match(result.failureReason ?? '', /run_tests.*可用工具|可用工具列表/);
  assert.equal(provider.requests.length, 0, '非法 toolChoice 不应进入模型调用');
});

test('46e) POST /api/runs：非法 toolChoice 在 HTTP 层返回 400（不进入执行）', async () => {
  const cfg = loadConfig();
  cfg.llmMode = 'mock';
  cfg.sqlitePath = ':memory:';
  await withServer46(cfg, async (base) => {
    const res = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runType: 'misc',
        goal: '验证非法 toolChoice',
        repoPath: process.cwd(),
        llm: { mode: 'mock', toolChoice: 'sometimes' },
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? '', /toolChoice/);
  });
});
