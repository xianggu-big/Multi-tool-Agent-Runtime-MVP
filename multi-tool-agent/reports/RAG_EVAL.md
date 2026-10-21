# RAG P0 评测（切块 / 索引 / 混合检索 / Rerank）

> 生成时间：2026-10-19；命令：`npm run rag:bench`；生成物请重跑命令，不要手改数字。

## 1. 口径与环境

- 语料：本仓库 AGENTS.md、multi-tool-agent/README.md、.env.example、docs/*.md、PROJECT_REPORT.md，共 **19** 个文档。
- 切块：512 tokens / 64 overlap（`src/knowledge/chunking.ts` 默认），共 **151** 个 chunk。
- Embedding：`hash-ngram-256`（离线、确定性、256 维、L2 归一化）。**它是词法哈希，不是语义模型**；本表衡量的是管线机制，不代表 bge/OpenAI embedding 的真实语义上限。
- 评测查询：18 条；相关 chunk = 文本包含指定唯一短语（自动标注，可复现）。
- 指标：Recall@5（top-5 是否命中任一相关块）、MRR（首个相关块名次倒数）、nDCG@5（二元相关性）。

## 2. 混合检索与 Rerank

| 模式 | Recall@5 | MRR | nDCG@5 | 平均延迟 |
|---|---:|---:|---:|---:|
| keyword | 94.4% | 0.798 | 0.620 | 0.22ms |
| vector | 55.6% | 0.380 | 0.311 | 0.22ms |
| hybrid | 88.9% | 0.690 | 0.536 | 0.89ms |
| hybrid_rerank | 100.0% | 0.750 | 0.638 | 3.61ms |

**读法**：RRF 对两路分数尺度不敏感，通常比单路更稳；`hybrid_rerank` 在候选池上做词法联合打分。若 rerank 相对 RRF 没有提升，说明语料/查询以精确词命中为主，或 reranker 太弱（生产应换 bge-reranker / Cohere / LLM rerank）。

## 3. 向量索引：Flat vs HNSW vs IVF

| 索引 | Recall@10（相对 Flat） | 中位延迟 | 距离计算次数 | 参数 |
|---|---:|---:|---:|---|
| flat (exact) | 100.0% | 0.061ms | 2718 | — |
| hnsw efSearch=16 | 86.1% | 0.179ms | 50952 | M=16, efC=200 |
| hnsw efSearch=32 | 93.9% | 0.131ms | 51391 | M=16, efC=200 |
| hnsw efSearch=64 | 96.7% | 0.245ms | 51788 | M=16, efC=200 |
| hnsw efSearch=128 | 97.8% | 0.407ms | 51976 | M=16, efC=200 |
| ivf nprobe=1 | 28.3% | 0.016ms | 39773 | nlist=20 |
| ivf nprobe=2 | 43.9% | 0.018ms | 39910 | nlist=20 |
| ivf nprobe=4 | 66.7% | 0.043ms | 40240 | nlist=20 |
| ivf nprobe=8 | 89.4% | 0.062ms | 40900 | nlist=20 |
| ivf nprobe=16 | 100.0% | 0.204ms | 41938 | nlist=20 |

**读法**：`flat` 是精确基线（O(N)）；HNSW 的 `efSearch` 与 IVF 的 `nprobe` 是运行时召回/延迟旋钮。`distanceComputations` 只统计向量距离计算（不含图遍历/堆操作），用于解释“为什么快/为什么召回掉”。

## 4. 元数据过滤（post-filter）

| 索引 | 过滤后 Recall@10 | 中位延迟 |
|---|---:|---:|
| flat + filter | 100.0% | 0.069ms |
| hnsw ef=64 + filter | 96.1% | 0.241ms |
| ivf probe=8 + filter | 84.4% | 0.056ms |

**读法**：这里故意用 `collection=docs` 做高选择性过滤。HNSW/IVF 先找候选再过滤，候选被过滤掉后可能不足 k → 召回下降。生产上高选择性过滤应做 **pre-filter**（分区/倒排/租户隔离），或把过滤条件下推到索引。

## 5. 查询与标签

| # | 查询 | 相关短语 |
|---|---|---|
| 1 | 写能力默认是否开启，部署时如何整机禁用 | `CODEBASE_WRITE_ENABLED` |
| 2 | 沙箱镜像如何构建 | `build-image.mjs` |
| 3 | 人工审批超时后按什么处理 | `超时按拒绝` |
| 4 | SSE 心跳间隔如何配置 | `STREAM_HEARTBEAT_MS` |
| 5 | 工具并发上限由哪个参数控制 | `MAX_TOOL_CONCURRENCY` |
| 6 | FTS5 不可用时检索如何降级 | `LIKE` |
| 7 | 单 run 报告怎么生成 | `report:run` |
| 8 | DeepSeek 真实模型实测平均成本是多少 | `0.574` |
| 9 | search_files 的三个静默陷阱 | `search_files` |
| 10 | Docker 代理拉取失败怎么排查 | `127.0.0.1:7890` |
| 11 | 子任务 limit_reached 为什么要单独统计 | `limit_reached` |
| 12 | 流式输出 tool_call 首帧如何提前渲染 | `tool_call` |
| 13 | 知识库语义召回不可用时怎么降级 | `sqlite-vec` |
| 14 | 工作区路径越界如何防护 | `workspacePath` |
| 15 | 错误报告 JSONL 落在哪里 | `errors.log` |
| 16 | 审批粘性 allow_file 是什么意思 | `allow_file` |
| 17 | 并行 vs 串行成本 A/B 的结论 | `1.56M` |
| 18 | 测试必须用哪个 Node 版本 | `Node v24` |

## 6. 边界与下一步

- 离线 hash embedding 无法验证“同义改写”的语义收益；接真实模型后（`OpenAICompatibleEmbedder` / BGE）应重跑本表。
- 当前 HNSW 是教学用简化实现（单层束搜索 + 最近邻剪枝），未做启发式邻居选择/删除；生产用 Qdrant/Milvus/pgvector。
- 元数据过滤目前是 post-filter；下一步做 pre-filter 分区，并测 10 万级语料。
- rerank 目前是词法 cross-encoder 替身；接真实 reranker 后看 Recall@5 / nDCG@5 的增量与延迟成本。
