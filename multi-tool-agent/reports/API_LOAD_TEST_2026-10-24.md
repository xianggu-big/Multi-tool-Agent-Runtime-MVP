# 前后端接口联调 + 关键接口压测报告（2026-10-24）

> **定位**：本机自用工作台的接口健康度与容量摸底，**不是生产基准**——单进程 Node、回环地址、Mock 模式、无并发用户。所有数字可用文末命令复现。
> **环境**：Ryzen 5 6600H / 13.7GB RAM · Node v24.14.1（系统版）· `LLM_MODE=mock` · `MTA_HOST` 默认 127.0.0.1 无鉴权 · SQLite（better-sqlite3 同步驱动）· 库内 ~480 runs（含压测产生的 60 条 Mock 噪声，不计入能力口径）。

## 1. 前端改动盘点（截至 `d8d45ef`）

**已完成并实测**（三轮 UI 改动全部在 `public/index.html`，工作区与 HEAD 一致，无未提交改动）：

| 模块 | 状态 |
|---|---|
| Kinetic Orange 主题（纯黑+橙+白、2px 硬边、Archivo Black/Space Mono、在线字体+回退） | ✅ 浏览器实测 7 项 PASS |
| 可收起侧栏（✕/≡/Ctrl+B、localStorage 记忆、窄屏首访默认收起、sticky 独立滚动） | ✅ |
| 顶部状态 ticker（真实 LLM/MCP/流状态跑马灯，`updateTicker()`） | ✅ |
| 悬停 tooltip（短 1s/长 3s、键盘 focus、`data-tip-src` 动态源） | ✅ 确定性测试命中 |
| 运行指示器（running 橙环旋转 / completed 白点 / failed 橙环 / awaiting 闪） | ✅ Mock 任务全流程 |
| 严格三色状态语义（无红绿） | ✅（写路径审批卡/diff 上轮已实测） |
| 「系统状态 & 数据清理」侧栏区块（health/maintenance/prune 接线） | ✅ 形状核对通过（见 §2） |

**待办/隐患**：
1. **无自动化 UI 回归**：三轮改版全靠浏览器手测 + tests/59/61 静态断言，色值/布局无快照守卫（可选：Playwright 截图基线）。
2. **Google Fonts 依赖网络**：断网回退 Arial Black 已验证不崩版，但 ticker/标题字重观感会下降。
3. **严格三色的可读性债**：失败与运行中同为橙色，靠标签/旋转区分——已实测可用，但属于长期观察项。
4. 前端未消费 `GET /api/runs`（列表端点仅 API 面存在）——见 §4 瓶颈 ①。

## 2. 接口联调结果：**33/33 通过**

探针脚本覆盖 `index.html` 全部 44 处 fetch/EventSource 调用点 → 33 个去重端点（含 POST run→轮询终态→events/trace/digest/verification/recovery/approvals/report/diagnosis 全链、cancel、context、data、client-errors、SSE）。

- **路径/方法**：前端每个调用都能命中 `src/server.ts` 路由表（68 条），无 404、无方法错配。
- **响应形状**：前端解构的字段全部存在。重点核对：`/api/health` 前端读 `components.db/mcp/rag/scheduler`（顶层无 `db`,探针初版断言写错已纠正）；`POST /api/runs` 返回 `runId` ✓；`/api/digests` 返回 `digests[]` ✓；`/api/mcp` 返回 `configured/servers` ✓。
- **生命周期**：创建→completed ~1s（Mock）；cancel 200；SSE 首帧 `_stream_meta` 正常。
- **鉴权**：当前无 token（默认回环），`EventSource` 不受影响。**若将来启用 `MTA_AUTH_TOKEN`**：SSE 走 Cookie 引导（`/?token=` 302）已具备，无需改前端。

## 3. 压测结果（每端点 3 档并发：10/50/100）

| 端点 | 峰值 RPS | p50/p95/p99 @c=100 | 错误率 |
|---|---:|---|---:|
| GET /api/health | 2429 | 36 / 63 / 67 ms | 0% |
| GET /api/config | 4460 | 20 / 37 / 42 | 0% |
| GET /api/mcp | 5370 | 18 / 26 / 26 | 0% |
| GET /api/agents/specs | 4831 | 22 / 26 / 27 | 0% |
| GET /api/task-router | 5180 | 18 / 30 / 30 | 0% |
| GET /api/digests?limit=50 | 2532 | 39 / 65 / 70 | 0% |
| GET /api/errors?view=summary | 6124 | 16 / 17 / 17 | 0% |
| **GET /api/runs（列表）** | **291** | **349 / 355 / 357** | 0% |
| GET /api/schedules | 4432 | 20 / 42 / 43 | 0% |
| GET /api/stream/stats | 5087 | 23 / 25 / 48 | 0% |
| **GET /（静态首页 213KB）** | **930** | **109 / 141 / 143** | 0% |
| POST /api/runs（Mock 入队） | 878 | 21 / 23 / 24（c=20） | 0%（未触发 429） |
| POST /api/runs（非法载荷→400） | 2405 | 19 / 23 | 0% |
| 混合读负载（6 端点加权 c=50 × 10s） | 2542 | 19 / 24 / 27 | 0% |

**SSE**：对**已完成 run** 开 10/30/60 并发连接全部 200——该 run 的流回放完即关闭，连接存活 <1s，**未触达 `maxConnections=32` 上限**（代码确认上限在 `server.ts:1317` 以 429+Retry-After 强制执行）。本轮方法学无法证伪上限生效，如需验证应对**活跃 run** 建流。

**总错误率：0%**（含 429/400 拦截路径均符合预期）。

## 4. 瓶颈分析与修复建议

**① `GET /api/runs` 列表：~33ms/请求，并发线性排队（唯一明显瓶颈）**
`server.ts:1305` 对每行 `recordToResult()`——把 50 条 run 的 `resultJson` 整段 JSON.parse 再返回。库内 run 越多越慢（当前 480 条）。
建议（按性价比）：a) 列表投影不解析 `resultJson`（只回 id/status/时间/目标摘要）；b) `runs` 表加 `createdAt` 索引 + `LIMIT/OFFSET` 分页参数；c) 若前端将来用此端点，配合 a 一次改到位。**当前前端未调用它，属 API 面债务，优先级中。**

**② 静态首页 sendFile：~930 rps 封顶，p50 随并发线性涨**
每次请求从磁盘读 213KB 全文件。单用户无感；若开多标签+多页签轮询会放大。
建议：进程内缓存字节 + `ETag`/`Last-Modified` 命中 304；或 `express.static` 带 `maxAge`。**优先级低。**

**③ `/api/health` 聚合成本**：每次调用现查 DB/RAG/调度器（p99 67ms @c=100）。侧栏按需拉取可接受；若前端加轮询（如 ticker 定期刷新），建议服务端 1-2s 结果缓存。**优先级低。**

**④ 写路径容量**：Mock 入队 878 rps、并发 20 未触发 `MAX_ACTIVE_RUNS` 429（Mock 终态太快）；真实模型场景的约束是模型时延与预算，不是 HTTP 层。**无需改动。**

**⑤ 联调零缺陷**：路径/方法/形状全对齐，无需要修复的链接错误。

## 5. 复现命令

```powershell
# 服务（当前代码）
npm start
# 联调探针（33 端点断言）
node .eval/api-integration-probe.mjs
# 压测（输出 .eval/load-results.json）
node .eval/api-load-test.mjs
```

## 6. 边界声明

- Mock 模式测的是 HTTP/序列化/SQLite 路径；真实模型时延不在此列。
- 压测脚本与目标同机，客户端与服务端争抢 CPU，RPS 为**下界**估计。
- 压测产生 60 条 Mock run 与 1 条 probe 数据集合（`probe/p1`），已计入 AGENT_REPORT 的 Mock 计数（能力口径默认排除 Mock）。
- 未测：TLS（无）、多进程、公网暴露姿态、SSE 对活跃 run 的上限触发路径。
