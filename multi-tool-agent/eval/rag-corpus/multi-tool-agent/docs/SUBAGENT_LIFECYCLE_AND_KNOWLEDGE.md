# 子 Agent 生命周期 + 知识库动态维护与扩展（调研与集成方案）

> **背景**：新加的系统需要与子 Agent 适配。两件事：① 低重要性子 Agent（一次性搜索）完成后的自动清理/销毁判定；② 把系统打造成可维护、可持续成长的知识库——调研业界先进方案 / GitHub 开源项目，下载集成并适配，支持知识库的动态维护与扩展。
> **最后更新**：2026-10-13 ｜ 本轮产出：`SubAgentLifecycle.ts`（自动回收判定器）+ `vectorRecall.ts`（语义召回层，sqlite-vec 集成）+ 53 个新测试全绿。

---

## 一、子 Agent 生命周期自动清理（已实现）

### 1.1 问题

原 `SubAgentPool` 只管「并发执行 → 返回结果」，没有「结果拿到后何时释放」的判断。低重要性任务（一次性搜索/清点）若不释放，上下文常驻、占用内存与后续任务的 token 预算；高重要性任务（代码审计）又可能需要保留供追问。

### 1.2 业界调研（同类系统如何处理）

| 系统 | 子 Agent 生命周期模式 | 上下文清理方式 | 启示 |
|---|---|---|---|
| **LangGraph** | checkpointer 区分 ephemeral(内存)/persistent(SQLite)；ephemeral 线程结束即丢 | 选内存 checkpointer = 不持久化，进程内 GC | 用「是否持久化」区分重要性 |
| **CrewAI** | LRU + max STM entries；任务后 `agent.memory.clear()` | 短期记忆 Redis LRU 自动过期；长期 Postgres | LRU + 闲置过期是公认模式 |
| **AutoGen** | 对话历史即记忆；v0.4 可插拔 short-term buffer / long-term vector | 消息历史到 token 上限截断 | 可插拔记忆组件 |
| **OpenAI Swarm** | handoff 后上下文随调用结束自然释放；context_variables 跨 agent | 极轻量，默认 ephemeral | 默认即销毁，保留是特例 |
| **通用 AgentPool 模式**（多篇文章） | LRU 队列 + 闲置超时(30min) + 池上限驱逐 | `shutdown()` + `del` | 池上限 + LRU 驱逐 |

**共性结论**：① 用「重要性分级」决定保留与否；② LRU + 闲置超时是资源回收的标准手段；③ ephemeral（一次性）默认即销毁，session/durable（需追问/常驻）才保留。

### 1.3 实现：`src/runtime/SubAgentLifecycle.ts`

**importance 三档**（写在 `SubAgentSpec.retention`）：

| 档 | 含义 | 默认闲置超时 | 默认 maxAge | 典型 spec |
|---|---|---|---|---|
| `ephemeral` | 一次性任务，结果被采纳后立即释放 | 30s | 30min | doc-research、dir-inventory |
| `session` | 会话级，保留供追问 | 5min | 4h | code-audit |
| `durable` | 长生命周期，常驻 | 30min | 24h | （预留） |

**七条释放判定规则**（`shouldRelease()`，纯函数、规则式、不调 LLM，优先级从高到低）：

1. **父任务取消** → 级联释放（与 SubAgentPool.abortedResult 语义一致）；
2. **maxAge 硬性到期** → 任何 tier 的兜底，防止常驻泄漏；
3. **不可恢复失败** → 释放（失败结果仍保留供核验）；
4. **ephemeral + 终结性上报完成** → 立即释放（一次性任务的典型路径）；
5. **ephemeral + 结果已被主 Agent 采纳** → 释放；
6. **ephemeral + 预算耗尽** → 释放（无结果可消费）；
7. **闲置超时** → session/durable 主力规则；ephemeral 兜底。

**池级 LRU 驱逐**（`pickEvictionVictim()`）：池满时优先驱逐「已结束的 ephemeral」→「闲置最久 ephemeral」→「session」→ 最后才「durable」。

**有状态管理器**（`SubAgentLifecycle`）：`register/touch/markTerminalReported/markConsumed/markEnded/retire/sweep/cancelByParent`。释放时若结果未被消费，显式标 `unconsumedResult: true`（不静默丢弃）。

**与现有系统集成点**：
- spec 声明 `retention`（已给三个内置 spec 标注：doc-research/dir-inventory=ephemeral，code-audit=session+5min）；
- `runSubAgent` 完成时调 `markTerminalReported/markEnded`；主 Agent 汇总时调 `markConsumed`；
- Runtime 周期性 `sweep()`（间隔可配，默认 10s）；父任务取消调 `cancelByParent()`；
- 释放回调可发 `subagent_released` 事件 + 写 audit（与知识系统 `correlationId` 串联）。

**测试**：`tests/27_subagent_lifecycle.test.ts` — 31 个用例，覆盖七条规则、LRU 驱逐、有状态管理器、spec 标注。全绿。

---

## 二、知识库动态维护与扩展（已实现核心 + 调研集成路径）

### 2.1 现状与缺口

现有知识系统（`docs/KNOWLEDGE_SYSTEM.md`）已具备：
- **Repository**：data_items + FTS5 全文检索（关键词命中）；
- **History**：audit_log 变更追踪；
- **Context**：sessions + turns 多轮上下文。

缺口（阻碍「可持续成长」）：
1. **只有关键词检索，没有语义召回**——「按意思」找不了（FTS5 命中不了同义不同字的查询）；
2. **无向量层**——无法做相似度排序、跨条目关联；
3. **无 compaction/decay**——知识只增不减，旧结论不会因源文件改动而失效（R6 风险）；
4. **无自动入库管道**——Agent 产出的发现不会自动沉淀进知识库。

### 2.2 业界调研：GitHub 开源项目选型

| 项目 | Stars | 语言 | 适配度 | 选用结论 |
|---|---|---|---|---|
| **[sqlite-vec](https://github.com/asg017/sqlite-vec)** | ~4k | C(扩展) | ⭐⭐⭐⭐⭐ | **已集成**。纯 C、零依赖、与现有 better-sqlite3 同库；本机探测 v0.1.9 可加载；vec0 虚表 + 辅助列 `data_id text` 关联 data_items |
| **[LlamaIndex.TS](https://github.com/run-llama/llama_index.ts)** | ~44k(含 Py) | TS SDK | ⭐⭐⭐ | **推荐为后续升级**。分层索引（节点/摘要/图谱）+ 自动摘要；偏重，MVP 暂不引入，但其「混合检索 + 摘要」架构是本层的目标形态 |
| **[LangChain.js](https://github.com/langchain-ai/langchainjs)** | ~90k | TS | ⭐⭐ | 不选。定位是 Agent 编排（本项目已有自己的 Loop），知识库只是其侧支；引入会带来不必要复杂度 |
| **[ChromaDB](https://github.com/chroma-core/chroma)** | ~16k | Py/JS client | ⭐⭐ | 不选。需独立服务进程，破坏「单库 SQLite」的轻量定位 |
| **[Qdrant](https://github.com/qdrant/qdrant)** | ~20k | Rust | ⭐⭐ | 同上，需独立服务 |
| **[@xenova/transformers](https://github.com/xenova/transformers.js)** | ~12k | JS | ⭐⭐⭐⭐ | **推荐为真语义嵌入器**。本地 ONNX 模型（gte-base/all-MiniLM-L6-v2），无需 API Key；MVP 用零依赖 HashEmbedder 兜底，可平滑替换 |
| **[GraphRAG](https://github.com/microsoft/graphrag)** | ~25k | Py | ⭐⭐ | 不选（Python、重）；但其「实体抽取 + 关系图谱」思路记为知识图谱升级方向 |

**选型理由**：本项目是 TypeScript + SQLite + better-sqlite3 的轻量单库架构。**sqlite-vec** 与现有栈零摩擦（同库、同连接、同事务），是最小代价的向量层；**LlamaIndex.TS** 作为后续「摘要/图谱/自动 compaction」的升级形态；**@xenova/transformers** 作为真语义嵌入器（当前用 HashEmbedder 兜底，接口已留，可平滑注入替换）。

### 2.3 实现：`src/knowledge/vectorRecall.ts`（语义召回层，已集成）

**可降级设计**（与 Repository 的 FTS5→LIKE 降级同约定）：
- ① sqlite-vec 扩展可用 → 真 kNN（vec0 虚表 + 辅助列 `data_id text` 关联 data_items.id）；
- ② 不可用 → 降级为「全表扫描 + 内存余弦重排」（无原生扩展也能用，规模受限）；
- ③ 嵌入器：默认 `HashEmbedder`（词 + 字符 3-gram 哈希向量，确定性、零依赖、捕获词法重叠，中文友好）；可注入 `@xenova/transformers` 等真嵌入器升级为真语义召回。

**关键技术点**（实测踩坑）：
- sqlite-vec v0.1.9 **不允许显式传 rowid**（报 "Only integers are allowed for primary key values"）→ 改用**辅助列 `data_id text`** 直接存 data_items.id，vec0 自动生成 PK，kNN 返回 data_id 关联回 data_items（已验证可行）；
- Float32Array ↔ Buffer 用 `writeFloatLE`（小端），维度在建表时固定（默认 256）；
- `KnowledgeHub.putData` 写数据后同步 upsert 向量（事务外，失败不影响主流程）；`deleteData` 同步 remove；`searchSemantic` / `searchHybrid` 提供语义/混合检索。

**混合检索**（`searchHybrid`）：关键词(FTS5) ∪ 语义(向量)，按得分融合去重——同条同时命中两路径取 max，`matchedBy` 标注命中来源（keyword/semantic/both）。

**测试**：`tests/28_vector_recall.test.ts` — 14 个用例（HashEmbedder 确定性/归一化/相似度、vecToBuffer 往返、语义检索相关性、降级路径、collection 过滤、stats、KnowledgeHub 集成的 putData 自动嵌入/searchSemantic/searchHybrid/deleteData 清理/stats）。全绿。

### 2.4 升级路径（让知识库「持续成长」的后续步骤）

| 阶段 | 内容 | 依赖 | 价值 |
|---|---|---|---|
| ✅ 本轮 | sqlite-vec 向量层 + HashEmbedder + 混合检索 | 已完成 | 语义召回可用，关键词+语义双通道 |
| Next-1 | 注入 `@xenova/transformers` 真嵌入器 | `npm i @xenova/transformers` | 从词法重叠升级为真语义（同义、意图） |
| Next-2 | **KnowledgeCurator**：compaction + decay | 新模块 | 旧知识自动摘要压缩；源文件 mtime 变化时标 stale（解 R6） |
| Next-3 | **自动入库管道**：Agent 发现 → 知识库 | 复用 SubtaskReport | code-audit/doc-research 的 findings/evidence 自动沉淀为 data_items |
| Next-4 | **知识图谱**（实体抽取 + 关系） | LlamaIndex.TS 或轻量自研 | 跨条目关联、推理链路（GraphRAG 思路） |
| Next-5 | **向量化上下文召回** | context_turns + embedding | 跨会话按语义召回历史 turn（当前只有 FTS5） |

---

## 三、相关文件

| 文件 | 作用 |
|---|---|
| `src/runtime/SubAgentLifecycle.ts` | 子 Agent 生命周期判定器（七条规则 + LRU 驱逐 + 有状态管理器） |
| `src/agents/specs.ts` | 新增 `retention`（importance/idleTimeoutMs/maxAgeMs）字段 |
| `src/agents/renderDocs.ts` | 契约文档渲染 retention（第 8 节 + 一览表新列） |
| `src/knowledge/vectorRecall.ts` | 语义向量召回层（sqlite-vec / 降级 / HashEmbedder） |
| `src/knowledge/index.ts` | KnowledgeHub 集成 vectorRecall（putData/deleteData 同步向量；searchSemantic/searchHybrid） |
| `tests/27_subagent_lifecycle.test.ts` | 31 用例 |
| `tests/28_vector_recall.test.ts` | 14 用例 |
| `agents/*.md` | 重新生成的契约文档（含 retention） |

## 四、验证

```bash
npx tsc -p tsconfig.json --noEmit          # 类型检查 0 错误
npm test                                   # 全量 190/190（原 137 + 新 53）
npm run agents:lint                        # 契约门禁通过（retention 已纳入文档）
npm run agents:docs                        # 重新生成契约文档
```
