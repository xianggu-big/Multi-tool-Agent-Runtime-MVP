# 杂项子 Agent（Misc Agent）：设计、边界与使用

> 一个专门处理**杂项与低优先级琐碎任务**的子 Agent。核心取舍：**用最小成本换"能答就答、答不了就明确上报"**。
> 它是同一个 Agent Loop 驱动的第三个 Agent（前两个是 Codebase / Research），因此预算、权限、事件、追踪、实时流式等能力全部复用。

---

## 1. 职责范围

### 1.1 做什么（IN SCOPE）

判定标准：**本地、只读、单步或几步就能完成、失败也没有严重后果**。

| 子类型 | 典型任务 | 主要工具 |
| --- | --- | --- |
| `inventory` 清点统计 | 这个目录有多少文件？总大小？按扩展名怎么分布？最大的几个文件是哪些？ | `dir_stats` |
| `locate` 定位 | 哪个文件里有 TODO？`*.bak` 文件在哪？某个关键词出现在哪些文件？ | `search_files` |
| `read` 读取与解释 | 读一下 package.json，说明它是干什么的；把这段 JSON 的字段列出来 | `read_file` |
| `lint` 例行体检 | 目录结构是否规范、有没有空文件、命名是否统一 | `list_files` + `dir_stats` |
| `other` 其它琐事 | 上面几类的组合，仍然只读、小步 | 上述工具 |

### 1.2 不做什么（OUT OF SCOPE，会主动上报改派）

| 不做的事 | 为什么 | 改派给 |
| --- | --- | --- |
| 改代码 / 重构 / 修 bug / 跑测试 | 需要写权限与命令执行 | `codebase` |
| 联网检索 / 查最新版本 / 要来源引用 | 需要网络权限 | `research` |
| **删除 / 批量重命名 / 移动 / 覆盖文件** | 破坏性操作，本项目没有快照与回滚机制 | `human`（人工确认） |
| 跨仓库 / 全盘扫描 / 大规模分析 | 超出「琐事」定位，成本不可控 | `codebase` |
| 涉及密钥、`.env`、`*.key` 等敏感文件 | 安全边界（工具层直接拒绝） | `human` |

> **为什么刻意不提供写能力？** 因为「低优先级」不等于「低风险」。删除/重命名一旦做错就是不可逆的数据损失；本项目既没有沙箱快照，也没有人工审批 UI，所以**只读是功能设计的一部分，不是未完成项**。确实需要写操作时，走 Codebase Agent（有 `repoPath` 边界）或人工处理。

---

## 2. 触发与调用条件

### 2.1 三种触发方式

| 方式 | 说明 | 入口 |
| --- | --- | --- |
| **显式选择** | 用户在界面上把任务类型选为 `Misc Agent` | 前端下拉 / `runType: 'misc'` |
| **自动分流**（推荐） | 选「自动分流」，用**规则式分流器**按目标推荐 Agent | `GET /api/task-router?goal=...` |
| **主 Agent 改派** | 其它 Agent（或 misc 自己）判断任务更适合 misc，改派过来 | 前端「一键改派」/ 直接用 misc 重新提交 |

分流器是**纯函数**（`src/runtime/router.ts`），**不调用 LLM**：分流本身如果先花一次模型调用，就违背了「用最省的 Agent 处理琐事」的初衷。

```bash
curl "http://localhost:3000/api/task-router?goal=这个目录有多少个ts文件"
# {"runType":"misc","confidence":"high","reason":"属于本地、只读、单步可完成的小事，交给 Misc Agent 最省",
#  "signals":["多少","目录"]}
# 破坏性目标会额外返回 requiresHuman=true：
# curl "…/api/task-router?goal=把临时文件批量删除"
# {"runType":"misc","confidence":"medium","requiresHuman":true,
#  "reason":"…；⚠️ 目标包含破坏性动作（删除）：本项目没有任何写/删工具，任何 Agent 都不会执行，需人工确认"}
```

分流规则（可解释、可单测）：

- **动作词优先**：`重构/实现/修复/跑测试/npm test/…` → codebase（权重 3）
- `搜索/调研/对比/最新版本/…` → research（权重 3）
- `多少/几个/统计/清点/目录/有哪些/…` → misc（权重 1，只在没有更重信号时生效）
- 无信号 → 默认 misc 试探（`confidence=low`），并在理由里说明「若上报超范围再改派」
- **升级为编排**：当目标是「只读类 + 多分区」（如「分别清点 src 和 test」「逐个检查每个目录」）时，分流器会建议 `orchestrator`（多 Agent 并行），而不是让 misc 串行做完；一旦出现改代码类信号，仍归 codebase（不抢它的活）
- 命中 `删除/清空/重命名/覆盖` 等危险词 → 返回 `requiresHuman: true`，并在理由里说明「本项目没有任何写/删工具，任何 Agent 都不会执行，需人工确认」（界面上以醒目提示展示）

### 2.2 调用前置条件（Guard，服务端强制）

1. 必须提供 `repoPath`（**只读工作区边界**），且目录必须真实存在，否则 400。
2. `misc.subtask` 只能是 `inventory|locate|read|lint|other`，否则 400。
3. `scanLimit` / `maxFileBytes` **只能收紧不能放宽**（超限会被压回服务端上限）。
4. `maxSteps` / `maxModelCalls` 同样只能收紧（详见 §5.3）。

---

## 3. 输入与输出格式

### 3.1 输入（`POST /api/runs`）

```json
{
  "runType": "misc",
  "goal": "清点 demo/codebase-sample：多少文件、总大小、按扩展名分布",
  "repoPath": "demo/codebase-sample",
  "misc": { "subtask": "inventory", "scanLimit": 2000, "maxFileBytes": 262144 },
  "maxSteps": 6,
  "maxModelCalls": 6,
  "maxToolCalls": 10,
  "tokenBudget": 50000,
  "stream": { "liveDeltas": true },
  "llm": { "provider": "deepseek", "model": "deepseek-flash" }
}
```

响应（201）会回显**本次生效的边界**，避免"以为给了大预算其实被压回"：

```json
{
  "runId": "run_...", "runType": "misc",
  "llm": { "presetId": "deepseek", "model": "deepseek-flash", "params": { "temperature": 0, "thinking": "disabled", "maxTokens": 1500 }, "droppedParams": [], "hasKey": true },
  "miscLimits": {
    "maxSteps": 6, "maxModelCalls": 6, "maxToolCalls": 10, "tokenBudget": 50000,
    "hardMaxSteps": 12, "scanLimit": 5000, "maxFileBytes": 262144,
    "allowedTools": ["list_files","search_files","read_file","dir_stats","submit_result"]
  }
}
```

### 3.2 工具（模型能看到的 5 个，全部只读或纯提交）

| 工具 | 权限 | 说明 |
| --- | --- | --- |
| `dir_stats` | `misc:read` | 目录清点：文件数、总大小、扩展名分布、最大/最新/最旧文件；忽略依赖与构建目录；**不跟随符号链接**；敏感文件只计数不记名 |
| `search_files` | `misc:read` | 复用 Codebase 工具（关键词/文件名定位） |
| `read_file` | `misc:read` | 复用 Codebase 工具（受 `maxFileBytes` 与敏感文件规则约束） |
| `list_files` | `misc:read` | 复用 Codebase 工具（深度/数量受限） |
| `submit_result` | `misc:report` | **终结性工具**：提交结构化结论，成功后任务立即结束 |

### 3.3 输出：结构化结论（`RunResult.misc`）

模型必须用 `submit_result` 提交，schema 由 Zod 强制：

```ts
interface MiscReport {
  summary: string;                                    // 一句话结论（必填）
  items?: { label: string; value: string|number; detail?: string }[];
  findings?: { path: string; note: string }[];
  escalateTo?: 'codebase' | 'research' | 'human';     // 超范围时的改派建议
  escalateReason?: string;                            // 填了 escalateTo 就必须给理由
  artifacts?: { label: string; content: string }[];   // 不落盘的文本产物
  structured: boolean;                                // false = 模型没提交，回退用正文
}
```

**为什么要用工具提交而不是解析文本**：Zod 校验能做 schema + 业务规则（例如"给了 `escalateTo` 就必须给 `escalateReason`"），失败会作为工具错误回灌给模型让它自己修正；同时终结性工具让任务**少跑一轮模型**（实测：提交即结束，`modelCalls` 不再增长）。

实测样例（`npm run demo:misc`，Mock 模式）：

```
status     : completed
steps      : 2 | modelCalls: 2 | toolCalls: 2
finalAnswer: （MOCK）该目录共 5 个文件，合计 1.4KB；统计只覆盖未忽略的目录。
--- 结构化结论（submit_result）---
structured : true
summary    : （MOCK）该目录共 5 个文件，合计 1.4KB；统计只覆盖未忽略的目录。
  · 文件总数: 5
  · 总大小: 1.4KB
  · 扩展名 1: .js × 3
escalateTo : （无，任务在能力范围内）
```

---

## 4. 与主 Agent / 其他子 Agent 的协作与分工

```
                   ┌──────────────────────────────┐
   用户目标 ──►    │  规则式分流器 classifyTask    │  ← 纯函数，不花模型钱
                   └──────────┬───────────────────┘
                              │ 建议（含置信度/理由/信号词）
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
   ┌─────────┐          ┌──────────┐          ┌──────────┐
   │  misc   │          │ codebase │          │ research │
   │ 只读琐事 │          │ 读码+测试 │          │ 联网调研  │
   └────┬────┘          └────┬─────┘          └────┬─────┘
        │ escalateTo         │                     │
        └────────► 一键改派（同一 goal 重新提交，不是 resume）◄──┘
                              │
                              ▼  human（破坏性/敏感操作，人工处理）
```

| 分工原则 | 说明 |
| --- | --- |
| **单职责** | misc 只做只读小事；出现「要写/要联网/要多轮推理」就改派，不硬撑 |
| **成本分层** | misc 的默认预算最小（6 步 / 6 次模型调用 / 50k tokens）、默认关闭思考 → 便宜且快 |
| **可逆优先** | 能只读完成的绝不动写路径；破坏性动作一律交人工 |
| **改派而非恢复** | `escalateTo` 触发的是**新任务**（同 goal、换 Agent），不是 `POST /resume`（那是同一任务从检查点续跑）——语义不同不能混用 |
| **共享基础设施** | 三个 Agent 共用同一个 Agent Loop / Tool Registry / 预算 / 状态机 / 事件与追踪 / SSE 实时视图，新增一个 Agent 不需要改循环 |

界面上：杂项结论卡片会显示 `⚠️ 该任务超出杂项 Agent 的能力边界，建议改派给 Codebase Agent。理由：…`，并给出**「一键改派给 X」**按钮（自动切任务类型 + 保留 goal）。

---

## 5. 权限与边界限制

### 5.1 权限集（服务端派生，模型无法自行扩大）

| 任务类型 | 权限 | 能否跑命令 | 能否联网 | 能否写文件 |
| --- | --- | --- | --- | --- |
| codebase | `codebase:read`, `codebase:test` | ✅（白名单） | ❌ | ❌ |
| research | `research:web`, `research:read` | ❌ | ✅ | ❌ |
| **misc** | **`misc:read`, `misc:report`** | **❌** | **❌** | **❌** |

实测验证（tests/21d、21e）：misc 请求 `run_tests` → `PERMISSION_DENIED`；请求 `web_search` → `PERMISSION_DENIED`。**拒绝发生在执行之前**（Registry 先查权限，再校验参数，最后才执行）。

### 5.2 路径与内容边界

- 所有路径过 `assertInsideRepo`：越界（`../../`）直接 `PATH_ESCAPE`（tests/21j 验证）。
- 敏感文件（`.env`、`*.key`、`*.pem`、`credentials.json`…）不读、不列举；`dir_stats` 对它们**只计数、不记录文件名**。
- 不跟随符号链接（防目录逃逸与环路）。
- 事件日志脱敏（`apiKey`/`token`/`sk-...` → `***REDACTED***`）。

### 5.3 预算边界（「只能收紧，不能放宽」）

| 项 | 默认 | 硬上限 | 说明 |
| --- | --- | --- | --- |
| `maxSteps` | 6 | **12**（`MISC_HARD_MAX_STEPS`） | 请求写 999 也会被压回 12（tests/21i 验证：触发 `limit_reached`、`triggeredLimit=maxSteps`） |
| `maxModelCalls` | 6 | 12 | 同上 |
| `maxToolCalls` | 10 | 40 | |
| `tokenBudget` | 50000 | 请求方可调大，但仍受 Runtime 预算体系约束 | |
| `totalTimeoutMs` | 60000 | 全局 `DEFAULT_TOTAL_TIMEOUT_MS` | 琐事不该跑很久 |
| `scanLimit` | 5000 | 50000 | 目录扫描条目上限（防大目录空转） |
| `maxFileBytes` | 262144（256KB） | 4MB | 单文件读取上限 |
| 生成参数 | `temperature=0`、`thinking=disabled`、`maxTokens=1500` | 可被 `.env` / 单次任务覆盖 | 琐事不需要思考链：更省更快 |

> 「只能收紧不能放宽」是刻意的：否则只要把 `maxSteps` 写成 50，就能拿只读的杂项 Agent 去干重活，成本与边界都会失控。

---

## 6. 异常、升级与回退策略

| 情形 | 系统行为 | 用户看到什么 |
| --- | --- | --- |
| 工作区不存在 / 未提供 | 400，**任务不创建**（不浪费任何 token） | 明确的错误提示（含收到的原始输入） |
| 任务超出能力（要改代码/联网/删除） | 模型按提示词直接 `submit_result` + `escalateTo` + `escalateReason` | 结论卡片 + **一键改派**按钮（`human` 时提示人工处理） |
| 模型请求池外工具（如 `run_tests`） | Registry 返回 `PERMISSION_DENIED` 并**回灌给模型**，模型据此改派或收尾 | 事件流里可见 `tool_failed`；结论里带改派建议 |
| 模型没调用 `submit_result` 就结束 | **回退**：`finalAnswer` 正文作为 `summary`，`structured=false` | 卡片标题显示「未结构化（模型未调用 submit_result）」，样式区分，不假装是结构化结论 |
| `escalateTo` 没带理由 | 工具返回 `MISSING_ESCALATE_REASON`，模型有机会修正 | 不会采纳「光说改派不说为什么」的结论 |
| 目录扫描被截断（超 `scanLimit`） | 结果标 `truncated=true` | 提示「统计结果不完整（可缩小 dir 或降低 maxDepth）」，结论里也应说明 |
| 文件过大 / 敏感文件 / 越界路径 | 工具返回错误（`FILE_TOO_LARGE` / 敏感 / `PATH_ESCAPE`） | findings 或 summary 里说明「已跳过」 |
| 步数 / token / 超时超限 | `limit_reached` + `triggeredLimit` | 状态徽标 + 失败原因；必要时改派给更合适的 Agent |
| 模型或网络异常 | `run_failed` + `errorCode` | 失败原因；建议人工或换 Provider 重试 |

**升级链**：`misc` →（`escalateTo`）→ `codebase` / `research` →（都不适用或涉破坏性操作）→ `human`。

---

## 7. 可落地的配置与使用方式

### 7.1 服务端配置（`.env`）

```bash
MISC_MAX_STEPS=6              # 默认步数
MISC_MAX_MODEL_CALLS=6        # 默认模型调用上限
MISC_MAX_TOOL_CALLS=10        # 默认工具调用上限
MISC_TOKEN_BUDGET=50000       # 默认 token 预算
MISC_HARD_MAX_STEPS=12        # 硬上限（请求无法超过）
MISC_SCAN_LIMIT=5000          # 目录扫描条目上限
MISC_MAX_FILE_BYTES=262144    # 单文件读取上限（256KB）
```

### 7.2 三种使用方式

```bash
# ① 一键演示（Mock，无需 Key）
npm run demo:misc

# ② HTTP：直接指定 misc
curl -s -X POST http://localhost:3000/api/runs -H 'content-type: application/json' -d '{
  "runType":"misc",
  "goal":"清点 demo/codebase-sample：多少文件、总大小、扩展名分布",
  "repoPath":"demo/codebase-sample",
  "misc":{"subtask":"inventory"}
}'

# ③ HTTP：先问分流器再提交（模拟界面的「自动分流」）
curl -s "http://localhost:3000/api/task-router?goal=$(python -c "import urllib.parse;print(urllib.parse.quote('这个目录有多少个 ts 文件'))")"
```

界面上：任务类型选 **「自动分流」** 或 **「Misc Agent（杂项 / 低优先级琐事，只读）」** → 填工作区路径与目标 → 「开始任务」。
「实时」视图会显示它的思考与工具卡片（`dir_stats` 的统计结果、`submit_result` 的提交），结束后在「事件流」视图下方看到结构化结论卡片。

### 7.3 相关接口与事件

| 接口 | 用途 |
| --- | --- |
| `GET /api/task-router?goal=&allowMisc=` | 分流建议（`allowMisc=0` 可强制不给 misc） |
| `POST /api/runs` | 创建任务（响应含 `miscLimits` 回显） |
| `GET /api/runs/:id` | 结果含 `misc` 结构化结论 |
| 事件 `misc_report_submitted` | 记录了结构化/非结构化、条目数、改派目标与理由 |

---

## 8. 代码位置与测试

| 位置 | 内容 |
| --- | --- |
| `src/tools/misc/dirStats.ts` | 只读目录统计（边界：忽略依赖目录、不跟随符号链接、敏感文件只计数） |
| `src/tools/misc/submitResult.ts` | 终结性结构化提交（含「改派必须给理由」的业务校验） |
| `src/runtime/router.ts` | 规则式分流器（纯函数、可解释、可单测、不花模型钱） |
| `src/runtime/AgentRuntime.ts` | misc 工具池/权限/预算边界、终结性工具处理、misc 专属系统提示词 |
| `src/llm/scenarios.ts` | `misc-basic` 演示剧本 |
| `src/demo/misc.ts` | 可运行演示 |
| `tests/21_misc_agent.test.ts` | 21a–21m：分流、工具池、越权、终结性工具、回退、改派、预算硬上限、dir_stats 边界、HTTP 端到端、分流接口 |

---

## 9. 已知限制（诚实清单）

1. **分流器是规则式的**：只认关键词，遇到「帮我把那个东西弄一下」这类模糊目标会低置信度地默认走 misc 试探，可能需要一次改派。它**不调用 LLM** 是有意为之（省钱、可解释、可单测）。
2. **没有真正的多 Agent 编排**：当前是「建议 + 一键改派」，不是主 Agent 自动 fork 子 Agent 并汇总。跨 Agent 自动委派属于下一阶段（需要子任务队列与结果汇总协议）。
3. **misc 不支持写操作**：见 §1.2 的理由；未来若要做，必须同时具备：单文件、显式审批、写前快照、可回滚，缺一不可。
4. **`dir_stats` 的统计不含被忽略目录**（`node_modules`/`.git`/`dist` 等）：结论里必须说明，否则数字会与 `du` 之类工具不一致。
5. **改派不会自动继承原任务的上下文**：只带 `goal` 重新提交（原 runId 仅作文案提示），因为跨 Agent 的消息格式与权限不同。
