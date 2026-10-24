# RAG 与 Agent 应用栈（P0/P1/P2 实现手册）

> 这份文档回答一组面试高频问题，但**每个结论都对应本仓可运行代码与可复跑证据**，不是概念摘抄。
> 最后更新：2026-10-21 ｜ RAG 测试：`tests/43~47`（26 例） ｜ 上下文压缩真实 A/B 见 `reports/COMPACTION_AB.md`（预注册结论 `not_proven`，不要外推） ｜ 评测生成物：`reports/RAG_EVAL.md`、`reports/RAG_ABLATION.md`

## 0. 速查：问题 → 代码 → 证据

| 问题 | 一句话答案 | 代码 / 证据 |
|---|---|---|
| chunk 多大、overlap 多少 | 默认 **512 tokens / 64 overlap**；按文档类型用 256/320/800 预设；`text` 是原文切片，`embedText` 才带标题前缀 | `src/knowledge/chunking.ts`；测试 43a |
| 为什么用这个 embedding 模型、维度、归一化 | 中文私有化先 `bge-small-zh-v1.5`(512)，API 先 `text-embedding-3-small`(1536)；统一 **L2 归一化**，余弦=点积；真实模型需显式设 `MTA_EMBEDDING_MODEL` | `src/knowledge/embeddings.ts`；测试 43b/43i |
| HNSW 和 IVF 区别 | HNSW 是**分层图**（`M/efConstruction/efSearch`）；IVF 是**聚类倒排**（`nlist/nprobe`）；两者都支持墓碑删除/upsert | `src/knowledge/vectorIndex.ts`；测试 43e/43j |
| 元数据过滤怎么做 | 本仓是 **post-filter**；高选择性过滤要扩 `ef` 重试，生产应 **pre-filter**（分区/倒排） | `HnswIndex.search`；测试 43f；`RAG_EVAL.md` §4 |
| 召回和延迟怎么权衡 | 调 `efSearch` / `nprobe`；用 Flat 做真值，画召回-延迟曲线 | `scripts/rag-bench.ts`；`RAG_EVAL.md` §3 |
| 关键词和向量怎么融合、RRF 是什么 | RRF：`score = Σ weight_i/(k+rank_i)`，默认 `k=60`，只看名次、不怕分数尺度 | `src/knowledge/hybrid.ts`；测试 43c/43d |
| rerank 提升了多少 | 本仓 18 条查询：hybrid Recall@5 **88.9%→100%**、MRR **0.690→0.750**、nDCG@5 **0.536→0.638**；延迟 0.89→3.61ms。注意 keyword 单路 94.4%，RRF 在词法语料上可能反而掉召回 | `RAG_EVAL.md` §2 |
| MCP 和 function calling 什么关系 | MCP 解决“工具从哪来/怎么发现/怎么跨进程调”；function calling 解决“模型选哪个工具”；桥接后共用同一份 ToolDefinition | `src/mcp/*`、`src/mcp/bridge.ts`；测试 44a-44e |
| transport 有几种 | **stdio**、**Streamable HTTP**（JSON 或 SSE 响应，客户端真流式解析并回传 `Mcp-Session-Id`）；旧版 HTTP+SSE 已弃用；**没有 WebSocket 标准传输** | `src/mcp/transport.ts`；测试 44f |
| tool schema 怎么写、并行调用、tool_choice | JSON Schema 放进 `function.parameters`；`parallel_tool_calls` 控制同轮多调用；`tool_choice` 取 auto/none/required/指定函数 | `src/llm/OpenAIProvider.ts`、`src/types.ts`；测试 46a-46c |
| 一次回答变慢怎么定位、token 花在哪 | 看 **wall vs busy(union)**、模型/工具 sum vs union、首 token、按 step 的 token 热点 | `src/observability/latency.ts`；`GET /api/runs/:id/diagnosis`；测试 45a/45b |
| 流式打字机、中断怎么处理 | SSE 推 `llm_delta`；Tracer 按 24ms 合并、前端跳过增量事件并增量 append，事件流限 500 条、滚动 10fps；`Last-Event-ID` 回放 + 心跳 + 看门狗；`/cancel` 走 AbortSignal | `src/trace/Tracer.ts`、`public/index.html`、`docs/STREAMING_LIVE_VIEW.md` |
| 什么时候用 LangGraph | 有环/条件边、检查点恢复、图内人工中断、多 Agent 共享状态时；线性单 Agent 手写更透明 | `src/runtime/frameworkChoice.ts`；测试 47a |
| 什么时候微调而不是 RAG | 知识易变/要引用 → RAG；稳定行为/格式且 ≥100~500 条标注 → LoRA；两者都要 → RAG+LoRA | `src/llm/adaptation.ts`；测试 47b |
| vLLM 显存怎么估、INT8 掉多少精度 | 权重 + KV + 激活（乘并发）+ 开销；量化主要省权重、不省 KV。**INT8 精度本仓未实测**，必须按任务评测集测 | `src/llm/vram.ts`；测试 47c |

---

## 1. RAG P0-1：切块与 Embedding

### 1.1 切块：512 / 64 的依据

默认值：`chunkSize=512 tokens`，`overlap=64 tokens`（12.5%）。

- **512**：对 FAQ/技术文档通常覆盖 2~4 个自然段，语义相对单一；再大容易把多个主题塞进一个向量，召回变糊；再小则上下文不足、chunk 数量与索引成本上升。
- **64**：只为覆盖“答案跨段”的边界，不追求大比例重叠。overlap 越大，索引体积、embedding 成本、重复召回越多。
- **不是按字符硬切**：先按标题/空行/句子边界切；超长句才硬切。overlap 取上一块**尾部完整句子**，避免把句子切成两半。
- **尾部短块合并**：末尾不足预算的块会并入上一块；合并时按原文 charStart..charEnd 重取文本，而不是拼接两块 text——否则 overlap 句子会被复制，text 与偏移不再对应原文。
- **确定性**：同一输入 + 同一参数，chunk id（`docId#index`）、边界、顺序完全一致，便于增量更新与回归测试。

预设（`CHUNK_PRESETS`）：

| 预设 | chunk | overlap | 适用 |
|---|---:|---:|---|
| `docs` | 512 | 64 | 通用文档（默认） |
| `code` | 320 | 48 | 代码/配置，按空行与函数边界切 |
| `faq` | 256 | 32 | FAQ/短条目，减少无关上下文 |
| `report` | 800 | 100 | 长报告，保留跨节上下文 |

**什么时候该重切**：换 embedding 模型（尤其最大输入长度变化）、文档结构变化、评测发现“答案被切断”或“一个块混多个主题”时。切块参数变化后必须重建索引。

### 1.2 Embedding 模型、维度、归一化

本仓注册表（`EMBEDDING_MODELS`）：

| 模型 | 维度 | 最大输入 | 适用 |
|---|---:|---:|---|
| `hash-ngram-256` | 256 | 8192 | **离线测试/降级**，词法哈希，不是语义模型 |
| `bge-small-zh-v1.5` | 512 | 512 | 中文私有化基线，CPU 可跑 |
| `bge-m3` | 1024 | 8192 | 多语言、长上下文、dense/sparse/colbert |
| `text-embedding-3-small` | 1536 | 8191 | API 通用基线，性价比高 |
| `text-embedding-3-large` | 3072 | 8191 | 更高精度/成本，评测不够再升 |
| `qwen3-embedding-0.6b` | 1024 | 32768 | 本地长上下文、代码/文档混合 |
| `nomic-embed-text-v1.5` | 768 | 8192 | 英文长文、本地部署 |

选择顺序建议：

1. 中文/私有化：先 `bge-small-zh-v1.5`（512 维）做基线；召回不够再换 `bge-m3` / Qwen3。
2. 允许调 API：先 `text-embedding-3-small`；需要更强语义再 `-large`，或用 Matryoshka `dimensions` 降到 512/1024 省存储。
3. **维度不是越大越好**：维度↑ → 表达力↑，但存储、带宽、索引构建/查询成本都↑。先用 512~1024 做基线。
4. **换模型必须重建索引**，不同模型的向量空间不可混用。

归一化：

- 所有入索引向量做 **L2 归一化**；归一化后余弦相似度 = 点积，HNSW/IVF 的距离实现更简单。
- `OpenAICompatibleEmbedder` 默认拿到结果后再显式归一化，避免厂商实现差异。
- 零向量保持为零，`cosineSimilarity` 对零向量返回 0。

真实 embedding 是**显式 opt-in**（默认仍是离线 hash 替身，保证测试可离线跑）：

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `MTA_EMBEDDING_MODEL` | 设置后才启用真实模型（如 `text-embedding-3-small`） | 未设置 = hash |
| `MTA_EMBEDDING_BASE_URL` | OpenAI 兼容 endpoint | `https://api.openai.com/v1` |
| `MTA_EMBEDDING_API_KEY` | API Key；缺省回退 `OPENAI_API_KEY` | — |
| `MTA_EMBEDDING_DIM` | 可选，覆盖模型默认维度 | 模型注册表值 |

### 1.3 代码入口

```ts
import { chunkDocument } from './src/knowledge/chunking.js';
import { createHashAsyncEmbedder, OpenAICompatibleEmbedder } from './src/knowledge/embeddings.js';

const chunks = chunkDocument({ id: 'doc-1', title: '说明', text }, { chunkSize: 512, overlap: 64 });
const embedder = new OpenAICompatibleEmbedder({ baseUrl, apiKey, model: 'text-embedding-3-small' });
const vectors = await embedder.embed(chunks.map((c) => c.embedText));
```

`embedText` 会带 `title` / `heading` 前缀，提升“标题即答案”的召回；`text` 保留原文，避免污染展示与引用。

---

## 2. RAG P0-2：向量索引（HNSW vs IVF）

### 2.1 本质区别

| | HNSW | IVF-Flat |
|---|---|---|
| 结构 | 多层邻近图 | k-means 聚类 + 倒排簇 |
| 查询 | 从高层贪心下降，底层束搜索 | 先找最近 `nprobe` 个簇，再扫簇内向量 |
| 构建参数 | `M`（每层邻居数）、`efConstruction` | `nlist`（簇数）、`iterations` |
| 运行时旋钮 | `efSearch`（候选队列大小） | `nprobe`（探测簇数） |
| 优点 | 高召回、低延迟、无需训练 | 构建/内存简单，簇可分区 |
| 缺点 | 构图慢、内存高、删除麻烦 | 边界点可能分错簇，召回依赖 `nprobe` |
| 适用 | 低延迟在线检索 | 大规模、可分区、批量场景 |

经验值：`M=16~32`，`efConstruction=100~400`，`efSearch=32~128`；IVF 的 `nlist≈sqrt(N)~4*sqrt(N)`，`nprobe` 从 1 往上扫到召回达标。

本仓实现是**教学用简化 HNSW**：单层束搜索 + 最近邻剪枝，未做论文里的启发式邻居选择/删除；生产直接用 Qdrant/Milvus/pgvector，接口不变即可替换。

### 2.2 元数据过滤：post-filter 的坑

本仓统一用 predicate：

```ts
index.search(query, { k: 10, filter: (m) => m.collection === 'docs' });
```

- HNSW/IVF 都是**先找候选，再过滤**（post-filter）。
- 过滤选择性很高时，候选可能被剔光 → 不足 k、召回下降。
- HNSW 的处理：过滤后有效候选不足 k 时，**扩大 `ef` 重试**（最多 5 次）。这里修过一个真实 bug：早期按“未过滤结果数”提前退出，导致候选全被过滤也不扩 ef；回归守卫是测试 43f。
- 生产建议：
  - 高选择性过滤做 **pre-filter**：按租户/集合分区，或把过滤条件下推到索引；
  - 或先取更大的候选池再过滤；
  - 过滤字段建立标量索引（Qdrant payload index / pgvector btree）。

### 2.3 召回-延迟实测（本仓语料）

数据来自 `reports/RAG_EVAL.md`（2026-10-19，19 文档 / 151 chunks / 18 查询，离线 hash embedding）：

| 索引 | Recall@10（相对 Flat） | 中位延迟 | 参数 |
|---|---:|---:|---|
| Flat（精确） | 100.0% | 0.061ms | — |
| HNSW `efSearch=16` | 86.1% | 0.179ms | M=16, efC=200 |
| HNSW `efSearch=32` | 93.9% | 0.131ms | M=16, efC=200 |
| HNSW `efSearch=64` | 96.7% | 0.245ms | M=16, efC=200 |
| HNSW `efSearch=128` | 97.8% | 0.407ms | M=16, efC=200 |
| IVF `nprobe=1` | 28.3% | 0.016ms | nlist=20 |
| IVF `nprobe=2` | 43.9% | 0.018ms | nlist=20 |
| IVF `nprobe=4` | 66.7% | 0.043ms | nlist=20 |
| IVF `nprobe=8` | 89.4% | 0.062ms | nlist=20 |
| IVF `nprobe=16` | 100.0% | 0.204ms | nlist=20 |

**怎么读**：

- 小语料上 Flat 的 JS 循环反而很快，HNSW 的图遍历/堆操作开销显现；**延迟数字不代表生产 C++/Rust 实现**，但召回旋钮的趋势是真实的。
- 生产选型看“召回@延迟预算”：先定可接受 Recall（如 95%），再选最小的 `efSearch`/`nprobe`。
- `distanceComputations` 含构建期距离计算，不能直接当查询成本；要看单次查询增量或压测。

---

## 3. RAG P0-3：混合检索 + Rerank

### 3.1 两路各擅长什么

- **关键词 BM25**：专有名词、错误码、函数名、精确短语。中文用 **unigram + bigram** 分词（单字保召回，双字保精度）。
- **向量**：同义改写、口语化提问、跨语言/模糊意图。
- 单路都可能在另一路的强项上翻车，所以混合。

### 3.2 RRF 是什么

Reciprocal Rank Fusion：

```
score(d) = Σ_i  weight_i / (k + rank_i(d))
```

- `rank_i(d)` 是文档 d 在第 i 路结果里的名次（1-based）；`k` 常取 60。
- **只看名次，不看原始分数**，所以 BM25 分数和余弦相似度不需要归一化，工程上最稳。
- `k` 越大，头部名次差距被压得越平；`k=60` 是原论文经验值。
- 本仓还提供加权分数融合（min-max 归一后 `alpha*vector + (1-alpha)*keyword`），适合有评测集调 `alpha` 的场景。

### 3.3 两阶段：召回 → rerank

1. 关键词 + 向量各取候选池（默认 `max(k*4, 20)`）；
2. RRF 融合；
3. 取 top `rerankTopN`（默认 `k*3`）做 rerank；
4. 返回 top-k。

本仓 `LexicalReranker` 是**离线 cross-encoder 替身**：`coverage .45 + bigram .20 + phrase .15 + title .10 + prior .10`。生产应换 `bge-reranker-v2-m3` / Cohere Rerank / LLM rerank；接口不变。

### 3.4 实测提升（18 条查询）

| 模式 | Recall@5 | MRR | nDCG@5 | 平均延迟 |
|---|---:|---:|---:|---:|
| keyword | 94.4% | 0.798 | 0.620 | 0.22ms |
| vector | 55.6% | 0.380 | 0.311 | 0.22ms |
| hybrid (RRF) | 88.9% | 0.690 | 0.536 | 0.89ms |
| hybrid + rerank | 100.0% | **0.750** | **0.638** | 3.61ms |

- 相对 RRF：Recall@5 **+11.1pp**，MRR **+0.060（+8.7%）**，nDCG@5 **+0.102（+19.0%）**。
- **RRF 不是永远更好**：这个语料的查询都带唯一短语，keyword 单路 Recall@5 94.4%，而 RRF 只有 88.9%——两路名次融合会把一些 keyword 强命中挤出 top-5。rerank 在候选池上重新按短语/覆盖率打分，才把 Recall 拉回 100%。
- 因此工程上不能“上了 RRF 就完事”：要么调 RRF 权重/`k`，要么 rerank，要么按查询类型路由（精确标识符走 keyword，口语化走向量/混合）。
- 换真实语义 embedding 后，向量路的优势会体现在“同义改写”查询上；本表不能代表真实语义上限（见 §11 边界）。

复跑：`npm run rag:bench` → `reports/RAG_EVAL.md`。

### 3.5 接入 Agent 主路径

- 新增工具 `knowledge_search`（权限 `knowledge:read`）：参数 `query / k / mode / collection`，返回 `chunkId / docId / heading / score / sources / text`。
- 它走的是切块级 RAG（`KnowledgeHub.searchRag`），不是旧的 FTS5 混合检索；`codebase` / `research` / `orchestrator` 的自检工具池与 `doc-research` 子 Agent 都已加入。
- MCP 的 `kb_search` 也改成同一条切块管线，返回 chunk 级来源，便于引用与高亮。
- **2026-10-24 统一**：`GET /api/knowledge/search?mode=keyword|semantic|hybrid` 与 `KnowledgeHub.searchKnowledge` 也走这条管线；chunk 命中按 `docId` 聚合（取最高分 chunk，`chunkHits` 记录命中块数），避免长文档挤占 doc 级 top-k。旧 `data_vec` 停写，`searchSemantic` / `searchHybrid` 退为兼容包装。

### 3.6 切块 / 维度消融（`reports/RAG_ABLATION.md`）

| chunk / overlap | chunks | Recall@5 | MRR | nDCG@5 | 平均延迟 |
|---|---:|---:|---:|---:|---:|
| 256 / 0 | 272 | 100.0% | 0.801 | 0.627 | 3.33ms |
| 256 / 64 | 340 | 100.0% | 0.782 | 0.664 | 3.06ms |
| 512 / 32 | 144 | 100.0% | **0.856** | **0.690** | 6.33ms |
| 512 / 64（默认） | 151 | 100.0% | 0.750 | 0.638 | 4.78ms |
| 800 / 0 | 89 | 100.0% | 0.752 | 0.619 | 6.78ms |

- **不要声称 512/64 是唯一最优**：本语料上 512/32 的 MRR 更高，256/0 与 800/0 也能 100% 召回；默认值选的是“语义完整度 / chunk 数 / 延迟”的折中。
- 维度消融（hash 替身）：64/128/256/512 维的 vector Recall@5 = 50.0%/44.4%/55.6%/66.7%，存储 0.04/0.07/0.15/0.29 MiB；hybrid+rerank 四档都 100%。真实模型上应按领域评测集选 512~1024 维，而不是盲目追大。
- 复跑：`npm run rag:ablation` → `reports/RAG_ABLATION.md`。

---

## 4. MCP P1：和 function calling 的关系、transport

### 4.1 关系

- **function calling** 是模型能力：模型根据 `tools` 列表输出“我要调用哪个工具、参数是什么”。
- **MCP** 是工具/资源/提示词的**发现与调用协议**：工具在另一个进程/服务里，客户端通过 JSON-RPC 问“你有哪些工具”“调用这个工具”。
- 两者不冲突：桥接后 MCP 工具变成普通 `ToolDefinition`，模型仍然用 function calling 选择它。
- 本仓 `registerMcpTools()` 把 MCP 工具注册进 `ToolRegistry`，前缀 `mcp_`，权限 `mcp:call`；参数 JSON Schema 原样暴露给模型。
- **风险等级不能默认 `safe`**：`safe` 会在超时后自动重试，可能放大远端工具副作用。现在按 MCP annotations 推断：`destructiveHint=true → high`、`readOnlyHint=true → safe`、未声明 → `medium`（不自动重试）。
- **取消要能穿透**：Runtime 的 `AbortSignal` → 桥接 Tool → `McpClient.callTool(..., {signal})` → `notifications/cancelled` → `McpServer` 的 `activeCalls` 表 → 工具 `ctx.signal`。HTTP 入口还会在连接关闭时 abort。

### 4.2 transport 有几种

| transport | 形态 | 本仓 |
|---|---|---|
| **stdio** | 客户端启动子进程，stdin/stdout 一行一个 JSON-RPC | `StdioTransport` / `serveStdio`；测试 44c 真实子进程 |
| **Streamable HTTP** | POST JSON-RPC；响应可为 `application/json` 或 `text/event-stream` | `HttpTransport` 增量读 SSE + 自动回传 `Mcp-Session-Id`；`POST /mcp`；测试 44d/44f |
| 旧版 HTTP+SSE | 双端点模式（2024-11-05 之前） | **已弃用，不要新用** |
| WebSocket | 不是 MCP 标准传输 | 不实现 |

### 4.3 生命周期与错误分层

```text
initialize → notifications/initialized → tools/list → tools/call
```

- 缺必填参数 / 未知工具：JSON-RPC `-32602 INVALID_PARAMS`。
- 未知方法：`-32601 METHOD_NOT_FOUND`。
- 工具执行抛错：放在 `result.isError = true`，**不是** JSON-RPC error（MCP 约定）。
- 通知（无 `id`）不返回响应；batch 支持单条/多条。

### 4.4 主路径配置入口（2026-10-23）

默认**不连接任何外部 MCP**。启用方式只有一个：显式设置 `MTA_MCP_SERVERS`（JSON 数组），
每个 server 必须给 `names` 白名单——这是刻意的上下文纪律，否则外部 server 的全部工具 schema 会挤占 prompt。

```json
[{"name":"hub","url":"http://127.0.0.1:9060/mcp","token":"","names":["kb_search"],"timeoutMs":15000}]
```

- **名字隔离**：桥接后的工具名是 `mcp_<server>_<tool>`，多 server 同名工具不会互相覆盖。
- **权限**：统一 `mcp:call`；风险按 annotations 推断（见 4.1），未声明为 `medium`（不自动重试）。
- **工具池**：codebase / research / misc 与「开启自检工具」的 orchestrator 会看到这些工具；
  **code-edit 子 Agent 不注入**——写路径必须留在沙箱 + 人工审批 + apply-journal 内，不能被远端工具绕过。
- **失败隔离**：各 server 并行连接；连不上只把该 server 标为 `error` 并上报 `MCP_UNAVAILABLE`，
  不影响 HTTP 服务与其它 server。`POST /api/runs` 只做**有界等待**（默认 10s），server 挂住时 run 先跑。
- **状态与脱敏**：`GET /api/mcp` 返回 `configured / ready / connecting / toolCount / tools / servers[]`；
  注意 `ready` 只表示「启动探测已结束」，**不代表全部可用**——逐 server 看 `servers[].state`（ready / error）；
  `servers[].missing` 列出白名单里 server 实际没提供的工具（其余工具照常可用，不静默假装全部命中）；
  URL 去掉 query/hash/凭据，错误消息里的 token 会二次打码，token 只进请求头。
- **配置校验 fail-fast**：非法 JSON、缺 `names`、重名、URL 内嵌账号密码、非 http/https、超时越界都在启动时报错，
  不允许“看起来启用了但实际没连”。

代码：`src/mcp/{protocol,server,client,transport,bridge,config,bootstrap}.ts`；演示 server：`scripts/mcp-server.ts`；
回归：`tests/44_mcp.test.ts` + `tests/64_mcp_config.test.ts`。

换 server 或轮换 token 后，先用探针确认“连接 → 列工具 → 调工具”，再写配置（token 只从环境变量读）：

```bash
MTA_MCP_PROBE_URL=http://127.0.0.1:8900/mcp MTA_MCP_PROBE_TOKEN=... npm run mcp:probe
```

---

## 5. Function calling P1：schema、并行、tool_choice

### 5.1 schema 怎么写

```ts
const tool: ToolDefinition = {
  name: 'search_files',
  description: '在仓库中搜索',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索模式' },
      kind: { type: 'string', enum: ['content', 'filename'] },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
};
```

请求体里变成：

```json
{
  "tools": [{ "type": "function", "function": { "name": "search_files", "description": "...", "parameters": { "...": "..." } } }]
}
```

要点：`description` 写“何时用/不用”，`required` 只放真正必填，`additionalProperties:false` 减少模型乱填；枚举优于自由字符串。

### 5.2 并行调用

- OpenAI 兼容字段：`parallel_tool_calls: true/false`。
- Runtime 侧：同一轮模型返回多个 `toolCalls` 时，`executeTools()` 用工作池并发执行，上限 `maxToolConcurrency`（默认 4），结果按调用顺序回填。
- 回归：`tests/34_tool_parallel_wave.test.ts`；本仓实测并行工具能压缩 wall time（见 `reports/PARALLEL_AB.md` 的边界）。

### 5.3 tool_choice

| 值 | 含义 |
|---|---|
| `auto`（默认） | 模型自己决定是否调用 |
| `none` | 禁止调用，只回答 |
| `required` | 必须调用至少一个工具 |
| `{type:'function', function:{name}}` | 强制调用指定工具 |

本仓支持在 `RunInput.llm.toolChoice` / `parallelToolCalls` 按 run 覆盖，并透传到 Provider（`AgentRuntime` → `provider.chat`）；没有工具时请求体不发送这两个字段。

---

## 6. LLM 可观测 P1：一次回答为什么慢、token 花在哪

### 6.1 三层拆解

1. **墙钟 vs 忙时**：`wallMs` 是用户感知时间；`busyMs` 是所有模型/工具 span 的并集。差值 `overheadMs` 是排队、事件循环阻塞、落盘/SSE、审批等待等。
2. **sum vs union**：并行工具/子任务的 `sum(duration)` 会大于 `union(duration)`；`concurrencySavedMs = sum - busy` 就是并行省下的时间。看并行收益必须看 union，不能看 sum。
3. **token 热点**：按 step 聚合 `prompt / completion / reasoning / cost`；输入占比高 → 检索 top-k、上下文压缩、工具结果截断；reasoning 占比高 → 降思考深度/分流简单任务。

### 6.2 首 token 延迟（TTFT）

- 流式时用 `llm_delta` 首帧时间减 `model_request` 起点，区分“上游排队慢”还是“生成慢”。
- **重要口径**：`llm_delta` 是临时事件，不落盘；所以事后从 SQLite 事件诊断时没有 TTFT，只有实时事件（或实时抓包）才有。不要拿持久化 run 报告声称有 TTFT。

### 6.3 API 与代码

- `GET /api/runs/:id/diagnosis` → `diagnoseRun(store.getEvents(id), rec)`。
- 输出：`wallMs / modelMs / toolMs / modelUnionMs / toolUnionMs / busyMs / overheadMs / overheadPct / concurrencySavedMs / firstTokenMs / slowest / tokenHotspots / advice`。
- 代码：`src/observability/latency.ts`；测试 45a/45b。

**排查顺序**：先看 overhead 是否 >30%（事件循环/审批/队列）→ 再看模型 union 占比（prompt 还是 output/reasoning）→ 最后看最慢工具与并发上限。一次 run 不够，至少看 P50/P95 与同任务基线。

---

## 7. 流式输出 P1：打字机与中断

### 7.1 数据通路

```text
Provider 流式增量 → Tracer.delta(按 span/channel 合并 ~24ms → llm_delta, ephemeral)
  → SSE /api/runs/:id/stream → 前端 requestAnimationFrame 增量 append（不复制进事件流）
  → 同时在内存聚合 reasoning/content 预览，随 model_completed 落盘
```

- `llm_delta` 的 `seq=0`、`ephemeral=true`，**不落盘**，避免高频文本写爆 SQLite。
- 服务端按 `spanId + channel` 合并增量，并在 `model_completed` 前 flush；前端事件流跳过 `llm_delta`、节点上限 500，文本缓冲上限 30000 字符——这是“画面突然卡死”事故后的渲染背压策略。
- 断线重连只能看到 `model_completed.outputs.{reasoningPreview,contentPreview}` 的聚合预览，不能逐字重放；这是明确取舍。
- `tool_call` 通道在首帧就推给前端，用于提前渲染工具卡片骨架。

### 7.2 断线与中断

- SSE 每个持久化事件带 `id: <seq>`；浏览器重连带 `Last-Event-ID`，服务端只回放 `seq > cursor`，前端按 seq 去重。
- 心跳 `STREAM_HEARTBEAT_MS`（默认 15s）防中间层断连；看门狗 `STREAM_WATCHDOG_MS`（默认 2s）轮询 SQLite 补漏并负责终态收尾。
- 用户中断：`POST /api/runs/:id/cancel` → `runtime.cancel()` → `AbortController` 传给 Provider/工具；run 终态 `cancelled`，已产生的工具结果与预算如实保留。
- 工具实现应周期性检查 `ctx.signal`；2026-10-19 已把沙箱阶梯改为 `spawnAsync`（超时 / 输出上限 / AbortSignal 全链路），同步阻塞缺口已收口，详见 `docs/WRITE_AND_APPROVAL.md` §3.8。

详见 `docs/STREAMING_LIVE_VIEW.md`。

---

## 8. P2：什么时候用 LangGraph，什么时候不该

判断标准是**控制流复杂度**，不是“框架先不先进”。

| 需求 | 手写 Agent Loop | LangGraph 类图框架 |
|---|---|---|
| 单 Agent、固定工具循环 | ✅ 更透明 | 过度设计 |
| 少量 if/else 分支 | ✅ 够用 | 可选 |
| 多轮反思/条件边/环 | 容易变成意大利面 | ✅ 图显式表达 |
| 检查点 + 按 thread 恢复 | 要自己实现 | ✅ 内置 |
| 图内暂停等人工审批/补充信息 | 要自己造状态机 | ✅ interrupt/resume |
| 多 Agent 共享状态 | 隐式耦合多 | ✅ 统一 state schema |
| 团队不熟框架 | 无学习成本 | 先 PoC，别一次迁完 |

本仓 `chooseAgentFramework()` 把上述判断落成可测函数（`src/runtime/frameworkChoice.ts`，测试 47a）。现有 `AgentRuntime` 是手写循环 + 事件/span，足以支撑四类 Agent；只有在“环 + 检查点 + HITL + 多 Agent”同时出现时才明显值得上图框架。

**框架不替代可观测性**：节点级 span、token/成本、失败重试、权限边界仍要自己埋点。

---

## 9. P2：什么时候微调（LoRA）而不是 RAG

| 需求 | 选择 |
|---|---|
| 知识频繁变化（文档/价格/政策/代码库） | **RAG** |
| 必须给出来源/引用 | **RAG** |
| 改变风格/格式/领域推理方式，且有稳定标注 | **LoRA** |
| 知识易变 + 行为要改 | **RAG + LoRA** |
| 只有几十条标注 | 先 prompt/few-shot，别急着 LoRA |
| 数据不能出本地 | 私有化 RAG / 私有化 LoRA，按合规选 |

经验门槛：行为改变至少 **100 条**高质量 instruction/response 对再考虑 LoRA；500+ 更稳。RAG 的“知识”与 LoRA 的“行为”是正交的，别用微调背频繁变化的文档，也别用 RAG 学新能力。
本仓决策函数按 100/500 两档给不同理由：<100 只 warn 先 prompt/few-shot；100~499 可 LoRA；≥500 更抗过拟合。

本仓 `chooseAdaptation()`（`src/llm/adaptation.ts`，测试 47b）返回 `prompt | rag | lora | rag+lora` 及理由/警告（如延迟预算 <300ms 时提示检索+rerank 可能放不下）。

---

## 10. P2：vLLM / 量化显存估算

### 10.1 估算公式

```text
weights   = params × bytes_per_weight
KV cache  = 2(K/V) × layers × kvHeads × headDim × seqLen × batch × concurrency × kv_bytes
activations ≈ batch × concurrency × seqLen × hidden × 2 × 2 bytes
total     = (weights + KV + activations) × (1 + overheadRatio)   # 默认 15%
perGPU    = total / tensorParallel
```

- GQA/MQA 的 `kvHeads` 远小于 `heads`，这是长上下文能落地的关键。
- 量化主要省**权重**，**不省 KV cache**；KV 可单独量化，但有精度代价。
- 不含多卡通信缓冲、CUDA graph、tokenizer/预处理；上线前用 `nvidia-smi` + 真实压测校准。

### 10.2 本仓估算器实测值（`src/llm/vram.ts`）

| 场景 | 权重 | KV | 激活 | 总计 |
|---|---:|---:|---:|---:|
| Llama-3-8B, fp16, 4k, bs=1 | 16.0 | 0.54 | 0.07 | **19.09 GB** |
| Llama-3-8B, INT4 权重, 4k | 4.0 | 0.54 | 0.07 | **5.29 GB** |
| Llama-3-8B, fp16, 32k | 16.0 | 4.29 | 0.54 | **23.96 GB** |
| Qwen2.5-7B, fp16, 4k | 15.2 | 0.23 | 0.06 | **17.82 GB** |
| Llama-3-70B, fp16, 4k, TP=4 | 140.0 | 1.34 | 0.13 | **162.70 GB（每卡 40.67）** |

结论：8B fp16 在 24GB 卡上“刚好”，但并发/长上下文会迅速吃掉余量；INT4 权重能显著降显存，但 KV 仍按 fp16 增长。70B 至少 4×48GB 级别（估算值，实际看框架/并行策略）。

### 10.3 INT8 掉多少精度？

**本仓库没有实测 INT8 精度，因此不给出“掉 X 个点”的伪数字。** 正确做法：

1. 固定基座/checkpoint 与解码参数，准备 **领域任务集 200~500 条**（不是只看 perplexity）；
2. 同时跑 bf16/fp16 与 INT8（明确是 **weight-only** 还是 **W8A8**）；
3. 记录：任务准确率/EM、结构化输出合法率、工具调用参数正确率、长上下文检索一致性、延迟与显存；
4. 用代表性校准集做 PTQ 校准，检查 per-channel/per-group 与 outlier；
5. KV cache 量化单独消融（它直接影响长上下文一致性）。

经验上 INT8 通常比 INT4 温和，但“掉多少”高度依赖模型、校准数据、任务与是否 W8A8；没有评测就不能承诺。

---

## 11. 复跑与边界

```powershell
# 只跑新增测试
node --import tsx --test tests/43_rag_pipeline.test.ts tests/44_mcp.test.ts tests/45_observability.test.ts tests/46_function_calling.test.ts tests/47_p2_helpers.test.ts

# RAG 评测（生成 reports/RAG_EVAL.md）
npm run rag:bench

# 切块 / 维度消融（生成 reports/RAG_ABLATION.md）
npm run rag:ablation

# 全量门禁
npm run typecheck
npm test
npm run agents:lint
```

边界（务必如实说明）：

- `hash-ngram-256` 是**词法哈希**，不是语义模型；RAG 表中的向量召回不代表 bge/OpenAI 的真实语义上限。
- 切块 `text` 现在是**原文切片**（`text === source.text.slice(charStart, charEnd).trim()`），标题只进 `embedText`；引用高亮可以按偏移直接定位。
- HNSW/IVF 的删除是**墓碑删除**：查询跳过、`size` 不计；IVF 在数据量翻倍时才重训聚类，HNSW 不做图修复（生产库会 compaction/rebuild）。
- HNSW 是教学简化实现，延迟数字受 JS 实现影响；生产用成熟向量库。
- 元数据过滤目前是 post-filter；高选择性场景需 pre-filter。
- rerank 是词法 cross-encoder 替身；真实 reranker 的提升/延迟需重测。
- 诊断的 TTFT 依赖实时 `llm_delta`，持久化事件里没有。
- INT8 精度未实测；不要引用未经验证的数字。
