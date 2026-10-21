// tests/17_provider_override.test.ts — 单次任务 API 覆盖（界面配置 API）
// 覆盖：createProvider 的 input.llm 覆盖优先级、无 Key 不静默降级、
//       validateRunRequest 的 400 校验、GET /api/config 不泄漏 Key。
// 注意：本文件绝不发起真实网络请求（不用假 Key 触发真实 LLM 调用）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createProvider } from '../src/llm/index.js';
import { createApp, validateRunRequest } from '../src/server.js';
import { defaultConfig } from './helpers.js';
import type { RuntimeConfig } from '../src/config.js';
import type { RunInput } from '../src/types.js';

// 测试隔离：真实环境可能已经设置了各家 Key 的环境变量（本机的 DEEPSEEK_API_KEY 就是这种），
// 会让「未提供 Key 应报错」的用例失效。文件级临时移除，进程退出时恢复。
const KEY_ENV_NAMES = [
  'DEEPSEEK_API_KEY',
  'LLM_API_KEY',
  'OPENAI_API_KEY',
  'DASHSCOPE_API_KEY',
  'MOONSHOT_API_KEY',
  'ZHIPU_API_KEY',
  'OLLAMA_API_KEY',
];
const savedKeyEnvs = new Map<string, string | undefined>();
for (const k of KEY_ENV_NAMES) {
  savedKeyEnvs.set(k, process.env[k]);
  delete process.env[k];
}
process.on('exit', () => {
  for (const [k, v] of savedKeyEnvs) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// 统一把 fetch 响应按 any 读取（测试断言用）
async function jget(res: Response): Promise<any> {
  return (await res.json()) as any;
}

function baseInput(over: Partial<RunInput> = {}): RunInput {
  return { runType: 'research', goal: 'g', ...over };
}

function openaiConfig(apiKey?: string): RuntimeConfig {
  const c = defaultConfig();
  c.llmMode = 'openai';
  c.llm.presetId = 'openai'; // 明确使用 OpenAI 预设，避免落到默认的 DeepSeek 预设
  c.openai = { apiKey, baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' };
  c.sqlitePath = ':memory:';
  return c;
}

test('17a) input.llm.apiKey 覆盖全局配置，选中 openai', () => {
  const cfg = openaiConfig('sk-global');
  const { provider, isMock } = createProvider(cfg, baseInput({ llm: { mode: 'openai', apiKey: 'sk-perrun', model: 'gpt-4o' } }));
  assert.equal(isMock, false);
  assert.equal(provider.name, 'openai');
});

test('17b) 无覆盖时沿用全局 openai 配置', () => {
  const cfg = openaiConfig('sk-global');
  const { provider, isMock } = createProvider(cfg, baseInput());
  assert.equal(isMock, false);
  assert.equal(provider.name, 'openai');
});

test('17c) 显式选 openai 但无 Key：抛错而非静默降级为 Mock', () => {
  const cfg = openaiConfig(undefined); // 全局也无 Key
  assert.throws(
    () => createProvider(cfg, baseInput({ llm: { mode: 'openai' } })),
    /API Key/,
  );
});

test('17d) 显式选 mock 时，即便全局是 openai 也用 Mock', () => {
  const cfg = openaiConfig('sk-global');
  const { provider, isMock } = createProvider(cfg, baseInput({ llm: { mode: 'mock' } }));
  assert.equal(isMock, true);
  assert.equal(provider.name, 'mock');
});

test('17e) mockScenario 在 mock 模式下仍然生效', () => {
  const cfg = defaultConfig();
  cfg.sqlitePath = ':memory:';
  const { provider, isMock } = createProvider(cfg, baseInput({ mockScenario: 'research-basic' }));
  assert.equal(isMock, true);
  assert.equal(provider.name, 'mock');
});

// ---- validateRunRequest（纯函数，不发请求）----

test('17f) 提供 per-run Key 时校验通过并正确写入 input.llm', () => {
  const cfg = openaiConfig(undefined);
  const { input, error } = validateRunRequest(
    { runType: 'research', goal: 'g', llm: { mode: 'openai', apiKey: 'sk-perrun', model: 'gpt-4o' } },
    cfg,
  );
  assert.equal(error, undefined);
  assert.ok(input);
  assert.equal(input!.llm?.mode, 'openai');
  assert.equal(input!.llm?.apiKey, 'sk-perrun');
  assert.equal(input!.llm?.model, 'gpt-4o');
});

test('17g) 选 openai 但无 Key（全局也无）：校验拒绝', () => {
  const cfg = openaiConfig(undefined);
  const { error } = validateRunRequest({ runType: 'research', goal: 'g', llm: { mode: 'openai', provider: 'openai' } }, cfg);
  assert.match(error!, /未提供 API Key/);
  assert.match(error!, /OPENAI_API_KEY/, '报错里应指出该填哪个环境变量');
});

test('17h) 全局有 Key 时，前端留空也能通过校验', () => {
  const cfg = openaiConfig('sk-global');
  const { input, error } = validateRunRequest({ runType: 'research', goal: 'g', llm: { mode: 'openai' } }, cfg);
  assert.equal(error, undefined);
  assert.equal(input!.llm?.mode, 'openai');
  assert.equal(input!.llm?.apiKey, undefined, '未填写时不下发 Key，由 Provider 回退到全局配置');
});

test('17i) 兼容旧字段 body.llmMode', () => {
  const cfg = openaiConfig(undefined);
  const { input, error } = validateRunRequest({ runType: 'research', goal: 'g', llmMode: 'openai', llm: { apiKey: 'sk-perrun' } }, cfg);
  assert.equal(error, undefined);
  assert.equal(input!.llm?.mode, 'openai');
});

test('17j) 选 serper 但无 Key：校验拒绝', () => {
  const cfg = defaultConfig();
  cfg.sqlitePath = ':memory:';
  const { error } = validateRunRequest({ runType: 'research', goal: 'g', search: { provider: 'serper' } }, cfg);
  assert.match(error!, /Serper 真实搜索但未提供 API Key/);
});

test('17k) repoPath 不存在：报错带上原始输入', () => {
  const cfg = defaultConfig();
  cfg.sqlitePath = ':memory:';
  const { error } = validateRunRequest({ runType: 'codebase', goal: 'g', repoPath: 'demo/不存在的目录' }, cfg);
  assert.match(error!, /repoPath 不存在/);
  assert.match(error!, /收到输入/);
  assert.match(error!, /demo\/不存在的目录/);
});

test('17l) repoPath 合法：解析为绝对路径', () => {
  const cfg = defaultConfig();
  cfg.sqlitePath = ':memory:';
  const { input, error } = validateRunRequest({ runType: 'codebase', goal: 'g', repoPath: 'demo/codebase-sample' }, cfg);
  assert.equal(error, undefined);
  assert.ok(input!.repoPath);
  assert.ok(/^([a-zA-Z]:[\\/]|[\\/])/.test(input!.repoPath!), '应为绝对路径');
});

// ---- HTTP 层（只测不触发真实运行的路径）----

async function withServer(cfg: RuntimeConfig, fn: (base: string) => Promise<void>) {
  const { app, store } = createApp(cfg);
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    // 强制关闭 keep-alive 连接，避免 close() 挂起
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
}

test('17m) GET /api/config 返回默认信息但不泄漏 Key', async () => {
  const cfg = openaiConfig(undefined);
  await withServer(cfg, async (base) => {
    const j = await jget(await fetch(`${base}/api/config`));
    assert.equal(j.llmMode, 'openai');
    assert.equal(j.hasOpenAIKey, false, '未配置 Key 时应为 false');
    assert.equal(j.openaiModel, 'gpt-4o-mini');
    // 关键：响应中不得出现任何 Key 字段
    assert.equal(j.openaiApiKey, undefined);
    assert.equal(j.apiKey, undefined);
    assert.equal(JSON.stringify(j).includes('sk-'), false, '不得泄漏任何 Key');
  });
});

test('17n) POST /api/runs 选 openai 无 Key：HTTP 400', async () => {
  const cfg = openaiConfig(undefined);
  await withServer(cfg, async (base) => {
    const res = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runType: 'research', goal: 'g', llm: { mode: 'openai', provider: 'openai' } }),
    });
    assert.equal(res.status, 400);
    assert.match((await jget(res)).error, /未提供 API Key/);
  });
});

test('17o) POST /api/runs 选 serper 无 Key：HTTP 400', async () => {
  const cfg = defaultConfig();
  cfg.sqlitePath = ':memory:';
  await withServer(cfg, async (base) => {
    const res = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runType: 'research', goal: 'g', search: { provider: 'serper' } }),
    });
    assert.equal(res.status, 400);
    assert.match((await jget(res)).error, /Serper 真实搜索但未提供 API Key/);
  });
});

test('17p) POST /api/runs mock 模式可正常创建（不发起网络）', async () => {
  const cfg = defaultConfig();
  cfg.sqlitePath = ':memory:';
  await withServer(cfg, async (base) => {
    const res = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runType: 'research', goal: 'g', mockScenario: 'research-basic', maxModelCalls: 4, maxSteps: 4 }),
    });
    assert.equal(res.status, 201);
    const { runId } = await jget(res);
    assert.ok(runId.startsWith('run_'));
    // 等待后台 run 结束后再关闭，避免写已关闭的 DB
    const deadline = Date.now() + 5000;
    for (;;) {
      const r = await jget(await fetch(`${base}/api/runs/${runId}`));
      if (['completed', 'failed', 'cancelled', 'limit_reached', 'awaiting_user'].includes(r.status)) break;
      if (Date.now() > deadline) break;
      await new Promise((r2) => setTimeout(r2, 50));
    }
  });
});
