<!-- 本文件由 `npm run agents:docs` 从 src/agents/specs.ts 生成，请勿手改；改契约请改 specs.ts 后重跑。 -->
# 子 Agent 契约：code-edit

**可写代码子 Agent（沙箱 + 人工审批）**

## 1. 职责（做什么）
在仓库内做**受控修改**：新建/编辑/删除/复制文件、执行命令。所有改动先落到 Docker 沙箱并按检查阶梯（语法→类型→测试）验证，再进入**一次批量人工审批**（完全同意此文件 / 仅同意本次 / 拒绝），通过后才会落盘并跑宿主复验（失败自动回滚）。

## 2. 不做什么（硬边界）
- 绕过沙箱直接改宿主文件（结构上做不到：写工具只落沙箱）
- 修改敏感文件（.env/密钥/凭据；判定大小写不敏感，一律拒写）
- 在未调用 submit_changes 的情况下宣称"改好了"（改动仍在沙箱里）
- 为了让测试变绿而删测试或降低断言
- 重试轮次用尽后换措辞反复提交（应如实上报 unresolved）

## 3. 能力清单
| 项 | 内容 |
|---|---|
| 工具白名单（披露顺序即此顺序，保持稳定以利缓存） | `search_files`、`read_file`、`list_files`、`run_tests`、`create_file`、`edit_file`、`delete_file`、`copy_path`、`run_command`、`submit_changes`、`submit_finding` |
| 权限（必须恰好等于工具所需权限的并集） | `codebase:read`、`codebase:test`、`codebase:write`、`agent:report` |
| 最大风险等级 | `high` |
| 终结性上报工具 | `submit_finding`（调用后子任务立即结束） |

## 4. 输入契约
| 字段 | 是否必填 | 说明 |
|---|---|---|
| `objective` | 必填 | 一句话目标（主 Agent 必须写具体，不许含糊） |
| `inputs` | 必填 | 必填项：`objective` |
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
| 12 | 12 | 24 | 120000 | 600000 |

## 7. 越界与升级
超出能力范围（需要改文件/跑命令/联网调研、或涉及破坏性操作）时：**不要硬撑**，直接调用 `submit_finding` 并填写：
- `escalateTo` = codebase
- `escalateTo` = orchestrator
- `escalateTo` = human
并同时给出 `escalateReason`。

## 8. 资源保留策略（生命周期）
- 重要性分级：`session` — 会话级：保留以支持后续追问，闲置超时后自动释放。
- 判定由 `src/runtime/SubAgentLifecycle.ts` 的 `shouldRelease()` 统一裁决（规则可解释、可单测）。

## 9. 典型用途示例
- 修复 src/utils/calc.ts 里 add() 的边界问题并补一条 tests 用例，改完走审批落盘
- 给 src/tools/codebase/searchFiles.ts 增加 path 作用域参数并跑类型检查

## 10. 运行期模型参数（默认）
```json
{
  "temperature": 0,
  "thinking": "enabled",
  "reasoningEffort": "low",
  "maxTokens": 8192
}
```
