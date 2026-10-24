# Multi-tool Agent Runtime MVP — 项目说明与当前状态

> 本项目代码在 `multi-tool-agent/`（注意：`multi-tool-agent/agents/AGENTS.md` 是**生成的子 Agent 契约文档**，与本文件无关，勿混淆）。
> 本项目规模较大、自己已有一套文档体系（README / docs / reports），**改动前先读 `multi-tool-agent/reports/PROJECT_REPORT.md`**。

## 当前状态（最后更新 2026-10-24 第九轮；工程实测基线 2026-10-24 = **72 个测试文件 / 465 子测试 / 465 通过 / 0 失败 / 0 跳过**（Docker 已启动，沙箱用例回归））

> **✅ 工作台打磨八项（2026-10-24 第九轮，纯前端）**：tooltip 延迟分级（≤20 字 1s / 长说明 3s）+ 键盘 focus 触发；侧栏 sticky（视口内独立滚动）；`<900px` 单列响应式 + 窄屏首访默认收起；运行灯命中区 `::before inset:-6px`；Mock 模式按任务类型自动填演示剧本（手动选择不覆盖）；**写路径深色实测通过**（真 DeepSeek 编排写任务：审批卡/diff/瀑布图可读，落盘 completed，真实任务 +1 → 415/71）。`npm test` 465/465；确定性合成事件测试全命中。明细 `reports/CHANGELOG.md` 2026-10-24「打磨八项」条目。

> **✅ 注释收拢悬停 3 秒 tooltip（2026-10-24 第八轮，纯前端）**：用户反馈「排版好乱」→ 全部常驻说明文字改为**悬停 3 秒**才出现的自定义深色气泡（`.tipbox` + document 级 mouseover 委托，`data-tip` 静态 / `data-tip-src` 动态）：删 12 处 `<p class="hint">`（写能力/编排/杂项/Codex/Token/实时流/4 页签/run_tests/Key 边界），11 处原生 `title` 全替换，标签加 ⓘ；输入栏整理（run_tests 复选框文案缩短、routeNote 省略号截断）。**修 bug**：scroll 捕获监听原会取消待触发定时器 → 悬停期间任何滚动气泡永不出现，改为只隐藏已显示。tests/59/61 守卫未触碰；`npm test` 464 通过/1 跳过（Docker 未启动）；浏览器实测 2s 不弹/4s 弹/移开消失 PASS。明细 `reports/CHANGELOG.md` 2026-10-24。

> **✅ 工作台蓝黑主题 UI（2026-10-23 第七轮，纯前端）**：`public/index.html` 改深蓝黑四层表面（`--bg #0b1220`）+ 亮蓝高亮单主题；CSS 约 120 处硬编码浅色收敛为 `--tint-*` 半透明状态色，JS 38 处内联色与 SVG 瀑布图同步；统一按钮 hover/active（硬边阴影+位移，像素点缀）/focus-visible/disabled；深色滚动条 + `color-scheme: dark` + `::selection`；方块运行灯（`body[data-run-state]` 挂 `renderStatus`）+ 运行中按钮文案切换 + 写意图对话框 Esc 关闭。**同日布局改版（方案 B）**：删顶部大标题区（含 tagline），设置面板改**可收起侧栏**（✕ / ≡ / Ctrl+B，状态记 `localStorage['mta.sidebarCollapsed']`），MCP 行搬侧栏顶部（id 不变），收起后主视图全宽 + 左上角悬浮「≡ 设置」含第二颗灯。**SSE 防卡死渲染逻辑未动**；无新增测试（tests/59/61 静态断言守卫通过）；浏览器实测布局/快捷键/刷新记忆 PASS。明细 `reports/CHANGELOG.md` 同日两条目。

> **✅ Codex 直连 + 定时任务（2026-10-23 第六轮）**：① **`runType='codex'`** 直接驱动本机 `codex exec --json`（`src/codex/`），复用 run/SSE/取消/审批/复盘；只读走隔离副本（排除 `.env*/.git/data`），写模式只改稳定副本 → `scanCodexChanges` → 复用 `submit_changes`（阶梯/审批/journal/落盘/宿主复验）。② 续问走 `codex exec resume`（threadId + workspaceId；resume 不接受 `-C`）；思考用 rollout 旁路 best-effort，失败降级。③ 三入口：runType / `codex_exec` 工具 / `codex-code` spec（`agents:lint` 通过）。④ **定时任务**：`schedules` 表 + 30s tick（once/daily、停服不补跑、重叠跳过）+ REST API + UI「定时」页签；`runs.scheduleId` 迁移列；只在 `src/index.ts` 启动。⑤ **无人值守**：普通 edit 自动放行；删除/命令进 `pending_actions`，事后「执行/忽略」；删除执行前复核 `baseHash`，污点整批拒绝。⑥ 修阶梯对非 TS 仓库误判（无 `tsconfig.json` 跳过 tsc、无 test 入口跳过测试）。真实 E2E：只读两轮续问、写模式 1 次审批落盘、定时+自动审批+删除暂缓均通过。测试 **72 文件 / 465 子测试 / 465 通过**。入口 `multi-tool-agent/docs/CODEX_AND_SCHEDULES.md`，方案 `reports/CODEX_SCHEDULER_PLAN.md`。遗留：思考旁路非公开契约、Codex 费用未计入、MCP destructive 不进待确认、定时任务停服不补跑。

> **✅ 按复盘清单修复（2026-10-23 第五轮，清单见 `reports/SUMMARY_2026-10-23.md` §8.4）**：① **后台补索引** `KnowledgeHubOptions.backgroundIndex`（env `MTA_RAG_BACKGROUND_INDEX`，默认关、本机 `.env` 已开）：写入/删除 O(1) 标脏 + 后台刷新，前台检索与后台补算共享同一 in-flight 构建，`dataVersion` 防止构建期间写入导致返回旧缓存（回归 `tests/68f`）。② **评测语料冻结** `eval/rag-corpus/`（23 文件快照）：`rag-bench` 优先读快照并在报告头标注；新基线 **61 queries / 220 chunks**、hybrid_rerank 72.1% / MRR 0.504（跨天可比）。③ **失败可诊断**：embedding 连接失败文案带 baseUrl 与 `ollama serve` 提示；`npm run doctor` 新增 **Embedding 探针**（实测 qwen3-embedding-0.6b / 1024 维）。④ **导入器** `--max-file-bytes` 默认 2→8 MiB，超限文件始终打印文件名+大小。⑤ **规模开关** `MTA_RAG_MAX_DOCS`（默认 50000）+ `GET /api/rag/status`（built/indexing/store/lastSync/docLimit）。实测单文档增量：20 篇全量 4,395ms → 改 1 篇 451ms。**遗留**：前端索引状态 UI、`data_vec`（256 hash）与 RAG 双轨统一、真实 HTTP 端到端。全量 **450/450**。

> **✅ RAG 索引持久化 P0（2026-10-23 第四轮）**：索引原先只在内存（`KnowledgeHub.ragCache`），重启后首次检索重跑全部 embedding（979 docs / 1107 chunks = **52.3s**），且 `putData` 每次写入都整库置空。新增 `src/knowledge/ragIndexStore.ts`（`rag_chunks`：chunk 正文 + 1024 维向量 BLOB + `doc_hash` + model/dim/chunk 指纹；`rag_index_meta`）、`RagPipeline.fromChunks()`（从持久化数据重建内存 BM25 + Flat，**不调 embedding**）、`KnowledgeHub.rebuildRag()` 改**增量同步**（只重算 `doc_hash` 变化的文档 / 删文档级联删块 / 指纹变化才全量）。实测：首次 53,874ms → **模拟重启 254ms、0 次 embedding**（约 212×）；库 47.5→50.2MB。检索代码未改，刻意不下沉 SQL（FTS5 中文分词差）、不混用 `data_vec`。回归 `tests/68`（5 例）；全量 **449/449**。**遗留**：无后台 worker（新写入下次检索同步补齐）、内存索引仍在（5 万文档量级需 Phase 2）、评测语料未冻结（本次 bench 语料 23/219 vs §8.10 的 19/151，不可直接对比）。

> **✅ 知识库语料导入器 + LCC 压测（2026-10-23 第三轮）**：新增 `scripts/ingest-docs.ts` / `npm run ingest:docs` —— 读 `.md/.mdx/.txt/.jsonl` **正文**（Markdown 按标题切节 + 段落打包 `--max-chars` 默认 3000；jsonl 一行一条、长文切块而非截断），`--exclude` / `--replace`（`data_items` + FTS + `data_vec` 三表一起清）/ `--build-index`；幂等 `itemId=<相对路径>#<序号>`；**不调用 `buildRuntime`**（避免「启动回收孤儿 run」误伤在线服务）。实跑真知识库 **979 条**（docs 359 / reports 395 / runs 223 / notes 2；`reports/` 排除 323 份 `reports/runs/` 证据缓存）。LCC（`D:\数据集\lcc_python` 实为 LCC_python 重打包：仅 `context`/`gt` 两列、`gt` 全空、`context` 中位 13,419 字符）抽 2000 条压测：导入 **19s**、RAG 构建 **3004 chunks / 210.2s（≈70ms/chunk，CPU Ollama）**、临时库 **77.9MB（≈39KB/doc）**。结论：**索引构建成为新瓶颈**（按此速率 50k 文档约 1.5h，且索引只在进程内），持久化/增量索引排 Step 1。测试 **444/444**；详见 `reports/RAG_IMPROVEMENT_2026-10-23.md` §8.11。

> **✅ 编排预筛 + MCP 安全/运维 + 真实 E2E 收口（2026-10-23 第二轮，任务表 `multi-tool-agent/reports/TASK_BOARD_2026-10-23.md`）**：① **编排预筛闸门** `src/runtime/orchestrationGate.ts`——自动分流先估算单上下文是否装得下（`bytes/3.2+8000 ≤ 预算×0.8`）+ 多信号判断；装得下就降为 codebase，显式编排不强制降级但 gate 写入响应/`run_started`/系统提示（回归 `tests/65`；**真实 A/B 未重跑**，`PARALLEL_AB.md` §6 已标边界）。② **读文件台账** `src/runtime/readStats.ts` → `run_digest.readStats` + 前端复盘面板（总次数/去重/重复/Top 路径；**只观测，不声称省 token**；`tests/56g`）。③ **MCP destructiveHint 人工闸门**：默认必须审批，无通道 fail-closed（`MCP_APPROVAL_REQUIRED`），拒绝不执行；Runtime 合并调用方 riskReasons，子 Agent 也注入审批通道（`tests/44h`）。④ **MCP 手动重连** `POST /api/mcp/reconnect`：error→ready 可恢复、重连不产生同名工具冲突（`tests/64i/64j`）。⑤ **真实模型自主调用 MCP**：`npm run mcp:e2e` PASS（3,756 tok / 2.8s / 2 次工具调用；修复前 9,487 tok / 7.1s）。⑥ **写能力 HTTP E2E**：`npm run e2e:write` PASS（38,542 tok / 95.7s / 1 次 allow_once 审批 / `src/calc.ts` 落盘 / 宿主 L2 ok / 0 回滚）。两条证据 `reports/MCP_WRITE_E2E.md`。⑦ **子任务历史**：`GET /api/subtasks/stats` + `npm run stats:subtasks`（聚合 `runs.resultJson`，默认排除 Mock；不建表；`tests/67`）。⑧ 修真实摩擦：`delegate_subtasks` 接受 JSON 字符串、`submit_orchestration.conflicts` 接受字符串（标为未结构化）、`run_tests` 关闭时不再出现在子 Agent 工具池（`tests/66`）。⑨ README 增加 Mermaid 架构图。**未做**：LICENSE（需用户选许可证）、T8 evidence 文件哈希（DEFERRED）、T10 MCPHub 旧 token 轮换（需用户）。

> **✅ 长流式渲染量化 + MCP 真实 E2E + 工具池收口（2026-10-23）**：`npm run perf:stream-ui` 用真实 Edge 155 + 真实 SSE 灌 5 万条增量，CDP 读 Performance/longtask/帧间隔；对照 P0-3 修复前（`cff7786^`）：**主线程阻塞 731→217ms（-70%）**、最长 longtask 167→123ms、DOM 节点增长 **261,245→300**；6,000 条量级新旧都 <300ms（不宣称更快）。报告 `reports/UI_STREAM_PERF.md`。`npm run mcp:probe`（token 仅环境变量）对真实 MCPHub 0.12.10 E2E：54 工具、`12306-mcp-get-current-date` 104ms 真实返回；`MTA_MCP_SERVERS` 启动服务后 `/api/mcp` ready=1，run 的 `allowedTools` 含 `mcp_hub_*`。工具池收口到 `src/runtime/toolPool.ts`（执行与 `miscLimits` 回显共用），回归 `tests/64g/64h`。全量 **64 文件 / 430 子测试 / 430 通过**；远端 CI run `39903621413` 全绿。

> **✅ MCP 主路径配置入口已落地（2026-10-23）**：`MTA_MCP_SERVERS`（JSON 数组，`names` 白名单**必填**）→ `parseMcpServers()` fail-fast 校验 → `McpClientRuntime` 并行连接 → 工具名 `mcp_<server>_<tool>`、权限 `mcp:call` → 按 runType 进 codebase/research/misc/orchestrator 工具池（**code-edit 子 Agent 不注入**）。单 server 失败只标 `error` + 报 `MCP_UNAVAILABLE`，不拖垮服务；`POST /api/runs` 有界等待 10s；`GET /api/mcp` 安全状态（URL 去凭据/query/hash，token 不进状态与错误消息）。回归 `tests/64a~64f`；README §2 工具表补齐 `knowledge_search`/`ask_user`/orchestrator 自检工具。CI 已钉 `node:24.22.0`（BF-014：24.21 上 better-sqlite3 退出断言），run `39901350247` 全绿。**遗留**：附录 A 曾在 `HEALTH_CHECK_2026-10-23.md` 明文写入本机 MCPHub token 并随 `cff7786` 推出——工作区已脱敏，但历史仍含旧 token，需在 MCPHub 删除/轮换 `mta-probe`。

> **✅ 契约门禁真实化 + 流式防卡死 + 评测扩到盲测/多文件（2026-10-23）**：`ToolRegistry.policySnapshot()` 把已注册工具的真实 permission/risk 交给 `validateSpecs()`，动态工具缺权限映射直接 error，`maxRiskLevel` 真正校验；`resolvePermissions()` 读注册表而非静态表。流式输出服务端按 `spanId+channel` 合并约 24ms，前端跳过 `llm_delta`、事件节点上限 500、文本增量 append、滚动 10fps，修“画面突然卡死”。真实编辑评测扩到 **26 条（20 引导 + 4 盲测 + 2 多文件）**，最新 **26/26（L2 26/26）**，833,082 tokens / $0.0248，单轮 95% Wilson 下界 **87.1%**。回归 `tests/59d`、`tests/62a~62c`、`tests/63a/63b`；全量 **422/422**。残余：自动审批仍是 `allow_once`，未覆盖 HTTP/UI 人工审批全链路（MCP 主路径配置入口已于同日补齐）。

> **📦 GitHub 发布准备（2026-10-21）**：仓库已脱敏并**重写为单一干净提交**（`6d3406e`，243 文件）。排除 `.eval/`（本机实测脚本，含个人绝对路径）、`.agents/`（个人工作流配置）、`reports/runs/`、`*.db`；`.env` / `data/` / `.workbuddy/` / `.zcode/` 从未入库。扫描结果：跟踪文件里无 `xianggu`、无 `C:\Users…`、无 `D:\c学习数据结构…`、无真实密钥（仅 `sk-xxx` 占位）。根 `README.md` = GitHub 首页；`.github/workflows/ci.yml` 保留。**remote 已配置**（`origin` → `github.com/xianggu-big/Multi-tool-Agent-Runtime-MVP`）；远端 CI 曾失败（BF-010：契约文档 CRLF/LF 比较），修复后**终点 A 功能提交 `c12a394`** 的 run `39728277735` **全步骤绿**（npm ci / typecheck / agents:lint / npm test）。未附 LICENSE（默认保留所有权利，需要再补）。

> **✅ 终点 A 四条验收已收口（2026-10-22）**：① **GitHub Actions 真绿**：`main` 上 run `39728277735`（`c12a394`）全步骤 success；② **干净目录可跑**：最新提交 `git clone --depth 1` → `npm install` → typecheck → **416/416** → `demo:codebase` completed；③ **真实模型编辑**：20 条单文件任务 **20/20（L2 20/20）**，611,890 tokens / **$0.0172**，证据 `multi-tool-agent/data/edit-eval-real/20261022-131513-248/`；④ **每个数字可复现**：复现命令已写入 `reports/EDIT_EVAL_REAL.md`、`reports/PROJECT_REPORT.md`、`README.md`、`docs/DEMO.md`。边界：20 条只覆盖小函数级修改，不外推大型重构。

> **✅ 运行测试显式授权 + 演示闭环（2026-10-22）**：`run_tests` 默认关闭时**不再进入工具池**（模型看不到，避免 UI 主路径每次都报 `DISABLED@run_tests` 假问题）；新增 `RunInput.allowRunTests`（按 run 覆盖）+ HTTP 布尔校验 + 前端「允许运行测试」开关（默认不勾，misc 隐藏）+ Mock 剧本按工具池自适应。`extract_evidence` 新增 `toReadableText()`：结构化搜索结果先抽 `title/snippet`，修掉 Research demo 的 JSON 碎片。CI 在干净 `node:24` Linux 容器等价实跑：`npm ci` 125 包 → typecheck → agents:lint → test = **406 通过 / 1 跳过（Docker）/ 0 失败**。`docs/DEMO.md` 重写为 10 分钟演示闭环（四条 Mock 命令 / 7 步工作台 / HTTP / 写能力 / 真实模型 / 常见失败）。回归 `tests/60/61`；全量 **61 文件 / 416 子测试（416 通过 / 0 跳过 / 0 失败 / 约 20s）**。
> **✅ R23 上下文滚动摘要 + 压缩迟滞已修（2026-10-21）**：`compactMessages` 识别旧摘要并**原样保留**，只压旧摘要之后的新增消息；首次压缩把任务目标原文（≤2000 字符）写入摘要；再次压缩要求活动区 ≥2000 字符且自上次压缩后新增 ≥4000 字符或 ≥4 条消息（上下文水位只作门禁，不再一过 60% 就每步压）；摘要达 `COMPACT_SUMMARY_MAX_CHARS=24000` 后停止压缩并标记 `capReached`，绝不截断旧摘要。新增落盘事件 `context_compacted` 与 `run_digest.compaction`。回归 `tests/33h~33l`、`tests/56f`。

> **✅ R25 压缩水位语义修正（2026-10-21）**：水位从「任务累计预算」改为 **`lastPromptTokens / provider.contextWindow`**（DeepSeek 预设 1,048,576；Mock 32,768），`tokenBudget` 只做总预算；窗口未知才显式回退并标 `watermarkSource=unknown`，usage 缺失按字符估算并标 `estimated`。`context_compacted` / `run_digest.compaction` 新增 `watermark / watermarkSource / promptTokens / contextWindow`。回归 `tests/33m~33p`、`56f`；全量 **407 子测试（407 通过 / 0 跳过 / 0 失败 / 约 17s）**；`eval:edit` 7/7。残余：其余 Provider 的窗口值未补齐；真实 A/B 已完成（30 run）但结论是 `not_proven`；前端 compaction 面板已落地（R24）。

> **✅ P0-2 上下文压缩真实 A/B 已完成（2026-10-21）**：`npm run eval:compaction` 跑 5 任务 × 2 策略 × 3 次 = 30 run（真 DeepSeek Flash，4K 模拟窗口，预算 $1）；rolling/legacy 均 30/30 completed、质量 100%，rolling 平均 tokens 多 1.8%、成本多 1.4%、耗时少 0.1%，最大摘要深度 2 vs 1，未达预注册 15% 效率门槛，判定 **`not_proven`**；详见 `multi-tool-agent/reports/COMPACTION_AB.md`。边界：重复读取被任务契约压平；结论不外推到 1M 窗口。回归 `tests/58`（7 例）。

> **✅ R24 复盘 / 压缩前端面板已落地（2026-10-21）**：新增「复盘」页签（只看问题/全部、状态/类型/条数筛选；摘要列表 + 详情、过程问题表、压缩观测、原始 JSON、当前 run 快捷定位）；实时流新增 `context_compacted` 卡片，`run_digest` 事件自动刷新。回归 `tests/59`（3 例）；本机 Edge headless + CDP 实测页签、真实摘要与合成压缩卡片。全量 **407 子测试**。

> **✅ 终态即取消（2026-10-20，修「卡死几分钟」）**：`finalize()` 现在 abort run 级 signal；`requestApproval` 监听 abort → 立即 `deny(actor=run-finished)`，不再等 300s；`delegate_subtasks` 自管 240s 批次超时并 abort 该批；`EventLogger` 不再在终态清零 seq（改 LRU 2000）。现场：`run_mvgejh0e_3e6c9b74` 主 run 08:20:06 已 completed，僵尸子任务仍跑到 08:27、连弹两张审批卡、事件从 seq 1 重写（225 行/201 seq）。回归 `tests/57`（4 例）+ `tests/32d6` 语义更新；全量 **386/386**。**运维：`npm start` 无热重载，改完代码必须重启**（当天 16:25 的 400 复现就是旧进程）。

> **✅ 复盘摘要（`run_digest`）已落地（2026-10-20）**：**每次** run 终态都自动写一份结构化复盘（成功也写、失败优先），内容 = 结论 + 计数 + 过程问题聚合（工具/运行时/子任务/审批/验证/回滚/注入，含次数与首个 seq）+ `firstIssue` + 一句话 `headline`；重启回收的 `RUN_INTERRUPTED` 也补一条。三落点：`run_digests` 表 / `data/run-digest.jsonl` / `run_digest` 事件；查看 `npm run digest:list`（默认只看有问题的）、`GET /api/digests`、`GET /api/runs/:id/digest`。回归 `tests/56`（5 例）；全量 **382/382**。详见 `multi-tool-agent/docs/RUN_DIGEST.md`。

> **✅ 上下文压缩切点 400 已修（2026-10-20）**：真实 run `run_mvge1343_49a18777` 第 16 步 `MODEL_ERROR` 400 —— `Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`。根因不是 Provider：Token 水位 ≥60% 触发 `compactMessages`，它按固定 6 条硬切，切在「assistant(tool_calls×2)+tool+tool」中间，assistant 进了摘要、后半条 tool 结果留在尾部 → 孤儿 tool。现切点强制对齐轮次边界（`alignCompactCut`），新增 `tests/33e/33f/33g`。同轮补齐**模型失败的 `source:"provider"` 错误报告**（此前只有 `run_failed` 事件，`/api/errors` 与 `data/errors.log` 都查不到 —— 文档 §2.3 属虚标），context 带 `status/step/messageCount/suspect`；事故已写入 `docs/ERROR_REPORTING.md` §1.4。全量 **377/377**。**残余质量风险 R23 已于 2026-10-21 修复**（滚动摘要 + 迟滞 + `context_compacted` 观测，见上一条）。明细见 `multi-tool-agent/reports/CHANGELOG.md` 2026-10-21 / 2026-10-20 条目。

> **✅ M1「写能力 + Docker 沙箱 + 三级人工审批」已实施完成（待你复核）**：代码/测试/文档全链路 + 真实 Docker + 真实模型端到端实测均通过。**M1'（2026-10-16）已把写能力接入 UI**：界面「允许修改文件」开关（默认不勾，勾选即授权本 run）+ 修改意图确认对话框 + 审批卡滚入高亮；`allowWriteSpecs` 四处完整接线（未授权 fail-closed）。
> **复核入口：`multi-tool-agent/docs/WRITE_AND_APPROVAL.md` 第 0 节（终验复核清单，逐条含状态+证据）+ §3 终验结果**；进度表见第 2 节。三态链路实测：deny 不落盘 / allow_once 落盘 + `hostVerify{ran:true,ok:true}` / allow_file 粘性第二次提交 `autoByPolicy:true`（合计成本 < $0.01）。

> **✅ 异步沙箱 + L1/L2 验证闭环已收口（2026-10-19）**：`spawnAsync` 替换同步阶梯（不再阻塞事件循环）；`strictVerify=true` 审批前跑 L2；终态 run 可手动 `POST /api/runs/:id/verify`（queued/running/passed/failed/cancelled，可取消），`GET /api/runs/:id/verification` 查询；新增 `verification_started/completed`、`change_applied`、`change_rolled_back` 事件与 UI 面板。关键修复：嵌套 `node --test` 继承 `NODE_TEST_CONTEXT` 导致失败被吞（`tests/39i`/`50b`）；终态 run 追加事件 seq 冲突破坏（`tests/50d`）。新增 `tests/49`（4 例）/`50`（6 例）；全量 **334/334**。

> **✅ RAG / Agent 应用栈 P0/P1/P2 已落地并通过复核收口（2026-10-19）**：切块（默认 512/64 + docs/code/faq/report 预设；`text` 可精确按 `charStart/charEnd` 切片）、embedding 注册表与 L2 归一化（真实模型用 `MTA_EMBEDDING_*` 显式 opt-in）、Flat/HNSW/IVF 索引（支持删除/upsert）、BM25+向量 RRF/加权融合、词法 rerank；`knowledge_search` 已进 codebase/research/orchestrator 与 `doc-research` 主路径，MCP `kb_search` 同管线；MCP server/client/stdio/Streamable HTTP（真 SSE 增量 + `Mcp-Session-Id`）+ ToolRegistry 桥接（风险按 annotations 推断、取消可穿透）；function calling 的 `tool_choice` / `parallel_tool_calls` 按 run 透传并在 HTTP 层校验；`GET /api/runs/:id/diagnosis` 慢回答与 token 热点；P2 的 LangGraph 取舍、LoRA vs RAG、vLLM 显存估算。**实测**：`npm run rag:bench`（19 文档 / 151 chunks / 18 查询）keyword 94.4% / RRF 88.9% → rerank **100%**，MRR 0.690→0.750，nDCG 0.536→0.638；`rag:ablation` 显示本语料 512/32 最好（0.856），512/64 默认 0.750——**不声称唯一最优**。**新增 `tests/43~48` 29 例全过；全量 334/334**。**本轮复核再修 5 处**：切块尾块按原文区间合并（overlap 不复制）/ forced tool 不在工具池时 fail-fast（`INVALID_TOOL_CHOICE`）/ MCP 超时主动 `notifications/cancelled` / 前端 token 预算 `min=1` 与费用预算“0=不限”口径 / `read_file` 沙箱副本 8 MiB 预检（32d4/43a/44g/46f）。**入口：`multi-tool-agent/docs/RAG_AND_AGENT_STACK.md`；评测：`reports/RAG_EVAL.md`、`reports/RAG_ABLATION.md`**。P2 收口：limits 正整数 / goal ≤20k / read_file 8MiB 预检 / fetch_page maxBytes+总超时 / EventLogger 终态清理。边界：hash embedding 非语义模型、HNSW 为教学简化实现、删除是墓碑、INT8 精度未实测。

> **✅ 人机协同（`ask_user` / `awaiting_user`）已落地（2026-10-19）**：模型缺关键信息时调用终结性工具 `ask_user`，run 进入 `awaiting_user` 而不是伪装 `completed`；问题随 `resultJson.awaitingUser` 落库、前端展示、SSE 发 `run_awaiting_user`，回答以新一轮任务 + `contextHistory` 继续。新增 `tests/48` 3 例，全量 334/334；入口 `multi-tool-agent/docs/HUMAN_IN_THE_LOOP.md`。残余：只识别显式工具调用；暂不支持同 run `answer + resume`。

> **✅ 崩溃对账 / 恢复已落地（2026-10-20）**：`apply-journal` 在碰任何文件前记录每文件 `baseHash/workHash/op/status`；启动扫描 `data/backups/*` 判定 `applied/not_applied/missing/conflict/unknown`。只对 `RUN_INTERRUPTED` 的 run 生效；自动恢复仅限「编辑 + 文件消失 + 有备份」，已落盘编辑/新增**不自动回滚**；旧日志/损坏日志只做人工比对。API `GET /api/runs/:id/recovery` + `POST .../rollback|accept`，UI 有恢复卡。日志写失败 `APPLY_JOURNAL_FAILED` fail-closed；单文件落盘异常不再伪装成 `ok:true`（`APPLY_FAILED`）。新增 `tests/51` 7 例（含 `51g` 独立进程真实 `SIGKILL`）+ `38g2/38g3`。入口 `docs/WRITE_AND_APPROVAL.md §3.9`；边界见 `reports/PROJECT_REPORT.md` R19。
> **✅ 可复现编辑管线评测已落地（2026-10-20）**：`npm run eval:edit` 用独立 fixture + 真 Docker 跑 7 个确定性场景（正确修复/批量新增/语法拦截/测试拦截/审批拒绝/宿主红回滚/TOCTOU），当前 **7/7 命中预期**（5 次审批 / 4 文件落盘 / 1 回滚；平均 11.5s；tokens=0）。产物 `reports/EDIT_EVAL.md`；汇总口径回归 `tests/55`（5 例）。**边界：衡量管线，不是模型编辑智力**；真实模型 20~30 条任务仍未做（R22）。

> **✅ 验证能力探测 + 提示注入边界 + 红队评测 + 首跑自检（2026-10-20）**：`hostVerify` 不再假定仓库有 `tests/*.test.ts`：有 Node 测试跑全量；有 tsconfig+tsc 降级类型检查并标注；都没有则 `unavailable`（不阻断落盘、明确「未经行为验证」），不自动执行 jest/vitest 任意脚本（`tests/52` 6 例）。新增 `src/security/untrusted.ts`：不可信工具输出扫描中英文/少量多语言特征 → `untrusted_content_flagged`（样本脱敏）+ run 污点 + **禁用粘性自动放行** + 模型上下文独立边界消息 + 审批卡安全警告；**删除 / 宿主命令批次即使人工选 `allow_file` 也不进入粘性集合**（`stickySkipped`）。**2026-10-20 进一步收紧**：`approvalRisk` 统一判定，批准删除/宿主命令必须带当前批次 `confirmHighRisk`（Runtime 缺确认不 resolve、HTTP 400 `HIGH_RISK_CONFIRMATION_REQUIRED`），前端勾选后才放开批准按钮；`tests/53` 现 13 例。`npm run security:redteam` 42 条固定样本：恶意检出 **20/22**、正常误报 **2/20**（已知漏检 m21 纯 base64 / m22 URL 编码；已知误报 b19/b20），产物 `reports/INJECTION_REDTEAM.md`；这是降风险不是彻底防御，边界见 `docs/SECURITY_BOUNDARIES.md`。新增 `npm run doctor`（Node/宿主 Node/sqlite-vec/数据目录/端口/Docker 镜像/Key；`tests/54` 6 例），`package.json` 钉 `engines.node >=24 <25`，新增 `.github/workflows/ci.yml`（远端尚未实跑）。全量 **373/373**。

**记账网页首轮 run 复核（2026-10-15，只读核查）**：`run_mv94f94p_314902b2`（orchestrator）的 doc-research 派发**属实**——依据：`events` seq 4-6（首次 delegate_subtasks 把 subtasks 传成字符串 → INVALID_ARGS）、seq 10-12（重试成功 + `subtask_started specId=doc-research subtaskId=st_75b59854`）、seq 57（`subtask_failed limit_reached/maxToolCalls 16`，st=7/mc=6/tc=16、**无报告无来源**）、`resultJson.subtasks[0]`（hasReport=false）+ `orchestration.unresolved`（**已如实声明缺口 + 7 个阻塞问题**）。
**暴露的三个可见性/口径缺口（2026-10-19 修正：①②③均已修）**：① ~~顶层计数器 t3 不含子任务的 16 次工具调用~~ **已修**——新增 `OrchestrationReport.subtaskUsage`（子任务的 modelCalls/toolCalls/tokens/成本合计），报告与前端可单独核对；② ~~`limit_reached` 子任务被记成 `cancelled`（ok:0/failed:0/cancelled:1）→ headline 上"0 失败"~~ **已修**——`subtasks.limited` 独立成桶 + `gaps{failed,cancelled,limited,unresolved,total}` 计数 + UI「缺口 N」徽标；③ ~~run 状态 `completed`，而实际阻塞于 7 个待用户回答的问题（无可区分状态/徽标）~~ **已修（2026-10-19）**：新增 `ask_user` 工具 + `awaiting_user` 终态 + `run_awaiting_user` 事件，问题结构化落库并在 UI 展示（回归 `tests/48`）；回答走新一轮 + `contextHistory`。改动明细见 `reports/CHANGELOG.md`（2026-10-16 口径修正）、风险登记见 `reports/PROJECT_REPORT.md` R16。
复核脚本（可复用）：`.eval/query-billing-runs.mjs`、`.eval/query-run-detail.mjs <runId>`。

**任务目标**
- 轻量级 Agent Runtime MVP：一套共享 Agent Loop 驱动 codebase / research / misc / orchestrator 四类 Agent；可运行、可测试、可演示，非生产系统。

**已确认的结论与约束（2026-10-15 实机复验）**
- 工程健康度（2026-10-23 实跑）：`npm run typecheck` 0 错误；`npm test` **63 文件 / 422 子测试 / 422 通过 / 0 跳过 / 0 失败 / 约 17s**；`npm run agents:lint` 三项门禁通过；`eval:edit` **7/7**；`eval:edit:real` **26/26**；4 个 Mock demo 的最近记录仍为 completed。
- M1/M1' 写能力：默认**可用**（`CODEBASE_WRITE_ENABLED` 默认 true，部署可显式 false 整机禁用）；写操作走「本 run 界面显式授权（「允许修改文件」开关 → `allowWriteSpecs`）→ 沙箱阶梯 → 一次批量审批 → 落盘 → 宿主复验（失败自动回滚）」；`code-edit` 是唯一可写 spec。实测四修：快照自引用崩溃 / hostVerify 继承运行期 env 致恒失败回滚 / 分类器被测试名污染 / 容器内套件 2 条平台假设失败——都带回归守卫（40k/40l/39i）。
- 真实模型（deepseek-flash，Key 来自系统用户级环境变量 `DEEPSEEK_API_KEY`，`.env` 留空即可）：
  - 单 Agent 冒烟通过（2 步 / 1781 tok / $0.00015 / 104 流式帧）。
  - 真实编排实测通过：4 个子任务（3 ok + 1 次 maxToolCalls 限流后收窄重试成功）/ 78.7s / 主 Agent 19.9k tok / $0.0016（子任务另计，合计约 230k tok）。
  - 前端工作台（实时视图）实测正常：思考逐字、工具卡片、统计、路由建议均可用（截图见 2026-10-14 会话）。
- 真实效果口径：**一律以 `reports/AGENT_REPORT.md` 的生成值为准**（`npm run report:agent` 每天 09:00 自动重生；真值在 `data/runtime.db`）。最近一次（2026-10-21 `report:refresh`，403 任务）：真实模型 **67.7%（42/62 成功）**、平均 44.4s、P95 159.6s、$0.60957；Mock 99.7%（340/341，仅演示、不计入能力评估）；全量 94.8%（382/403）。**注**：Mock 计数与环比从 2026-10-19 起不再随 `npm test` 漂移（19g/19h/19i 已改内存库）；历史库仍含旧噪声。
- 安全修复已收口（2026-10-14）：审查 P0×2 + P1×4 **全部修复**（run_tests 白名单改参数模板匹配、SSRF 去尾点+DNS 复核、resume 补 catch、realpath 反 junction、FTS5/vec0 补 MATCH）；对抗套件 5 条断言已从「BUG 证据」翻转为「回归守卫」（20/20）；g3 额外钉死原生路径（实测 `vec0 available=true, vectors=2`）。明细见 `reports/CHANGELOG.md`「安全修复收口」。
- 仍剩未修缺陷：`reports/CODE_REVIEW_2026-10-13.md` 的 **P2-7（无鉴权，仅本机部署）** / P3×3；P2-1~P2-6 已于 2026-10-19 修复并转为回归守卫（32c3、32d2~32d6）。
- 观测与量化已完成（2026-10-14）：错误聚合面板（`/api/errors?view=summary` + 前端「错误」页签，浏览器实测）；`reports/PROVIDER_BENCHMARK.md`（DeepSeek 实测 1,737 tok/$0.00011/2.6s，其余 4 家待 Key）；`reports/PARALLEL_AB.md`——**同任务同顶层预算实测：编排 243.7s/1.56M tok vs 串行 39.4s/221k tok（约 7× token，未回本）**，根因=子任务重复读取 + search_files 陷阱迫使"逐行通读" + 重试链吞并行度。
- `search_files` 三重静默陷阱（2026-10-14 发现，**已于 2026-10-15 修复**，commit `403b337`）：① `kind` 默认 `filename`（内容搜索恒 0 命中且 `ok:true`）→ 改默认 `content` + 0 命中给修正 hint；② `a|b` 被转义成字面量 → 改为 OR 语义；③ `path` 不在 schema 被 Zod 静默丢弃 → 补 `path`/`dir` 作用域参数。回归：`tests/37` 7 用例 + `.eval/probe-search3.mjs`（改造为 PASS/FAIL 探针）。
- 测试环境硬约束：必须用系统 Node v24（`/d/Program Files/nodejs/node`），better-sqlite3 按 v24 ABI 编译；托管 Node 22 会 ERR_DLOPEN_FAILED。
- 本机 Git Bash 实测注意：`curl --data-urlencode` 传中文会乱码（分流器会被误判成"未识别信号"）；`docker exec/chown` 的容器内绝对路径（如 `/work`）会被 Git Bash 改写成 `D:/Program Files/Git/work` —— 要加 `MSYS_NO_PATHCONV=1`。HTTP API 实测一律用 Node fetch。

**关键文件路径**
- M1 设计与验收：`multi-tool-agent/docs/WRITE_AND_APPROVAL.md`（第 0 节=终验清单，第 3 节=终验结果）；沙箱镜像构建：`node scripts/sandbox/build-image.mjs`
- 实测/复现脚本：`.eval/m1-e2e-drive.mjs`（真 Docker + 真模型三态端到端）、`.eval/m1-ladder-probe.mjs`（不花 token 的阶梯探针）、`.eval/m1-e2e-attach.mjs`（附着已跑 run）、`.eval/api-e2e.mjs`、`.eval/probe-search3.mjs`
- RAG / MCP 入口：`multi-tool-agent/docs/RAG_AND_AGENT_STACK.md`（问题→代码→证据）；评测 `multi-tool-agent/scripts/rag-bench.ts` → `reports/RAG_EVAL.md`；MCP demo `multi-tool-agent/scripts/mcp-server.ts`
- 安全边界 / 验证降级：`multi-tool-agent/docs/SECURITY_BOUNDARIES.md`；`src/security/untrusted.ts`（注入扫描 + 污点）；`src/sandbox/verificationPlan.ts`（full_suite/typecheck/unavailable）；`docs/WRITE_AND_APPROVAL.md` §3.10
- 红队评测：`multi-tool-agent/eval/security-redteam/corpus.json`（42 条）+ `scripts/injection-redteam.ts` + `reports/INJECTION_REDTEAM.md`；`npm run security:redteam`（`--strict` 暂不接 CI）
- 首跑自检 / CI：`npm run doctor`（`scripts/doctor.ts`）；`.github/workflows/ci.yml`。GitHub 远端已真跑过一次（run `39549359352` / `a698c71`），**`npm test` 失败**：`tests/23d` 把 CRLF 与 LF 当内容差异（BF-010）。修复后同一 commit + 补丁在 `node:24` 容器跑出 **395 通过 / 1 跳过 / 0 失败**；已推送（`f52ef4a`）并触发 run `39724718243`：**npm ci / typecheck / agents:lint / npm test 全部 success**。
- 编辑评测（管线）：`multi-tool-agent/scripts/edit-eval.ts` + `src/evaluation/editEval.ts` + `eval/edit-fixture/base/`；产物 `reports/EDIT_EVAL.md`；`npm run eval:edit`（需 Docker + `mta-sandbox:node24`，7/7）
- 编辑评测（真实模型）：`multi-tool-agent/scripts/edit-eval-real.ts` + `eval/edit-fixture/real/`；产物 `reports/EDIT_EVAL_REAL.md` + 脱敏证据 `EDIT_EVAL_REAL_EVIDENCE.json`；`npm run eval:edit:real -- --tasks=26 --budget-usd=1 --timeout-ms=240000`（需 Docker + `DEEPSEEK_API_KEY`，最新 26/26、L2 26/26；20 引导 / 4 盲测 / 2 多文件；单轮 Wilson 下界 87.1%、约 $0.025）；`--preflight-only` 先验证 fixture 基线 15/15
- 产品化路线：`multi-tool-agent/docs/PRODUCT_READINESS.md`（To C 阈值 / 四道门 / 简历叙事 / 下一轮动作）
- 核心报告集 + 专项评测：`multi-tool-agent/reports/{PROJECT_REPORT,AGENT_REPORT,CHANGELOG,PARAMETERS,CODE_REVIEW_2026-10-13,PARALLEL_AB,PROVIDER_BENCHMARK,ZCODE_COMPARISON,RAG_EVAL,RAG_ABLATION,EDIT_EVAL,EDIT_EVAL_REAL,INJECTION_REDTEAM}.md`（各自的更新规则见下）
- 仓库级 skill（两个，随仓库走）：`.agents/skills/mta-verification/`（验证/复跑/取数）、`.agents/skills/mta-reporting/`（核心报告集 + 专项评测 + 收尾清单）
- 量化报告：`multi-tool-agent/reports/PARALLEL_AB.md`（并行 A/B，结论为负）、`PROVIDER_BENCHMARK.md`（Provider 现状）；A/B 脚本 `.eval/ab-parallel.mjs` + `.eval/ab-collect.mjs`
- 单 run 报告（**生成物 + 本地缓存，不入库**）：`npm run report:run -- <runId>|--all` → `multi-tool-agent/reports/runs/`（每 run 一份 + `INDEX.md`）；实现在 `multi-tool-agent/src/report/`、`scripts/gen-run-report.ts`；HTTP `GET /api/runs/:id/report`
- 错误排查入口：`multi-tool-agent/docs/ERROR_REPORTING.md`；架构：`docs/ARCHITECTURE.md`
- 工作区记忆：`.workbuddy/memory/MEMORY.md`（报告制度等长期约定）

- 仓库级 skill（随仓库走）：`.agents/skills/`（Codex 从 cwd 向上找 `.agents/skills`）；与 `~/.codex/skills` 同名时会**重复注入**；沙箱内**不可写**（deny ACL），改 skill 要在沙箱外

**规模原则（2026-10-23 起，所有工程改进的默认约束）**
- 目标不是「当前 979 条能跑」，而是 **10^5 / 10^6 / 10^7 文档量级仍可用**。每轮改动的第一问：再放大 100 倍会先撞哪堵墙。
- 实测单价（本机 1024 维）：Flat 距离计算 **≈83ns/块**；embedding **≈47ms/chunk（CPU）**；存储 **≈30–50KB/doc**（`contentJson` + `searchText` + `rag_chunks.text` 三份正文）。
- 外推（**推算，非实测**，未计访存/GC 恶化）：

| 规模 | chunks（≈1.13/文档） | 向量常驻内存 | 单查询暴力 kNN | 全量重建（CPU） |
|---|---:|---:|---:|---:|
| 10^5 | ~113k | 463MB | ~9ms | ~1.5h |
| 10^6 | ~1.13M | 4.6GB | ~94ms | ~15h |
| 10^7 | ~11.3M | 46GB | ~940ms | ~150h |

- **不能变成死路的 5 个决定**：① 禁止「全表读入内存」（`rebuildRag` 现在就是，>10 万条必须改流式 + 外部索引）；② 检索层不得假设索引在内存（`VectorStore` / `KeywordStore` 抽象，内存实现只是默认）；③ 正文只存一份（现在三份，10^7 时是 300–500GB）；④ 写入路径不做同步 O(N) 工作（后台队列）；⑤ 批量作业必须幂等 + 断点续跑。
- **升级触发条件（未到阈值不提前做）**：`>50k docs` → 打开 sqlite-vec/ANN + chunk 级倒排；`>500k` → 向量量化（int8/PQ）+ GPU embedding + 专用向量库；`>5M` → 分片 / 分布式 + 粗到细检索 + 语义缓存。阈值前只保证**接口可替换**，不上重型组件。
- 诚实边界：10^7 在本机单进程 + JSON/内存模型下不可达；真到那一档必须换成「服务 + 向量库 + GPU 入库」的形态，不是把现有代码调参。

**下一步（按性价比）**
- **RAG 下一轮（Step 2~3）**：Step 0 语料治理、Step 1 持久化/增量/后台补索引、评测语料冻结均已完成；下一步 Step 2 多查询改写/HyDE、small-to-big 父块回填（目标 Recall 72.1% → 80%+）；Step 3 默认检索改 `hybrid`（RRF）、rerank 默认关，CE 降延迟后再议；5 万文档量级再把检索下沉 `vec0`、并统一 `data_vec` 双轨。
- **编辑评测继续加难度（R22 残余）**：26 条已含 4 条盲测 + 2 条多文件（`reports/EDIT_EVAL_REAL.md`）；下一阶段接“真实 HTTP run + 人工审批 + UI 事件流”的全链路 smoke，并扩到更多文件/更大 fixture；仍单独统计部分成功、重试轮次与回滚。
- **提示注入红队（首版已完成）**：42 条固定样本 + `npm run security:redteam` 已落地；删除/宿主命令已禁用粘性复用并要求当前批次二次确认。剩余：扩真实改写/编码/多语言样本、降低安全文档误报，对「外传密钥 / 发布 / 改审批配置」加独立二次确认/能力令牌，不只依赖 run 级污点。
- **口径修正（2026-10-19：①②③④ 已完成）**：① ~~`limit_reached` 独立成桶~~、② ~~编排报告 `gaps` 计数 + 前端「缺口 N」徽标~~、④ ~~子任务消耗分层计数（`subtaskUsage`）~~ 均已在 `src/types.ts` / `src/runtime/AgentRuntime.ts` / `public/index.html` 落地（回归用例在 `tests/22_orchestrator.test.ts` 22h/22m）；**③ 已完成**：新增 `ask_user` + `awaiting_user` 终态（回归 `tests/48`）；残余是只识别显式工具调用，正文提问仍可能被记为 completed。
- **~~流程图 + 量化报告生成器~~（2026-10-16 已完成「渲染层」）**：`npm run report:run -- <runId>|--last <n>|--all` → `reports/runs/<runId>.md`（Mermaid 流程图 + 分层量化 + 六阶段归因）+ `INDEX.md`；HTTP `GET /api/runs/:id/report`（`?format=md`）。实现：`src/report/{runReport,runReportFiles}.ts` + `scripts/gen-run-report.ts`；回归 `tests/41`（8 例，含 41h 验证/回滚归因）+ `tests/22` 22q。`reports/runs/` 是**本地证据缓存**，已加 `.gitignore` 不入库（`--all` 可重生成）。异步沙箱已就绪，下一步可接**终态自动触发**。
- 编排成本收口：子任务去重读取（同一 run 内只读文件缓存，或主 Agent 预读下发）；派发前先判“单上下文能否装下”，避免默认 7× token。
- 首次上手收口（已完成 2026-10-22）：`npm run doctor` 已有；README §1.1~1.3 已补「预期输出 / 最小验证路径 / 常见失败」；`docs/DEMO.md` 已给 10 分钟闭环；干净目录 fresh-clone 跑通 install/typecheck/**416/416**/demo，GitHub Actions run `39724718243` 全绿。
- 有 Key 时按 `reports/PROVIDER_BENCHMARK.md` §3 命令跑 openai/qwen/moonshot/zhipu 横评。

**报告更新规则（改报告前先对照；核心报告集 + 专项评测全在 `multi-tool-agent/reports/`）**
- **勿手改（生成物；要改就改源或跑命令重生）**：`AGENT_REPORT.md`（`npm run report:agent`，只读扫 `data/runtime.db`；历史快照落 `reports/history/agent-YYYY-MM-DD.json`）、`PARAMETERS.md`（`npm run report:params`，源 `src/config.ts` / `src/agents/specs.ts` / `src/llm/presets.ts`）、`agents/AGENTS.md` + `agents/<id>.agent.md`（`npm run agents:docs`）。
- **人写、按各自规则增补**：`PROJECT_REPORT.md`（每次实质改动就更新；头部「最后更新/测试规模/遗留风险」+ §8 文档地图要同步）、`CHANGELOG.md`（**顶部**按 `## 日期` 分组新增一条、最新的日期在最上、条内用 `### <标题>`；文末模板仍写 `### C-XX`，跟最近一条走即可；参数改动**同时**登记「参数变更总表」）、`CODE_REVIEW_2026-10-13.md`（**P2-7 / P3×3** 是当前唯一未修清单，已修项记在 CHANGELOG「安全修复收口」与 2026-10-19 追补）、`PARALLEL_AB.md`（换实验就换/新增一节，保留「口径与边界」）、`PROVIDER_BENCHMARK.md`（有 Key 时按 §3 命令补测再回填）、`ZCODE_COMPARISON.md`（沿用「机制 / 对比 / 建议 / 顺序」四段式）。
- **新增文档要同时进两处地图**：`multi-tool-agent/README.md` §7 文档导航 + `reports/PROJECT_REPORT.md` §8 文档地图。
- **冲突裁决**：报告数字与 `multi-tool-agent/data/*.db` 或实测输出不一致时，**以数据/实测为准**（`.eval/query-billing-runs.mjs`、`.eval/query-run-detail.mjs <runId>` 取证）。

**收尾动作清单（hook 在上下文 ≥70%/85% 时注入的提醒就指向这里）。先分档，再按档执行：**

| 档 | 触发条件 | 要做 |
|---|---|---|
| **重档** | 有代码 / 参数 / 契约改动（动 `src/`、`tests/`、`src/agents/specs.ts`、默认值） | 第 1~4 步全做；生成物必须重生、门禁必须跑 |
| **轻档** | 纯文档 / skill / 注释改动 | 只做：①「当前状态」（若状态变了）② CHANGELOG 一条（追加到当日已有段）③ 提交。**不跑 `report:refresh`、不重跑测试** |

判断口诀：**生成物会不会因此变化？不会 → 轻档。**

1. 更新本文件「当前状态」（hook 每轮注入与 SessionStart 注入都指向它，是唯一扛得住压缩的通道）。
2. `reports/CHANGELOG.md` **顶部**加条目（纯文档改动追加到当日已有 `## 日期` 段，不新开段）；参数变更**同时**补「参数变更总表」；`reports/PROJECT_REPORT.md` 头部与相关节（重档必须）。
3. **重档才跑**：`npm run report:refresh` → `npm run typecheck` → `npm test` → `npm run agents:lint`，把实测数字写进 CHANGELOG 的「验证」行。本机硬约束：`npm test` / `agents:lint` 在沙箱内会 `uv_os_get_passwd ENOMEM`，需在沙箱外跑；`git add/commit` 与 `.agents/` 写入也必须在沙箱外（沙箱对 `.git`、`.agents` 加了 deny ACE）。
4. 耐久结论（「为什么」）写 `.workbuddy/memory/MEMORY.md`；当日流水写 `.workbuddy/memory/<日期>.md`；项目记忆主题文件同目录维护。
5. 流水与经验条目由 hook 自动追加（Codex 侧 `~/.codex/hooks.json` → `~/.codex/hooks/progress.py`；ZCode 侧 `~/.zcode/cli/hooks/progress.py`）：提问/收尾 → `~/.zcode/progress/<slug>.md`，Stop → `Desktop/项目经验/项目经验.md`。**只读不改。**

> **规则防腐**：本清单与报告里的条数 / 件数 / 编号（测试数、报告数量、编号）会过期。发现与实际不符时，**先改规则再干活**——没人修剪的规矩会变成新的漂移源（实测：`C-XX` 停在 C-17、报告制度曾写「三/四件套」、本文件曾写「37 个测试文件」而当时实际已 40；报告口径现统一为「核心报告集 + 专项评测」）。
**踩过的坑**
- Git Bash 传中文（curl）会乱码 → 曾误判分流器有 bug；真相是编码问题，改用 Node fetch 后 6 个用例全部符合预期。
- **同仓双写冲突（2026-10-14 实证）**：WorkBuddy 与 ZCode 同时改 `multi-tool-agent` 的同一批文件（无 git，覆盖不可回滚）。判断"对方交接完成"不能只看静默时长（3 分钟静默是假象，其实际在跑测试）——要看进展是否停在收尾动作。**协作前置条件：单一写者 + `git init`**。
- **Docker Desktop 死代理（2026-10-15）**：Docker 的 manual 代理曾指向已停的 `127.0.0.1:7890` → `docker pull` 必挂（报错形如连不上代理），曾误判成"镜像源坏了"。**已修正**：现为 `ProxyHttpMode=system`（`docker info` 显示 `http.docker.internal:3128`）；遇到拉取失败先查此项（`%APPDATA%/Docker/settings-store.json`）。
- **mcphub 容器 restart policy=no（2026-10-15）**：`samanhappy/mcphub` 容器（`epic_satoshi`）重启策略为 `no`，宿主机重启后**不会自己回来**，需手动 `docker start <name>` 拉回（实测 `docker inspect` → `RestartPolicy.Name=no`）。
- **沙箱账户自有 `.agents/` 会锁死沙箱（2026-10-16 实证）**：仓库级 skill 根 `.agents/skills` 若由沙箱账户 `CodexSandboxOffline` 创建，Windows 沙箱 setup 给它加 deny ACE 时失败（日志 `deny ACE failed on <repo>\.agents: open deny ACL target for update`）→ 之后**每条命令**都失败（`helper_unknown_error: setup refresh had errors`；`codex doctor` 报 sandbox 结构化失败）。修复：删除 `.agents/` 后用**非沙箱**方式重建（属主回到本人）；非提权 shell 里 `takeown` 会报无 ownership 权限。证据：`~/.codex/.sandbox/sandbox.<date>.log`、`setup_error.json`。
- **PowerShell 批量改这批文件：锚点必须按 CRLF（2026-10-16 实证）**：`src/`、`tests/`、`public/index.html`、`reports/*.md` 都是 **CRLF + UTF-8 无 BOM**，踩了两坑——① 按 LF 写多行锚点 → **全部 miss**（只剩单行替换侥幸命中）；② 脚本回显文本被误写进文件首行（实测污染 `src/types.ts` 与 `src/runtime/AgentRuntime.ts` 首行，`git diff` 才看出来）。可靠姿势：读全文 → 归一化成 LF → 替换 → 还原 CRLF → `[System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($false)))`；改完核对 `CRLF/bareLF` 计数并看 `git diff` 首行。**另**：PowerShell 双引号串里反引号是转义符 → 含反引号/代码跨度的字符串一律用单引号 here-string `@'...'@`。
- **~~`npm test` 会写 `data/runtime.db`~~（2026-10-19 已修）**：此前每次套件新增 **3 条 mock run**（codebase「g」+ research「g」+ research「比较两个打包器」）→ `AGENT_REPORT.md` 的 Mock 计数与环比随测试次数漂移（历史已累计数百条）。已把 `tests/19_streaming` 的 19g/19h/19i 改为 `config.sqlitePath = ':memory:'`，单跑 9/9 后库计数不变。历史噪声保留、不自动清理；`reports/runs/` 仍随按需生成增长，已 `.gitignore` 不入库。
- **`apply_patch` 会把 CRLF 转成 LF（2026-10-16 实证）**：本仓 `core.autocrlf=true`，所以 `git diff` 只看真实改动（不会整文件刷屏），但**工作区行尾会被整体改成 LF**（要到下次 checkout 才回 CRLF）→ 用 `apply_patch` 改 `src/`、`tests/`、`reports/*.md` 后要还原行尾（读全文 → 归一化 LF → 还原 CRLF → `UTF8Encoding($false)`）。另：`.bat` 包装的 `apply_patch` 收不了多行参数（报 `The last line of the patch must be '*** End Patch'`）→ 直接调 `codex.exe --codex-run-as-apply-patch <patch>`，或走上面的 PowerShell 归一化替换。
