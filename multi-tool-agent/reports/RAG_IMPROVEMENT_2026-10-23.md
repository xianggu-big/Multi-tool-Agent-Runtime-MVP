# RAG 命中率提升方案与研究笔记（2026-10-23，只读）

> **性质**：方案与研究笔记，**不含任何代码改动**。执行交给后续 code agent。
> **基线**：`reports/RAG_EVAL.md`（2026-10-19）、`reports/RAG_ABLATION.md`；19 文档 / 151 chunks / 18 查询。
> **本报告不新增实测数字**：下文所有分数均引用既有评测，本轮未跑 `rag:bench` / `rag:ablation`。

> **2026-10-24 更新**：本报告 §8.11 的「`data_vec` 未迁移、semantic 仍走 hash」已过时。
> 双轨已统一：`data_vec` 停写，keyword/semantic/hybrid 全部走 `rag_chunks`；旧表可用 `npm run rag:cleanup-legacy` 清理。
> 当前口径见 `docs/KNOWLEDGE_SYSTEM.md` §8 与 `reports/CHANGELOG.md` 2026-10-24「RAG 双轨统一」条目。

---

## 0. 结论

**当前 RAG 的瓶颈不在检索算法，在 embedding 与评测集。**

> **2026-10-23 已实测证实**（见 §8.5）：换成本地 `qwen3-embedding:0.6b` 后，`vector` 单路 Recall@5 从 **52.9% → 94.1%**（+41.2 个百分点），而检索代码一行未改。

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

## 8.5 实测结果（2026-10-23 追加，已实际运行）

> ⚠️ **本节基于旧的 18 条查询集**（全部是「自然问句 + 字面短语」混杂）。改用 34 条字面/同义双版本后的复测见 **§8.7**，部分结论已被修正。

### 8.5.1 环境与接线

| 项 | 值 |
|---|---|
| 模型 | `qwen3-embedding:0.6b`（Ollama 0.40.8，1.2 GB，100% GPU，ctx 4096） |
| 别名 | `ollama cp qwen3-embedding:0.6b qwen3-embedding-0.6b`（注册表 ID 用短横线，Ollama tag 用冒号） |
| 配置 | `.env` 四行：`MTA_EMBEDDING_MODEL / BASE_URL / API_KEY / DIM=1024` |
| 自检 | `npm run embed:check` → PASS（维度 1024、\|v\|=1.0000、相近 0.7358 vs 无关 0.1664） |

### 8.5.2 运行时（方案 B）：首次构建 8.3s

`npm start` → `GET /api/rag/search` 首次调用触发 `rebuildRag()`：

```
GET /api/rag/stats →
  docs=225  chunks=253  dim=1024  embedder=qwen3-embedding-0.6b@1024
  冷启动（含 embedder 初始化 + 253 chunk 全量向量化）= 8289ms
  预热后：vector 22~39ms / keyword 4ms / hybrid_rerank 53ms
```

结论：**首次检索多付约 8 秒，之后是几十毫秒级**。这个代价对本地自用可以接受；若要消除，可在启动时预热。

### 8.5.3 离线评测（方案 A）：vector 单路 52.9% → 94.1%

同一语料、同一 217 chunks、同一 17 条查询，只换 embedding：

| 模式 | hash-ngram-256（基线） | qwen3-embedding-0.6b@1024 | 变化 |
|---|---|---|---|
| keyword | 88.2% / 0.775 / 0.579 | 88.2% / 0.775 / 0.579 | 不变（不走 embedding） |
| **vector** | **52.9%** / 0.392 / 0.299 | **94.1%** / 0.737 / 0.477 | **Recall +41.2pt，MRR +0.345，nDCG +0.178** |
| hybrid | 100.0% / 0.734 / 0.514 | 94.1% / 0.819 / 0.555 | Recall −5.9pt，MRR +0.085，nDCG +0.041 |
| hybrid_rerank | 94.1% / 0.799 / 0.595 | 94.1% / 0.786 / 0.563 | 基本持平（nDCG −0.032） |

（每格 = Recall@5 / MRR / nDCG@5；延迟见 `reports/RAG_EVAL.md`，vector 从 0.24ms → 19.82ms，因为每次查询要走一次 HTTP embedding。）

**索引侧同样受益**（同一批向量）：

| 索引 | hash 基线 Recall@10 | 语义模型 Recall@10 |
|---|---:|---:|
| hnsw ef=32 | 82.9% | **95.9%** |
| hnsw ef=64 | 90.0% | **97.1%** |
| ivf nprobe=8 | 87.1% | **96.5%** |
| ivf nprobe=16 | 98.8% | **100.0%** |

### 8.5.4 结论

1. **假设被证实**：`vector` 单路 +41.2 个百分点——瓶颈确实在 embedding（词法哈希），不在检索算法。
2. **hybrid 反而降了 5.9 个点**：RRF 把「已经很强」的语义路和「同分尺度」的词法路强行融合，会把个别语义正确的候选挤出 top-5。→ **已实测见 §8.6**：改 `hybrid_weighted`（alpha≈0.4）后 nDCG 反超 RRF。
3. **rerank 没跟上**：`hybrid_rerank` 的 nDCG 还略降，因为当前 reranker 是**词法联合打分**，配不上语义召回。这条正好印证 §2 的 P1-D。
4. **评测集仍偏字面**：17 条查询里有 1 条（`0.574`）因语料变动被跳过；keyword 88.2% 与 vector 94.1% 已接近，说明样本仍不够「同义型」。§2 的 P0-A 依旧要做。

### 8.5.5 本次改动清单

- 新增 `scripts/embed-selfcheck.mjs` + `npm run embed:check`
- `scripts/rag-bench.ts`：改为 `createConfiguredEmbedder() ?? createHashAsyncEmbedder(256)`，新增 `RAG_BENCH_EMBEDDER=hash` 回退开关，报告头动态写入实际 embedder
- `.env` 追加 4 行 `MTA_EMBEDDING_*`
- `reports/RAG_EVAL.md` 已按语义模型重新生成（`npm run rag:bench`）

---

### 8.6 加权融合调参（2026-10-23 追加）

> ⚠️ **alpha=0.4 的结论在 34 条查询集上没有复现**（见 §8.7）——旧结论是小样本过拟合。

§8.5 发现「换 embedding 后 hybrid 反而降」，于是做了一次 `hybrid_weighted` 的 alpha 扫描（alpha = 向量权重，其余同上）。

**主表新增 `hybrid_weighted`（alpha=0.5 默认）**：94.1% / 0.835 / 0.570 —— MRR 已经是所有模式里最高。

**alpha 扫描**

| alpha | Recall@5 | MRR | nDCG@5 |
|---|---:|---:|---:|
| 0.3 | 94.1% | 0.796 | **0.591** |
| **0.4** | 94.1% | 0.814 | 0.587 |
| 0.5 | 94.1% | **0.835** | 0.570 |
| 0.6 | 94.1% | 0.742 | 0.533 |
| 0.7 | 94.1% | 0.710 | 0.512 |
| 0.8 | 94.1% | 0.739 | 0.494 |
| 0.9 | 94.1% | 0.747 | 0.496 |

**读法**

1. **Recall 在所有权重下都是 94.1%** —— 权重只影响**排序**，不影响「召不召回」。所以调 alpha 是提 nDCG/MRR 的手段，不是提召回的手段。
2. **alpha 0.3~0.4 的 nDCG 最高**（0.591 / 0.587），alpha 0.5 的 MRR 最高（0.835）。
3. 与默认 RRF（`hybrid`：0.819 / 0.555）比：**alpha=0.4 是 0.814 / 0.587 —— nDCG +0.032、MRR 基本持平**。
4. 与当前词法 rerank（`hybrid_rerank`：0.786 / 0.563）比：alpha=0.4 在 MRR 与 nDCG 上**都更好**。

**建议**：把默认检索从 `hybrid_rerank` 改为 `hybrid_weighted`（alpha≈0.4）；rerank 保留开关，等换成 cross-encoder 再默认开启。

**边界**：只有 17 条查询，0.02~0.03 的差异**在噪声范围内**。要定默认值，先把 §2 的 P0-A（扩到 30 条、含同义改写）做完再看。

---

### 8.7 评测集重建与复测（2026-10-23 追加，**修正 §8.5 / §8.6 的结论**）

**改动**：查询集从 18 条扩到 **34 条**——每个标注短语出两条：`literal`（查询里**含**标注短语）与 `paraphrase`（同义改写、**不含**标注短语）。报告新增 §2.2「按查询类型拆分」；修复了一处统计 bug（子集分母误用全集）。

**同一 34 条查询上的 A/B（只换 embedding）**

| 模式 | hash-ngram-256 | qwen3-embedding@1024 |
|---|---|---|
| keyword | 76.5% / 0.541 / 0.413 | 76.5% / 0.541 / 0.413 |
| vector | **47.1% / 0.355 / 0.293** | **76.5% / 0.560 / 0.362** |
| hybrid | 76.5% / 0.572 / 0.421 | 79.4% / 0.632 / **0.451** |
| hybrid_weighted | 64.7% / 0.549 / 0.393 | 79.4% / 0.621 / 0.438 |
| hybrid_rerank | 79.4% / **0.612** / **0.432** | 79.4% / 0.586 / 0.421 |

**按类型拆分（Recall@5）**

| 模式 | hash·字面 | hash·同义 | qwen·字面 | qwen·同义 |
|---|---:|---:|---:|---:|
| keyword | 82.4% | 70.6% | 82.4% | 70.6% |
| vector | 70.6% | **23.5%** | 88.2% | **64.7%** |
| hybrid | 82.4% | 70.6% | 82.4% | 76.5% |
| hybrid_weighted | 70.6% | 58.8% | 88.2% | 70.6% |

**三条修正**

1. **§8.5 的 94.1% 是「简单查询集」上的数字**。换到 34 条后 vector 总体只有 76.5%。但**embedding 的增益更精确地体现在同义型**：hash 仅 **23.5%**，真模型 **64.7%（+41.2pt）**；字面型 70.6% → 88.2%。语义模型的价值确实集中在「换个说法」，这正是 RAG 存在的理由。
2. **§8.6 的「alpha=0.4 最优」不成立**。qwen 在 34 条上最优是 alpha 0.5（MRR 0.621）或 0.3（nDCG 0.450），与 17 条时的 0.4 不一致 → **旧结论是对小样本过拟合**。
3. **`hybrid_rerank` 在 qwen 下反而最差**（MRR 0.586 < hybrid 0.632；nDCG 0.421 < 0.451）。词法 rerank 会把语义召回的好结果重新打乱，**换 cross-encoder 之前应默认关闭**。

**新建议**：默认 `hybrid`（RRF）；`rerank` 默认关；alpha 调参等样本扩到 50+ 再说。

**仍存局限（下一版评测集要改）**：本版「同义改写」仍与原文共享内容词（如「工具调用」「向量检索」「审批」），所以 keyword 在同义型仍有 70.6% —— **这不是纯语义测试**。已追加第三类「抽象型」查询，见 **§8.8**。

### 8.8 抽象型查询（第三类）复测（2026-10-23 追加）

**评测集扩到 51 条** = 17 个标注短语 × 3 种问法：
`literal`（含短语）/ `paraphrase`（同义改写）/ `abstract`（只描述现象、不提技术名词）。

**同一 51 条上的 A/B**

| 模式 | hash-ngram | qwen3-embedding |
|---|---|---|
| keyword | 70.6% / 0.452 / 0.322 | 70.6% / 0.452 / 0.322 |
| vector | **35.3% / 0.261 / 0.209** | **68.6% / 0.501 / 0.310** |
| hybrid | 66.7% / 0.477 / 0.328 | 74.5% / 0.533 / **0.370** |
| hybrid_weighted | 54.9% / 0.423 / 0.291 | 74.5% / 0.526 / 0.362 |
| hybrid_rerank | 70.6% / 0.552 / 0.349 | **76.5%** / 0.535 / 0.354 |

**按类型拆分（Recall@5）**

| 模式 | hash·字面 | hash·同义 | hash·抽象 | qwen·字面 | qwen·同义 | qwen·抽象 |
|---|---:|---:|---:|---:|---:|---:|
| keyword | 82.4% | 70.6% | 58.8% | 82.4% | 70.6% | 58.8% |
| vector | 70.6% | 23.5% | **11.8%** | 88.2% | 64.7% | **52.9%** |
| hybrid | 82.4% | 70.6% | 47.1% | 82.4% | 76.5% | **64.7%** |
| hybrid_weighted | 70.6% | 58.8% | 35.3% | 88.2% | 70.6% | 64.7% |

**四条结论**

1. **语义增益的最大价值出现在抽象型**：hash vector **11.8% → 52.9%（+41.1pt）**；同义型 +41.2pt；字面型仅 +17.6pt。三档梯度清晰——**换 embedding 买到的正是「换个说法还能找到」这件事**。
2. **但 BM25 仍是强基线**：抽象型上 keyword 58.8% 仍略高于 vector 52.9%。0.6B 模型不是银弹，别指望它单独解决召回。
3. **融合最稳**：`hybrid` 在抽象型 64.7%，三档 82.4 / 76.5 / 64.7 —— 是**唯一在所有类型上都不掉队**的模式。这比任何单路都更有说服力。
4. **alpha=0.5 在 51 条上确认最优**（74.5% / 0.526 / 0.362），§8.7 的修正成立；`hybrid_rerank` Recall 最高（76.5%）但 **nDCG 更低**（0.354 < 0.370）→ 词法 rerank 仍应默认关。

### 8.9 真 cross-encoder rerank 实测（2026-10-23 追加）

**做法**：本地 Python 小服务 `scripts/rerank-server.py`（`sentence-transformers` + `BAAI/bge-reranker-base`，CPU，模型 1.1GB 放 `D:\bge-reranker\model`），TS 侧新增 `src/knowledge/httpReranker.ts`（`HttpReranker`，fail-open：服务不可用时退回 `priorScore`）。`Reranker.rerank` 接口改为「同步或异步均可」，`RagPipeline` 统一 `await`。

**结果（51 条查询，qwen embedding）**

| 模式 | Recall@5 | MRR | nDCG@5 | 平均延迟 |
|---|---:|---:|---:|---:|
| keyword | 70.6% | 0.452 | 0.322 | 0.25ms |
| vector | 68.6% | 0.501 | 0.310 | 18.73ms |
| hybrid | 74.5% | 0.533 | 0.370 | 19.76ms |
| hybrid_weighted | 74.5% | 0.526 | 0.362 | 18.98ms |
| **hybrid_rerank（词法，旧）** | 76.5% | 0.535 | 0.354 | 21.86ms |
| **hybrid_rerank（cross-encoder）** | **78.4%** | **0.650** | **0.445** | **4793ms** |

**三条结论**

1. **cross-encoder 确实有效**：相对词法 rerank，**MRR 0.535 → 0.650（+0.115）**，**nDCG 0.354 → 0.445（+0.091）**，Recall 76.5% → 78.4%。相对最好的非 rerank 模式（hybrid：0.533 / 0.370），MRR +0.117、nDCG +0.075 —— **这是目前所有改动里排序质量提升最大的一项**。
2. **代价是 4.8 秒/查询**：15 个候选 × 每块最多 512 token，在 **CPU** 上约 7680 token/查询。对交互式检索不可接受，只能用于离线评测或批处理。
3. **优化方向（按性价比）**：① `rerankTopN` 从 `k*3=15` 降到 9；② 服务端 `--max-length 256` 截断；③ 换 ONNX/量化或 GPU build（本机 torch 是 `+cpu`）；④ 换更小的 reranker。**在降到 <500ms 之前，不建议把它设为默认。**

**落地建议**：`hybrid_rerank` 保持**默认关**，通过 `MTA_RERANKER_URL` 显式开启；默认检索仍用 `hybrid`（RRF）。

### 8.10 隐喻型查询（第四类，61 条）复测（2026-10-23 追加）

**评测集扩到 61 条**：在 51 条基础上加 **10 条隐喻型**（只用比喻、与原文几乎零词面重叠）。

**总体（61 条，qwen embedding + cross-encoder）**

| 模式 | Recall@5 | MRR | nDCG@5 | 平均延迟 |
|---|---:|---:|---:|---:|
| keyword | 63.9% | 0.397 | 0.281 | 0.21ms |
| vector | 65.6% | 0.459 | 0.281 | 18.51ms |
| hybrid | 68.9% | 0.486 | 0.331 | 18.54ms |
| hybrid_weighted | 70.5% | 0.473 | 0.320 | 22.03ms |
| hybrid_rerank（CE） | **72.1%** | **0.573** | **0.391** | 4784ms |

**按类型拆分（Recall@5）**

| 模式 | 字面型 | 同义型 | 抽象型 | 隐喻型 |
|---|---:|---:|---:|---:|
| keyword | 82.4% | 70.6% | 58.8% | **30.0%** |
| vector | 88.2% | 64.7% | 52.9% | **50.0%** |
| hybrid | 82.4% | 76.5% | 64.7% | **40.0%** |
| hybrid_weighted | 88.2% | 70.6% | 64.7% | 50.0% |

**四条结论**

1. **隐喻型是全模式掉分最狠的一档，也是第一次 vector 明显压过 keyword**（50.0% vs 30.0%，**+20pt**）。前三档 keyword 都不落下风，说明只有「零词面重叠」才真正测到语义能力。
2. **融合在隐喻型上反而有害**：`hybrid` 40.0% **低于纯 vector 50.0%**。BM25 在这类查询上基本是噪声，RRF 把它当同等一路，稀释了语义信号。→ 对高抽象查询应**降低词法权重**（`hybrid_weighted` α≈0.8~0.9）或直接走 vector。
3. **cross-encoder 在 61 条上依然有效**：MRR 0.486 → 0.573（+0.087），nDCG 0.331 → 0.391（+0.060），Recall 68.9% → 72.1%。代价仍是 **4.8s/查询**。
4. **总体分数下降不是退化**：vector 从 51 条的 68.6% 降到 65.6%，是因为新增了 10 条最难查询。

**边界**：隐喻型只有 10 条，**每 10% 就是一条查询**，波动极大；这一节的结论只能当方向性证据，不能当精确指标。

---

## 8.11 语料治理落地与 2000 条索引压测（2026-10-23 追加）

§9 边界里「知识库只有 runs/conversations、`--dir` 只写文件树」这个前置缺口本次补上了。

### 8.11.1 通用文档导入器 `scripts/ingest-docs.ts`

```bash
npm run ingest:docs -- --dir docs --collection docs
npm run ingest:docs -- --dir reports --collection reports --exclude runs --replace
npm run ingest:docs -- --dir D:\数据集\lcc_sample.jsonl --collection lcc --jsonl-field text --build-index
```

- 读**正文**：`.md/.mdx/.txt/.jsonl`；Markdown 按标题切节、段落打包到 `--max-chars`（默认 3000）；jsonl 一行一条，长文本切块而不是截断。
- `--exclude runs,history` 跳过子目录：`reports/runs/` 是 323 份按 run 生成的证据缓存，进库只会稀释召回。
- `--replace` 导入前清空同 collection（`data_items` / `data_items_fts` / `data_vec` 三表一起清，避免文件删改后残留孤儿块）。
- `--build-index` 导入后立即 `rebuildRag()`，打印耗时与 chunk 规模（压测用）。
- 幂等：`itemId = <相对路径>#<序号>`（jsonl 为 `#L<行号>`）。**不调用 `buildRuntime`**——那会触发「启动回收孤儿 run」，把在线服务里未完成的 run 标成 failed。

### 8.11.2 真知识库现状

| collection | 来源 | 条目 | 正文 |
|---|---|---:|---:|
| docs | `docs/`（19 文件） | 359 | 165.4 KiB |
| reports | `reports/`（22 文件，排除 `runs`） | 395 | 270.0 KiB |
| runs | 历史 run 摘要（`ingest-knowledge.ts`） | 223 | — |
| notes | 手工笔记 | 2 | — |
| **合计** | | **979** | |

校验：`data_items_fts MATCH '"cross"*'` 命中 `docs/RAG_AND_AGENT_STACK.md#14`、`reports/RAG_EVAL.md#2` 等，说明正文确实进了 FTS 索引。

### 8.11.3 LCC 2000 条索引压测（临时库，跑完删除）

数据：`D:\数据集\lcc_python` 是 Microsoft **LCC_python** 的重打包版，列只有 `context` / `gt`；本 shard 25,000 行，`gt` 全空，`context` 中位 **13,419 字符**。抽 2,000 条、每条取前 3,000 字符 → `D:\数据集\lcc_sample.jsonl`（6.4 MB）。

| 阶段 | 实测 |
|---|---|
| 导入（含审计 + FTS + hash 向量） | 2,000 条 / 5,856.5 KiB，约 **19s**（≈9.5 ms/条） |
| RAG 构建 | **3,004 chunks / qwen3-embedding-0.6b@1024 / 210.2s**（≈**70 ms/chunk**，CPU Ollama） |
| 临时库体积 | **77.9 MB（≈39 KB/doc）** |

### 8.11.4 结论

1. **索引构建成了新瓶颈**：2000 文档 3.5 分钟；按同速率推到 `MAX_RAG_DOCS=50,000` 约 **1.5 小时**，而且索引只在进程内（重启后首次检索会重建）。→ 持久化索引 / 增量更新应排到 Step 1。
2. **存储放大约 12 倍**：6.4 MB 原文 → 77.9 MB 库（`contentJson` + `searchText` + FTS 各存一份）。按此推 50k 文档约 2 GB，先砍冗余再谈规模。
3. **LCC 只适合压测**：它是「长 Python 文件 + 空 gt」的补全式数据，不是问答/知识语料；真实语料应是本项目的 `docs/` + `reports/` + 决策记录。

**边界**：压测库是临时文件（`data/stress-lcc.db`，已删除），229s 总耗时含进程启动与 FTS 写入；`70 ms/chunk` 随 chunk 长度与 CPU 负载波动，不能当常量外推。

同一导入器对**真实知识库**（979 docs）`--build-index` 实测：**1,107 chunks / 52.3s（≈47 ms/chunk）**——这是本机日常「重启后首次检索」的真实冷启动代价。

## 8.12 持久化索引 P0 落地（2026-10-23 追加）

### 8.12.1 问题

- 索引只在进程内存（`KnowledgeHub.ragCache`）：重启后首次检索要重跑**全部** embedding——979 docs → 1107 chunks → **52.3s**，这段时间用户的 HTTP 请求是挂着的；
- `putData` / `deleteData` 每次都把 `ragCache` 置空：**改一个文档 = 整库重算**。

### 8.12.2 改动

- 新增 `src/knowledge/ragIndexStore.ts`：`rag_chunks`（chunk 正文 + 1024 维向量 BLOB + `doc_hash` + `model/dim/chunk_config`）+ `rag_index_meta`（指纹）。
- `RagPipeline.fromChunks()`：从已有 chunk + 向量重建内存 BM25 + FlatIndex，**不调用 embedding**；`build()` 改为「先算 embedding，再走 fromChunks」，检索代码一行未改。
- `KnowledgeHub.rebuildRag()` 改为**增量同步**：
  - 指纹（model + dim + chunkSize/overlap）不匹配 → 清空 + 全量重算（换模型/换切块参数安全）；
  - 只重算 `doc_hash` 变化的文档；消失的文档级联删块；
  - 单个文档的 chunk 在**同一事务**里整批替换（先删后插），不存在半新半旧。
- 刻意**不**做两件事：检索不下沉到 SQL（FTS5 `unicode61` 对连续中文分词差，会静默降召回）；不混用 `data_vec`（256 维 hash，属于另一条路径，迁移是独立工程）。

### 8.12.3 实测（真实知识库 979 docs / 1107 chunks / `qwen3-embedding-0.6b@1024`）

| 场景 | 耗时 | embedding 调用 |
|---|---:|---:|
| 首次构建（持久化层为空） | **53,874 ms** | 1,107 chunk |
| 模拟重启（同库、新进程） | **254 ms** | **0** |
| 数据库体积 | 47.5 MB → 50.2 MB（+2.7 MB） | — |

回归 `tests/68`（5 例）：重启零嵌入 / 单文档增量 / 级联删除 / 指纹变更全量重算 / 重启前后检索一致；全量 **449/449** 通过。

### 8.12.4 遗留

- **没有后台 worker**：新写入在下次检索时同步增量补齐（单文档几百 ms）；批量导入仍建议走 `--build-index`。
- 检索仍是内存索引（1107 chunks 常驻约 5 MB）；到 5 万文档量级要 Phase 2 下沉到 `vec0` + 词法索引。
- 评测语料已漂移：本次复跑 `rag:bench` 是 **23 文档 / 219 chunks**（§8.10 是 19 / 151），数字不可直接对比——**评测语料未冻结**，这是下一轮要修的口径问题。

## 9. 边界声明

- **五组实测并存，以最新一组为准**：§8.5 / §8.6 用旧 18 条；§8.7 用 34 条；§8.8 用 51 条；§8.9 用 51 条 + cross-encoder；**§8.10 用 61 条（四类问法）+ cross-encoder**。冲突时看 §8.10。
- 评测集**已重建到 61 条、4 种问法**；隐喻型只有 10 条，每 10% 就是一条查询，波动极大。
- `hybrid_rerank` 的数字**取决于 `MTA_RERANKER_URL` 是否设置**：不设走词法（默认），设了走本地 cross-encoder 服务。`reports/RAG_EVAL.md` 的表头会写明实际 reranker。
- cross-encoder 的 **4.8s/查询是 CPU 实测**（torch `+cpu`，15 候选 × 512 token）；GPU/ONNX 量化后的数字未测。
- `vector` 的 ~20ms 含**每次查询一次 HTTP embedding**，不是纯索引耗时；索引本身仍是毫秒级（flat 1.4ms @ 217 chunks）。
- 运行时那组数字（225 docs / 253 chunks / 冷启动 8.3s）是**旧的知识库现状**；2026-10-23 导入语料后为 **979 docs / 1,107 chunks / 冷启动 52.3s（≈47ms/chunk）**，持久化后（§8.12）降到 **254ms**。
- `bge-small-zh-v1.5` / `bge-m3` 未实测；本机只验证了 `qwen3-embedding:0.6b` 与 `bge-reranker-base`。
- `data_vec`（sqlite-vec，`float[256]`，223 行 hash 向量）**本次未迁移**，`/api/knowledge/search?mode=semantic` 仍走 hash。
- §8.11 的导入语料只有 `docs` 359 + `reports` 395 条（+ 历史 `runs` 223 / `notes` 2）；LCC 样本与压测库是**临时产物**，未进入真知识库。
- `70 ms/chunk` 与 `19s / 2000 条` 是本机 CPU + Ollama 的实测，不是理论上限；换机器/换 embedding 服务都要重测。
