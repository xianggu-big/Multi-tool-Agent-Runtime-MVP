# RAG P0 评测（切块 / 索引 / 混合检索 / Rerank）

> 生成时间：2026-10-23；命令：`npm run rag:bench`；生成物请重跑命令，不要手改数字。

## 1. 口径与环境

- 语料：`eval/rag-corpus`（**冻结快照**，跨天可比）：AGENTS.md、README.md、.env.example、docs/*.md、PROJECT_REPORT.md，共 **23** 个文档。
- 切块：512 tokens / 64 overlap（`src/knowledge/chunking.ts` 默认），共 **220** 个 chunk。
- Embedding：`qwen3-embedding-0.6b@1024`（1024 维、L2 归一化）。本地 Ollama 语义模型；与 hash 基线的对比见 `reports/RAG_IMPROVEMENT_2026-10-23.md`。
- 评测查询：61 条；相关 chunk = 文本包含指定唯一短语（自动标注，可复现）。
- Reranker：`lexical-coverage`（词法打分，**不是** cross-encoder）。
- 指标：Recall@5（top-5 是否命中任一相关块）、MRR（首个相关块名次倒数）、nDCG@5（二元相关性）。

## 2. 混合检索与 Rerank

| 模式 | Recall@5 | MRR | nDCG@5 | 平均延迟 |
|---|---:|---:|---:|---:|
| keyword | 60.7% | 0.383 | 0.268 | 0.28ms |
| vector | 59.0% | 0.426 | 0.275 | 19.02ms |
| hybrid | 72.1% | 0.494 | 0.339 | 19.84ms |
| hybrid_weighted | 65.6% | 0.450 | 0.306 | 18.79ms |
| hybrid_rerank | 72.1% | 0.504 | 0.334 | 21.90ms |

**读法**：RRF 对两路分数尺度不敏感，通常比单路更稳；`hybrid_rerank` 在候选池上做词法联合打分。若 rerank 相对 RRF 没有提升，说明语料/查询以精确词命中为主，或 reranker 太弱（生产应换 bge-reranker / Cohere / LLM rerank）。

## 2.1 hybrid_weighted 权重扫描（alpha = 向量权重）

| alpha | Recall@5 | MRR | nDCG@5 |
|---|---:|---:|---:|
| 0.3 | 65.6% | 0.434 | 0.305 |
| 0.4 | 68.9% | 0.431 | 0.305 |
| 0.5 | 65.6% | 0.450 | 0.306 |
| 0.6 | 60.7% | 0.429 | 0.297 |
| 0.7 | 59.0% | 0.419 | 0.287 |
| 0.8 | 59.0% | 0.423 | 0.283 |
| 0.9 | 59.0% | 0.412 | 0.277 |

**读法**：alpha 越大越偏向语义路。语义召回显著强于词法时，最优 alpha 通常明显 >0.5；判断以 nDCG + MRR 为主，不能只看 Recall。

## 2.2 按查询类型拆分（构造效度）

| 模式 | 字面型 Recall@5 | 同义型 Recall@5 | 抽象型 Recall@5 | 隐喻型 Recall@5 |
|---|---:|---:|---:|---:|
| keyword | 82.4% | 64.7% | 52.9% | 30.0% |
| vector | 70.6% | 64.7% | 47.1% | 50.0% |
| hybrid | 82.4% | 76.5% | 64.7% | 60.0% |
| hybrid_weighted | 82.4% | 70.6% | 58.8% | 40.0% |

**读法**：字面型考「能不能被关键词命中」；同义型考「换个说法还找不找得到」；抽象型只描述现象、不提技术名词；隐喻型与原文几乎零词面重叠（压力测试，全模式掉分是预期）。四列都高 = 真正语义稳健。

## 3. 向量索引：Flat vs HNSW vs IVF

| 索引 | Recall@10（相对 Flat） | 中位延迟 | 距离计算次数 | 参数 |
|---|---:|---:|---:|---|
| flat (exact) | 100.0% | 1.120ms | 13420 | — |
| hnsw efSearch=16 | 81.5% | 0.565ms | 87540 | M=16, efC=200 |
| hnsw efSearch=32 | 91.6% | 0.339ms | 89231 | M=16, efC=200 |
| hnsw efSearch=64 | 95.6% | 0.500ms | 91415 | M=16, efC=200 |
| hnsw efSearch=128 | 96.4% | 0.841ms | 93633 | M=16, efC=200 |
| ivf nprobe=1 | 34.9% | 0.097ms | 59135 | nlist=20 |
| ivf nprobe=2 | 58.4% | 0.170ms | 60011 | nlist=20 |
| ivf nprobe=4 | 77.9% | 0.355ms | 61628 | nlist=20 |
| ivf nprobe=8 | 95.7% | 0.659ms | 65079 | nlist=20 |
| ivf nprobe=16 | 99.8% | 1.031ms | 69752 | nlist=20 |

**读法**：`flat` 是精确基线（O(N)）；HNSW 的 `efSearch` 与 IVF 的 `nprobe` 是运行时召回/延迟旋钮。`distanceComputations` 只统计向量距离计算（不含图遍历/堆操作），用于解释“为什么快/为什么召回掉”。

## 4. 元数据过滤（post-filter）

| 索引 | 过滤后 Recall@10 | 中位延迟 |
|---|---:|---:|
| flat + filter | 100.0% | 0.725ms |
| hnsw ef=64 + filter | 93.9% | 0.532ms |
| ivf probe=8 + filter | 92.5% | 0.359ms |

**读法**：这里故意用 `collection=docs` 做高选择性过滤。HNSW/IVF 先找候选再过滤，候选被过滤掉后可能不足 k → 召回下降。生产上高选择性过滤应做 **pre-filter**（分区/倒排/租户隔离），或把过滤条件下推到索引。

## 5. 查询与标签

| # | 查询 | 相关短语 |
|---|---|---|
| 1 | CODEBASE_WRITE_ENABLED 默认是开还是关，怎么整机禁用 | `CODEBASE_WRITE_ENABLED` |
| 2 | 上线后想把改文件能力彻底关掉，应该改哪个开关 | `CODEBASE_WRITE_ENABLED` |
| 3 | build-image.mjs 这个脚本怎么用 | `build-image.mjs` |
| 4 | 给代码执行环境打包隔离镜像的那条命令是什么 | `build-image.mjs` |
| 5 | 人工审批超时按拒绝是什么意思 | `超时按拒绝` |
| 6 | 人在时限内没有回应，系统会怎么处理这次改动 | `超时按拒绝` |
| 7 | STREAM_HEARTBEAT_MS 默认多少 | `STREAM_HEARTBEAT_MS` |
| 8 | 长连接保活多久发一次空包 | `STREAM_HEARTBEAT_MS` |
| 9 | MAX_TOOL_CONCURRENCY 控制什么 | `MAX_TOOL_CONCURRENCY` |
| 10 | 同时执行太多工具调用会被哪个上限拦住 | `MAX_TOOL_CONCURRENCY` |
| 11 | FTS5 不可用时降级成 LIKE 查询吗 | `LIKE` |
| 12 | 全文索引扩展装不上时，搜索会退化成什么方式 | `LIKE` |
| 13 | report:run 命令怎么生成单次报告 | `report:run` |
| 14 | 想给某一次执行生成一份带流程图的复盘文档 | `report:run` |
| 15 | search_files 有哪些默认行为会静默失败 | `search_files` |
| 16 | 内容检索总是零命中，哪些默认行为容易误导人 | `search_files` |
| 17 | Docker 代理 127.0.0.1:7890 连不上怎么排查 | `127.0.0.1:7890` |
| 18 | 拉镜像时代理那条链路连不上，从哪里开始查 | `127.0.0.1:7890` |
| 19 | limit_reached 为什么单独统计 | `limit_reached` |
| 20 | 子任务被预算截断后，为什么不和失败合并计数 | `limit_reached` |
| 21 | tool_call 首帧怎么提前渲染 | `tool_call` |
| 22 | 模型还没说完，第一个字节是怎么先显示出来的 | `tool_call` |
| 23 | sqlite-vec 加载失败会怎样 | `sqlite-vec` |
| 24 | 向量检索扩展不可用时系统怎么兜底 | `sqlite-vec` |
| 25 | workspacePath 越界如何防护 | `workspacePath` |
| 26 | 用相对路径读到仓库外的文件会被怎么拦 | `workspacePath` |
| 27 | errors.log 记录什么 | `errors.log` |
| 28 | 结构化错误日志落在磁盘哪个文件 | `errors.log` |
| 29 | allow_file 粘性同意是什么意思 | `allow_file` |
| 30 | 「这个文件以后都同意」这个选项是什么意思 | `allow_file` |
| 31 | 并行 A/B 里 1.56M token 是什么结论 | `1.56M` |
| 32 | 多 Agent 并行相比串行多花多少 token | `1.56M` |
| 33 | Node v24 是硬性要求吗 | `Node v24` |
| 34 | 跑测试对运行时版本有什么硬要求 | `Node v24` |
| 35 | 上线以后不想让它碰我的文件，部署前一次性禁掉 | `CODEBASE_WRITE_ENABLED` |
| 36 | 跑代码之前要先准备好那个隔离盒子，怎么把它打出来 | `build-image.mjs` |
| 37 | 我离开电脑太久没点确认，结果是默默通过了吗 | `超时按拒绝` |
| 38 | 页面挂很久没新消息，怎么知道后台还活着 | `STREAM_HEARTBEAT_MS` |
| 39 | 一次让它干太多活会不会互相打架，有没有天花板 | `MAX_TOOL_CONCURRENCY` |
| 40 | 高级索引装不上的时候，土办法是怎么搜的 | `LIKE` |
| 41 | 想给某次执行留一份事后能翻的材料 | `report:run` |
| 42 | 我明明知道仓库里有这段代码，它就是搜不出来 | `search_files` |
| 43 | 容器里下载东西老失败，怀疑是翻墙那条路断了 | `127.0.0.1:7890` |
| 44 | 活儿没干完是被额度掐掉的，这算不算失败 | `limit_reached` |
| 45 | 它话才说一半，我就先看到它准备动手了 | `tool_call` |
| 46 | 做相似度搜索的那个插件没装成功会怎么样 | `sqlite-vec` |
| 47 | 用 ../ 爬出去读别人的文件会被拦住吗 | `workspacePath` |
| 48 | 出了错以后去哪里翻记录 | `errors.log` |
| 49 | 点一次「以后这个文件都别问我」会有什么后果 | `allow_file` |
| 50 | 多个子任务一起跑，账单比一个一个跑贵多少 | `1.56M` |
| 51 | 我这台机器的运行时版本不对会不会跑不起来 | `Node v24` |
| 52 | 马缰绳得拽住，不然一群马一起冲 | `MAX_TOOL_CONCURRENCY` |
| 53 | 门禁刷一次就整栋楼都开了 | `allow_file` |
| 54 | 油表见底就熄火，这算不算事故 | `limit_reached` |
| 55 | 停电以后怎么知道冰箱还在转 | `STREAM_HEARTBEAT_MS` |
| 56 | 保险丝烧了去哪里看熔断记录 | `errors.log` |
| 57 | 后门没锁，有人翻墙进来 | `workspacePath` |
| 58 | 把动手的权限整个焊死 | `CODEBASE_WRITE_ENABLED` |
| 59 | 先搭一间空房，再把东西搬进去 | `build-image.mjs` |
| 60 | 把一次性胶片留成相册 | `report:run` |
| 61 | 话还没落地，手先伸出去了 | `tool_call` |

## 6. 边界与下一步

- 离线 hash embedding 无法验证“同义改写”的语义收益；接真实模型后（`OpenAICompatibleEmbedder` / BGE）应重跑本表。
- 当前 HNSW 是教学用简化实现（单层束搜索 + 最近邻剪枝），未做启发式邻居选择/删除；生产用 Qdrant/Milvus/pgvector。
- 元数据过滤目前是 post-filter；下一步做 pre-filter 分区，并测 10 万级语料。
- rerank 目前是词法 cross-encoder 替身；接真实 reranker 后看 Recall@5 / nDCG@5 的增量与延迟成本。
