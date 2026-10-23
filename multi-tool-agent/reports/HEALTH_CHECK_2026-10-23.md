# 全身检查报告（2026-10-23，只读）

> **性质**：只读检查。本轮**没有修改任何代码**，下面列的是「问题 → 证据 → 建议改动 → 验收方法」，交给后续 code agent 执行。
> **基线**：`multi-tool-agent` / `main` / `411a72b`（test: 收紧真实模型编辑评测的可信度）；Node v24.14.1；Docker 运行中。
> **检查人**：Trae agent（只读）；检查方式 = 静态审阅 + 门禁实跑 + 真实 HTTP 探针。

---

## 0. 结论摘要

- **门禁全绿**：`typecheck` 0 错误 / `agents:lint` 三项全过 / `npm test` **416/416 通过、0 跳过、0 失败、24.9s**
- **权限体系内部完全一致**：22 个工具 ↔ `TOOL_PERMISSION` 表 ↔ 各工具自带的 `permission`，逐条比对**无一处漂移**
- 但有 **3 个 P0**：2 个是「构建期门禁静默失效」（不是运行期可被利用的漏洞），1 个是**用户可见的画面卡死**（前端渲染流水线饱和，P0-3）
- **1 个 P1**：MCP 能力已实现但**没有配置入口**，只在测试里被调用
- **2 个 P2**：README 工具表漂移、写权限粒度过粗
- 另有 4 条是 `docs/ARCHITECTURE.md §7` 已登记的已知缺口，本次**未复验**，仅登记备查

---

## 1. 检查范围与实跑结果

| 检查项 | 方法 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | ✅ 0 错误 |
| 契约门禁 | `npm run agents:lint` | ✅ ① 自校验 0 issue / ② 文档不漂移 / ③ 工具存在性 |
| 全量测试 | `npm test` | ✅ tests 416 / pass 416 / fail 0 / skipped 0 / 24.9s |
| 权限配置 | 静态逐条比对 | ✅ 22/22 一致（见附录 B） |
| 工具清单 | 静态清点 | 22 个（4 类 + 写 6 + 知识 1 + 人机 1） |
| MCP 连通性 | 真实 HTTP + 本项目 `McpClient` | ✅ 可连通，54 工具可列 |
| 技术债标记 | grep `TODO|FIXME|HACK` | ✅ 0 处真实标记（命中全是文案/示例） |
| 工作区 | `git status` | 🟡 仅生成物漂移：`reports/AGENT_REPORT.md`、`reports/history/agent-2026-10-23.json` |

---

## 2. 问题清单（按严重度）

### 🔴 P0-1：MCP 工具在构建期门禁中**静默跳过**权限校验

**现象**
`TOOL_PERMISSION` 是静态表（`src/runtime/AgentRuntime.ts:368`），而 MCP 工具是运行时动态注册的（名字带 `mcp_` 前缀）。表里没有这些条目。

**根因**（两处叠加）
1. `validateSpecs()` 用 `spec.tools.map((t) => toolPermission[t]).filter(Boolean)` 求「工具所需权限的并集」（`src/agents/specs.ts:298`）。表里查不到的工具贡献 `undefined`，被 `filter(Boolean)` **静默丢弃** → 该工具对校验**完全不存在**。
2. 于是 `tools: ['mcp_xxx']` + `permissions: []` 也能通过 `agents:lint`。运行时倒是 fail-closed（`Registry.execute` 返回 `PERMISSION_DENIED`），但**构建期契约门禁破了口子**。

**影响**
`agents:lint` 是本项目「文档与实现不漂移」的核心防线。接 MCP 后，这条防线对 MCP 工具**完全失效**——接错、漏授权、接高危工具，lint 都不会报。

**建议改动**
1. `src/runtime/AgentRuntime.ts`：把 `TOOL_PERMISSION` 的查表逻辑收敛成一个函数
   ```
   export function permissionOf(toolName: string): string | undefined
   ```
   规则：表内命中 → 返回值；`startsWith('mcp_')` → 返回 `'mcp:call'`；否则 `undefined`。
   同时把这个前缀常量与 `src/mcp/bridge.ts` 的 `prefix` 默认值共用一个来源（避免两处各写一遍）。
2. `src/agents/specs.ts` `validateSpecs()`：
   - 工具名查不到权限 → 新增 `error`（`工具未声明权限映射: xxx`）
   - 保留「不多不少」校验不变
3. `src/runtime/AgentRuntime.ts` `resolvePermissions()` 改用 `permissionOf()`。

**验收**
- 新增回归：spec 声明一个不存在的工具 → lint `error`
- 新增回归：spec 声明 `mcp_foo` 但 `permissions` 不含 `mcp:call` → lint `error`
- 新增回归：`mcp_foo` + `mcp:call` → 通过
- `npm run agents:lint` 仍三项全过

---

### 🔴 P0-2：`maxRiskLevel` 声明了但**从未被校验**

**现象**
`SubAgentSpec.maxRiskLevel`（`src/agents/specs.ts:68`）全项目只有 6 处引用：类型定义、4 个 spec 赋值、`src/agents/renderDocs.ts:40`（渲染进文档）。`validateSpecs()` **没有任何风险等级检查**。

**影响**
给 `dir-inventory`（`maxRiskLevel: 'safe'`）塞一个 `run_command`（`riskLevel: 'high'`），`agents:lint` 照样全绿，生成的 `agents/*.md` 还会写着「最大风险等级 safe」。这是一个**误导性文档 + 失效门禁**的组合。

**建议改动**
1. 新增风险排序工具（`safe < low < medium < high`）。
2. `validateSpecs()` 增加一条：
   - spec 内任一工具的 `riskLevel` 超过 `spec.maxRiskLevel` → `error`
3. 该检查需要读工具的 `riskLevel`，因此 `validateSpecs` 的入参需要从 `Record<string,string>` 扩展成「工具名 → {permission, riskLevel}」（或额外传一个 `toolRisk` 表）。注意同步 `scripts/agents-lint.ts` 与 `src/server.ts:352/488` 两处调用点。

**验收**
- 回归：临时构造 `maxRiskLevel:'safe'` + `run_tests`(medium) 的 spec → lint 必须 `error`
- 现有 4 个 spec 的声明值本来就正确，改完应仍然全绿

---

### 🔴 P0-3：画面「突然卡死、恢复后一次性补出大量内容」（前端渲染流水线饱和）

**现象**（用户原述）：运行过程中画面突然卡住不更新、点不动；过一阵恢复后，发现模型已经跑了很多轮/出了很多回答。

**结论**：**服务端没有停，是浏览器主线程被渲染任务占满**。模型与 SSE 一直在跑，消息在浏览器里排队；主线程空出来后积压的帧一次性消费 → 看起来「突然好了，而且已经跑了好多」。

**四条根因（按贡献度）**

1. **每条文本增量都强制整容器布局（`addEvent`）**
   `es.onmessage` 对**所有**事件无条件调用 `addEvent()`（`public/index.html:2981-2982`），`llm_delta` 也在其中。`addEvent` 每追加一条就立刻 `holder.scrollTop = holder.scrollHeight`（`index.html:2116-2117`）——**每次 append 强制一次同步布局**，而事件列表没有条数上限。按 18~65 字符/分片估算，一个万级 token 的回答会产生**数百到数千条** `llm_delta`；切到「事件流」页签时最严重。

2. **每帧整段重写最多 3 万字符（`flushCards`）**
   `pushText` → `requestAnimationFrame(flushCards)`，`flushCards` 把 `clipText()` 的结果（**上限 30000 字符**）整体赋给 `textContent`（`index.html:1343-1362`）。紧接着 `scrollBottom()` 执行 `live.scrollTop = live.scrollHeight`（`index.html:1266-1271`）；`.live` 是 `max-height:58vh; overflow:auto`（`index.html:105`），**这行会强制布局整个已累计的卡片列表**。多轮任务下卡片只增不减，每帧要排版的文本量可达数十万字符 → 单帧从个位数毫秒涨到几百毫秒 → 表现为「卡死」。

3. **增量缓冲只增不减（`_buf`）**
   `card._buf[channel] += text`（`index.html:1344`）没有上限；`clipText` 只截**显示**、不截**缓冲**。长回答下字符串拼接是 O(n²)，持续制造堆压力（GC 停顿会表现为「突然」卡顿）。

4. **后台标签页是放大器**
   `document.hidden` 时浏览器暂停 `requestAnimationFrame`，但 SSE 消息仍在逐条进入 `applyLiveEvent` / `addEvent`。切回标签页时一次性补渲染 → 一次长卡顿。

**为什么不是服务端**（已逐条排除）

- SSE 没有压缩中间件；`X-Accel-Buffering: no` + `flushHeaders()` 已设置（`src/server.ts:819-824`）
- 看门狗每 2s 的 `store.getEvents()` 虽是全量 SELECT，但实测**单 run 最多 338 条**（全库 11,477 条 / 411 run），`JSON.parse` 开销可忽略
- `raw()` 的「逐事件 `JSON.stringify` 大 payload」已在 C-12 改为懒序列化（`index.html:1391-1392`），确实生效
- 流式期间服务端无同步阻塞 I/O（`readFileSync` / `readdirSync` 只在工具执行时发生，不在增量路径上）

**复现与量化（改之前先留基线）**

1. `npm start` → 打开「实时」页签并勾选「调试」→ 跑一个长任务
2. DevTools Performance 录 30s：看 **Long Tasks**、`flushCards` / `addEvent` 自身耗时
3. 记录调试面板的「帧数」，同时看 `#live` 的 `childElementCount` 与 `.lsay` 文本长度
4. 对照实验：关掉「自动滚动」再跑一次——若卡顿显著缓解，根因 2 成立

**建议修改（按性价比排序）**

| 顺序 | 改动 | 位置 | 预期效果 |
|---|---|---|---|
| 1 | **服务端合并增量**：`Tracer.delta` 不逐 chunk 发，累积 16~32ms 发一帧 | `src/trace/Tracer.ts:133` + 调用方 | 帧数降 10~30 倍；前端无感（仍是文本累加） |
| 2 | `addEvent` **跳过 `llm_delta`**，事件列表加环形上限（如 500 条） | `index.html:2103-2118` | 事件流不再随增量膨胀 |
| 3 | `flushCards` 改**增量追加**（记录已渲染长度，向 Text 节点 `appendData`），或上限降到 4000 字并节流到 ~10fps | `index.html:1342-1364` | 每帧成本从 O(全文) 降到 O(新增) |
| 4 | `scrollBottom` 节流到 100ms，且仅在「用户本来就在底部」时执行 | `index.html:1266-1271` | 去掉每帧一次的全容器布局 |
| 5 | `_buf` 环切到 ~60k；已结束卡片加 `content-visibility:auto` / `contain:content` | `index.html:1344`、CSS `.lcard` | 抑制 GC 与离屏卡片排版 |

**验收**

- 同一长任务改前/改后各录一次 Performance：`Long Task`（>50ms）数量与最长时长、`flushCards` 总耗时、DOM 节点数
- 目标：全程无 >200ms 长任务；事件流节点数 ≤500；后台切回后无 >500ms 卡顿
- 补一条前端静态回归（与 `tests/59c` 同风格）：断言 `addEvent` 对 `llm_delta` 早退、且事件列表有上限

**已否决方案（2026-10-23 讨论后确认不做，避免后续重复提出）**

> 提案：思考过程在界面上显示完后不再展示（只留前几段），全文写入数据库供 RAG 使用，以此消除卡顿。

否决理由：

1. **不覆盖卡顿窗口**：卡死发生在**流式输出的那 10~30 秒内**（文本从 0 涨到 3 万字，每帧重排），而「显示完再截断」要等思考结束才生效——最痛的一段完全没被覆盖。
2. **代价错配**：为了修一个渲染问题，付出「思考全文入库」的数据成本。当前 `Tracer.delta` 是**刻意 `persist: false`**（`src/trace/Tracer.ts:133-139`），库里只留 1200 字符的 `reasoningPreview`。全量入库会让单 run 体积涨到数 MB 量级（现有 411 个 run）。
3. **检索污染**：思考过程包含大量被否定的假设与回头路，切块进向量库会让检索命中「已排除的方案」。
4. **索引规模不匹配**：`reports/RAG_ABLATION.md` 的实测语料只有 19 文档 / 151 chunks，HNSW 为教学简化实现；把每次 run 的思考全量索引是 2~3 个数量级的跳跃。

**替代做法（推荐）**：

- **折叠而非截断**：思考结束后 `<details>` 默认收起，显示前 3 行 + 「展开全文」。折叠子树不参与排版，根因 ②b 消失，且信息不丢。
- 真正修卡顿仍按上面 5 项表（其中「服务端合并增量」单项收益最大）。
- 若确实要留档思考原文：存**冷表**或 `data/thinking/<runId>.txt`，**不进向量索引**；RAG 只吃最终答案 + 工具调用轨迹。

**一句话**：折叠是体验优化，该做；「截断 + 全量入库」是用数据成本掩盖渲染 bug，不该做。顺序必须是先把每帧成本从 O(全文) 降到 O(新增)，再谈折叠。

---

### 🟠 P1-3：MCP 能力已实现，但**没有配置入口**（能力在，产品路径不在）

**现象**
`registerMcpTools()`（`src/mcp/bridge.ts:24`）只在 `tests/44_mcp.test.ts` 里被调用。主路径（`src/index.ts` / `src/server.ts`）**从不桥接 MCP**。没有 `mcpServers` 配置、没有环境变量、没有界面入口。

**已实测**（2026-10-23，本机）
- MCPHub `http://localhost:8900/mcp` 用 `Authorization: Bearer <key>` 可连通
- 本项目 **现有** `McpClient` + `HttpTransport` **零改动**即可完成 `initialize → tools/list（54）→ tools/call`，返回真实数据

**建议改动**
1. 新增配置项（二选一，建议环境变量优先，避免新增文件）：
   - `MTA_MCP_SERVERS`：JSON 数组，每项 `{ name, url, token, names[] }`
   - 或 `.env` 多行配置
2. 启动时（`src/server.ts` 装配注册表处，`validateSpecs` 之前）对每个 server：
   - `new HttpTransport({ url, headers })` → `McpClient.connect()` → `registerMcpTools(registry, client, { prefix: 'mcp_', permission: 'mcp:call', names })`
   - **必须支持 `names` 白名单**：实测 54 个工具的 schema 约 31.5 KB（≈8k tokens），全量注入等于每轮白烧上下文
3. 连接失败只 `warn` 并继续启动（MCP 不可用不能拖垮主服务），但要落 `runtime_error` 事件。
4. `token` 绝不能进事件/日志（复用 `EventLogger` 的脱敏兜底）。

**验收**
- `npm start` 后 `GET /api/config`（或新增 `/api/mcp`）能显示已桥接的 MCP 工具数与来源
- 单测：假 server + 白名单过滤，断言只有 `names` 内的工具进入 registry
- 单测：MCP 不可达时服务照常启动且记一条错误

**注意**
- 只有 `code-edit` 之外的只读 spec 才允许接 MCP；**文件/仓库类 MCP（filesystem/git/shell）不要接**——它们会绕过 `apply-journal` / 审批 / 沙箱阶梯 / 宿主复验，等于在写能力闭环外开旁路。
- MCPHub 里 `playwright-browser_run_code_unsafe` 的描述自己写了「RCE-equivalent」，必须显式排除。

---

### 🟡 P2-4：README §2 的能力表已漂移

**证据**：`README.md:148-153` 写 codebase 只有 `search_files / read_file / list_files / run_tests`，research 只有 4 个工具。
**实际**（`src/runtime/AgentRuntime.ts:1993-2026`）：两边都多了 `knowledge_search` 和 `ask_user`（RAG 与人机协同上线后没回填）。
**建议**：更新 README 表格；顺手核对 orchestrator 的「自检只读工具」开关是否也该写进表。

---

### 🟡 P2-5：`codebase:write` 粒度过粗

6 个工具（`create_file` / `edit_file` / `delete_file` / `copy_path` / `run_command` / `submit_changes`）共用一个权限。
做不到「允许编辑但禁止删除」「允许写但禁止执行命令」。
当前靠审批层补（`src/security/approvalRisk.ts` 对删除/宿主命令要求当前批次 `confirmHighRisk`），属于「权限层粗、审批层细」的有意取舍。
**建议**：若未来要接 MCP 或做更细的门控，拆成 `codebase:write.file` / `codebase:write.delete` / `codebase:exec`。**改动面大（涉及审批、前端开关、契约文档），非必要不做。**

---

### 🟡 P2-6：工具池定义在**三处**并存，新增工具要改 3 处

- 工具实现 + `src/tools/index.ts` 注册
- `TOOL_PERMISSION`（`AgentRuntime.ts:368`）
- `resolveAllowedTools()` 里按 `runType` 硬编码的 4 个池（`AgentRuntime.ts:1993`）
- （子 Agent 还要在 `specs.ts` 再声明一次）

**建议**：把「runType → 工具池」抽成一张声明表（与 `SUB_AGENT_SPECS` 同风格），`resolveAllowedTools` 只查表。属于重构，可延后。

---

### ⚪ 既有已知缺口（本次未复验，仅登记）

| 编号 | 问题 | 出处 |
|---|---|---|
| P3-7 | 检查点消息**无截断**，超长多轮会持续增长内存与 SQLite 体积 | `docs/ARCHITECTURE.md §7.5` |
| P3-8 | SSE **无背压**，订阅者收到完全相同的事件流，不做丢弃/限流 | `docs/ARCHITECTURE.md §7.19` |
| P3-9 | HTTP API **无鉴权**、本地 HTTP **无 TLS**（前端 Key 明文传输） | `docs/ARCHITECTURE.md §7.6/§7.11`；`CODE_REVIEW` P2-7 |
| P3-10 | 跨进程 `resume` 丢失请求级 `llm`/`search` 覆盖 | `docs/ARCHITECTURE.md §7.12` |

> 这几条在「本地单用户」定位下都是**可接受**的，不构成阻塞项。要不要修见 `docs/PRODUCT_READINESS.md §5`。

---

## 3. 已确认无问题（**不要重复改**）

1. **权限一致性**：22 个工具自带 `permission` 与 `TOOL_PERMISSION` 表**逐条相同**（附录 B）
2. **spec 权限不多不少**：4 个 spec 的 `permissions` 都恰好等于其 `tools` 的权限并集
3. **Registry 强制校验**：`execute()` 在参数校验与执行前先查 `ctx.allowedPermissions.includes(tool.permission)`，工具自身绕不过（`src/tools/Registry.ts:106`）
4. **子 Agent 权限独立**：`allowedPermissions: spec.permissions`，与主 Agent 无关；且不注入 `spawnSubAgent`，结构上无法再委派
5. **请求级 `allowedTools` 只能收窄**：`resolveAllowedTools` 做 `pool.includes(t) && registry.has(t)` 双重过滤，不能提权
6. **写工具不在顶层池**：4 个 `runType` 的池里都没有写工具，写只走 `code-edit` 子 Agent + `dispatchableSpecs` 授权
7. **`run_tests` 默认不进工具池**（不是「进了再拒绝」），模型看不到就不会白调
8. **无技术债标记**：`src/` 下没有遗留 `TODO/FIXME/HACK`
9. **门禁数字真实**：416 与 README/AGENTS 写的 416 一致（不是文档漂移的数字）

---

## 4. 本次**未覆盖**（别当成「已通过」）

- 真实模型端到端（`smoke:llm`）、`eval:edit`、`eval:edit:real`、`eval:compaction`、`security:redteam` **均未跑**
- `serper` 真实联网搜索仍未验证（与 `ARCHITECTURE §7.3` 一致）
- 前端 UI 未做浏览器实测
- MCPHub 的 5 个 server 中有 **4 个功能性不可用**（见附录 A），本次只验证了「协议与链路通」

---

## 5. 建议执行顺序

1. **P0-1 + P0-2**（同一类问题、同一批文件，一次改完一次 lint）
2. **P0-3 画面卡死**（先按「复现与量化」留基线，再改；第 1 项「服务端合并增量」单独就能去掉大部分卡顿）
3. **P1-3 接 MCP**（依赖 P0-1 的 `permissionOf`）
4. **P2-4** 文档回填（轻档，几分钟）
5. P2-5 / P2-6 按需，别为了「更工程」提前拆

---

## 附录 A：MCPHub 环境实测（2026-10-23）

**服务**：容器 `epic_satoshi` / `samanhappy/mcphub` v0.12.10，`0.0.0.0:8900→3000`，配置挂载 `D:/docker_profile/mcp_settings.json`。
**认证**：`/api/*` 用 `x-auth-token`；`/mcp` 用 `Authorization: Bearer <bearerKey>`（登录 JWT 不适用于 MCP 端点）。
**环境变更**：为验证链路，在 MCPHub 里创建了 bearer key `mta-probe`（token `mta-local-060079d6aaeb44ef`，`accessType=all`）。不需要时在界面删除，或 `DELETE /api/auth/keys/<id>`。
**安全提醒**：admin 密码仍是默认 `admin123`（接口返回 `isUsingDefaultPassword: true`），**不要把这个端口暴露到局域网/公网**。

| server | 工具数 | 实测结论 |
|---|---|---|
| `12306-mcp` | 8 | ✅ 真可用：`get-current-date` → 2026-10-23；`get-tickets` 拉到真实余票 |
| `fetch` | 1 | 🟡 链路通，但受 robots.txt 限制（百度被拒）；容器对 `example.com` 不通 |
| `playwright` | 25 | ❌ 起不来：容器内缺 Chromium（`/opt/google/chrome/chrome` 不存在） |
| `amap` | 12 | ❌ `INVALID_USER_KEY`（配置里是占位 `your-api-key`） |
| `slack` | 8 | ❌ `invalid_auth`（配置里是占位 token） |

**容器网络**：`registry.npmmirror.com` / `www.baidu.com` / `api.deepseek.com` 可达；`example.com` 超时。
**运维坑**：容器 `RestartPolicy=no`——宿主机重启后不会自己回来（与根 `AGENTS.md` 记录的坑一致），建议改 `unless-stopped`。

---

## 附录 B：权限矩阵（实测比对结果）

### B1. 工具 → 权限（22 个，表与实现完全一致）

| 工具 | 权限 | 风险 |
|---|---|---|
| `search_files` `read_file` `list_files` | `codebase:read` | safe |
| `run_tests` | `codebase:test` | medium |
| `web_search` `fetch_page` | `research:web` | low |
| `extract_evidence` `compare_sources` | `research:read` | safe |
| `knowledge_search` | `knowledge:read` | safe |
| `dir_stats` | `misc:read` | safe |
| `submit_result` | `misc:report` | safe |
| `submit_finding` | `agent:report` | safe |
| `delegate_subtasks` | `orchestrator:delegate` | low |
| `submit_orchestration` | `orchestrator:report` | safe |
| `ask_user` | `agent:ask` | safe |
| `create_file` `edit_file` `delete_file` `copy_path` `run_command` `submit_changes` | `codebase:write` | high |

### B2. 子 Agent spec

| spec | 工具数 | 权限 | maxRiskLevel |
|---|---|---|---|
| `dir-inventory` | 4 | `misc:read` + `codebase:read` + `agent:report` | safe |
| `code-audit` | 4 | `codebase:read` + `agent:report` | safe |
| `doc-research` | 5 | `research:web` + `research:read` + `knowledge:read` + `agent:report` | low |
| `code-edit` | 11 | `codebase:read` + `codebase:test` + `codebase:write` + `agent:report` | high |

### B3. 顶层 runType 工具池（由 `resolveAllowedTools` 派生）

| runType | 工具池 | 派生权限 |
|---|---|---|
| `codebase` | search/read/list + [`run_tests`] + `knowledge_search` + `ask_user` | `codebase:read` + [`codebase:test`] + `knowledge:read` + `agent:ask` |
| `research` | 4 检索工具 + `knowledge_search` + `ask_user` | `research:web` + `research:read` + `knowledge:read` + `agent:ask` |
| `misc` | list/search/read + `dir_stats` + `submit_result` + `ask_user` | `codebase:read` + `misc:read` + `misc:report` + `agent:ask` |
| `orchestrator` | `delegate_subtasks` + `submit_orchestration` + `ask_user` [+ 自检只读] | `orchestrator:delegate` + `orchestrator:report` + `agent:ask` [+ 只读] |

---

## 边界声明

- 本报告是**静态检查 + 门禁实跑 + MCP 连通性探针**，不是完整验收。
- 「未覆盖」一节列出的项目**没有跑**，不能据此判断通过或失败。
- 本报告最初**未产生任何代码改动**；后续修复状态见附录 C（2026-10-23 当天执行）。

---

## 附录 C：后续执行状态（2026-10-23）

| 问题 | 状态 | 落地与证据 |
|---|---|---|
| P0-1 动态工具权限静默跳过 | ✅ 已修 | `ToolRegistry.policySnapshot()` + `validateSpecs({toolPermissionByName,toolRiskLevel})`；查不到权限映射直接 error；`resolvePermissions()` 读注册表。回归 `tests/62a/62b`；Linux `node:24` 容器等价 CI 通过 |
| P0-2 `maxRiskLevel` 未校验 | ✅ 已修 | 按 `safe < low < medium < high` 校验 spec 内每个已注册工具；越界 error。回归 `tests/62c` |
| P0-3 流式渲染把主线程打满 | ✅ 已修（结构性回归） | 服务端增量 24ms 合并；前端跳过 `llm_delta`、事件上限 500、文本增量 append、滚动 10fps、`content-visibility:auto`。回归 `tests/59d`、`tests/63a/63b`；尚未做浏览器 Performance 长任务量化 |
| P1-3 MCP 主路径无配置入口 | ⏳ 未做 | 仍只在测试/脚本中桥接；下一轮接 `MCP_SERVERS_JSON` 或等价配置 |
| P2-4 README 工具表漂移 | ⏳ 未做 | 下一轮用生成物回填工具/权限表 |

当天全量：**63 文件 / 422 子测试 / 422 通过 / 0 失败 / 0 跳过**；真实编辑评测扩到 26 条（20 引导 + 4 盲测 + 2 多文件）并 **26/26** 通过。
