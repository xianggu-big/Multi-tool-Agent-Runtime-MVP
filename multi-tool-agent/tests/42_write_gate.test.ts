// tests/42_write_gate.test.ts — 写能力门禁接线（M1'：界面「允许修改文件」开关的运行时硬边界）
//
// 背景：M1 的 `orchestration.allowWriteSpecs` 此前「只解析、未接线」；M1' 把它接成三层：
//   ① 契约目录（软引导）：未授权时 code-edit 不出现在主 Agent 的可用清单（dispatchableSpecs）
//   ② delegate_subtasks 守卫（硬边界）：派发写 spec 且未授权 → WRITE_NOT_ALLOWED（fail-closed）
//   ③ spawnSubAgent 兜底（结构层）：即使绕过工具层，也会被结构层拒绝（AgentRuntime）
// 本文件覆盖：解析（validateRunRequest）/ 判定口径（resolveWriteSpecsAllowed）/
//            目录过滤（dispatchableSpecs）/ delegate 守卫（含「只读 spec 不受影响」对照组）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { validateRunRequest } from '../src/server.js';
import { dispatchableSpecs, getSpec, isWriteSpec, isWriteSpecId } from '../src/agents/specs.js';
import { resolveWriteSpecsAllowed } from '../src/runtime/AgentRuntime.js';
import { registryWithAll, makeCtx } from './helpers.js';
import type { SubtaskOutcome, SubtaskRequest } from '../src/types.js';

const WORKSPACE = resolve('demo/codebase-sample');
const CONFIG = loadConfig();

// ---------------------------------------------------------------- 42a 解析
test('42a) validateRunRequest：allowWriteSpecs 仅显式 true 才透传（缺省 = false，fail-closed）', () => {
  const base = { runType: 'orchestrator', goal: '清点并审计仓库', repoPath: WORKSPACE };

  const on = validateRunRequest({ ...base, orchestration: { allowWriteSpecs: true } }, CONFIG);
  assert.equal(on.error, undefined);
  assert.equal(on.input?.orchestration?.allowWriteSpecs, true);

  const off = validateRunRequest({ ...base, orchestration: { allowWriteSpecs: false } }, CONFIG);
  assert.equal(off.input?.orchestration?.allowWriteSpecs, false);

  const dflt = validateRunRequest({ ...base }, CONFIG);
  assert.equal(dflt.input?.orchestration?.allowWriteSpecs, false, '缺省必须 fail-closed 为 false');
});

// ---------------------------------------------------------------- 42b 判定口径
test('42b) resolveWriteSpecsAllowed：请求授权 && 部署门禁，缺一不可', () => {
  const granted = { orchestration: { allowWriteSpecs: true } };
  const denied = { orchestration: { allowWriteSpecs: false } };

  assert.equal(resolveWriteSpecsAllowed(granted, { codebase: { writeEnabled: true } }), true);
  assert.equal(
    resolveWriteSpecsAllowed(granted, { codebase: { writeEnabled: false } }),
    false,
    '部署显式禁用（CODEBASE_WRITE_ENABLED=false）时，请求授权也必须无效',
  );
  assert.equal(resolveWriteSpecsAllowed({}, { codebase: { writeEnabled: true } }), false, '请求未授权时 fail-closed');
  assert.equal(resolveWriteSpecsAllowed(denied, { codebase: { writeEnabled: true } }), false);
});

// ---------------------------------------------------------------- 42c 目录过滤（软引导）
test('42c) dispatchableSpecs：未授权时目录不含 code-edit；授权后出现；白名单交集生效', () => {
  const off = dispatchableSpecs({});
  assert.ok(!off.some((s) => s.id === 'code-edit'), '未授权：code-edit 不应出现在可派发目录');
  assert.ok(off.some((s) => s.id === 'dir-inventory'), '只读 spec 不受影响');

  const on = dispatchableSpecs({ allowWriteSpecs: true });
  assert.ok(on.some((s) => s.id === 'code-edit'), '授权：code-edit 应出现');

  const wlOff = dispatchableSpecs({ allowedSpecs: ['dir-inventory', 'code-edit'], allowWriteSpecs: false });
  assert.deepEqual(
    wlOff.map((s) => s.id),
    ['dir-inventory'],
    '白名单里的写 spec 仍受授权门禁（交集）',
  );

  const wlOn = dispatchableSpecs({ allowedSpecs: ['dir-inventory', 'code-edit'], allowWriteSpecs: true });
  assert.deepEqual(wlOn.map((s) => s.id).sort(), ['code-edit', 'dir-inventory']);
});

// ---------------------------------------------------------------- 42d delegate 守卫（硬边界）
function fakeSpawn(calls: string[]) {
  return async (req: SubtaskRequest): Promise<SubtaskOutcome> => {
    calls.push(req.specId);
    return {
      subtaskId: 'st_stub',
      specId: req.specId,
      specTitle: req.specId,
      objective: req.objective,
      status: 'ok',
      steps: 0,
      modelCalls: 0,
      toolCalls: 0,
      durationMs: 1,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, isEstimate: true },
    };
  };
}

function delegateCtx(over: Record<string, unknown> = {}) {
  return makeCtx({
    runType: 'orchestrator',
    allowedPermissions: ['orchestrator:delegate'],
    ...over,
  });
}

test('42d) delegate 守卫：未授权派发 code-edit → WRITE_NOT_ALLOWED 且不 spawn；授权后放行', async () => {
  const reg = registryWithAll();

  const calls1: string[] = [];
  const res1 = await reg.execute(
    'delegate_subtasks',
    { subtasks: [{ specId: 'code-edit', objective: '新建 docs/_x.md' }] },
    delegateCtx({ spawnSubAgent: fakeSpawn(calls1), writeSpecsAllowed: false }),
  );
  assert.equal(res1.result.ok, false, '未授权时必须拒绝');
  assert.equal(res1.result.error?.code, 'WRITE_NOT_ALLOWED');
  assert.match(String(res1.result.error?.message), /允许修改文件/, '错误文案要指向界面开关（可行动提示）');
  assert.equal(calls1.length, 0, '未授权时不得触达 spawnSubAgent');

  const calls2: string[] = [];
  const res2 = await reg.execute(
    'delegate_subtasks',
    { subtasks: [{ specId: 'code-edit', objective: '新建 docs/_x.md' }] },
    delegateCtx({ spawnSubAgent: fakeSpawn(calls2), writeSpecsAllowed: true }),
  );
  assert.equal(res2.result.ok, true, `授权后应放行：${JSON.stringify(res2.result)}`);
  assert.deepEqual(calls2, ['code-edit']);
});

// ---------------------------------------------------------------- 42e 对照组（只读不受影响）
test('42e) 对照组：只读 spec 的派发不受写门禁影响（未授权也正常）', async () => {
  const reg = registryWithAll();
  const calls: string[] = [];
  const res = await reg.execute(
    'delegate_subtasks',
    { subtasks: [{ specId: 'dir-inventory', objective: '清点 src', inputs: { dir: 'src' } }] },
    delegateCtx({ spawnSubAgent: fakeSpawn(calls), writeSpecsAllowed: false }),
  );
  assert.equal(res.result.ok, true);
  assert.deepEqual(calls, ['dir-inventory']);
});

// ---------------------------------------------------------------- 42f 口径一致性
test('42f) isWriteSpec 口径：恰好 code-edit 一个写 spec；未知 id 为 false', () => {
  assert.equal(isWriteSpecId('code-edit'), true);
  assert.equal(isWriteSpecId('dir-inventory'), false);
  assert.equal(isWriteSpecId('no-such-spec'), false);
  assert.equal(isWriteSpec(getSpec('code-edit')!), true);
  assert.equal(isWriteSpec(getSpec('dir-inventory')!), false);
  assert.equal(
    dispatchableSpecs({ allowWriteSpecs: true }).filter((s) => isWriteSpec(s)).length,
    1,
    '契约注册表里应恰好一个写 spec（防未来误加写权限）',
  );
});
