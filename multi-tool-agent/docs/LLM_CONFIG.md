# LLM 接入与调参手册（LLM_CONFIG）

> 目标：把「baseUrl + 模型」从手填变成**可选**，把**可调参数**摊开讲清楚，方便你边跑边学。
> 本文的数据全部来自**真实 API 实测**（2026-10-13，DeepSeek），不是抄文档。

---

## 1. 三步接入 DeepSeek

**方式 A：界面配置（推荐，不用改文件）**

1. `npm start` → 打开 http://localhost:3000
2. 左侧展开「LLM / 搜索 / 实时流 配置」→ **LLM 模式** 选 `真实接口（OpenAI 兼容）`
3. **服务商** 选 `DeepSeek（推荐）` → 模型下拉出现 `deepseek-flash` → 粘贴 API Key（旁边有「申请 Key」链接）
4. 点 **测试连接** 确认通过 → 「开始任务」

**方式 B：环境变量（进程级默认，重启仍生效）**

```bash
# .env
LLM_MODE=openai
LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=sk-你的key
```

> ⚠️ **不要把真实 Key 写进 `.env.example`** —— 那是给 Git 提交的模板。写 `.env`（已被 `.gitignore` 忽略），或用界面填写。

---

## 2. 可选式配置：预设目录

界面上的「服务商 → 模型」两连下拉，数据来自服务端 `GET /api/llm/presets`（单一事实来源，前后端不会各写一份）。

| 预设 | Base URL | Key 环境变量 | 说明 |
| --- | --- | --- | --- |
| **deepseek**（默认） | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | 优先接入；清单经真实 API 校验 |
| openai | `https://api.openai.com/v1` | `OPENAI_API_KEY` | 模型清单为示例，可切「自定义模型」 |
| qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY` | 阿里云百炼兼容模式 |
| moonshot | `https://api.moonshot.cn/v1` | `MOONSHOT_API_KEY` | Kimi |
| zhipu | `https://open.bigmodel.cn/api/paas/v4` | `ZHIPU_API_KEY` | GLM |
| ollama | `http://localhost:11434/v1` | 无需 Key | 本地模型（需先 `ollama pull`） |
| custom | 手填 | `LLM_API_KEY` | 任何 OpenAI 兼容网关 |

**DeepSeek 模型清单（2026-10-13 用 `GET /models` 实测）**

| 模型 ID | 上下文 | 最大输出 | 思考深度 | 备注 |
| --- | --- | --- | --- | --- |
| `deepseek-flash`（默认） | 1,048,576 | 393,216 | low / high / max | 输入支持文本+图片（本项目只发文本） |
| `deepseek-v4-pro` | 1,048,576 | 393,216 | low / high / max | 质量更高、更贵 |

> 旧别名 `deepseek-chat`、`deepseek-reasoner`、`deepseek-v4-flash` **实测仍可用**（分别路由到 `deepseek-flash` 的非思考/思考模式），但属于弃用名，建议直接用正式 ID。

**优先级（高 → 低）**

| 项 | 顺序 |
| --- | --- |
| Base URL / 模型 | 界面/单次任务 > 显式配置的 `OPENAI_BASE_URL`/`OPENAI_MODEL` > 预设默认值 |
| API Key | 界面/单次任务 > `LLM_API_KEY`/`DEEPSEEK_API_KEY`（config） > 预设对应的环境变量 > `OPENAI_API_KEY` |
| 生成参数 | 单次任务 `llm.params` > `.env` 的 `LLM_*` |
| Provider 预设 | 界面 > `LLM_PROVIDER` > 有旧版 `OPENAI_*` 变量则 openai > 兜底 deepseek |

---

## 3. Token 的两种限制（最容易混淆，务必分清）

| | `max_tokens`（单次输出上限） | `tokenBudget`（任务 Token 预算） |
| --- | --- | --- |
| 作用范围 | **一次模型回复** | **整个任务累计**（所有轮次的输入+输出） |
| 在哪配 | 界面「Token 限制」→ 单次输出上限 / `LLM_MAX_TOKENS` | 界面「Token 限制」→ 任务 Token 预算 / `DEFAULT_TOKEN_BUDGET` |
| 超了会怎样 | 回复被截断：`finish_reason=length`，工具参数可能残缺 | 任务停止，状态 `limit_reached`、`triggeredLimit=tokenBudget` |
| 典型症状 | 答案只写一半、工具调用 JSON 解析失败 | 多轮任务跑到一半停住，提示超过 Token 预算 |
| 还有 | 思考内容**也计入** `max_tokens`（实测见 §5.3） | 还有 `costBudgetUsd` 费用预算，同样会停任务 |

另外「最大步骤 / 模型调用上限 / 工具调用上限」是 Runtime 的**次数**限制，与 token 无关。

---

## 4. 参数手册（每个参数都能在界面上调）

| 参数 | 范围 | 不填时 | 调大 | 调小 | Agent 场景建议 |
| --- | --- | --- | --- | --- | --- |
| `max_tokens` | 1–384000（DeepSeek） | 厂商默认 | 回答更长、更贵 | 更快更省，但可能截断 | **2048–8192**；思考模式别低于 2048 |
| `temperature` | 0–2 | 厂商默认（DeepSeek=1.0） | 更发散、更有创意、更不稳定 | 更确定、可复现 | **0–0.3**（工具调用要求确定性） |
| `top_p` | 0–1 | 1.0 | 候选更多样 | 更保守 | 与 temperature 二选一调，**保持 0.95–1.0** |
| `frequency_penalty` | -2–2 | 0 | 少复读 | 允许重复 | 长文生成可试 0.1–0.3 |
| `presence_penalty` | -2–2 | 0 | 更愿引入新话题 | 更聚焦 | 一般保持 0 |
| `thinking` | enabled/disabled | 厂商默认（DeepSeek 默认开） | — | 关掉可显著提速省钱 | 复杂分析开、简单工具调用可关 |
| `reasoning_effort` | low/high/max | 厂商默认（high） | 思考更深、更慢更贵 | 更快更省 | **low** 起步；难任务再上 max |
| `extra`（JSON） | 任意 | — | 直通厂商新参数 | — | 试验用；`model/messages/tools/stream` 等键会被拦截 |

界面上还提供三个一键预设：**精确 0.0 / 平衡 1.0 / 创意 1.5**（改的是 temperature）。

**「被忽略的参数」提示**：开启思考模式后，DeepSeek 会忽略 `temperature`/`top_p`/penalties。服务端会**直接不发送**这些字段，并在开始任务后的回显里列出：

```
本次生效：DeepSeek（推荐） · deepseek-flash · https://api.deepseek.com · Key 已使用
参数：{"maxTokens":900,"temperature":0,"thinking":"enabled","reasoningEffort":"low"}
⚠️ 被忽略的参数：temperature（当前模型不支持，或思考模式下无效）
```

（这条提示是实测得到的：`droppedParams: ["temperature"]`。）

---

## 5. 实测记录（2026-10-13，真实 DeepSeek API）

### 5.1 连通性与模型清单

```
GET https://api.deepseek.com/models      → 200，132ms，返回 2 个模型
  deepseek-flash     (V4.1-Flash) 1,048,576 ctx / 393,216 max_out / effort [low,high,max]
  deepseek-v4-pro    (V4-Pro)     1,048,576 ctx / 393,216 max_out / effort [low,high,max]
```

### 5.2 思考模式与 `reasoning_content`

```bash
POST /chat/completions  {"model":"deepseek-flash","thinking":{"type":"enabled"},"reasoning_effort":"low", ...}
→ 200；message.reasoning_content 有 91 字（真实思维链），message.content = "1+1等于2。"
    usage.completion_tokens_details.reasoning_tokens = 56
```

流式同样有效：**28 个 SSE 帧**，`delta.reasoning_content` 累计 93 字符、`delta.content` 1 字符。

> 本项目的「实时」视图就是消费这个通道：`delta.reasoning_content → llm_delta{channel:"reasoning"}` 逐字渲染。

### 5.3 ⚠️ 教学案例：`max_tokens` 太小会「思考吃光额度」

```
max_tokens=5（思考模式开启）
→ finish_reason = "length"
   message.reasoning_content = "We need answer user just"   ← 5 个 token 全被思考吃掉
   message.content = ""                                     ← 正文为空
```

**这是最典型的踩坑**：以为模型「不吭声了」，其实是 `max_tokens` 太小。看到「正文为空 + finish_reason=length」→ 先加大 `max_tokens`。

### 5.4 工具调用（Agent 的前提）

```
tools=[search_files]，tool_choice=auto，thinking=disabled
→ finish_reason = "tool_calls"
   tool_calls = [{ name:"search_files", arguments: {"pattern":"add"} }]   ← 0.53s
```

### 5.5 完整 Agent Loop（本项目真实跑通）

```
runId=run_...  status=completed  4 steps / 4 model calls / 3 tool calls
总耗时 3697ms（SSE 观测 3667ms）
流式增量 159 帧（思考 141 字 + 正文 256 字）
tokens: prompt 3430（其中 2432 命中缓存）/ completion 301 / 思考 36
费用估算 $0.000231（estimateNote：按 deepseek-flash 表价 输入 $0.14/1M（缓存命中 $0.0028/1M）、输出 $0.28/1M）
真实工具轨迹：read_file(ENOENT 被纠正) → list_files → read_file → 给出结论
```

**两个可复用的经验**：

1. **上下文缓存是 Agent 的最大省钱杠杆**：4 次调用里 71% 的输入 token 命中了缓存，缓存价（$0.0028/1M）比未命中（$0.14/1M）便宜 50 倍。
2. **模型会自己从工具报错里纠正**：它先按用户给的路径读文件（失败），看到错误后列目录、换正确路径重试，最后答案里还解释了路径为什么错——说明工具错误信息要写清楚（本项目 `READ_ERROR` 带了原因）。

### 5.6 费用估算的诚实性

- 表价来自预设（`LLMModelPreset.pricing`），**价格会变**，界面上始终标注为「估算」并给出费率依据。
- 有表价时按「输入（区分缓存命中）+ 输出」分开计价；无表价时退化为固定 $1/1M 并明确写「粗略估算（偏差可能很大）」。
- 修正前用固定比率估算同一任务得到 $0.0048，**比真实值高约 20 倍**——这就是必须标注估算依据的原因。

---

## 6. 常见错误与排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `测试连接` 返回 401 / `鉴权失败` | Key 无效、过期、或复制时带了空格 | 重新复制 Key；确认用的是对应服务商的 Key |
| 401 但你确信 Key 有效 | 环境里存在**旧的/别人的** Key 被优先使用 | 界面填写会覆盖环境变量；或检查 `.env` / 系统环境变量 |
| `HTTP 404` | Base URL 不对（少写/多写 `/v1`） | DeepSeek 用 `https://api.deepseek.com`（带 `/v1` 也兼容）；DashScope 必须带 `/compatible-mode/v1` |
| `未知的 LLM Provider 预设` | 预设 id 拼错 | 错误信息里会列出全部可选 id |
| `未提供 API Key` | 选了真实模式但没 Key | 界面填 Key，或设置 `DEEPSEEK_API_KEY`；**不会静默降级成 Mock** |
| 正文为空、`finish_reason=length` | `max_tokens` 太小，被思考吃光 | 加大 `max_tokens`（≥2048），或 `thinking=disabled` |
| 工具调用 JSON 解析失败 | 输出被截断 | 加大 `max_tokens` |
| 调了 temperature 没变化 | 开启思考模式时该参数被忽略 | 看「被忽略的参数」提示；要确定性就 `thinking=disabled` + `temperature=0` |
| `temperature 超出允许范围 [0, 2]` | 参数越界 | 按提示范围改（服务端拒绝而不是静默改值） |
| 429 / 限流 | 并发或配额 | 降低并发（`MAX_TOOL_CONCURRENCY`）、减少 `maxModelCalls` |
| 请求超时 | 网络/代理 | 本机走代理时注意 Base URL 可达性；`totalTimeoutMs` 也要留够 |

**命令速查**

```bash
# 用你的真实 Key 跑一次完整链路（会花极少量 token，脚本已把上限压小）
LLM_MODE=openai npm run smoke:llm
LLM_MODE=openai LLM_PROVIDER=deepseek DEEPSEEK_API_KEY=sk-xxx npm run smoke:llm

# 只测连通性（/models，不消耗 token）
curl -s -X POST http://localhost:3000/api/llm/test -H 'content-type: application/json' -d '{"provider":"deepseek"}'

# 看预设目录与参数元数据
curl -s http://localhost:3000/api/llm/presets | head -c 800
```

---

## 7. 调参实验指南（建议按这个顺序学）

1. **先跑通**：`npm run smoke:llm` 或界面「测试连接」，确认 Key/BaseUrl/模型没问题。
2. **感受 `max_tokens`**：设 `thinking=enabled` + `max_tokens=200` 跑一次 → 大概率看到「思考写完正文为空」；再改成 2048 → 正常。这一条就理解了 token 上限的双重作用。
3. **感受 `thinking`**：同一任务分别 `enabled`/`disabled`，对比「实时」视图里的耗时与 tokens。简单工具调用任务关掉思考通常更快更省。
4. **感受 `reasoning_effort`**：low → high → max，看 `reasoningTokens` 与耗时怎么涨。
5. **感受 `temperature`**：必须 `thinking=disabled` 才有意义；同一 prompt 跑 3 次，0 与 1.5 的稳定性差异很明显。
6. **感受预算**：把「任务 Token 预算」调到 3000 跑一个多步任务 → 观察 `limit_reached` 与 `triggeredLimit=tokenBudget`；再把「费用预算」设 0.0001 试一次 → `costBudget`。
7. **看缓存**：连续跑两次同一任务，对比 `usage.cachedPromptTokens` 与费用估算的变化。

---

## 8. 已知限制（诚实清单）

1. **只有 DeepSeek 做了真实端到端验证**（2026-10-13）：其余预设（openai / qwen / moonshot / zhipu / ollama）的**代码路径相同**（都是 OpenAI 兼容 + `/chat/completions`），但本环境无对应 Key，**未实测**；模型清单与表价也来自公开资料，可能已过期。
2. **价格是估算**：表价写在预设里，会变动；真实账单以供应商为准。
3. **`extra` 是学习用的直通口**：越权字段被拦截，但仍可能出现「厂商已废弃的参数」被发出去而报错——错误会原样透出。
4. **思考内容不落盘（逐字）**：只保留 1200 字符的聚合预览（见 `docs/STREAMING_LIVE_VIEW.md` §8）。
5. **`max_tokens` 字段名固定为 `max_tokens`**：若某厂商改用 `max_completion_tokens`，可用 `params.extra: {"max_completion_tokens": N}` 直通。
6. **界面参数不会自动跟随模型能力变化**：切换模型/Provider 后请留意「被忽略的参数」提示。
