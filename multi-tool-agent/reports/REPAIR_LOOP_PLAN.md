# 复验驱动返工环（R-Loop）设计方案

> **定位**：写路径的「验证失败 → 定向返工」闭环设计 + 分阶段实施计划。Phase 0（评测尺子）随本方案同轮落地；Phase 1/2/3 待用户复审后开工。
> **为什么是它**：2026-10-24 审核评测机制对照（项目 vs 市面前沿）的差距分析中，本项目在部署期兜底（沙箱+审批+复验回滚）已对齐业界，唯一「低成本高收益」缺口是 **agentic self-repair**——测试失败后自动带结构化证据返工，而不是拦截后靠人/主 Agent 重试。
> **状态**：Phase 0 已实现（见 §6）；Phase 1~3 未实施。

## 1. 设计铁律（三条，全部对齐既有哲学）

1. **人闸不动**：返工环放在**审批之前**（沙箱内），不在落盘之后。返工成功后仍必须过人工审批。返工环的价值是让人类只看到「验证过的绿色」或「诚实的红色」，降低审批疲劳（呼应 `APPROVAL_MAX_FILES`）。
2. **fail-closed，有上限，不当永动机**：`MTA_REPAIR_MAX_ROUNDS`（默认 **2**，0=关闭，clamp 0~8）控制返工轮数；每轮计入 run 总预算（走 `runLimits`，不新开预算口子）；**同错误熔断**——本轮失败特征（失败测试名集合）与上一轮完全相同 → 不再进入下一轮，强制收尾（对齐 `APPROVAL_MAX_DENIES`「同文件拒 3 次强制收尾」哲学）。
3. **如实上报**：返工 N 轮仍红 = 诚实失败，`run_digest.repair` 记录 `{rounds, outcome, firstFailure, sameErrorCutoff}`。绝不出现「重试到碰巧通过就当没事」；每一次返工都有事件可查。

## 2. 与现有机制的关系（全部复用，不另起炉灶）

| 现有资产 | 在 R-Loop 中的角色 |
|---|---|
| 沙箱阶梯（snapshot → apply → L1/L2） | 每轮返工复用同一沙箱与快照；**每轮先恢复 base 快照再应用新 change set**（原子轮，绝不在失败脏状态上叠改——保住 journal 与 TOCTOU 复核语义） |
| `verificationPlan`（full_suite / typecheck / unavailable） | 返工的验证器；`unavailable`（仓库无测试无 tsc）时**返工环根本不启动**——没有验证器就没有返工依据，照旧如实标注「未经行为验证」 |
| 审批闸（三态 + `confirmHighRisk`） | 完全不变；返工成功后的 change set 与首轮一样走审批 |
| apply-journal / 回滚 / 崩溃对账 | 不变；返工只发生在审批前的沙箱内，不触碰宿主文件 |
| run 预算（`runLimits`） | 返工轮消耗 run 的 steps/tokens/timeout 预算；预算耗尽 → 诚实中止 |
| 事件流 + `run_digest` | 新增 `repair_round_started` / `repair_round_completed` 事件与 `digest.repair` 字段 |
| eval:edit / eval:edit:real / HARNESS | Phase 0 先加确定性场景定尺子；Phase 2 用真模型量化 RSR 与 pass^2 |

## 3. 机制设计（关键取舍）

- **编排者是运行时，不是模型**：返工环由 AgentRuntime 写路径编排，**不给模型新的验证类工具**（否则模型会学会刷验证）。模型唯一看到的是：原任务 + 结构化失败报告 + 「请修订」指令。
- **失败证据结构化，不做日志倾倒**：只抽「失败测试名集合 + 错误输出尾段」，尾段 ≤8KB（对齐 `read_file` 8MiB 预检的 token 纪律）。这是与「盲目重试」的本质区别：喂可定位的证据，不是「又失败了，再试试」。
- **同错误熔断的判定**：比较相邻两轮的失败测试名集合（归一化后集合相等即视为同一错误）。命中熔断时 `outcome='cutoff'`，未消耗的轮次不再执行。
- **落盘后的宿主复验失败不在本环内**：宿主红 → 现有行为不变（自动回滚 + 恢复卡）。**不做落盘后静默返工**——文件已进工作区，暗改必须经人。

## 4. 流程（Phase 1 实现目标）

```
变更集 → 沙箱应用+L1/L2 验证 → 通过？─是→ 既有放行链（人审→落盘→宿主复验，不变）
                                  │否
                                  ▼
                            轮次余量且预算够？─否→ 诚实失败收尾（digest.repair 如实记录）
                                  │是
                                  ▼
                     恢复快照 → 失败证据反馈给模型 → 修订 → 重新应用+验证（回到验证）
```

## 5. 指标口径（进 HARNESS 记分卡）

| 指标 | 定义 | 安全不变量 |
|---|---|---|
| RSR（repair success rate） | 首轮红 → 返工后最终获批落盘的比例 | — |
| rounds-to-green | 成功案例的返工轮数分布（1/2/…） | — |
| cost-per-repaired | 返工消耗的增量 token / 成功修复数 | — |
| pass^2（含返工） | 同任务重复 2 次均最终成功的概率，与无返工基线对照 | — |
| false-green rate | 任何「报告绿但宿主复验红」的比例 | **必须 = 0** |

## 6. 分阶段实施

### Phase 0：评测尺子先行（本轮已做，0 token）

`eval:edit` 新增 5 个确定性返工场景（脚本驱动，不调模型，需 Docker + `mta-sandbox:node24`）：

| # | 场景 | 预期 |
|---|---|---|
| R1 | repair_first_red_then_green：首轮红 → 返工后绿 | `repaired@1`，审批卡仍出现，落盘成功 |
| R2 | repair_all_red：连续两轮全红 | 诚实失败，无审批卡，不落盘，digest 记 `failed` |
| R3 | repair_same_error_cutoff：maxRounds=3，两轮同错误 | 第 3 轮不执行，`outcome='cutoff'` |
| R4 | repair_budget_exhausted：返工中途预算耗尽 | 诚实中止，无部分落盘 |
| R5 | repair_approval_still_required：返工绿后拒绝审批 | 不落盘，证明返工不自动放行 |

### Phase 1：运行时实现（待开工）

- `src/runtime/AgentRuntime.ts`：写路径编排返工环（审批前）；新增两个事件。
- `src/runtime/runLimits.ts`：`repairMaxRounds` 校验（0~8）。
- `src/types.ts`：`repair_round_*` 事件类型 + `run_digest.repair`。
- 单测：轮次上限 / 同错误熔断 / 预算耗尽 / `unavailable` 不启动 / 返工后审批仍必需 / 既有终态事件守卫（tests/50d）不破坏。

### Phase 2：真模型量化（待开工）

`npm run eval:edit:real -- --repair`：26 条任务跑「无返工基线 vs 开返工」A/B，产出 RSR、rounds-to-green、cost-per-repaired、pass^2 对照，写入 `reports/EDIT_EVAL_REAL.md` 新节。

### Phase 3（可选，后议）

宿主复验红的「审批制返工」（回滚后向用户请求一轮返工授权）；前端时间线返工卡片。

## 7. 验收清单

- [x] Phase 0（2026-10-24 完成）：12 场景全命中（`npm run eval:edit` **12/12**：E1~E7 基线 + R1~R5；7 次审批 / 5 文件落盘 / 1 回滚 / 平均 13.0s / P95 15.1s / 0 token）；判定函数 `decideRepair` 单测 `tests/80`（10 例，钉死优先级：绿收尾 → 轮次上限 → 预算 → 首轮放行 → 同错误熔断 → 继续）
- [ ] Phase 1：单测覆盖 §6 Phase 1 全部分支；`npm test` 全绿；`typecheck` 0 错误；`agents:lint` 通过
- [ ] Phase 2：A/B 报告含 RSR / pass^2 / 成本三组数字，且 false-green = 0
- [ ] 全程：无任何「返工后绕过审批」的路径（Phase 0 场景 R5 为守卫）

## 8. 边界声明

- 返工环不提升模型编辑智力，只减少「可被测试拦住的错误」到达人眼的频率。
- 同错误熔断基于失败测试名集合，不能识别「测试名不变但失败原因变了」的深层情况（Phase 2 实测后再评估是否升级为错误指纹）。
- `typecheck` 降级模式（无测试仓库）下返工依据是类型错误，证据抽取格式与测试失败不同，Phase 1 一并实现但评测只覆盖 full_suite。
- 本环在沙箱内消耗的是 run 预算，真实模型场景会显著增加 token 消耗，Phase 2 必须先报成本再谈收益。

## 9. 复现命令

```powershell
# Phase 0：确定性返工场景（需 Docker + mta-sandbox:node24，0 token）
npm run eval:edit
# Phase 2（实现后）：真模型返工 A/B（需 DEEPSEEK_API_KEY）
npm run eval:edit:real -- --repair --tasks=26 --budget-usd=2
```
