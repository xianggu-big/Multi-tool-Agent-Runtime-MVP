# 知识系统（Context / History / Repository）

> 三模块互通的知识系统：上下文管理 + 历史与变更追踪 + 数据仓库。
> 复用现有 SQLite 单库与事件系统，用 `correlationId` 把「一次操作」在三处串起来，保证一致性与可追溯性。

## 一、为什么做这套

之前系统只有「任务运行」（runs + events）这一种历史维度：
- 没有结构化的「数据」可存取与检索（Agent 产出的发现、笔记、配置散落在事件流的 `data` 里，无法按集合/标签/全文查）；
- 没有「变更追踪」（谁在何时把什么从 A 改成了 B）——只能靠事件流人肉拼；
- 没有「多轮上下文」的保持与跨会话召回（"我们之前聊过这个吗"无法回答）。

本套系统补齐这三块，且**不另起炉灶**：与 runs/events 同库同连接，跨表事务天然一致。

## 二、三模块

### 1. 数据仓库（Repository） — `src/knowledge/repository.ts`
- 表 `data_items`：`id / collection / itemId / type / tags[] / content(JSON) / searchText / 时间戳 / createdBy`，`(collection, itemId)` 唯一。
- 分类维度：`collection`（命名空间）+ `itemId`（集合内业务 id）+ `type`（内容类型）+ `tags`（标签数组）。
- 高效检索：**FTS5** 全文索引（standalone 表 `data_items_fts`，与数据行同事务同步）；FTS5 不可用时降级 `LIKE`。
- 查询：按集合/类型/标签/全文；`search()` 走 FTS5（按相关度 `rank` 排序），`list()` 走结构化过滤。

### 2. 历史与变更追踪（History） — `src/knowledge/history.ts`
三层历史，互为补充：
- **操作日志** = 现有 `events` 表（TraceEvent，已含 runId/seq/timestamp）——不重复存储；
- **会话记录** = 现有 `runs` 表（RunRecord）——不重复存储；
- **变更追踪** = 新表 `audit_log`：`at / correlationId / actor / action / resourceType / resourceId / before / after / meta`。
- 查询：按时间区间 / actor / action / resourceType / resourceId / correlationId。
- `timeline()`：把 runs + audit 按时间合并成一条统一时间线（events 可选并入，按 runId 局部）。

### 3. 上下文管理（Context） — `src/knowledge/context.ts`
- 表 `contexts`（sessionId / title / summary / meta / turnCount）+ `context_turns`（sessionId / turnNo / role / content / tokens）。
- **多轮保持**：`getRecent(sessionId, n)` 返回滚动窗口，供下一轮注入历史。
- **跨会话检索**：FTS5 `context_turns_fts`，`search(q)` 在全部历史 turn 里召回相关上下文。
- `summary` 字段预留给 LLM 滚动摘要（MVP 不自动生成，接口已留）。

## 三、互通与可追溯性（核心契约）

**一次逻辑操作 = 一条 audit + 一条事件 + 同一个 `correlationId` 贯穿三库。**

由门面 `KnowledgeHub`（`src/knowledge/index.ts`）保证：
- **一致性**：写数据 + 写审计在**同一个 better-sqlite3 事务**里（嵌套事务=SAVEPOINT），要么都成功要么都回滚；事件在事务**外**发（事件落盘是异步批量的，不进同步事务）。
- **可追溯性**：每个操作返回 `correlationId`，它同时出现在 ① `audit_log.correlationId` ② 事件 `data.correlationId` ③（数据侧）`item.id` 经 `audit.resourceId` 关联。

**一键串起来**：`GET /api/history/trace/:correlationId` → 返回该操作的全部审计条目；从中拿到 `resourceId` → `GET /api/data/:collection/:itemId` 拿数据；事件流里 `data.correlationId` 同值。反之从事件或数据也能反查审计。

**事件归属**：操作发生在一个 run 内时，事件持久化进该 run 的事件流（前端时间线可见、可回放）；无归属 run 时发 ephemeral 事件（实时通道可见、不落盘，避免污染 events 表）——审计日志是持久化兜底。

## 四、服务端 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/data` | 查询：`?collection=&type=&tag=&q=&limit=&offset=`（带 `q` 走 FTS5） |
| POST | `/api/data` | 创建/更新：`{collection, itemId?, type?, tags?, content, actor?}` → 201 + `{item, correlationId, auditId}` |
| GET | `/api/data/:collection/:itemId` | 取单条 |
| PUT | `/api/data/:collection/:itemId` | 更新（同 POST 但路径指定） |
| DELETE | `/api/data/:collection/:itemId?actor=` | 删除（记 before 审计） |
| GET | `/api/history` | 审计查询：`?from=&to=&actor=&action=&resourceType=&resourceId=&correlationId=&limit=` |
| GET | `/api/history/timeline` | 统一时间线：`?runId=&actor=&from=&to=&includeEvents=1&limit=` |
| GET | `/api/history/trace/:correlationId` | 按 correlationId 一键追溯 |
| GET | `/api/context` | 列会话；带 `?q=` 改为跨会话 FTS 检索 |
| POST | `/api/context` | 开会话：`{sessionId?, title?, meta?}` |
| GET | `/api/context/:sessionId` | 会话 + 最近若干轮（`?recent=10`） |
| DELETE | `/api/context/:sessionId` | 删会话（连带 turns） |
| GET | `/api/context/:sessionId/turns` | 全部 turns |
| POST | `/api/context/:sessionId/turns` | 追加轮：`{role, content, tokens?}` |
| GET | `/api/knowledge/stats` | 三模块统计总览 |

## 五、与现有系统的关系

- **复用**：同一 SQLite 连接（`SqliteStore.database` 暴露给 KnowledgeHub）；同一 Tracer/事件总线；同一 ErrorReporter。
- **不侵入**：runs/events 表结构未改；现有 API 不变。
- **首个真实用例：孤儿运行回收**。服务重启时，上次进程中断、状态仍停在 `running` 的行会被自动收口为 `failed`，并：
  1. 补一条 `runtime_error` 事件（序号取该 run 事件最大值 + 1，**保持回放序号严格连续**——必须直接写库，不能走 EventLogger 的内存计数器，否则会从 1 起与历史撞号）；
  2. 写一条 `run_interrupted` 审计（`before={status:'running'} / after={status:'failed', errorCode:'RUN_INTERRUPTED'}`）；
  3. 一条错误报告（落 `errors.log` + 内存环 + 控制台）。
  三者共用 `corr_orphan_*`，可一键追溯。这之前，重启会留下永久 `running` 的行，污染列表与每日效能统计。

## 六、检索效率与升级路径

- 当前：数据全文用 FTS5（已探测可用）；上下文 turn 全文用 FTS5；标签/类型用普通索引。
- 升级路径（数据量增大时）：FTS5 表天然支持；如需向量召回，可在 `data_items` 加 `embedding` 列 + pgvector（见 `docs/DESIGN_DECISIONS.md` §13 的 Postgres 迁移路径）。
- 反模式：不要把 FTS5 当主存储——它是索引，主数据仍在 `data_items`/`context_turns`；FTS 失效时自动降级 LIKE，行为一致。

## 七、相关文件

- `src/knowledge/repository.ts` / `history.ts` / `context.ts` / `index.ts`（门面）
- `src/knowledge/vectorRecall.ts`（语义向量召回层，见下「语义召回」）
- `src/store/SqliteStore.ts`（`listOrphanRuns` / `finalizeInterruptedRun` / `database` getter）
- `src/runtime/index.ts`（装配 + 启动回收）
- `src/server.ts`（API 路由）
- `tests/26_knowledge.test.ts`（8 个用例：三模块 + 互通 + 回收 + 幂等 + API）
- `tests/28_vector_recall.test.ts`（14 个用例：HashEmbedder + 语义检索 + 降级 + 混合检索 + KnowledgeHub 集成）

## 八、语义向量召回层（叠加在 FTS5 之上）

> 2026-10-13 新增。让知识库「按意思」而非「按字面」召回。详见 `docs/SUBAGENT_LIFECYCLE_AND_KNOWLEDGE.md`。

**为什么加**：FTS5 只命中关键词；「按语义/意图」召回不了（存了「硬编码密钥」，问「不安全常量」命中不了）。向量层补齐这一块。

**实现**（`src/knowledge/vectorRecall.ts`，复用同一 SQLite 连接）：
- **sqlite-vec** v0.1.9 扩展（已 `npm i sqlite-vec`，本机探测可加载）：`data_vec` vec0 虚表 + **辅助列 `data_id text`** 关联 data_items.id（v0.1.9 不允许显式传 rowid，实测改用辅助列方案）；kNN 按距离排序，转相似度 ∈ [0,1]；
- **可降级**：sqlite-vec 不可用 → 全表扫描 + 内存余弦重排（与 FTS5→LIKE 同约定，无原生扩展也能用）；
- **嵌入器**：默认 `HashEmbedder`（词 + 字符 3-gram 哈希向量，确定性、零依赖、中文友好、L2 归一化）；接口已留，可注入 `@xenova/transformers` 真嵌入器升级为真语义召回；
- `KnowledgeHub` 集成：`putData` 同步 upsert 向量、`deleteData` 同步 remove、`searchSemantic(query, {limit, collection})`、`searchHybrid`（关键词∪语义融合去重，`matchedBy` 标注命中来源）、`stats` 含 vector 维度。

**检索三通道**：
| 方法 | 通道 | 适用 |
|---|---|---|
| `repository.search` / `queryData` | FTS5 关键词 | 精确词命中、已知术语 |
| `knowledge.searchSemantic` | 向量 kNN | 按意思、同义不同字、模糊意图 |
| `knowledge.searchHybrid` | 关键词 ∪ 语义 | 通用（精确命中保 1.0 分，语义补召回，取 max 去重） |

**升级路径**：注入真嵌入器（@xenova/transformers）→ 知识 compaction/decay（旧结论随源文件改动失效，解 R6）→ 自动入库管道（Agent 发现 → data_items）→ 知识图谱（实体关系，GraphRAG 思路）。
