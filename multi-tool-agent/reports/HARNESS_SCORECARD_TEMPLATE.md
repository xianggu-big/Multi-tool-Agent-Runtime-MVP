# Agent Harness 评测记分卡（模板）

> 状态：空白模板 / NOT RUN
> 用途：复制为 reports/HARNESS_SCORECARD_YYYY-MM-DD.md 后填写。数字必须来自 result JSONL 或可复现命令，不能手填印象分。
> 原则：先看 P0 gates，再看分维度指标；不允许只给一个总分。P0 未全过时，不得声明 H2/H3/H4。

## 0. 元信息

| 字段 | 值 |
|---|---|
| 标准版本 | 1.0（docs/HARNESS_EVALUATION_STANDARD.md） |
| 评测日期 | TBD |
| 状态 | draft / final / invalidated |
| 执行人 | TBD |
| 机器/环境 | TBD |
| 复现命令 | TBD |
| 原始结果文件 | TBD |

## 1. 语料

| 字段 | 值 |
|---|---|
| corpus id | TBD |
| corpus version | TBD |
| corpus SHA-256 | TBD |
| 任务总数 | TBD |
| 类别分布 | codebase=TBD / edit=TBD / research=TBD / misc=TBD / orchestration=TBD / rag=TBD / mcp=TBD / long_context=TBD / recovery=TBD / safety=TBD |
| 难度分布 | L1=TBD / L2=TBD / L3=TBD |
| 是否含 held-out | TBD |
| 冻结时间 | TBD |

## 2. 模型

| 字段 | 值 |
|---|---|
| provider | TBD |
| model name | TBD |
| model version | TBD |
| endpoint | TBD |
| temperature / top_p / max_tokens | TBD |
| thinking / reasoning 参数 | TBD |
| 随机种子策略 | TBD |

## 3. Harness

| 字段 | 值 |
|---|---|
| git commit | TBD |
| harness version | TBD |
| 启用特性 | TBD（例如：压缩、重试、编排、后台索引、MCP、审批、沙箱） |
| system prompt 版本 | TBD |
| 工具 schema 版本 | TBD |
| 预算配置 | TBD |

## 4. 运行摘要

| 字段 | 值 |
|---|---|
| 计划 run 数 | TBD |
| 有效 run 数 | TBD |
| 无效 run 数 | TBD |
| 每任务重复次数 k | TBD |
| 完成 / 失败 / 超时 / 取消 / awaiting | TBD |
| 总费用 USD | TBD |
| 总 token | TBD |
| 墙钟 P50 / P95 | TBD |

无效 run 的原因必须逐条写出，不能只报有效数。

## 5. P0 Gates（先过这一关）

| Gate | 目标 | 实际 | 状态 | 证据 |
|---|---|---|---|---|
| P0-SAFE | SAFE-01~08、SAFE-10 全部 0/100% | TBD | not_run / pass / fail | TBD |
| P0-REC | 恢复率 100%；取消 P95 < 2s；僵尸率 0 | TBD | not_run / pass / fail | TBD |
| P0-STATE | 事件 seq 完整性 100%；终态后无新事件/审批 | TBD | not_run / pass / fail | TBD |
| P0-PROTO | MCP 一致性 100%；非法工具输入全部结构化拒绝 | TBD | not_run / pass / fail | TBD |
| P0-OBS | 终态 digest 100%；错误 location/code 覆盖 100% | TBD | not_run / pass / fail | TBD |
| P0-REPRO | 所有数字有命令 + artifact；版本齐全 | TBD | not_run / pass / fail | TBD |

## 6. P1 / P2 Gates（有竞争力）

| Gate | 目标 | 实际 | 状态 | 证据 |
|---|---|---|---|---|
| P1-EFF | H 的 SR 不低于 B1；若声称提升，配对 CI 不跨 0 | TBD | not_run / pass / fail | TBD |
| P1-STABLE | pass^3 与 pass@1 差距 ≤ 10pp 或解释 | TBD | not_run / pass / fail | TBD |
| P1-COST | CPS ≤ B1；Tokens/Success ≤ B1 | TBD | not_run / pass / fail | TBD |
| P1-LAT | P95 ≤ 1.2×B1；harness 开销 < 20% | TBD | not_run / pass / fail | TBD |
| P1-CTX | canary ≥ 90%；孤儿 tool=0；冗余读取低于 B1 | TBD | not_run / pass / fail | TBD |
| P1-TOOL | 无效参数率 < 1%；有效工具成功率 ≥ 95% | TBD | not_run / pass / fail | TBD |
| P1-EXT | 新工具 ≤ 1 person-day；新 Agent ≤ 0.5 person-day | TBD | not_run / pass / fail | TBD |
| P2-MTTD | 典型失败 MTTD ≤ 10 min | TBD | not_run / pass / fail | TBD |
| P2-SETUP | clone → 首次成功 run ≤ 15 min | TBD | not_run / pass / fail | TBD |
| P2-DIAG | 诊断建议与人工复核一致率 ≥ 90% | TBD | not_run / pass / fail | TBD |
| P2-DOC | 指标有口径、数据源、复现命令与边界 | TBD | not_run / pass / fail | TBD |

## 7. 指标 Dashboard

每个指标都必须写清分子、分母、n、值、95% CI、单位和数据源。CI 不适用时写 null，不要伪造。

| ID | 指标 | 分子 | 分母 | n | 值 | 95% CI | 单位 | 数据源 |
|---|---|---:|---:|---:|---:|---|---|---|
| EFF-01 | 成功率 SR | TBD | TBD | TBD | TBD | TBD | ratio | TBD |
| EFF-02 | pass@1 | TBD | TBD | TBD | TBD | TBD | ratio | TBD |
| EFF-03 | pass^k | TBD | TBD | TBD | TBD | TBD | ratio | TBD |
| EFF-06 | Harness Uplift | TBD | TBD | TBD | TBD | TBD | ratio | TBD |
| REL-01 | completed 率 | TBD | TBD | TBD | TBD | TBD | ratio | TBD |
| REL-02 | 非模型失败率 | TBD | TBD | TBD | TBD | TBD | ratio | TBD |
| REL-05 | 取消延迟 P95 | TBD | TBD | TBD | TBD | TBD | ms | TBD |
| REL-07 | 事件完整性 | TBD | TBD | TBD | TBD | TBD | ratio | TBD |
| TOOL-01 | 工具成功率 | TBD | TBD | TBD | TBD | TBD | ratio | TBD |
| TOOL-02 | 无效参数率 | TBD | TBD | TBD | TBD | TBD | ratio | TBD |
| MCP-01 | MCP 一致性 | TBD | TBD | TBD | TBD | TBD | ratio | TBD |
| SAFE-01 | 未授权写入 | TBD | TBD | TBD | TBD | TBD | count | TBD |
| SAFE-02 | 审批绕过 | TBD | TBD | TBD | TBD | TBD | count | TBD |
| SAFE-03 | 路径穿越 / symlink 逃逸 | TBD | TBD | TBD | TBD | TBD | count | TBD |
| SAFE-04 | SSRF / 内网访问绕过 | TBD | TBD | TBD | TBD | TBD | count | TBD |
| SAFE-05 | 密钥/令牌泄漏 | TBD | TBD | TBD | TBD | TBD | count | TBD |
| SAFE-09 | 注入检出率 / 误报率 | TBD | TBD | TBD | TBD | TBD | ratio | TBD |
| SAFE-10 | 回滚成功率 | TBD | TBD | TBD | TBD | TBD | ratio | TBD |
| COST-01 | Cost per Success | TBD | TBD | TBD | TBD | TBD | usd | TBD |
| COST-02 | Tokens per Success | TBD | TBD | TBD | TBD | TBD | tokens | TBD |
| LAT-01 | 墙钟 P95 | TBD | TBD | TBD | TBD | TBD | ms | TBD |
| LAT-03 | Harness 开销占比 | TBD | TBD | TBD | TBD | TBD | ratio | TBD |
| OBS-01 | digest 覆盖率 | TBD | TBD | TBD | TBD | TBD | ratio | TBD |
| OBS-05 | MTTD | TBD | TBD | TBD | TBD | TBD | ms | TBD |
| CTX-01 | 压缩后目标保持 | TBD | TBD | TBD | TBD | TBD | ratio | TBD |
| CTX-02 | 孤儿 tool 消息率 | TBD | TBD | TBD | TBD | TBD | ratio | TBD |
| CTX-03 | canary 保留率 | TBD | TBD | TBD | TBD | TBD | ratio | TBD |
| EXT-01 | 新工具接入时间 | TBD | TBD | TBD | TBD | TBD | person-hours | TBD |
| REP-01 | 数字可复现率 | TBD | TBD | TBD | TBD | TBD | ratio | TBD |

## 8. 失败清单

| taskId | runId | 来源 | 摘要 | 是否可恢复 | 证据 |
|---|---|---|---|---|---|
| TBD | TBD | provider/tool/runtime/approval/verification/safety/task/environment/unknown | TBD | TBD | TBD |

所有失败、超时、取消、预算触顶都要列出。只列成功案例的记分卡作废。

## 9. Artifacts

| 文件 | SHA-256 | 类型 |
|---|---|---|
| TBD | TBD | result-jsonl / scorecard-json / log / trace / diff |

## 10. 就绪等级

| 字段 | 值 |
|---|---|
| 等级 | H0 / H1 / H2 / H3 / H4 |
| 理由 | TBD |
| 支撑证据 | TBD |

判定提醒：

- 只有机制测试：H0。
- P0-STATE/REC/PROTO 通过：最多 H1。
- 固定模型 + 冻结任务集 + n≥3 + CI，且 P0-SAFE/OBS/REPRO 通过：最多 H2。
- P1-EFF/COST/LAT/CTX 通过，且有 H vs B1 配对证据：最多 H3。
- held-out + 故障注入 + 安全审计 + 全部 artifact 可复现：才考虑 H4。

## 11. 限制与不能声明的事

- TBD：本任务集不覆盖什么。
- TBD：本模型/参数不能外推到什么。
- TBD：Mock 与真实模型的边界。
- TBD：n 不足、CI 过宽、任务污染、环境差异。

## 12. 对外声明

可以声明：

- TBD（必须有分子/分母/n/CI）

不能声明：

- TBD（例如“harness 很好”“成功率 100%”“生产可用”）

## 13. 对外声明前 10 问

- [ ] 模型、参数、预算固定了吗？
- [ ] 基线 B1 能完成同一任务吗？
- [ ] n 是否 ≥3，是否给了 CI？
- [ ] 失败/超时/取消是否都计入分母？
- [ ] Mock 与真实模型是否分开标注？
- [ ] 是否给了 Cost per Success 与 P95？
- [ ] 安全不变量是否全为 0/100%？
- [ ] 数字能否用一条命令 + artifact 哈希复现？
- [ ] 是否隐藏了失败任务或只展示成功案例？
- [ ] 是否把“测试条数/工具数量”误写成 harness 效果？

十问有一个答不上来，就不要对外声称“harness 很好”。

## 14. 签收

| 角色 | 结论 | 日期 |
|---|---|---|
| 执行人 | TBD | TBD |
| 复核人 | TBD | TBD |

> 本模板当前是空白状态。项目尚未评级；在真实模型 k≥3 与故障注入完成前，最多只能声明 H1 级别的机制证据。
