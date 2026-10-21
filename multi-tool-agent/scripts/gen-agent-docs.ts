// scripts/gen-agent-docs.ts — 从契约生成子 Agent 文档（agents/*.md）
// 用法：npm run agents:docs
// 输出确定：同一份 specs 永远生成同样的字节，因此可以用 agents:lint 做漂移检测。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { SUB_AGENT_SPECS } from '../src/agents/specs.js';
import { renderDocSet } from '../src/agents/renderDocs.js';

const config = loadConfig();
const { files } = renderDocSet(SUB_AGENT_SPECS, config.subagent);

let written = 0;
for (const [rel, content] of Object.entries(files)) {
  const abs = resolve(rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  written += 1;
  console.log(`  ✓ ${rel} (${content.length} 字节)`);
}
console.log(`[agents:docs] 已生成 ${written} 份文档（源：src/agents/specs.ts）`);
