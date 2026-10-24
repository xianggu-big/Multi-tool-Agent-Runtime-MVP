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
- `src/knowledge/vectorRecall.ts`（嵌入原语 + 旧 sqlite-vec 兼容工具；生产检索已统一到 RAG）
- `src/store/SqliteStore.ts`（`listOrphanRuns` / `finalizeInterruptedRun` / `database` getter）
- `src/runtime/index.ts`（装配 + 启动回收）
- `src/server.ts`（API 路由）
- `tests/26_knowledge.test.ts`（8 个用例：三模块 + 互通 + 回收 + 幂等 + API）
- `tests/28_vector_recall.test.ts`（14 个用例：HashEmbedder + 旧向量层原语 + 统一检索集成）
- `tests/79_rag_unified.test.ts`（8 个用例：单一写入、三模式同管线、文档级去重、元数据过滤、级联删除、统一统计、HTTP 路由、`--replace` 无 `data_vec` 回归）

## 八、统一检索层（切块级 RAG，2026-10-24 起唯一路径）

> 早期曾并行维护两套向量：`data_vec`（sqlite-vec + HashEmbedder 256 维）与 `rag_chunks`（切块级 RAG）。
> 2026-10-24 完成统一：**`data_vec` 停写，RAG 是关键词/语义/混合三种模式的唯一实现**。

**为什么统一**：双轨会双写 embedding、双份存储、同一查询两个答案，换模型还要迁移两处；切块级 RAG 在召回质量（BM25 + 向量 + RRF + rerank）、持久化（重启零 embedding）和可评测性上都更强。

**唯一管线**：
```
data_items → chunk(512/64) → embedding → BM25 + Flat/HNSW/IVF → RRF/加权 → rerank → 文档级去重
```

**统一入口**：
| 入口 | 说明 |
|---|---|
| `knowledge.searchKnowledge(q, {mode:'keyword'|'semantic'|'hybrid', limit, collection})` | 返回文档级命中（`score / normalizedScore / matchedBy / chunkId / chunkHits`） |
| `knowledge.searchSemantic` / `searchHybrid` | 兼容包装，分别固定 `vector` / `hybrid_rerank` |
| `GET /api/knowledge/search?mode=...` | 三种 mode 同管线；keyword 仍返回 `items`，另两种返回 `hits` |
| `GET/POST /api/rag/*` | 索引观测、重建（flat/hnsw/ivf、chunk 参数）、切块级检索 |
| `knowledge_search` 工具 / MCP `kb_search` | 与 HTTP 共用 `searchRag` |

**存储与增量**：`rag_chunks`（chunk 正文 + 向量 BLOB + `doc_hash`）+ `rag_index_meta`（模型/维度/切块指纹）；写入只标脏，下次检索或后台任务按 `doc_hash` 增量补齐；删除文档级联删块。

**统计口径**：`knowledge.stats().vector` 现在返回 `{ engine:'rag', built, embedder, dim, docs, chunks, count }`，不再报告 `data_vec` 的 256 维 hash 计数。

**旧表迁移**：代码不再创建/写入 `data_vec`；历史库里的旧表不影响检索，可保留或手动清理（`npm run rag:cleanup-legacy`，需 `sqlite-vec` 可加载）。

**边界**：默认 `hash-ngram` 只是离线兜底、不是真语义模型（真实模型需 `MTA_EMBEDDING_MODEL`）；默认 Flat 精确检索，HNSW/IVF 为教学实现；中文 BM25 用字 bigram 近似，不等同于专业分词器。
