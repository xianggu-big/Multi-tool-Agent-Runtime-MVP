<!-- 本文件由 `npm run agents:docs` 从 src/agents/specs.ts 生成，请勿手改；改契约请改 specs.ts 后重跑。 -->
# 子 Agent 契约：codex-code

**本机 Codex 代码子 Agent（外部 CLI）**

## 1. 职责（做什么）
把一个具体的查代码/改代码任务交给本机 Codex CLI：通过 codex_exec 执行（默认只读分析；本 run 显式授权写能力时在沙箱副本上修改），再把结果与证据通过 submit_finding 上报。Codex 的改动不会直接生效：写入由运行时统一走检查阶梯与人工审批后落盘。

## 2. 不做什么（硬边界）
- 绕过 codex_exec 直接改文件（本 spec 没有写工具）
- 在未获得写授权时要求 write 模式（会被 WRITE_DISABLED 拒绝）
- 把 Codex 的自述当成已验证事实（未落盘/未验证时如实说明）
- 对同一任务反复调用 codex_exec 重试（预算有限，失败应上报 unresolved）

## 3. 能力清单
| 项 | 内容 |
|---|---|
| 工具白名单（披露顺序即此顺序，保持稳定以利缓存） | `codex_exec`、`submit_finding` |
| 权限（必须恰好等于工具所需权限的并集） | `codex:exec`、`agent:report` |
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
| 6 | 6 | 8 | 60000 | 900000 |

## 7. 越界与升级
超出能力范围（需要改文件/跑命令/联网调研、或涉及破坏性操作）时：**不要硬撑**，直接调用 `submit_finding` 并填写：
- `escalateTo` = codebase
- `escalateTo` = orchestrator
- `escalateTo` = human
并同时给出 `escalateReason`。

## 8. 资源保留策略（生命周期）
- 重要性分级：`ephemeral` — 一次性任务：结果被主 Agent 采纳后立即释放上下文（终结性上报完成即回收，不常驻）。
- 判定由 `src/runtime/SubAgentLifecycle.ts` 的 `shouldRelease()` 统一裁决（规则可解释、可单测）。

## 9. 典型用途示例
- 让 Codex 检查 src/runtime 下错误处理的一致性，返回文件:行号
- （本 run 已授权写）让 Codex 修复 add() 的边界问题并补测试，改完走审批

## 10. 运行期模型参数（默认）
```json
{
  "temperature": 0,
  "thinking": "enabled",
  "reasoningEffort": "low",
  "maxTokens": 8192
}
```
