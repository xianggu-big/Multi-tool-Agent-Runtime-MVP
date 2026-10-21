<!-- 本文件由 `npm run agents:docs` 从 src/agents/specs.ts 生成，请勿手改；改契约请改 specs.ts 后重跑。 -->
# 子 Agent 契约：code-audit

**代码审计子 Agent（只读）**

## 1. 职责（做什么）
在指定目录内做只读代码审计：定位关键实现、检查可疑模式（TODO/FIXME、硬编码、缺少校验）、给出带文件路径的发现。

## 2. 不做什么（硬边界）
- 修改代码
- 运行测试或任意命令
- 联网
- 读取仓库外的文件
- 对未读过的文件下结论

## 3. 能力清单
| 项 | 内容 |
|---|---|
| 工具白名单（披露顺序即此顺序，保持稳定以利缓存） | `search_files`、`list_files`、`read_file`、`submit_finding` |
| 权限（必须恰好等于工具所需权限的并集） | `codebase:read`、`agent:report` |
| 最大风险等级 | `safe` |
| 终结性上报工具 | `submit_finding`（调用后子任务立即结束） |

## 4. 输入契约
| 字段 | 是否必填 | 说明 |
|---|---|---|
| `objective` | 必填 | 一句话目标（主 Agent 必须写具体，不许含糊） |
| `inputs` | 必填 | 必填项：`dir` |
| `boundary` | 可选 | 本次额外边界（只能收紧，不能放宽上面的硬边界） |
| `expectedOutput` | 可选 | 期望输出要点 |

## 5. 输出契约
通过 `submit_finding` 提交（Zod 强制校验），字段：
`summary`（必填）、`items[]`、`findings[]`（带 path）、`evidence[]`（证据指针，文件:行号 / URL）、
`confidence`（high/medium/low）、`escalateTo` + `escalateReason`、`artifacts[]`。

> 业务规则：给了 `escalateTo` 必须给理由；给了 `findings` 且自评 `confidence=high` 时必须至少给一条 `evidence`。
> 未调用 `submit_finding` 就结束 = **契约未履行**，结果会被标注 `contractViolation`，主 Agent 不应直接采信。

## 6. 预算（独立于主 Agent，互不侵占）
| maxSteps | maxModelCalls | maxToolCalls | tokenBudget | totalTimeoutMs |
|---|---|---|---|---|
| 12 | 12 | 24 | 120000 | 150000 |

## 7. 越界与升级
超出能力范围（需要改文件/跑命令/联网调研、或涉及破坏性操作）时：**不要硬撑**，直接调用 `submit_finding` 并填写：
- `escalateTo` = codebase
- `escalateTo` = orchestrator
- `escalateTo` = human
并同时给出 `escalateReason`。

## 8. 资源保留策略（生命周期）
- 重要性分级：`session` — 会话级：保留以支持后续追问，闲置超时后自动释放。
- 闲置超时：300s（无活动后释放）
- 判定由 `src/runtime/SubAgentLifecycle.ts` 的 `shouldRelease()` 统一裁决（规则可解释、可单测）。

## 9. 典型用途示例
- 审计 src/ 下所有文件里的 TODO 与可疑硬编码，给出文件:行号

## 10. 运行期模型参数（默认）
```json
{
  "temperature": 0,
  "thinking": "enabled",
  "reasoningEffort": "low",
  "maxTokens": 8192
}
```
