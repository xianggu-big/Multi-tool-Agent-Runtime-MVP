# RAG 命中率提升方案与研究笔记（2026-10-23，只读）

> **性质**：方案与研究笔记，**不含任何代码改动**。执行交给后续 code agent。
> **基线**：`reports/RAG_EVAL.md`（2026-10-19）、`reports/RAG_ABLATION.md`；19 文档 / 151 chunks / 18 查询。
> **本报告不新增实测数字**：下文所有分数均引用既有评测，本轮未跑 `rag:bench` / `rag:ablation`。

---

## 0. 结论

**当前 RAG 的瓶颈不在检索算法，在 embedding 与评测集。**

1. `vector` 单路 **Recall@5 = 55.6%**（`RAG_EVAL.md`），而 embedding 是 `hash-ngram-256`——**词法哈希，不是语义模型**。这个数字是「半个关键词搜索」的天花板，不是算法的极限。
2. 18 条评测查询用「文本包含唯一短语」自动标注（如问写能力开关，答案短语是字面量 `CODEBASE_WRITE_ENABLED`），**构造上天然偏袒关键词检索** → keyword 94.4% 是虚高的。
3. 因此：**先修评测集，再换 embedding**。顺序反了会得到「分数涨了但不知道是不是真的」的结果。

---

## 1. 现状（引用既有数据）

| 模式 | Recall@5 | MRR | nDCG@5 | 平均延迟 |
|---|---:|---:|---:|---:|
| keyword | 94.4% | 0.798 | 0.620 | 0.22ms |
| vector | **55.6%** | 0.380 | 0.311 | 0.22ms |
| hybrid | 88.9% | 0.690 | 0.536 | 0.89ms |
| hybrid_rerank | 100.0% | 0.750 | 0.638 | 3.61ms |

**两个构造效度问题**

- **embedding 是词法哈希**（`src/knowledge/embeddings.ts:37` 的 `hash-ngram-256`），256 维、L2 归一化，无任何语义。
- **评测集偏袒字面匹配**：查询与 gold 短语共享 token，所以 keyword 天然最优、vector 天然吃亏。该评测能证明「管线通」，**不能证明「语义检索够用」**。

**过滤下推的已知损失**（`RAG_EVAL.md §4`）：flat+filter 100%、hnsw ef=64+filter 96.1%、ivf probe=8+filter 84.4% —— 现在是 **post-filter**，高选择性过滤会掉召回。

---

## 2. 提升路线（按性价比排序）

### P0-A｜重建评测集（**必须先做**）

- 每条查询补 2 个改写：① 同义改写（不含答案的字面 token）② 口语化提问。
- 标注从「包含唯一短语」改为**chunk id 白名单**（人工或半自动）。
- 规模建议：30 条 = 10 字面型 + 10 同义型 + 10 多跳型。
- **验收**：重建后 keyword 的 Recall 应**明显低于**现在的 94.4%。这不是退步，是评测变难、变得有意义了。

### P0-B｜换真 embedding

- 候选：
  - `bge-small-zh-v1.5`（512 维，CPU 友好）——本机首选
  - `bge-m3`（1024 维，多语言，体积更大）
- **接入点已就绪**：`createConfiguredEmbedder()` 读 `MTA_EMBEDDING_MODEL / MTA_EMBEDDING_BASE_URL / MTA_EMBEDDING_API_KEY / MTA_EMBEDDING_DIM`（`src/knowledge/embeddings.ts:182-196`），且是 **OpenAI 兼容**协议——Ollama 的 `http://localhost:11434/v1` 可直接用。
- **必须重建索引**：向量维度变了（256 → 512/1024），`sqlite-vec` 虚表与 `vectorIndex.ts` 的维度假设都要重建；旧数据要么全量重灌，要么按维度分表。
- **验收**：`npm run rag:bench` 的 `vector` 单路 Recall@5 ≥ **70%**；hybrid 不低于 keyword。

### P1-C｜多查询改写（query expansion / HyDE）

- 把用户问题改写成 2~3 个检索查询，各自检索后 RRF 融合。
- 落点：`src/knowledge/ragPipeline.ts` 的查询入口，或 `knowledge_search` 工具层（不要塞进系统提示词）。
- 成本控制：只在首轮召回置信度低（如 top1 分数 < 阈值）时触发，避免每次多花一次 LLM。
- **验收**：Recall@5 提升 ≥5 个点，P95 延迟增加 ≤300ms。

### P1-D｜换真 reranker

- 现状：默认 `LexicalReranker`（`ragPipeline.ts:113`），是**词法联合打分**，不是 cross-encoder。
- 候选：`bge-reranker-v2-m3`。
- **工程现实**：cross-encoder 在 Node 侧需要 ONNX Runtime 或一个 Python 小服务；如果不想引入，可先用 **LLM rerank**（让模型给候选排序）做对照，再决定是否上 cross-encoder。
- `rerankTopN` 默认 `k*3`，候选池可调。
- **验收**：nDCG@5 提升 ≥0.05；rerank 延迟 <200ms/10 候选。

### P2-E｜pre-filter 替代 post-filter

- 现状：先召回再过滤，HNSW 掉到 96.1%、IVF 掉到 84.4%。
- 做法：按 `collection` / 租户分区存储，或把过滤条件下推到索引候选生成阶段。
- **验收**：高选择性过滤后的召回损失 <2%。

### P2-F｜small-to-big（小块检索、大块喂模型）

- 用小块（256~512）保证命中精度，命中后返回父块或相邻块给模型。
- 不动召回指标，改善**答案质量**（Faithfulness / 人工评分）。
- `chunking.ts` 已支持 `charStart/charEnd` 精确切片，具备实现基础。

---

## 3. 指标清单（三层，别只看 Recall）

### 3.1 检索层（离线、可复现）

| 指标 | 定义 | 当前 | 目标 |
|---|---|---|---|
| Recall@5 / @10 | top-k 是否含相关块 | 55.6%（vector） | ≥70% |
| Precision@k | 召回里噪声占比 | 未测 | 加测 |
| MRR | 首个相关块名次倒数 | 0.380（vector） | ≥0.55 |
| nDCG@10 | 排序质量 | 0.311（vector） | ≥0.50 |
| **Hit Rate** | 至少命中一个的比例 | 未单独统计 | 加测 |
| Context Precision / Recall | RAGAS 口径 | 未测 | 加测 |
| P50 / P95 延迟 | 端到端检索耗时 | 0.22~3.61ms | P95 <300ms（含 LLM 改写时） |
| 过滤后召回损失 | pre vs post-filter | 见 §1 | <2% |

### 3.2 生成层（LLM 裁判或人工）

| 指标 | 定义 | 当前 |
|---|---|---|
| **Faithfulness** | 答案是否只依据检索到的上下文（防幻觉） | 未测 |
| Answer Relevance | 答案是否回答了问题 | 未测 |
| **Abstain Rate** | 无证据时说「不知道」的比例 | **完全未测** |
| Citation Precision | 引用是否真的支持结论 | 未测 |

### 3.3 在线层

用户追问率、引用点击率、无答案率、单次回答 token / 成本。

---

## 4. 指标 → 症状 → 该改什么

| 症状 | 指标表现 | 动作 |
|---|---|---|
| 库里有但搜不到 | Recall 低、keyword 高 | 换 embedding（P0-B）+ 多查询（P1-C） |
| 搜到但排得靠后 | MRR / nDCG 低 | 上 cross-encoder rerank（P1-D） |
| 喂给模型一堆无关块 | Precision 低 | 提高 rerank 阈值 / 下调 top-k |
| 答案编造 | Faithfulness 低 | 提示词加「只依据上下文，无则拒答」 |
| 该拒答却硬答 | Abstain 率过低 | 显式加拒答规则 + 加测 |
| 有过滤条件就掉召回 | 过滤后损失大 | pre-filter（P2-E） |

---

## 5. 生成侧提示词（可直接用）

> 放置位置建议：**不要堆进 `buildSystemPrompt`**。RAG 规则应放在 `knowledge_search` 的工具描述里，或由独立的 builder 注入，避免污染 4 类 Agent 的公共提示。

**回答器**

```text
你是检索增强问答器。规则：
1. 只能使用 <context> 中的内容作答；不得引入外部知识。
2. 每条结论后用 [n] 标注来源编号；没有来源的句子不要写。
3. 如果 <context> 不足以回答，只输出：不足以回答：<缺什么>，不要猜测。
4. 上下文互相矛盾时，列出冲突并说明你倾向哪个及理由。
5. 不要复述问题，直接给结论。
```

**多查询改写**

```text
把用户问题改写成 3 个检索用查询：
- 一个保留原意但换同义词；
- 一个拆成更小的子问题；
- 一个假设性答案（HyDE），写成「答案可能长这样」的一段话。
只输出 3 个查询，不要解释。
```

---

## 6. 关于「去 GitHub 找 skill」

- **没有 skill 能提升召回率**。skill 是给编码 Agent 读的操作手册，改不了 `src/knowledge/` 里的算法。
- 值得借的是**评测框架**：
  - `ragas`（Python）：Faithfulness / Context Precision / Context Recall 的现成实现
  - `bge-m3` / `bge-reranker-v2-m3` 的模型卡（HuggingFace）
  - 中文检索评测子集：`C-MTEB`
- **不建议**为了 RAG 引入 LlamaIndex / LangChain 整框架替换现有轻量管线——现有 `RagPipeline` 已是「可替换零件」设计（`ragPipeline.ts` 注释），换零件比换框架划算。

---

## 7. 本地模型：DeepSeek R1 与 embedding

**本机实测硬件**（2026-10-23 查得）：AMD Ryzen 5 6600H（6C/12T）/ **13.7 GB RAM** / **RTX 3050 Ti Laptop 4 GB VRAM**。

| 版本 | Q4 体积量级 | 结论 |
|---|---|---|
| **R1 全量（671B MoE）** | 400 GB+ | ❌ 完全不可能 |
| R1-Distill-1.5B | ~1.2 GB | ✅ 轻松，但能力太弱 |
| **R1-Distill-7B / 8B** | ~4.5~5 GB | ✅ **唯一合理选择**；4GB 显存装不下需部分 offload，估 8~12 tok/s |
| R1-Distill-14B | ~9 GB | 🟡 能跑但慢（估 2~4 tok/s），且与系统抢内存 |
| R1-Distill-32B / 70B | 20 GB+ | ❌ 内存不够 |

```bash
ollama run deepseek-r1:8b
# 项目内：provider=ollama，baseUrl=http://localhost:11434/v1
```

**两个提醒**

1. **R1 蒸馏版是推理模型**，会「想很久」，做 RAG 答案生成延迟高且常过度推理；日常问答 `qwen3:8b` 更合适。
2. **对你当前的 RAG，最值得本地跑的不是 LLM，是 embedding 和 reranker**：`bge-small-zh-v1.5` 在 CPU 上就够快，对召回率的收益远大于换 7B 聊天模型。

---

## 8. 执行顺序

1. **重建评测集**（P0-A）—— 不改这步，后面所有数字都不可信
2. **换 embedding + 重建索引**（P0-B）
3. **rerank 升级 / 多查询改写**（P1-D、P1-C）
4. **pre-filter / small-to-big**（P2-E、P2-F）
5. 本地模型（可选，与命中率无关）

---

## 9. 边界声明

- 本报告**未新增任何实测**：`rag:bench` / `rag:ablation` 本轮未跑，所有分数引自 2026-10-19 的既有报告。
- 「vector 单路 ≥70%」是从「换真 embedding」的常见经验推的**目标值，不是已测结果**，需用重建后的评测集实测校准。
- `bge-small-zh-v1.5` / `bge-m3` 在**本机 CPU** 上的吞吐未实测；若走 Ollama，模型 tag 以 Ollama library 实际可用为准。
- cross-encoder 在 Node 侧需要额外运行时（ONNX / Python 服务），本报告未验证可行性。
