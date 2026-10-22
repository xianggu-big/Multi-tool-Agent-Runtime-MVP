// tests/23_agent_contracts.test.ts — 契约文档规范（文档从契约生成 + 漂移门禁）
// 这一组测试回答：「怎么保证子 Agent 清楚协作方式与接口约定」——
// 答案不是"写一份好文档"，而是**让文档无法与实现不一致**：文档由契约渲染，测试与 lint 双重校验。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { SUB_AGENT_SPECS } from '../src/agents/specs.js';
import { renderDocSet, renderSpecDoc, renderAgentsIndex } from '../src/agents/renderDocs.js';

const config = loadConfig();

test('23a) 文档渲染是确定性的（同一契约两次渲染逐字节一致）', () => {
  const a = renderDocSet(SUB_AGENT_SPECS, config.subagent);
  const b = renderDocSet(SUB_AGENT_SPECS, config.subagent);
  assert.deepEqual(Object.keys(a.files).sort(), Object.keys(b.files).sort());
  for (const k of Object.keys(a.files)) {
    assert.equal(a.files[k], b.files[k], `${k} 应逐字节一致（否则 lint 会永远报漂移）`);
    assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(a.files[k]), '生成文档里不应含时间戳（会破坏确定性）');
  }
});

test('23b) 每个子 Agent 的契约卡都覆盖了协作必需的九节', () => {
  for (const spec of SUB_AGENT_SPECS) {
    const doc = renderSpecDoc(spec);
    for (const section of [
      '职责（做什么）',
      '不做什么（硬边界）',
      '能力清单',
      '输入契约',
      '输出契约',
      '预算',
      '越界与升级',
      '典型用途示例',
      '运行期模型参数',
    ]) {
      assert.ok(doc.includes(section), `${spec.id} 的文档缺少「${section}」`);
    }
    // 关键信息必须出现（否则子 Agent 只能靠猜）
    assert.ok(doc.includes(spec.responsibilities), '应有职责原话');
    assert.ok(spec.tools.every((t) => doc.includes(t)), '应列出全部工具');
    assert.ok(spec.permissions.every((p) => doc.includes(p)), '应列出全部权限');
    assert.ok(doc.includes(String(spec.budget.maxSteps)), '应列出预算');
    assert.ok(doc.includes('submit_finding'), '应说明终结性上报工具');
  }
});

test('23c) 协作总则说明了角色分工、调用格式与宽度/深度上限', () => {
  const doc = renderAgentsIndex(SUB_AGENT_SPECS, config.subagent);
  assert.ok(doc.includes('主 Agent（编排）'));
  assert.ok(doc.includes('子 Agent'));
  assert.ok(doc.includes('"specId"'), '应给出可复制的调用示例');
  assert.ok(doc.includes(String(config.subagent.maxWidth)), '应写明宽度上限');
  assert.ok(doc.includes(String(config.subagent.maxDepth)), '应写明深度上限');
  assert.ok(doc.includes('待采纳'), '应写明「子任务结论是待采纳的候选」这一采信规则');
  assert.ok(doc.includes('禁止假装成功'), '应写明失败必须如实上报');
  assert.ok(doc.includes('TOOL_PERMISSION'), '应指明权限的唯一事实来源');
});

test('23d) 磁盘上的 agents/*.md 与契约一致（漂移门禁，等价于 npm run agents:lint）', () => {
  const { files } = renderDocSet(SUB_AGENT_SPECS, config.subagent);
  for (const [rel, expected] of Object.entries(files)) {
    const abs = resolve(rel);
    assert.ok(existsSync(abs), `缺少 ${rel}：请运行 npm run agents:docs`);
    // 跨平台：只比较内容，不比较行尾（Windows CRLF / Linux LF 都算一致）
    const actual = readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
    assert.equal(actual, expected.replace(/\r\n/g, '\n'), `${rel} 与契约不一致：请运行 npm run agents:docs 重新生成`);
  }
});

test('23e) 生成的文档不包含任何秘密（Key 模式扫描）', () => {
  const { files } = renderDocSet(SUB_AGENT_SPECS, config.subagent);
  for (const [rel, content] of Object.entries(files)) {
    assert.ok(!/sk-[A-Za-z0-9]{12,}/.test(content), `${rel} 中不应出现疑似密钥`);
    assert.ok(!content.includes('DEEPSEEK_API_KEY='), '不应把环境变量值写进文档');
  }
});

test('23f) 新增契约的"最小步骤"是可复制的（specs.ts → docs → lint）', () => {
  // 用一份最小 spec 渲染，验证渲染器对任意 spec 都能工作（不依赖内置三条的硬编码）
  const minimal = {
    id: 'demo-spec',
    title: '演示子 Agent',
    responsibilities: '只做一件事',
    notDo: ['不写文件'],
    tools: ['read_file', 'submit_finding'],
    permissions: ['codebase:read', 'agent:report'],
    budget: { maxSteps: 2, maxModelCalls: 2, maxToolCalls: 2, tokenBudget: 1000, totalTimeoutMs: 10000 },
    maxRiskLevel: 'safe' as const,
    escalateTo: ['human'],
    examples: ['示例'],
  };
  const doc = renderSpecDoc(minimal);
  assert.ok(doc.includes('# 子 Agent 契约：demo-spec'));
  assert.ok(doc.includes('demo-spec'));
  const set = renderDocSet([minimal], config.subagent);
  assert.deepEqual(Object.keys(set.files).sort(), ['agents/AGENTS.md', 'agents/demo-spec.agent.md']);
});

test('23g) package.json 里登记了契约文档与门禁脚本', () => {
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts['agents:docs'], '应有 agents:docs');
  assert.ok(pkg.scripts['agents:lint'], '应有 agents:lint');
  assert.ok(pkg.scripts['demo:orchestrator'], '应有 demo:orchestrator');
});
