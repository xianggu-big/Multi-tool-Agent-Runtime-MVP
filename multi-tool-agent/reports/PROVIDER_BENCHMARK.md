# Provider 横评（PROVIDER_BENCHMARK）

> **目的**：回答 R1——「除 DeepSeek 外的 6 个预设从未实测」。本文给出**当前能测的实测值**，以及其余 Provider 的**精确复现命令**（有 Key 即可复跑，无需改代码）。
> **日期**：2026-10-14 ｜ **口径**：真实 API（非 Mock），成本为表价估算

---

## 1. 结论速览

| Provider | 状态 | 说明 |
|---|---|---|
| **deepseek** | ✅ **已实测通过**（本文 §2） | 默认预设；单 Agent 冒烟 + 多 Agent 编排 + SSE 流式均已真跑 |
| openai | ⏸ **未配置 Key，未测** | 复现命令见 §3；本机仅配置了 `DEEPSEEK_API_KEY` |
| qwen（通义千问） | ⏸ **未配置 Key，未测** | 同上 |
| moonshot（Kimi） | ⏸ **未配置 Key，未测** | 同上 |
| zhipu（智谱 GLM） | ⏸ **未配置 Key，未测** | 同上 |
| ollama（本地） | ⏸ 未测 | 无需 Key，但需本机起 ollama 服务（`baseUrl` 指向 `http://localhost:11434`） |
| custom | ⏸ 未测 | 用户自填 baseUrl/model/Key |

> 与 `reports/PROJECT_REPORT.md` §R1 的对应：R1「只有 DeepSeek 做过真实端到端」在本次复测后**仍然成立**，但复现路径已固化（§3），配 Key 后每项约 1 分钟。

---

## 2. DeepSeek 实测数据（2026-10-14）

### 2.1 单 Agent 冒烟（`npm run smoke:llm`，runId `run_mv7m8izj_9a2a20de`）

| 指标 | 实测值 |
|---|---|
| 结果 | ✅ completed |
| 步骤 / 模型调用 / 工具调用 | 2 / 2 / 1 |
| tokens | 1,737（prompt 1,587 + completion 150） |
| **缓存命中** | prompt 1,152 / 1,587 = **72.6%**（命中价 $0.0028/1M） |
| 成本 | **$0.000106**（表价估算） |
| 总耗时 | **2,600ms**（SSE 观测 2,577ms） |
| 流式增量 | 69 帧（思考 21 字 / 正文 210 字） |
| 附带验证 | thinking×maxTokens 防护生效（maxTokens 1200 → 8192 自动抬升并报 `adjusted`） |

### 2.2 扩展数据点（同日的 A/B 实测，同一 Provider）

| 形态 | 状态 | 墙钟 | 合计 tokens | 成本 |
|---|---|---|---|---|
| 单 Agent 串行（60 工具预算） | completed | 39.4s | 221,461 | $0.00964 |
| 多 Agent 编排（15 子任务） | completed | 243.7s | 1,558,256 | $0.08270 |

（明细与根因见 `reports/PARALLEL_AB.md`）

**DeepSeek 侧观察**：`deepseek-flash` 在缓存命中下长上下文复用成本极低（命中价是标准输入价的 1/50）；A/B 里 7 倍 token 的编排成本中，缓存把"重复读文件"的代价压掉了一部分（否则差距更大）。

---

## 3. 复现命令（其余 Provider：配 Key 即跑）

```bash
cd multi-tool-agent
# 通用形态：LLM_MODE=openai 打开真实模式；LLM_PROVIDER 选预设；Key 用对应环境变量
LLM_MODE=openai LLM_PROVIDER=openai  OPENAI_API_KEY=sk-...        npm run smoke:llm
LLM_MODE=openai LLM_PROVIDER=qwen    DASHSCOPE_API_KEY=sk-...     npm run smoke:llm
LLM_MODE=openai LLM_PROVIDER=moonshot MOONSHOT_API_KEY=sk-...     npm run smoke:llm
LLM_MODE=openai LLM_PROVIDER=zhipu   ZHIPU_API_KEY=...            npm run smoke:llm
LLM_MODE=openai LLM_PROVIDER=ollama  OLLAMA_BASE_URL=http://localhost:11434 npm run smoke:llm   # 本地，无需 Key

# 逐项记录（建议直接抄进下表）：status / 步骤 / tokens / 成本 / 总耗时 / 流式帧 / 缓存命中
# 提示：Key 只走环境变量或界面输入，不要写进仓库（.env 的 Key 字段刻意留空）
```

**待填表**（配 Key 后逐行补齐）：

| Provider | 模型 | status | 步骤 | tokens | 成本 | 耗时 | 流式帧 | 缓存命中 |
|---|---|---|---|---|---|---|---|---|
| openai | ? | — | — | — | — | — | — | — |
| qwen | ? | — | — | — | — | — | — | — |
| moonshot | ? | — | — | — | — | — | — | — |
| zhipu | ? | — | — | — | — | — | — | — |
| ollama | 本机模型 | — | — | — | — | — | — | — |

---

## 4. 口径与边界

- **单次运行**：每 Provider 只跑 1 次冒烟，用于"是否跑得通 + 量级"，不是稳定性/延迟分布结论；要分布需 ≥5 次取 P50/P95。
- **成本是表价估算**（供应商不回金额）：DeepSeek 按 $0.14/1M 输入（缓存 $0.0028/1M）、$0.28/1M 输出；真实账单以各家控制台为准。
- **未测 ≠ 不支持**：其余预设均已配置 baseUrl/模型清单（`src/llm/presets.ts`），验证义务在"有 Key 时跑一遍"。
- 相关：`reports/PROJECT_REPORT.md` §R1/§5、`reports/PARAMETERS.md` §1.2（预设与表价）、`docs/LLM_CONFIG.md`。
