#!/usr/bin/env node
// scripts/embed-selfcheck.mjs — embedding 模型自检（零依赖，Node 18+）
//
// 用途：确认本地 embedding 服务「活着、维度对、向量已归一化、语义真的有效」。
// 背景：本仓曾用 hash-ngram（词法哈希）冒充 embedding，向量路 Recall 只有 55.6%；
//       换成真语义模型后必须能自证「相近文本分高、无关文本分低」，否则等于白换。
//
// 用法：
//   node scripts/embed-selfcheck.mjs
//   node scripts/embed-selfcheck.mjs --base http://127.0.0.1:11434/v1 --model qwen3-embedding-0.6b --dim 1024
//   node scripts/embed-selfcheck.mjs --mrl 256          # 额外验证 MRL 降维
//   node scripts/embed-selfcheck.mjs --json             # 机器可读输出
//
// 退出码：0 = 全部通过；1 = 有失败项。

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const hasFlag = (name) => args.includes('--' + name);

const BASE = (argOf('base', process.env.MTA_EMBEDDING_BASE_URL || 'http://127.0.0.1:11434/v1')).replace(/\/+$/, '');
const MODEL = argOf('model', process.env.MTA_EMBEDDING_MODEL || 'qwen3-embedding-0.6b');
const EXPECT_DIM = Number(argOf('dim', process.env.MTA_EMBEDDING_DIM || '0')) || null;
const API_KEY = process.env.MTA_EMBEDDING_API_KEY || 'ollama';
const MRL = Number(argOf('mrl', '0')) || null;
const AS_JSON = hasFlag('json');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  if (!AS_JSON) console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0); // 已 L2 归一化 → 点积即余弦
const norm = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0));

async function embed(input, extra = {}) {
  const res = await fetch(BASE + '/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, input, ...extra }),
    signal: AbortSignal.timeout(120_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return { json, vectors: (json.data || []).map((d) => d.embedding) };
}

if (!AS_JSON) console.log(`\n【embedding 自检】base=${BASE} model=${MODEL}\n`);

// ── 1. 服务存活 ───────────────────────────────────────────────
try {
  const root = BASE.replace(/\/v1$/, '');
  const res = await fetch(root + '/api/version', { signal: AbortSignal.timeout(5000) });
  const v = await res.json();
  check('服务存活', !!v.version, 'version=' + v.version);
} catch (e) {
  check('服务存活', false, e.message);
}

// ── 2. 主接口与语义有效性 ─────────────────────────────────────
try {
  const t0 = performance.now();
  const { vectors } = await embed([
    '如何在部署时彻底关闭写文件能力',
    'CODEBASE_WRITE_ENABLED 设为 false 可以禁用写能力',
    '今天上海的天气怎么样',
  ]);
  const ms = Math.round(performance.now() - t0);
  const dim = vectors[0]?.length;

  check('返回三条向量', vectors.length === 3, 'count=' + vectors.length);
  check('维度符合预期', EXPECT_DIM ? dim === EXPECT_DIM : !!dim, `dim=${dim}${EXPECT_DIM ? '（期望 ' + EXPECT_DIM + '）' : ''}`);
  const n0 = dim ? norm(vectors[0]) : 0;
  check('已 L2 归一化', Math.abs(n0 - 1) < 1e-3, '|v|=' + n0.toFixed(4));

  if (vectors.length === 3) {
    const cSim = cos(vectors[0], vectors[1]);
    const cUnrel = cos(vectors[0], vectors[2]);
    check('语义相近 cos > 0.6', cSim > 0.6, 'cos=' + cSim.toFixed(4));
    check('无关文本 cos < 0.4', cUnrel < 0.4, 'cos=' + cUnrel.toFixed(4));
    check('相近明显高于无关', cSim - cUnrel > 0.3, '差值=' + (cSim - cUnrel).toFixed(4));
  }
  if (!AS_JSON) console.log(`  ⏱  三条耗时 ${ms}ms`);
} catch (e) {
  check('主接口 /embeddings', false, e.message);
}

// ── 3. MRL 降维（可选） ───────────────────────────────────────
if (MRL) {
  try {
    const { vectors } = await embed('测试降维', { dimensions: MRL });
    check(`MRL dimensions=${MRL}`, vectors[0]?.length === MRL, 'dim=' + vectors[0]?.length);
  } catch (e) {
    check(`MRL dimensions=${MRL}`, false, e.message);
  }
}

// ── 4. Ollama 原生接口（仅本地可用时） ────────────────────────
try {
  const root = BASE.replace(/\/v1$/, '');
  const res = await fetch(root + '/api/embed', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: '原生接口探测' }),
    signal: AbortSignal.timeout(60_000),
  });
  if (res.ok) {
    const j = await res.json();
    check('原生 /api/embed 可用', !!(j.embeddings && j.embeddings[0]), 'dim=' + j.embeddings?.[0]?.length);
  }
} catch {
  /* 非 Ollama 服务（OpenAI/BGE 私有部署）跳过该项，不算失败 */
}

const failed = results.filter((r) => !r.ok);
if (AS_JSON) {
  console.log(JSON.stringify({ base: BASE, model: MODEL, pass: results.length - failed.length, fail: failed.length, results }, null, 2));
} else {
  console.log('\n========================================');
  console.log(`结果：PASS ${results.length - failed.length} / FAIL ${failed.length}`);
  console.log(failed.length === 0 ? '✔ 模型工作正常' : '✘ 存在失败项：' + failed.map((f) => f.name).join('、'));
}
// 注意：不要用 process.exit()——Windows + Node 24 下若 undici 仍有未关闭的 socket，
// 会触发 libuv 断言 `!(handle->flags & UV_HANDLE_CLOSING)`（退出码 3221226505）。
// 用 exitCode 让进程自然退出。
process.exitCode = failed.length === 0 ? 0 : 1;
