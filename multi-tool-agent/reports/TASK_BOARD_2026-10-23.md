# 任务表（2026-10-23 第二轮）

> 目标：把「还能显著改变成本曲线」和「小而该做」的短板补成**可验证**的改动。
> 规则：每项必须有验收口径；做不完的如实标 BLOCKED/DEFERRED，不把“写了代码”当成“完成”。

| ID | 任务 | 优先级 | 状态 | 验收口径 |
|---|---|---|---|---|
| T1 | 编排预筛闸门：单上下文装得下就不编排 | P0 | ✅ DONE | 自动分流可降级；显式编排不降级但可解释；回归 `tests/65`。**真实 A/B 未重跑**（写在 `PARALLEL_AB.md` §6） |
| T2 | 子任务重复读取：读取台账 + 重复检测（不谎称省 token） | P0 | ✅ DONE | `run_digest.readStats` + 前端面板；回归 `tests/56g`；**只观测，未做共享缓存** |
| T3 | MCP 高危工具人工闸门 | P0 | ✅ DONE | 无通道拒绝 / 拒绝不执行 / 批准才执行；回归 `tests/44h` |
| T4 | MCP 手动重连 + 状态刷新 | P1 | ✅ DONE | `POST /api/mcp/reconnect` 实测 error→ready；回归 `tests/64i/64j` |
| T5 | 真实 LLM 自主选择 MCP 工具（E2E） | P1 | ✅ DONE | `npm run mcp:e2e` PASS；证据 `reports/MCP_WRITE_E2E.md` §2 |
| T6 | 编辑管线 HTTP + 人工审批 smoke | P1 | ✅ DONE | `npm run e2e:write` PASS；证据同报告 §3；顺带修 3 个输入摩擦 |
| T7 | `subtasks` 表 + 按 spec 成功率 | P2 | ✅ DONE（轻量版） | 不建表：`GET /api/subtasks/stats` 聚合 `runs.resultJson`；回归 `tests/67` |
| T8 | evidence 绑定文件哈希 | P2 | ⏸ DEFERRED | 需要改 evidence 结构 + 所有上报方 + UI 失效提示；当前样本小，收益低于风险 |
| T9 | LICENSE + 架构图 + README 展示 | P2 | 🟡 PARTIAL | README 已有 Mermaid 架构图 + 新命令；**LICENSE 需用户选许可证**（不擅自默认 MIT） |
| T10 | MCPHub 旧 token 轮换 | 运维 | BLOCKED（需用户） | 旧 key 删除/轮换；`mcp:probe` 用新 token 通过 |

## 执行顺序

1. T1（先量成本，再改结构）
2. T3 + T4（MCP 安全与可运维，同一批文件）
3. T2 + T8（读写路径的可追溯性）
4. T5 / T6（需要外部模型或真实 UI 的验证，能做则做）
5. T7 / T9（工程整洁度，最后做）

## 证据落点

- 代码：`src/`、`tests/`
- 量化：`reports/PARALLEL_AB.md`、`reports/UI_STREAM_PERF.md`、`reports/EDIT_EVAL*.md`
- 变更：`reports/CHANGELOG.md`、`reports/PROJECT_REPORT.md`
- 本轮真实 E2E：`reports/MCP_WRITE_E2E.md`（MCP 3,756 tok / 2.8s；写链路 38,542 tok / 95.7s / 1 次审批 / 0 回滚）

## 执行记录（2026-10-23）

- 全量门禁：typecheck 0 错误；`npm test` **67 文件 / 444 子测试 / 444 通过**；`agents:lint` 三项通过。
- T5 两次运行对照：修复前 4 次工具调用 / 9,487 tok / 7.1s；修复后 2 次 / 3,756 tok / 2.8s（差异来自 `submit_result` 接受字符串简写）。
- T6 实测暴露并修掉：`delegate_subtasks` 字符串入参、`submit_orchestration.conflicts` 字符串、`run_tests` 关闭时仍出现在子 Agent 工具池。
