# 架构与模块职责（ARCHITECTURE）

> 本文档描述 MVP 的实际实现。所有「未验证 / 未完成」项在 §7 显式标注。

## 1. 总体架构

```
                   ┌─────────────────────────────────────────────┐
   HTTP / SSE      │                 AgentRuntime                 │
  ───────────────► │  (共享 Agent Loop: 预算/权限/超时/检查点/状态) │
   POST /api/runs  │                                             │
   GET  /api/runs  │   ┌──────────┐   ┌────────────┐  ┌────────┐ │
   SSE /stream     │   │  LLM     │   │ Tool       │  │ Store  │ │
                   │   │ Provider │──►│ Registry   │─►│SQLite  │ │
                   │   │(Mock/OpenAI)│ │(安全边界)  │  │        │ │
                   │   └──────────┘   └─────┬──────┘  └────────┘ │
                   │        ▲               │ execute           │
                   │        │ tool_calls    ▼                    │
                   │   ┌──────────────────────────┐  ┌────────┐ │
                   │   │ two agents' tools        │  │Event  │ │
                   │   │ codebase/* research/*     │  │Logger │ │
                   │   └──────────────────────────┘  └────────┘ │
                   └─────────────────────────────────────────────┘
```

**两种 Agent 通过「同一段 `loopBody`」驱动**，区别仅在于：
- 注入的 `allowedTools` / `allowedPermissions` 不同（由 `runType` 决定）；
- `LLMProvider` 返回的剧本/真实回复不同；
- 工具实现集合不同（但都经同一个 `ToolRegistry` 执行）。

## 2. 模块职责

### 2.1 `src/runtime/AgentRuntime.ts`（核心）
- `createRun`：建记录、`queued`，并缓存该 run 的 Provider（用于同进程恢复）。
- `run`：同步 await 完成（测试 / 演示用）。
- `enqueue`：后台 fire-and-forget（HTTP 层用）。
- `cancel`：触发 `AbortController.abort()`（尽力而为）。
- `resume`：仅 `failed` / `limit_reached` 可恢复；重建预算、放宽限制、从检查点续跑。
- `loopBody`：每一步依次做 **取消检查 → 步骤上限 → 总超时 → 模型预算 → 工具预算 → 调用 LLM → 记录用量 → 工具调用 → 检查点**；终态判定 `end_turn` 或无工具调用即 `completed`。
- 私有助手：`resolveAllowedTools`（按 runType 限定工具池 + 入参白名单二次过滤）、`resolvePermissions`（由工具名推导权限集合）、`buildBudget`、`saveCheckpoint`。

### 2.2 `src/runtime/StateMachine.ts`
- `canTransition` / `assertTransition`：合法转换表。
- `RESUMABLE = ['failed','limit_reached']`。
- 合法转换：`queued→running`；`running/waiting_tool → {completed,failed,cancelled,limit_reached,awaiting_user}`；`waiting_tool→running`；`failed/limit_reached→running`（恢复）；`awaiting_user→cancelled`（人工取消）。`completed` / `cancelled` 为终态不可再转。

### 2.3 `src/runtime/Budget.ts`
- 跟踪 `steps / modelCalls / toolCalls / tokens / cost / wall-clock`。
- 方法：`enterStep`（步骤上限）、`checkPreModelCall`、`checkPreToolCall`、`checkToken`、`checkCost`、`checkTimeout`。
- 用量（token / cost）在 Mock 下为**明确标注的估算**（`isEstimate=true`），真实 LLM 下由 Provider 返回实际值（未验证）。

### 2.4 `src/tools/Registry.ts`（安全边界，见 §4）
- `execute` 强制顺序：未知工具 → 权限 → 参数 Schema → 超时/异常规范化 → 有限重试（仅 `safe` 且 `retryable`）。
- `toDefinitionsFor(allowed)`：仅向模型暴露白名单内工具定义。

### 2.5 `src/llm/`
- `MockProvider`：按 `MockResponder(ctx)→MockStep` 返回剧本；估算 token；支持按 `onDelta` 分片流式。
- `OpenAIProvider`：OpenAI 兼容，raw `fetch`，无 SDK 耦合；支持 `stream:true` 的 SSE 解析与生成参数透传。**DeepSeek 走该路径已真实验证**；其它服务商未实测。
- `scenarios.ts`：演示剧本（codebase / research），按上下文（上一步结果）决定下一步动作。
- `index.ts`：`createProvider(config, input)` → `{provider, isMock, resolved}`。`resolved` 回显实际生效的预设/模型/baseUrl/参数与**被忽略的参数**（不含 Key）。**覆盖优先级**：`input.llm.*`（前端面板）> 显式配置的 `OPENAI_*` 环境变量 > 预设默认值；Key 为 `input > config.llm/api > 预设对应环境变量 > OPENAI_API_KEY`。显式选真实模式但无 Key（且预设非 `keyOptional`）时**抛错**，不静默降级为 Mock。

### 2.5b `src/server.ts` 的请求校验（`validateRunRequest`）
- 纯函数，集中做「服务端不信任前端」的校验：`runType`/`goal`/预算数值、`repoPath` 存在性与绝对化、LLM 与搜索的 Key 前置校验。
- 选择 `openai` 或 `serper` 但无 Key → 返回 400 明确错误。
- `GET /api/config` 只返回**非敏感**信息（`hasOpenAIKey` 等布尔值、BaseUrl、Model），**绝不回传 Key**。
- Key 的处理路径：请求体 → `RunInput.llm` / `RunInput.search` → Provider / `ToolRuntimeConfig`。**不写入 `runs` 表、不写入事件**（EventLogger 另有脱敏兜底）。

### 2.5b3 `src/tools/misc/*` + `src/runtime/router.ts`（杂项子 Agent）
- `dir_stats`：只读目录清点（文件数/总大小/扩展名分布/最大文件）；边界=忽略 `EXCLUDED_DIRS`、不跟随符号链接、敏感文件只计数不记名、`scanLimit` 上限并回报 `truncated`。
- `submit_result`：**终结性工具**（`Tool.terminal=true`）——成功即结束任务，返回结构化 `MiscReport`；含业务校验（填了 `escalateTo` 必须给 `escalateReason`）。
- `router.ts`：`classifyTask(goal)` 规则式分流（纯函数、不调 LLM、返回置信度/理由/信号词），供 `GET /api/task-router` 与界面「自动分流/一键改派」使用。
- Runtime 侧：`resolveAllowedTools` 为 misc 返回只读池（无 `run_tests`/`web_search`/写工具）；`resolveLimits` 对 misc 用更小默认值且**只能收紧不能放宽**（`hardMaxSteps` 兜底）；`loopBody` 检测终结性工具成功后直接 `finalize`，并把 `MiscReport` 写入 `runs.resultJson`；未调用 `submit_result` 时回退为「正文 + `structured=false`」。
- 详见 `docs/MISC_AGENT.md`。

### 2.5b5 `src/runtime/errorReporter.ts` + `src/tools/shared/*`（错误报告与宽容契约）
- `ErrorReporter`：结构化报告（id/位置/类型/码/消息/上下文/栈 + 排查建议），三落点 = `runtime_error` 事件 / `data/errors.log`(JSONL) / `GET /api/errors`；`parseErrorLocation` 从栈里取第一处项目内帧。
- 兜底：`AgentRuntime` 对 `run()`/`enqueue()` 的未预期异常显式 catch（此前 `.finally()` 会吞掉 rejection → 任务永远停在 running）；server 有错误中间件 + 进程级 `unhandledRejection`/`uncaughtException`；前端 `window.onerror`/`unhandledrejection` → `POST /api/client-errors`。
- `tools/shared/workspacePath.ts`：工作区路径宽容解析（相对仓库根/工作区相对/绝对；越界与不存在区分，失败给可用条目）。
- `tools/shared/reportNormalize.ts`：上报结构宽容归一化（数组元素可为字符串；来源缺失如实计入 unresolved）。
- 详见 `docs/ERROR_REPORTING.md`。

### 2.5b4 `src/agents/*` + `src/runtime/{preSplit,SubAgentPool,subAgentLoop}.ts`（多 Agent 编排）
- `agents/specs.ts`：**子 Agent 契约（唯一事实来源）**——职责/notDo/工具白名单/权限/预算/上报 schema/模型参数；`validateSpecs` 装配期强校验（工具已注册、权限**不多不少**、必须有终结性上报工具、预算合法），`agents/*.md` 由 `renderDocs.ts` 从同一份契约**生成**，`npm run agents:lint` 做漂移门禁。
- `runtime/preSplit.ts`：规则式预筛（按目录/主题切候选子任务，零 token、可解释、可单测）。
- `runtime/SubAgentPool.ts`：有界并发池（结果顺序=入参顺序）+ 级联取消 + 单任务异常转结果；`effectiveConcurrency` 按配置与剩余预算下调并行度。
- `runtime/subAgentLoop.ts`：子 Agent 独立循环（独立 messages/预算/权限；**不注入 spawnSubAgent** → 结构上无法再委派）；终结性工具 `submit_finding` 成功即结束；未调用则标注 `contractViolation`。
- `tools/orchestrator/*`：`delegate_subtasks`（三道结构层守卫：宽度/能力注入/规格白名单 + 结果裁剪 + 批次回调）、`submit_orchestration`（汇总，终结性）、`submit_finding`（子 Agent 上报，evidence/confidence 业务校验）。
- 详见 `designs/multi-tool-agent-harness-design-v1.md`。

### 2.5b2 `src/llm/presets.ts` + `params.ts` + `testConnection.ts`（LLM 可选式配置）
- `presets.ts`：Provider 预设目录（`deepseek` 优先，含 baseUrl / 模型清单 / Key 环境变量名 / 表价 `pricing` / 能力开关 / `ignoredParams`）与参数元数据 `PARAM_META`（范围、默认、说明文案）；`sanitizeParamsForModel` 负责「该模型不支持 / 思考模式下无效」的参数剔除，并返回被丢弃的键供界面诚实提示。
- `params.ts`：`parseGenerationParams` 纯函数——范围校验（越界**直接报错**而非静默改值）、枚举校验、`extra` 保护键拦截。
- `testConnection.ts`：`checkLlmTestTarget`（SSRF 白名单：允许公网+回环，禁止云元数据/私网）、`testLlmConnection`（先 `GET /models`，404/405 时可退化为一次最小 `chat/completions`；`fetch` 可注入以便单测）。
- `OpenAIProvider.buildRequestBody / buildParamsBody / estimateCost / toTokenUsage`：请求体装配与费用估算均为**纯函数**，可离线单测；参数未设置则**不发送**该字段（交给厂商默认值）。
- 优先级见 `docs/LLM_CONFIG.md` §2；DeepSeek 已用真实 API 端到端验证（含流式 `reasoning_content`）。

### 2.5c `src/trace/Tracer.ts`（可视化监控检测模块）
- `Tracer`：用 `performance.now()`（单调时钟）为 Agent Loop 节点精确计时；`start/finish` 生成成对 span 事件（携带 `spanId`/`kind`/`startTs`/`durationMs`/`status`/输入输出）；`emit` 透传非 span 事件。
- `buildTraceSnapshot(runId, status, events)`：纯函数，从事件流离线重建 span 列表 + 根 + 摘要，供前端流程图/瀑布图直接消费。
- 详见 `docs/TRACE_VISUALIZATION.md`。

### 2.5d `src/trace/EventLogger.ts`（双通道：异步批量落盘 + 实时推送）
- `emit(runId, type, data, {persist})`：**脱敏 → 实时通道 `onLive`（毫秒级）→ 持久化通道**（入内存队列 + `setImmediate` 调度批量事务写库）。`flush()` 把队列批量写入 `store.appendEvents`（单事务），避免在 Agent Loop 主循环里同步写库；`run()/enqueue()` 收尾时强制 flush。
- `persist:false` 产出**临时事件**：`seq=0` + `ephemeral=true`，只走实时通道、不落盘、不占持久化序号（保证持久化事件 `seq` 严格连续，见测试 11/19b）。用于高频文本增量 `llm_delta`。

### 2.5e `src/trace/LiveHub.ts`（实时事件分发 / SSE 快车道）
- 按 `runId` 维护订阅者集合；`publish` 为纯内存 O(订阅者数) 广播，订阅者异常被隔离；返回 `unsubscribe` 供连接断开时释放。
- 使 SSE 不必等待「批量落盘 + 轮询」，端到端「产生→推送」实测 P95 = 0ms（见 `docs/STREAMING_LIVE_VIEW.md` §6）。

### 2.5f 流式展示链路（`onDelta → llm_delta → SSE`）
- `LLMProvider.chat(req, onDelta?, signal?)`：可选增量回调 + 取消信号。`MockProvider` 把思考/正文按 `STREAM_CHUNK_CHARS` 分片（延迟可配，测试为 0）；`OpenAIProvider` 带 `stream:true` 走 SSE 解析（`accumulateOpenAIStreamChunk` 为可单测纯函数，**真实供应商未联调**）。
- `AgentRuntime.loopBody`：按 `input.stream.liveDeltas ?? config.stream.liveDeltas` 决定是否传入 `onDelta`；**关闭时不产生任何增量事件（零额外开销）**。同时把增量在内存聚合为 `reasoningPreview` / `contentPreview`（各 1200 字符上限）写入 `model_completed.outputs`，供断线/事后回看还原。
- `Tracer.delta` 按 `runId + spanId + channel` 缓冲约 24ms 再合并发送，并在 `model_completed` 前强制 flush；高频逐字帧不再一对一打穿 SSE 和浏览器主线程。前端跳过把 `llm_delta` 复制进事件流，事件节点上限 500，文本按新增片段追加，自动滚动 10fps 节流。
- `src/server.ts` SSE 端点三段式：① 先订阅 `LiveHub`（避免空窗）→ ② 同步回放持久化事件（支持 `Last-Event-ID` / `?fromSeq=`）→ ③ 心跳（15s）+ 看门狗（2s，补漏 + 终态收尾）；`ephemeral` 帧不写 `id:`，因此不参与断线续传。
- `GET /api/stream/stats` 暴露 `activeStreams / ephemeralEvents / pendingPersistence` 便于现场诊断。

### 2.5g `src/knowledge/*` + `src/mcp/*` + `src/observability/*`（RAG / MCP / 诊断）

- `src/knowledge/{chunking,embeddings,vectorIndex,hybrid,ragPipeline}.ts`：切块级 RAG（doc → chunk → embedding → BM25 + Flat/HNSW/IVF → RRF/加权融合 → rerank）。`KnowledgeHub` 懒构建并在写/删后失效；HTTP 路由 `/api/rag/*`。与既有 FTS5/vec0 的 `VectorRecall` 并存，不替换。
- `src/mcp/*`：MCP JSON-RPC server/client、stdio 与 Streamable HTTP transport、ToolRegistry 桥接（`mcp_` 前缀 + `mcp:call` 权限）。
- `src/observability/latency.ts`：单 run 慢回答诊断（wall/busy、sum/union、TTFT、token 热点），HTTP `GET /api/runs/:id/diagnosis`。
- 详细取舍与实测见 `docs/RAG_AND_AGENT_STACK.md` 与 `reports/RAG_EVAL.md`。

### 2.6 `src/tools/codebase/*`（Codebase Agent）
- `security.ts`：`assertInsideRepo`（路径穿越防护）、`EXCLUDED_DIRS`、`SENSITIVE_FILES` / `isSensitive`。
- `searchFiles` / `readFile` / `listFiles`：真实本地 I/O，受 `repoPath` 与敏感文件约束。
- `runTests`：受限白名单子进程（`shell:false`、`cwd=repoPath`、20s 超时、SIGTERM）。

### 2.7 `src/tools/research/*`（Research Agent）
- `ssrf.ts`：`checkUrl` 纯函数（localhost / 私网 / 云元数据 / 内网域名 / 白名单）。
- `fetchPage`：SSRF 校验 → 手动重定向并**重新校验** → 大小/超时/类型限制。
- `webSearch`：真实 Serper（需 Key，**未验证**）或 **OFFLINE_MOCK**（明确标注，绝不伪造实时结果）。
- `extractEvidence` / `compareSources`：来源保留的证据提取与结构化比较（supported / inferred / unknown）。

### 2.8 `src/store/SqliteStore.ts`
- 表：`runs` / `events` / `checkpoints`。
- 方法含 `createRun / getRun / updateRun / appendEvent / appendEvents(批量事务) / getEvents / saveCheckpoint / getLatestCheckpoint / listRuns / close`。
- 默认文件库（见 `.env` `SQLITE_PATH`）；演示用 `:memory:`。

### 2.9 `src/trace/EventLogger.ts`
- 每条 `TraceEvent` 含 `seq / timestamp / type / data`；自动脱敏（密钥正则）与超长截断。

## 3. 真实 Agent Loop 流程（一次完成的 codebase 任务）

1. `createRun` → `queued`；`run()` → `executeLoop` 置 `running`。
2. 构造 system prompt + user goal；`allowedTools=[search_files,read_file,list_files,run_tests]`。
3. Step1：调 Mock → `tool_use: search_files` → 预算/权限/参数校验通过 → 执行 → `tool_completed`。
4. Step2：`read_file(src/calc.js)` → 执行 → 完成。
5. Step3：`run_tests(node --test)`（白名单命中、`shell:false`）→ 真实子进程，6/6 通过 → 完成。
6. Step4：Mock 返回 `end_turn` → 终态 `completed`，写 `finalAnswer`。
7. 全程每步 `saveCheckpoint`；事件流写入 `events`。

（research 任务流程类似：`web_search`(OFFLINE_MOCK) → `extract_evidence` → `compare_sources` → `end_turn`。）

## 4. Tool Registry 安全边界（强制顺序）

`ToolRegistry.execute(name, args, ctx)` 每次都执行：

1. **未知工具** → `UNKNOWN_TOOL`（不执行任何逻辑）。
2. **权限不足**（`!ctx.allowedPermissions.includes(tool.permission)`）→ `PERMISSION_DENIED`。
3. **参数校验失败**（Zod `safeParse`）→ `INVALID_ARGS`。
4. **超时**（`withTimeout`，`tool.timeoutMs`）→ `TIMEOUT`（仅 `safe` 默认可重试）。
5. **取消**（`AbortError`）→ `CANCELLED`。
6. **其他异常** → `EXECUTION_ERROR`（`retryable:false`，避免放大副作用）。
7. 仅对 **`ok:false` 且 `retryable` 且 `riskLevel==='safe'`** 的工具有限重试（最多 `MAX_RETRY`）。

> 关键点：模型请求的工具，即便不在本次 `allowedTools` 白名单内（如 research 任务误请求 `run_tests`），也会在步骤 1/2 被拒绝；**工具自身无法绕过 Registry**。

## 5. 状态机与恢复

- 终态：`completed` / `cancelled`（不可恢复）；`awaiting_user`（等待用户回答，本次 run 不再推进）。
- 可恢复：`failed` / `limit_reached`（→ `running`）。
- `awaiting_user`：模型调用终结性工具 `ask_user` 后进入；问题落库到 `resultJson.awaitingUser`，事件为 `run_awaiting_user`。当前**不做**断点续跑，用户回答后提交新一轮任务（`contextHistory` 带上上一轮）。详见 `docs/HUMAN_IN_THE_LOOP.md`。
- `resume(runId, raiseLimits=true)`：
  - 校验 `RESUMABLE` 与存在检查点（无检查点则抛错）。
  - 同进程：复用缓存的 Provider（保留 Mock 剧本上下文）。
  - 跨进程：从 `config` 重建 Provider（**丢失原 Mock 剧本的上下文状态**——已知限制）。
  - 重建预算并基于检查点消息续跑；默认放宽 `maxModelCalls` / `maxSteps`。

## 6. 可观测性与 API

- REST：`GET /api/errors`（结构化错误报告查询）、`POST /api/client-errors`（浏览器错误上报）、`GET /api/agents/specs`（子 Agent 契约目录 + 自校验 issue，不含任何 Key）、`GET /api/task-router?goal=`（规则式分流建议 + 可选 `suggestedSubtasks` 预筛）、`POST /api/runs`（响应回显 `llm.resolved` 与 misc 的 `miscLimits`）、`GET /api/llm/presets`（预设+参数元数据，不含 Key）、`POST /api/llm/test`（真实连通性测试，带 SSRF 防护）、`GET /api/runs/:id`、`GET /api/runs/:id/events?fromSeq=&limit=`（增量拉取，响应头 `X-Next-Cursor`/`X-Remaining`）、`GET /api/runs/:id/trace`（聚合 span 快照）、`GET /api/stream/stats`（订阅数/临时事件数/待落盘队列）、`POST /api/runs/:id/cancel`、`POST /api/runs/:id/resume`、`GET /api/runs`、`GET /api/health`、`GET /api/config`（非敏感默认配置，含 `stream` 块）。
- SSE：`GET /api/runs/:id/stream` 实时推送 `TraceEvent`（span 事件含 `spanId`/`startTs`/`durationMs`；文本增量 `llm_delta` 为 `ephemeral` 帧）。支持 `Last-Event-ID` 断线续传、`?fromSeq=` 游标、`?debug=1` 与 `STREAM_DEBUG=1` 帧级日志；响应头含 `X-Accel-Buffering: no`。
- 前端：`public/index.html`（原生 JS 工作台，三个视图）——「实时」（思考逐字 + 工具卡片 + 调试面板）、「事件流」（原始持久化事件）、「流程监控」（流程图 + 瀑布图）；含「API 配置」面板。

## 7. 已知缺陷与未完成项（诚实清单）

> 以下均为**当前未实现或未验证**，非「已支持」。

1. **exactly-once 不保证**：工具可重复执行；取消为 best-effort；恢复会重放。详见 README §4。
2. **只有 DeepSeek 做了真实端到端验证**（2026-10-13）：其余预设（openai/qwen/moonshot/zhipu/ollama）代码路径相同但无 Key、未实测；模型清单与表价来自公开资料，可能过期。费用始终是**估算**（按预设表价，价格会变），真实账单以供应商为准。
3. **真实联网搜索未验证**：`serper` 路径已编码但无 Key；默认 `OFFLINE_MOCK` 明确标注为非实时。
4. **`fetch_page` 仅单元测试验证**：SSRF / 重定向逻辑通过 mock `fetch` 覆盖，无真实站点集成测试；真实网络错误/编码/压缩等边界未覆盖。
5. **检查点消息无截断**：超长多轮对话会持续增长内存与 SQLite 体积。
6. **HTTP API 无鉴权**：仅适合本地 / 内网；暴露在公网有风险。
7. **前端为极简原型**：无并发多任务管理、无历史对比、无鉴权、样式基础。
8. **`run_tests` 白名单按前缀匹配**：依赖 `shell:false` 兜底防注入；一旦改为 shell 执行即失效（当前不会）。
9. **并发模型**：`enqueue` 可并发；单进程共享 SQLite；无分布式锁 / 限流。
10. **无重试/死信/可观测仪表盘**：生产可观测性薄弱，仅事件流。
11. **前端传入的 API Key 走明文 HTTP**：本地 HTTP 无 TLS，浏览器→服务端之间 Key 为明文传输（不落库、不记日志，但传输层无保护）。
12. **跨进程 `resume` 丢失单次任务覆盖**：`rebuildInput` 只重建 `runType`/`goal`，因此跨进程恢复时前端传入的 `llm`/`search` 覆盖会丢失，回退到 `.env` 配置（同进程恢复不受影响，Provider 已缓存）。
13. **文本增量不持久化**：断线重连/事后回看只能拿到 `model_completed.outputs.{reasoningPreview,contentPreview}` 的聚合预览（各 1200 字符上限），无法逐字重放。
14. **杂项 Agent 无写能力（刻意）**：没有删除/重命名/写入工具，破坏性操作一律 `escalateTo=human`（缺快照与审批机制）。
15. **分流器是规则式的**：模糊目标可能被低置信度地默认交给 misc 试探，需要一次改派；未做跨 Agent 自动编排（仅建议 + 一键改派）。
16. **编排的两套循环并存**：主 Agent 用 `loopBody`（有检查点/恢复），子 Agent 用精简 `subAgentLoop`（不可恢复）——存在重复代码，合并路径见设计文档 §15（未知区 1）。
17. **子任务不独立落库**：只存 `runs.resultJson` 信封 + `events`；跨 run 查询子任务历史需另建 `subtasks` 表（未知区 2）。
18. **无独立模型裁判 / 无打转检测 / evidence 未绑定版本**：V 层目前是确定性断言 + 提示词约束（未知区 4~6）。
19. **SSE 无背压与多客户端差异化**：订阅者收到完全相同的事件流；客户端处理不过来时不做丢弃/限流；同域并发连接数受浏览器限制（HTTP/1.1 典型 6 条）。

## 8. 下一阶段 3 项优先功能（建议）

1. **真实 LLM + 真实搜索的端到端验证与评测**：补 Key 后跑通 `openai`/`serper`，并加「真实调用」集成测试（当前被 Mock 覆盖，需补充）。
2. **幂等与可恢复性增强**：工具调用去重 / 幂等键、exactly-once 努力（至少 at-least-once + 去重），并修复跨进程 resume 的 Provider 上下文丢失。
3. **生产化加固**：API 鉴权、检查点消息截断/压缩、并发限流与队列、真实集成测试（fetch_page 对真实站点、run_tests 在隔离沙箱）。
