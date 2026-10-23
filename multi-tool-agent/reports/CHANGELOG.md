# 变更记录（CHANGELOG）

> **用途**：你定期看项目时的「改了什么、为什么改、影响是什么」清单。按时间**倒序**（最新的在最上面）。
> **与其它文档的分工**：
> - 本文件 = **人写的「为什么」**（决策、取舍、教训）
> - `reports/PARAMETERS.md` = **自动生成的「现在是什么值」**（`npm run report:params`）
> - `reports/PROJECT_REPORT.md` = **一页读懂的项目报告**（能力 / 指标 / 风险 / 下一步）
> **维护约定**：每次功能改动或参数调整后，在本文件顶部新增一条（模板见文末）。参数改动**同时**要登记到「参数变更总表」。
> **修缺陷时另记一份**：`reports/BUGFIX_LOG.md`（一 bug 一条：现象 / 定位 / 影响面 / 根因 / 修后效果与验收命令）。本文记「哪天改了什么」，那份记「这个 bug 的前因后果」。

---

## 参数变更总表（按时间倒序）

| 日期 | 参数 | 旧值 | 新值 | 原因 |
|---|---|---|---|---|
| 2026-10-23 | 新增 `MTA_MCP_SERVERS` | — | **空数组**（不连接任何外部 MCP） | JSON 数组显式 opt-in；每个 server 必须给 `names` 白名单，避免外部工具 schema 全量进上下文；非法配置启动即报错 |
| 2026-10-22 | 新增 `RunInput.allowRunTests`（本 run 覆盖，非环境变量） | — | 未设置 = 跟随 `CODEBASE_RUN_TESTS_ENABLED` | 运行测试是「在目标仓库执行代码」的能力：默认关闭时 `run_tests` 不进工具池；界面显式勾选才开启本 run |
| 2026-10-21 | 新增 `COMPACT_MIN_ACTIVE_CHARS` / `COMPACT_MIN_NEW_CHARS` / `COMPACT_MIN_NEW_MESSAGES` | — | **2000 / 4000 / 4** | 压缩迟滞：累计 token 水位只作为门禁，活动区不够大或自上次压缩后没有足够新增时不再压缩，避免「水位过 60% 后每步都压」 |
| 2026-10-21 | 新增 `COMPACT_SUMMARY_MAX_CHARS` / `COMPACT_GOAL_MAX_CHARS` | — | **24000 / 2000** | 滚动摘要上限与任务目标原文保留长度；达到上限停止压缩，旧摘要原文不截断 |
| 2026-10-20 | 新增 `RUN_DIGEST_PATH` | — | **留空 = 跟随 SQLite 目录**（`<dataDir>/run-digest.jsonl`；`:memory:` 不落盘） | 每次 run 终态的复盘摘要 JSONL；跟随 DB 目录可让测试的临时库写到临时目录，不污染仓库 `data/` |
| 2026-10-20 | 新增 `RECOVERY_AUTO_RESTORE_MISSING` | — | **true** | 启动对账时只自动恢复「编辑 + 文件在崩溃窗口内消失 + 有原文备份」；已落盘的编辑/新增不自动回滚 |
| 2026-10-19 | 新增 `SANDBOX_L2_BEFORE_APPROVAL` | — | **false**（默认不跑；`strictVerify=true` 可单 run 开启） | 审批前是否额外跑 L2 全量；默认保持快速路径，落盘后仍有宿主 L2 复验 |
| 2026-10-19 | 新增 `MTA_EMBEDDING_MODEL` / `MTA_EMBEDDING_BASE_URL` / `MTA_EMBEDDING_API_KEY` / `MTA_EMBEDDING_DIM` | — | 未设置 = 离线 hash；设置后启用真实 embedding | 真实语义模型显式 opt-in，测试仍可离线跑；换模型必须重建索引 |
| 2026-10-19 | HTTP `goal` 长度上限 | 无上限 | **20,000 字符** | 防止 1MB goal 原样入库/进 prompt |
| 2026-10-19 | run limits 校验 | 任意有限数（0/负数可解除预算） | **正整数 + 范围**（`totalTimeoutMs` 1000~3.6e6，`costBudgetUsd` (0,1000]） | 0 不再等于“无上限”；非法值 400 |
| 2026-10-19 | `read_file` 预检上限 | 无（整文件读入内存） | **8 MiB** | 超限直接 `FILE_TOO_LARGE`，避免大文件吃满内存 |
| 2026-10-19 | `fetch_page` 响应上限 / 超时 | 硬编码 512KB；每跳独立 timeout | **`args.maxBytes`（1KB~5MB）+ 重定向链共享总超时** | 入参真正生效；DNS/重定向不再把总时长放大 |
| 2026-10-19 | RAG rebuild 文档上限 | Repository 单页 500 条静默截断 | **显式分页 + 50,000 上限** | 不再静默丢文档；超限明确报错 |
| 2026-10-19 | 新增 RAG 切块默认值 | — | `chunkSize=512` / `overlap=64`（docs 预设；code 320/48、faq 256/32、report 800/100） | 新切块层默认：512 覆盖 2~4 段，64 overlap 只覆盖跨段边界；参数变化后必须重建向量索引 |
| 2026-10-19 | 新增 `RunInput.llm.toolChoice` / `parallelToolCalls` | — | 未设置（`auto` / 厂商默认） | 按 run 控制 function calling；无工具时不发送字段 |
| 2026-10-16 | `CODEBASE_WRITE_ENABLED` 默认值 | `false`（默认关） | **`true`（默认可用）** | M1'：写能力接入 UI，不再"默认隐藏"——写操作改由「本 run 界面显式授权（`allowWriteSpecs`）+ 沙箱 + 审批卡」三层把关；部署可显式 `false` 整机禁用（UI 显示被禁用） |
| 2026-10-16 | `orchestration.allowWriteSpecs`（接线） | 只解析、**无消费点**（未接线） | **四处完整接线**（契约目录 / ToolContext 注入 / delegate 守卫 / spawn 结构层兜底） | UI「允许修改文件」开关落地；未授权 fail-closed：写 spec 不出现、派发被拒（`WRITE_NOT_ALLOWED`，文案指向界面开关） |
| 2026-10-15 | 新增 `CODEBASE_WRITE_ENABLED` | — | **false**（默认关闭） | 写能力总门禁，仿 `CODEBASE_RUN_TESTS_ENABLED` 先例；关时写工具一律 `DISABLED`（fail-closed） |
| 2026-10-15 | 新增 `APPROVAL_ENABLED` | — | **true** | 审批门禁开关（写能力开启后生效） |
| 2026-10-15 | 新增 `APPROVAL_TIMEOUT_MS` | — | **300000**（5 分钟） | 挂起审批的超时；超时按拒绝处理（配 `pausedMs` 暂停预算，不会把等待时间算进任务超时） |
| 2026-10-15 | 新增 `APPROVAL_MAX_DENIES` | — | **3**（按文件计数） | 同一文件连续被拒 3 次 → 强制收尾，防"换个措辞无限重试"烧 token |
| 2026-10-15 | 新增 `APPROVAL_MAX_FILES` | — | **10** | 单次审批的 change set 文件上限（防"10 文件 10 次打断"的打断疲劳；超出部分提示下一批） |
| 2026-10-15 | 新增 `SANDBOX_IMAGE` | — | **`mta-sandbox:node24`** | 沙箱镜像（node:24-bookworm-slim + build-essential/python3 + Linux ABI 的 node_modules） |
| 2026-10-15 | 新增 `HOST_NODE_PATH` | — | **`D:/Program Files/nodejs/node.exe`** | 宿主复验（P1-8）钉死的系统 Node 24 绝对路径；不存在则复验跳过并如实标注 |
| 2026-10-15 | 新增 `SANDBOX_EXEC_TIMEOUT_MS` | — | **600000**（10 分钟） | 沙箱内单条命令（tsc/测试/run_command）的执行超时上限 |
| 2026-10-15 | 工作区根层 `git init` | （无版本控制） | **根层仓库**（`.gitignore` 合并 multi-tool-agent 规则 + `.workbuddy/`/`.zcode/` 两层忽略；`.eval/` 保留跟踪） | 单一写者 + 可回滚安全网的协作前置（v3-1）；无 git 时同仓双写覆盖不可恢复 |
| 2026-10-14 | `run_tests` 白名单 | 前缀匹配 | **精确匹配 + 参数模板匹配（仅 `node --test` + 仓库内测试路径）** | 封堵任意文件读取/执行（32b2 实证） |
| 2026-10-14 | SSRF 校验 | 不剥离尾点、无 DNS 复核 | **去尾点 + DNS 解析后 IP 复核** | 封堵 `localhost.` 尾点绕过与 DNS rebinding（32a2/32a3 实证） |
| 2026-10-14 | `resume()` rejection | 无 `.catch`（`void result`） | **内部 `.catch` + `server.ts` 兜底 `.catch`** | 封堵 unhandledRejection 进程崩溃（32g1 实证） |
| 2026-10-14 | 工作区路径校验 | 词法 `resolve` 检查 | **`realpath` 解析后二次校验** | 封堵 junction/symlink 路径逃逸（32c2 实证） |
| 2026-10-14 | FTS5 / vec0 检索 | 缺 `MATCH` → 静默降级 | **正确 `MATCH`，0 结果才回退 LIKE** | 恢复原生全文/向量检索（32g3 实证） |
| 2026-10-14 | 新增 `retryBudget` | — | **2**（可配） | 429/5xx/网络瞬断指数退避重试，吸收厂商噪声（ZCode 同款策略） |
| 2026-10-14 | 新增 `streamIdleTimeoutMs` | — | **30000ms**（可配） | 流式空闲超时可重试，避免连接挂死 |
| 2026-10-14 | 新增 `COMPACT_TRIGGER_RATIO` | — | **0.6** | Token 水位 ≥60% 预算时自动压缩消息历史，降低后续 prompt 开销 |
| 2026-10-14 | 新增 `COMPACT_KEEP_TAIL` | — | **6** | 压缩时保留最近 6 条消息（含 tool 结果），保证上下文不丢 |
| 2026-10-14 | `maxToolConcurrency` | — | **4**（已存在，本次验证） | 同一轮工具调用并发工作池上限 |
| 2026-10-13 | 新增 模型单次调用超时 `timeoutMs` | （无，仅运行级总超时） | **120000ms**（可配） | 单次模型调用挂起时不再拖到整个运行总超时才失败 |
| 2026-10-13 | 左侧栏宽 | 380px（输入+配置混杂） | **340px 折叠式设置** | 输入移到底部栏，侧栏只留配置 |
| 2026-10-13 | `code-audit` 契约 maxTokens | 2000 | **8192** | thinking 模式下思考 token 计入 max_tokens，2000 被思考独占导致正文为空（事故 run_mv6afboo，4 子任务全 EMPTY_RESULT） |
| 2026-10-13 | `doc-research` 契约 maxTokens | 1600 | **8192** | 同上 |
| 2026-10-13 | 新增 thinking×maxTokens 防护 | — | thinking 开启且 `<8192` 时抬到 **8192** 并报 `adjusted` | 用户 UI 配 `maxTokens:2048+thinking` 也会触发同一根因；防护覆盖所有调用方（含主 Agent） |
| 2026-10-13 | 子 Agent `retention`（3 spec） | — | doc-research/dir-inventory=`ephemeral`；code-audit=`session`+5min idle | 子 Agent 生命周期自动回收：一次性任务结果采纳即释放，审计类保留供追问 |
| 2026-10-13 | 生命周期默认值 | — | ephemeral 30s/30min · session 5min/4h · durable 30min/24h（闲置/maxAge） | 各 tier 的资源回收兜底阈值 |
| 2026-10-13 | `sqlite-vec` 依赖 | — | `^0.1.9` | 语义向量召回层（vec0 虚表 + data_id 辅助列） |
| 2026-10-13 | `tsx` devDep | （未 pin） | `^4.23.15` | 固化：npm install 曾把它 prune 导致测试无法运行 |
| 2026-10-13 | `dir-inventory` 契约预算 | 4 步 / 4 模型调用 / 6 工具 / 30k tok | **8 / 8 / 16 / 60k tok** | 真实模型的实际步数（list→stats→抽查）远超 Mock 剧本，原值必然触顶 |
| 2026-10-13 | `code-audit` 契约预算 | 8 / 8 / 14 / 80k tok | **12 / 12 / 24 / 120k tok** | 同上 |
| 2026-10-13 | `doc-research` 契约预算 | 6 / 6 / 10 / 60k tok | **8 / 10 / 16 / 80k tok** | 同上 |
| 2026-10-13 | 前端「任务 Token 预算」 | misc 时压成 50000 **且不恢复** | 50000（离开 misc 自动恢复 200000） | 预算被污染导致后续所有任务在 5 万 token 被腰斩 |
| 2026-10-13 | 新增 `SUBAGENT_*`（4 项） | — | 并发 4 / 宽度 4 / 深度 1 / 结果 800 字符 | 多 Agent 编排的并行与上下文纪律 |
| 2026-10-13 | 新增 `ORCH_*`（6 项） | — | 8 步 / 12 模型调用 / 12 工具 / 200k tok / 300s / 自检工具关 | 编排主 Agent 的默认预算 |
| 2026-10-13 | 新增 `MISC_*`（7 项） | — | 6 步 / 6 / 10 / 50k tok / 硬上限 12 / 扫描 5000 / 单文件 256KB | 杂项 Agent 的小预算 + 硬边界 |
| 2026-10-13 | 新增 `LLM_*` 生成参数（7 项） | — | 见 `PARAMETERS.md` §1.1 | Token 限制与调参需求 |
| 2026-10-13 | 新增 `STREAM_*`（6 项） | — | 增量开 / Mock 延迟 25ms / 分片 18 字 / 心跳 15s / 看门狗 2s / 调试关 | 实时流式展示 |
| 2026-10-13 | 默认 LLM 预设 | （隐式 OpenAI） | **`deepseek`**（默认模型 `deepseek-flash`） | 优先接入 DeepSeek，且经真实 API 校验 |
| 2026-10-13 | 新增 `ERROR_LOG_PATH` | — | `./data/errors.log` | 错误报告落盘取证 |
| 2026-10-13 | 事件模型 | 13 种 | **+`llm_delta` / `subtask_*` / `runtime_error` / `orchestration_submitted` / `misc_report_submitted`** | 流式展示、编排可视化、错误报告 |
| 2026-10-13 | 权限集 | 4 种 | **+`misc:read/report`、`agent:report`、`orchestrator:delegate/report`** | 四个 Agent 的最小权限划分 |

> ⚠️ 表中「旧值」为改动前代码/界面中的实际值。更早（Trace 监控阶段）未改参数，故不列。

---

## 2026-10-23

### 长流式渲染量化 + MCP 真实 E2E + 工具池收口

**为什么现在做**：上一轮把 MCP 主路径接上了，但还缺两件事——P0-3 只有结构性回归没有浏览器数字；MCP 只对本地临时 server 验证过。
顺手修掉真实 E2E 暴露的口径漂移：`POST /api/runs` 回显的 `miscLimits.allowedTools` 是硬编码列表，不含 MCP 工具。

- **浏览器量化**：新增 `scripts/perf-ui-stream.mjs`（`npm run perf:stream-ui`）。用真实 `public/index.html` + 真实 `EventSource`，灌 5 万条增量后读 CDP `Performance.getMetrics`、longtask 与帧间隔。本机 Edge 155 对照：**主线程阻塞 731ms → 217ms（-70%）**，最长 longtask 167→123ms，DOM 节点增长 **261,245 → 300**；6,000 条量级两者都在 300ms 内（不宣称新版更快）。报告 `reports/UI_STREAM_PERF.md`。
- **MCP 真实 E2E**：新增 `scripts/mcp-probe.ts`（`npm run mcp:probe`，token 只从环境变量读）。对本机 MCPHub 0.12.10 实测：54 工具、真实调用 `12306-mcp-get-current-date` 104ms 返回；配置 `MTA_MCP_SERVERS` 启动服务后 `/api/mcp` ready=1，`run_started.allowedTools` 含 `mcp_hub_...`。见 `reports/HEALTH_CHECK_2026-10-23.md` 附录 D。
- **工具池唯一真值**：新增 `src/runtime/toolPool.ts`，`AgentRuntime` 与 `server.ts` 的 `miscLimits` 共用；MCP 工具、`run_tests`、orchestrator 自检开关只在一处定义。回归 `tests/64g/64h`。

**验证**：typecheck 0 错误；`npm test` **64 文件 / 430 子测试 / 430 通过 / 0 失败 / 0 跳过**；`agents:lint` 三项通过；Linux 容器等价复跑通过（Docker 用例按设计 skip）。

### MCP 客户端配置入口（P1-3 收口）

**问题**：MCP 的 client/bridge/transport 都实现了，但只在测试里被调用——能力在、产品路径不在。真实 MCPHub（54 工具）已验证协议可通，用户却没有配置入口。

- **配置**：`MTA_MCP_SERVERS`（JSON 数组）→ `parseMcpServers()` 校验后进入 `RuntimeConfig.mcp`。`names` **必填**（白名单），最多 8 server / 每 server 100 工具；URL 只允许 http/https、禁止内嵌账号密码；超时 1000~120000ms；重名/非法 JSON 一律 fail-fast。
- **连接**：`McpClientRuntime` 并行连接各 server，工具名为 `mcp_<server>_<tool>`，权限统一 `mcp:call`，风险按 annotations 推断。单个 server 失败只标 `error` + 上报 `MCP_UNAVAILABLE`，不影响服务与其它 server。
- **工具池**：codebase / research / misc 与「开启自检工具」的 orchestrator 追加 MCP 工具；**code-edit 子 Agent 不注入**（写路径必须留在沙箱/审批/apply-journal 内）。`POST /api/runs` 只做有界等待（10s），server 挂住不拖死请求。
- **观测与脱敏**：`GET /api/mcp` 返回 `configured/ready/connecting/toolCount/tools/servers[]`，`servers[].missing` 显式列出白名单里 server 没提供的工具；URL 去 query/hash/凭据，错误消息里的 token 二次打码；启动失败只进内存/JSONL/控制台（`skipEvent`），不伪造 run 事件。`src/index.ts` 在 SIGINT/SIGTERM 时关闭 MCP 会话（3s 兜底）。
- **文档**：`.env.example` 补格式与示例（token 留空）；README §2 工具表补齐 `knowledge_search` / `ask_user` / orchestrator 自检工具，并新增 MCP 段；`docs/RAG_AND_AGENT_STACK.md` §4.4 记录主路径。

**回归**：新增 `tests/64a~64f`（6 例）：配置解析、非法配置、URL 脱敏、真实 HTTP MCP 白名单桥接、失败隔离、未配置时 `/api/mcp`。

### CI 钉 Node 24.22.0（BF-014）

远端 CI 在 Node **24.21.0** 上出现原生断言 `RemoveEnvironmentCleanupHook ... Assertion failed: (env) != nullptr`（`better-sqlite3 11.10.0` 的 `Statement` 析构），7 个测试文件被连带判红；业务断言本身未失败。`ci.yml` 钉 `node-version: '24.22.0'` 后 run `39901350247` 全绿。明细见 `reports/BUGFIX_LOG.md` BF-014。

### 契约门禁真实化 + 流式渲染防卡死 + 编辑评测扩到盲测/多文件

**昨天遗留**：`411a72b` 的远端 CI 在 `npm test` 红了一次且拿不到登录态日志；真实编辑评测虽然 20/20，但题目点名文件/函数、只覆盖单文件，可信度被测试设计放大。今天先把“文档说管住了、实现没校验”的门禁缺口补上，再把评测扩到盲测和多文件。

- **P0 契约门禁**：`ToolRegistry.policySnapshot()` 提供已注册工具的真实 permission/risk；`validateSpecs()` 优先读取它，工具查不到权限映射直接 `error`，并新增 `spec.maxRiskLevel` 越界校验。`resolvePermissions()` 也改为读注册表，动态注册的 MCP 工具不再被静态表静默漏掉。回归 `tests/62a~62c`。
- **P0 流式卡死**：`Tracer.delta` 按 `runId + spanId + channel` 合并约 24ms，并在 `model_completed` 前 flush；前端不再把 `llm_delta` 复制进事件流，事件节点上限 500，文本按新增片段 append，自动滚动 100ms 节流，卡片启用 `content-visibility:auto`。回归 `tests/59d`、`tests/63a/63b`。
- **编辑评测真实性**：新增 R21~R24 盲测（只给用户症状，不点名文件/函数）与 R25~R26 多文件（抽取邮箱模块、搬迁 clamp 并保留原导入路径）；报告按引导/盲测/多文件分组，证据 schema 升到 v2。

**实测**（`deepseek-flash`，证据 `data/edit-eval-real/20261023-121200-802/`）：**26/26 通过，L2 26/26**；引导 20/20、盲测 4/4、多文件 2/2；**833,082 tokens / $0.0248 / 平均 22.7s / P95 29.2s**；单轮 95% Wilson 下界 **87.1%**。自动审批仍只衡量“模型能否改对”，不代表人工审批体验；仍不覆盖大型重构或 HTTP/UI 人工审批全链路。

**验证**：`npm run typecheck` 0 错误；`npm run agents:lint` 三项通过；`npm test` **63 文件 / 422 子测试 / 422 通过 / 0 失败 / 0 跳过 / 约 17s**；Linux `node:24` 容器等价 CI 复跑通过（Docker 用例按设计 skip）。

### 全身检查报告（只读，未改代码）

**背景**：准备接 MCP 之前，需要对「权限 / 契约门禁 / 工具池 / 文档漂移」做一次系统体检，并把问题与建议改动交给后续 code agent。

**产出**（只新增文档，**零代码改动**）：

- 新增 `reports/HEALTH_CHECK_2026-10-23.md`：门禁基线 + 权限矩阵（22 工具逐条比对）+ 问题清单 + 建议改动与验收方法 + MCPHub 环境实测。
- 新增 `reports/RAG_IMPROVEMENT_2026-10-23.md`：RAG 命中率提升方案（评测集构造效度、embedding 换型、六条路线、三层指标、生成侧提示词、本机 R1 蒸馏可行性）。
- 同时登记进 `README.md §7` 与 `PROJECT_REPORT.md §8` 两处文档地图。

**主要发现**：

- **P0**：`validateSpecs` 用 `toolPermission[t]` 后 `.filter(Boolean)`，导致「表里没有的工具」**静默跳过**权限校验；接 MCP（动态工具名）后构建期门禁会完全失效。
- **P0**：`SubAgentSpec.maxRiskLevel` 只声明不校验（仅渲染进文档），`safe` 的 spec 塞 `high` 工具 `agents:lint` 仍全绿。
- **P0**（追加排查）：**画面突然卡死、恢复后一次性补出大量内容** —— 服务端未停，是浏览器主线程被渲染任务占满：`addEvent` 对每条 `llm_delta` 都 append 后强制 `scrollTop=scrollHeight`；`flushCards` 每帧整段重写最多 3 万字符并再强制布局整个 `#live`；`_buf` 只增不减。
- **P1**：`registerMcpTools()` 只在测试中被调用，主路径无配置入口（能力在、产品路径不在）。
- **P2**：README §2 工具表漂移（缺 `knowledge_search` / `ask_user`）；`codebase:write` 粒度过粗；工具池定义三处并存。

**验证**：`npm run typecheck` 0 错误；`npm run agents:lint` 三项全过；`npm test` **416/416 通过、0 跳过、0 失败（24.9s）**。未跑真实模型 / `eval:*` / 前端浏览器实测。

---

## 2026-10-22

### 真实模型编辑评测：20/20（终点 A 第 3 条）

**背景**：`eval:edit` 只证明「沙箱 / 审批 / 落盘 / 复验 / 回滚」管线按设计工作（脚本扮演模型，tokens=0），不能回答「真实模型能不能在这个链路里把活干成」，也无法给 README / 简历提供可复现的模型编辑成功率。

**改动**：

- 新增 `eval/edit-fixture/real/`（4 源文件 + 4 测试文件，基线 15/15）与 `scripts/edit-eval-real.ts`。
- 20 条小任务（12 条修 bug、6 条新增/重构、2 条类型收紧）；每条复制独立 fixture，`setup` 注入缺陷，真实 `code-edit` 子 Agent 在 Docker 沙箱修改，自动 `allow_once`，落盘后宿主跑 4 个测试文件并校验目标源码。
- 新增 `npm run eval:edit:real -- --tasks=20 --budget-usd=1 --timeout-ms=240000`；产物 `reports/EDIT_EVAL_REAL.md`，逐任务证据 `data/edit-eval-real/<stamp>/`（不入库）。
- 修正评测有效性：`setup` 未命中的任务标 `invalid` 并排除分母；R11 断言接受 `size <= 0` 或等价的 `!(size > 0)`，同时要求错误文案含 `size must be > 0`。

**结果**（证据 `data/edit-eval-real/20261022-131513-248/`，`deepseek-flash`）：**20/20 通过（100%）**，宿主 L2 **20/20**，审批 20 次，**611,890 tokens / $0.0172 / 平均 23.9s**。

**补充（同轮）**：报告新增 **95% Wilson 单轮下界 83.9%**（避免把 20 条样本的 100% 当稳定能力）、P95 33.5s、平均 6.9 步 / 6.9 次模型调用 / 8.7 次工具调用；生成脱敏逐任务证据 `reports/EDIT_EVAL_REAL_EVIDENCE.json`；评测启动前强制跑 fixture 基线（`--preflight-only` 可只做此项，当前 15/15）。

**边界**：20 条均为单文件、小函数级修改；不能外推到大型重构、多文件架构调整或长链路调试。自动审批只衡量「模型能否改对」，不代表人工审批体验；成本按 Provider 表价估算。

**验证（当轮）**：`npm run typecheck` 0 错误；`npm test` **61 文件 / 416 子测试 / 416 通过 / 0 失败 / 0 跳过 / 约 23s**；`npm run agents:lint` 三项通过；`npm run eval:edit` 重跑 **7/7**（平均 12.7s / P95 14.1s）。

**文件**：`scripts/edit-eval-real.ts`、`eval/edit-fixture/real/`、`reports/EDIT_EVAL_REAL.md`、`package.json`、`reports/{CHANGELOG,BUGFIX_LOG,PROJECT_REPORT}.md`、`README.md`、`docs/DEMO.md`、根 `AGENTS.md`。

### 运行测试改为「显式授权」：默认不进工具池

- 背景：`CODEBASE_RUN_TESTS_ENABLED` 默认 false，但 codebase 工具池仍包含 `run_tests`。模型会调用 → 工具返回 `DISABLED` → 复盘显示「完成，但过程另有 1 类问题（DISABLED@run_tests）」。UI 主路径每次只读分析都会出现这条假问题。
- 改动：
  - `RunInput.allowRunTests`（本 run 覆盖）+ HTTP 校验（必须显式布尔，字符串 `"true"` 直接 400）。
  - `AgentRuntime.resolveAllowedTools`：未开启时不把 `run_tests` 放进工具池；`ToolContext.config.codebase.runTestsEnabled` 同步按 run 覆盖。
  - Mock 剧本自适应：工具池没有 `run_tests` 时直接收尾，并明确写「未启用运行测试，本次只做静态分析」。
  - 前端：codebase 任务参数新增「允许运行测试」开关（默认不勾，misc 隐藏），提交时透传。
- 实测（2026-10-22，HTTP + Mock）：
  - 不勾：`run_mvj11vsd_b69fab7c`，completed，3 步 / 2 次工具，复盘「完成，过程无错误」。
  - 勾选：`run_mvj11wf7_5fcb6e21`，completed，4 步 / 3 次工具，`run_tests` 6/6，复盘同样无错误。
- 回归：`tests/61`（5 例）。

### `extract_evidence` 支持结构化输入（修 Research 演示的 JSON 碎片）

- 现象：`demo:research` 的 `compare_sources.items` 是被切碎的 JSON 字符串（`{"ok":true,"data":...`）。
- 根因：Mock 剧本把 `web_search` 的原始 JSON 直接传给 `extract_evidence`，工具按句子切分 JSON。
- 修法：新增 `toReadableText()`，JSON 输入先递归抽取 `title/snippet/description/content/...`，过滤纯 URL；畸形 JSON 回退原文。
- 回归：`tests/60`（4 例）；修复后 Research 演示参数是正常标题与句子。

### CI 等价实跑 + 演示闭环文档

- 在干净 `node:24` Linux 容器里跑 CI 四步（`npm ci` → typecheck → agents:lint → test）：`npm ci` 125 包成功，406 通过 / 1 跳过（Docker 用例）/ 0 失败（当时 407 子测试）。补齐「CI 从未实跑」的空白。
- `docs/DEMO.md` 重写为 10 分钟演示闭环：四条 Mock 命令、7 步工作台路径、HTTP 真实响应、写能力闭环、真实模型路线、证据清单、常见失败。
- README §1 增加「预期输出 / 最小验证路径 / 常见失败」三节。
- 验证：`npm run typecheck` 0 错误；`npm test` **61 文件 / 416 子测试全过**（Docker 已启动，0 跳过）；`npm run agents:lint` 三项通过。

### 远端 CI 红：契约文档行尾跨平台不一致（BF-010）

- 现场：GitHub Actions run `39549359352`（`a698c71`）在 `npm test` 失败，本机全绿。
- 根因：`agents/*.md` 在 Windows 工作区是 CRLF，生成器输出 LF；`tests/23d` 与 `agents-lint` 严格比较字符串，把行尾当成内容。
- 修复：两处比较前统一 `replace(/\r\n/g, '\n')`；生成器保持 LF。
- 验证：`a698c71` + 两文件补丁在 `node:24` Linux 容器跑出 **395 通过 / 1 跳过 / 0 失败**；本机 416/416。
- 推送 `f52ef4a` 后，run `39724718243` **全步骤绿**（npm ci / typecheck / agents:lint / npm test 均 success）；fresh-clone 冒烟同样 416/416。

## 2026-10-21

### 上下文压缩真实模型 A/B（P0-2：先证明，不先宣称）

**背景**：R23/R25 已把滚动摘要、迟滞和窗口水位用确定性回归钉死，但此前没有真实长任务对照；单测通过只能证明实现符合预期，不能证明滚动摘要比旧策略更省或更好。

**改动**：

- `compactMessages` 增加 `strategy: 'rolling' | 'legacy'` 对照开关；`RunInput.compactionStrategy` 可按 run 选择，legacy 仍走 `alignCompactCut`，避免把“孤儿 tool 400”混进策略差异。
- 新增 `src/evaluation/compactionAb.ts`（纯函数：关键词保持、重复读取、策略汇总、预注册判定、报告渲染）与 `scripts/compaction-ab.ts`（5 个只读代码分析任务 × 2 策略 × 3 次 = 30 run，真 DeepSeek / DeepSeek Flash，独立 fixture 副本）。
- 运行时按 `4096` tokens 模拟压缩窗口，模型真实窗口 `1,048,576` 保持不变；报告明确这是**窗口假设**，不冒充 1M 窗口实测。
- 预算硬停：默认总预算 `$1`，每个 run 另有子预算；结果落 `data/compaction-ab/<stamp>/`，不写仓库文件。
- 新增 `npm run eval:compaction` 与 `tests/58_compaction_ab.test.ts`（7 例）。
- 顺手修掉烟测误报：普通事故日志 `POST /login with {"email": null, "password": "x"}` 被 `secret-exfiltration` 判成外传；现在必须同时出现密钥与收件目的地才命中，`tests/53a` 加回归。

**结果**（证据：`data/compaction-ab/20261021-135918-973/`，报告：`reports/COMPACTION_AB.md`）：

- 30/30 run completed；rolling 15/15、legacy 15/15 都命中全部验收关键词，完成率 / 目标全中率 / 关键词平均保持率均为 100%。
- 两者平均 steps / model calls / tool calls 都是 3 / 3 / 6；都发生 15 个 run 压缩、合计 24 次；最大摘要深度 rolling 2 vs legacy 1。
- rolling 平均 tokens `8,896` vs legacy `8,735`（rolling 多 1.8%）；平均成本 `$0.00085` vs `$0.00083`（多 1.4%）；平均耗时 `10,115ms` vs `10,125ms`（少 0.1%）。
- Provider 错误 / tool 错误 / 孤儿风险 run 均为 0。正式实验花费 `$0.0253`。
- 预注册判定为 **`not_proven`（未证明）**：没有质量回退，但没有任何效率指标达到 >=15% 改善门槛；任务契约固定每文件只读一次，重复读取率被人为压平，不能算策略优势。结论只适用于本 fixture、DeepSeek Flash、4K 模拟窗口，不能外推成“滚动摘要普适更优”。

**验证（当轮）**：`npm run typecheck` 0 错误；`npm test` **58 文件 / 404 子测试 / 404 通过 / 0 失败 / 0 跳过 / 约 18s**（Docker 已启动）；`npm run security:redteam` 仍为恶意 20/22、正常误报 2/20；`npm run agents:lint` 三项通过；`npm run report:refresh` 已重生。后续 R24 后全量 407。

**文件**：`src/{evaluation/compactionAb,security/untrusted}.ts`、`scripts/compaction-ab.ts`、`tests/{58_compaction_ab,53_injection_boundary}.test.ts`、`package.json`、`reports/{COMPACTION_AB,CHANGELOG,PROJECT_REPORT}.md`、`README.md`、根 `AGENTS.md`。

### 复盘 / 上下文压缩前端面板（R24：从 CLI/API 走到可看的界面）

**背景**：`run_digest` 与 `context_compacted` 已有 DB / JSONL / CLI / API 四个入口，但前端没有展示；复盘的最后一个动作仍要离开工作台去敲命令，R24 一直挂在风险表里。

**改动**：

- `public/index.html` 新增「复盘」页签：支持「只看有问题的 / 全部」、状态、任务类型、最近条数筛选，以及「当前 run」快捷定位。
- 左侧摘要列表显示状态、问题数、`headline`、类型与结束时间；右侧详情显示结论、首个问题、步骤/模型/工具/tokens/成本/事件数。
- 压缩观测卡片显示 `count / removedMessages / maxDepth / lastSummaryChars / maxWatermark / watermarkSources / lastPromptTokens / contextWindow / capReached`；没有压缩时明确写「本 run 未触发」，不把“未触发”解释成“压缩不可用”。
- 过程问题按 `code + source/where + count + seq + 样例消息` 展示；底部保留原始摘要 JSON。
- 实时流新增 `context_compacted` 卡片；`run_digest` 事件到达且复盘页签打开时自动刷新列表/详情。
- 新增 `tests/59_digest_ui.test.ts`（3 例，静态解析前端接线 + 内联脚本语法）；真实浏览器用本机 Edge headless + CDP 实测：页签可切换、真实摘要可加载、合成压缩摘要可渲染 67.1% 水位与全部压缩字段。

**验证**：`npm run typecheck` 0 错误；`npm test` **59 文件 / 407 子测试 / 407 通过 / 0 失败 / 0 跳过 / 约 17s**（Docker 已启动）；`npm run agents:lint` 三项通过；`npm run report:refresh` 已重生。

**影响 / 边界**：复盘从“要会命令”变成工作台内可读；历史 run 仍不回填摘要（接口 404），修复前的重复 seq 仍只影响观感；面板只读，不提供自动修复或回填。

### 压缩水位改用「模型上下文窗口 + 真实 promptTokens」（R25：修门禁语义错误）

**背景**：R23 的迟滞解决了「一过水位就每步压」，但水位本身仍然拿 `Budget.tokenBudget`（任务总预算）和累计消耗 `budgetUseRatio` 当上下文大小。两者语义不同：预算 20 万、当前 prompt 只有 2 万的 run 不会压；预算很小但当前上下文很短的 run 反而会压。单测能过，是因为 Mock 直接给了 `promptTokens`，没有真正验证「以窗口为准」。

**改动**：

- `LLMProvider` 增加只读 `contextWindow?: number`：OpenAI 兼容 Provider 从 `modelPreset.contextTokens` 取（DeepSeek 预设为 1,048,576）；`MockProvider` 默认 32,768，便于确定性回归。
- 运行时每次模型返回后记录 `lastPromptTokens = resp.usage.promptTokens`，新增纯函数 `resolveCompactWatermark`：
  - 已知窗口 + 真实 usage → `promptTokens / contextWindow`，`source=provider`；
  - 已知窗口但 usage 缺失/为 0 → 按 4 字符/token 显式估算，`source=estimated`；
  - 窗口未知 → 才回退旧的累计预算代理，`source=unknown`，事件里明确标注，不伪造窗口。
- `tokenBudget` 继续只做总预算与触顶判定，**不再兼任上下文窗口**。`contextUseRatio` 仍是预算进度条；压缩看 `watermark`。
- `context_compacted` 事件新增 `watermark / watermarkSource / promptTokens / contextWindow`；`run_digest.compaction` 新增 `maxWatermark / watermarkSources / lastPromptTokens / contextWindow`，只看摘要就能解释「为什么压/为什么没压」。
- 回归：`33m`（累计预算 90%+、当前 prompt 仅 9% → 不压）、`33n`（窗口未知 → 回退且 `source=unknown`）、`33o`（累计预算仅 50%、prompt 占窗口 61% → 压）、`33p`（usage 缺失 → 估算 + `estimated`）；`33d` 改用外部计数器（不再依赖会被压缩回退的 `callIndex`），`56f` 改为按窗口水位触发并断言新观测字段。

**影响**：压缩门禁从「任务花了多少钱」变成「这次请求带了多少上下文」，语义正确；DeepSeek 预设可直接用真实窗口，其余预设未填窗口时仍会显式回退并在事件中暴露。残余：真实模型 20~30 步长任务 A/B **后续已于同日完成**（30 run，结论 `not_proven`，见 `reports/COMPACTION_AB.md`）；其余 Provider 的窗口值未补齐（不确定就不填，避免伪造）。

**验证（当轮）**：`npm run typecheck` 0 错误；`npm test` **56 文件 / 396 子测试 / 396 通过 / 0 失败 / 0 跳过 / 约 18s**（Docker 已启动，`40j` 真跑通过）；`npm run agents:lint` 三项通过；`npm run report:refresh` 已重生；`npm run eval:edit` **7/7**（真 Docker / 真审批 / 落盘 / 回滚 / TOCTOU）；后续 R24 后全量 **407**。

**文件**：`src/types.ts`、`src/llm/{MockProvider,OpenAIProvider,presets}.ts`、`src/runtime/{AgentRuntime,runDigest}.ts`、`tests/{33_compact_messages,56_run_digest}.test.ts`、`docs/RUN_DIGEST.md`、`reports/{CHANGELOG,PROJECT_REPORT}.md`、根 `AGENTS.md`。

### 上下文滚动摘要 + 压缩迟滞（R23：修「摘要套摘要」质量衰减）

**背景**：M18（2026-10-20）修掉了压缩切点产生的孤儿 `tool` 消息（真实 400、整 run 报废），但**没有修质量衰减**：压缩水位用累计 token，超过 60% 后几乎每步都压缩；旧摘要又被当成普通消息重新压，且每条按 200 字符截断——3000 字摘要反复几轮只剩 200 字，长任务越来越容易忘掉最初目标、重复早做过的事。

**改动**：

- `compactMessages` 改为**滚动摘要**：识别已有摘要（`【上下文压缩 depth=…`），其正文**原样保留**，只压缩旧摘要之后的新增消息；替换时从旧摘要位置开始，不会留下「旧摘要 + 新摘要」两条。
- 首次压缩把**任务目标原文**（最多 2000 字符）写入摘要，避免目标被 200 字摘要截断；后续滚动只追加新增消息摘要。
- 压缩迟滞：累计 token 水位 `≥0.6` 只表示“可压缩”，实际再次压缩还要求活动区 ≥2000 字符，且自上次压缩后新增 ≥4000 字符或 ≥4 条消息（`COMPACT_MIN_ACTIVE_CHARS` / `COMPACT_MIN_NEW_CHARS` / `COMPACT_MIN_NEW_MESSAGES`）。
- 摘要硬上限 `COMPACT_SUMMARY_MAX_CHARS=24000`：达到上限后停止压缩并标记 `capReached`，**绝不截断旧摘要**。
- 新增落盘事件 `context_compacted`（此前只有不落盘的 `step_started.compacted`）：带 `depth / removedMessages / summaryChars / keptSummary / capReached / activeChars / budgetUseRatio / step`；`runDigest` 新增可选 `compaction{count,removedMessages,maxDepth,lastSummaryChars,capReached}`，可在复盘里直接看长任务压缩次数与摘要大小。
- 回归：`tests/33h`（旧摘要原文保留、新增消息进摘要）、`33i`（无新增时不重复压）、`33j`（30 步长任务仍保留目标/验收标准）、`33k`（触顶不截断旧摘要）、`33l`（迟滞门禁：水位过线但新增不足时不压缩）、`tests/56f`（digest 压缩观测 + 事件落盘）；`33d` 的 goal 加长以适配活动区门槛。

**影响**：压缩从“每步重压整段摘要”变成“保留旧摘要、只追加新增消息”，长任务的早期目标与关键事实不再逐轮衰减。边界：摘要上限 24000 字符后不再压缩（防止无限增长）；尚未用真实模型跑 20~30 步长任务 A/B，当前证据是确定性回归 + 结构观测；前端暂无 compaction 面板（属 R24）。

**验证**：`npm run typecheck` 0 错误；`npm test` **56 文件 / 392 子测试 / 391 通过 / 0 失败 / 1 跳过 / 约 16s**（唯一跳过 `40j`：当前 Docker 守护进程未运行，`docker info` 连不上；不是代码失败）；`npm run agents:lint` 三项通过；`npm run report:refresh` 已重生生成物。`eval:edit` 因 Docker 未运行未跑。

**文件**：`src/runtime/AgentRuntime.ts`、`src/runtime/runDigest.ts`、`src/types.ts`、`tests/33_compact_messages.test.ts`、`tests/56_run_digest.test.ts`、`docs/RUN_DIGEST.md`、`reports/{CHANGELOG,PROJECT_REPORT}.md`、根 `AGENTS.md`。

---

## 2026-10-20
### 终态即取消：修「run 已结束、僵尸子任务还在跑」+ 事件序号重号

**背景**（用户实测：最近三次运行都跑很多轮次后突然失败/卡死）。查 `run_mvgejh0e_3e6c9b74`（662s，状态 completed）的时间线：

| 时刻(UTC) | 事件 |
|---|---|
| 08:09:24 | 派发 2 个子任务（dir-inventory + code-edit） |
| 08:11:12 | 子任务 submit_changes → 弹第一张审批卡 |
| 08:13:24 | `delegate_subtasks` **工具超时失败**（子任务仍在后台等审批） |
| 08:16:36 | 重派 → 又一张审批卡 |
| 08:19:53 | 工具再次超时；**08:20:06 主 run `run_completed`** |
| 08:21:36 | 僵尸子任务的审批才因 300s 超时被拒 |
| 08:21:51 | 它又提交一次、**又弹一张审批卡**（再等 300s） |
| 08:27:04 | 子任务终于结束，事件已从 **seq 1 重写**（该 run 225 行 / 201 个 seq） |

两个根因：
1. **`finalize()` 从不 abort run 级 signal** —— 主循环收尾后，在飞子任务/审批等待全部继续活着（工具超时只是 `withTimeout` race 了一个 reject，底层 `pool.map` 照跑）。
2. **`EventLogger` 在 `run_completed/run_cancelled` 时清零 seq 计数**（`FORGET_SEQ_ON`）—— 终态后追加的事件从 1 重新编号，与历史撞号，回放/前端排序错乱。

**改动**：

- `finalize()` 开头 abort 该 run 的 `AbortController`：**终态即取消**，主循环一收尾就不允许任何在飞工作继续。
- `requestApproval()` 监听 run signal：abort 时立即按 `deny / actor:"run-finished"`（原因「任务已结束（终态/取消），审批自动拒绝」）解挂；不再靠 300s 超时兜底。`pendingApprovals` 同步清理、预算恢复。
- `SpawnSubAgent` 增加 `opts.signal`（批次级取消），`buildSpawnSubAgent` 用 `AbortSignal.any([runSignal, batchSignal])` 传给 `runSubAgent`。
- `delegate_subtasks` 自己管批次超时（`DELEGATE_TIMEOUT_MS=240000`，到点 `batchAc.abort()` 让子任务真停下），`timeoutMs` 抬到 +10s 作为 Registry 兜底。
- `EventLogger` 去掉 `FORGET_SEQ_ON`，改为**按 run 保留计数 + LRU 上限**（默认 2000，`maxTrackedRuns` 可配）：终态后追加事件顺延编号，长跑服务也不会按 runId 泄漏。

**影响**：run 结束后不会再出现「新的审批卡 / 新的模型调用 / 新的工具调用」；事件流 seq 全局连续（可安全回放）；代价是进程内最多跟踪 2000 个 run 的计数器（可忽略）。

**验证**：新增 `tests/57`（4 例：终态 abort、审批立即拒绝、seq 不重号、取消即拒绝）；`tests/32d6` 语义更新为「保留 + LRU」；`npm run typecheck` 0 错误；全量 **56 文件 / 386 子测试 / 386 通过 / 0 跳过 / 0 失败 / 约 29s**。

**运维提醒**：本次修复前，服务进程（PID 93624，15:44:38 启动）仍在跑**旧代码**——所以 16:25 那次 400 仍是旧的压缩切点 bug（`compactMessages` 已修但未重启）。`npm start` **没有热重载**，改完代码必须重启（或用 `npm run dev` 的 `--watch`）。

**文件**：`src/runtime/AgentRuntime.ts`、`src/trace/EventLogger.ts`、`src/tools/orchestrator/delegateSubtasks.ts`、`src/tools/types.ts`、`tests/57_run_lifecycle.test.ts`、`tests/32_adversarial.test.ts`。

### 每次 run 结束都留复盘摘要（成功也记，失败优先）——`run_digest`

**背景**：用户明确要求「每次任务流程结束后无论成功还是失败都要记录，失败的更要记，过程中出现的错误问题都要记，不然怎么复盘修复」。现状是：失败时 `runs` 行只有一行 `failureReason`，看不到过程中还失败过哪些工具/子任务；**成功时几乎没有痕迹**（completed 就完了，中间 3 次工具失败、1 次限流全沉在 events 里）；「一个流程都跑不完」（进程被杀、provider 400）只是被启动回收改成 failed，没有复盘材料。上一轮排查 400 时也是靠手工 `SELECT ... FROM events` 才还原。

**改动**：

- 新增 `src/runtime/runDigest.ts`（纯函数、零 I/O）：`buildRunDigest(run, events)` 产出结论 + 计数 + **过程问题聚合**（`issues[]`：code / source / 位置 / 次数 / 首末 seq / 首条消息）+ `firstIssue` + 一句话 `headline`。口径：`ok` 只认 `completed`；`awaiting_user / cancelled / limit_reached / failed` 都算非成功；问题覆盖 `tool_failed`、`runtime_error`、`subtask_failed`、审批拒绝、L2 验证失败、自动回滚、注入命中。
- 落点三处：① 新表 `run_digests`（可过滤列 + `digestJson`）；② `data/run-digest.jsonl`（一行一个 run，默认**跟随 SQLite 目录**，`:memory:` 不落盘以免污染仓库）；③ `run_digest` 事件（轻量版，进事件流可回放）。
- 写入时机：`finalize()` 统一出口（所有终态都写）+ **启动孤儿回收**（`RUN_INTERRUPTED` 也补一条，`runtime.recordRunDigest()`）。写之前 `EventLogger.flush()`，否则会漏掉最后一步事件。
- seq 正确性：终态事件之后追加 `run_digest` 会撞上 `EventLogger` 对 completed/cancelled 的计数清理（会从 1 重来），因此先 `ensureSeqAtLeast(maxSeq)` 再 emit；`failed / limit_reached` 保留计数（可 resume），其余终态 `forgetRun()` 收尾防泄漏。新增 `EventLogger.forgetRun()`。
- 查询：`GET /api/digests?onlyProblems=1&status=&runType=&limit=`、`GET /api/runs/:id/digest`；CLI `npm run digest:list`（默认只看有问题的，`--all / --status / --runType / --show=<runId> / --json`）。
- 文档：新增 `docs/RUN_DIGEST.md`（什么时候写 / 三个落点 / 字段 / 怎么看 / 6 条诚实边界）。

**影响**：每次 run 多 1 条事件 + 1 行 DB + 1 行 JSONL（可忽略）；历史 run 不回填（接口 404 并说明原因）；摘要写失败只报 `DIGEST_FAILED`，不影响 run 终态。

**验证**：新增 `tests/56`（5 例：成功但有过程错误、400 失败、awaiting_user、进程中断孤儿、HTTP 接口/过滤）；`tests/32` 的「事件序号连续」回归通过；`npm run typecheck` 0 错误；全量 **56 文件 / 382 子测试 / 382 通过 / 0 跳过 / 0 失败**。

**文件**：`src/runtime/{runDigest.ts,AgentRuntime.ts,index.ts}`、`src/store/SqliteStore.ts`、`src/trace/EventLogger.ts`、`src/config.ts`、`src/server.ts`、`src/types.ts`、`scripts/run-digest-list.ts`、`tests/56_run_digest.test.ts`、`docs/RUN_DIGEST.md`、`package.json`。

### 模型调用失败补齐 `source:"provider"` 错误报告 + 400 事故记入 ERROR_REPORTING

**背景**：定位 `run_mvge1343_49a18777` 的 400 时发现——`model_request` 与 `run_failed` 事件里都有线索，但 `/api/errors` 和 `data/errors.log` **一条都没有**。原因是执行循环的 provider catch 只做 `tracer.finish` + `finalize`，从未调 `errors.report()`；而 `docs/ERROR_REPORTING.md` §2.3 却写着「`provider`｜模型调用失败｜`MODEL_ERROR` + 状态码 + 响应片段」，属于**文档虚标**（`ErrorSource` 声明了 8 个来源，`provider` 一直没有调用点）。

**改动**：

- `AgentRuntime` 主循环 catch（非取消分支）新增 `errors.report({ source:'provider', phase:'llm.chat', code:'MODEL_ERROR', context:{ provider, model, step, messageCount, toolCount, contextUseRatio, status?, suspect? } })`。`suspect='invalid_message_sequence'` 由协议文案（`role 'tool' must be a response` / `with 'tool_calls'`）识别，用于直接指出「压缩切坏序列」而不是让排查者去猜 Key/网络。
- `errorReporter.hintFor('MODEL_ERROR')` 改为**先分诊**：400 + suspect → 消息序列非法（对比相邻 step 的 `messageCount` 是否突降）；都不是再查 Key / Base URL / 模型名 / 网络。
- `docs/ERROR_REPORTING.md`：新增 **§1.4 事故复盘二（上下文压缩切坏消息序列）**，含现象、证据表（messageCount 54→12、step15 checkpoint 的 12 条角色序列）、根因、修复清单与 4 条教训；§2.3 的 provider 行改为真实行为；§2.4 增加 `?source=provider` 排查命令与「先看 messageCount」的顺序；§2.5 改写 `MODEL_ERROR` 的处理口径；§2.7 新增两条诚实边界（子 Agent 的 provider 失败仍不单报；`suspect` 只是子串分诊）。
- `tests/24d` 由「MODEL_ERROR 不强制产生报告」翻转为「必须落一条 `source=provider` 报告，且 context 带 step/messageCount」；新增 `24d2`（400 孤儿 tool → `status=400` + `suspect` + hint 指向消息序列）。

**影响**：模型失败现在会出现在「错误」页签与 `data/errors.log`，并自带分诊线索；`/api/errors` 的 provider 计数从本次起才有数据（**历史 run 不回填**）。子 Agent 内部的模型失败仍只体现为 `subtask_failed`（已写入 §2.7 已知缺口）。

**验证**：`npm run typecheck` 0 错误；`tests/24` 16/16；全量 **55 文件 / 377 子测试 / 377 通过 / 0 跳过 / 0 失败 / 约 28s**。

**文件**：`src/runtime/AgentRuntime.ts`、`src/runtime/errorReporter.ts`、`tests/24_error_reporting.test.ts`、`docs/ERROR_REPORTING.md`。

### 修复上下文压缩切点产生孤儿 tool 消息 → 第 16 步 400 整 run 报废

**背景**：`run_mvge1343_49a18777`（orchestrator，真实模型）在第 16 步直接 `failed`：

```
OpenAIProvider(流式) 返回 400: {"error":{"message":"Messages with role 'tool' must be a
response to a preceding message with 'tool_calls'", "type":"invalid_request_error"}}
```

排查结论（有落库证据）：**不是** Provider/Key/网络问题，是 `compactMessages()` 自己把消息序列切坏了。该 run 的 `model_request` 记录显示 messageCount 在 step13→14 由 **54 突降到 12**（Token 水位 130k/200k ≥ 60% 触发压缩），之后连续 3 步都是 12。压缩策略是「system + 摘要 + 最近 6 条」，**按固定条数切一刀**，而这 6 条正好落在某一轮「assistant(tool_calls ×2) + tool + tool」的中间——assistant 被压进摘要、第二条 tool 结果留在尾部，于是尾部第一条业务消息就是 `role:"tool"`，其 `tool_calls` 父消息已不存在。DeepSeek（OpenAI 兼容）对此 fail-fast 400。

用该 run 最后一份 checkpoint（step 15，12 条）复算，序列为 `s,u,t,u,a[2],t,t,u,a[2],t,t,u` —— 第 2 条就是孤儿 tool（`toolCallId=call_01_ET_...`），与报错完全对应。为什么第 15 步没炸、第 16 步才炸：压缩发生在「本轮模型返回之后、消息入队之前」，所以坏序列是上一步压缩产出的，下一步才被发出去。

**改动**：

- `src/runtime/AgentRuntime.ts` 新增 `alignCompactCut()`：切点必须是**消息轮次边界**。若 `messages[keepFrom].role === 'tool'`，把切点向后推到下一个非 tool 消息（被丢掉的只是那一轮残留的 tool 结果，摘要里已有片段）；若尾部全是 tool（一轮工具数 ≥ 保留条数的极端情况），回退到最近一条 assistant，找不到则 no-op。`compactMessages()` 走对齐后的切点。
- `tests/33` 新增 3 例：`33e` 复刻故障形态（切点落在第二个 tool 上）断言压缩后无孤儿；`33f` 极端形状（一轮 8 工具）；`33g` 不变量扫描（10 种多工具轮次形状 × 有无 goal）。校验逻辑是完整协议校验（tool 必须被前置 `tool_calls` 覆盖、轮次结束不留未应答项）。

**影响**：压缩后最多比原计划多丢 1~N 条 tool 结果（它们属于被摘要掉的那一轮），不会再产生非法序列。**参数值未变**（`COMPACT_TRIGGER_RATIO=0.6` / `COMPACT_KEEP_TAIL=6`），所以不入「参数变更总表」。

**未修（已登记 R23）**：水位是**累计** token，一旦 ≥60% 就**每步都压缩**，于是出现「摘要套摘要」——`digest` 里每条消息按 200 字符截断，上一版 3000 字摘要会被压成 200 字，反复几轮后早期上下文基本消失（该 run 的 digest 已出现 `较早 5 条` 里套 `较早 47 条`）。建议后续改成「滚动摘要 + 不重复压缩旧摘要」或加水位迟滞，本次不动行为以免同时引入两处变更。

**验证**：`npm run typecheck` 0 错误；`npm test` **55 文件 / 376 子测试 / 376 通过 / 0 跳过 / 0 失败 / 约 27s**（Docker 已启动）；`tests/33` 单跑 7/7。

**文件**：`src/runtime/AgentRuntime.ts`、`tests/33_compact_messages.test.ts`、`reports/{CHANGELOG,PROJECT_REPORT}.md`。

### 高危审批二次确认 + 报告口径统一

**背景**：上一版只做到“删除 / 宿主命令不复用粘性自动放行”，但人工仍可在审批卡上一次点击 `allow_once/allow_file` 直接批准高危批次；前端按钮不是安全边界，直接 POST 也能绕过。另一个长期漂移是 skill 仍把报告制度叫“八件套”，而实际已扩为核心报告集 + 专项评测。

**改动**：

- 新增 `src/security/approvalRisk.ts`：删除 / 宿主命令的风险判定只有一个来源，Runtime、写工具与 UI 不再各维护一套。
- `ApprovalRequest` 新增 `highRisk / riskReasons / requiresExplicitConfirmation`；`approval_requested` 透传风险元数据，`approval_decided` 记录 `highRiskConfirmed`。
- Runtime `decideApproval()` 对高危批准强制要求 `confirmHighRisk:true`：缺确认时**不 resolve、不删除挂起项、不写粘性集合**；拒绝不需要确认。
- HTTP `POST /api/runs/:id/approvals/:approvalId` 缺确认返回 `400 {code:"HIGH_RISK_CONFIRMATION_REQUIRED", reasons:[...]}`，并保留 pending；`GET` 仍返回完整风险元数据。
- 前端审批卡新增红色高危区、风险原因与“我已核对文件清单 / diff”复选框；未勾选时只锁定批准按钮，拒绝始终可用。服务端 400 会显示明确提示并允许重新确认。
- 新增 `tests/53k`（Runtime fail-closed）、`53l`（拒绝免确认 + 事件元数据）、`53m`（HTTP 400/200 且挂起项保留）；`53h/53i` 改为显式确认后批准。
- 仓库级 skill 与根 `AGENTS.md` 的“八件套”旧称统一为“核心报告集 + 专项评测”，并移除 skill 里写死的 272 测试基线；`reports.md` 增加 RAG / 编辑 / 红队专项评测的维护入口。

**影响**：高危动作现在有**当前批次**的显式人工确认，且后端/Runtime 双层 fail-closed；普通编辑仍不需要额外确认。边界仍是只覆盖删除 / 宿主命令——外传密钥、发布、修改审批配置尚未接入能力令牌。

**验证**：`npm run typecheck` 0 错误；`npm test` **55 文件 / 373 子测试 / 373 通过 / 0 跳过 / 0 失败 / 约 19s**；`npm run agents:lint` 三项通过；`npm run security:redteam` 仍为恶意 20/22、正常误报 2/20；`npm run eval:edit` **7/7**（真 Docker）；`npm run report:refresh` 已重生生成物。

**文件**：`src/security/{approvalRisk,untrusted}.ts`、`src/types.ts`、`src/runtime/AgentRuntime.ts`、`src/server.ts`、`src/tools/codebase/writeTools.ts`、`public/index.html`、`tests/53_injection_boundary.test.ts`、`docs/{WRITE_AND_APPROVAL,SECURITY_BOUNDARIES,PRODUCT_READINESS}.md`、`README.md`、`PROJECT_REPORT.md`、`.agents/skills/**`、根 `AGENTS.md`、`.workbuddy/memory/MEMORY.md`。

### 提示注入红队评测 + 高危动作禁用粘性放行

**背景**：上一版只有一条启发式扫描链路和少量单测，说不出真实检出率/误报率；更关键的是，`allow_file` 的粘性放行会把“曾经同意过这个文件”复用到后续删除或宿主命令批次，等于让一次普通编辑授权变成高危动作的长期通行证。

**改动**：

- 新增 `eval/security-redteam/corpus.json`（42 条：22 条恶意、20 条正常技术文本，含已知缺口/已知误报）+ `scripts/injection-redteam.ts` + `npm run security:redteam`；生成 `reports/INJECTION_REDTEAM.md`，报告保留逐条样本、命中特征与漏检/误报。
- `src/security/untrusted.ts` 的 `canAutoApprove()` 新增 `ops` / `hasCommands` 判定：含 `delete` 或宿主命令的批次一律不走粘性自动放行；`src/runtime/AgentRuntime.ts` 对高危批次即使人工选择 `allow_file` 也不写入粘性集合，并在 `approval_decided` 记录 `stickySkipped:true`。
- 扫描前做零宽字符清理与中文字符间空格折叠，补西/法/日文“忽略之前指令”和中文“密钥…发送”反向语序特征；同时收窄 `role-override` / `tool-coercion` 的误报边界（`you are now ready...`、`call the function add` 不再命中）。
- `tests/53` 扩到 10 例：新增高危动作纯判定、宿主命令批次不进入粘性、删除批次不进入粘性、红队样本门禁（检出率 ≥90%、误报率 ≤10%）。

**实测**：`npm run security:redteam` 恶意 **20/22（90.9%）**、正常误报 **2/20（10.0%）**、总体 **38/42（90.5%）**；`npm test` **55 文件 / 370 子测试 / 370 通过 / 0 跳过 / 0 失败 / 约 18s**；`npm run typecheck` 0 错误。

**边界**：这是固定样本集上的启发式检测，不是“防住提示注入”；纯 base64（m21）与 URL 编码（m22）仍漏检，安全文档里提到攻击短语仍会误报（b19/b20）。高危动作现在是**禁用粘性自动放行**，不是静默阻断——用户仍可人工选择。`security:redteam --strict` 会因已知缺口退出 1，**暂不接 CI 硬门禁**。

### 可复现编辑管线评测（7 场景，真 Docker / 审批 / 回滚 / TOCTOU）

**背景**：写能力此前只有单次真实 run 与单测证据，缺少一条可重复命令回答四个问题：坏改动会不会被沙箱拦住？用户拒绝后是否真的不落盘？宿主复验失败是否自动回滚？审批期间外部改文件会不会被覆盖？

**改动**：

- 新增 `scripts/edit-eval.ts` + `src/evaluation/editEval.ts` + `eval/edit-fixture/base/`；`npm run eval:edit` 生成 `reports/EDIT_EVAL.md`。
- 7 个确定性场景：E1 单文件修复 / E2 两文件批量一次审批 / E3 语法拦截 / E4 测试拦截 / E5 审批拒绝 / E6 沙箱绿宿主红回滚 / E7 审批期间外部改动 TOCTOU。
- 每个场景使用独立临时仓库；宿主复验通过 junction 解析本项目 `node_modules`，结束后删除 junction，证据保留在 `data/edit-eval/<stamp>/`。
- 新增 `tests/55`（5 例）：结果分类、跳过不计入分母、token/cost 口径、报告必须声明“不是模型能力评测”、失败分类聚合。

**实测**：`npm run eval:edit` **7/7 命中预期**（5 次审批 / 4 文件落盘 / 1 回滚；沙箱 5/7 通过、宿主 2/3；平均 11.5s、P95 12.6s；tokens=0）。`npm test` **55 文件 / 370 子测试 / 370 通过 / 0 跳过 / 0 失败 / 约 18s**。

**边界**：场景由脚本确定性驱动，证明的是**管线行为**，不是 LLM 改代码成功率；尚未覆盖 20~30 条真实模型任务、粘性放行、取消/超时、L1 失败后的重生成成功率（见 `PROJECT_REPORT.md` R22）。实现注意：本机 Node 24 的 `fs.cpSync` 会直接崩进程（最小用例可复现），评测改用 `copyRepoSnapshot`。


### 验证能力探测 + 提示注入边界 + 真实崩溃测试 + 首跑自检

**背景**：上一轮崩溃对账只用了等价故障注入；宿主复验默认假设仓库有 `tests/*.test.ts`；工具结果原样回喂模型，命中注入只靠系统提示；新机器上手仍靠 README 手工排查。这四块都会让「本地产品够用」停留在演示层。

**改动**：

- **验证能力探测**：新增 `src/sandbox/verificationPlan.ts`。落盘后按仓库实际能力选择 `full_suite`（Node 原生测试）/ `typecheck`（tsconfig + 本地 tsc）/ `unavailable`（不执行、不阻断落盘、明确告知未经行为验证）。不自动执行 jest/vitest 等任意 `npm test` 脚本。`hostVerify` 结果新增 `mode/coverage/blocking/planReason`；手动 L2 也显示同样口径。回归 `tests/52`（6 例）。
- **提示注入边界**：新增 `src/security/untrusted.ts`。不可信工具输出扫描中英文注入特征；命中后发 `untrusted_content_flagged`（样本脱敏）、给 run 打污点、**禁用粘性自动放行**；审批事件/审批卡新增 `warnings` 与 `untrusted`；模型上下文追加独立边界消息（不改 tool JSON，保持可解析）。回归 `tests/53`（6 例）；与 `tests/16` 的结构性越权守卫互补。
- **真实崩溃测试**：新增 `tests/fixtures/crash-apply-child.ts` + `tests/51g`。独立 Node 进程在 `rm` 后、`rename` 前真实 `SIGKILL`（Windows 上报 `exit=1`），父进程确认 tmp 残留/文件消失/日志 `pending`，再由启动扫描从备份恢复并清理 tmp。
- **首跑自检**：新增 `npm run doctor`（`scripts/doctor.ts`）：Node 版本/ABI、宿主 Node 路径、SQLite + sqlite-vec、数据目录可写、端口、Docker/镜像、模型 Key；有 fail 退出 1，只有 warn 退出 0。回归 `tests/54`（6 例）。
- **工程门面**：`package.json` 增加 `engines.node >=24 <25`；新增 `.github/workflows/ci.yml`（Node 24 → `npm ci` → typecheck → agents:lint → test；Docker 镜像未构建时真实容器用例自动 skip）。
- **文档**：新增 `docs/SECURITY_BOUNDARIES.md`；`docs/WRITE_AND_APPROVAL.md` 新增 §3.10 并补真实 kill 证据；`README`、`PROJECT_REPORT`、`PRODUCT_READINESS` 同步。

**实测**：`npm run typecheck` 0 错误；`npm test` **54 文件 / 361 子测试 / 361 通过 / 0 跳过 / 0 失败 / 约 18s**；`npm run doctor` 本机全绿（Node 24.14.1 / sqlite-vec v0.1.9 / Docker 29.3.1 / 镜像已存在 / DeepSeek Key 已配置）。CI 工作流已写入，但**尚未在 GitHub 远端实跑**（本地无远端触发）。

**边界**：注入检测是启发式，可被改写绕过；污点是 run 级，会保守地让本 run 后续写审批都不能粘性放行；`unavailable` 模式下改动会落盘但未经行为验证，UI/结果已明确标注；`npm run doctor` 不启动服务、不跑测试、不调用模型。

### 崩溃对账与恢复（落盘意图日志 + 启动扫描 + 手动回滚）

**背景**：`applyToRepo` 是逐文件 `rm → rename`，而 `change_applied` 在整批循环结束后才发。进程若在中间被杀，仓库会处于「部分文件已改、零事件」；若在 `rm` 与 `rename` 之间被杀，文件会暂时消失，只剩 `.mta-tmp-*` 与 `data/backups/<runId>/` 里的原文备份。此前启动回收只把孤儿 run 标成 `failed`，不做文件对账。

**改动**：

- 新增 `src/sandbox/applyJournal.ts`：在**碰任何文件之前**写入本批意图（`baseHash` / `workHash` / `op` / `approvalId`），逐文件落盘后更新状态；原子写，日志写失败时 `submit_changes` 返回 `APPLY_JOURNAL_FAILED` 并中止落盘（fail-closed）。
- `SandboxSession.beginApply()` / `applyToRepo(rel, approvalId)` / `rollbackFromBackup(rel, approvalId)` 接入日志；`workHash` 以落盘时实际 work 副本为准，避免 stage 后内容变化导致误判。
- 新增 `src/runtime/RecoveryService.ts`：启动扫描 `data/backups/*`，对账五种状态（`applied` / `not_applied` / `missing` / `conflict` / `unknown`）；只对 `RUN_INTERRUPTED` 的 run 生效；自动恢复仅限「编辑 + 文件消失 + 有备份」，已落盘编辑/新增永不自动回滚；旧版本无日志或日志损坏 → `legacy` + 人工比对。
- 新增 HTTP：`GET /api/recovery`、`GET /api/runs/:id/recovery`、`POST /api/runs/:id/recovery/rollback`、`POST /api/runs/:id/recovery/accept`；新增事件 `recovery_detected` / `recovery_auto_restored` / `recovery_rolled_back` / `recovery_accepted`。
- UI：终态 run 显示「崩溃恢复」卡（已落盘/消失/冲突/自动恢复计数；回滚/保留现状；明细逐文件说明）。
- 顺带修两个落盘边界：单文件 `applyToRepo` 抛异常不再中断整批；全部文件未落盘时返回 `APPLY_FAILED`，不再出现 `ok:true + applied:[]`。

**实测**：`npm run typecheck` 0 错误；`npm test` **51 个测试文件 / 342 子测试 / 342 通过 / 0 跳过 / 0 失败 / 约 18s**；新增 `tests/51`（6 例）与 `38g2`/`38g3`；服务入口 `npm start` 的 top-level `await recovery.startupSweep()` 已实测可启动，`GET /api/recovery` 返回 `{reports:[]}`。

**边界**：只覆盖落盘窗口，不覆盖模型执行中断后的对话恢复；自动恢复只处理「编辑 + 文件消失」，其余交给人；`legacy`/损坏日志不自动回滚；单写者前提（没有跨进程文件锁）；`data/recovery/<runId>.json` 是恢复报告缓存。

## 2026-10-19

### 异步沙箱 + L1/L2 验证闭环（2026-10-19）

**背景**：同步 `spawnSync` 跑沙箱阶梯会冻结服务端事件循环（实测 HTTP 轮询 ECONNRESET）；L2 只有实现没有触发点；验证失败缺少可回放的证据事件。

**改动**：

- `src/sandbox/exec.ts`：`spawnAsync()` 支持超时、输出上限、AbortSignal；Docker、快照、阶梯、diff、落盘、回滚改为异步；同步版本仅保留给离线测试。
- `runLadder('L2')` 不再重复跑全量：L0 → L1 仅类型检查 → L2 全量一次。
- `strictVerify` 审批前 L2；终态 run 手动 `POST /api/runs/:id/verify`（queued/running/passed/failed/cancelled，全局并发 1，可取消），`GET /api/runs/:id/verification` 查询。
- 新增 `verification_started` / `verification_completed` / `change_applied` / `change_rolled_back` 事件；终态 run 追加事件前 `flush()` + `ensureSeqAtLeast(maxSeq)`，避免主键冲突。
- `sanitizeHostVerifyEnv()` 剔除 `NODE_TEST_CONTEXT` / `NODE_TEST_KNOWN_GLOBALS`，修复嵌套 `node --test` 把失败吞掉的真实 bug（回归 `tests/39i`/`50b`）。
- UI：深度验证面板、「严格验证」开关、验证/落盘/回滚卡片；0 文件落盘显示“改动未落盘”。
- 单 run 报告：`⑤ 审批 / 落盘 / 验证` 阶段现在统计 `verification_*`、`change_applied`、`change_rolled_back`（验证失败/取消、落盘/回滚文件数）；回归 `tests/41h`。
- 新增 `docs/PRODUCT_READINESS.md`：To C 验收阈值、四道门、简历叙事与“现在不该做什么”；已进 README §7 + PROJECT_REPORT §8 地图。
- 测试隔离：`tests/32c2` 的 junction 测试改用独立临时仓库，避免全量并发时与 `demo/` 快照争用导致偶发 skip。

**验证**：`npm run typecheck` 0 错误；`npm test` **334/334 通过 / 0 跳过 / 0 失败（50 个测试文件，约 15~40s（Docker 冷/热缓存差异）；Docker 已启动，40j 真机阶梯通过）**；定向 `38+39+40+46+49+50` 48/48。

**边界**：手动验证状态在内存（服务重启丢失）；手动 L2 依赖 `run_started.inputs.repoPath`；报告已能统计验证/落盘/回滚，但还没有单独的「验证详情」章节。

### R17 收口：测试不再污染 `data/runtime.db`

**背景**：`tests/19_streaming` 的 19g/19h/19i 直接使用默认 `SQLITE_PATH`，每跑一次完整套件就往生产库写 3 条演示型 mock run（codebase「g」、research「g」、research「比较两个打包器」）。`AGENT_REPORT.md` 的 Mock 计数和环比因此随测试次数漂移，历史库已累计数百条噪声记录。

**改动**：这 3 个端到端用例在 `loadConfig()` 后显式设置 `config.sqlitePath = ':memory:'`，仍用真实 HTTP/SSE 路径，只把持久化层隔离到内存。其余测试此前已使用 `:memory:` 或 `tmpdir`。

**验证**：`node --import tsx --test tests/19_streaming.test.ts` 9/9 通过；单跑前后三类演示记录数保持不变（codebase「g」108、research「g」111、research「比较两个打包器」107）；`npm test` 323/323、`typecheck` 0 错误、`agents:lint` 三项通过。

**边界**：历史库里已写入的噪声不自动删除或重写；新测试必须继续显式隔离数据库。`reports/runs/` 仍会随按需生成增长，已由 `.gitignore` 忽略。

### 人机协同：ask_user 工具 + awaiting_user 终态

**背景**：此前 run 如果缺少关键信息，只能在最终回答里“顺便问一句”，状态仍记为 `completed`，报告和 UI 无法区分“已完成”与“等人回答”（R16-③）。本次把提问变成显式工具调用和独立终态，避免把阻塞伪装成完成。

**改动**：

- **工具契约**：新增终结性工具 `ask_user`（权限 `agent:ask`，risk `safe`），参数为 1~10 个结构化问题 + 可选 `reason/context`；`codebase`、`research`、`misc`、`orchestrator` 主工具池均已接入。系统提示要求模型在缺关键信息时优先使用该工具，而不是猜测。
- **状态机**：`running/waiting_tool -> awaiting_user`；`awaiting_user` 唯一出边是 `cancelled`，刻意不进入 `RESUMABLE`。这样不会用 `rebuildInput` 恢复时丢掉 `repoPath` 或 Provider 配置。
- **持久化与恢复**：`RunResult.awaitingUser` 随 `resultJson` 落库；孤儿回收 SQL 与终态事件集合识别 `awaiting_user`；回答以**新一轮任务 + `contextHistory`**继续，不在原 run 上强行恢复。
- **前端**：新增 `⏸️ awaiting_user` 状态、问题卡片（问题/原因/背景）和会话收尾；轮询与 `refreshResult` 把该状态视为终态，不再无限等待。
- **可观测与报告**：Trace 根 span 记为可选终态；单 run 报告把它归入交付缺口；`AGENT_REPORT` 不再把它算进失败原因或失败样本，成功率分母只统计已结束任务，并单列“等待用户”数量。
- **测试与文档**：新增 `tests/48_awaiting_user.test.ts`，覆盖状态机、工具契约、Runtime 终态/落库/解包/事件/Trace/孤儿回收；新增 `docs/HUMAN_IN_THE_LOOP.md`，并同步 README、架构、设计决策与项目报告。

**验证**：`npm run typecheck` 0 错误；`npm test` **323 子测试 / 323 通过 / 0 跳过 / 0 失败（18.2s）**；`tests/48_awaiting_user.test.ts` 单跑 3/3 通过；`npm run agents:lint` 三项门禁通过；`npm run report:refresh` 重生 `PARAMETERS.md`、`agents/*.md` 与 `AGENT_REPORT.md`（393 任务，真实模型 71.2%，Mock 99.7%）。

**边界**：当前只识别**显式工具调用**，模型若只在正文里提问，run 仍是 `completed`；暂不支持同一 run 的 `answer + resume`（回答会开新一轮）；`awaiting_user` 既不算成功也不算失败，报告中的成功率分母已排除它。

### RAG / Agent 应用栈 P0/P1/P2 落地：切块、向量索引、混合检索、MCP、function calling、可观测与部署估算

**背景**：面试清单里的 RAG 与 Agent 应用栈知识点此前只有零散概念，没有可运行、可测量、可回归的实现。本次把 P0（embedding/chunk、向量索引、混合检索+rerank）、P1（MCP、function calling、可观测、流式）与 P2（LangGraph 取舍、LoRA vs RAG、vLLM 显存）落到代码、测试与实测报告。

**改动**（新增代码 + 接线 + 测试 + 文档）：

- RAG 核心：`src/knowledge/{chunking,embeddings,vectorIndex,hybrid,ragPipeline}.ts`。切块按 token 预算 + 标题/段落/句子边界，尾部句子 overlap；模型注册表覆盖 BGE / OpenAI / Qwen / Nomic；索引实现 Flat / HNSW / IVF-Flat；融合实现 RRF 与加权分数融合；rerank 用离线词法 cross-encoder 替身。
- 知识库接线：`KnowledgeHub` 新增 lazy RAG 缓存、`rebuildRag()` / `searchRag()` / `ragStats()`，`putData` / `deleteData` 后失效；HTTP 新增 `GET /api/rag/stats`、`POST /api/rag/rebuild`、`GET /api/rag/search`。
- MCP：`src/mcp/{protocol,server,client,transport,bridge}.ts` + `scripts/mcp-server.ts`。支持 stdio、Streamable HTTP（JSON/SSE）、in-memory；`registerMcpTools()` 把外部工具桥接进 `ToolRegistry`，JSON Schema 原样暴露。
- Function calling：`ToolChoice` 类型与 `parallelToolCalls` 字段，`OpenAIProvider.buildRequestBody()` 发送 `tool_choice` / `parallel_tool_calls`；`AgentRuntime` 从 `RunInput.llm` 透传；工具并行仍走既有工作池。
- 可观测：`src/observability/latency.ts` + `GET /api/runs/:id/diagnosis`，输出 wall/busy、模型与工具的 sum/union、并发节省、首 token、按 step 的 token 热点与建议。
- P2：`src/runtime/frameworkChoice.ts`（LangGraph 取舍）、`src/llm/adaptation.ts`（LoRA vs RAG）、`src/llm/vram.ts`（vLLM 显存估算）。
- 测试：新增 `tests/43_rag_pipeline.test.ts` ~ `tests/47_p2_helpers.test.ts`，覆盖切块确定性/overlap、embedding 维度与归一化、RRF 数学、rerank 翻盘、Flat/HNSW/IVF 召回、元数据 post-filter、MCP 三种 transport、桥接权限、tool_choice、并行字段、慢回答诊断、LangGraph/LoRA/VRAM 决策。
- 文档与评测：新增 `docs/RAG_AND_AGENT_STACK.md`；新增 `scripts/rag-bench.ts` + `npm run rag:bench`，生成 `reports/RAG_EVAL.md`（生成物，重跑命令，不手改数字）。

**修复（实现过程中暴露的真实缺陷）**：

1. HNSW 元数据 post-filter 用“未过滤结果数”提前退出，候选被过滤光却不扩大 `ef`。改为按**有效候选数**判断并重试（回归：测试 43f）。
2. RagPipeline 的 keyword / vector 模式返回候选池大小而非 `k`。改为 `slice(0, k)`（回归：测试 43g）。

**实测（2026-10-19，详见 `reports/RAG_EVAL.md`）**：

- RAG 质量（19 文档 / 151 chunks / 18 查询，离线 hash embedding）：keyword Recall@5 94.4%、MRR 0.798、nDCG@5 0.620；vector 55.6% / 0.380 / 0.311；RRF 88.9% / 0.690 / 0.536；RRF+rerank 100% / **0.750** / **0.638**。rerank 相对 RRF：Recall@5 **+11.1pp**，MRR **+8.7%**，nDCG@5 **+19.0%**，延迟 0.89→3.61ms。**注意**：本语料 keyword 单路 94.4%，RRF 反而掉到 88.9%——融合不是必涨，精确短语场景要 rerank 或按查询类型路由。
- 索引：HNSW `efSearch=16/32/64/128` 的 Recall@10 = 86.1%/93.9%/96.7%/97.8%；IVF `nprobe=1/2/4/8/16` = 28.3%/43.9%/66.7%/89.4%/100.0%（相对 Flat）。post-filter：flat 100% / HNSW ef=64 96.1% / IVF probe=8 84.4%。
- 显存估算：Llama-3-8B fp16/4k ≈ 19.09GB；INT4 权重 ≈ 5.29GB；32k ≈ 23.96GB；Qwen2.5-7B ≈ 17.82GB；Llama-3-70B TP=4 ≈ 162.70GB（每卡 40.67GB）。

**验证（当时基线）**：`npm run typecheck` 0 错误；`npm test` **308 子测试 / 307 通过 / 1 跳过 / 0 失败**（跳过=40j，本机 Docker 守护进程未运行）；新增 5 个套件 19/19 通过。

**复验（2026-10-19，Docker 29.3.1 已启动）**：`tests/40_sandbox.test.ts` 单跑 **12/12 通过**（含 40j 真机 Docker L0 阶梯）；`npm test` **308 子测试 / 308 通过 / 0 跳过 / 0 失败（17.6s）**；`npm run typecheck` 0 错误；`npm run agents:lint` 三项门禁通过；`npm run report:refresh` 已重生 `PARAMETERS.md`、`agents/*.md` 与 `AGENT_REPORT.md`（372 任务，真实模型 71.2% / 平均 18.8s / $0.57478）。**后续追补新增 6 例，最终 318/318（见下一节）。**

**边界（不要过度声称）**：

- `hash-ngram-256` 是词法哈希，不是语义模型；RAG 表不代表 bge/OpenAI 的真实语义上限。
- HNSW 是教学简化实现，JS 延迟不代表生产向量库；元数据过滤目前是 post-filter。
- rerank 是词法替身，真实 reranker 的提升与延迟需重测。
- 诊断的 TTFT 依赖实时 `llm_delta`，持久化事件里没有。
- **INT8 / INT4 精度本仓未实测**，不给出“掉 X 个点”的数字；按 `docs/RAG_AND_AGENT_STACK.md` §10.3 的评测协议测。

### 追补：RAG 主路径 / 真实 embedding opt-in / 索引删除与增量 / MCP 流式与取消 / P2 收口

**背景**：对上一节做复核时发现一批“文档写了、主路径没用上/实现有缺口”的问题；本次逐条修复并补回归。

**改动**：

- **RAG 进入 Agent 主路径**：新增 `knowledge_search` 工具（权限 `knowledge:read`，模式 keyword/vector/hybrid/hybrid_weighted/hybrid_rerank，返回 `chunkId/docId/heading/score/sources/text`）；`codebase`/`research`/`orchestrator` 工具池与 `doc-research` 子 Agent 均已接入；MCP `kb_search` 改为同一条切块管线（不再走旧 FTS5 混合结果）。
- **切块偏移修复**：`text` 改为原文切片（`text === source.text.slice(charStart, charEnd).trim()`），标题只进 `embedText`；此前 `text` 额外拼了 heading 前缀而偏移仍是原文，引用高亮会错位（回归：43a）。
- **真实 embedding 显式 opt-in**：`MTA_EMBEDDING_MODEL` / `MTA_EMBEDDING_BASE_URL` / `MTA_EMBEDDING_API_KEY` / `MTA_EMBEDDING_DIM`；未设置时仍用离线 hash，保证测试可离线。`rebuildRag` 改为显式分页（500/页，最多 50,000 文档），不再静默截断（回归：43i）。
- **向量索引**：`Flat/HNSW/IVF` 统一支持 `remove()` 与同 id upsert；HNSW 用墓碑删除，IVF 用墓碑 + 查询跳过、数据量翻倍才重训（不再每次 `add` 全量 k-means）；`stats().params` 暴露 `tombstones/rebuilds`（回归：43j）。
- **MCP**：`AbortSignal` 从 Runtime → 桥接 Tool → `McpClient` → `notifications/cancelled` → `McpServer.activeCalls` → 工具 `ctx.signal`；风险等级按 annotations 推断（destructive→high / readOnly→safe / 未声明→medium，避免默认 safe 触发自动重试）；`HttpTransport` 改为**增量读取 SSE**（首帧即回调）并自动回传 `Mcp-Session-Id`；`POST /mcp` 支持连接关闭取消、`DELETE /mcp` 结束会话（回归：44e/44f）。
- **Function calling HTTP 边界**：`validateRunRequest` 保留并校验 `llm.toolChoice` / `llm.parallelToolCalls`，强制工具名必须在 `allowedTools` 白名单内；非法值 `POST /api/runs` 返回 400（回归：46d/46e）。
- **P2 收口**：运行预算必须是正整数（`tokenBudget=0` 不再等于解除预算、`totalTimeoutMs=1` 拒绝）、`goal` ≤20,000 字符、`read_file` 读前 8MiB 预检、`fetch_page` 真正使用 `args.maxBytes` 且重定向链共享总超时、`EventLogger` 在 completed/cancelled 终态清理 `seqByRun`（failed/limit_reached 保留以支持 resume）。`isSensitive` 大小写不敏感此前已修，32c3 已是回归守卫（回归：32d2~32d6）。
- **P2 辅助**：`chooseAdaptation()` 的 100/500 两档理由不再有死分支；显存估算的激活项乘 `concurrency`（并发请求会线性增加激活）。

**实测（2026-10-19 最终基线）**：

- RAG：keyword 94.4%/0.798/0.620；vector 55.6%/0.380/0.311；RRF 88.9%/0.690/0.536；RRF+rerank 100%/0.750/0.638；延迟 0.89→3.61ms。
- 索引：HNSW ef 16/32/64/128 → 86.1%/93.9%/96.7%/97.8%；IVF nprobe 1/2/4/8/16 → 28.3%/43.9%/66.7%/89.4%/100%；过滤后 flat 100% / HNSW 96.1% / IVF 84.4%。
- 消融（`reports/RAG_ABLATION.md`）：本语料 512/32 最好（Recall 100%、MRR 0.856），512/64 默认 100%/0.750；256/0 与 800/0 也 100% 召回——**不能声称 512/64 唯一最优**。维度 64/128/256/512 的 vector Recall@5 = 50.0%/44.4%/55.6%/66.7%，hybrid+rerank 四档均 100%。

**验证**：`npm run typecheck` 0 错误；`npm test` **318/318 通过（0 跳过 / 0 失败，17.1s）**；`npm run agents:lint` 三项门禁通过；`npm run report:refresh` 已重生 `PARAMETERS.md`、`agents/*.md`、`AGENT_REPORT.md`（378 任务，真实 71.2%，平均 2.9s，$0.57478）。

### 复核收口：切块尾块合并 / forced tool fail-fast / MCP 超时取消 / 前端预算口径 / 沙箱副本预检

**背景**：继续核对上一节的实现，发现 5 处“能跑但口径不对/边界没兜住”的问题；逐条修复并补回归。

**改动**：

- **切块尾块合并（`src/knowledge/chunking.ts`）**：尾部短块原来直接 `prev.text + last.text`；相邻块带 overlap 时会把重叠句子复制，导致 `text` 与 `charStart/charEnd` 不再对应原文。改为按原文区间重取 `text.slice(prev.charStart, last.charEnd).trim()`，同步重算 `embedText` / `tokenEstimate` / `metadata.charEnd`（回归 43a：合并后只剩 1 块、`text === mergeText`、偏移切片断言仍成立）。
- **forced tool fail-fast（`src/runtime/AgentRuntime.ts`）**：`tool_choice='required'` 但本 run 无可用工具，或指定函数不在 `allowedTools` 时，直接以 `INVALID_TOOL_CHOICE` 失败并列出可用工具，不进入模型调用（回归 46f：`provider.requests.length === 0`）。
- **MCP 超时取消（`src/mcp/client.ts`）**：`request()` 超时除 reject 外，主动发送 `notifications/cancelled{requestId, reason:'timeout'}`；远端挂起工具能收到 abort，不再空跑到自然结束（回归 44g：1s 超时路径不等待 5s 工具）。
- **前端预算口径（`public/index.html`）**：`tokenBudget` 输入改为 `min=1` 并标注“（≥1）”，同时去掉 `Number(...) || undefined` 的静默兜底——手填 0 / 负数 / 小数会在提交前直接报“必须是 ≥1 的整数”，不再悄悄变成“不限”；`costBudget` 标注“0 或留空=不限”，与后端“token 预算 0 非法、费用预算 0 视为未设置”的语义对齐。
- **read_file 沙箱副本预检（`src/tools/types.ts` / `src/sandbox/session.ts` / `src/tools/codebase/readFile.ts`）**：`SandboxAccess` 新增可选 `workFileSize()`（旧 fake 仍兼容）；走沙箱分支时先查 work 副本大小，>8 MiB 直接 `FILE_TOO_LARGE`，避免先整块 `readWorkFile` 再拒（回归 32d4：fake sandbox 故意让 `readWorkFile()` 抛错，断言仍返回 `FILE_TOO_LARGE` 且没有整块读取）。

**验证**：`npm run typecheck` 0 错误；`npm test` **320/320 通过（0 跳过 / 0 失败，18.8s）**；`npm run agents:lint` 三项门禁通过；`npm run report:refresh` 已重生 `PARAMETERS.md`、`agents/*.md`、`AGENT_REPORT.md`（384 任务 / 真实 71.2%（52 次）/ mock 332 / 平均 2.8s / $0.57478）。针对性单跑：32 套件 23/23、43 套件 10/10、44 套件 7/7、46 套件 6/6。

**边界**：MCP 取消是尽力通知，不保证远端工具立即停止；`read_file` 预检只保证“超限不整块读”，8 MiB 以内仍是整块进内存。

---

## 2026-10-16

### 落实《写能力设计原则》第一批：R15-① / R15-⑤ / R18 / I3 修复

**背景**：新增 `docs/WRITE_PRINCIPLES.md`（方针：写能力必须始终保留 + 审核/回溯）后，按其自检清单与已登记缺口，落地第一批修复（打通写闭环 + 补齐回归守卫 + 修复跨模式误认）。

**改动**（代码 3 文件 + 测试 3 文件）：
- **R15-① `read_file` 写上下文优先读沙箱副本**：注入沙箱时 `read_file` 走 `sandbox.readWorkFile`（staged → 读副本 / 未 staged → 回落真实仓库 / 已删 → NOT_FOUND），返回体新增 `source: 'repo'|'sandbox'` 标注——修复"子 Agent 读不到自己刚暂存的文件"（真实实测 PATH_NOT_FOUND 迫使模型绕开，打断写闭环）。回归：`tests/38i`。
- **R15-⑤ 审批语义单测补齐**：`tests/38j`（连续拒绝**按文件计数** + 第 3 次 `denyLimitReached` + 不同文件独立）/ `38k`（粘性 `allow_file` 第二次 `autoByPolicy:true` 自动放行、不再挂起）/ `38l`（敏感文件不进粘性 + **超时按拒绝** `actor:timeout`）。此前仅有代码级/实测证据。
- **R18 跨模式历史混淆（双重修复）**：① 前端 `contextHistory`/`contextSummary` 每轮标注 `[模式:xxx]`（`public/index.html`）；② 服务端在有历史时注入「历史对话说明」消息——能力以本次工具列表为准、历史操作不可推断当前能力（`AgentRuntime.ts`）。回归：`tests/29a`/`30d` 断言更新并固化说明消息位置。
- **I3 `repoPath` 落库**：`run_started` 事件的 `inputs` 记录 `repoPath`（此前核查无法从记录直接证明"当时指向哪个文件夹"）。

**验证**：`npm run typecheck` 0 错误；`npm test` **289/289**（42 文件；38 新增 4 用例、29/30 各适配 1 处断言）；`npm run agents:lint` 3 项通过；前端脚本语法校验通过。

**文件**：`src/tools/codebase/readFile.ts`、`src/runtime/AgentRuntime.ts`、`public/index.html`、`tests/{38_approval,29_context_history,30_memory_summary}.test.ts`、`reports/{CHANGELOG,PROJECT_REPORT}.md`、`README.md`、`AGENTS.md`、`docs/{TEST_REPORT,WRITE_AND_APPROVAL}.md`。

**未做（如实）**：R15-②（L2 全量阶梯触发点）、R15-④（阶梯异步化）、I2（子任务跨轮可见性）、I4（事件截断标注）——继续留在清单上。

### 写能力设计原则文档（WRITE_PRINCIPLES）：写必须保留 + 审核/回溯设计框架

**背景**：用户明确方针——「写任务的能力必须始终保留，它是 agent 区别于聊天机器人的核心能力」，并要求阐明其重要性、与聊天机器人的关键差异、以及保留前提下的审核与回溯机制设计。

**改动**：新增 `docs/WRITE_PRINCIPLES.md`（**理念层**文档）——① 写能力为何至关重要（闭环 / 委托 / 可靠性 + 本仓库真实教训）；② 与聊天机器人的六维差异（产出物 / 幻觉代价 / 验证 / 信任 / 闭环 / 失败模式）；③ 总原则 **capability-on, action-gated**（能力常开、动作门控）+ 反模式清单；④ 审核机制四道闸（能力边界 / 意图授权 / 预检分离 / 人工确认，逐条对照本仓库实现）；⑤ 回溯机制四层（记录 / 证据 / 恢复 / 复盘）；⑥ 边界情形（降速不降级；事故修复顺序 = 回溯 → 审核 → 能力）；⑦ 改写路径自检清单。同步 `README.md` §7 与 `reports/PROJECT_REPORT.md` §8 两处地图。

**影响**：纯文档、无代码/参数改动（轻档）。与 `docs/WRITE_AND_APPROVAL.md`（实现层）、`reports/RUN_REVIEW_2026-10-16.md`（教训来源）、`PROJECT_REPORT` R14/R15/R18（风险面）形成完整引用链。

**文件**：`docs/WRITE_PRINCIPLES.md`（新增）、`README.md`、`reports/{PROJECT_REPORT,CHANGELOG}.md`。

### 运行核查：用户实测「记账网页」会话链（127 项 / 0 命中 / 写通道 / "委派虚构"质疑）

**背景**：用户对多轮实测（目标文件夹 `<workspace>/llm_test`）提出核查请求——(a) `list_files` 为何恒返回 127 项；(b) 按文件名搜 `*.html` 为何恒 0 命中；(c) 根因是否为"会话缺少写入通道"；(d) "委派子任务/编排提交"是否属于不存在的工具、构成虚构。

**方法**：直读 `data/runtime.db` + `data/m1-e2e.db` 的 runs/events（含 `run_started.allowedTools`、`reasoningPreview`、完整事件链）+ 磁盘独立盘点 + 逐条对证 → 报告 `reports/RUN_REVIEW_2026-10-16.md`（12 run 时间线 + 6 项判定 + 复现命令）。**只读核查，无代码/参数改动。**

**判定**：
- ①「127 项」**属实**（独立盘点 depth-2 = 127，逐项吻合）；②「0 命中」**属实**（目录确实 0 个 html；搜索正常执行、通配符语义有效）；③「无写入通道」**属实**（逐 run `allowedTools` 均无写工具；本系统的写只属 `code-edit` 且需本 run 显式授权——这些 run 均未勾选，「允许修改文件」因此全程未被打开）。
- ④ **「委派/编排是编造的」不属实（错误自认）**：工具真实存在（orchestrator 专用），16:41 `run_mvapy02d`（子任务 `st_eaf552da` 全链路 + 提交成功）与 10-15 `run_mv94f94p` 均真实调用。成因为**跨 runType 历史混淆**：codebase 以自己工具列表为唯一事实（`reasoningPreview` 原文可证）裁判了 orchestrator/misc 的真实操作；该误判进入历史后被后续轮次反复复读（16:47 的 orchestrator 连自己持有的工具都否定）。

**衍生**：`PROJECT_REPORT` 登记 **R18**（跨模式历史混淆）+ 4 项改进建议（历史标注 runType / 子任务跨轮可见性 / `repoPath` 落库 / 事件截断标注，见 RUN_REVIEW §6）；`.eval/query-run-detail.mjs` 增强支持可选 `dbPath` 参数（本次核查需查 `m1-e2e.db`）。

**文件**：`reports/RUN_REVIEW_2026-10-16.md`（新增）、`reports/{PROJECT_REPORT,CHANGELOG}.md`、`README.md`、`.eval/query-run-detail.mjs`。

### M1'：写能力接入 UI（可见开关 + 修改意图确认对话框 + 审批卡强化）——`allowWriteSpecs` 完整接线

**背景**：用户实测后提出「写功能不要只做隐藏处理——门禁的用途应是"修改操作时弹提示让用户确认"，而不是把功能藏起来无法使用」。原状排查：M1 的 `orchestration.allowWriteSpecs` **只解析、未接线**（全仓无消费点），且前端无开关 → 从界面发出的任务永远不可写。

**改动**：
- `config.ts`：`CODEBASE_WRITE_ENABLED` 默认 `false → true`（写工具默认可用，能力不再隐藏；写操作由三层把关）。部署可显式 `false` 整机禁用。
- `agents/specs.ts`：新增 `isWriteSpec` / `isWriteSpecId` / `dispatchableSpecs`（判定口径单一来源）；`runtime/AgentRuntime.ts`：新增导出 `resolveWriteSpecsAllowed`（请求授权 && 部署门禁），接线四处——① 编排契约目录过滤（软引导）② `ToolContext.writeSpecsAllowed` 注入 ③ `delegate_subtasks` 守卫（未授权 → `WRITE_NOT_ALLOWED`）④ `spawnSubAgent` 结构层兜底（防绕过）。
- `server.ts`：`GET /api/config` 暴露 `writeEnabled`（UI 显示门禁状态）；`runtime/index.ts` → `src/index.ts`：沙箱容器孤儿回收**从 buildRuntime 挪到服务入口**（buildRuntime 被测试/演示复用，不碰 Docker——新默认下否则每次测试启动都会删 `mta-sb-*` 容器，含并发误杀风险）。
- 前端 `public/index.html`：① 编排面板新增「允许修改文件（写能力）」开关（说明 + 部署禁用/白名单冲突的可见警示）；② **修改意图确认对话框**：goal 命中"修改文件"意图但当前设置不会真的改文件时（非编排模式 / 未勾选 / 部署禁用），弹可见对话框供用户选择「仍以只读提交 / 去开启写能力（自动切编排+勾选+高亮）」；③ 请求体传 `allowWriteSpecs`；④ 审批卡出现时**自动滚入视野 + 短暂高亮**。

**实测**（真实模型 deepseek-flash + 真 Docker 沙箱，`run_mvanz941_6f0f72ff`）：UI 语义请求（`allowWriteSpecs=true`，**不带白名单**）→ 编排派发 code-edit（首次 INVALID_ARGS 后模型自愈重试）→ 沙箱 `create_file` → `submit_changes` → **审批卡** → `allow_once` → **落盘 `docs/_ui_write_smoke.md` + `hostVerify{ran:true, ok:true, note:"宿主全量测试通过"}`** → run completed。过程再次实证 R15-④（沙箱阶梯期间 HTTP 轮询 ECONNRESET——事件循环阻塞，脚本断开、审批由人工补点）。

**影响**：写能力从「环境变量 + API 才能触发」变为「界面可见、勾选即授权、修改有确认对话框、落盘有审批卡」。fail-closed 语义保留在**本 run 层**（不勾选 = 只读；四处接线保证绕不过去）。默认值变化属安全语义调整（详见参数变更总表）。

**验证**：`npm run typecheck` 0 错误；`npm test` **285/285**（42 文件；新增 `tests/42_write_gate.test.ts` 6 用例：解析 / 判定口径 / 目录过滤 / delegate 守卫 / 对照组 / 口径一致性）；`npm run agents:lint` 3 项通过；前端脚本语法校验通过；UI 链路真机实测（上）。

**文件**：`src/{config.ts,server.ts,index.ts,agents/specs.ts,runtime/AgentRuntime.ts,runtime/index.ts,tools/types.ts,tools/orchestrator/delegateSubtasks.ts}`、`public/index.html`、`tests/{helpers.ts,42_write_gate.test.ts}`、`reports/{CHANGELOG,PROJECT_REPORT,PARAMETERS}.md`、`README.md`、`docs/WRITE_AND_APPROVAL.md`、`.env.example`、`.eval/m1-e2e-out/EVIDENCE.md`。

### M1 写能力三态端到端复测（应「实测未见写功能」之疑）：deny / allow / 粘性全部通过

**背景**：用户实测后反馈「貌似还没有写的功能」——排查为**设计使然**（总门禁默认关 + 界面未接线 + 需 Docker 沙箱），并按要求跑真实端到端复测「亲眼确认」。

**做什么**：起专用实例（`PORT=3033 CODEBASE_WRITE_ENABLED=true LLM_MODE=openai`，独立库 `m1-e2e.db`）→ `.eval/m1-e2e-drive.mjs`（deny+allow）→ 补跑 `M1_PHASES=sticky`（`M1_OUTDIR=.eval/m1-e2e-out-sticky` 独立目录，防覆盖旧证据）。

**结果**（真实 Docker + 真实模型 deepseek-flash，三态合计 **$0.0019**）：

| 阶段 | runId | 关键断言 |
|---|---|---|
| deny | `run_mvamvreb_a8b3377e` | 拒绝 → 仓库无该文件 ✓（7,357 tok / $0.0005） |
| allow_once | `run_mvamwqgl_1fa69ede` | 落盘 + `hostVerify{ran:true,ok:true,"宿主全量测试通过"}` ✓（11,308 tok / $0.0006） |
| 粘性 allow_file | `run_mvamz4w4_b27c6bf6` | 两次提交 → 1 次人工审批 + 第二次 `sticky-policy` 自动放行 `autoByPolicy:true`、两次均落盘 ✓（15,428 tok / $0.0008） |

**状态更新**：`PROJECT_REPORT.md` R15-③ 由「未被真实 run 触发」更新为「已由真实 run 触发验证」（残余=单测覆盖，见⑤）。

**环境坑（复现须知，均为实测复现）**：① 本机 HTTP 代理（`127.0.0.1:55173`）会劫持 curl 对 3033 的探测（假 502）→ 用 `--noproxy '*'` 或 Node fetch 判别；② 起服务必须用**系统 Node 24**（托管 Node 22 → better-sqlite3 ABI 137≠127，`ERR_DLOPEN_FAILED`）；③ 脚本 `M1_OUTDIR` 可分离输出、防覆盖旧证据。

**验证**：两轮 `M1_E2E_RESULT` 的 `issues` 均空；沙箱容器终态自动清理（`docker ps -a` 无 `mta-sb-` 残留）；落盘测试文件已清理（`docs/_m1_{smoke,sticky}.md` 已删）。

**文件**：`.eval/m1-e2e-out/result.json`（更新）、`.eval/m1-e2e-out-sticky/result.json`（新增）、`reports/{PROJECT_REPORT,CHANGELOG,PROGRESS_2026-10-16}.md`。

### 项目进度快照：PROGRESS_2026-10-16（完成状态 / 进行中 / 风险分级）

**背景**：用户要求查看项目整体进度（各模块完成状态、进行中事项、阻塞与风险），按优先级整理成一份简要的项目进度报告。

**改动**：新增 `reports/PROGRESS_2026-10-16.md`——**一次性状态快照**（非八件套维护文档）：健康度基线（279/279 · typecheck 0 · 68.1% 真实成功率）/ 里程碑 M1–M13 状态 / 待复核与待办 / 风险按 P1–P3 分级（R15、R2、R16-③、R17、审查 P2×7/P3×3 等）/ Top 5 下一步；同步 `README.md` §7 与 `reports/PROJECT_REPORT.md` §8 两处文档地图各加一行（标注"快照"）。

**影响**：无代码/参数改动。

**验证**：生成时实时复跑 `npm run typecheck` **0 错误**；测试基线引用同日 `npm test` **279/279** 实测（本次**未重跑**——期间仅 docs 提交、无代码改动，按收尾分档走**轻档**）。

**文件**：`multi-tool-agent/reports/PROGRESS_2026-10-16.md`、`multi-tool-agent/README.md`、`multi-tool-agent/reports/{PROJECT_REPORT,CHANGELOG}.md`。

### 单 run 报告生成器：流程图 + 分层量化 + 六阶段归因（项目「下一步」第 2 项）

**背景**：2026-10-15 复核「记账网页」首轮 run（`run_mv94f94p_314902b2`）暴露的是**渲染层**问题——记录里其实全标了（`subtask_failed limit_reached`、`orchestration.unresolved` 里 7 个待用户回答的问题），但读起来像「干净的 3 步完成」。用户据此提出「每轮自动生成流程图 + 量化报告」。口径层（缺口 ①②④）已在同日前一条「口径修正」落地；本条补渲染层：把 `events` 有序流 + trace span 树 + `resultJson` 机械渲染成一份可复核的报告。

**改动**：
- 新增 `src/report/runReport.ts`（纯函数、零 I/O）：`aggregateRunEvents()` 聚合主 Agent 分步/工具/错误；`attributeStages()` **六阶段归因**（intake / model / tool / subtask / approval / delivery，每阶段 `ok|gap|fail|na` + 说明 + `evidence: seq[]`）；`buildRunReport()` 产出 10 节 Markdown；`parseRunReportMeta()` / `buildRunReportIndex()`。
- 报告 10 节：一行结论 / **分层量化**（主 Agent vs 子任务合计 vs 总计）/ **Mermaid 流程图**（主流程 + 子任务各一张）/ 分步明细（主 Agent）/ 子任务明细 / 工具调用聚合（带「来源=主 Agent|子任务」列）/ **六阶段归因表**（+ 每阶段 `<details>` 指标）/ 缺口与未解决项 / 原始错误清单 / 诚实清单与盲点 / 附录（最终答复，标注「不可作证据」）。
- 新增 `src/report/runReportFiles.ts`（I/O 层）：原子写（tmp + rename）+ 全量重建 INDEX（幂等）。
- 新增 `scripts/gen-run-report.ts` + `npm run report:run -- <runId> | --last <n> | --all [--db <path>] [--out-dir <dir>]`（只读扫库）→ `reports/runs/<runId>.md` + `INDEX.md`。
- `src/server.ts` 新增 `GET /api/runs/:id/report`（默认 JSON `{meta,markdown,reportCount}`；`?format=md` → `text/markdown`；未知 run → 404；**按需生成、不落盘**）。
- 新增 `tests/41_run_report.test.ts`（7 例）：分层量化（子任务消耗单列、合计=主+子）/ 流程图只画主 Agent 的 step / 六阶段归因 / meta 可解析且与返回一致 / 旧口径数据不炸（无 `gaps`/无 `subtasks`）/ INDEX 幂等 / 落盘不漂移；`tests/22_orchestrator.test.ts` 的 `22q)` HTTP 端到端补报告接口断言（JSON + `?format=md` + 404）。
- 新增根 `.gitignore` 条目：`multi-tool-agent/reports/runs/` **不入库**——每个 run 一份、随每次 `npm test` 增长（实测 322 份 / 2.0MB）；真值 `data/*.db` 同样不入库，故其定位为**本地证据缓存**（`npm run report:run -- --all` 可全量重生成）。

**影响**：run 的「看起来完成」不再能掩盖缺口——报告把主 Agent 与子任务**分层**（`runs` 行 t3 vs `subtaskUsage`）、失败/取消/限流截断/未解决项单列，并在六阶段表里给出 `gap`/`fail` + 证据 seq。**行为无变化**（只读渲染，不碰执行路径）。**未做（如实标注）**：① run 终态**异步**自动触发报告生成——`AGENTS.md` 原计划含此项，与「阶梯异步化」同一前置（同步 `spawnSync` 会阻塞事件循环，实测 HTTP 轮询 ECONNRESET）；② 阻塞态 `awaiting_user`（R16-③）。

**验证**：`npm run typecheck` 0 错误；`npm test` **279 项（279 通过 / 0 失败 / 0 跳过 / 16.7s）**（Docker 已开，40j「真实 Docker L0 阶梯」实跑通过）；`npm run agents:lint` 三项门禁通过；`npm run report:refresh` 已重生（`AGENT_REPORT.md`：319 任务 / 真实 68.1%（47 次））；`npm run report:run -- --all` → **322 份** + INDEX。真实样本 `run_mv94f94p_314902b2`：分层量化 15,661（主）+ 28,439（子）= **44,100 tok**、`3+16 工具`、工具聚合 `doc-research/fetch_page 12 次（7 失败 / 45.7s / 来源=子任务）`、六阶段 `ok/ok/gap/fail/na/gap`。

**文件**：`multi-tool-agent/src/report/{runReport,runReportFiles}.ts`、`scripts/gen-run-report.ts`、`src/server.ts`、`package.json`、`tests/{41_run_report,22_orchestrator}.test.ts`、`reports/{CHANGELOG,PROJECT_REPORT}.md`、`README.md`、根 `.gitignore`。

**教训**：子任务归属**只能按 span 树回溯**——`tool_completed` / `tool_failed` / `model_completed` **不带 `parentId`**（只有 started/request 侧带），且 `tool_completed.name` 是**裸名**（只有 `tool_started` 带 `spec/` 前缀）→ 必须先用 `spanId` 建「span 种类 + 父节点」索引再回溯；否则子任务的 16 次工具调用会串进主 Agent 的分步表、子循环的 step 号会混进主流程图（`41b`/`41g` 已钉死这两条回归）。

### 工具化：仓库级 skill（mta-verification / mta-reporting）+ 报告口径对齐

**背景**：用户要把「验证/复跑流程」与「报告更新规则 + 收尾清单」固化下来，减少每次收尾的重复劳动与遗忘；顺带发现报告口径在几处文档里不一致（"三/四件套"）。

**改动**：
- **新增仓库级 skill**（Codex 从 cwd 向上找 `.agents/skills`，无需全局安装）：`.agents/skills/mta-verification/`（SKILL.md + `references/{commands,traps,probes}.md`：分层验证 L0→L5、环境硬约束、`.eval/` 探针用法）；`.agents/skills/mta-reporting/`（SKILL.md + `references/{reports,closeout}.md`：八件套逐份规则、收尾 5 步、记忆分层、hook 注入点）。
- **口径对齐（八件套）**：`README.md` §7「项目报告四件套」→「八件套」并补齐 CODE_REVIEW / PARALLEL_AB / PROVIDER_BENCHMARK / ZCODE_COMPARISON 四条；`reports/PROJECT_REPORT.md` 里程碑 M8 的「`reports/` 三件套」标注为「现已扩到八件套」；`.workbuddy/memory/MEMORY.md`（机器本地）报告制度表从 3 行扩到 8 行。
- **`AGENTS.md`**：补「报告更新规则」「收尾动作清单」两节；报告成功口径改为取 `AGENT_REPORT.md` 生成值；CHANGELOG 条目写法改为与现状一致（顶部按 `## 日期` 分组）。

**影响**：收尾动作不再依赖临时记忆；报告口径全仓一致。**无代码改动、无参数改动**（参数变更总表无新增行）。

**验证**：`npm run typecheck` 0 错误；`npm test` **272 项（271 通过 / 1 跳过 / 0 失败 / 5.6s）**；`npm run agents:lint` 三项门禁全部通过。跳过项 = 40j「真实 Docker L0 阶梯」——本机 Docker 守护进程当时未运行。

**文件**：`.agents/skills/{mta-verification,mta-reporting}/**`、`AGENTS.md`、`multi-tool-agent/README.md`、`multi-tool-agent/reports/{PROJECT_REPORT,CHANGELOG}.md`、`.workbuddy/memory/{MEMORY,2026-10-16}.md`。

**教训**：① 沙箱账户自有的 `.agents/` 会让 Windows 沙箱 setup 加 deny ACE 失败 → 之后每条命令都报 `setup refresh had errors`（详见 `AGENTS.md`「踩过的坑」）；② `.agents/` 与 `.git` 都在沙箱 deny ACL 内，**skill 文件写入与 `git add/commit` 必须在沙箱外执行**；③ 沙箱内 Node 跑 `agents:lint`/`test` 会报 `uv_os_get_passwd ENOMEM`，同样需在沙箱外跑。

**补充（同日，轻档收尾）**：按改动比例修剪收尾规则 —— ① **收尾分档**（重档＝有代码/参数/契约改动，跑 `report:refresh` + `typecheck`/`test`/`agents:lint`；轻档＝纯文档/skill，只更新状态锚点 + CHANGELOG 一条 + 提交），已写入 `AGENTS.md`「收尾动作清单」与 `mta-reporting` skill 的 `references/closeout.md`；② 新增**规则防腐**条款：清单/报告里的条数·件数·编号会过期，发现不符先改规则。本条本身即轻档示范：未重跑测试（上一次运行在数分钟前且期间无代码改动）。

### 口径修正：编排子任务统计分层（`limit_reached` 独立成桶 + `gaps` + 子任务消耗合计）

**背景**：2026-10-15 记账首轮 run 复核（`run_mv94f94p_314902b2`）暴露三个「可见性/口径」缺口：① `limit_reached` 子任务被并进 `cancelled`（`ok:0/failed:0/cancelled:1`）→ 编排 headline 看起来「0 失败」；② 顶层计数器只算主 Agent → 一次「干净的 3 步完成」里藏着子任务的 16 次工具调用；③ run 状态 `completed` 而实际阻塞于 7 个待用户回答的问题（无可区分状态/徽标）。本轮只改「报告怎么说」，**不动执行逻辑**。

**改动**：
- `src/types.ts`：`OrchestrationReport.subtasks` 增 `limited`；新增 `gaps{failed,cancelled,limited,unresolved,total}` 与 `subtaskUsage{modelCalls,toolCalls,totalTokens,costUsd}`。
- `src/runtime/AgentRuntime.ts`：`summarizeSubtasks` 把 `limit_reached` 从 `cancelled` 拆出（`cancelled` 只算真取消）；新增导出 `summarizeSubtaskUsage()`；`toOrchestrationReport` 装配 `gaps`/`subtaskUsage`，自动补漏文案改为「失败 X、取消 Y、被限流截断 Z」；`fallbackOrch` 兜底路径同样带 `subtaskUsage`；`orchestration_submitted` 事件补带 `gaps`/`subtaskUsage`（实时卡片可用）。
- `src/tools/orchestrator/delegateSubtasks.ts`：派发回执改为 `X/Y 成功：失败 A、取消 B、被限流截断 C——请在汇总里如实标注缺口`。
- `public/index.html`：部分成功横幅、统计条、子任务卡 meta、状态徽标四处把「取消/超限」拆成「取消 + 限流截断」，并加「缺口 N」徽标（优先 `gaps.total`，旧数据现场回退计算）。
- `tests/22_orchestrator.test.ts`：`22m)` 断言补 `limited: 0`，新增 `limit_reached` 独立成桶 / `gaps` 口径 / `subtaskUsage` 合计三组用例；`22h)` 断言补 `limited: 0`。

**影响**：编排 run 的缺口不再被平均成「0 失败」——限流截断单列、缺口计数在报告与 UI 徽标可见、子任务消耗（模型调用/工具调用/tokens/成本）可单独核对。**行为无变化**（子任务执行、预算、状态机未动）；口径只影响新 run（旧 run 的 `resultJson` 无 `gaps`/`subtaskUsage`，前端走回退计算，`subtasks.limited` 缺省按 0）。**未做**：缺口 ③ 阻塞态（`awaiting_user`）仍是待办，见 `AGENTS.md`「下一步」。

**验证**：`npm run typecheck` 0 错误；`npm test` **272 项（272 通过 / 0 失败 / 0 跳过 / 14.4s）**——本轮 Docker 守护进程已开，`40j`「真实 Docker L0 阶梯」由上一轮的跳过转为实跑通过；`npm run agents:lint` 三项门禁通过；`npm run report:refresh` 已重生（`PARAMETERS.md` 仅生成时间变化，`agents/*.md` 无漂移）。

**文件**：`src/types.ts`、`src/runtime/AgentRuntime.ts`、`src/tools/orchestrator/delegateSubtasks.ts`、`public/index.html`、`tests/22_orchestrator.test.ts`、`reports/{AGENT_REPORT,PARAMETERS}.md` 与 `reports/history/agent-2026-10-16.json`（后三者=生成物）。

**教训**：这批文件是 **CRLF 行尾 + UTF-8 无 BOM**。用 PowerShell 批量替换时踩两坑：① 脚本回显文本（`... ok`）被误写进文件首行，靠 `git diff` 才发现；② 锚点按 LF 写 → 多行锚点全部 miss（只有单行替换侥幸命中）。改为「读全文 → 归一化成 LF → 替换 → 还原 CRLF → `UTF8Encoding($false)` 写回」后一次通过，并逐文件核对 `CRLF/bareLF` 计数。

---
## 2026-10-15

### 写能力 + Docker 沙箱 + 三级人工审批（M1 Step0..6）

**背景**：待办清单第一组：给 Runtime 加**受控写能力**——工具可以改仓库文件，但必须 ① 先在同一套 Docker 沙箱里验证（"改前试跑"）② 经**人工三级审批**才落盘 ③ 落盘后跑宿主复验、失败自动回滚。两轮评审定稿（P0×3 / P1×6 / P2×7 + v3×5），第 0 节「终验复核清单」为验收标准（`docs/WRITE_AND_APPROVAL.md`）。

**改动**：
- **Step 0 前置**：工作区根层 `git init`（单一写者 + 可回滚安全网，v3-1）；`search_files` 三重静默陷阱修复（`kind` 默认改 `content` + 0 命中给修正 hint / `A|B` 改为 OR 语义 / 新增 `path` 作用域参数；`tests/37` 7 用例）。
- **Step 1 镜像**：`scripts/sandbox/Dockerfile` + `build-image.mjs` → `mta-sandbox:node24`（`build-essential`+`python3` 供原生模块回退编译、`npm ci` 三重试、装完自检 `require('better-sqlite3')`、非 root `node` 用户、`/work` 归 node）。脚本可独立重跑（层缓存/`--no-cache`）。
- **Step 2 沙箱**：`src/sandbox/{docker,session,classify}.ts`。**不用 bind mount**：`docker cp` 仓库快照进容器（排除 node_modules/data/.git/工具状态；Linux ABI 依赖走镜像）；`SandboxSession` 按 parentRunId 复用；检查阶梯 L0 语法 → L1 `tsc --incremental` + 受影响测试（三级映射兜底：同名 → grep 引用 → 找不到则**全量**，绝不允许"找不到映射=不跑测试"）→ L2 全量；分类器 10 类 + 修复提示 + `ENV_MISMATCH` 单列（不算模型改错）；Docker 不可用 → fail-closed。
- **Step 3 写工具**（`src/tools/codebase/writeTools.ts`）：`create_file / edit_file / delete_file / copy_path / run_command` **只暂存沙箱**；`submit_changes` 做一次批量提交：阶梯 → **一个 change set 一次审批** → 落盘（TOCTOU 哈希守卫 + 原文备份 + 原子写含 EPERM/EBUSY 3 次退避）→ 宿主复验 → 失败自动回滚。路径围栏 + 敏感文件拒写（大小写不敏感）+ 512KB 上限 + CRLF 主导行尾/BOM 保持。
- **Step 4 审批门禁**（`AgentRuntime`）：`ToolContext.requestApproval` 在主循环与子循环**两处**注入；三态 `allow_file / allow_once / deny`；粘性放行（本 run 内该文件后续沙箱全绿自动落盘，敏感文件永久逐次）；**连续拒绝按文件计数**（3 次强制收尾）；超时按拒绝；等待期暂停 Budget（`pausedMs` 随检查点持久化，resume 不重计）；事件 `approval_requested`（只带摘要，**diff 不进事件流**）/`approval_decided`；接口 `GET|POST /api/runs/:id/approvals`（全文 diff 经 GET 拉取）。
- **Step 5 前端**：live 审批卡（diff 全文 + 按行着色、检查逐项 ✅/❌、三个决定按钮 + 拒绝理由、「待审批 N」徽标、决定后可回放）；契约文档重新生成（`agents/code-edit.agent.md`）。
- **Step 6 契约与编排开关**：新 spec `code-edit`（5 写工具 + 只读族 + `submit_finding`；权限恰等于工具并集；`maxRiskLevel:'high'`；走 `subAgentLoop`）；编排**默认不可派发写 spec**（`allowWriteSpecs=false`，fail-closed）+ 本 run 界面开关；主 Agent 保持只读。

**取舍**：① diff 只在磁盘/接口（事件流保持轻量，断线重放不背大 payload）；② 批量上限 10 文件/批（防打断疲劳，超出提示"本批通过后再提交"）；③ 写能力默认关闭（与 `run_tests` 同款门禁先例），沙箱不可用即拒绝而非降级为直写；④ `code-edit` 预算 12/12/24/120k 标为**待实测修正**（`specs.ts` 注释）。

**影响**：Runtime 从"只读 Agent"变为"可写但受控"——风险由三层兜住：沙箱（Linux 隔离 + 阶梯）→ 人工审批（三态）→ git/备份（自动回滚）。`run_command` 落宿主的副作用无法从沙箱同步（诚实清单）。

**验证**：全量 **269/269** 通过（新增 `tests/38_approval` 8 例 + `tests/39_write_tools` 9 例 + `tests/40_sandbox` 11 例）；`npm run typecheck` 0 错误；`npm run agents:lint` 3 项通过；4 个 Mock demo 全部 completed；真机 Docker：镜像构建成功、`40j` 真实容器 L0 阶梯通过（期间修掉两条实测缺陷：docker cp 属主 root → `chown -R node:node /work`；`esbuild --loader=ts` 对文件输入非法 → 改为按扩展名推断）。真实模型端到端见下一条。

**文件**：`src/sandbox/{docker,session,classify}.ts`、`src/tools/codebase/writeTools.ts`、`src/tools/shared/textEdit.ts`、`src/runtime/{AgentRuntime,subAgentLoop,Budget}.ts`、`src/store/SqliteStore.ts`、`src/server.ts`、`src/config.ts`、`public/index.html`、`src/agents/specs.ts`、`scripts/sandbox/{Dockerfile,build-image.mjs}`、`tests/{37_search_files_semantics,38_approval,39_write_tools,40_sandbox}.test.ts`、`docs/WRITE_AND_APPROVAL.md`、`.dockerignore`。

---

### M1 端到端实测收口：五处实测缺陷修复 + 终验复核（Step7/8）

**背景**：Step1..6 提交后必须"真跑一遍"才算数（两轮评审的第 0 节清单）。用**独立库/端口**起服务（`CODEBASE_WRITE_ENABLED=true LLM_MODE=openai PORT=3033 SQLITE_PATH=./data/m1-e2e.db`）+ 真实 deepseek-flash，走「编排 → code-edit 子 Agent → 沙箱 → 审批 → 落盘」全链路。**首轮实测直接全线失败**——写工具第一步就崩，且即便绕过也有三处会阻断落盘。

**改动（五处实测缺陷，全部带回归守卫）**：
1. **快照自引用崩溃**（`src/sandbox/session.ts`）：真实布局下宿主副本在 `<repo>/data/sandbox/<runId>/repo`（**dest 在 src 之内**），`fs.cpSync(repo, dest)` 的前置校验直接抛 `ERR_FS_CP_EINVAL: Cannot copy ... to a subdirectory of self`（filter 来不及生效）→ `create_file` 两次尝试全 EXECUTION_ERROR，模型如实上报失败。改为自实现递归拷贝 `copyRepoSnapshot()`，保留原排除语义（任何层级 `node_modules/data/.git/.workbuddy/.zcode` 跳过；符号链接/junction 跳过）。**`tests/40k` 钉死**（含 `cpSync` 抛错的对照断言）。注：`40j` 用 tmpdir 当 dataDir，结构上覆盖不到这个布局。
2. **hostVerify 继承运行期 env → 恒失败自动回滚**（`src/tools/codebase/writeTools.ts`）：宿主复验是 `spawnSync(node, ...)`，默认继承 server 进程环境。实测 `LLM_MODE=openai PORT=3033 SQLITE_PATH=./data/m1-e2e.db CODEBASE_WRITE_ENABLED=true` 下套件 **8 条用例失败**（17e/17j/17k/17l/17o/17p/20o/22q——全都在读 env / `loadConfig()`）→ 每次审批通过都走"落盘 → 复验失败 → 自动回滚"，文件**永远落不了盘**；而这正是 README 推荐的独立库实测姿势。新增 `sanitizeHostVerifyEnv()`（剔除应用配置键、保留 PATH 等系统键），复验环境对齐"新开 shell 跑 `npm test`"的可得状态。**`tests/39i` 钉死**。
3. **分类器被测试名污染**（`src/sandbox/classify.ts`）：全量套件输出会打印**测试名**（tests/39a「敏感文件拒写…」、tests/40e「ERR_DLOPEN_FAILED…」）→ 套件因任何原因失败都被误判 `SENSITIVE_FILE` / `ENV_MISMATCH`（实测 code-edit 收到"敏感文件拒写"修复提示后被带偏并放弃；`environmentIssue=true` 还会导致不重生成）。规则改为：l1/l2 套件来源不走文本类判定（`SENSITIVE_FILE/PATH_ESCAPE/OUTPUT_LIMIT`），一律 `TEST_FAIL`；`ENV_MISMATCH` 在套件来源需命中"错误行"（行内含 error/code:/errno）。**`tests/40l` 钉死**（含两条对照）。
4. **两个测试的平台假设**（`tests/14a`、`tests/32a2`）：`C:/Windows/system32` 在 Linux 是**相对路径**（穿透断言在容器内必然失败）；容器内 DNS 对 `localhost.` 直接 ENOTFOUND（尾点 FQDN 佐证断言失败）。后果：容器内全量套件恒 2 条失败，而 L1 的"无可映射测试 → 全量兜底"（v3-4）会因此**永久阻断一切未映射文件的改动**。改为平台分支断言 + 佐证失败即跳过（守卫本体断言不变）。容器内复测：**270 tests / 269 pass / 1 skip（40j 在容器内无 Docker）/ 0 fail**。
5. **diff header 残留宿主绝对路径**（`session.ts diffPatch`）：原实现 `replace(/a\.tmp/g, ...)` 只换子串，临时目录前缀残留在 header（审批卡显示 `diff --git "a/D:\c\345…\tmp\a/docs/x.md"`）。改为逐行重写 header（`diff --git a/<rel> b/<rel>` / `--- a/<rel>` / `+++ b/<rel>`），实测输出 `diff --git a/docs/_m1_smoke.md b/docs/_m1_smoke.md`。

**取舍**：不改 v3-4 的"全量兜底"语义（它明确要求"绝不允许找不到映射=不跑测试"），改的是**让容器里的全量套件真的能绿**（测试各自的平台假设就地修正，不降级为 skip）；净环境只剔应用配置键，不动系统键。

**影响**：写路径从"实测不可用"变为**实测可用**（deny 不落盘 / allow 落盘 + 宿主复验通过）；审批卡 diff 可读；阶梯失败提示不再误导模型；审批通过的改动在 env 非默认时也能真正落盘。

**验证**：全量 **272/272** 通过（269 + `40k`/`40l`/`39i`）；`npm run typecheck` 0 错误；`npm run agents:lint` 3 项通过；真实模型端到端（deny/allow 两态 + 粘性尝试，成本合计 < \$0.01）——事件链、无 diff 断言、diff 全文、拒绝不落盘、放行落盘 + `hostVerify{ran:true,ok:true}` 全部实测通过，逐条证据见 `docs/WRITE_AND_APPROVAL.md` §3。

**文件**：`src/sandbox/{session,classify}.ts`、`src/tools/codebase/writeTools.ts`、`tests/{14_codebase_security,32_adversarial,39_write_tools,40_sandbox}.test.ts`、`.eval/{m1-e2e-drive,m1-e2e-attach,m1-ladder-probe}.mjs`、`docs/WRITE_AND_APPROVAL.md`。

---

## 2026-10-14

### 错误聚合面板 + Provider 横评 + 并行收益 A/B（待办清单第三组）

**背景**：待办清单第三组（功能增强）：① provider 横评（R1）；② 错误聚合面板（R5）；③ 多 Agent 并行收益 A/B 量化（R2）。
**改动**：
- **错误聚合面板（R5）**：
  - `src/runtime/errorReporter.ts` 新增 `summary()`：按「code + location」聚合（次数/首末时间/样例消息/关联 run≤5/排查建议），排序=次数降序→最近发生降序，支持 runId/source 过滤与 limit；
  - `src/server.ts`：`GET /api/errors?view=summary`（不传 view 时行为不变，向后兼容）；
  - `public/index.html`：新增「错误」页签（高频 TOP 表：次数/错误码/位置/最近一次/样例消息/排查建议 + 最近错误原文 + 刷新按钮），切页签自动拉取；
  - 测试：`tests/24_error_reporting.test.ts` 新增 24n（聚合纯逻辑：去重计数/排序/最近样例/runIds 去重/过滤/limit）+ 24o（HTTP 聚合视图 + 向后兼容）。
- **Provider 横评（R1）**：`reports/PROVIDER_BENCHMARK.md`（新）——DeepSeek 实测（单 Agent 冒烟 2 步 / 1,737 tok / $0.00011 / 2.6s / 缓存命中 72.6%），另附同日 A/B 两个真实数据点；openai/qwen/moonshot/zhipu/ollama 因本机未配置 Key 如实标注「未测」，并给出逐条复现命令（配 Key 即跑，无需改代码）。
- **并行收益 A/B（R2）**：`reports/PARALLEL_AB.md`（新）——同一任务、同顶层预算（12 步/12 模型调用/200k token）三组对照：串行(≤24 工具)=**limit_reached 无产出**（19.5s/114k tok）；串行(≤60 工具)=completed **39.4s/221k tok/$0.0096**；编排=completed **243.7s/1,558k tok/$0.0827**（子任务 11/15 ok）。**结论：该任务形态下编排未回本（约 7× token）**；根因三条均可指认——子任务重复读取（159 次 read_file vs 串行 27 次）、`search_files` 陷阱迫使模型"逐行通读补偿"、重试链吞掉并行度（3 中断+1 失败+3 取消）。编排真正买到的是：分区覆盖、自报缺口（unresolved）、故障隔离。实测脚本：`.eval/ab-parallel.mjs`、`.eval/ab-collect.mjs`（工作区 `.eval/`，非项目本体）。
**影响**：错误可聚合看 TOP（不再被同错误淹没）；Provider 现状与复现路径固化；R2 从"未量化"变为"已量化且结论为负"，并直接指向 `search_files` 修复的 ROI（它同时污染单 Agent 效果与编排成本）。
**验证**：全量 **236/236 通过**（234 + 新增 2）；typecheck 0 错误；agents:lint 3 项通过；错误页签浏览器实测通过（聚合 2 组/最近 3 条渲染正常，截图见 2026-10-14 会话）。
**文件**：`src/runtime/errorReporter.ts`、`src/server.ts`、`public/index.html`、`tests/24_error_reporting.test.ts`、`reports/{CHANGELOG,PROJECT_REPORT,PARALLEL_AB,PROVIDER_BENCHMARK}.md`。

---

### 安全修复收口：审查 P0×2 + P1×4 全部修复，对抗断言转回归守卫

**背景**：`reports/CODE_REVIEW_2026-10-13.md` §6 修复路线图（先修 P0）。本次把 P0×2（run_tests 白名单前缀匹配 → RCE 面、SSRF 尾点 FQDN 绕过）与 P1×4（resume rejection 逃逸、junction 逃逸、FTS5/vec0 原生检索死代码）全部收口，并把对抗套件 5 条「BUG 证据」断言翻转成「回归守卫」——`tests/32_adversarial.test.ts` 从「断言缺陷存在」正式转为「断言缺陷不存在」。
**改动**：
- **P0-1 run_tests 白名单**（`src/tools/codebase/runTests.ts`）：前缀匹配改为「精确匹配，或 `node --test` + 仓库内相对测试路径」。新增 `verdictFor`（精确/模板判定）与 `isSafeNodeTestArg`（拒绝绝对路径、盘符、UNC、`..`、非测试文件；其余白名单命令一律禁止追加参数）。
- **P0-2 SSRF**（`src/tools/research/ssrf.ts` + `fetchPage.ts`）：host 去尾点后再校验（`localhost.` / `*.internal.` 与无尾点等价）；新增 DNS 解析后 IP 复核 `resolvesToPrivate()`——**初始目标与每个重定向目标都查**，解析到回环/私网/链路本地/云元数据段一律 `SSRF_BLOCKED`（防 DNS rebinding）。
- **P1-1 resume rejection**（`src/runtime/AgentRuntime.ts` + `src/server.ts`）：`resume()` 补齐显式 `.catch`（对齐 enqueue，经 `handleInternalError`）；`/api/runs/:id/resume` 路由再兜一层 `.catch`（`RESUME_REJECTION` + ErrorReporter），同步抛错路径返回 400。未捕获 rejection 不再崩进程。
- **P1-2 junction 逃逸**（`src/tools/shared/workspacePath.ts`）：存在的路径经 `realpathSync` 解析真实路径，再校验仍在（realpath 后的）仓库根内；链接指向仓库外 → `PATH_ESCAPE`（`escaped: true`，不泄露外部路径是否存在）。
- **P1-3/4 FTS5/vec0**（`src/knowledge/repository.ts` + `vectorRecall.ts`）：FTS SQL 补 `MATCH ?` 并对齐占位符（`ORDER BY rank`）；vec0 kNN 补 `MATCH ?` + 距离排序；「FTS 命中 0 条」保留 LIKE 兜底（非词首子串/CJK 的显式回退，不再是恒抛错的静默降级）。
- **对抗断言翻转 + 补钉**（`tests/32_adversarial.test.ts`）：a2/a3/c2/g1/g3 从「BUG 证据」改为「回归守卫」（b2 此前已是）；g1 子进程 PoC 断言从「崩溃（非零码）」改为「正常退出（码 0）」；g3 **新增原生路径钉死断言**——`repository.stats().fts === true`、`vectorRecall.stats().available === true` 且向量已真实入库，并打印实测值（避免「原生检索失效但兜底返回同样结果」的静默盲区，这正是本次修复要消灭的模式）。
- **收尾清理**：`Tracer.delta` 通道类型补 `'tool_call'`（流式 tool_call 首帧功能的类型收尾）；`server.ts` 的 `contextFiles` 过滤谓词改为返回真布尔（`f.trim() !== ''`）；`tests/34` 私有属性访问改 `as any`（与 `24_error_reporting` 既有约定一致）；b2/g1/g3 翻转后残留的「现状：有 BUG」陈旧注释改为「修复后 / 修复前」史实叙述。

**取舍**：
- DNS 复核按 **fail-open**（解析失败/2s 超时不阻断）：离线或临时解析失败不应打断正常公网访问；代价是「解析失败时不做 IP 复核」，边界写在函数注释里。
- FTS 命中 0 条才退 LIKE（而不是「FTS 不可用才退」）：FTS5 前缀查询查不到「非词首子串/连续 CJK」，兜底是能力补充，不是掩盖故障——但因此 g3 必须显式钉死原生可用性，否则无法区分「FTS 生效」与「兜底生效」。

**影响**：启用 `run_tests` 不再有任意文件读/任意 JS 执行面；`fetch_page` 恢复 SSRF 边界（含 DNS rebinding 复核）；恢复路径的未预期异常不再崩溃服务进程；仓库外文件不可经 junction/symlink 读出；宣称的 FTS5/vec0 原生检索**真实生效**（实测 `vec0 available=true, vectors=2`）。
**验证**：全量 **234/234 通过**（`npm test`）；`npm run typecheck` 0 错误；`npm run agents:lint` 3 项通过；对抗套件 20/20（5 条由 BUG 证据转为回归守卫）。性能实测：EventLogger 5 万 emit+flush 115ms / 批量 2 万 53ms / 压缩 1 万 7ms。
**文件**：`src/tools/codebase/runTests.ts`、`src/tools/research/ssrf.ts`、`src/tools/research/fetchPage.ts`、`src/tools/shared/workspacePath.ts`、`src/runtime/AgentRuntime.ts`、`src/server.ts`、`src/trace/Tracer.ts`、`src/knowledge/repository.ts`、`src/knowledge/vectorRecall.ts`、`tests/32_adversarial.test.ts`、`tests/34_tool_parallel_wave.test.ts`、`reports/{CHANGELOG,PROJECT_REPORT}.md`。

---

### ZCode 对标优化（P0×2 + P1×3）

**背景**：`reports/ZCODE_COMPARISON.md` 列出高 ROI 优化 5 项，按优先级从 P0 到 P1 依次完成。
**改动**：
- **P0-1 模型调用重试预算**（`src/llm/OpenAIProvider.ts`）：
  - 429/5xx/网络瞬断/流空闲 指数退避重试，默认 `retryBudget=2`（最多 2 次重试，共 3 次尝试）；
  - 流式一旦已向用户吐过增量（`emitted=true`）则不再重试，防内容重复；
  - 重试耗尽后错误注明已重试次数；
  - 新增 `streamIdleTimeoutMs=30s`：SSE 流超过此时长无增量则中止，标记为 `streamIdle` 可重试错误。
  - 测试：`tests/31_retry_budget.test.ts`（4 用例：429 重试成功、400 不重试、耗尽报次数、判定函数）。
- **P0-2 Token 水位感知 + 自动压缩**（`src/runtime/AgentRuntime.ts`）：
  - 每次模型调用后计算 `contextUseRatio = (promptTokens + completionTokens) / tokenBudget`；
  - ≥ `COMPACT_TRIGGER_RATIO=0.6` 时触发 `compactMessages()`：保留 system[0] + 最近 `COMPACT_KEEP_TAIL=6` 条，中间段替换为摘要消息（含角色+内容，上限 3KB）；
  - 压缩事件通过 `emitLive` 实时推送（不落盘），同时 `console.log` 记录；`tracer.finish` 的 `extra` 始终带 `contextUseRatio` 供前端进度条。
  - 测试：`tests/33_compact_messages.test.ts`（4 用例：不足不压、超阈值压缩、摘要长度受限、集成触发）。
- **P1-3 工具并行波验证**（`src/runtime/AgentRuntime.ts`，已有实现）：
  - `executeTools` 已是并发工作池：`maxToolConcurrency=4`，`Promise.all(workers)` 驱动；
  - 带预算检查/错误隔离/每工具重试（`MAX_RETRY=1`，仅 safe 工具）。
  - 测试：`tests/34_tool_parallel_wave.test.ts`（2 用例：4 工具并发总耗时≈单工具、并发上限配置存在）。
- **P1-4 流式 tool_call 首帧反馈**（`src/llm/OpenAIProvider.ts` + `src/types.ts`）：
  - `LLMDelta.channel` 扩展为 `'reasoning' | 'content' | 'tool_call'`；
  - `accumulateOpenAIStreamChunk` 检测到新 tool_call 分片（首次创建 entry 且具备 id+name）时返回 `toolCallStarted`；
  - `chatStreaming` 立即 `onDelta({ channel: 'tool_call', text: JSON.stringify(...) })`，前端可提前渲染工具卡片骨架；
  - `AgentRuntime` 的 `streamAcc` 忽略 `tool_call` 通道（不混入正文预览）；`MockProvider` 同步支持流式 emit tool_call。
  - 测试：`tests/35_streaming_tool_call.test.ts`（3 用例：首帧上报、最终装配正确、Mock 流式 emit）。
- **P1-5 `@` 文件级上下文引用**（`src/types.ts` + `src/server.ts` + `src/runtime/AgentRuntime.ts` + `public/index.html`）：
  - `RunInput` 新增 `contextFiles?: string[]`；
  - `validateRunRequest` 解析 `body.contextFiles`（去重/上限 20/过滤空值）；
  - `AgentRuntime.executeLoop` 在 system 之后、goal 之前注入「用户指定起点文件，请优先直接读取」提示；
  - 前端 goal 输入框支持 `@相对路径` 语法：实时解析为高亮 pill，提交时自动提取为 `contextFiles`。
  - 测试：`tests/36_context_files.test.ts`（2 用例：去重过滤、注入位置正确）。

**影响**：
- 模型调用可靠性显著提升（429/网络错自动恢复，不手动重跑任务）；
- 长对话 token 开销受控（自动压缩防预算耗尽）；
- 流式 UI 体验提升（tool_call 卡片提前出现，减少「空白等待」感知）；
- 用户可通过 `@路径` 精确引导 Agent 从指定文件开始分析。

**取舍**：
- 重试预算放在 Provider 层而非 Runtime 层：Provider 更了解厂商错误码语义，且流式重试需跟踪 `emitted` 状态，放在 Runtime 会耦合流式细节；
- 压缩触发阈值 0.6（而非 0.8）：过早压缩会丢失有用上下文，过晚则失去意义；0.6 是 ZCode 报告的对标值，实测在 10 轮对话后触发，移除 3 条历史，保留最近 6 条 + system + goal，平衡效果明显；
- `tool_call` 走 `LLMDelta` 而非独立事件：减少前端事件处理分支，复用现有 `llm_delta` 实时通道；
- `@` 语法保留在 goal 文本中：用户可直观看到引用，同时后端单独收到结构化 `contextFiles`，双重可用。

**验证**：全量测试 **234/234 通过**（新增 11 用例）；`npm run typecheck` 0 错误；`npm run agents:lint` 通过；`npm run report:refresh` 参数台账/契约文档/Agent 报告均已刷新。
**文件**：`src/llm/OpenAIProvider.ts`、`src/runtime/AgentRuntime.ts`、`src/types.ts`、`src/llm/MockProvider.ts`、`src/server.ts`、`public/index.html`、`tests/31_retry_budget.test.ts`、`tests/33_compact_messages.test.ts`、`tests/34_tool_parallel_wave.test.ts`、`tests/35_streaming_tool_call.test.ts`、`tests/36_context_files.test.ts`、`reports/CHANGELOG.md`、`reports/PARAMETERS.md`、`reports/AGENT_REPORT.md`。

---

## 2026-10-13（晚）

### C-17 全面代码审查 + 对抗性测试套件（20 用例，7 大类）

**背景**：用户要求对包做全面代码审查（架构/实现状态/已知问题），并从边界条件、异常输入、并发、安全性、性能、逻辑漏洞多角度设计并执行测试，按严重程度输出结论。
**改动**：
- **新增 `tests/32_adversarial.test.ts`**（20 个子测试，全部通过）：A SSRF（checkUrl 纯函数 24 目标 + `fetch_page` 端到端 PoC）/ B run_tests 白名单 / C 路径穿越·junction·敏感文件 / D HTTP 输入校验 / E 并发（40 enqueue·事件序号·批量落库）/ F 性能（5 万事件·2 万批量·1 万消息压缩）/ G 逻辑漏洞（resume rejection·misc 钳制·FTS5/vec0 死路径）。约定：「回归守卫」断言安全性质（防回退），「BUG 证据」断言当前真实行为（修复后这些断言会失败，提醒改回守卫形态）。
- **新增 `tests/32_g1_child.ts`**：32g1 的子进程 PoC 载体（复刻 server.ts `/resume` 的 `void result` 路径，证明进程会崩溃）。
- **审查结论落 `reports/CODE_REVIEW_2026-10-13.md`**（新增交付物）：按 P0/P1/P2/P3 分级共 17 项，P0 两项——run_tests 白名单前缀匹配导致任意文件读+RCE、SSRF 尾点 FQDN 绕过（端到端实测读出本地服务内容）；P1 四项——resume rejection 逃逸致进程崩溃、junction 逃逸、FTS5/vec0 原生检索死代码（恒抛错静默降级）。
**影响**：未改产品代码（纯测试+文档）。测试规模 203 → **223** 全绿；typecheck 0 错误；agents:lint 通过。修复路线图见审查报告 §6（修 P0-1/P0-2 优先）。
**验证**：`node --import tsx --test "tests/*.test.ts"` → 223/223；对抗套件 20/20；性能实测 5 万事件 85ms / 2 万批量 46ms / 1 万消息压缩 6ms。
**文件**：`tests/32_adversarial.test.ts`（新）、`tests/32_g1_child.ts`（新）、`reports/CODE_REVIEW_2026-10-13.md`（新）、`reports/CHANGELOG.md`、`reports/PROJECT_REPORT.md`。

---

## 2026-10-13（下午）

### C-11 子 Agent 生命周期自动回收 + 知识库语义向量召回层

**背景**：用户要求两件事——① 子 Agent 完成低重要性任务（一次性搜索）后系统自动判断何时释放资源（上下文清理/销毁）；② 把系统打造成可维护、可持续成长的知识库——调研业界先进方案/GitHub 开源项目，下载集成并适配，支持动态维护与扩展。此前 `SubAgentPool` 只管并发执行无「何时释放」判断；知识库只有 FTS5 关键词检索无语义召回。
**改动**：
- **子 Agent 生命周期**（`src/runtime/SubAgentLifecycle.ts`，新）：
  - `SubAgentSpec` 新增 `retention`（importance: ephemeral/session/durable + idleTimeoutMs + maxAgeMs）；三个内置 spec 已标注：doc-research/dir-inventory=`ephemeral`，code-audit=`session`+5min idle；
  - 七条释放判定规则（`shouldRelease`，纯函数、规则式、不调 LLM）：父取消→maxAge→失败→ephemeral终结/消费/预算耗尽→闲置超时；
  - 池级 LRU 驱逐（`pickEvictionVictim`）：池满优先驱逐已结束 ephemeral→闲置最久 ephemeral→session→durable；
  - 有状态管理器 `SubAgentLifecycle`：register/touch/markTerminalReported/markConsumed/markEnded/retire/sweep/cancelByParent；释放时 `unconsumedResult` 不静默丢弃；
  - 契约文档（`renderDocs.ts`）渲染 retention（第 8 节 + 一览表新列）。
- **语义向量召回层**（`src/knowledge/vectorRecall.ts`，新）：
  - 集成 **sqlite-vec** v0.1.9（已 `npm i sqlite-vec`，本机探测可加载）；用**辅助列 `data_id text`** 关联 data_items.id（v0.1.9 不允许显式传 rowid，实测踩坑后改此方案）；
  - 可降级：sqlite-vec 不可用→全表扫描+内存余弦重排（与 FTS5→LIKE 同约定）；
  - 默认 `HashEmbedder`（词+字符3-gram 哈希向量，确定性、零依赖、中文友好）；接口已留，可注入 `@xenova/transformers` 真嵌入器升级；
  - `KnowledgeHub` 集成：putData 同步 upsert 向量、deleteData 同步 remove、新增 `searchSemantic`/`searchHybrid`（关键词∪语义融合去重，matchedBy 标注）、stats 含 vector 维度。
- **依赖**：`package.json` 新增 `sqlite-vec ^0.1.9`（dep）、`tsx ^4.23.15`（devDep，固化——此前未 pin 导致一次 `npm install` 把它 prune 掉）。
- 测试：`tests/27_subagent_lifecycle.test.ts`（31 用例）、`tests/28_vector_recall.test.ts`（14 用例）。
**影响**：低重要性子 Agent 不再常驻；知识库具备「按意思」召回能力（关键词+语义双通道），为后续真语义嵌入器/compaction/自动入库管道铺路。详见 `docs/SUBAGENT_LIFECYCLE_AND_KNOWLEDGE.md`（含业界调研：LangGraph/CrewAI/Swarm 生命周期 + sqlite-vec/LlamaIndex/Chroma 选型对比）。
**验证**：typecheck 0 错误；全量测试 **190/190 通过**（原 137 + 新 45）；`agents:lint` 三项通过（retention 已纳入文档）；sqlite-vec 真实 kNN 实测可用。
**文件**：`src/runtime/SubAgentLifecycle.ts`（新）、`src/agents/specs.ts`、`src/agents/renderDocs.ts`、`src/knowledge/vectorRecall.ts`（新）、`src/knowledge/index.ts`、`agents/*.md`（重新生成）、`tests/27_subagent_lifecycle.test.ts`（新）、`tests/28_vector_recall.test.ts`（新）、`package.json`、`docs/SUBAGENT_LIFECYCLE_AND_KNOWLEDGE.md`（新）。

---

## 2026-10-13

### C-16 ZCode 对标分析与优化路线（文档级 + 真实遥测基准）

**背景**：用户要求调研 ZCode（Z.ai 智谱开源 coding agent）的实现机制，与本项目对比（响应速度/代码生成质量/上下文连续性/错误处理），产出逐步优化建议清单。
**改动**：`reports/ZCODE_COMPARISON.md`（新）：
- ZCode 六大机制调研结论（回合状态机 / 依赖感知工具并行波 / 子代理=子运行时 / 三层上下文压缩+跨会话记忆 / 模型适配层重试预算 / 产品层 Goal Mode·@引用·AGENTS.md）；
- 本项目真实遥测基准：模型调用 P50 1.9s / P95 13.1s（n=238）、运行 P50 10.5s / P95 71s（n=38）、真实完成率 ~60%、失败主因 MODEL_ERROR×8；
- 10 项改进建议（每项含问题/差异/方向/预期收益），按 5 批次实施：P0 重试预算+token 水位压缩 → P1 并行波+流式工具装配+@ 引用 → P2 错误学习闭环+LLM 摘要+结论自检 → P3 Plan 模式+AGENTS.md/文件缓存。
**影响**：纯文档；为后续迭代给出按 ROI 排序的路线图。
**文件**：`reports/ZCODE_COMPARISON.md`（新）、`reports/CHANGELOG.md`。

---

### C-15 记忆压缩：超出活跃窗口的对话自动归纳，防记忆丢失

**背景**：用户确认四项能力现状。发现「记忆」只有滚动窗口（最近 6 轮），超出窗口的对话虽仍存于 `context_turns`，但**没有任何归纳/摘要机制**把早期内容带回模型——早期重要上下文会"丢"。
**改动（设计并实现自动归纳总结）**：
- `src/knowledge/context.ts`：新增 `SUMMARY_WINDOW=6`、`extractiveSummarize()`（默认提取式摘要，问/答前缀 + 预算截断）、`SessionSummarizer` 可注入接口；`ContextStore` 构造器支持注入摘要器（LLM 摘要器升级点）；`appendTurn` 后自动 `maybeSummarize()`——把活跃窗口外的历史轮次压缩进 `contexts.summary`，并用 `meta.summarizedThroughTurn` 记录进度（幂等、增量）。
- `RunInput` 加 `contextSummary`；`AgentRuntime` 把它作为一条「之前对话摘要」消息注入（system 之后、history 之前）；`validateRunRequest` 裁剪到 4000 字。
- 前端提交时自动计算「超出最近 6 轮的更早对话」的提取式摘要，作为 `contextSummary` 发送。
- 测试 `tests/30_memory_summary.test.ts`（4 用例）：超窗归纳不丢早期内容、摘要器可注入、注入顺序正确。
**影响**：连续长对话时，即使早期轮次被移出活跃窗口，模型仍能通过摘要记得"之前聊过什么、结论是什么"。
**验证**：typecheck 0；全量 **199/199 通过**（195 + 4 新增）。
**文件**：`src/knowledge/context.ts`、`src/types.ts`、`src/runtime/AgentRuntime.ts`、`src/server.ts`、`public/index.html`、`tests/30_memory_summary.test.ts`（新）、`reports/CHANGELOG.md`。

---

### C-14 前端改进：记住工作区路径 + WorkBuddy 式分组面板

**背景**：用户要求① 仓库/工作区路径记住上次填写并选择的值（本地持久化、下次自动回填）；② 整体 UI 采用 WorkBuddy 式编排，把操作分组到清晰区块/面板，从用户视角设计、流程直观、反馈清晰。
**改动**：
- **① 工作区偏好持久化**：localStorage 新增 `mta_repoPath` / `mta_runType`。`persistWorkspacePrefs()` 在 repoPath 变更（change）与 runType 切换（onchange）时保存；`restoreWorkspacePrefs()` 加载时回填，并**重跑 `showFields()` 联动字段显隐**（否则恢复的 runType 不会显示对应字段）。`rememberKeys` 关闭时也照常记住路径/类型（不含敏感信息）。
- **② 设置面板分组**：原来一个「⚙️ 设置」大 `<details>` 里堆了 LLM/搜索/流式/预算/编排全部内容（且 apiPanel 又嵌套）。重构为**四个平级手风琴分组**：`任务参数`（编排/misc/research 条件字段 + Mock 剧本 + 步数/上限/超时）、`模型 LLM`（模式/服务商/模型/Key/连接测试/Token 限制/高级参数）、`搜索`、`实时流 & 存储`。加 `.panel-title` 与 `.settings` 卡片样式（边框+浅底，分组清晰）。所有 ID 不变，`toggleApiFields`/`showFields` 等逻辑零改动。
**影响**：工作区路径与任务类型跨刷新记住，不用每次重填；设置从「一堵墙」变成四个可折叠分组，找配置更直观。
**验证**：HTML `<details>` 配平（11/11）、关键 ID 唯一、前端脚本 `node --check` 通过；`/` 已实时提供新页面（sendFile 读盘，无需重启）。
**文件**：`public/index.html`（CSS + 设置面板重构 + 工作区偏好持久化）、`reports/CHANGELOG.md`。

---

### C-13 多轮对话：新提问不再清空之前对话 + 模型能记住前文

**背景**：用户反馈「每次再问问题都把之前的给弄掉了」——不是持久化的问题，而是**每次提交 `liveReset` 清空实时视图 + 清空 answer/sources/reports**，之前的问答直接消失；且新任务不携带前文，模型无法做 follow-up。
**根因**：单次运行的「实时视图」模型——每次新运行都从零渲染，没有「对话累积」概念；后端 `buildSystemPrompt` 后只塞 `goal` 一条 user 消息，历史对话不进入模型上下文。
**改动**：
- **对话线程（前端累积）**：右栏顶部新增「对话记录」折叠区（`#conversationLog`），`rememberConversation` 每次写 localStorage 后 `renderConversationHistory()` 重渲染；`finalizeConversation` 记录 `answer`；点击历史问题回填输入框（事件委托，避免内联 onclick 转义坑）。新提交只清当前运行视图，**之前的问答保留在对话记录里**。
- **多轮上下文（后端）**：`RunInput` 加 `contextHistory`（`{role:'user'|'assistant', content}[]`）；`AgentRuntime` 把它插到 `system` 之后、本次 `goal` 之前（裁剪 10 轮 × 2000 字）；`validateRunRequest` 规范化；前端提交时自动带最近 6 轮已完成问答。
- 测试 `tests/29_context_history.test.ts`（2 用例）：有 contextHistory 时顺序正确、无 contextHistory 时行为不变。
**影响**：连续提问时，之前的问答不再消失，且模型真正「记得」前文——follow-up（如「那第一点再展开讲讲」）能接续上下文。
**验证**：typecheck 0；全量 **195/195 通过**（193 + 2 新增）。
**文件**：`public/index.html`、`src/types.ts`、`src/runtime/AgentRuntime.ts`、`src/server.ts`、`tests/29_context_history.test.ts`（新）、`reports/CHANGELOG.md`。

---

### C-12 交互与数据持久化改进：卡死/超时修复 + 对话持久化 + 知识库语义检索 + 底部输入框

**背景**：用户要求四项改进：① 修复页面卡死与请求超时并说明成因；② 明确对话上下文保存位置与机制、恢复工作区已保存对话与上次会话；③ 建立可检索知识库（历史对话 + 工作区内容）并考虑向量语义检索；④ 输入方式改为 WorkBuddy 式底部输入框。
**改动**：
- **① 卡死/超时修复**：根因排查出 `raw()` 对每个事件**无条件** `JSON.stringify` 大 payload（工具结果可 256KB）→ 主线程反复阻塞。改为**懒序列化**（debug 开启才序列化 + 截断 8KB）。`OpenAIProvider` 加 `timeoutMs`（默认 120s）+ `withCallTimeout()` 合并「运行级 signal」与「单次调用超时」，流式/非流式都套上。
- **② 对话持久化**：两层存储——权威层 `contexts`/`context_turns`（SQLite，`/api/context`），本机缓存层 localStorage（`mta_conversations`/`mta_lastSession`/`mta_finalizedRuns`）。提交时 `saveSessionOnStart`（openSession + user turn）、完成时 `finalizeConversation`（assistant/system turn + 入库，幂等防重）、加载时 `restoreLastSession` 回填上次 goal。
- **③ 知识库语义检索**：复用已有 `Repository`(FTS5) + `VectorRecall`(sqlite-vec vec0，HashEmbedder 兜底 + 可注入真嵌入器)。新增 `GET /api/knowledge/search?mode=keyword|semantic|hybrid`；`scripts/ingest-knowledge.ts` 回填存量 runs/conversations（`--dir` 可索引工作区文件结构）；运行完成时前端自动 `PUT /api/data` 增量入库。实测语义召回：`打包器对比→比较两个打包器`、`代码改进方案→代码分析运行`。
- **④ 底部输入框**：左侧 380px 侧栏改为 340px 折叠式「⚙️ 设置」；新增 `position:sticky` 底部输入栏（任务类型 + repoPath + goal + 开始/取消），goal 自动增高 + Ctrl/Cmd+Enter 提交。ID 不变，`showFields`/`NEEDS_WORKSPACE` 等逻辑零改动。
**影响**：重任务不再因调试序列化卡死；模型调用挂起 120s 即失败而非拖到总超时；对话跨浏览器/重启可恢复；历史对话与运行进入语义可检索知识库；输入体验对齐 WorkBuddy。
**验证**：前端 `node --check` 通过；typecheck 0 错误；全量 **193/193 通过**；回填 180 runs / 180 向量（sqlite-vec 可用）。
**文件**：`public/index.html`、`src/llm/OpenAIProvider.ts`、`src/server.ts`、`scripts/ingest-knowledge.ts`（新）、`docs/INTERACTION_PERSISTENCE_PLAN.md`（新）、`reports/CHANGELOG.md`。

---

### C-11 修复：thinking×maxTokens 把正文吃光 → 子任务全 EMPTY_RESULT（诊断驱动）

**背景**：用户运行一次多 Agent 编排（`run_mv6afboo`，目标"看看这个文件有什么改进方案并给个小demo"），4 个子任务全部失败，界面上满屏 "llm delta #0"、最终答案残缺为"未"。
**根因（查事件流定位）**：每个子任务最后一步都是 `stop=max_tokens、completionTokens=2000、contentLen=0`——**思考型模型的思考 token 计入 `max_tokens`**，而 `code-audit` 契约自己配了 `thinking:'enabled' + maxTokens:2000`，2000 全被思考吃光，正文一个字都没输出 → 既没调用 `submit_finding` 也没文本 → `EMPTY_RESULT`。主 Agent 同理（用户 UI 参数 `maxTokens:2048 + thinking:enabled`）→ 最终答案被截断。
**改动**：
- `src/llm/presets.ts` `sanitizeParamsForModel`：新增 **thinking×maxTokens 防护**——thinking 开启且 `maxTokens < 8192` 时抬到 `THINKING_MIN_MAX_TOKENS=8192`，并**如实记录 `adjusted`**（不是静默改写）。不满足条件（thinking 关 / maxTokens 未设 / 已≥8192）不触碰。
- `src/llm/OpenAIProvider.ts`：`BuiltParams` 加 `adjusted`；`buildParamsBody`/`buildRequestBody` 透传；`chatOnce`/`chatStreaming` 把 `paramAdjustments` 附加到 `LLMResponse`，让事件可披露。
- `src/types.ts`：`LLMResponse` 加 `paramAdjustments?`；`ParamAdjustment` 类型定义在底层（避免循环依赖）。
- `src/runtime/subAgentLoop.ts`：截断失败从笼统的 `EMPTY_RESULT` 区分为可定位的 `OUTPUT_TRUNCATED`，消息点明根因（"思考 token 计入上限、把额度吃光了，调大 maxTokens 或关 thinking"）+ 带上当时 `spec.modelParams`；llm finish 事件透出 `paramAdjustments`。
- `src/runtime/AgentRuntime.ts`：主循环 llm finish 同样透出 `paramAdjustments`。
- `src/agents/specs.ts`：`code-audit` maxTokens 2000→**8192**、`doc-research` 1600→**8192**（思考型契约的硬上限原本就太小，根因之一）。
- 测试 `tests/27_thinking_guard.test.ts`（3 用例）：防护抬升+披露、Provider 透传、子 Agent 截断→`OUTPUT_TRUNCATED`+可定位消息。`tests/20_llm_params.test.ts` 20c 的 maxTokens 抬到 8192 以专注测"采样参数丢弃"。
**影响**：thinking 模式下不会再因 maxTokens 过小而静默产出空正文；即使发生，失败消息也直接点出根因与处置，而不是"啥都没产出"。本次根因里有**两个独立源**：契约自带的小 maxTokens（杀所有子任务）+ 用户 UI 的小 maxTokens（杀主 Agent），都被覆盖。
**验证**：typecheck 0 错误；全量 **193/193 通过**；agent 文档与 PARAMETERS 报告已重新生成（漂移门禁通过）。
**文件**：`src/llm/presets.ts`、`src/llm/OpenAIProvider.ts`、`src/types.ts`、`src/runtime/subAgentLoop.ts`、`src/runtime/AgentRuntime.ts`、`src/agents/specs.ts`、`tests/27_thinking_guard.test.ts`、`tests/20_llm_params.test.ts`、`agents/*.agent.md`、`reports/PARAMETERS.md`、`reports/CHANGELOG.md`。

---

### C-10 新增「知识系统」：上下文管理 + 历史与变更追踪 + 数据仓库（三模块互通，可追溯）

**背景**：用户要求构建一个包含上下文管理（多轮保持与检索）、历史记录（操作日志/会话记录/变更追踪，按时间与类型查询）、数据仓库（持久化/分类/高效检索）的系统，且三模块数据互通、保证一致性与可追溯性。此前系统只有 runs+events 一种历史维度，Agent 产出的数据散落在事件流里无法结构化查取，也没有变更追踪与多轮上下文召回。
**改动**：
- 新增 `src/knowledge/`（4 文件）：
  - `repository.ts` 数据仓库：`data_items`（collection/itemId/type/tags/content）+ **FTS5** 全文检索（standalone 表，与数据行同事务同步；不可用降级 LIKE）；
  - `history.ts` 历史与变更追踪：复用现有 events（操作日志）+ runs（会话记录），新增 `audit_log`（at/correlationId/actor/action/resourceType/resourceId/before/after/meta）；按时间/actor/action/资源查询 + 统一时间线 `timeline()`（合并 runs + audit，events 可选并入）；
  - `context.ts` 上下文管理：`contexts` + `context_turns`，`getRecent` 滚动窗口保持多轮、FTS5 跨会话检索相关历史上下文；
  - `index.ts` 门面 `KnowledgeHub`：写数据 + 写审计在**同一事务**（嵌套=SAVEPOINT）；事件在事务外发；每次操作返回 `correlationId`，同时出现在 audit + 事件 + 资源关联——`GET /api/history/trace/:correlationId` 一键串起。
- 服务端路由（`src/server.ts`）：`/api/data`（CRUD + 全文）、`/api/history`（+timeline +trace）、`/api/context`（会话/turn/检索）、`/api/knowledge/stats`。
- **互通契约**：一次逻辑操作 = 一条 audit + 一条事件 + 同一 correlationId 贯穿三库；有归属 run 则事件持久化进该 run 时间线，无则发 ephemeral（实时可见、不污染 events），审计日志作持久兜底。
- **顺带修复：孤儿运行回收**。此前重启会留下永久 `running` 的行（污染列表与每日效能统计）。现在 `buildRuntime` 启动时自动收口：标记 `failed`(errorCode=`RUN_INTERRUPTED`) + 补 `runtime_error` 事件（seq=max+1 保持回放连续，**直接写库**避开内存计数器撞号）+ 写 `run_interrupted` 审计 + 错误报告，四者共用 `corr_orphan_*`。这是知识系统「变更追踪」的首个真实用例。
- `SqliteStore`：`listOrphanRuns` / `finalizeInterruptedRun` / `database` getter（暴露给知识系统共享连接）。
- `ErrorReporter`：新增 `skipEvent` 入参（回收时事件序号由 store 接续，不走内存计数器）+ `RUN_INTERRUPTED` 提示。
- 测试 `tests/26_knowledge.test.ts`（8 用例）：三模块各自能力 + 互通可追溯 + 孤儿回收 + 幂等 + API 烟雾；`tests/24_error_reporting.test.ts` 顺手让 `withServer` 用临时日志（测试不再向生产 `errors.log` 写噪音）。
**影响**：Agent 的结构化数据有了可分类、可全文检索的落点；任意一次写操作可从事件、数据、审计任一入口一键追溯到全貌；重启不再留下"永远在跑"的幽灵运行。
**验证**：typecheck 0 错误；全量测试 **145/145 通过**（137 既有 + 8 新增）；FTS5 探测可用；真实库孤儿运行已随重启被回收。
**文件**：`src/knowledge/*`（新）、`src/store/SqliteStore.ts`、`src/runtime/index.ts`、`src/runtime/errorReporter.ts`、`src/server.ts`、`src/types.ts`、`tests/26_knowledge.test.ts`、`tests/24_error_reporting.test.ts`、`docs/KNOWLEDGE_SYSTEM.md`（新）、`reports/CHANGELOG.md`。

---

### C-09 修复：orchestrator 提交时漏带 repoPath（"界面填了却报缺少 repoPath"）

**背景**：用户截图显示——任务类型选「多 Agent 编排」、界面明明填了 `<workspace>//llm_test`，提交却报 `创建失败: orchestrator 任务必须提供 repoPath`。
**根因**：**同一份列表写了两处**：字段显隐处（`showFields`）在新增 orchestrator 时改到了，但**提交时收集参数的判断（`body.repoPath = …`）漏改**——于是界面有输入框、请求里却没有这个字段，服务端按约返回 400。
**改动**：把「需要工作区的任务类型」收敛为唯一常量 `NEEDS_WORKSPACE = ['codebase','misc','orchestrator']`，字段显隐与参数收集**同源**；并在前端提交前**先自检**——该填没填就在答案区直接说明是哪个字段，不必等服务端 400。
**影响**：多 Agent 编排可以直接提交了（已用用户当时那条路径实测：201 + runId）。
**教训**：同一份「枚举清单」出现在多处 = 迟早漏改一处。要么收敛成常量，要么由代码生成。
**验证**：JS 语法检查通过；POST `/api/runs`（orchestrator + `<workspace>//llm_test`）返回 **201 创建成功**。
**文件**：`public/index.html`（3 处）、`reports/CHANGELOG.md`、`reports/AGENT_REPORT.md`（重新生成）。

---

### C-08 新增「Agent 效果报告」（每天自动生成，与上次环比）+ 每日定时播报

**背景**：用户澄清——想定期看的不是"工程状态台账"（参数值/测试数/错误码），而是**关于 Agent 本身的报告**：它干了什么、干得怎么样、能力到哪、调参有没有效果；并且要**每天**出（便于与前几日对比）。
**改动**：
- `scripts/gen-agent-report.ts`（新，`npm run report:agent`）：**只读**扫 `data/runtime.db`，自动生成 `reports/AGENT_REPORT.md`：
  §0 与上次环比 ｜ §1 任务台账与效果指标（汇总 / 各 Agent 表现 / 失败原因分类 / 最近 20 条明细） ｜ §2 行为过程报告（成功与失败样本的**逐帧轨迹**：每轮推理耗时·工具调用·结果·错误码） ｜ §3 能力边界实况（实测数字 + 未验证项） ｜ §4 调参效果对比（按「模型+参数指纹」分组对比耗时/tokens/成本/成功率）
- 每日指标快照落 `reports/history/agent-YYYY-MM-DD.json` → 支撑环比与趋势
- `run_started` 事件补记 `llmProvider/llmModel/llmParams`（让 §4 能真正按参数分组，而不是只有模型名）
- `report:refresh` 现在把「参数台账 + 契约文档 + Agent 报告」一起刷新
- **每日 09:00 定时任务**：自动生成报告并把摘要播报给用户（含异常提示与排查建议）
**影响**：**首次生成暴露了一个必须正视的数字——真实模型成功率 38.1%（Mock 91.4%）**，失败集中在 `MODEL_ERROR`×8 / `tokenBudget`×2；工具级失败 `INVALID_ARGS`×43 与 `DISABLED`×45（前者是修复前的历史积累，后者是 `run_tests` 默认关闭的预期行为）。这些此前只在日志里，现在每天可见。
**验证**：typecheck 0 错误；首次生成扫描 **151 个任务 / 3517 条事件**，报告含完整行为样本（含用户真实任务"我这个loop你测试感觉如何"的 9 步轨迹）。
**文件**：`scripts/gen-agent-report.ts`、`reports/AGENT_REPORT.md`、`reports/history/`（新）；改 `src/runtime/AgentRuntime.ts`（1 处事件字段）、`package.json`。

---

### C-07 补充「数据库选型」决策记录（文档级，无代码改动）

**背景**：用户提问"如果要做这种项目，数据库要用什么"。
**改动**：`docs/DESIGN_DECISIONS.md` 新增 §13——按**数据形态**（状态 / 事件流 / JSON 文档 / 大文本 / 日志 / 缓存 / 向量）与**部署规模**（单机 → 多机 → 出报表）给出分阶段选型；含从 `SqliteStore` 迁移到 Postgres 的路径与 3 个坑（`seq` 多进程原子分配、批量事务语义、时间戳类型），以及 4 条反模式。
**影响**：纯文档；对现状无影响（继续用 SQLite，其适用边界已写明）。
**验证**：无需跑测试（未改代码）。
**文件**：`docs/DESIGN_DECISIONS.md`、`reports/CHANGELOG.md`。

---

### C-06 多 Agent「跑不通」故障修复 + 统一错误报告机制

**背景**：用户反馈多 Agent 功能无法正常运行。定位到 8 条根因（详见 `docs/ERROR_REPORTING.md` 事故复盘），其中两条最关键：
1. **工具契约过严/不一致**——`search_files` 只认 `pattern`（模型写 `query`）、`read_file` 只认 `path`（模型写 `file`）、路径只认「相对仓库根」、上报结构必须是对象数组（模型爱写字符串）→ 一次运行产生 22 次失败调用，把子 Agent 的步数预算耗光。
2. **错误报告基本缺失**——`void executeLoop().finally()` 会吞掉 Promise rejection，**任务永远停在 `running`、界面毫无反应**，这是「查不下去」的根源。

**改动**：
- 工具契约宽容化：参数别名、`resolveWorkspacePath()`（相对仓库根/工作区相对/绝对；越界与不存在区分）、`reportNormalize()`（字符串数组→对象；来源缺失如实计入 unresolved）、`Tool.inputExample`（参数报错附正确示例）
- 修复静默错误：`dir_stats/list_files` 收到 `path` 时不再悄悄统计整个仓库
- 编排守卫：`DUPLICATE_OBJECTIVE`（拒绝重复派发同一 objective）
- 补齐错误报告：`ErrorReporter`（四要素：位置/类型/码/上下文 + 排查建议）→ 三落点（`runtime_error` 事件 / `data/errors.log` / `GET /api/errors`）；覆盖执行循环、子 Agent、委派、工具、provider、路由中间件、进程级未捕获、**浏览器** `window.onerror`
- 局部失败显式化：`OrchestrationReport.partial` + 界面红色「⚠️ 部分成功」横幅

**影响**：同一真实任务（DeepSeek）**子任务 1/6 → 4/4 成功**；tokens ↓73%（50,577→13,784）；墙钟 ↓62%（70.4s→27.0s）；失败调用 22→4（均可自愈）。任何异常都有可 grep 的记录与位置。

**验证**：typecheck 0 错误；`npm test` **137/137**；`agents:lint` 通过；真实 DeepSeek 端到端复跑两次。
**文件**：`src/runtime/errorReporter.ts`、`src/tools/shared/{workspacePath,reportNormalize}.ts`、`docs/ERROR_REPORTING.md`、`tests/24_error_reporting.test.ts`（新）；改 `types.ts`、`config.ts`、`index.ts`、`server.ts`、`AgentRuntime.ts`、`Registry.ts`、4 个工具、`specs.ts`、`public/index.html`。

---

### C-05 多 Agent 协作（主调度 + 并行子 Agent）

**背景**：需要主 Agent 拆分、多个子 Agent 并行执行，并明确职责边界与接口契约。
**改动**：新增 runType `orchestrator`：
- **拆分**：规则式预筛（`preSplit.ts`，零 token，按目录/主题分区）+ 主 Agent 细化（提示词含拆分判据）
- **边界**：注册 ≠ 披露 ≠ 授权三处分离；深度守卫靠「子 Agent 上下文不注入派发能力」；宽度守卫 `WIDTH_LIMIT`
- **并行**：`SubAgentPool`（有界并发 + 级联取消 + 部分失败转结果 + 结果顺序=派发顺序）
- **契约**：`src/agents/specs.ts` 为唯一事实来源；`agents/*.md` 由 `npm run agents:docs` 生成，`npm run agents:lint` 做漂移门禁（已实测能抓出「权限超集=偷偷提权」）
- **文档**：`designs/multi-tool-agent-harness-design-v1.md`（可编码设计 + 独立评审回修 5 项）

**影响**：新增 3 个子 Agent 契约（dir-inventory / code-audit / doc-research）；新增 3 个工具（delegate_subtasks / submit_finding / submit_orchestration）；子任务 span 进入既有流程图与瀑布图。
**验证**：`npm test` +19 项；`agents:lint` 三项通过（并验证"手改一个字即报漂移"）。
**文件**：`src/agents/*`、`src/runtime/{preSplit,SubAgentPool,subAgentLoop}.ts`、`src/tools/orchestrator/*`、`src/demo/orchestrator.ts`、`agents/*.md`、`designs/*.md`、`tests/{22,23}_*.test.ts`。

---

### C-04 杂项子 Agent（misc）+ 规则式任务分流

**背景**：需要专门处理杂项与低优先级琐碎任务的子 Agent。
**改动**：新增 runType `misc`（只读、小预算、默认关思考）；`dir_stats`（只读清点）+ `submit_result`（终结性结构化提交）；`classifyTask` 规则式分流器（不调 LLM）；`GET /api/task-router` + 界面「自动分流 / 一键改派」。
**影响**：琐事不再消耗大预算；超范围时主动 `escalateTo`（codebase/research/human）；破坏性动作返回 `requiresHuman`。
**验证**：`npm test` +14 项；`npm run demo:misc` 通过。
**文件**：`src/tools/misc/*`、`src/runtime/router.ts`、`docs/MISC_AGENT.md`、`tests/21_misc_agent.test.ts`。

---

### C-03 LLM 可选式配置 + Token 限制 + DeepSeek 接入

**背景**：需要界面可配 Token 限制；baseUrl/模型改为可选项而不是手填；优先接入 DeepSeek；并提供可调参数。
**改动**：`presets.ts`（7 个 Provider 预设，DeepSeek 优先，含表价）+ `params.ts`（参数校验，越界即报错）+ `testConnection.ts`（真实连通性测试 + SSRF 防护）；界面新增「Token 限制」（max_tokens / 任务 Token 预算 / 费用预算）与「高级生成参数」（temperature/top_p/penalties/thinking/reasoning_effort）；开始任务后回显**生效配置 + 被忽略的参数**；费用估算改为按表价 + 缓存命中计价。
**影响**：**DeepSeek 经真实 API 端到端验证**（原 `deepseek-v4-flash` 猜测错误，实测应为 `deepseek-flash`）；费用估算从固定 \$1/1M（高估约 20 倍）改为按表价。
**验证**：`npm test` +26 项；`LLM_MODE=openai npm run smoke:llm` 通过（4 步/4 模型调用/3 工具调用/3697ms）。
**文件**：`src/llm/{presets,params,testConnection}.ts`、`docs/LLM_CONFIG.md`、`tests/20_llm_params.test.ts`。

---

### C-02 实时流式展示（Live View）

**背景**：要求 AI 思考过程实时流式可见 + 工具调用同步显示状态与结果，体验对齐主流 vibecode 工具。
**改动**：双通道事件（持久化 + `onLive` 实时快车道）；`LiveHub` 进程内分发；Provider 流式（Mock 分片 + OpenAI SSE 解析）；SSE 三段式端点（回放 / 实时 / 看门狗）+ 心跳 + `Last-Event-ID`；界面「实时」页签（思考逐字 + 工具卡片 + 调试面板）。
**影响**：实测「产生→推送」延迟 P50=P95=**0ms**（max 1.0ms）；增量不落盘（`ephemeral` 事件不占 seq）。
**教训**：SSE 处理器里若「回放终态事件先触发 cleanup」后仍创建定时器 → 两个 interval 永不清理、进程无法退出（已修）。
**验证**：`npm test` +9 项；`npm run smoke:stream` 通过。
**文件**：`src/trace/{LiveHub,EventLogger,Tracer}.ts`、`docs/STREAMING_LIVE_VIEW.md`、`tests/19_streaming.test.ts`。

---

### C-01 可视化监控（Trace）+ 前端「流程监控」

**背景**：需要 Agent Loop 与工具调用的可视化监控（流程图 + 瀑布图）与检测模块。
**改动**：`Tracer`（`performance.now()` 精确计时 + span 事件）、`buildTraceSnapshot`（纯函数聚合）、`EventLogger` 异步批量落盘、`/api/runs/:id/trace`、前端流程图 + SVG 瀑布图。
**验证**：`npm test` +6 项；全量 49/49（当时）。
**文件**：`src/trace/Tracer.ts`、`docs/TRACE_VISUALIZATION.md`、`tests/18_tracer.test.ts`。

---

## 模板（新增变更时复制这段）

```markdown
### C-XX <一句话标题>

**背景**：为什么要做这件事（触发点 / 问题 / 需求）。
**改动**：做了什么（按模块列，能对上文件）。
**影响**：用户可感知的变化 + 实测数字（没有数字就写"未测量"）。
**验证**：跑了什么命令、结果如何（typecheck / 测试数 / 实测）。
**文件**：新增与改动的关键文件。

**教训**（可选）：踩过的坑，以及为什么踩。
```

参数改动**必须**同时补到顶部「参数变更总表」；改完跑一次 `npm run report:refresh` 让 `PARAMETERS.md` 与 `agents/*.md` 跟上代码。
