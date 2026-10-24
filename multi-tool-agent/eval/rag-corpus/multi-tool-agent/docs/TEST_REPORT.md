# 测试报告（TEST_REPORT）

> 本报告记录**真实运行结果**，未编造任何通过数 / 指标 / 模型效果。
> 运行命令：`node --import tsx --test "tests/*.test.ts"`
> 运行器：Node 内置 `node:test` + `tsx`（TS 加载器）。
> 运行环境：Windows，系统 Node v24.14.1（`D:\Program Files\nodejs`），`better-sqlite3` 已按 v24 重建，`tsx` 4.23.15。
>
> ⚠️ **本文档的逐场景明细停在「场景 1–24」（2026-10-13 快照，§1 汇总的「24 文件 / 136 子测试」即当时口径）**。其中 19–24 各行的结论仍有效，但**当前规模已不是这个数**：2026-10-19 实跑为 **50 个场景文件 / 334 个子测试（334 通过 / 0 跳过 / 0 失败，约 15~40s（Docker 冷/热缓存差异）；Docker 已启动，40j 真机阶梯通过）**。25 号之后的场景（25~50：知识系统、生命周期、错误聚合、重试预算、压缩、工具并行波、契约 lint、search_files 陷阱、M1 沙箱与审批、写工具、分类器、跑阶梯、**41 单 run 报告、42 写门禁接线、43~48 RAG/MCP/可观测/function calling/P2 估算/人机协同、49 异步执行、50 手动 L2 验证**）没有回填到本表——最新口径以 `reports/PROJECT_REPORT.md` §2 与 `npm test` 实测为准（逐次改动记在 `reports/CHANGELOG.md`）。
> ⚠️ 若改用其他 Node 主版本运行，`better-sqlite3` 会因 ABI 不匹配报 `ERR_DLOPEN_FAILED`，需先 `rm -rf node_modules/better-sqlite3/build` 再 `npm rebuild better-sqlite3`。这不是代码问题。

## 1. 汇总

| 指标 | 数值 |
| --- | --- |
| 场景文件（tests/*.test.ts） | 50 |
| 子测试（subtests） | 334 |
| 通过 | 334 |
| 失败 | 0 |
| 跳过 / TODO | 0 |
| 退出码 | 0 |

16 个原始要求场景全部覆盖且通过；新增场景 17（单次任务 API 覆盖 / 界面配置）、18（可视化监控检测模块）、19（实时流式展示 / Live View）、20（LLM 预设 / 生成参数 / Token 限制 / 测试连接）、21（杂项子 Agent / 任务分流）、22（多 Agent 编排）、23（子 Agent 契约文档）、24（错误检测与报告）同样通过。

**契约门禁（`npm run agents:lint`）**：① 契约自校验 0 issue ② 文档漂移 0 份（并已实测：手改一个字即报「文档与契约不一致」）③ 工具存在性通过。

**冒烟脚本（真实链路，非 Mock 断言）**

| 脚本 | 实测结果 |
| --- | --- |
| `npm run smoke:stream`（SSE 客户端） | 47 帧 / 23 个文本增量帧 / 484ms；「产生→推送」延迟 P50=P95=0ms、max=1.0ms → 通过 |
| `LLM_MODE=openai npm run smoke:llm`（真实 DeepSeek） | `completed`，4 steps / 4 次模型调用 / 3 次工具调用，3697ms；159 个流式增量帧（思考 141 字 + 正文 256 字）；prompt 3430（缓存命中 2432）/ completion 301 → 通过 |

真实 LLM 的一次完整 HTTP 验证（2026-10-13）：`/api/llm/test` 返回 200 + 真实模型清单 `[deepseek-flash, deepseek-v4-pro]`（132ms）；错误 Key 返回 502 且提示「鉴权失败（HTTP 401）…」；参数越界返回 400；未知预设返回 400 并列出可选项；真实任务回显 `droppedParams: ["temperature"]`（思考模式下被忽略）。

## 2. 各场景真实结论

| # | 场景（要求） | 子测试 | 结果 |
| --- | --- | --- | --- |
| 1 | 模型调用一个工具，收到结果后返回最终答案 | 模型调用一个工具，收到结果后返回最终答案 | ✅ |
| 2 | 多工具调用（顺序 / 并行） | 2a) 连续调用多个工具（顺序）；2b) 一次响应多个工具调用（并行执行并分别记录） | ✅ |
| 3 | 根据工具结果选择下一步（反应式） | 模型根据第一个工具的结果选择第二个工具 | ✅ |
| 4 | 未知工具被拒绝且不执行 | 模型返回不存在的工具：被拒绝并反馈错误（不执行） | ✅ |
| 5 | 参数不符合 Schema 被拒绝 | 工具参数不符合 Schema：被拒绝并反馈 INVALID_ARGS | ✅ |
| 6 | 工具超时统一处理 | 工具执行超时由 Registry 统一处理为 TIMEOUT | ✅ |
| 7 | 异常规范化 / 受控恢复 | 7a) 异常规范化为 EXECUTION_ERROR（默认不可重试）；7b) 失败结果后 Runtime 受控恢复并继续 | ✅ |
| 8 | 最大步骤限制 | 模型无限请求工具时触发最大步骤限制 | ✅ |
| 9 | 预算限制（模型 / 工具调用） | 9a) 达到最大模型调用次数停止；9b) 达到最大工具调用次数停止 | ✅ |
| 10 | 用户取消 | 用户主动取消任务 | ✅ |
| 11 | 事件顺序持久化 | 执行事件按正确顺序持久化 | ✅ |
| 12 | 检查点恢复 | 从有效检查点恢复任务 | ✅ |
| 13 | 非法状态转换被拒绝 | 13a) 状态机拒绝非法转换；13b) 仅 failed/limit_reached 可恢复；13c) Runtime 拒绝恢复已完成任务 | ✅ |
| 14 | 仓库工具无法访问允许目录之外 | 14a) assertInsideRepo 拒绝路径穿越；14b) read_file 经 Registry 拒绝跳出仓库；14c) read_file 拒绝敏感文件 | ✅ |
| 15 | 网页工具拒绝不允许目标与危险重定向 | 15a) checkUrl 拒绝私网/危险目标；15b) fetch_page 拒绝 SSRF 目标；15c) 拒绝非白名单域名；15d) 拒绝重定向到云元数据；15e) 拒绝重定向到 localhost | ✅ |
| 16 | 不可信网页指令不能覆盖 Runtime 权限策略 | 含不可信指令的网页无法使 Runtime 越权执行 | ✅ |
| 17 | **单次任务 API 覆盖**（界面配置 API） | 17a~17e) `createProvider` 覆盖优先级与「无 Key 不静默降级」；17f~17l) `validateRunRequest` 校验；17m~17p) HTTP 层 `GET /api/config` 不泄漏 Key、openai/serper 无 Key 返回 400、mock 可正常创建 | ✅ |
| 18 | **可视化监控检测模块** | 18a) Tracer 精确计时；18b) 聚合出 run/llm/tool/answer span；18c) model_completed 记录推理耗时与决策；18d) 工具失败 span 记录错误码；18e) 异步缓冲后事件可读；18f) TraceSpan 结构 | ✅ |
| 24 | **错误检测与报告** | 24a) 从栈解析项目内位置（过滤 node_modules）；24b) 报告四要素齐全 + 密钥脱敏 + JSONL 落盘；24c) 非 Error 值（字符串/undefined）也能报告 + 过滤查询；24d) 执行循环异常 → 落 failed；24e) **enqueue 路径异常不再产生 unhandledRejection、任务不卡死**（带位置与码）；24f) 路径解析四形态 + 越权/不存在的区分度 + 词法模式；24g) `/api/errors` 查询 + `/api/client-errors` 浏览器上报（位置可解析）；24h) 未知路由不崩服务；24i) `runtime_error` 进入事件流；24j~24l) 输出结构宽容归一化（字符串数组 → 对象；来源缺失如实计入 unresolved） | ✅ |
| 23 | **子 Agent 契约文档规范** | 23a) 渲染确定性（逐字节一致、无时间戳）23b) 契约卡九节覆盖 23c) 协作总则含角色/调用格式/宽度深度/采信规则 23d) 磁盘文档与契约一致（漂移门禁）23e) 生成物不含密钥 23f) 任意 spec 均可渲染（含最小 spec）23g) npm 脚本已登记 | ✅ |
| 22 | **多 Agent 编排** | 22a~22b) 规则式预筛（按目录/主题分区、去重、宽度上限、提取主题/列举目录）22c~22d) 契约校验（内置 0 error；能抓出权限超集/工具未注册/缺上报工具）22e~22g) 三维守卫（宽度超限 `WIDTH_LIMIT`、深度=1 由"不注入派发能力"保证、未知规格 `UNKNOWN_SPEC`）22h) 并行执行（顺序稳定=派发顺序、各自工具池、结构化上报带证据）22i) 部分失败显式化（Runtime 统计覆盖模型自报、自动补 unresolved）22j) 契约未履行标注 `contractViolation`22k) 并发池（有界、顺序稳定、异常转结果、级联取消、并行度受预算约束）22l) 父子 trace（subtask span 挂父 run、子调用挂 subtask）22m) 汇总归一化与统计口径 22n~22o) 上报工具业务校验（证据强制 / 升级人工必须写未解决项）22p) 请求校验（工作区、规格白名单、宽度只收紧）22q) HTTP 端到端（汇总报告 + 子任务明细 + 契约目录 + trace span）22r) task-router 预筛建议 | ✅ |
| 21 | **杂项子 Agent（misc）/ 任务分流** | 21a~21b) 分流器（琐事→misc、改码→codebase、调研→research；无信号时低置信度试探；`allowMisc=0`；危险动作提示）；21c) 工具池只含 5 个只读/提交工具；21d~21e) 越权请求 `run_tests`/`web_search` 被 `PERMISSION_DENIED`（未执行）；21f) 终结性工具 `submit_result` 成功后立即结束（不多跑模型）+ `misc_report_submitted` 事件；21g) 未提交时回退为正文且 `structured=false`；21h) `escalateTo` 必须带理由，合法时保留改派信息；21i) 预算「只能收紧不能放宽」（请求 999 步被压到硬上限并触发 `limit_reached`）；21j) `dir_stats` 真实统计 + 路径越界拒绝；21j2) `submit_result` 的 schema 与业务校验；21k) `validateRunRequest` 的 misc 校验；21l) HTTP 端到端（结构化结论 + `miscLimits` 回显 + 落库读回）；21m) `/api/task-router` 接口 | ✅ |
| 20 | **LLM 预设 / 生成参数 / Token 限制** | 20a~20g) 参数装配（只发显式字段、全量映射、思考模式剔除采样参数、模型 ignoredParams、extra 保护键、请求体 stream/tools、单次请求覆盖默认）；20h~20j) 费用估算（表价含缓存价 / 无表价退化 / usage 归一化）；20k~20l) 参数校验（合法规范化、越界与枚举报错、extra 拦截）；20m~20o) `validateRunRequest`（参数保留、未知预设拒绝、token/费用预算）；20p~20t) 预设解析与 createProvider（优先级、DeepSeek 默认、custom 缺 BaseUrl 报错、Ollama 免 Key、droppedParams、Mock 标注不生效）；20u~20y) `/api/llm/presets` 不泄漏 Key、`checkLlmTestTarget` SSRF 白名单、`/api/llm/test` 拦截与 200/401/404 分支、BaseUrl 规范化；20z) 预设目录一致性 | ✅ |
| 19 | **实时流式展示（Live View）** | 19a) Mock 分片顺序与拼接一致；19b) `llm_delta` 只走实时通道不落盘且持久化 seq 仍严格连续；19c) 聚合预览随 model_completed 落盘；19d) 关闭流式时零增量（零开销）；19e) OpenAI 流式聚合纯函数（reasoning/content/tool_call 分片）；19f) LiveHub 按 runId 隔离与退订；19g) SSE 端到端（元信息 + 实时增量 + `run_end`）；19h) 断线续传只回放缺失事件；19i) 任务结束后连接 SSE 走纯回放并正确收尾 | ✅ |

## 3. 关键安全断言（已验证）

- **未知工具**：返回 `UNKNOWN_TOOL`，工具逻辑不执行。
- **权限越权**：research 任务请求 `run_tests`（需 `codebase:test`，不在其权限集）→ `PERMISSION_DENIED`，危险命令 **不执行**（场景 16）。
- **路径穿越**：`read_file` 对 `../../package.json`、绝对越权路径均被拒，错误信息含「路径越权 / 不在仓库根目录内」（场景 14）。
- **SSRF**：`fetch_page` 对 `http://127.0.0.1`、`http://169.254.169.254/latest/meta-data/`、`file://`、`ftp://`、内网域名、非白名单域名均 `SSRF_BLOCKED`；重定向到云元数据 / localhost 也被拦截（场景 15）。
- **状态机**：`completed → running`、`queued → completed` 等非法转换被拒；`resume` 对已完成任务抛错。
- **API Key 不泄漏**：`GET /api/config` 响应中不含任何 Key 字段；选 `openai`/`serper` 但无 Key 时返回 400 明确错误而非静默降级（场景 17）。
- **不发真实网络请求**：场景 17 全部通过纯函数 / mock 路径验证，测试套件不调用任何真实 LLM / 搜索 API。

## 4. 运行方式（可复现）

```bash
npm test
# 等价于：node --import tsx --test "tests/*.test.ts"

# 实时流式链路冒烟（真实 HTTP + SSE，打印每帧明细与延迟统计）
npm run smoke:stream
```

原始 TAP 输出保存在 `tests/run-report.raw.txt`（本次运行产物，可能被下次运行覆盖；提交时建议重新生成或纳入 CI）。

## 5. 未覆盖 / 待补（诚实说明）

- **真实 LLM 集成测试未纳入 `npm test`**：测试套件刻意不发真实请求（保持零成本、可离线跑）；DeepSeek 的真实链路改由 `npm run smoke:llm` 与手工 HTTP 验证覆盖（结果见上）。其它服务商预设仍未实测。
- **费用/表价为估算**：按预设里的价目表计算，价格会变动，未与供应商账单核对。
- **真实联网搜索（Serper）**无 Key，未纳入集成测试。
- **`fetch_page` 真实网络**仅通过 mock `fetch` 验证 SSRF / 重定向逻辑；无真实站点集成测试。
- **多客户端并发订阅同一个 run** 未覆盖（当前实现不区分订阅者）。
- 以上各项在 Mock 路径下被完整覆盖，但「真实 API」路径仅编码、未端到端验证（详见 ARCHITECTURE.md §7、STREAMING_LIVE_VIEW.md §8）。
