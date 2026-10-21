// tests/20_llm_params.test.ts — LLM 预设、生成参数与 Token 限制
// 覆盖：参数装配（只发显式提供的字段）、思考模式下的参数忽略、extra 白名单、
//       请求体（stream / tools）、费用估算（含缓存价）、usage 归一化、
//       参数校验与范围拒绝、预设解析规则、/api/llm/presets 不泄漏 Key、
//       /api/llm/test 的 SSRF 防护与错误分支（注入 fake fetch，不发真实请求）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createApp, validateRunRequest } from '../src/server.js';
import { createProvider, resolveEffectivePresetId } from '../src/llm/index.js';
import {
  buildParamsBody,
  buildRequestBody,
  estimateCost,
  toTokenUsage,
} from '../src/llm/OpenAIProvider.js';
import { parseGenerationParams } from '../src/llm/params.js';
import { sanitizeParamsForModel, getPreset, getModelPreset, LLM_PRESETS } from '../src/llm/presets.js';
import { checkLlmTestTarget, testLlmConnection, normalizeBaseUrl } from '../src/llm/testConnection.js';
import type { LLMChatRequest, RunInput } from '../src/types.js';

// 测试隔离：清除环境里可能存在的真实 Key（本机就设置了 DEEPSEEK_API_KEY）
const KEY_ENV_NAMES = ['DEEPSEEK_API_KEY', 'LLM_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'DASHSCOPE_API_KEY'];
const saved = new Map<string, string | undefined>();
for (const k of KEY_ENV_NAMES) {
  saved.set(k, process.env[k]);
  delete process.env[k];
}
process.on('exit', () => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const req: LLMChatRequest = {
  system: 's',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
};

// ---------------------------------------------------------------------------
// 参数装配
// ---------------------------------------------------------------------------

test('20a) buildParamsBody：只发送显式提供的参数', () => {
  const { body, dropped } = buildParamsBody({ temperature: 0 });
  assert.deepEqual(body, { temperature: 0 });
  assert.deepEqual(dropped, []);
  // 未提供的字段不得出现（否则会覆盖厂商默认值）
  for (const k of ['max_tokens', 'top_p', 'frequency_penalty', 'presence_penalty', 'thinking', 'reasoning_effort']) {
    assert.equal(k in body, false, `${k} 不应出现`);
  }
});

test('20b) buildParamsBody：各字段全量映射（非思考模式）', () => {
  const { body, dropped } = buildParamsBody({
    maxTokens: 2048,
    temperature: 0.3,
    topP: 0.9,
    frequencyPenalty: 0.2,
    presencePenalty: -0.5,
    reasoningEffort: 'max',
  });
  assert.deepEqual(body, {
    max_tokens: 2048,
    temperature: 0.3,
    top_p: 0.9,
    frequency_penalty: 0.2,
    presence_penalty: -0.5,
    reasoning_effort: 'max',
  });
  assert.deepEqual(dropped, []);

  // thinking=disabled（显式关闭思考）不应剔除采样参数
  const disabled = buildParamsBody({ thinking: 'disabled', temperature: 0.3 });
  assert.equal(disabled.body.temperature, 0.3);
  assert.deepEqual(disabled.body.thinking, { type: 'disabled' });
});

test('20c) 思考模式开启时，采样参数被丢弃并如实报告', () => {
  // maxTokens 取安全下限以上（8192），避免触发 thinking×maxTokens 防护，专注测「采样参数被丢弃」
  const { body, dropped } = buildParamsBody({
    thinking: 'enabled',
    temperature: 0.7,
    topP: 0.8,
    maxTokens: 8192,
    reasoningEffort: 'low',
  });
  assert.equal('temperature' in body, false, '思考模式下 temperature 应被剔除');
  assert.equal('top_p' in body, false);
  assert.deepEqual(dropped.sort(), ['temperature', 'topP']);
  assert.equal(body.max_tokens, 8192, 'max_tokens 仍应保留');
  assert.deepEqual(body.thinking, { type: 'enabled' });
});

test('20d) 模型预设声明的 ignoredParams 会被丢弃', () => {
  const fakeModel = { id: 'x', label: 'x', ignoredParams: ['frequencyPenalty' as const, 'presencePenalty' as const] };
  const { params, dropped } = sanitizeParamsForModel({ frequencyPenalty: 1, presencePenalty: 1, temperature: 0 }, fakeModel);
  assert.equal(params.frequencyPenalty, undefined);
  assert.equal(params.presencePenalty, undefined);
  assert.equal(params.temperature, 0, '未声明的参数应保留');
  assert.deepEqual(dropped.sort(), ['frequencyPenalty', 'presencePenalty']);
});

test('20e) params.extra 直通厂商新参数，但保护键被拦截', () => {
  const ok = buildParamsBody({ extra: { top_k: 40, custom_flag: true } });
  assert.deepEqual(ok.body, { top_k: 40, custom_flag: true });
  assert.deepEqual(ok.dropped, []);

  const blocked = buildParamsBody({ extra: { model: 'hack', messages: [], tools: [], stream: true, tool_choice: 'none' } });
  assert.deepEqual(blocked.body, {}, '保护键不得进入请求体');
  assert.deepEqual(blocked.dropped.sort(), ['messages', 'model', 'stream', 'tool_choice', 'tools']);
});

test('20f) buildRequestBody：包含 messages/tools，流式时带 stream 与 include_usage', () => {
  const withTools: LLMChatRequest = {
    ...req,
    tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }],
  };
  const nonStream = buildRequestBody({ model: 'm', params: { maxTokens: 10 } }, withTools, false);
  assert.equal(nonStream.body.model, 'm');
  assert.equal(nonStream.body.max_tokens, 10);
  assert.equal(nonStream.body.tool_choice, 'auto');
  assert.equal(Array.isArray(nonStream.body.tools), true);
  assert.equal('stream' in nonStream.body, false);

  const streaming = buildRequestBody({ model: 'm' }, withTools, true);
  assert.equal(streaming.body.stream, true);
  assert.deepEqual(streaming.body.stream_options, { include_usage: true });
});

test('20g) 单次请求参数覆盖构造时的默认参数', () => {
  const { body } = buildRequestBody({ model: 'm', params: { temperature: 0, maxTokens: 100 } }, { ...req, params: { temperature: 1.5 } }, false);
  assert.equal(body.temperature, 1.5, '单次请求应覆盖默认');
  assert.equal(body.max_tokens, 100, '未覆盖的默认值仍生效');
});

// ---------------------------------------------------------------------------
// 费用与 usage
// ---------------------------------------------------------------------------

test('20h) estimateCost：有表价时按输入/缓存/输出分别计价', () => {
  const pricing = { inputPerM: 0.14, cachedInputPerM: 0.0028, outputPerM: 0.28 };
  // 1000 输入（其中 800 命中缓存）+ 500 输出
  const cost = estimateCost({ promptTokens: 1000, completionTokens: 500, cachedPromptTokens: 800 }, pricing, 0.000001);
  const expected = (200 * 0.14 + 800 * 0.0028 + 500 * 0.28) / 1_000_000;
  assert.ok(Math.abs(cost.costUsd - expected) < 1e-12, `期望 ${expected}，实际 ${cost.costUsd}`);
  assert.match(cost.estimateNote, /按表价估算/);
  assert.match(cost.estimateNote, /0\.28/);
});

test('20i) estimateCost：无表价时退化到粗略比率并明确标注', () => {
  const cost = estimateCost({ promptTokens: 1000, completionTokens: 1000 }, undefined, 0.000001);
  assert.equal(cost.costUsd, 0.002);
  assert.match(cost.estimateNote, /未配置表价/);
  assert.match(cost.estimateNote, /粗略估算/);
});

test('20j) toTokenUsage：兼容 DeepSeek 的 usage 字段（缓存/思考 token）', () => {
  const usage = toTokenUsage(
    {
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
      prompt_cache_hit_tokens: 768,
      completion_tokens_details: { reasoning_tokens: 120 },
    },
    { inputPerM: 0.14, cachedInputPerM: 0.0028, outputPerM: 0.28 },
    0.000001,
  );
  assert.equal(usage.totalTokens, 1200);
  assert.equal(usage.cachedPromptTokens, 768);
  assert.equal(usage.reasoningTokens, 120);
  assert.ok(usage.costUsd > 0 && usage.costUsd < 0.001, 'DeepSeek 表价下这个量级应远小于 0.001 美元');
});

// ---------------------------------------------------------------------------
// 参数校验（服务端不信任前端）
// ---------------------------------------------------------------------------

test('20k) parseGenerationParams：合法输入被接受并规范化', () => {
  const r = parseGenerationParams({ maxTokens: 1024.9, temperature: '0.7', topP: 0.95, thinking: 'disabled', reasoningEffort: 'max' });
  assert.equal(r.error, undefined);
  assert.equal(r.params?.maxTokens, 1024, 'maxTokens 取整');
  assert.equal(r.params?.temperature, 0.7);
  assert.equal(r.params?.topP, 0.95);
  assert.equal(r.params?.thinking, 'disabled');
  assert.equal(r.params?.reasoningEffort, 'max');
});

test('20l) parseGenerationParams：越界/非法值明确报错', () => {
  assert.match(parseGenerationParams({ temperature: 5 })!.error!, /temperature 超出允许范围 \[0, 2\]/);
  assert.match(parseGenerationParams({ topP: -1 })!.error!, /topP 超出允许范围 \[0, 1\]/);
  assert.match(parseGenerationParams({ maxTokens: 0 })!.error!, /maxTokens 超出允许范围/);
  assert.match(parseGenerationParams({ thinking: 'yes' })!.error!, /thinking 只能是/);
  assert.match(parseGenerationParams({ reasoningEffort: 'ultra' })!.error!, /reasoningEffort 只能是 low \/ high \/ max/);
  assert.match(parseGenerationParams({ extra: [1, 2] })!.error!, /extra 必须是对象/);
  assert.match(parseGenerationParams({ extra: { messages: [] } })!.error!, /不允许覆盖由 Runtime 掌控的字段/);
  assert.match(parseGenerationParams('nope')!.error!, /必须是对象/);
});

test('20m) validateRunRequest：接受参数并保留在 input.llm.params 中', () => {
  const config = loadConfig();
  const { input, error } = validateRunRequest(
    { runType: 'research', goal: 'g', llm: { mode: 'mock', params: { temperature: 0.2, maxTokens: 800 } } },
    config,
  );
  assert.equal(error, undefined);
  assert.deepEqual(input!.llm?.params, { temperature: 0.2, maxTokens: 800 });
});

test('20n) validateRunRequest：未知 Provider 预设被拒绝并列出可选项', () => {
  const config = loadConfig();
  const { error } = validateRunRequest({ runType: 'research', goal: 'g', llm: { mode: 'mock', provider: 'nope' } }, config);
  assert.match(error!, /未知的 LLM Provider 预设/);
  assert.match(error!, /deepseek/);
});

test('20o) validateRunRequest：tokenBudget / costBudgetUsd 被解析', () => {
  const config = loadConfig();
  const { input } = validateRunRequest({ runType: 'research', goal: 'g', tokenBudget: 5000, costBudgetUsd: 0.25 }, config);
  assert.equal(input!.tokenBudget, 5000);
  assert.equal(input!.costBudgetUsd, 0.25);
});

// ---------------------------------------------------------------------------
// 预设解析
// ---------------------------------------------------------------------------

test('20p) 预设解析优先级：单次任务 > 显式 LLM_PROVIDER > 旧 OPENAI_* 变量 > 默认（DeepSeek）', () => {
  const config = loadConfig();
  const base: RunInput = { runType: 'research', goal: 'g' };

  // ① 单次任务指定最高
  assert.equal(resolveEffectivePresetId(config, { ...base, llm: { provider: 'qwen' } }), 'qwen');

  // ② 环境变量显式指定
  config.llm.presetExplicit = true;
  config.llm.presetId = 'zhipu';
  assert.equal(resolveEffectivePresetId(config, base), 'zhipu');
  assert.equal(resolveEffectivePresetId(config, { ...base, llm: { provider: 'moonshot' } }), 'moonshot');

  // ③ 只在有旧版 OpenAI 变量时回退到 openai
  config.llm.presetExplicit = false;
  config.llm.presetId = 'deepseek';
  process.env.OPENAI_API_KEY = 'sk-legacy';
  assert.equal(resolveEffectivePresetId(config, base), 'openai');
  delete process.env.OPENAI_API_KEY;

  // ④ 兜底 = 默认预设（DeepSeek 优先接入）
  assert.equal(resolveEffectivePresetId(config, base), 'deepseek');
});

test('20q) createProvider：DeepSeek 预设解析出 baseUrl/model，且不需要手填', () => {
  const config = loadConfig();
  config.llmMode = 'openai';
  config.llm.apiKey = 'sk-test';
  const bundle = createProvider(config, { runType: 'research', goal: 'g', llm: { mode: 'openai', provider: 'deepseek' } });
  assert.equal(bundle.isMock, false);
  assert.equal(bundle.resolved.baseUrl, 'https://api.deepseek.com');
  assert.equal(bundle.resolved.model, 'deepseek-flash');
  assert.equal(bundle.resolved.presetId, 'deepseek');
});

test('20r) createProvider：自定义预设必须给 Base URL；本地无 Key 预设可用', () => {
  const config = loadConfig();
  config.llmMode = 'openai';
  config.llm.apiKey = 'sk-test';
  assert.throws(
    () => createProvider(config, { runType: 'research', goal: 'g', llm: { mode: 'openai', provider: 'custom' } }),
    /未提供 Base URL/,
  );

  // Ollama：keyOptional，不需要任何 Key
  config.llm.apiKey = undefined;
  const ollama = createProvider(config, { runType: 'research', goal: 'g', llm: { mode: 'openai', provider: 'ollama' } });
  assert.equal(ollama.resolved.baseUrl, 'http://localhost:11434/v1');
  assert.equal(ollama.resolved.hasKey, true, '本地服务用占位 Key，不算「缺 Key」');
});

test('20s) createProvider：思考模式下 temperature 会被标记为已忽略（含 DeepSeek 提示）', () => {
  const config = loadConfig();
  config.llmMode = 'openai';
  config.llm.apiKey = 'sk-test';
  const bundle = createProvider(config, {
    runType: 'research',
    goal: 'g',
    llm: { mode: 'openai', provider: 'deepseek', params: { temperature: 0.7, thinking: 'enabled' } },
  });
  assert.deepEqual(bundle.resolved.droppedParams, ['temperature']);
});

test('20t) Mock 分支：不调用真实模型，参数被标注为「不生效」', () => {
  const config = loadConfig();
  const bundle = createProvider(config, { runType: 'research', goal: 'g', llm: { mode: 'mock', provider: 'deepseek', params: { temperature: 0.1 } } });
  assert.equal(bundle.isMock, true);
  assert.equal(bundle.resolved.presetId, 'mock');
  assert.deepEqual(bundle.resolved.droppedParams, ['temperature'], 'Mock 下参数应被明确标注为被忽略');
});

// ---------------------------------------------------------------------------
// /api/llm/presets 与 /api/llm/test
// ---------------------------------------------------------------------------

async function withServer(config: ReturnType<typeof loadConfig>, fn: (base: string) => Promise<void>) {
  const { app, store } = createApp(config);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as any).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections?.();
    });
    store.close();
  }
}

test('20u) GET /api/llm/presets：返回预设与参数元数据，且绝不包含任何 Key', async () => {
  const config = loadConfig();
  config.llm.apiKey = 'sk-super-secret';
  config.sqlitePath = ':memory:';
  await withServer(config, async (base) => {
    const res = await fetch(`${base}/api/llm/presets`);
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.ok(!text.includes('sk-super-secret'), '响应中不得出现 Key');
    const data = JSON.parse(text);
    assert.ok(Array.isArray(data.presets) && data.presets.length >= 5);
    const deepseek = data.presets.find((p: any) => p.id === 'deepseek');
    assert.equal(deepseek.baseUrl, 'https://api.deepseek.com');
    assert.ok(deepseek.models.some((m: any) => m.id === 'deepseek-flash'));
    const keys = data.params.map((m: any) => m.key);
    for (const k of ['maxTokens', 'temperature', 'topP', 'thinking', 'reasoningEffort']) {
      assert.ok(keys.includes(k), `参数元数据应包含 ${k}`);
    }
    // 元数据要带说明与范围，前端才能渲染提示
    const maxTokens = data.params.find((m: any) => m.key === 'maxTokens');
    assert.equal(maxTokens.type, 'number');
    assert.ok(maxTokens.max > 0 && typeof maxTokens.help === 'string' && maxTokens.help.length > 10);
  });
});

test('20v) checkLlmTestTarget：允许公网与本地回环，拦截云元数据与内网', () => {
  assert.equal(checkLlmTestTarget('https://api.deepseek.com').ok, true);
  assert.equal(checkLlmTestTarget('http://localhost:11434/v1').ok, true, '本地模型服务应允许');
  assert.equal(checkLlmTestTarget('http://127.0.0.1:8080/v1').ok, true);

  assert.equal(checkLlmTestTarget('http://169.254.169.254/latest/meta-data').ok, false);
  assert.equal(checkLlmTestTarget('http://10.0.0.5/v1').ok, false);
  assert.equal(checkLlmTestTarget('http://192.168.1.10/v1').ok, false);
  assert.equal(checkLlmTestTarget('http://metadata.google.internal/v1').ok, false);
  assert.equal(checkLlmTestTarget('ftp://example.com').ok, false);
  assert.equal(checkLlmTestTarget('not a url').ok, false);
});

test('20w) POST /api/llm/test：被拦截的目标直接返回失败且不发请求', async () => {
  const config = loadConfig();
  config.sqlitePath = ':memory:';
  await withServer(config, async (base) => {
    const res = await fetch(`${base}/api/llm/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'custom', baseUrl: 'http://169.254.169.254/latest', model: 'x' }),
    });
    const data = (await res.json()) as any;
    assert.equal(data.ok, false);
    assert.equal(data.method, 'blocked');
    assert.match(data.detail, /云元数据地址被禁止|私网/);
  });
});

test('20x) testLlmConnection：注入 fake fetch，覆盖 200 / 401 / 404 回退分支', async () => {
  // ① /models 200
  const okFetch = (async (url: string) => {
    assert.match(String(url), /\/models$/);
    return new Response(JSON.stringify({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  const ok = await testLlmConnection({ baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-flash' }, okFetch);
  assert.equal(ok.ok, true);
  assert.equal(ok.method, 'models');
  assert.equal(ok.modelAvailable, true);
  assert.deepEqual(ok.models, ['deepseek-flash', 'deepseek-v4-pro']);

  // ② 401
  const authFetch = (async () => new Response('{"error":"invalid key"}', { status: 401 })) as unknown as typeof fetch;
  const bad = await testLlmConnection({ baseUrl: 'https://api.deepseek.com', apiKey: 'x' }, authFetch);
  assert.equal(bad.ok, false);
  assert.match(bad.detail!, /鉴权失败（HTTP 401）/);

  // ③ 404 → 回退到最小对话请求
  const calls: string[] = [];
  const fallbackFetch = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (String(url).endsWith('/models')) return new Response('not found', { status: 404 });
    return new Response('{"choices":[]}', { status: 200 });
  }) as unknown as typeof fetch;
  const fb = await testLlmConnection({ baseUrl: 'https://example.com/v1', apiKey: 'k', model: 'm', allowChatFallback: true }, fallbackFetch);
  assert.equal(fb.ok, true);
  assert.equal(fb.method, 'chat');
  assert.equal(calls.length, 2);
  assert.match(calls[1], /POST .*\/chat\/completions$/);

  // ④ 404 且不允许回退 → 明确失败并给出建议
  const noFallback = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
  const nf = await testLlmConnection({ baseUrl: 'https://example.com/v1', apiKey: 'k' }, noFallback);
  assert.equal(nf.ok, false);
  assert.match(nf.detail!, /不支持 \/models/);
});

test('20y) normalizeBaseUrl：去掉结尾斜杠（避免拼出 //chat/completions）', () => {
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/'), 'https://api.deepseek.com');
  assert.equal(normalizeBaseUrl('  https://api.deepseek.com/v1//  '), 'https://api.deepseek.com/v1');
});

test('20z) 预设目录自身的一致性：id 唯一、默认模型在清单内、DeepSeek 优先', () => {
  const ids = LLM_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, '预设 id 不应重复');
  for (const p of LLM_PRESETS) {
    if (p.defaultModel) {
      assert.ok(p.models.some((m) => m.id === p.defaultModel), `${p.id} 的 defaultModel 必须在 models 清单内`);
    }
    assert.ok(p.apiKeyEnv, `${p.id} 应声明 apiKeyEnv`);
  }
  assert.equal(ids[0], 'deepseek', 'DeepSeek 应排在第一个（优先接入）');
  const preset = getPreset('deepseek')!;
  assert.equal(getModelPreset(preset, 'deepseek-flash')?.maxOutputTokens, 393216);
});
