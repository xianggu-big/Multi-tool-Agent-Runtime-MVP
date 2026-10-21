// src/agents/renderDocs.ts — 从契约（specs.ts）渲染人读文档（纯函数，确定性输出）
// 设计原则：**文档从契约生成，不手写**。
//   - `npm run agents:docs` 把这里渲染的内容写进 agents/*.md；
//   - `npm run agents:lint` 用同一函数重新渲染并与磁盘比对，不一致就判为漂移（CI 门禁）。
// 输出必须**逐字节确定**：不写时间戳、不写随机 id、数组顺序固定——否则 lint 会永远报漂移。

import type { SubAgentSpec } from './specs.js';

export interface DocSet {
  /** 路径 → 内容（相对项目根目录） */
  files: Record<string, string>;
}

const GENERATED_HEADER =
  '<!-- 本文件由 `npm run agents:docs` 从 src/agents/specs.ts 生成，请勿手改；改契约请改 specs.ts 后重跑。 -->';

function bullet(items: string[]): string {
  return items.map((x) => `- ${x}`).join('\n');
}

/** 单个子 Agent 的契约卡（人读版） */
export function renderSpecDoc(spec: SubAgentSpec): string {
  return [
    GENERATED_HEADER,
    `# 子 Agent 契约：${spec.id}`,
    '',
    `**${spec.title}**`,
    '',
    '## 1. 职责（做什么）',
    spec.responsibilities,
    '',
    '## 2. 不做什么（硬边界）',
    bullet(spec.notDo),
    '',
    '## 3. 能力清单',
    `| 项 | 内容 |`,
    `|---|---|`,
    `| 工具白名单（披露顺序即此顺序，保持稳定以利缓存） | ${spec.tools.map((t) => `\`${t}\``).join('、')} |`,
    `| 权限（必须恰好等于工具所需权限的并集） | ${spec.permissions.map((p) => `\`${p}\``).join('、')} |`,
    `| 最大风险等级 | \`${spec.maxRiskLevel}\` |`,
    `| 终结性上报工具 | \`submit_finding\`（调用后子任务立即结束） |`,
    '',
    '## 4. 输入契约',
    `| 字段 | 是否必填 | 说明 |`,
    `|---|---|---|`,
    `| \`objective\` | 必填 | 一句话目标（主 Agent 必须写具体，不许含糊） |`,
    `| \`inputs\` | ${spec.requiredInputs?.length ? '必填' : '可选'} | 必填项：${(spec.requiredInputs ?? []).map((r) => `\`${r}\``).join('、') || '无'} |`,
    `| \`boundary\` | 可选 | 本次额外边界（只能收紧，不能放宽上面的硬边界） |`,
    `| \`expectedOutput\` | 可选 | 期望输出要点 |`,
    '',
    '## 5. 输出契约',
    '通过 `submit_finding` 提交（Zod 强制校验），字段：',
    '`summary`（必填）、`items[]`、`findings[]`（带 path）、`evidence[]`（证据指针，文件:行号 / URL）、',
    '`confidence`（high/medium/low）、`escalateTo` + `escalateReason`、`artifacts[]`。',
    '',
    '> 业务规则：给了 `escalateTo` 必须给理由；给了 `findings` 且自评 `confidence=high` 时必须至少给一条 `evidence`。',
    '> 未调用 `submit_finding` 就结束 = **契约未履行**，结果会被标注 `contractViolation`，主 Agent 不应直接采信。',
    '',
    '## 6. 预算（独立于主 Agent，互不侵占）',
    `| maxSteps | maxModelCalls | maxToolCalls | tokenBudget | totalTimeoutMs |`,
    `|---|---|---|---|---|`,
    `| ${spec.budget.maxSteps} | ${spec.budget.maxModelCalls} | ${spec.budget.maxToolCalls} | ${spec.budget.tokenBudget} | ${spec.budget.totalTimeoutMs} |`,
    '',
    '## 7. 越界与升级',
    `超出能力范围（需要改文件/跑命令/联网调研、或涉及破坏性操作）时：**不要硬撑**，直接调用 \`submit_finding\` 并填写：`,
    bullet(spec.escalateTo.map((e) => `\`escalateTo\` = ${e}`)),
    '并同时给出 `escalateReason`。',
    '',
    '## 8. 资源保留策略（生命周期）',
    (() => {
      const r = spec.retention;
      const importance = r?.importance ?? 'ephemeral';
      const desc: Record<string, string> = {
        ephemeral: '一次性任务：结果被主 Agent 采纳后立即释放上下文（终结性上报完成即回收，不常驻）。',
        session: '会话级：保留以支持后续追问，闲置超时后自动释放。',
        durable: '长生命周期：常驻，除非显式退役或硬性 maxAge 到期。',
      };
      const lines = [`- 重要性分级：\`${importance}\` — ${desc[importance]}`];
      if (r?.idleTimeoutMs) lines.push(`- 闲置超时：${Math.round(r.idleTimeoutMs / 1000)}s（无活动后释放）`);
      if (r?.maxAgeMs) lines.push(`- 最大存活：${Math.round(r.maxAgeMs / 1000)}s（硬性兜底）`);
      lines.push('- 判定由 `src/runtime/SubAgentLifecycle.ts` 的 `shouldRelease()` 统一裁决（规则可解释、可单测）。');
      return lines.join('\n');
    })(),
    '',
    '## 9. 典型用途示例',
    bullet(spec.examples),
    '',
    '## 10. 运行期模型参数（默认）',
    '```json',
    JSON.stringify(spec.modelParams ?? {}, null, 2),
    '```',
    '',
  ].join('\n');
}

/** 协作总则（AGENTS.md）：所有子 Agent 的共同约定 */
export function renderAgentsIndex(
  specs: SubAgentSpec[],
  limits: { maxConcurrency: number; maxWidth: number; maxDepth: number; resultChars: number },
): string {
  const table = [
    '| 契约 id | 标题 | 工具数 | 权限 | 预算（步/模型/工具/tokens） | 重要性 | 越界改派 |',
    '|---|---|---|---|---|---|---|',
    ...specs.map(
      (s) =>
        `| \`${s.id}\` | ${s.title} | ${s.tools.length} | ${s.permissions.map((p) => `\`${p}\``).join(' ')} | ` +
        `${s.budget.maxSteps}/${s.budget.maxModelCalls}/${s.budget.maxToolCalls}/${s.budget.tokenBudget} | ` +
        `\`${s.retention?.importance ?? 'ephemeral'}\` | ${s.escalateTo.join(' → ')} |`,
    ),
  ].join('\n');

  return [
    GENERATED_HEADER,
    '# 多 Agent 协作总则（AGENTS.md）',
    '',
    '> 这份文档面向「要被主 Agent 调用的子 Agent」与「维护者」。它与 `src/agents/specs.ts` 同源，',
    '> 由 `npm run agents:docs` 生成、`npm run agents:lint` 校验一致——**不存在"实现与文档不一致"的情况**。',
    '',
    '## 1. 三种角色',
    '| 角色 | 有什么能力 | 结构层保证 |',
    '|---|---|---|',
    '| **主 Agent（编排）** | `delegate_subtasks`（派发）、`submit_orchestration`（汇总） | 默认不给自己只读工具；宽度/深度受 Runtime 守卫 |',
    '| **子 Agent** | 仅自己契约里的工具 + `submit_finding` | 独立上下文 / 独立预算 / 独立权限；**上下文中不注入派发能力 → 无法再委派** |',
    '| **Runtime** | 并发池、级联取消、事件与 trace、预算与权限强制、结果统计 | 统计口径以 Runtime 为准，不采信模型自报 |',
    '',
    '## 2. 调用方式（接口约定）',
    '```jsonc',
    '// 主 Agent 调用（一次派发一批，彼此必须相互独立）',
    '{',
    '  "subtasks": [',
    '    {',
    '      "specId": "dir-inventory",           // 契约 id（见下表）',
    '      "objective": "清点 src 目录的文件数与扩展名分布",  // 一句话、可验证',
    '      "inputs": { "dir": "src" },          // 输入引用（具体到目录/来源，不要"整个仓库"）',
    '      "boundary": "只统计 src，不递归到其它顶层目录",     // 只能收紧',
    '      "expectedOutput": "文件数、总大小、扩展名 Top5"',
    '    }',
    '  ]',
    '}',
    '```',
    '返回：每个子任务一条 `SubtaskOutcome`（`status` / `report` / `evidence` / `confidence` / `usage` / `durationMs`）。',
    '',
    '## 3. 契约一览',
    table,
    '',
    '## 4. 协作纪律（主 Agent 必读）',
    '1. **先判依赖再拆**：子任务必须相互独立；有依赖的活串行分多次派发。',
    '2. **四要素齐全**：specId / objective / inputs / boundary（+ expectedOutput）。目标含糊是子 Agent 跑偏的第一原因。',
    `3. **宽度与深度上限**：单次派发 ≤ ${limits.maxWidth}（并发 ≤ ${limits.maxConcurrency}），层级深度 ≤ ${limits.maxDepth}（当前子 Agent 无法再委派）。`,
    '4. **结论是"待采纳"**：结合 `evidence`、`confidence`、`contractViolation` 判断；低置信或缺证据 → 标注不确定或再派一次交叉验证。',
    '5. **禁止假装成功**：失败/取消/截断必须在汇总的 `unresolved` 里如实列出（Runtime 也会自动补一条统计提醒）。',
    '6. **冲突显式化**：子任务结论不一致时写进 `conflicts` 并说明处理方式，不要静默取一个。',
    '',
    '## 5. 每个子任务看到什么（隔离约定）',
    '- 只看得到自己契约里的工具定义（**披露层**过滤，按 `tools` 顺序固定披露 → 前缀稳定利好缓存）；',
    `- 只拿到 \`objective\` + \`inputs\`（结果回传主 Agent 时按 ${limits.resultChars} 字符/字段裁剪，防上下文爆炸）；`,
    '- 看不到主 Agent 的对话历史，也看不到兄弟子任务的结果（Actor 式隔离）；',
    '- 权限只来自自己的契约（**授权层**强制）——注册了工具 ≠ 这次允许执行。',
    '',
    '## 6. 维护者须知',
    '- 新增子 Agent：只在 `src/agents/specs.ts` 加一条，然后 `npm run agents:docs && npm run agents:lint && npm test`。',
    '- 契约自校验会拦截：工具未注册 / 权限缺少声明 / **权限超集（偷偷提权）** / 缺终结性上报工具 / 预算非法。',
    '- 工具与权限的对应关系以 `src/runtime/AgentRuntime.ts` 的 `TOOL_PERMISSION` 为唯一事实来源。',
    '',
  ].join('\n');
}

/** 渲染整套文档（顺序固定，保证逐字节确定） */
export function renderDocSet(
  specs: SubAgentSpec[],
  limits: { maxConcurrency: number; maxWidth: number; maxDepth: number; resultChars: number },
): DocSet {
  const files: Record<string, string> = {
    'agents/AGENTS.md': renderAgentsIndex(specs, limits),
  };
  for (const spec of [...specs].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    files[`agents/${spec.id}.agent.md`] = renderSpecDoc(spec);
  }
  return { files };
}
