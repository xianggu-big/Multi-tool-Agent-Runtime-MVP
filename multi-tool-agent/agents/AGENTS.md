<!-- 本文件由 `npm run agents:docs` 从 src/agents/specs.ts 生成，请勿手改；改契约请改 specs.ts 后重跑。 -->
# 多 Agent 协作总则（AGENTS.md）

> 这份文档面向「要被主 Agent 调用的子 Agent」与「维护者」。它与 `src/agents/specs.ts` 同源，
> 由 `npm run agents:docs` 生成、`npm run agents:lint` 校验一致——**不存在"实现与文档不一致"的情况**。

## 1. 三种角色
| 角色 | 有什么能力 | 结构层保证 |
|---|---|---|
| **主 Agent（编排）** | `delegate_subtasks`（派发）、`submit_orchestration`（汇总） | 默认不给自己只读工具；宽度/深度受 Runtime 守卫 |
| **子 Agent** | 仅自己契约里的工具 + `submit_finding` | 独立上下文 / 独立预算 / 独立权限；**上下文中不注入派发能力 → 无法再委派** |
| **Runtime** | 并发池、级联取消、事件与 trace、预算与权限强制、结果统计 | 统计口径以 Runtime 为准，不采信模型自报 |

## 2. 调用方式（接口约定）
```jsonc
// 主 Agent 调用（一次派发一批，彼此必须相互独立）
{
  "subtasks": [
    {
      "specId": "dir-inventory",           // 契约 id（见下表）
      "objective": "清点 src 目录的文件数与扩展名分布",  // 一句话、可验证
      "inputs": { "dir": "src" },          // 输入引用（具体到目录/来源，不要"整个仓库"）
      "boundary": "只统计 src，不递归到其它顶层目录",     // 只能收紧
      "expectedOutput": "文件数、总大小、扩展名 Top5"
    }
  ]
}
```
返回：每个子任务一条 `SubtaskOutcome`（`status` / `report` / `evidence` / `confidence` / `usage` / `durationMs`）。

## 3. 契约一览
| 契约 id | 标题 | 工具数 | 权限 | 预算（步/模型/工具/tokens） | 重要性 | 越界改派 |
|---|---|---|---|---|---|---|
| `dir-inventory` | 目录清点子 Agent | 4 | `misc:read` `codebase:read` `agent:report` | 8/8/16/60000 | `ephemeral` | codebase → human |
| `code-audit` | 代码审计子 Agent（只读） | 4 | `codebase:read` `agent:report` | 12/12/24/120000 | `session` | codebase → orchestrator → human |
| `doc-research` | 资料调研子 Agent | 5 | `research:web` `research:read` `knowledge:read` `agent:report` | 8/10/16/80000 | `ephemeral` | research → human |
| `code-edit` | 可写代码子 Agent（沙箱 + 人工审批） | 11 | `codebase:read` `codebase:test` `codebase:write` `agent:report` | 12/12/24/120000 | `session` | codebase → orchestrator → human |
| `codex-code` | 本机 Codex 代码子 Agent（外部 CLI） | 2 | `codex:exec` `agent:report` | 6/6/8/60000 | `ephemeral` | codebase → orchestrator → human |

## 4. 协作纪律（主 Agent 必读）
1. **先判依赖再拆**：子任务必须相互独立；有依赖的活串行分多次派发。
2. **四要素齐全**：specId / objective / inputs / boundary（+ expectedOutput）。目标含糊是子 Agent 跑偏的第一原因。
3. **宽度与深度上限**：单次派发 ≤ 4（并发 ≤ 4），层级深度 ≤ 1（当前子 Agent 无法再委派）。
4. **结论是"待采纳"**：结合 `evidence`、`confidence`、`contractViolation` 判断；低置信或缺证据 → 标注不确定或再派一次交叉验证。
5. **禁止假装成功**：失败/取消/截断必须在汇总的 `unresolved` 里如实列出（Runtime 也会自动补一条统计提醒）。
6. **冲突显式化**：子任务结论不一致时写进 `conflicts` 并说明处理方式，不要静默取一个。

## 5. 每个子任务看到什么（隔离约定）
- 只看得到自己契约里的工具定义（**披露层**过滤，按 `tools` 顺序固定披露 → 前缀稳定利好缓存）；
- 只拿到 `objective` + `inputs`（结果回传主 Agent 时按 800 字符/字段裁剪，防上下文爆炸）；
- 看不到主 Agent 的对话历史，也看不到兄弟子任务的结果（Actor 式隔离）；
- 权限只来自自己的契约（**授权层**强制）——注册了工具 ≠ 这次允许执行。

## 6. 维护者须知
- 新增子 Agent：只在 `src/agents/specs.ts` 加一条，然后 `npm run agents:docs && npm run agents:lint && npm test`。
- 契约自校验会拦截：工具未注册 / 权限缺少声明 / **权限超集（偷偷提权）** / 缺终结性上报工具 / 预算非法。
- 工具与权限的对应关系以 `src/runtime/AgentRuntime.ts` 的 `TOOL_PERMISSION` 为唯一事实来源。
