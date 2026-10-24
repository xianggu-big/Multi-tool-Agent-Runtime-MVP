# 项目报告（PROJECT_REPORT）

> **一页读懂**：这个 Runtime 现在能做什么、实测到什么程度、哪里还不可靠、下一步该做什么。
> **更新方式**：每次有实质改动就更新本文件（配合 `reports/CHANGELOG.md` 的明细）。
> **最后更新**：2026-10-23 ｜ 对应测试规模：**67 个测试文件 / 444 个子测试（444 通过 / 0 失败 / 0 跳过）**；Docker 已启动，`40j` 已补跑通过；`eval:edit` 7/7 ｜ 参数现状见 `reports/PARAMETERS.md`
> **真实端到端（2026-10-23）**：`npm run mcp:e2e`（真模型自主调用 MCP）与 `npm run e2e:write`（HTTP → 沙箱 → 审批 → 落盘 → 宿主复验）均 PASS；证据、token/耗时与边界见 `reports/MCP_WRITE_E2E.md`。**样本=各 1 次，不外推成功率**。
> **项目工具**：`.agents/skills/{mta-verification,mta-reporting}/`（仓库级 Codex skill：验证/复跑流程、核心报告集 + 专项评测 + 收尾清单）
> **安全审查**：2026-10-13 全面代码审查 + 对抗性测试（`reports/CODE_REVIEW_2026-10-13.md`）；**P0×2、P1×4 与 P2-1~P2-6 已修复并转为回归守卫（2026-10-19 收口）**，剩 P2-7（无鉴权，README 已声明仅本机）/ P3×3
> **写能力**：2026-10-15 新增「沙箱 + 三级人工审批」受控写能力（M1）；2026-10-16 **M1' 接入 UI**（「允许修改文件」开关 + 修改意图确认对话框 + `allowWriteSpecs` 完整接线）；边界与缺口见 §4 R14/R15，验收与证据见 `docs/WRITE_AND_APPROVAL.md`
> **编辑评测**：`npm run eval:edit` 是 7 个确定性管线场景 **7/7**（真 Docker / 真审批 / 真落盘 / 宿主复验 / 回滚 / TOCTOU；`reports/EDIT_EVAL.md`，tokens=0，衡量**管线**）；`npm run eval:edit:real` 是 26 条真实模型任务 **26/26（L2 26/26）**，含 20 条引导 + 4 条盲测 + 2 条多文件，833,082 tokens / \$0.0248，单轮 95% Wilson 下界 **87.1%**（`reports/EDIT_EVAL_REAL.md`，衡量**模型在该管线里的完成能力**，仍不外推大型重构）。
> **安全评测**：`npm run security:redteam` 已建 42 条固定样本（恶意 / 正常 / 已知缺口），当前恶意检出 **20/22**、正常误报 **2/20**；产物 `reports/INJECTION_REDTEAM.md`。**是启发式降风险，不是“防住提示注入”**；纯 base64 / URL 编码仍漏检。
> **高危审批**：删除 / 宿主命令批次不复用粘性，批准还必须在当前批次勾选二次确认；Runtime 缺 `confirmHighRisk` 时不 resolve、HTTP 返回 400。回归 `tests/53k/l/m`。
> **上下文压缩（2026-10-20 修 400；2026-10-21 修 R23 质量衰减 + R25 水位语义；R24 前端复盘/压缩面板）**：M18 把切点强制对齐轮次边界（`alignCompactCut`），杜绝孤儿 tool 消息导致 OpenAI 兼容接口 400（现场 `run_mvge1343_49a18777` 第 16 步）；M22 改为**滚动摘要 + 压缩迟滞**——旧摘要原文保留、只压新增消息、首次压缩保留任务目标、活动区增长不足时不重复压；R25 把水位从「任务累计预算」改成**当前 promptTokens / 模型上下文窗口**（窗口未知才显式回退并标 `source=unknown`），`context_compacted` 与 `run_digest.compaction` 带窗口水位观测。回归 `tests/33e~33p`、`tests/56f`。真实 A/B 已完成（5 任务 × 2 策略 × 3 次 = 30 run，4K 模拟窗口）：30/30 完成、质量 100%，但 rolling 平均 tokens 比 legacy 多 1.8%、成本多 1.4%、耗时少 0.1%，未达预注册 15% 效率门槛，判定 `not_proven`（`reports/COMPACTION_AB.md`）；不声称滚动摘要更省或更快。边界：摘要上限 24000 字符后停止压缩；其余 Provider 窗口未补齐。

---

## 1. 现在能做什么（能力矩阵）

| 能力 | 状态 | 实测到什么程度 |
|---|---|---|
| **共享 Agent Loop** | ✅ 可用 | 一套循环驱动 4 个 Agent（codebase / research / misc / orchestrator），预算·权限·超时·检查点统一强制 |
| **Codebase Agent** | ✅ 可用 | 真实本地 I/O（搜索/读取/受限测试）；`run_tests` 默认**不进工具池**（白名单 + `shell:false`），界面显式勾选「允许运行测试」或 `allowRunTests:true` 才启用（2026-10-22）；未开启时不会白调一次再拿 `DISABLED` |
| **真实模型编辑（code-edit）** | ✅ 可用（小任务/小规模多文件） | Docker 沙箱 + 自动 `allow_once` + 宿主 L2 + 源码断言；26 条任务 **26/26**、L2 **26/26**（20 引导 / 4 盲测 / 2 多文件）、833,082 tokens / \$0.0248 / 平均 22.7s，单轮 95% Wilson 下界 **87.1%**。仍不外推大型重构或需人工澄清的需求 |
| **Research Agent** | ✅ 可用 | `fetch_page` 真实网络（仅 mock 单测验证 SSRF/重定向）；`web_search` 默认 OFFLINE_MOCK |
| **Misc Agent（杂项）** | ✅ 可用 | 只读清点/定位/小文件解释；结构化结论（`submit_result`）；超范围 → `escalateTo` |
| **多 Agent 编排** | ✅ 可用 | 主 Agent 拆分 → 并行派发 → 汇总核验；真实 DeepSeek 实测 **4/4 子任务成功**（27s / 13.8k tokens / \$0.0014） |
| **人机协同（ask_user）** | ✅ 可用 | 模型缺少关键信息时调用 ask_user 显式暂停：run 进入 awaiting_user（不再伪装 completed），问题落库并在 UI 展示；回答后以新一轮任务 + contextHistory 继续。回归 tests/48 |
| **实时流式展示** | ✅ 可用 | 思考逐字 + 工具卡片 + **tool_call 首帧骨架提前渲染**；「产生→推送」延迟 P50=P95=**0ms**（max 1.0ms）；服务端增量按 span/channel 合并约 24ms，前端事件流跳过 `llm_delta`、上限 500 条、文本增量 append、滚动 10fps（修“画面突然卡死”）。**真实 Edge 5 万条 burst 对照**：阻塞 731→**217ms**、DOM 节点 261,245→**300**（`reports/UI_STREAM_PERF.md`；6,000 条量级新旧都 <300ms，不宣称更快） |
| **可视化监控** | ✅ 可用 | 流程图 + SVG 瀑布图；子任务并行 span 直接可见 |
| **LLM 多 Provider** | 🟡 DeepSeek 已验证 | 7 个预设（deepseek/openai/qwen/moonshot/zhipu/ollama/custom）；**仅 DeepSeek 做过真实端到端** |
| **参数体系（Token/调参）** | ✅ 可用 | 界面可配 max_tokens / 任务 Token 预算 / 费用预算 + 6 个生成参数；越界即报错不静默改值 |
| **契约文档（AGENTS.md）** | ✅ 可用 | 从 `src/agents/specs.ts` 生成，`npm run agents:lint` 做漂移门禁（实测能抓出权限超集） |
| **错误报告** | ✅ 可用 | 四要素（位置/类型/码/上下文）+ 三落点（事件 / JSONL / API）+ 浏览器错误上报 + **按 `code+location` 聚合视图**（`/api/errors?view=summary`，前端「错误」页签，浏览器实测）；**模型调用失败（`source:provider`）2026-10-20 起才真正上报**，context 带 `status/step/messageCount/suspect`（协议类 400 标 `invalid_message_sequence`）；子 Agent 内的模型失败仍未单报（`docs/ERROR_REPORTING.md` §2.7） |
| **复盘摘要（run_digest）** | ✅ 可用（2026-10-20） | **每次 run 终态都自动写**（completed / failed / limit_reached / cancelled / awaiting_user / 启动回收的 RUN_INTERRUPTED）：结论 + 计数 + **过程问题聚合**（`tool_failed` / `runtime_error` / `subtask_failed` / 审批拒绝 / L2 验证失败 / 回滚 / 注入命中）+ `firstIssue` + 一句话 `headline`；三落点（`run_digests` 表 / `data/run-digest.jsonl` / `run_digest` 事件）；查看 `npm run digest:list`、`GET /api/digests`、`GET /api/runs/:id/digest`。回归 `tests/56`（5 例）。详见 `docs/RUN_DIGEST.md` |
| **复盘 / 压缩面板** | ✅ 可用（2026-10-21，R24） | 前端「复盘」页签：问题优先/全部、状态/类型/条数筛选；左侧摘要列表 + 右侧详情（结论/计数/首个问题/过程问题表/原始 JSON）；压缩卡片展示次数、移除消息、深度、摘要字符、水位及来源、prompt/window、触顶；实时 `context_compacted` 卡片 + `run_digest` 自动刷新。回归 `tests/59`（3 例）；Edge headless 实测 |
| **单 run 报告（流程图 + 量化归因）** | ✅ 可用 | 把单个 run 的 `events` 有序流 + span 树 + `resultJson` 机械渲染成一份报告：Mermaid 流程图（主流程 + 子任务）/ **分层量化**（主 Agent vs 子任务合计）/ 分步·子任务·工具聚合 / **六阶段归因**（每阶段 ok/gap/fail/na + 证据 seq）/ 缺口与未解决项；`npm run report:run -- <runId>` 或 `GET /api/runs/:id/report`。**只读渲染，不改执行逻辑**；实测生成 322 份 |
| **任务分流** | ✅ 可用 | 规则式（不调 LLM）：琐事→misc、多分区只读→编排、改代码→codebase、调研→research；破坏性动作标 `requiresHuman` |
| **子 Agent 生命周期** | ✅ 可用 | importance 三档（ephemeral/session/durable）+ 七条释放判定 + LRU 池驱逐；一次性任务结果采纳即释放、审计类保留供追问（`SubAgentLifecycle.ts`，31 测试） |
| **知识库语义召回** | ✅ 可用 | FTS5 原生 MATCH（AND 语义）与 vec0 kNN **均已实测生效**（`available=true, vectors=2`，回归守卫钉死原生可用性）；LIKE / 内存余弦为显式兜底 |
| **知识库语料导入** | ✅ 可用（2026-10-23） | `npm run ingest:docs`（`scripts/ingest-docs.ts`）读 `.md/.mdx/.txt/.jsonl` **正文**：Markdown 按标题切节 + 段落打包（`--max-chars` 默认 3000）、jsonl 一行一条且长文切块；支持 `--exclude` / `--replace`（三表一起清）/ `--build-index`（导入后立即建索引）。实测真知识库 **979 条**（docs 359 / reports 395 / runs 223 / notes 2），冷启动建索引 **1,107 chunks**（持久化前 52.3s → 持久化后 **254ms**）；LCC 2000 条压测：导入 19s、RAG 构建 3004 chunks / 210s（≈70ms/chunk，CPU Ollama）。详见 `reports/RAG_IMPROVEMENT_2026-10-23.md` §8.11 |
| **切块级 RAG（chunk + 混合检索 + rerank）** | ✅ 可用 | **索引持久化（2026-10-23）**：chunk 正文 + 向量落 `rag_chunks`，按 `doc_hash` 增量刷新、指纹（模型/维度/切块）变化才全量重建；重启重建 **254ms / 0 次 embedding**（持久化前 52.3s），回归 `tests/68`。检索仍为内存 BM25 + Flat（5 万文档量级需下沉）。文档 → 512/64 切块（`text` 可精确按偏移切片，标题只进 `embedText`）→ embedding（离线 hash 默认；设 `MTA_EMBEDDING_MODEL` 切真实模型）→ BM25 + Flat/HNSW/IVF（支持删除/upsert）→ RRF/加权融合 → rerank（尾部短块按原文区间合并，overlap 不重复）；`POST /api/rag/rebuild`（分页、上限 5 万文档）、`GET /api/rag/search`、Agent 工具 `knowledge_search`；`npm run rag:bench` / `rag:ablation` 产出 `reports/RAG_EVAL.md` / `RAG_ABLATION.md` |
| **MCP（server + client + 桥接 + 主路径配置 + 安全/运维）** | ✅ 可用 | stdio / Streamable HTTP（客户端增量解析 SSE + `Mcp-Session-Id`）两种 transport；`initialize → tools/list → tools/call`；`registerMcpTools()` 把外部工具变成普通 Tool（JSON Schema 原样暴露，权限 `mcp:call`，风险按 annotations 推断）；取消信号可穿透到 `notifications/cancelled`（客户端超时也会主动发 `reason:'timeout'`）；`POST /mcp` / `DELETE /mcp`。**主路径可配**：`MTA_MCP_SERVERS`（JSON 数组 + `names` 白名单）→ `McpClientRuntime` 并行连接 → 按 runType 进工具池；`GET /api/mcp` 安全状态；单 server 失败只报 `MCP_UNAVAILABLE`。**2026-10-23 补安全与运维**：`destructiveHint=true` 默认必须人工批准（无审批通道 → `MCP_APPROVAL_REQUIRED`；拒绝不执行），`POST /api/mcp/reconnect` 可把 error 恢复为 ready 且不产生同名工具冲突。**真实 MCPHub 0.12.10 已 E2E**（54 工具 / 104ms）；**真实 DeepSeek 已自主选择 MCP 工具**（`npm run mcp:e2e`，3,756 tok / 2.8s）。回归 `tests/44` + `tests/64` |
| **编排预筛闸门** | ✅ 可用 | 自动分流先估算「单上下文是否装得下」+ 多信号（交叉验证/分区审计/并行）；装得下就不默认编排。显式编排不强制降级，但 gate 写入响应/`run_started`/系统提示，可解释「为什么没拆」。回归 `tests/65`；**未重做真实 A/B** |
| **读文件台账** | ✅ 可用 | `run_digest.readStats`：`read_file` 总次数 / 去重路径 / 重复次数 / Top 重复路径；前端复盘面板可见。只观测，不承诺省 token；回归 `tests/56g` |
| **子任务历史统计** | ✅ 可用 | `GET /api/subtasks/stats` + `npm run stats:subtasks`：按 spec 聚合成功率/平均耗时/token，默认排除 Mock；零迁移（聚合 `runs.resultJson`）。回归 `tests/67` |
| **Function calling 控制** | ✅ 可用 | `tool_choice`（auto/none/required/指定函数）与 `parallel_tool_calls` 按 run 透传，HTTP 层校验非法值/白名单（400）；forced tool 不在本 run 工具池时执行前直接 `INVALID_TOOL_CHOICE`（不调用模型）；同轮多工具走工作池并发（`maxToolConcurrency`） |
| **慢回答诊断** | ✅ 可用 | `GET /api/runs/:id/diagnosis`：wall vs busy、模型/工具 sum vs union、并发节省、首 token、按 step 的 token/cost 热点与建议；TTFT 仅实时事件可得（`llm_delta` 不落盘） |
| **模型调用重试预算** | ✅ 可用 | 429/5xx/网络瞬断/流空闲 指数退避重试，默认 2 次；流式吐过增量则不再重试防重复 |
| **上下文压缩** | ✅ 可用 | **当前 prompt 占模型窗口 ≥60%** 时滚动压缩（保留 system+最近 6 条）；窗口未知时才回退累计预算并标记 `source=unknown`。真实 A/B（30 run，4K 模拟窗口）质量无回退，但效率未达 15% 门槛，结论 `not_proven` |
| **工具并行波** | ✅ 可用 | 同一轮 4 个工具并发执行（总耗时≈单工具），带预算检查/错误隔离/单工具重试 |
| **`@` 文件上下文引用** | ✅ 可用 | goal 输入框支持 `@相对路径`，后端注入「优先读取这些文件」提示（去重/上限 20） |
| **受控写能力（沙箱 + 三级审批）** | ✅ 可用（UI 显式授权） | 5 个写工具 + `submit_changes` 批量提交；改动**只在 Docker 沙箱暂存并跑检查阶梯**（L0 语法 / L1 `tsc --incremental`+受影响测试/全量兜底）→ 一次批量人工审批（`allow_file`/`allow_once`/`deny`）→ 落盘（TOCTOU 哈希守卫+备份+原子写）→ **宿主复验**（钉死系统 Node 24，失败自动回滚）。真实模型端到端实测：deny 不落盘 / allow 落盘且 `hostVerify{ran:true,ok:true}`（`docs/WRITE_AND_APPROVAL.md` §3）。**M1'（2026-10-16）**：界面「允许修改文件」开关显式授权本 run（默认不勾）+ 修改意图确认对话框 + 审批卡滚入高亮；部署可 `CODEBASE_WRITE_ENABLED=false` 整机禁用（UI 显示被禁用） |
| **编辑管线评测** | ✅ 可复现 | 7 个场景：正确修复 / 批量新增 / 语法拦截 / 测试拦截 / 审批拒绝 / 宿主红回滚 / TOCTOU 拒写；`npm run eval:edit` 真 Docker 跑，**7/7 命中预期**（5 次审批 / 4 文件落盘 / 1 回滚） |
| **验证闭环（L1/L2 + 证据）** | ✅ 可用 | 沙箱阶梯全链路异步（不再阻塞事件循环）；`strictVerify=true` 在审批前跑 L2；终态 run 可手动 `POST /api/runs/:id/verify`（排队/运行/通过/失败/取消 + 全局并发 1），`GET /api/runs/:id/verification` 查询；`verification_*` / `change_applied` / `change_rolled_back` 事件可在 UI 与报告归因；回归 `tests/49`/`50`/`41h` |
| **崩溃对账 / 恢复** | ✅ 可用 | 落盘前写 `apply-journal`（base/work 哈希 + 每文件状态），启动扫描 `data/backups/*` 判定 `applied/not_applied/missing/conflict/unknown`；只对中断 run 生效，自动恢复仅限「编辑 + 文件消失 + 有备份」，已落盘编辑/新增不自动回滚；`GET /api/runs/:id/recovery` + `POST .../rollback|accept`；UI 恢复卡；回归 `tests/51`（7 例，含真实进程 SIGKILL）+ `38g2/38g3` |
| **验证能力探测（防止误回滚）** | ✅ 可用 | 落盘后按仓库能力选择 `full_suite` / `typecheck` / `unavailable`；无测试仓库不再因固定 `tests/*.test.ts` 必然失败而回滚，但会明确标注「未经任何行为验证」；不自动执行 jest/vitest 等任意 `npm test`。回归 `tests/52`（6 例） |
| **提示注入边界** | 🟡 降风险 | 不可信工具输出扫描中英文/少量多语言注入特征；命中后写 `untrusted_content_flagged`（样本脱敏）、run 打污点、禁用粘性自动放行；模型上下文追加独立边界消息；审批卡显示安全警告。**删除 / 宿主命令批次即使人工选择 `allow_file` 也不进入粘性集合**（`stickySkipped`），批准前还须完成当前批次二次确认（Runtime + HTTP fail-closed）。红队 42 样本：恶意检出 20/22、正常误报 2/20。**是启发式，不是彻底防御**；回归 `tests/53`（13 例）+ `tests/16` |

**明确不可用 / 刻意不做**：**主 Agent 的写权限**（写 spec 只能由编排派发、且默认关闭）、任意 Shell（写路径只走白名单化的 `run_command` + `submit_changes`）、跨进程分布式调度、子 Agent 自由对话、深层递归（>1 层）、exactly-once 语义、完整人工调度接口（改派/暂停）、`SubAgentLifecycle` 运行期接线（已实现、未接线）。

---

## 2. 关键指标（都是实测，不是估算）

| 指标 | 数值 | 来源（可复现命令） |
|---|---|---|
| 测试规模 | 63 文件 / **422 子测试（422 通过 / 0 失败 / 0 跳过 / 约 17s；Docker 已启动）** | `npm test` |
| 单 run 报告 | 322 份一次生成 / 六阶段归因 / 真实样本合计 44,100 tok（主 15,661 + 子 28,439） | `npm run report:run -- --all` |
| 类型检查 | 0 错误 | `npm run typecheck` |
| 契约门禁 | 3 项通过（自校验 / 文档漂移 / 工具存在性） | `npm run agents:lint` |
| SSE 推送延迟 | P50=P95=**0ms**，max 1.0ms（帧间隔 p50 9.4ms） | `npm run smoke:stream` |
| **多 Agent（真实模型）** | 4/4 子任务成功 · 27.0s · **13.8k tokens** · **\$0.0014** | `LLM_MODE=openai` + `src/demo/orchestrator.ts` 同型任务 |
| 多 Agent（修复前对比） | 1/6 成功 · 70.4s · 50.6k tokens · 22 次失败调用 | 见 `docs/ERROR_REPORTING.md` 事故复盘 |
| LLM 缓存命中 | 单 Agent 4 次调用 **70.9%**（3430→2432 tokens） | `npm run smoke:llm` |
| 费用估算准确性 | 由固定 \$1/1M（高估约 20×）改为按预设表价 + 缓存价 | `PARAMETERS.md` §1.2 |
| 工具参数错误率 | 22 次失败调用 → **4 次**（且均可自愈） | 同上事故复盘 |
| 模型调用重试预算 | 429/5xx/网络瞬断 自动重试 2 次；流式吐过增量不重试 | `tests/31_retry_budget.test.ts` |
| 上下文窗口压缩 | 当前 promptTokens/contextWindow ≥60% 时触发，保留 system+最近 6 条；窗口未知显式回退 | `tests/33_compact_messages.test.ts` |
| **上下文压缩 A/B（真实）** | rolling vs legacy：30/30 完成、质量 100%；rolling tokens 多 1.8%、成本多 1.4%、耗时少 0.1%；判定 `not_proven` | `npm run eval:compaction`；`reports/COMPACTION_AB.md` |
| 工具并发 | 4 工具同时执行，总耗时 94ms（≈单工具 80ms+原始开销） | `tests/34_tool_parallel_wave.test.ts` |
| **并行收益 A/B（真实）** | 同任务同顶层预算：串行 **39.4s/221k tok/$0.0096**（完成）vs 编排 **243.7s/1.56M tok/$0.083**（完成）；**编排约 7× token 未回本** | `reports/PARALLEL_AB.md`（runId 可复现） |
| Provider 实测 | DeepSeek ✅（2 步 / 1,737 tok / $0.00011 / 2.6s / 缓存命中 72.6%）；其余 4 家待配 Key | `reports/PROVIDER_BENCHMARK.md` |
| 错误聚合 | `/api/errors?view=summary` 按 code+location 计数 + 前端「错误」页签（浏览器实测通过） | `tests/24_error_reporting.test.ts` 24n/24o |
| **受控写能力（真实模型端到端）** | deny：1 次审批 → 拒绝 → **仓库无变化**（$0.0005 / 7.3k tok）；allow：审批通过 → **落盘成功 + `hostVerify{ran:true,ok:true}`（宿主全量套件通过）**（$0.0004 / 7.1k tok） | `docs/WRITE_AND_APPROVAL.md` §3；`.eval/m1-e2e-drive.mjs` |
| **崩溃对账（真实 SIGKILL）** | 5 态判定 + 启动自动恢复消失文件 + 手动回滚已落盘 + 冲突文件不覆盖 + 旧日志人工比对；独立进程在 `rm` 后/`rename` 前真实 `SIGKILL`（Windows exit=1），启动扫描恢复并清理 tmp | `tests/51`（7 例）；`docs/WRITE_AND_APPROVAL.md` §3.9 |
| **验证降级** | 有 Node 测试→全量；有 tsconfig+tsc→类型检查；都没有→`unavailable`（不阻断落盘、明确标注未经行为验证） | `tests/52`（6 例）；`docs/WRITE_AND_APPROVAL.md` §3.10 |
| **提示注入边界** | 中英文/少量多语言特征命中→事件 + run 污点 + 禁用粘性自动放行；删除 / 宿主命令批次不进入粘性，且须当前批次二次确认；审批卡安全警告；正常技术文本仅剩 2 条已知误报 | `tests/53`（13 例）；`docs/SECURITY_BOUNDARIES.md` |
| **提示注入红队** | 恶意 20/22（90.9%）；正常误报 2/20（10.0%）；总体 38/42（90.5%）；已知漏检 m21 纯 base64 / m22 URL 编码，已知误报 b19/b20 安全文档提到攻击短语 | `npm run security:redteam`；`reports/INJECTION_REDTEAM.md` |
| **首跑自检** | Node 24 / 宿主 Node / sqlite-vec / 数据目录 / 端口 / Docker 镜像 / Key；有 fail 退出 1 | `npm run doctor`；`tests/54`（6 例） |
| **复盘摘要覆盖** | 每次终态 1 条（DB + JSONL + 事件）；**成功也写**、失败优先；历史 run 不回填 | `tests/56`（5 例）；`npm run digest:list` |
| **复盘 / 压缩面板** | 前端「复盘」页签：问题优先筛选、摘要详情、过程问题聚合、压缩观测（水位/来源/窗口/触顶）；本机 Edge headless + CDP 实测 | `tests/59`（3 例）；`public/index.html` |
| **编辑管线评测** | 7/7 命中预期；5 次审批 / 4 文件落盘 / 1 回滚；沙箱 5/7 通过（E3/E4 故意失败）、宿主 2/3；平均 12.7s / P95 14.1s；tokens=0 | `npm run eval:edit`；`reports/EDIT_EVAL.md`（2026-10-22 重跑） |
| **真实模型编辑评测** | 26/26 通过；L2 26/26；26 次审批；20 引导 / 4 盲测 / 2 多文件；833,082 tokens / \$0.0248 / 平均 22.7s；单轮 95% Wilson 下界 **87.1%**（DeepSeek Flash） | `npm run eval:edit:real -- --tasks=26 --budget-usd=1 --timeout-ms=240000`；`reports/EDIT_EVAL_REAL.md` + `EDIT_EVAL_REAL_EVIDENCE.json` |
| **写能力 UI 链路（真实模型，M1'）** | 界面语义（`orchestration.allowWriteSpecs=true`，不带白名单）→ 派发 code-edit → 沙箱建文件 → **审批卡** → `allow_once` → **落盘 + `hostVerify{ran:true,ok:true}`**（run_mvanz941_6f0f72ff） | `.eval/m1-e2e-out/EVIDENCE.md`「M1'」节；`reports/CHANGELOG.md` 2026-10-16 M1' |
| 沙箱阶梯（真 Docker） | 容器内 L0 语法 + L1 `tsc --incremental` + 全量测试兜底：**17.1s / 全绿**；容器内套件 269 pass / 1 skip（Docker 用例在容器内无守护进程）/ 0 fail | `.eval/m1-ladder-probe.mjs`、`tests/40` |

---

## 3. 参数现状（摘要，完整见 `PARAMETERS.md`）

| 类别 | 当前关键值 |
|---|---|
| LLM | 模式 `mock`（可切 `openai`）；预设 **deepseek**；模型 `deepseek-flash`；Key ✅ 已配置 |
| 生成参数 | `maxTokens 2048` / `temperature 0` / `thinking enabled` / `effort low` |
| 全局预算 | 12 步 / 20 模型调用 / 40 工具调用 / 20 万 token / 120s |
| 杂项 Agent | 6 步 / 6 模型调用 / 10 工具 / 5 万 token（**硬上限 12 步**） |
| 编排 | 宽度 4 × 并发 4 × 深度 1 / 结果 800 字符；主 Agent 20 万 token；子 Agent 预算独立 |
| 子 Agent 预算 | dir-inventory 8/8/16/60k · code-audit 12/12/24/120k · doc-research 8/10/16/80k |
| 实时流式 | 增量开；Mock 分片延迟 25ms；心跳 15s；看门狗 2s |
| 错误报告 | `./data/errors.log`（JSONL） |
| 复盘摘要 | `RUN_DIGEST_PATH` 留空 = 跟随 SQLite 目录（`<dataDir>/run-digest.jsonl`）；`:memory:` 不落盘 |
| 重试预算 | `retryBudget=2` / `streamIdleTimeoutMs=30000ms` |
| 上下文压缩 | 触发阈值 `0.6`（当前 prompt / 模型窗口）/ 保留最近 `6` 条 / 摘要上限 24000 字符 |
| 写能力（M1/M1'） | 门禁 `CODEBASE_WRITE_ENABLED`（**默认 true**，可显式 false 整机禁用）；本 run 授权 `orchestration.allowWriteSpecs`（界面「允许修改文件」开关，默认不勾）；审批 `APPROVAL_ENABLED=true` / 超时 `300000ms`（超时按拒绝）/ 连续拒绝上限 `3`（按文件）/ 单批文件上限 `10` |
| 沙箱 | 镜像 `mta-sandbox:node24`；宿主复验 Node 路径 `D:/Program Files/nodejs/node.exe`（P1-8 钉死）；单命令超时 `SANDBOX_EXEC_TIMEOUT_MS=600000` |

---

## 4. 风险与缺口（诚实清单，按优先级）

| # | 风险 / 缺口 | 影响 | 建议动作 |
|---|---|---|---|
| R1 | 除 DeepSeek 外的预设未实测（本机仅配置 DeepSeek Key） | 换 Provider 可能需现场调试 | 复现命令已固化在 `reports/PROVIDER_BENCHMARK.md` §3，配 Key 即跑 |
| R2 | ~~并行真实收益未量化~~ → **已量化（2026-10-14）**：同任务下编排约 7× token / 6× 墙钟，**未回本**。**2026-10-23 已加预筛闸门**（自动分流装得下就不编排），但**未重跑 A/B**，不能说「成本已解决」 | 默认走编排会显著烧钱 | 结构性缓解已上线；需要用真实任务重跑 A/B 才能给出新的成本比 |
| R3 | `web_search` 默认离线资料；真实搜索未验证 | 调研结论可能来自离线样本 | 配 Serper Key 后实测 |
| R4 | 子 Agent 不可恢复（独立精简循环，无检查点） | 长时子任务失败需整体重派 | 子任务加检查点 OR 限定子任务时长（当前 90~150s） |
| R5 | ~~错误报告不聚合~~ → **已解决（2026-10-14）**：`/api/errors?view=summary` 聚合 + 前端「错误」页签 | — | 剩余：无告警（可加阈值触发） |
| R6 | `evidence` 未绑定文件版本（只记 `file:line`） | 文件改动后旧结论不会失效 | evidence 加内容哈希或 mtime |
| R7 | 子任务不单独落库（存 `runs.resultJson` + 事件） | 跨 run 查"某 spec 历史成功率"原先要扫事件 | **2026-10-23 已有零迁移聚合**（`/api/subtasks/stats`，默认排除 Mock）；样本变大后再考虑建 `subtasks` 表 |
| R8 | 前端无鉴权、HTTP 明文 | 仅可本机使用 | 保持不暴露公网；需要时加 token 鉴权 |
| R9 | `confidence` 未标定（模型自报）→ 只作软提示 | 不能作为硬门控 | 要做硬门控需先标定 + 监控升级率 |
| **R14** | **写能力边界与诚实清单**（M1，须如实披露）：① 容器内**无网络隔离**（`run_command` 可联网）；② `run_command` **落宿主后的副作用无法从沙箱同步**，只能靠 git/备份兜底（审批卡已标注）；③ **Linux 沙箱 ≠ Windows 宿主**：靠 L2 宿主复验 + 失败自动回滚，环境性失败标 `ENV_MISMATCH`（不算模型改错）；④ 沙箱快照走 `docker cp`（src+tests ≈1MB；node_modules 走镜像不进快照）；⑤ **重派次数 × 3 轮重试的最坏成本存在**（交接 brief 只保证不重复劳动，不承诺不烧 token）；⑥ 本里程碑**不做**主 Agent 写权限、完整人工调度接口（改派/暂停）、`SubAgentLifecycle` 运行期接线（如实标注"已实现、未接线"） | 使用者需知道"能写"不等于"安全无边界" | 明细与验收证据见 `docs/WRITE_AND_APPROVAL.md` §0 诚实清单 / §3 |
| **R15** | **写能力残余缺口（2026-10-15 终验实测；①③④⑤ 已修，② 已于 2026-10-19 收口）**：① ~~`read_file` 读**真实仓库**而非沙箱副本~~ → **已修（2026-10-16）**：写上下文优先读 `readWorkFile`（副本 / 回落真实仓库 / 已删三态）；回归 `tests/38i`；② ~~L2 全量阶梯无触发点~~ → **已修（2026-10-19）**：`strictVerify` 审批前 L2 + 终态 run 手动 `POST /api/runs/:id/verify`（异步、可取消）；回归 `tests/50`；③ ~~粘性 `allow_file` 未被真实 run 触发~~ → **2026-10-16 真实 run 已触发**（`run_mvamz4w4_b27c6bf6`：两次提交 → 1 次人工审批 + 第二次 `sticky-policy` 自动放行）；④ ~~同步 `spawnSync` 阻塞事件循环~~ → **已修（2026-10-19）**：`spawnAsync` + 异步 Docker/快照/阶梯；回归 `tests/49`；⑤ ~~审批语义无单测~~ → **已补**：`tests/38j/k/l` | 影响体验与可测性（已全部收口） | 后续优先级转向评测集、子任务去重、编排门槛（见 §5） |
| **R16** | **run 可见性口径**（2026-10-16 部分修复，源：2026-10-15 记账首轮 run 复核）：① ~~`limit_reached` 被并进 `cancelled` → headline 看起来「0 失败」~~ **已修**（独立成桶 + `gaps` 计数 + UI「缺口 N」徽标）；② ~~顶层计数器不含子任务消耗（t3 看不见 16 次工具调用）~~ **已修**（新增 `subtaskUsage` 合计）；③ ~~run 阻塞于「待用户回答的问题」时状态仍是 `completed`（无可区分状态/徽标）~~ → **已修（2026-10-19）**：新增 `ask_user` 终结性工具 + `awaiting_user` 终态 + `run_awaiting_user` 事件；问题结构化落库（`resultJson.awaitingUser`）并在 UI 展示，回答后以新一轮任务继续 | 残余：只识别**显式工具调用**；模型若只在正文里提问，run 仍是 `completed`（见 `docs/HUMAN_IN_THE_LOOP.md` §6） | 后续可做 `answer + resume`（需先持久化完整 RunInput） |
| **R17** | **`npm test` 会写 `data/runtime.db`**（2026-10-16 实测，**2026-10-19 已修**）：每次套件新增 3 条演示型 mock run（codebase「g」+ research「g」+ research「比较两个打包器」）→ `AGENT_REPORT.md` 与 `reports/history/*.json` 的 Mock 计数、环比随测试次数漂移（历史已累计数百条） | 报告口径曾被测试噪声污染，环比数字不能直接当趋势读 | **已修**：`tests/19_streaming.test.ts` 的 19g/19h/19i 改用 `config.sqlitePath = ':memory:'`；单跑 9/9 后库内三类记录数保持不变。历史噪声保留，不自动清理 |
| **R18** | **跨 runType 对话历史混淆**（2026-10-16 RUN_REVIEW 发现）：`contextHistory` 注入最近对话时**不标 runType** → 换模式后模型以自己工具列表为唯一事实，把别的模式真实做过的事判为"编造"（实测：codebase 误自认"委派是编的"；orchestrator 被历史带偏、连自己持有的工具都否定）。**已修（2026-10-16 同日）**：① 前端每轮标注 `[模式:xxx]`；② 服务端注入「历史对话说明」消息（能力以本次工具列表为准）——回归 `tests/29a`/`30d`；残余 = 子任务跨轮可见性（RUN_REVIEW §6 I2） | 用户信任受损（错误道歉链）；"委派/编排"真实性被误解 | ③ 子任务跨轮可见性（未做）；后续观察跨模式误认是否消失 |
| **R19** | **崩溃恢复边界**（2026-10-20）：只覆盖**落盘窗口**（apply-journal 写入后、change_applied 前），不覆盖模型执行中断后的对话恢复；自动恢复只处理「编辑 + 文件消失 + 有备份」，已落盘编辑/新增必须由用户明确回滚；旧日志/损坏日志只做人工比对；单写者前提（无跨进程文件锁）。`tests/51g` 已用独立进程在 `rm`→`rename` 窗口真实 `SIGKILL`（Windows exit=1） | 不能宣称 exactly-once；多实例/共享仓库需另做锁与租约 | 若做多实例：加 apply 锁 + 租约 + 启动对账；若要覆盖执行中断：持久化完整 RunInput/消息历史 |
| **R20** | **提示注入只做启发式降风险**（2026-10-20）：42 条固定样本测得恶意检出 20/22、正常误报 2/20；纯 base64 / URL 编码仍漏检，安全文档提到攻击短语会误报（b19/b20）；污点是 run 级，不是逐句 provenance；不可信内容仍会进入模型上下文。已做结构性收紧：**删除 / 宿主命令批次即使人工选 `allow_file` 也不进入粘性集合**（`stickySkipped`），且批准必须带当前批次 `confirmHighRisk`；Runtime 缺确认时不 resolve，HTTP 返回 400。 | 恶意仓库/网页仍可能影响模型判断；二次确认只证明用户做了显式选择，不证明看懂 diff；审批仍可能被社会工程 | 扩真实样本并降低误报；对「外传密钥 / 发布 / 改审批配置」做独立二次确认/能力令牌；长期做来源级 provenance / 只读摘要。`security:redteam --strict` **暂不接 CI 硬门禁** |
| **R21** | **无测试仓库的「验证真空」**（2026-10-20）：`unavailable` 不阻断落盘，只保证文案诚实；`typecheck` 只证明类型通过，不证明行为正确 | 用户可能把「没报错」误读成「已验证」 | 结果/UI 已标注 mode/coverage；后续可加「必须验证才允许落盘」严格模式；编辑评测集按仓库类型分层统计 |
| **R22** | **编辑评测的模型层覆盖**（2026-10-20 发现；2026-10-22 补真实模型层；**2026-10-23 扩盲测/多文件 + 真实 HTTP 审批**）：~~7 个确定性场景不能证明 LLM 能改对真实任务~~ → `eval:edit:real` 现有 26 条（20 引导 + 4 盲测 + 2 多文件）**26/26**、L2 **26/26**、833,082 tokens / \$0.0248；`npm run e2e:write` 另跑通真实 HTTP run + 人工审批 + 落盘 + 宿主复验（1 次，38,542 tokens / 95.7s）。仍**不覆盖**大型重构、粘性放行、取消/超时、L1 失败后重生成成功率 | 可说「受控小任务及小规模多文件在该管线中 26/26，且 HTTP 审批链路可用」，不能说「模型能重写项目」 | 残余：更多文件/更大 fixture；粘性/取消/超时 smoke；管线评测继续做 CI 门禁 |
| **R23** | **上下文压缩的「摘要套摘要」质量衰减**（2026-10-20 发现，**2026-10-21 已修**）：① ~~水位用累计 token，一旦 ≥60% 就每步都压缩，没有迟滞~~ → 现累计水位只作门禁，实际再压要求活动区 ≥2000 字符且自上次压缩后新增 ≥4000 字符或 ≥4 条消息；② ~~旧摘要被当普通消息重压、每条按 200 字符截断~~ → 现滚动摘要保留旧摘要原文，只压新增消息；首次压缩把任务目标原文写入摘要；摘要达 24000 字符上限时停止压缩并标记 `capReached`，绝不截断旧摘要。新增落盘事件 `context_compacted` + `run_digest.compaction` 观测（次数/深度/移除条数/摘要大小）。回归 `tests/33h~33l`、`56f` | 长任务早期目标与关键事实不再逐轮衰减；崩溃型 400 仍由 M18 守卫 | 残余：真实 A/B 已完成（2026-10-21，30 run），结论是 `not_proven`（质量无回退、效率未达 15% 门槛），不能外推成滚动摘要更优；摘要在 24000 字符后停止压缩（防无限增长）；前端 compaction 面板已落地（R24） |
| **R25** | **压缩水位语义错误**（2026-10-21 发现并修复）：水位原来用 `Budget.tokenBudget` + 累计消耗，把「任务总预算」当「上下文窗口」——预算大的 run 明明 prompt 很小也不压，预算小的 run 反而过早压。现改为 `lastPromptTokens / provider.contextWindow`（DeepSeek 预设 1,048,576，Mock 32,768）；窗口未知才回退累计预算并标 `watermarkSource=unknown`；usage 缺失按字符估算并标 `estimated`。回归 `tests/33m/33n/33o/33p`、`56f` | 压缩时机与真实上下文大小对齐；事件/复盘能解释「为什么压/为什么没压」 | 其余 Provider 的 `contextTokens` 未补齐（不确定就不填）；真实长任务 A/B 已完成（30 run），结论 `not_proven` |
| **R24** | **历史数据未回补 + 复盘无 UI**（2026-10-20 发现；**前端面板 2026-10-21 已落地**）：① 修复前产生的重复 seq（如 `run_mvgejh0e_3e6c9b74` 225 行/201 seq）不回补，回放观感仍差；② ~~`run_digest` 只有 DB/JSONL/事件与 CLI/API，前端暂无展示面板~~ → 已新增「复盘」页签（筛选 / 列表 / 详情 / 过程问题 / 压缩观测 / 原始 JSON；实时 `context_compacted` 卡片；`run_digest` 自动刷新）；③ 历史 398 个 run 没有摘要（接口 404 并说明，仍不回填） | 复盘可在工作台内完成；老 run 仍只能回查 events | 残余：历史数据不回填；一次性回填脚本可选；重复 seq 只影响观感，不修数据 |
> ✅ **R10–R13（原审查 P0×2 / P1×4）已于 2026-10-14 全部修复**：`run_tests` 白名单改「精确匹配 + 参数模板」；SSRF 去尾点 + DNS 解析后 IP 复核（初始目标与每个重定向目标都查）；`resume()` 补齐 `.catch` 对齐 enqueue；路径解析补 `realpath` 复核；FTS5/vec0 SQL 补 `MATCH`（原生检索实测生效）。对抗套件对应断言全部转为回归守卫（20/20），明细与取舍见 `reports/CHANGELOG.md`「安全修复收口」。
---

## 5. 下一步建议（按性价比排序）

1. **编辑评测从引导题扩到盲测/多文件（已完成 2026-10-23）**：确定性管线 7/7；真实模型 26 条任务 **26/26（L2 26/26）**，其中盲测 4/4、多文件 2/2，见 `reports/EDIT_EVAL_REAL.md`。下一步接真实 HTTP run + 人工审批 + UI 事件流 smoke，并统计部分成功/重试/回滚，不外推当前 100%。
2. **提示注入红队集（首版已完成）**：42 条样本 + `npm run security:redteam` 已落地；删除 / 宿主命令已禁用粘性复用，并要求当前批次二次确认。剩余是扩真实样本、降低安全文档误报，并对「外传密钥 / 发布 / 改审批配置」增加独立二次确认/能力令牌。`--strict` 暂不接 CI。
3. **子任务去重读取**（A/B 指出的结构性浪费）：同一 run 内多个子任务重复读同一批文件（159 次 read_file vs 串行 27 次）→ 加只读文件缓存，或让主 Agent 预读后作为 inputs 下发（见 `reports/PARALLEL_AB.md` §4）。
4. **编排门槛**：主 Agent 派发前先判"一个上下文能否装下"（预筛 + 估算），装得下就走单 Agent——避免默认编排烧 ~7× token（见 §2 指标）。
5. **CI 远端跑绿 + 10 分钟上手（已完成 2026-10-22；2026-10-23 继续验证）**：历史绿 run `39728277735`；2026-10-23 在 Linux 容器复跑 `npm ci / typecheck / agents:lint / test` 通过，新提交需再确认远端。
6. **有 Key 时跑 Provider 横评**：按 `reports/PROVIDER_BENCHMARK.md` §3 的命令逐项补齐（约 1 分钟/家，Key 只走环境变量）。
7. **code-edit 预算实测修正**：`12/12/24/120k` 仍标"待实测修正"（`specs.ts` 注释）；用本页 §2 的端到端数据点回填。
8. **`subtasks` 表 + 成功率统计**（2 小时）：看每个 spec 的历史成功率与平均耗时，为契约调参提供数据 → 解决 R7。
9. **`answer + resume` + run 报告异步触发**：`awaiting_user` 已能显式暂停并按新一轮继续；下一步持久化完整 `RunInput`，并在终态事件后异步生成报告（避免阻塞请求路径）。
10. **真实长任务压缩 A/B（已完成，2026-10-21）**：5 个任务 × 2 策略 × 3 次 = 30 run，真 DeepSeek Flash、4K 模拟窗口；30/30 完成、质量 100%，但 rolling tokens 多 1.8%、成本多 1.4%、耗时少 0.1%，未达预注册 15% 效率门槛，判定 `not_proven`。后续若要继续，应扩大任务长度/样本并允许自然重复读取，不能直接宣称滚动摘要更优。

---

## 6. 里程碑时间线（本仓库从 0 到现在的路径）

| 阶段 | 内容 | 关键产出 |
|---|---|---|
| M1 | 共享 Agent Loop + 双 Agent（codebase/research）+ Tool Registry 安全边界 | 16 场景测试 |
| M2 | 可视化监控（Trace）：span 计时 + 流程图 + 瀑布图 | `docs/TRACE_VISUALIZATION.md` |
| M3 | 实时流式展示（Live View）：思考逐字 + 工具卡片 | `docs/STREAMING_LIVE_VIEW.md`，推送延迟 0ms |
| M4 | LLM 可选式配置 + Token 限制 + **DeepSeek 真实接入** | `docs/LLM_CONFIG.md`，首次真实 API 验证 |
| M5 | 杂项子 Agent + 规则式任务分流 | `docs/MISC_AGENT.md` |
| M6 | 多 Agent 协作（编排 + 契约驱动 + 独立评审） | `designs/multi-tool-agent-harness-design-v1.md` |
| M7 | 多 Agent 故障修复 + 统一错误报告 | `docs/ERROR_REPORTING.md`，子任务 1/6 → 4/4 |
| M8 | **报告制度**：变更记录 + 参数台账（自动生成）+ 项目报告 | `reports/`（核心报告集 + 专项评测/快照） |
| M9 | **ZCode 对标优化**：重试预算 + Token 水位压缩 + 流式 tool_call 首帧 + `@` 文件引用 | `reports/ZCODE_COMPARISON.md` 5 项全部完成，234 测试全绿 |
| M10 | **安全修复收口**：审查 P0×2 + P1×4 全部修复，对抗断言「BUG 证据」→「回归守卫」 | `reports/CHANGELOG.md`「安全修复收口」；234 测试全绿 / typecheck 0 错 |
| M11 | **观测与量化**：错误聚合面板（R5）+ Provider 横评（R1）+ 并行收益 A/B（R2 结论为负） | `PARALLEL_AB.md`、`PROVIDER_BENCHMARK.md`；236 测试全绿 |
| M12 | **受控写能力**：Docker 沙箱（快照/阶梯/分类器）+ 5 写工具 + 三级人工审批 + `code-edit` 契约 + 端到端实测收口（5 处实测缺陷修复） | `docs/WRITE_AND_APPROVAL.md`（含终验复核清单 + §3 终验结果）；真机 Docker + 真实模型 deny/allow 双态实测；272 测试全绿 |
| M13 | **单 run 报告生成器**：流程图（Mermaid）+ 分层量化 + 六阶段错误归因（`npm run report:run` / `GET /api/runs/:id/report`） | `src/report/`、`scripts/gen-run-report.ts`；实测 322 份；279 测试全绿 |
| M14 | **写能力 UI 化（M1'）**：`allowWriteSpecs` 完整接线（catalog / ToolContext / delegate 守卫 / spawn 兜底）+ 界面「允许修改文件」开关 + 修改意图确认对话框 + 审批卡滚动高亮 | `src/`、`public/index.html`、`tests/42_write_gate.test.ts`；285 测试全绿；UI 链路真机实测 |
| M15 | **异步沙箱 + L1/L2 验证闭环**：`spawnAsync` 全链路、手动/严格 L2、验证状态机与取消、证据事件、UI 验证面板 | `src/sandbox/{exec,hostVerify}.ts`、`src/runtime/VerificationService.ts`、`tests/49`/`50`；334 测试全绿 |
| M16 | **可复现编辑管线评测**：独立 fixture + 真 Docker 沙箱 + 真审批 + 宿主复验/回滚 + TOCTOU；7 个确定性场景 7/7；`npm run eval:edit` 生成 `reports/EDIT_EVAL.md` | `scripts/edit-eval.ts`、`src/evaluation/editEval.ts`、`eval/edit-fixture/`、`tests/55`；当轮 370 测试全绿（现总量见头部） |
| M17 | **高危审批二次确认**：`approvalRisk` 统一风险判定；删除 / 宿主命令批准需 `confirmHighRisk`（Runtime fail-closed + HTTP 400）；前端未勾选时锁定批准按钮，拒绝始终可用；事件记录风险原因与 `highRiskConfirmed` | `src/security/approvalRisk.ts`、`AgentRuntime.ts`、`server.ts`、`public/index.html`、`tests/53k/l/m`；373 测试全绿 |
| M18 | **上下文压缩切点对齐**（2026-10-20，修真实 400）：`compactMessages` 不再按固定条数硬切，切点必须落在轮次边界，杜绝「孤儿 tool 消息」导致 OpenAI 兼容接口 400、整 run 报废 | `src/runtime/AgentRuntime.ts`（`alignCompactCut`）、`tests/33e/33f/33g`；377 测试全绿 |
| M19 | **模型失败补齐 `source:"provider"` 错误报告**（2026-10-20）：provider catch 现在走 `ErrorReporter` 三落点，context 带 `status/step/messageCount/toolCount/contextUseRatio/suspect`；`MODEL_ERROR` 的 hint 改为「先判断是消息序列还是 Key/网络」；400 事故写入 `docs/ERROR_REPORTING.md` §1.4 | `src/runtime/{AgentRuntime,errorReporter}.ts`、`tests/24d/24d2`、`docs/ERROR_REPORTING.md`；377 测试全绿 |
| M20 | **每次 run 结束自动留复盘摘要**（2026-10-20）：`run_digest` 在 `finalize()` 与启动孤儿回收两处自动写，含结论 / 计数 / 过程问题聚合 / `firstIssue` / `headline`；三落点（`run_digests` 表 + `data/run-digest.jsonl` + 事件）；`npm run digest:list` / `GET /api/digests` 可查 | `src/runtime/runDigest.ts`、`AgentRuntime.finalize`、`SqliteStore`、`EventLogger.forgetRun`、`tests/56`；382 测试全绿 |
| M21 | **终态即取消**（2026-10-20）：`finalize()` abort run 级 signal，`requestApproval` 监听 abort 立即 `deny(actor=run-finished)`，`delegate_subtasks` 自管批次超时并 abort 该批；`EventLogger` 改为按 run 保留 seq（LRU 2000）——修掉「run 已 completed 僵尸子任务仍在跑/弹卡/事件 seq 重号」 | `src/runtime/AgentRuntime.ts`、`src/trace/EventLogger.ts`、`src/tools/orchestrator/delegateSubtasks.ts`、`tests/57`（4 例）；386 测试全绿 |
| M22 | **上下文滚动摘要 + 压缩迟滞**（2026-10-21，修 R23）：旧摘要原文保留、只压新增消息；首次压缩保留任务目标；活动区增长不足不再每步压缩；摘要触顶停止而非截断；`context_compacted` 落盘 + `run_digest.compaction` 观测 | `src/runtime/{AgentRuntime,runDigest}.ts`、`tests/33h~33l`、`tests/56f`；392 子测试（391 通过 / 1 跳过，Docker 未运行） |
| M23 | **压缩水位语义修正**（2026-10-21，修 R25）：`contextWindow` + 真实 `promptTokens` 计算水位；未知窗口显式回退并标 `source=unknown`；事件/复盘带 `watermarkSource/contextWindow` | `src/types.ts`、`src/llm/{MockProvider,OpenAIProvider}.ts`、`src/runtime/{AgentRuntime,runDigest}.ts`、`tests/33m~33p`、`tests/56f`；396 子测试（396 通过 / 0 跳过，Docker 已启动） |
| M24 | **上下文压缩真实 A/B**（2026-10-21）：新增 legacy 对照、`eval:compaction`、预注册判定与报告；5×2×3=30 run，真 DeepSeek Flash，4K 模拟窗口；30/30 完成、质量 100%，rolling tokens 多 1.8%、成本多 1.4%、耗时少 0.1%，结论 `not_proven` | `src/evaluation/compactionAb.ts`、`scripts/compaction-ab.ts`、`tests/58`、`reports/COMPACTION_AB.md`；404 测试全绿（当轮） |
| M25 | **复盘 / 压缩前端面板**（2026-10-21，R24）：新增「复盘」页签（问题优先筛选、摘要详情、过程问题表、压缩观测、原始 JSON）、当前 run 快捷定位、实时 `context_compacted` 卡片与 `run_digest` 自动刷新 | `public/index.html`、`tests/59`（3 例）；407 测试全绿；Edge headless + CDP 实测 |
| M26 | **运行测试显式授权 + 演示闭环**（2026-10-22）：`run_tests` 默认不进工具池（`allowRunTests` 按 run 覆盖 + HTTP 布尔校验 + 前端开关 + Mock 剧本自适应）；`extract_evidence` 支持结构化输入（先抽 title/snippet，修掉 JSON 碎片）；CI 在干净 node:24 Linux 容器等价实跑（npm ci 125 包，406 通过 / 1 跳过 / 0 失败）；`docs/DEMO.md` 重写为 10 分钟演示闭环。回归 `tests/60/61` |
| M27 | **真实模型编辑评测 + 终点 A 收口**（2026-10-22）：新增 10 文件 fixture（基线 15/15）与 20 条真实模型编辑任务；Docker 沙箱 + 自动 allow_once + 宿主 L2 + 源码断言；**20/20 通过、L2 20/20、611,890 tokens / \$0.0172**；修复 `setup` CRLF/LF 静默未命中（BF-011），未命中标 invalid。CI main 绿 + fresh clone 416/416 | `scripts/edit-eval-real.ts`、`eval/edit-fixture/real/`、`reports/EDIT_EVAL_REAL.md`；`npm run eval:edit:real` |

---

## 7. 如何复现与验证（命令清单）

> **改完代码必须重启服务**：`npm start` 无热重载（改了 `src/` 不重启，进程仍跑旧代码——2026-10-20 的 400 复现就是因此）；开发用 `npm run dev`（`--watch` 会自动重启）。

```bash
npm run typecheck        # 类型检查（应 0 错误）
npm test                 # 全量测试（当前 422 子测试 / 422 通过 / 0 跳过 / 0 失败；Docker 已启动，40j 真跑）
npm run agents:lint      # 契约门禁：自校验 + 文档漂移 + 工具存在性
npm run digest:list      # 每次 run 的复盘摘要（默认只看有问题的：非 completed 或过程出过错）
npm run eval:edit        # 编辑管线评测（7 场景；需 Docker + mta-sandbox:node24，约 80s）→ reports/EDIT_EVAL.md
npm run eval:edit:real -- --tasks=26 --budget-usd=1 --timeout-ms=240000  # 真实模型编辑（20 引导 + 4 盲测 + 2 多文件；需 Docker + DEEPSEEK_API_KEY，约 $0.03）→ reports/EDIT_EVAL_REAL.md
npm run eval:compaction # 上下文压缩 A/B（30 run，需 DEEPSEEK_API_KEY，约 $0.03）→ reports/COMPACTION_AB.md
npm run security:redteam # 提示注入红队（42 样本；无需 Key）→ reports/INJECTION_REDTEAM.md
npm run report:refresh   # 重新生成 参数台账 + 子 Agent 契约文档
npm run report:run -- <runId>   # 单 run 报告（Mermaid 流程图 + 分层量化 + 六阶段归因）→ reports/runs/（本地缓存，不入库）
npm run report:run -- --all     # 全量重建 reports/runs/ + INDEX.md（只读扫 data/runtime.db）

node scripts/sandbox/build-image.mjs   # 构建写能力沙箱镜像 mta-sandbox:node24（可独立重跑，需 Docker Desktop）

npm run demo:codebase    # 4 个演示（Mock，无需 Key）
npm run demo:research
npm run demo:misc
npm run demo:orchestrator

npm run smoke:stream                       # 实时链路实测（帧间隔 / 推送延迟）
LLM_MODE=openai npm run smoke:llm          # 真实模型端到端（会花极少量 token）

npm start                                  # 起服务 + 界面（默认 3000，可用 PORT 覆盖）
curl -s "http://localhost:3000/api/errors?limit=20"   # 看错误报告
curl -s "http://localhost:3000/api/errors?view=summary"   # 高频错误聚合（前端「错误」页签同源）
```

---

## 8. 我正在维护的文档地图

| 文档 | 什么时候看 |
|---|---|
| **`reports/PROJECT_REPORT.md`**（本文） | 定期回看项目全貌 |
| **`reports/PROGRESS_2026-10-16.md`**（快照，一次性） | 想看某一时点的整体进度：完成状态 / 进行中 / 阻塞与风险分级（按需追加新快照） |
| **`reports/RUN_REVIEW_2026-10-16.md`**（复核快照，一次性） | 想核查某段实测会话「agent 说法 vs 实际记录」：逐条判定 + 证据索引（按需追加新复核） |
| **`reports/HEALTH_CHECK_2026-10-23.md`**（全身检查，一次性，只读） | 要接 MCP / 改权限 / 补契约门禁之前：门禁基线、权限矩阵、P0（`permissionsOf` 缺失与 `maxRiskLevel` 未校验）、建议改动与验收方法 |
| **`reports/SUMMARY_2026-10-23.md`**（当日总结与复盘，一次性） | 想用**非技术语言**理解「导入器 / 冷启动 / 持久化」到底做了什么，或想看诚实的事后复盘（做错的 5 条、判断失误 4 条、遗憾 6 条）与下一轮验收标准 |
| **`reports/UI_STREAM_PERF.md`**（人写） | 想验证“长回答会不会把浏览器卡死”：真实 Edge + 真实 SSE，5 万条增量 burst 的 Task/JS/Layout、longtask、帧间隔与修复前后 DOM 节点对照；`npm run perf:stream-ui` |
| **`reports/MCP_WRITE_E2E.md`**（人写，2026-10-23） | 想核实「模型真的会自己调 MCP 工具吗」「HTTP 审批真的会落盘并复验吗」：两条真实 E2E 的 token/耗时/事件证据、暴露的摩擦与修复、复现命令与边界 |
| **`docs/WRITE_PRINCIPLES.md`** | 要改**写路径**（工具 / 审批 / 沙箱 / 回滚）之前：方针层原则（能力常开、动作门控）+ 四道审核闸 + 四层回溯 + 自检清单 |
| **`docs/SECURITY_BOUNDARIES.md`** | 要处理不可信内容 / 提示注入：威胁模型、四层防线、run 污点与审批降权、高危动作禁用粘性 + 当前批次二次确认、红队结果与已知缺口、复现方式 |
| **`docs/RAG_AND_AGENT_STACK.md`** | 要回答/实现 RAG 与 Agent 应用栈：chunk/embedding 取舍、HNSW vs IVF、RRF+rerank 实测、MCP/function calling、慢回答诊断、流式与中断、LangGraph/LoRA/vLLM |
| **docs/HUMAN_IN_THE_LOOP.md** | 要改/要用人机协同：ask_user 契约、awaiting_user 状态机、与审批的区别、回答后如何继续、边界与复跑 |
| **`docs/DEMO.md`** | 想演示或第一次上手：四条 Mock 命令、7 步工作台主路径、HTTP/写能力/真实模型路线、证据清单、常见失败 |
| **`docs/PRODUCT_READINESS.md`** | 想知道“To C 够用 / 简历有分量”到底怎么验收：主路径、阈值、四道门、下一轮动作、现在不该做什么 |
| **`reports/AGENT_REPORT.md`**（生成物，每天 09:00 自动出） | 想看"这个 Agent 干得怎么样"：任务台账 / 成功率 / 行为轨迹 / 能力实况 / 调参对比 / 环比 |
| **`reports/CHANGELOG.md`** | 想知道"某次为什么这么改" |
| **`reports/BUGFIX_LOG.md`** | **定期复盘先看这份**：一 bug 一条的故障档案（现象 / 定位 SQL / 影响面 / 根因 / 修复 / 修后效果与验收命令 / 遗留）；🟡 表示已修但还没真实复跑 |
| **`reports/runs/`**（生成物，**不进 git**） | 想复核**某一次 run** 到底发生了什么：`npm run report:run -- <runId>`（流程图 / 分层量化 / 六阶段归因），`INDEX.md` 是全量索引；`GET /api/runs/:id/report` 同源 |
| **`.agents/skills/`**（仓库级 skill） | 要复跑验证或做收尾时：`mta-verification`（L0→L5 分层验证 + `.eval/` 探针）、`mta-reporting`（核心报告集规则 + 收尾 5 步） |
| **`reports/PARAMETERS.md`**（生成物） | 想知道"现在参数是多少" |
| **`reports/PARALLEL_AB.md`** | 想知道"多 Agent 到底值不值"：同任务串行 vs 编排的真实墙钟/token/成本与根因 |
| **`reports/RAG_EVAL.md`**（生成物） | 想看 RAG 实测：切块/混合检索/rerank 的 Recall/MRR/nDCG，以及 Flat/HNSW/IVF 的召回-延迟曲线；`npm run rag:bench` |
| **`reports/RAG_ABLATION.md`**（生成物） | 想看 chunk 大小/overlap 与 embedding 维度的消融：为什么是 512/64、其他配置差多少；`npm run rag:ablation` |
| **`reports/RAG_IMPROVEMENT_2026-10-23.md`**（方案，人写，只读） | 想提升 RAG 命中率之前：先看为什么现有 94.4% 是虚高（评测集偏袒字面匹配）、六条提升路线与三层指标（Recall/MRR/nDCG/Faithfulness/Abstain）、生成侧提示词、本机跑 R1 蒸馏版的可行性 |
| **`reports/COMPACTION_AB.md`**（生成物） | 想看滚动摘要 vs legacy 的真实 A/B：30 run、4K 模拟窗口、质量/效率/压缩次数与预注册判定；`npm run eval:compaction`。当前结论 `not_proven`，不要外推 |
| **`reports/EDIT_EVAL.md`**（生成物） | 想看编辑闭环是否按设计工作：真 Docker 拦截/审批/落盘/宿主回滚/TOCTOU；`npm run eval:edit` |
| **`reports/EDIT_EVAL_REAL.md`**（生成物） | 想看真实模型能否在该管线里改对：26 条（20 引导 + 4 盲测 + 2 多文件）、L2、tokens/成本/耗时；`npm run eval:edit:real`。仍不覆盖大型重构/HTTP 人工审批全链路 |
| **`reports/INJECTION_REDTEAM.md`**（生成物） | 想看提示注入检测的真实检出/误报与已知缺口：42 条样本、漏检 m21/m22、误报 b19/b20；`npm run security:redteam` |
| **`reports/PROVIDER_BENCHMARK.md`** | 想换 Provider：现状（DeepSeek 已实测）+ 各家逐条复现命令 |
| `docs/ERROR_REPORTING.md` | **出问题时第一个看**（事故复盘 + 错误码表 + 排查顺序） |
| `docs/RUN_DIGEST.md` | 想用/改复盘摘要：字段口径、三落点、`digest:list`、前端「复盘」页签与压缩观测的边界 |
| **`docs/WRITE_AND_APPROVAL.md`** | 想用/想改**写能力**时：第 0 节=终验复核清单（每条含状态+证据）、第 1 节=设计与取舍、第 2 节=实施进度、第 3 节=终验结果 |
| `docs/ARCHITECTURE.md` / `docs/DESIGN_DECISIONS.md` | 理解架构与取舍 |
| `designs/multi-tool-agent-harness-design-v1.md` | 多 Agent 的完整设计（含独立评审回修） |
| `agents/AGENTS.md` + `agents/<id>.agent.md`（生成物） | 子 Agent 的协作约定与接口契约 |
| `docs/{STREAMING_LIVE_VIEW,LLM_CONFIG,MISC_AGENT,TRACE_VISUALIZATION}.md` | 对应模块的详细说明 |
| `docs/TEST_REPORT.md` | 每个测试场景的真实结论 |
