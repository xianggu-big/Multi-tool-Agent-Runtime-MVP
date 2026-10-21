// scripts/agents-lint.ts — 契约一致性门禁（CI 可用）
// 检查三件事：
//   ① 契约自校验（工具已注册 / 权限不多不少 / 有上报工具 / 预算合法）
//   ② 文档漂移（agents/*.md 是否与 specs.ts 渲染结果逐字节一致）
//   ③ 契约与工具表一致（每个 spec 的工具都必须真实存在于注册表）
// 退出码：0 = 通过；1 = 有问题（CI 会红）
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { SUB_AGENT_SPECS } from '../src/agents/specs.js';
import { validateSpecs } from '../src/agents/specs.js';
import { renderDocSet } from '../src/agents/renderDocs.js';
import { buildRegistry } from '../src/tools/index.js';
import { TOOL_PERMISSION } from '../src/runtime/AgentRuntime.js';

const config = loadConfig();
const registry = buildRegistry();
let failed = 0;

// ① 契约自校验
const issues = validateSpecs(SUB_AGENT_SPECS, TOOL_PERMISSION, registry.names(), { maxStepsHardLimit: 20 });
for (const issue of issues) {
  const tag = issue.level === 'error' ? '✗' : '⚠';
  console.log(`  ${tag} [${issue.specId}] ${issue.message}`);
  if (issue.level === 'error') failed += 1;
}
console.log(`[agents:lint] ① 契约自校验：${issues.length === 0 ? '通过（0 issue）' : `${issues.length} 项（error ${failed}）`}`);

// ② 文档漂移
const { files } = renderDocSet(SUB_AGENT_SPECS, config.subagent);
let drift = 0;
for (const [rel, expected] of Object.entries(files)) {
  const abs = resolve(rel);
  if (!existsSync(abs)) {
    console.log(`  ✗ 缺少文档: ${rel}（运行 npm run agents:docs）`);
    drift += 1;
    continue;
  }
  const actual = readFileSync(abs, 'utf8');
  if (actual !== expected) {
    console.log(`  ✗ 文档与契约不一致: ${rel}（运行 npm run agents:docs 重新生成）`);
    drift += 1;
  }
}
console.log(`[agents:lint] ② 文档漂移：${drift === 0 ? '通过' : `${drift} 份需重新生成`}`);
failed += drift;

// ③ 每个 spec 的工具必须在注册表中真实存在
for (const spec of SUB_AGENT_SPECS) {
  for (const t of spec.tools) {
    if (!registry.has(t)) {
      console.log(`  ✗ [${spec.id}] 工具不存在于注册表: ${t}`);
      failed += 1;
    }
  }
}
console.log(`[agents:lint] ③ 工具存在性：${failed === 0 ? '通过' : '见上'}`);

if (failed > 0) {
  console.error(`[agents:lint] 失败：共 ${failed} 项问题`);
  process.exit(1);
}
console.log('[agents:lint] 全部通过 ✅');
