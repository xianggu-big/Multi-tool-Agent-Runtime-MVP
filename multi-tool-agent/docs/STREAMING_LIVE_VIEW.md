# 实时流式展示（Live View）：设计与调试指南

> 目标：让 Agent 的**思考过程**与**工具调用过程**对使用者完全可见、实时更新，体验对齐主流 vibecode 工具（边想边出字、工具调用以卡片形式展示状态与结果）。
> 本文收录的是**真实运行结果**；未验证的部分单独标注，不做包装。

---

## 1. 明确需要展示的内容

| 类别 | 具体字段 | 数据来源 |
| --- | --- | --- |
| **思考文本（推理通道）** | 模型 reasoning 通道的逐字增量（如 DeepSeek `reasoning_content`；Mock 下为合成的「第 N 轮推理…」） | SSE `llm_delta{channel:"reasoning"}` |
| **正文文本（可见输出）** | 模型 content 的逐字增量（含最终答案的文字） | SSE `llm_delta{channel:"content"}` |
| **推理卡片状态** | 推理序号、step、模型名、状态（推理中/完成）、耗时、决策结论（调用哪些工具 / 停止原因） | `model_request` / `model_completed` |
| **工具名称** | 工具名（web_search、read_file…） | `tool_call_requested` / `tool_started` |
| **工具参数** | 结构化参数（JSON 原样展示，可折叠） | `tool_call_requested.data.arguments` |
| **工具状态** | `已发起 → 执行中 →（重试 N）→ 完成 / 失败`，失败带错误码 | `tool_call_requested` / `tool_started` / `tool_completed` / `tool_failed` |
| **工具结果摘要** | 成功：结果 JSON 前 500 字符 + 是否截断；失败：`[错误码] 错误信息` | `tool_completed.outputs.resultSnippet` / `tool_failed.{code,message}` |
| **工具耗时** | 运行中本地计时（≥，200ms 刷新）；结束后替换为服务端 `durationMs` | `tool_completed.data.durationMs` + 前端 tick |
| **阶段指示** | 运行中 / 推理中 / 调用工具 / 执行工具 / 处理结果 / 已完成 / 已结束 | 前端按事件类型推导 |
| **运行指标** | 用时、推理次数、工具次数、失败数、已收帧数 | 前端本地聚合（零网络请求） |
| **最终答案** | 完整答案文本（独立卡片） | `run_completed.outputs.finalAnswer` |
| **异常/限制** | 失败原因、错误码、触发的限制名（maxSteps 等） | `run_failed` / `run_cancelled` / `run_limit_reached` |
| **调试信息**（默认隐藏） | 原始事件 JSON、帧类型/序号/帧间隔/「产生→推送」延迟 | 前端调试面板（需勾选「调试」） |

> 明确**不展示**：模型内部真实注意力/权重、未发生的工具调用、被脱敏的字段（Key 一律 `***REDACTED***`）、以及日志截断上限之外的内容。

---

## 2. 数据通路

```
Provider.chat(onDelta)
        │  逐字增量（content / reasoning）
        ▼
AgentRuntime.loopBody ──► Tracer.delta()  ──► EventLogger.emit(persist:false)
        │                                              │
        │  ① 实时通道 onLive（毫秒级，不等落盘）          │
        │                                              ▼
        │                                         LiveHub.publish(runId)
        │                                              │
        │                                              ▼
        │                                   SSE /api/runs/:id/stream ──► 浏览器「实时」视图
        │
        └─► Tracer.start/finish（span 事件，persist:true）
                    │
                    ├─► ② 批量落盘：缓冲区 → setImmediate → SqliteStore.appendEvents（单事务）
                    └─► ③ SSE 看门狗：每 2s 拉一次持久化事件，按 seq 去重补漏
```

三条通道的分工：

- **① 实时通道**：文本增量与工具状态**不等落盘**直接推，端到端延迟实测 P95 = 0ms（见 §6）。
- **② 持久化通道**：事件经 `setImmediate` 批量写库（单事务），既不阻塞 Agent Loop，也保证断线重连可回放。
- **③ 看门狗**：兜底补漏 + 终态收尾（异步落盘可能晚于实时推送，二者按 `seq` 去重）。

### 事件模型的两类

| 类型 | 例子 | 落盘 | seq | 断线重连 |
| --- | --- | --- | --- | --- |
| **持久化事件** | `run_started`、`model_request/completed`、`tool_*`、`checkpoint_saved`、`run_*` | ✅ | 严格连续 1..N | ✅ 按 `Last-Event-ID` 回放 |
| **临时事件（ephemeral）** | `llm_delta`（文本增量） | ❌ 只走实时通道 | 固定 0 | ❌ 不重放（设计取舍，见 §8） |

---

## 3. 更新方式与刷新频率

| 内容 | 更新方式 | 频率 / 延迟（实测或设定） |
| --- | --- | --- |
| 思考 / 正文文本增量 | SSE 推送（不落盘）→ 前端 `requestAnimationFrame` 合并渲染 | 事件产生即推送；服务端「产生→推送」P95 = 0ms；渲染按帧合并（≤60 次/秒） |
| 工具开始 / 状态变更 | SSE 事件驱动即时更新 | 同上；不等待落盘 |
| 工具执行中计时 | 前端本地 `setInterval` tick | 200ms（纯本地，无网络请求） |
| 运行指标（用时/次数） | 前端本地聚合 | 200ms |
| 断线补漏 | 服务端看门狗轮询 SQLite | 2000ms（`STREAM_WATCHDOG_MS`） |
| SSE 连接保活 | 注释帧 `: hb` | 15000ms（`STREAM_HEARTBEAT_MS`） |
| SSE 断线重连 | 浏览器 `EventSource` 自带重连 + `Last-Event-ID` | `retry: 1000`（1s） |
| SSE 不可用时的兜底 | 前端轮询 `GET /api/runs/:id/events?fromSeq=N&limit=500` | 1000ms |
| 流程监控（流程图/瀑布图） | 事件触发的节流拉取 `/trace` | 700ms 节流（≤1.4 次/秒） |
| 事件落盘 | 异步批量（`setImmediate` + 单事务） | 微任务级调度，不阻塞主循环 |

**一句话总结刷新策略**：文本与状态走「推送 + 帧合并」，计时与指标走「本地 tick」，图表走「节流拉取」，全都有兜底路径。

---

## 4. 界面结构（实时视图）

```
[阶段徽标] [用时 · 推理 n · 工具 n · 失败 n · 帧 n]        [✓自动滚动] [调试]
────────────────────────────────────────────────────────────────────
👤 用户目标
🧠 推理 #1   step 1 · mock           [推理中] 12.3ms…
   ├ 思考：第 1 轮推理：当前信息不足，需要调用 search_files 获取事实…▍
   └ 正文：我将先在仓库中搜索相关代码…▍
🔧 工具 · search_files  已发起        [已发起]
   ▸ 调用参数 { "pattern": "export function", "kind": "content", "limit": 20 }
🔧 工具 · search_files  执行中        [执行中] 4.9ms…
   ▸ 结果 {"ok":true,"data":{"matches":[...]}}  …（摘要，最多 500 字符）
🧠 推理 #2  … 决策 → 调用工具：read_file
✅ 最终答案  [完成]
```

交互细节：

- 卡片头部可点击折叠 / 展开；工具参数与结果默认展开、可收起。
- 文本超出 3 万字只保留最近 3 万字并提示（避免长任务把 DOM 撑爆）。
- **自动滚动**：仅当用户停留在底部时自动跟随；用户上滑后暂停并出现「↓ 回到最新」按钮。
- 勾选**调试**后：每张卡片附带「原始事件（调试）」JSON，顶部出现诊断面板（连接状态、各类计数、最近 60 帧的间隔与推送延迟）。

---

## 5. 性能策略（对主流程的影响最小化）

1. **增量不落盘**：`llm_delta` 走 `persist:false`，不占 seq、不进缓冲区、不写库——避免每秒数十次写 SQLite。
2. **实时回调零 I/O**：`onLive → LiveHub.publish` 是内存分发，无序列化、无磁盘、无网络；订阅者异常被隔离，不影响 Agent Loop。
3. **渲染合帧**：前端把增量累加到内存缓冲，用 `requestAnimationFrame` 批量写 DOM，DOM 写入频率与屏幕刷新率同阶，而不是与事件频率同阶。
4. **零开销开关**：`liveDeltas=false` 时**不产生任何增量事件**（连字符串拼接都不做），测试/CI 默认关闭，行为与引入前完全一致（测试 19d 断言）。
5. **可观测的开销**：`GET /api/stream/stats` 暴露 `ephemeralEvents`（临时事件累计）与 `pendingPersistence`（待落盘队列）供现场判断。
6. **定时器钳制**：心跳 ≥1s、看门狗 ≥250ms、Mock 分片延迟 0–2000ms（客户端传入的 `mockChunkDelayMs` 被钳制到 ≤200ms），防止误配置造成热循环。

---

## 6. 实测数据（本机、Mock、`npm run smoke:stream`）

运行：`SMOKE_CHUNK_DELAY_MS=20 npm run smoke:stream`（研究型任务，4 次模型调用 + 3 次工具调用）

| 指标 | 实测值 |
| --- | --- |
| 总帧数 / 其中文本增量帧 | 47 / 23 |
| 端到端时长 | 484ms |
| 帧间隔（客户端） | min 0.0 / P50 9.9 / P95 21.6 / max 24.4 ms |
| 「产生→推送」延迟（服务端，实时帧自带时间戳） | min 0.0 / P50 0.0 / P95 0.0 / **max 1.0 ms** |
| 结论 | ✅ 收到文本增量 + 终态 `run_end` |

同一套链路的 HTTP 端到端验证（服务端入口，Mock 分片延迟 25ms，codebase 演示）：

- 任务：`completed`，4 steps / 4 次模型调用 / 3 次工具调用 / 660ms
- trace 摘要：run 660ms、llm 4 次共 639.6ms、tool 3 次共 8.9ms、answer 1
- 流式诊断：`ephemeralEvents=25`、`pendingPersistence=0`（增量确实只走实时通道）
- 持久化事件：`seq` 严格连续，**不含** `llm_delta`（符合设计）

> 诚实说明：以上数字是**本机 Mock 路径**的实测值，用于验证「链路本身」的延迟与顺序；真实模型的逐字节奏取决于供应商网络，未在本环境验证（无 Key）。

---

## 7. 开发环境调试与问题排查

### 7.1 三个首选入口

```bash
# ① 一键冒烟：起服务 → 跑任务 → 打印每帧明细与统计（最快确认链路是否通）
npm run smoke:stream
SMOKE_CHUNK_DELAY_MS=20 SMOKE_SCENARIO=codebase-basic npm run smoke:stream

# ② 裸看 SSE（观察帧序号、心跳、终态）
curl -N "http://localhost:3000/api/runs/<runId>/stream?debug=1"

# ③ 看服务端计数（订阅数 / 临时事件数 / 待落盘队列）
curl -s http://localhost:3000/api/stream/stats
```

### 7.2 开关

| 环境变量 | 作用 | 默认（服务端入口） |
| --- | --- | --- |
| `STREAM_LIVE_DELTAS` | 是否推送文本增量 | `true`（测试/脚本默认 `false`） |
| `MOCK_STREAM_CHUNK_DELAY_MS` | Mock 分片演示节奏 | `25`（测试为 0） |
| `STREAM_CHUNK_CHARS` | 单个增量分片字符数 | `18` |
| `STREAM_HEARTBEAT_MS` | SSE 心跳间隔 | `15000` |
| `STREAM_WATCHDOG_MS` | 看门狗轮询间隔 | `2000` |
| `STREAM_DEBUG` | 打印 SSE 连接生命周期与帧级日志（含 `frames/heartbeats/replay/dedup/uptimeMs`） | `false` |

前端侧：`API 配置 → 实时流式输出` 复选框（按任务覆盖）、`实时` 页签右上角「调试」复选框（原始事件 + 诊断面板）。

### 7.3 常见问题速查

| 现象 | 先看什么 | 常见原因与处理 |
| --- | --- | --- |
| 完全看不到逐字输出 | `/api/health` 的 `stream.liveDeltas`；界面「实时流式」是否被取消勾选 | ① 增量默认**不落盘**，若你连接 SSE 时任务已跑完，只能看到聚合预览而非逐字流（见 §8）；② 关闭状态下不产生增量 |
| 工具卡片一直「执行中」 | 事件流里是否有 `tool_completed` / `tool_failed` | 工具真在跑（如 `run_tests`）；`CODEBASE_RUN_TESTS_ENABLED=false` 时 `run_tests` 会以 `TOOL_DISABLED` 快速失败，不会卡住 |
| 帧有延迟、批量到达 | 是否经过反向代理；响应头 `X-Accel-Buffering: no` 是否生效 | nginx 等默认缓冲会「攒够再发」；本项目已设置该响应头并 `flushHeaders()`，自建代理需一并关闭缓冲 |
| 页面没反应，控制台报断连 | `实时` → 调试面板的「连接」状态与「回放」计数 | SSE 断开后浏览器会自动重连（带 `Last-Event-ID`）；前端另有 1s 轮询兜底，可在诊断面板看到帧是否继续增长 |
| 长任务越跑越卡 | 「帧」计数与内存 | 文本超 3 万字自动截断；增量不累积到事件表，无需担心 |
| 服务端 `[sse]` 日志看不到 | `STREAM_DEBUG=1` | 默认关闭，只在排查时开启 |
| 重启后看不到历史思考 | `/trace` 的 `outputs.reasoningPreview / contentPreview` | 增量不落盘，但从库中可读到**聚合预览**（各 1200 字符上限），足以复盘 |

### 7.4 断线续传语义（关键）

- 每个**持久化**事件都带 SSE `id:`（= `seq`）。浏览器重连时自动带 `Last-Event-ID`，服务端只回放 `seq > cursor` 的事件，前端再按 `seq` 去重。
- 服务器支持 `?fromSeq=N` 显式指定游标（轮询兜底与脚本使用），`GET /api/runs/:id/events` 返回 `X-Next-Cursor` / `X-Remaining`。
- **临时事件（文本增量）不参与续传**：它们没有 `seq`，也不会出现在回放里。

---

## 8. 已知限制（诚实清单）

1. **增量不持久化**：断线重连或任务结束后再打开页面，看不到逐字重放，只能看到 `model_completed.outputs.{reasoningPreview,contentPreview}` 的**聚合预览**（上限 1200 字符/次调用）。这是为「不写爆 SQLite」付出的代价。
2. **真实流式路径未端到端验证**：`OpenAIProvider` 的 `stream:true` 解析已实现，且 `accumulateOpenAIStreamChunk` 的解析逻辑有单元测试（含 tool_call 分片聚合），但**没有 API Key，未与真实供应商联调**。
3. **Mock 的「思考文本」是合成的**：无剧本时按决策模板生成（如「第 N 轮推理：当前信息不足，需要调用 X…」），**不是真实模型思考**；界面上所有 Mock 结果都标注为模拟。
4. **`_sentTs` / `_pushDelayMs` 是调试字段**：只在实时帧上附加，供诊断面板计算推送延迟；它们的时钟基准是服务端本地时钟，跨机比较无意义。
5. **不做多客户端差异化**：同一 runId 的订阅者收到完全相同的事件流（无按客户端的过滤/权限）。
6. **无背压控制**：若浏览器处理不过来，事件仍会推送（文本靠合帧缓解，工具事件本就低频）；极端情况下可能出现帧堆积。
7. **SSE 依赖 HTTP/1.1 长连接**：同域并发连接数受浏览器限制（典型 6 条），多任务标签页同时打开可能排队。生产部署建议 HTTP/2 + 关闭代理缓冲。

---

## 9. 文件与接口清单

| 位置 | 职责 |
| --- | --- |
| `src/llm/MockProvider.ts` | 按 `onDelta` 分片输出思考/正文（延迟可配置，测试为 0） |
| `src/llm/OpenAIProvider.ts` | `stream:true` 的 SSE 解析；`accumulateOpenAIStreamChunk` 为纯函数（可单测） |
| `src/trace/EventLogger.ts` | 双通道：批量落盘 + `onLive` 实时回调；`persist:false` 临时事件 |
| `src/trace/LiveHub.ts` | 进程内按 runId 的发布订阅（异常隔离、可退订） |
| `src/trace/Tracer.ts` | `delta()` 产出 live-only `llm_delta`；span 计时 |
| `src/runtime/AgentRuntime.ts` | 开关判定、透传 `onDelta`、聚合预览写入 `model_completed` |
| `src/server.ts` | SSE 三段式端点（回放/实时/看门狗）+ `/api/stream/stats` |
| `public/index.html` | 「实时」视图：卡片、合帧渲染、自动滚动、调试面板、轮询兜底 |
| `scripts/stream-smoke.ts` | 冒烟 + 实测（帧明细与延迟统计） |
| `tests/19_streaming.test.ts` | 19a–19i：分片、临时事件、零开销、流解析、LiveHub、SSE 端到端、续传、纯回放 |

**HTTP 接口**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/runs/:id/stream` | SSE 事件流；支持 `Last-Event-ID` / `?fromSeq=` / `?debug=1` |
| GET | `/api/runs/:id/events?fromSeq=&limit=` | 持久化事件增量拉取（响应头 `X-Next-Cursor`） |
| GET | `/api/stream/stats` | 流式诊断计数 |
| GET | `/api/health`、`/api/config` | 含 `stream` 配置（不含任何 Key） |
