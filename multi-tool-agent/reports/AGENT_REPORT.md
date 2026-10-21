<!-- 由 `npm run report:agent` 从 data/runtime.db 自动生成（只读扫描）。请勿手改：改数据请跑任务，改口径请改脚本。 -->

# Agent 效果报告（自动生成）

> 生成时间：**2026-10-21 04:29:00** ｜ 数据范围：**全部历史** ｜ 数据源：`./data/runtime.db`（401 个任务）
> 口径说明：**成功 = 状态 completed；成功率分母 = 已结束任务（排除 awaiting_user）**；`mock` 与真实模型分开统计（Mock 的成功率不代表真实模型能力）。


## 0. 与上次对比（环比）
| 指标 | 上次（2026-10-21） | 本次 | 变化 |
|---|---|---|---|
| 任务数 | 401 | 401 | — |
| 成功率（全部） | 95.0% | 95.0% | — |
| 成功率（真实模型） | 68.3% | 68.3% | — |
| 平均耗时 | 7.0s | 7.0s | — |
| 累计 tokens | 2141819 | 2141819 | — |
| 累计成本 | $0.60342 | $0.60342 | — |

## 1. 任务台账与效果指标

### 1.1 汇总

| 口径 | 任务数 | 成功 | 等待用户 | 成功率 | 平均步数 | 平均耗时 | P95 耗时 | tokens | 缓存命中 | 成本 |
|---|---|---|---|---|---|---|---|---|---|---|
| 全部 | 401 | 381 | 0 | 95.0% | 3.9 | 7.0s | 19.5s | 2141819 | 50.5% | $0.60342 |
| 真实模型 | 60 | 41 | 0 | 68.3% | 4.1 | 45.2s | 197.8s | 2006750 | 53.9% | $0.60342 |
| Mock（仅演示） | 341 | 340 | 0 | 99.7% | — | 331ms | — | 135069 | — | — |

### 1.2 各 Agent 表现（按 runType）

| Agent | 任务数 | 等待用户 | 成功率 | 平均步数 | 平均耗时 | 工具调用总数 | 模型调用总数 | 成本 |
|---|---|---|---|---|---|---|---|---|
| codebase | 148 | 0 | 91.2% | 3.8 | 2.2s | 501 | 555 | $0.54216 |
| research | 221 | 0 | 100.0% | 4.0 | 540ms | 660 | 881 | $0.00065 |
| misc | 13 | 0 | 92.3% | 3.7 | 13.5s | 59 | 48 | $0.01704 |
| orchestrator | 19 | 0 | 68.4% | 5.0 | 116.4s | 125 | 95 | $0.04357 |

> 编排子任务：**25/39** 成功（来自 `subtask_completed` / `subtask_failed` 事件）。

### 1.3 失败原因分类

| 原因 | 次数 |
|---|---|
| `MODEL_ERROR` | 10 |
| `tokenBudget` | 3 |
| `maxSteps` | 2 |
| `totalTimeout` | 2 |
| `maxToolCalls` | 2 |
| `RUN_INTERRUPTED` | 1 |

**工具级失败码（Top 10）**

| 错误码 | 次数 |
|---|---|
| `INVALID_ARGS` | 180 |
| `DISABLED` | 116 |
| `NOT_FOUND` | 10 |
| `PATH_NOT_FOUND` | 9 |
| `HTTP_ERROR` | 5 |
| `READ_ERROR` | 4 |
| `NETWORK_ERROR` | 4 |
| `TIMEOUT` | 3 |
| `APPROVAL_DENIED` | 3 |
| `SANDBOX_CHECK_FAILED` | 2 |

**结构化错误报告累计**：1 条（`runtime_error` 事件；明细见 `data/errors.log` 与 `GET /api/errors`）。

### 1.4 任务明细（最近 20 条）

| 时间 | Agent | 状态 | 目标 | 步/模型/工具 | 耗时 | tokens | 成本 | 结果摘要 |
|---|---|---|---|---|---|---|---|---|
| 10-20 10:34 | orchestrator | ✅ | 你前面出现的运行错误你可以看到吗    | 1/1/0 | 17.2s | 7875 | $0.00105 | 能看到**一部分**，但性质要说清：我看到的是被写进对话历史的错误文本，不是真正 |
| 10-20 10:30 | orchestrator | ✅ | 继续   | 10/10/14 | 99.6s | 168153 | $0.00839 | ## 最重要结论：记账网页其实已经做好了，而且能跑  先纠正我前几轮的错误——我 |
| 10-20 10:26 | orchestrator | ❌ maxSteps | 继续   | 6/6/6 | 91.4s | 41203 | $0.00341 | 达到最大步骤数 6 |
| 10-20 08:25 | orchestrator | ❌ MODEL_ERROR | 那你开始吧   | 10/10/17 | 119.3s | 143883 | $0.00466 | 模型调用失败: OpenAIProvider(流式) 返回 400: {"err |
| 10-20 08:23 | orchestrator | ✅ | 啥情况，你总结一下前面你都干什么了   | 6/6/6 | 59.2s | 57155 | $0.00307 | 本次只做了两件事：一次目录清点、一次只读代码审计，两者都成功返回（confide |
| 10-20 08:09 | orchestrator | ✅ | 继续  | 7/7/7 | 662.4s | 52655 | $0.00199 | 本轮**没有产出任何可用成果**：仓库状态未确认、index.html 不存在。 |
| 10-20 07:54 | orchestrator | ❌ MODEL_ERROR | 继续  | 15/15/27 | 486.4s | 136735 | $0.00512 | 模型调用失败: OpenAIProvider(流式) 返回 400: {"err |
| 10-20 07:46 | orchestrator | ❌ totalTimeout | 帮我搞一个html，要可爱风格的记账界面  | 2/2/2 | 197.8s | 10667 | $0.00094 | 超过总任务超时 120000ms |
| 10-19 11:36 | codebase(mock) | ✅ | g | 4/4/3 | 20ms | 387 | $0.00000 | 【Codebase 分析完成】 目标：g 1) 通过 search_files  |
| 10-19 11:36 | research(mock) | ✅ | g | 4/4/3 | 14ms | 353 | $0.00000 | 【Research 报告】（基于 MOCK 离线资料，非实时联网） 目标：g 已 |
| 10-19 11:36 | research(mock) | ✅ | 比较两个打包器 | 4/4/3 | 1.1s | 545 | $0.00000 | 【Research 报告】（基于 MOCK 离线资料，非实时联网） 目标：比较两 |
| 10-19 11:31 | codebase(mock) | ✅ | g | 4/4/3 | 16ms | 387 | $0.00000 | 【Codebase 分析完成】 目标：g 1) 通过 search_files  |
| 10-19 11:31 | research(mock) | ✅ | g | 4/4/3 | 16ms | 353 | $0.00000 | 【Research 报告】（基于 MOCK 离线资料，非实时联网） 目标：g 已 |
| 10-19 11:31 | research(mock) | ✅ | 比较两个打包器 | 4/4/3 | 1.2s | 545 | $0.00000 | 【Research 报告】（基于 MOCK 离线资料，非实时联网） 目标：比较两 |
| 10-19 08:23 | codebase(mock) | ✅ | g | 4/4/3 | 19ms | 363 | $0.00000 | 【Codebase 分析完成】 目标：g 1) 通过 search_files  |
| 10-19 08:23 | research(mock) | ✅ | g | 4/4/3 | 13ms | 329 | $0.00000 | 【Research 报告】（基于 MOCK 离线资料，非实时联网） 目标：g 已 |
| 10-19 08:23 | research(mock) | ✅ | 比较两个打包器 | 4/4/3 | 1.1s | 521 | $0.00000 | 【Research 报告】（基于 MOCK 离线资料，非实时联网） 目标：比较两 |
| 10-19 07:13 | codebase(mock) | ✅ | g | 4/4/3 | 16ms | 363 | $0.00000 | 【Codebase 分析完成】 目标：g 1) 通过 search_files  |
| 10-19 07:13 | research(mock) | ✅ | g | 4/4/3 | 14ms | 329 | $0.00000 | 【Research 报告】（基于 MOCK 离线资料，非实时联网） 目标：g 已 |
| 10-19 07:13 | research(mock) | ✅ | 比较两个打包器 | 4/4/3 | 1.1s | 521 | $0.00000 | 【Research 报告】（基于 MOCK 离线资料，非实时联网） 目标：比较两 |

## 2. 行为过程报告（典型样本逐帧）

### 2.1 成功样本 · `orchestrator` · 10 步 / 99.6s

**目标**：继续



`+0.0s` 🏁 started 
`+0.0s` 🧠 第 1 轮推理（openai）
`+2.4s` 　└ 完成 2355ms · 2 个工具决策 · 5071 tok · tool_use
　　　🔧 调用 list_files({"maxDepth":"4","limit":"200"})
　　　🔧 调用 dir_stats({"dir":".","maxDepth":"4","topN":"10"})
　　　✅ list_files 2ms
　　　✅ dir_stats 1ms
`+2.4s` 🧠 第 2 轮推理（openai）
`+7.1s` 　└ 完成 4736ms · 1 个工具决策 · 6167 tok · tool_use
　　　🔧 调用 delegate_subtasks({"subtasks":["specId=code-audit; objective=审计仓库根目录 app.js（30…)
　　　❌ delegate_subtasks [INVALID_ARGS] 参数校验失败: subtasks.0: Expected object, received string; subtasks.1: Expected objec…
`+7.1s` 🧠 第 3 轮推理（openai）
`+8.8s` 　└ 完成 1750ms · 1 个工具决策 · 6711 tok · tool_use
　　　🔧 调用 delegate_subtasks({"subtasks":[{"specId":"code-audit","objective":"审计仓库根目录 app…)
　　　❌ delegate_subtasks [INVALID_ARGS] 参数校验失败: subtasks.0.inputs.files: Expected string, received array; subtasks.1.inp…
`+8.8s` 🧠 第 4 轮推理（openai）
`+11.2s` 　└ 完成 2351ms · 1 个工具决策 · 7261 tok · tool_use
　　　🔧 调用 delegate_subtasks({"subtasks":[{"boundary":"只读；只分析 app.js；不修改任何文件、不执行命令；必须给 文件…)
　　…（省略其余事件，共 176 条）

**结论**：## 最重要结论：记账网页其实已经做好了，而且能跑  先纠正我前几轮的错误——我之前反复说「仓库是空目录，list_files 返回 0 文件」，**这是错的**。本轮实测仓库有 5 个文件、43.8KB：`app.js`（30KB / 882 行）、`styles.css`（11KB / 627 行）、`index.html`（83 行）、`tsconfig.json`、`tsc-placeho

### 2.2 失败样本 · `orchestrator` · limit_reached (maxSteps)

**目标**：继续



`+0.0s` 🏁 started 
`+0.0s` 🧠 第 1 轮推理（openai）
`+3.6s` 　└ 完成 3616ms · 1 个工具决策 · 4279 tok · tool_use
　　　🔧 调用 delegate_subtasks({"subtasks":["specId=dir-inventory; objective=确认仓库根目录当前是否为空目…)
　　　❌ delegate_subtasks [INVALID_ARGS] 参数校验失败: subtasks.0: Expected object, received string。正确示例: {"subtasks":[{"specId…
`+3.6s` 🧠 第 2 轮推理（openai）
`+4.7s` 　└ 完成 1073ms · 1 个工具决策 · 4537 tok · tool_use
　　　🔧 调用 delegate_subtasks({"subtasks":[{"specId":"dir-inventory","objective":"确认仓库根目录当…)
　　🧩 子 Agent dir-inventory：确认仓库根目录当前是否为空目录，以及已存在哪些文件（若有）
`+4.7s` 🧠 第 1 轮推理（dir-inventory/openai）
`+5.8s` 　└ 完成 1085ms · 2 个工具决策 · 1475 tok · tool_use
　　　✅ dir_stats 1ms
　　　✅ list_files 1ms
`+5.8s` 🧠 第 2 轮推理（dir-inventory/openai）
　　…（省略其余事件，共 182 条）

**失败原因**：达到最大步骤数 6 ／ 触发限制：maxSteps

## 3. 能力边界实况（实测数字 + 未验证项）

| Agent | 现在能做什么 | 实测表现 | 还没验证 / 做不到 |
|---|---|---|---|
**codebase**,读代码、搜索、受限测试（白名单）；跨文件定位与解释,任务 148 次 · 成功率 91.2% · 平均 2.2s,真实 `run_tests` 默认关闭；不能改代码
**research**,检索资料、抓取网页、提取证据、比对来源,任务 221 次 · 成功率 100.0% · 平均 540ms,`web_search` 默认 OFFLINE_MOCK（非实时）；真实 Serper 未验证
**misc**,只读清点 / 定位 / 小文件解释；结构化上报,任务 13 次 · 成功率 92.3% · 平均 13.5s,无写权限（刻意）；超范围只上报不改派
**orchestrator**,拆分成独立子任务并行派发 → 汇总核验,任务 19 次 · 成功率 68.4% · 平均 116.4s,深度 ≤1；真实并行收益未与串行基线 A/B 对比

> 子 Agent 契约（4 个）：`dir-inventory`(8 步/60000 tok)、`code-audit`(12 步/120000 tok)、`doc-research`(8 步/80000 tok)、`code-edit`(12 步/120000 tok)

## 4. 调参效果对比（按「模型 + 参数指纹」分组）

| 模型 ｜ 参数 | 任务数 | 成功率 | 平均耗时 | 平均 tokens | 平均成本 | 平均步数 |
|---|---|---|---|---|---|---|
| mock ｜ 默认参数 | 332 | 99.7% | 340ms | 404 | $0.00000 | 4.0 |
| 未知模型 ｜ 默认参数 | 30 | 56.7% | 8.4s | 23630 | $0.01789 | 3.5 |
| deepseek-flash ｜ {"temperature":1} | 17 | 76.5% | 106.5s | 32107 | $0.00166 | 4.3 |
| deepseek-flash ｜ {"temperature":1.5,"reasoningEffort":"low"} | 14 | 92.9% | 15.5s | 22495 | $0.00120 | 2.9 |
| deepseek-flash ｜ {"temperature":1.5,"presencePenalty":-2,"reasoningEffort":"high"} | 2 | 100.0% | 58.4s | 88014 | $0.00472 | 5.5 |
| 未知模型 ｜ {"maxTokens":1200,"thinking":"enabled","reasoningEffort":"low"} | 2 | 100.0% | 2.3s | 1759 | $0.00013 | 2.0 |
| deepseek-flash ｜ {"temperature":0,"reasoningEffort":"low"} | 2 | 50.0% | 110.7s | 57665 | $0.00263 | 6.0 |
| deepseek-flash ｜ {"temperature":1,"reasoningEffort":"low"} | 2 | 100.0% | 45.3s | 71511 | $0.00338 | 7.5 |

---

## 附：这份报告怎么用

1. **看环比**（§0）：任务数/成功率/成本是否在变好；异常波动从这里开始查。
2. **看失败分类**（§1.3）：某类错误码突然变多 → 去 `docs/ERROR_REPORTING.md` 的错误码表对照处理。
3. **看行为样本**（§2）：判断"它是不是在瞎试"——工具调用是否收敛、有没有反复重试同一动作。
4. **看能力实况**（§3）：哪些 Agent 有实测数据、哪些还是空白 —— 空白就是下一步该补的验证。
5. **看调参对比**（§4）：同任务不同参数的效果/成本差异，直接支撑"该怎么调"。

> 历史快照：`reports/history/agent-YYYY-MM-DD.json`（每天一份指标快照，供环比与趋势分析；当前保留 9 份）。
