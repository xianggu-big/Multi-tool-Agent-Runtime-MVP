// tests/37_search_files_semantics.test.ts — search_files 三重静默陷阱的回归守卫
// 背景（2026-10-14 实测发现，见 AGENTS.md「当前状态」/ reports/PROJECT_REPORT.md §下一步）：
//   ① kind 默认 filename：不传 kind 做内容搜索恒返回 0 且 ok:true（静默错误，最危险的形态）；
//   ② 多关键词 `a|b` 被 globToRegex 转义成字面量，恒 0 命中；
//   ③ `path` 参数不在 schema 中，被 Zod 静默丢弃（"在 X 目录内搜索"退化为全仓搜索）。
// 真实代价：编排的 code-audit 子 Agent 因此烧 ~220k token 并触发 maxToolCalls；A/B 实测中
//   模型被迫"逐行通读补偿"→ 1.39M 子任务 token（reports/PARALLEL_AB.md）。
// 本文件按「回归守卫」约定断言修复后的行为（修复前这些断言会失败）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { registryWithAll, makeCtx } from './helpers.js';

const REPO = resolve('.');

// 运行时拼装「绝不存在的词」：若写成字面量，测试文件自身会被搜到（自指陷阱）
const NOPE = `NOPE_${Date.now()}_ZZZ`;

function ctx() {
  return makeCtx({ runType: 'codebase', allowedPermissions: ['codebase:read'], repoPath: REPO });
}

async function run(args: Record<string, unknown>) {
  const reg = registryWithAll();
  const r = await reg.execute('search_files', args, ctx());
  return { ok: r.result.ok, code: r.result.error?.code, data: (r.result.data ?? {}) as any };
}

test('37a) 回归守卫：不传 kind 默认按内容搜索（不再是 filename 静默 0 命中）', async () => {
  // 'TOOL_PERMISSION' 只出现在文件内容里，不是任何文件名 → 旧行为（默认 filename）恒 0 命中
  const r = await run({ pattern: 'TOOL_PERMISSION', limit: 20 });
  assert.equal(r.ok, true);
  assert.equal(r.data.resolvedKind, 'content', '不传 kind 应解析为 content');
  assert.ok(r.data.count >= 1, `默认应能搜到内容（实际 ${r.data.count}）`);
  assert.ok(
    r.data.matches.some((m: any) => m.file.includes('AgentRuntime')),
    'TOOL_PERMISSION 应命中 src/runtime/AgentRuntime.ts',
  );
});

test('37b) 回归守卫：显式 kind="filename" 仍按文件名搜索（含通配符）', async () => {
  const r = await run({ pattern: 'searchFiles*', kind: 'filename', limit: 20 });
  assert.equal(r.data.resolvedKind, 'filename');
  assert.ok(r.data.count >= 1);
  assert.ok(r.data.matches.some((m: any) => m.file.endsWith('searchFiles.ts')));

  // 通配符语义保留：*.test.ts 应命中多个测试文件
  const g = await run({ pattern: '*.test.ts', kind: 'filename', path: 'tests', limit: 200 });
  assert.ok(g.data.count >= 10, `tests/ 下应有多个 *.test.ts（实际 ${g.data.count}）`);
});

test('37c) 回归守卫：多关键词 A|B 是 OR 语义（不再被转义成字面量）', async () => {
  // 控制组：整串字面量（含 |）不存在
  const ctl = await run({ pattern: NOPE, limit: 5 });
  assert.equal(ctl.data.count, 0, '控制组：该词确实不存在');

  // OR：一个不存在的词 + 一个存在的词 → 应命中存在的那个
  const r1 = await run({ pattern: `${NOPE}|TOOL_PERMISSION`, limit: 20 });
  assert.ok(r1.data.count >= 1, 'A|B 应至少命中 B');
  const r2 = await run({ pattern: `TOOL_PERMISSION|${NOPE}`, limit: 20 });
  assert.ok(r2.data.count >= 1, 'B|A 顺序无关，应至少命中 B');
  // 单侧不存在的词不应压低命中数
  const solo = await run({ pattern: 'TOOL_PERMISSION', limit: 20 });
  assert.equal(r1.data.count, solo.data.count, 'OR 命中数应与单关键词一致');
});

test('37d) 回归守卫：0 命中必须返回可行动修正 hint（不再静默）', async () => {
  const r = await run({ pattern: NOPE, limit: 5 });
  assert.equal(r.data.count, 0);
  assert.ok(typeof r.data.hint === 'string' && r.data.hint.length > 0, '0 命中必须带 hint');
  assert.match(r.data.hint, /kind/, 'hint 应提示 kind 用法');
  assert.match(r.data.hint, /\|/, 'hint 应提示多关键词 OR 写法');
  assert.match(r.data.hint, /path/, 'hint 应提示 path 限定目录');
});

test('37e) 回归守卫：path 参数生效并限定作用域（dir/subdir 为等价别名）', async () => {
  const r = await run({ pattern: 'EXCLUDED_DIRS', path: 'src/tools/codebase', limit: 50 });
  assert.equal(r.data.scope, 'src/tools/codebase');
  assert.ok(r.data.count >= 1);
  assert.ok(
    r.data.matches.every((m: any) => m.file.startsWith('src/tools/codebase/')),
    '所有命中必须落在限定目录内',
  );

  const alias = await run({ pattern: 'EXCLUDED_DIRS', dir: 'src/tools/codebase', limit: 50 });
  assert.deepEqual(
    alias.data.matches.map((m: any) => m.file),
    r.data.matches.map((m: any) => m.file),
    'dir 别名应与 path 行为一致',
  );

  // 不限定时应能命中限定目录之外的引用（对照组）
  const wide = await run({ pattern: 'EXCLUDED_DIRS', limit: 200 });
  assert.ok(wide.data.count > r.data.count, '全仓搜索命中数应多于限定目录');
});

test('37f) 回归守卫：越界 path 明确拒绝（PATH_ESCAPE），不存在 path 与越界区分（PATH_NOT_FOUND）', async () => {
  const esc = await run({ pattern: 'x', path: '../../outside_37f', limit: 5 });
  assert.equal(esc.ok, false);
  assert.equal(esc.code, 'PATH_ESCAPE', '越界必须明确拒绝（不静默退化成全仓搜索）');

  const missing = await run({ pattern: 'x', path: 'no/such/dir_37f', limit: 5 });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'PATH_NOT_FOUND', '不存在 ≠ 越界（错误码要能区分）');
});

test('37g) 回归守卫：未识别的 kind 取值按 content 处理并回显（透明可控）', async () => {
  const r = await run({ pattern: 'TOOL_PERMISSION', kind: 'weird_mode', limit: 10 });
  assert.equal(r.data.resolvedKind, 'content');
  assert.equal(r.data.kindRequested, 'weird_mode', '未识别取值应回显，便于模型自我纠正');
  assert.match(String(r.data.kindNote), /content/);
});
