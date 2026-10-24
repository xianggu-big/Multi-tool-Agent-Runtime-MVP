# 交互与数据持久化改进方案（INTERACTION & PERSISTENCE）

> 覆盖四项：① 页面卡死/请求超时修复；② 对话上下文保存位置与恢复机制；③ 知识库（历史对话 + 工作区内容，向量语义检索）；④ 底部输入框改造。
> 状态标记：【已实现】= 本轮已落地并验证；【方案】= 已给出具体做法与接入点，待后续实施。

---

## 一、页面卡死与请求超时（成因 + 修复）

### 1.1 成因（已排查定位）

| # | 成因 | 位置 | 后果 |
|---|---|---|---|
| R1 | `raw()` 对**每个** model/tool/subtask 事件**无条件** `JSON.stringify(e, null, 2)`（共 12 处调用），即使调试面板隐藏也在序列化。工具结果可含 256KB 文件内容/上千条目录 → 主线程每事件一次 O(n) 序列化 | `public/index.html` `raw()` | 重任务时主线程被反复阻塞 → **页面卡死** |
| R2 | 模型调用**无单次超时**，只有运行级总超时（`totalTimeoutMs`）。某一次模型请求挂起（网络抖动/供应商无响应）时，要等整个运行的总超时才失败 | `src/llm/OpenAIProvider.ts` | 用户体感**「请求超时」**（长时间无响应） |
| R3 | 前端 `setInterval` 轮询每秒 `GET /api/runs/:id/events?limit=500` 拉全量事件（含大 data），与 SSE 并存；事件多时响应体大、`JSON.parse` 重 | `public/index.html` `startPolling` | 放大 R1、加重网络与解析 |
| R4 | 思考型模型产生大量 `llm_delta`（reasoning 可达数千 token） | 已用 rAF 合并 + 30k 截断缓解 | 基本可控，规模化后仍是压力点 |

### 1.2 修复（已实现）

- **R1**：`raw()` 改为**懒序列化**——`LIVE.debug` 关闭时直接 `return` 不 stringify；开启时序列化后截断到 8KB 并提示看 `/api/runs/:id/events`。**这是卡死主因，一行守护解决。**
- **R2**：`OpenAIConfig` 增加 `timeoutMs`（默认 120s），`OpenAIProvider` 用 `withCallTimeout()` 把「调用方运行级 signal」与「单次调用超时」合并（`AbortController` + 定时器），流式/非流式两条路径都套上，`finally` 清理。
- **R3（方案）**：SSE 打开时轮询退化为低频兜底（仅断线重连时启用）；`/events` 增加 `?fields=` 白名单以裁剪大字段。本轮未改轮询频率（避免行为回归），列为下一步。

### 1.3 涉及功能点

- Provider 单次调用超时（可配置）。
- 前端调试序列化懒执行 + 截断。
- （待办）事件接口按需裁剪 + 轮询降级。

---

## 二、对话上下文：保存位置与恢复机制

### 2.1 保存位置（两层，职责明确）

| 层 | 位置 | 存什么 | 生命周期 |
|---|---|---|---|
| **权威持久层** | 后端 `contexts` / `context_turns`（SQLite，经 `/api/context`） | 每个会话的 title + 有序 turns（user/assistant/system） | 跨浏览器、跨重启；工作区内长期保存 |
| **本机缓存层** | 前端 `localStorage`（`mta_conversations` / `mta_lastSession` / `mta_finalizedRuns`） | 最近 50 条会话摘要 + 上次会话 id + 已收尾集合 | 仅本机，用于秒级恢复与幂等 |

> 权威层在 SQLite（复用知识系统的 ContextStore），前端 localStorage 只是「最近一次」的快捷恢复，二者不冲突、后端为准。

### 2.2 机制（已实现）

- **提交时**：`saveSessionOnStart(runId, goal, runType)` → ① 后端 `openSession('run_<runId>', {title: goal})` + `appendTurn(user, goal)`；② localStorage 记 `{runId, goal, runType, status:'running'}` 并置为 `lastSession`。
- **完成/失败时**：`finalizeConversation(id, r)` → ① 补 `appendTurn(assistant|system, finalAnswer|失败原因)`；② 入库 `PUT /api/data`（collection `runs`，自动语义嵌入）；③ localStorage 更新 status。**用 `mta_finalizedRuns` 集合做幂等**（刷新/重复 refresh 不重复写 turn）。
- **加载时**：`restoreLastSession()` → 读 localStorage，有历史则把**上次会话的 goal 回填到底部输入框**；无历史则保留默认演示目标。
- **回填**：`npm` 脚本 `scripts/ingest-knowledge.ts` 把**存量** runs 与 context turns 一次性写入知识库（幂等覆盖）。

### 2.3 涉及功能点（方案：会话历史 UI）

- 底部输入框上方加「历史会话」下拉/列表（读 `GET /api/context`），点击可恢复该会话的 goal 并回看结论（`GET /api/context/:sid`）。
- 会话按 `updatedAt` 倒序；支持删除（`DELETE /api/context/:sid`）。

---

## 三、知识库（历史对话 + 工作区内容，向量语义检索）

### 3.1 现状（已存在，本轮接线补齐）

- `Repository`：`data_items`（collection/itemId/type/tags/content）+ FTS5 关键词检索。
- **2026-10-24 更新**：双轨已统一为切块级 RAG；唯一向量存储是 `rag_chunks`，`data_vec` 停写。
- `KnowledgeHub`：`searchKnowledge`（keyword/semantic/hybrid 同管线）/ `searchSemantic` / `searchHybrid`（兼容包装）；文档级去重 + `matchedBy`。
- 嵌入器默认零依赖 `HashEmbedder`（离线兜底）；配置 `MTA_EMBEDDING_MODEL` 后自动使用真实 embedding。

### 3.2 本轮新增（已实现）

- `GET /api/knowledge/search?q=&mode=keyword|semantic|hybrid&limit=`（server 端点）。
- `scripts/ingest-knowledge.ts`：把历史 runs（goal + 最终答案/失败原因）→ collection `runs`；历史 context turns → collection `conversations`；`--dir <repo>` 把工作区文件结构 → collection `workspace`。幂等。
- 前端在每次运行完成时 `PUT /api/data` 把该次对话入库（增量，不依赖离线回填）。

### 3.3 真实语义嵌入升级路径（方案）

`HashEmbedder` 是词法兜底；要「真语义」配置 `MTA_EMBEDDING_MODEL` 即可（切块级 RAG 自动重建索引）：

1. **OpenAI 兼容 embeddings**：`new OpenAIEmbedder({ baseUrl, model: 'text-embedding-3-small', apiKey })` → 调 `/embeddings`，dim 1536。适合已用 DeepSeek/OpenAI 键的场景。
2. **本地零外呼**：`@xenova/transformers` 的 `Xenova/all-MiniLM-L6-v2`（dim 384，本地推理，无 API 成本，适合离线/隐私）。
3. 切换点：`.env` 设置 `MTA_EMBEDDING_MODEL` + `MTA_EMBEDDING_BASE_URL` + Key；模型/维度/切块指纹变化时 `rebuildRag` 自动整库重算。

### 3.4 涉及功能点（方案）

- 界面加「知识库检索」入口（顶部搜索框），调 `/api/knowledge/search?mode=hybrid`，展示命中（标注 keyword/semantic/both）。
- 工作区**内容**（非仅文件名）索引：`readFile` 结果在工具层顺带 `putData`（`collection 'workspace-snippets'`），规模大时按文件大小截断。

---

## 四、底部输入框改造（已实现）

### 4.1 布局改动

| 之前 | 之后 |
|---|---|
| 左侧固定 380px 侧栏：任务类型 + repoPath + goal + 开始按钮 + **全部配置**堆在一起 | 左侧 340px 折叠式**设置**面板（`<details open>`「⚙️ 设置」）：只放 LLM/搜索/流式/预算/编排等配置 |
| 输入与配置混杂、每次都要滚侧栏 | 底部**粘性输入栏**（`position: sticky; bottom:0`）：任务类型 + repoPath + goal + 开始/取消，全宽、始终可见 |

### 4.2 具体改动

- CSS：`.layout` 改 `340px 1fr`、新增 `.inputbar`（sticky 底栏、flex 自适应、阴影）、`details.settings`。
- HTML：左栏去掉 runType/repoPath/goal/开始按钮，包进 `<details class="settings" open>`；新增 `.inputbar` 元素承载这四项（ID 不变：`runType`/`codebaseFields`/`repoPath`/`goal`/`startBtn`/`cancelBtn`/`routeNote`）。
- 交互：goal 输入框**自动增高**（`scrollHeight` 上限 160px）+ **Ctrl/Cmd+Enter 提交**（WorkBuddy 式）。
- `showFields`/`NEEDS_WORKSPACE`/`routeNote` 等既有逻辑因 ID 不变**零改动**继续生效。

### 4.3 涉及功能点

- 底部输入栏的任务类型下拉会联动显示 repoPath（`codebaseFields` 显隐）、`routeNote` 建议，与之前侧栏行为一致。
- （方案）设置面板记忆折叠状态到 localStorage。

---

## 五、改动文件清单

- `public/index.html`：raw 懒序列化、底部输入栏、自动增高/Enter 提交、对话持久化与恢复、完成时入库。
- `src/llm/OpenAIProvider.ts`：单次调用超时 `withCallTimeout` + `OpenAIConfig.timeoutMs`。
- `src/server.ts`：`GET /api/knowledge/search?mode=`。
- `scripts/ingest-knowledge.ts`（新）：知识库回填。
- `docs/INTERACTION_PERSISTENCE_PLAN.md`（本文件）。

## 六、验证

- 前端脚本 `node --check` 通过；`tsc --noEmit` 0 错误。
- 全量测试 **193/193 通过**。
- 语义检索实测：`「打包器对比」→「比较两个打包器」`、`「代码改进方案」→ 代码分析运行`（hybrid，matchedBy=semantic）。
- 回填实测（2026-10-13 当时口径）：180 条 runs 入库、180 个向量（旧 sqlite-vec 轨；现已停写）。
