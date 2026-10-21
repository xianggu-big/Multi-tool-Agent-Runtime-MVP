# multi-tool-agent 多 Agent 协作（编排主 Agent + 并行子 Agent）架构设计

> 设计台账：2026-10-13 · multi-tool-agent · v1 · 关键决策 12 项 · 未知区 8 项 · 独立评审 **存疑 5 项已全部回修（1 轮）**
> 独立评审：由**独立上下文的子智能体**执行（未见设计过程推理），按「权衡成立性 / 案例对照贴切性 / 成本量级一致性 / 来源支撑性」四项三态判定；
> 结果：权衡成立性=通过、来源支撑性=通过（回修后）、案例对照贴切性=存疑 2 项、成本量级一致性=存疑 3 项 —— 回修明细见 §16。
> 轨道：新建轨（在既有 Harness 六层之上新增编排能力；既有 98 个测试全部保留为回归基线）
> 状态标注：**已确认** = 用户拍板（AskUserQuestion 四项选择）；**默认假设** = 本设计建议，可推翻。
> 实现进度：设计已在同一会话内落地为 MVP 代码 + 测试（`tests/22_orchestrator.test.ts`、`tests/23_agent_contracts.test.ts`），本文档按**实际实现**校对。

---

## 1. 需求规格

| 维度 | 内容 | 状态 |
|---|---|---|
| 目标与用途 | 主 Agent 调度、多个子 Agent **并行**执行任务的协作方案；覆盖拆分分配、职责边界、并行执行、文档/接口契约四要点 | 已确认 |
| 成功标准 | ① 子任务在独立上下文运行且汇总为结构化报告（Zod 断言）；② **在分区数 ≤ 宽度上限（默认 4）时**，墙钟比串行基线降 ≥40%（用 `Tracer` span 实测；分区数超过上限会分批，收益随之下降——这是 `SUBAGENT_MAX_WIDTH` 的直接代价）；③ 越权调用在**结构层**被拒（断言 `PERMISSION_DENIED`） | 已确认 |
| 验收来源 oracle | 客观部分：`npm test`（123 项，含并行等价性/越权/部分失败/级联取消）+ `npm run agents:lint`；主观部分（汇总质量）不自动评分，标注未知区 | 已确认 |
| 任务结构 | 混合：天然分区类（多目录清点/审计、多来源调研）可扇出；有增量依赖类（跨模块重构、追调用链）必须串行 | 已确认 |
| 数据/资源边界 | 工作区 `repoPath` 为只读边界；子 Agent 继承只读边界（无写/删/命令/联网除 research 类 spec） | 已确认 |
| 硬约束 | ① 向后兼容（既有测试全绿）② 扇出宽度 ≤4、深度 ≤1（MVP）、预算显式分配 ③ 只读优先 ④ 不引入外部队列/中间件，单机 Node + SQLite | 已确认 |
| 用户与场景 | 开发者本机使用；界面「多 Agent 编排」入口；CLI/HTTP 亦可 | 已确认 |
| 边界（不做什么） | 不做跨进程/分布式调度；不做子 Agent 间自由对话；不做自动写/删；不做深层递归（>1 层） | 已确认 |
| 技术栈约束 | TypeScript 5.7 + Node 22/24 + better-sqlite3 + express + zod；`node:test` + tsx；无新依赖 | 已确认 |
| 模型策略与成本 | 接受分档：主 Agent 强档 / 子 Agent 低价档 / 窄决策走确定性规则；DeepSeek 已实测（含缓存 71% 命中） | 先确认（问卷 Q6 参考答案） |
| 效率与体感 | 并行段墙钟 ≈ max(子任务)+汇总；必须流式（既有 SSE + 实时视图）；并行度封顶 4；取消级联 | 先确认（问卷 Q7 参考答案） |

---

## 2. 架构范式 P

| 子维度 | 决策 | 理由 |
|---|---|---|
| 扩展方式 | **插件化（契约驱动）** | 新增子 Agent = 在 `src/agents/specs.ts` 加一条 spec，不改 Runtime；契约由 `validateSpecs` 装配期强校验 |
| 配置方式 | **声明式为主 + 代码兜底** | spec 声明能力/权限/预算；运行期参数走 `RunInput.orchestration`；复杂编排由主 Agent 动态决定（提示词引导） |
| 部署拓扑 | **单机进程内并发（Runner 可替换）** | 复用现有 `enqueue` 与共享 SQLite（WAL）；`SpawnSubAgent` 是注入式闭包，未来可换子进程/远程而不改工具与契约 |
| 编排模式 | **中心化调度 + 扇出-扇入** | 主 Agent 独占拆分与汇总；子 Agent 完全隔离（Actor 式），只回传结构化结果 |

---

## 3. 技术栈选型

| 项 | 选型 | 理由 |
|---|---|---|
| 语言 | TypeScript 5.7（`moduleResolution: Bundler`，`.js` 后缀 specifier） | 项目既有约定 |
| 运行时 | Node 22（托管）/ Node 24（系统，需与 better-sqlite3 ABI 对齐） | 既有环境 |
| 关键依赖 | zod（契约与参数校验）、better-sqlite3（持久化）、express（HTTP/SSE） | 零新增依赖 |
| 运行环境 | 本机单进程；SQLite WAL | 单人开发场景 |

**模型组合**（四分类；候选模型来自项目已实测的 DeepSeek 预设，价格量级见 `src/llm/presets.ts` pricing，核实日期 2026-10-13）

| 档位 | 候选模型 | 职责 | 单价量级（每 1M tokens） | 预估 token 占比 |
|---|---|---|---|---|
| 确定性代码 | — | 任务分流 `classifyTask`、预筛 `preSplitSubtasks`、零决策 | — | 0% |
| 决策型模型 | — | MVP 未启用（保留：该不该扇出/该合并还是重跑可用窄决策模型） | — | 0% |
| 快速低价 LLM | `deepseek-flash` + `thinking=disabled`（清点类）/ `effort=low`（分析类） | 子 Agent 执行子任务 | 输入 $0.14 / 缓存 $0.0028 / 输出 $0.28 | ~70% |
| 强力 LLM | `deepseek-v4-pro` 或 `flash` + `thinking=enabled` + `effort=low` | 主 Agent 拆分与汇总核验 | 输入 $0.435 / 缓存 $0.003625 / 输出 $0.87 | ~30% |

---

## 4. 六层设计

### 4.1 E 执行循环

- **设计决策**
  - 执行模式：**分叉与综合（扇出-扇入）**；同一 `AgentRuntime.loopBody` 驱动主 Agent，子 Agent 走独立的短生命周期循环 `runSubAgent`（不可恢复，见 §15）。
  - 终止条件：主 Agent 必须调用终结性工具 `submit_orchestration`；子 Agent 必须调用 `submit_finding`。未调用 = 契约未履行（`structured=false` / `contractViolation`），**不让模型自评成功**。
  - 防跑飞三道保险：主任务 `maxSteps/maxModelCalls/maxToolCalls` + 子任务各自独立预算 + 每节点超时（工具 `timeoutMs`、子任务 `totalTimeoutMs`）。
  - 墙钟与并行：`SUBAGENT_MAX_CONCURRENCY=4` 有界池；`effectiveConcurrency()` 再按剩余预算下调；并行段墙钟 ≈ max(子任务) + 汇总。
  - 失败分类回喂：工具错误作为 `role:tool` 观察回喂（不吞异常）；子任务失败/取消/超限一律转成 `SubtaskOutcome.status`，由主 Agent 在 `unresolved` 里显式处理。
  - 打转检测：沿用 registry 的未知工具/参数校验 + 单任务步数上限（未做「N 次同参指纹」检测，列入未知区）。
  - 可中断：父 `AbortController` 级联到子任务；本项目工具全只读 → **取消无补偿问题**。
- **落地规格**：`AgentRuntime.loopBody`（既有） + `src/runtime/subAgentLoop.ts:runSubAgent()` + `src/runtime/SubAgentPool.ts:SubAgentPool.map()`（结果顺序 = 入参顺序，单任务异常转结果不打断整批）。

### 4.2 T 工具注册

- **设计决策**
  - 接入方式：沿用 `ToolRegistry.register`；三个新工具 `delegate_subtasks` / `submit_orchestration` / `submit_finding`。
  - **注册 ≠ 披露 ≠ 授权**三处分离（本设计的关键）：
    - 注册：全局注册表（都在）；
    - 披露：`toDefinitionsFor(spec.tools)` —— 子 Agent 只看到自己契约里的工具，顺序固定；
    - 授权：`ToolContext.allowedPermissions = spec.permissions`，越权由 Registry 拒绝（实测 `PERMISSION_DENIED`）。
  - 深度守卫：子 Agent 的 `ToolContext` **不注入** `spawnSubAgent`（能力层面"没有那条通路"），再加授权层拦截。
  - 执行环境：本地进程内；只读工具无副作用。
  - 凭证：不进入子 Agent 上下文（子 Agent 只拿 objective/inputs；Provider 与 Key 由 Runtime 持有）。
- **落地规格**：`src/tools/orchestrator/{delegateSubtasks,submitOrchestration,submitFinding}.ts`；`src/tools/types.ts:ToolContext.{spawnSubAgent,onSubtasksDelegated,depth,allowedSpecs}`。

### 4.3 C 上下文管理

- **设计决策**
  - 隔离：子 Agent 独立 `messages`（全新 system + user），看不到主 Agent 历史与兄弟结果。
  - **回传裁剪**：`delegateSubtasks` 对每个子任务结果按 `SUBAGENT_RESULT_CHARS=800` 裁剪；`findings/items` 各截前 20 条；`artifacts` 正文**不回传**（只留标签），并把截断项写进 `truncatedFields`。
  - 前缀稳定：子 Agent 系统提示由 spec 模板生成（无时间戳/随机 id）；工具定义按 `spec.tools` 固定顺序披露；`renderDocSet` 输出逐字节确定（lint 依赖此性质）。
  - 外部内容消毒：文件/网页内容在提示词里被标记为不可信输入；工具结果进入子 Agent 上下文时按 32k 字符截断。
- **落地规格**：`subAgentLoop.buildSubAgentPrompt()`；`delegateSubtasks.brief()`。

### 4.4 S 状态存储

- **设计决策**
  - 主任务沿用 `runs/events/checkpoints`；**结构化结果统一存 `runs.resultJson` 信封** `{v:1, misc?, orchestration?, subtasks?}`（`src/store/resultJson.ts`，兼容旧的裸 MiscReport）。
  - 子任务事件（`subtask_started/completed/failed`、`subtask_report_submitted`）落入既有 `events` 表，通过 `spanId + parentId` 关联父 run → 前端流程图/瀑布图直接可见。
  - 并发写：SQLite WAL；子任务不独立落库（**MVP 取舍**：不建 subtasks 表，见 §15）。
  - 外部副作用幂等：本项目工具全只读 → 无副作用，`N/A`。
- **落地规格**：`SqliteStore.migrate()` 增列 `resultJson`（`PRAGMA table_info` + `ALTER TABLE ADD COLUMN`）、`unpackResultJson()`。

### 4.5 L 生命周期钩子

- **设计决策**
  - 拦截点：`ToolRegistry.execute` 是唯一执行入口（未知工具 → Schema → 权限 → 超时 → 异常规范化），主/子 Agent 共用。
  - 委派前置校验：宽度（`WIDTH_LIMIT`）、规格存在性（`UNKNOWN_SPEC`）、白名单（`SPEC_NOT_ALLOWED`）、能力注入（`DELEGATION_NOT_AVAILABLE`）。
  - 人在回路：继承既有四档——只读自动执行；破坏性动作因**无工具**而结构上不可达（`requiresHuman` 在分流器里提前提示）。
  - 纵深：披露层 + 授权层 + 宽度/深度守卫 + 预算守卫（四道，互不依赖）。
- **落地规格**：`delegateSubtasks.execute()` 的三道守卫；`AgentRuntime.resolveAllowedTools()`（按 runType/spec 派生池）。

### 4.6 V 评估接口

- **设计决策**
  - 谁独立验证：MVP 用**确定性断言**（测试 + agents:lint）；`confidence`/`evidence`/`contractViolation` 作为主 Agent 的采信依据。
  - **生成者与评估者分离**：子 Agent 产出结论，主 Agent 汇总核验（不同调用、不同上下文）；子 Agent 看不到彼此的推理。
  - 统计口径不采信模型自报：`toOrchestrationReport` 用 Runtime 实测的 `subtasks` 覆盖模型填的值，并在有失败时自动补 `unresolved`。
  - 工具回执 ≠ 业务事实：子 Agent 结论要求 `evidence`（文件:行号 / URL），`findings` 且 `confidence=high` 时无证据会被工具直接拒绝（`EVIDENCE_REQUIRED`）。
  - 未做：独立模型裁判、跨子任务交叉验证的自动化（列入未知区）。
- **落地规格**：`AgentRuntime.toOrchestrationReport/summarizeSubtasks`；`submitFinding` 业务校验；`tests/22_orchestrator.test.ts`。

---

## 5. 模型组合与任务分派

- **形态判定**：**C（多智能体）**，因为通过了编排决策卡门禁（§6）。
  - 显式质疑记录："能否用单 Agent + 循环内多档模型替代？" → **部分能**：清点/定位类「专业化」确实可用单 Agent + `dir_stats` 实现（这正是 misc 的现状）；"多目录 × 多审计维度"的组合，单 Agent 也能靠 `executeTools` 的**工具级并发**（`MAX_TOOL_CONCURRENCY`，默认 4）并行取数，**所以命中的不是"串行执行"这面墙**。
  - 真正命中是**上下文上限这面墙**：每个分区的处理不是一次工具调用，而是「读 → 判断 → 再读 → 核验」的**多轮语义闭环**，工具级并发解决不了；各分区结果还会持续堆进同一个上下文（"5 个分区的报告"很容易吃掉几十 k token），越到后面越贵越差。多 Agent 把每个分区的闭环放进了独立上下文，主 Agent 只接收裁剪后的简报——这才是分区的收益来源。
  - 结论：对**可扇出**任务放行多 Agent；对不可扇出任务仍走单 Agent（`classifyTask` 给出 codebase/misc）。
- **任务-模型分派表**

| 步骤 | 档位 | 理由 | 成本/延迟预算 |
|---|---|---|---|
| 任务分流（选谁做） | 确定性代码 | 关键词规则，零 token、可解释、可单测 | 0 |
| 预筛候选子任务 | 确定性代码 | 按目录/来源分区，零 token | 0（`pickTopLevelDirs` 仅 stat） |
| 主 Agent 拆分/汇总 | 强力 LLM | 开放推理 + 跨子任务裁决 | `ORCH_MAX_STEPS=8` / `ORCH_TOKEN_BUDGET=200k` |
| 子 Agent 执行 | 快速低价 LLM（按 spec 分档） | 子任务边界明确、容错空间大 | 每 spec 独立预算（4~8 步 / 30k~80k tokens） |
| 结果核验 | 模型 + 确定性规则混合 | 证据缺失/低置信由规则提示，最终由主 Agent 判断 | 计入主 Agent 预算 |

- **token 预算按档位分配**：主 Agent 200k（可调）；子 Agent 预算**独立计提**（不进主 Agent 预算），单次上限 30k~80k；评估/核验成本计入主 Agent 预算（不隐式外挂）。
- **缓存与重算账**：子 Agent 系统提示按 spec 模板生成（稳定）；工具表固定序；`agents/*.md` 渲染确定性。**重写触发点**：切换 spec / 改 `spec.tools` 顺序 / 改提示词模板 → 该 spec 的前缀全部失效。观测口径：`usage.cachedPromptTokens / promptTokens`。
  **实测来源（可复现）**：`npm run smoke:llm`（2026-10-13，真实 DeepSeek `deepseek-flash`，单 Agent 4 次模型调用）→ `promptTokens 3430 / cachedPromptTokens 2432 = 70.9%`，明细见 `docs/LLM_CONFIG.md` §5.5。**注意**：该数字来自**单 Agent 的**多轮工具调用，用于说明"前缀稳定 → 缓存命中"这一机制；多 Agent 下的命中率未单独实测（见 §15 未知区 7）。
- **级联升级条件**：MVP 未自动升级；触发条件（默认假设）：子任务 `confidence=low` 或 `contractViolation` → 主 Agent 应再派一次交叉验证（提示词第 5 条要求），或 `escalateTo` 升级。
  **前置条件（必须声明）**：`confidence` 是**模型自报**，未经标定/校准（知识库明确警告：未校准的概率当门控阈值用 = 用噪声做决策）。因此本设计把它定位为**软提示**，只用于"触发复核/标注不确定"，**不做硬门控**（不因 `confidence=high` 就跳过核验）。若将来要做硬门控，须先建立校准与升级率监控。
- **降级链**：DeepSeek 不可用 → 切 `deepseek-v4-pro` → 切其它预设（openai/qwen/moonshot/zhipu）→ 退回 Mock（明确标注为模拟，不冒充真实）。
- **评估者档位**：MVP 无独立评估者；若启用，须为**独立上下文的强档模型**且不看子 Agent 的推理过程（仅产物 + 执行记录）。

---

## 6. 多 Agent 编排（决策卡逐项）

| 步 | 结论 |
|---|---|
| 1 是否真的需要 | 需要（对可扇出任务）：子任务零依赖 + 并行收益 > 协调成本；不可扇出任务仍走单 Agent。已做「单 Agent + 多档模型」替代性质疑（§5） |
| 2 拓扑 | **中心化调度 + 扇出-扇入**（主 Agent 独占拆分/汇总；子 Agent 互不可见） |
| 3 委派契约 | `{specId, objective, inputs, boundary, expectedOutput}` → 返回 `SubtaskOutcome{status, report{summary,items,findings,evidence,confidence,escalateTo}, usage, durationMs, truncatedFields, contractViolation}` |
| 4 隔离边界 | 独立上下文（独立 messages）、独立预算、独立权限（= spec.permissions）；**隔离上下文 ≠ 隔离权限**，两者都做 |
| 4.5 模型档位 | 主 Agent 强档；子 Agent 按 spec（清点类 `thinking=disabled`、分析类 `effort=low`）；升级条件见 §5 |
| 5 加熔断 | 宽度 ≤4（`WIDTH_LIMIT`）、深度 ≤1（无派发能力）、子任务超时/步数/token 上限、失败转结果不抛出、父取消级联 |
| 6 反模式自查 | 共享可变状态：无（结果经批次回调一次性记录）；无界扇出：无（结构层封顶）；过度分解：预筛 + 提示词"宁少勿滥"；子结论未经核验直接采信：**已防**（evidence 强制 + Runtime 统计覆盖 + unresolved 自动补） |

**委派结论采信规则（已落地）**：子 Agent 的结论是「待采纳」；`contractViolation` / `confidence=low` / 缺 `evidence` 时不得直接采信——提示词第 5 条要求主 Agent 标注不确定或再派一次。

---

## 7. 模块 / 目录结构

```
src/agents/
  specs.ts            # 子 Agent 契约（唯一事实来源）+ validateSpecs 自校验 + 子任务上报 schema
  renderDocs.ts       # 契约 → 人读文档（确定性渲染，供 docs/lint 复用）
src/runtime/
  preSplit.ts         # 规则式预筛（按目录/主题切候选子任务，零 token）
  SubAgentPool.ts     # 有界并发池 + 级联取消 + 部分失败转结果 + effectiveConcurrency
  subAgentLoop.ts     # 子 Agent 独立循环（隔离上下文/预算/权限 + 终结性上报）
  AgentRuntime.ts     # 编排接线：工具池/权限/预算、spawnSubAgent、批次记录、汇总归一化、编排提示词
src/tools/orchestrator/
  delegateSubtasks.ts   # 主 Agent 扇出（三道守卫 + 上下文裁剪 + 批次回调）
  submitOrchestration.ts# 主 Agent 汇总上报（终结性；冲突/未解决强制）
  submitFinding.ts      # 子 Agent 结构化上报（终结性；证据与置信度业务校验）
agents/                # 【生成物】AGENTS.md + <id>.agent.md（由 npm run agents:docs 生成）
scripts/
  gen-agent-docs.ts   # 生成契约文档
  agents-lint.ts      # 契约一致性门禁（自校验 + 文档漂移 + 工具存在性）
tests/
  22_orchestrator.test.ts   # 22a~22r：预筛/契约/守卫/并行/部分失败/契约未履行/取消/trace/HTTP
  23_agent_contracts.test.ts# 23a~23g：文档确定性、九节覆盖、漂移门禁、无秘密
```

---

## 8. 关键接口签名

### 8.1 数据源接口（契约与预筛）

```ts
// src/agents/specs.ts
export interface SubAgentSpec {
  id: string; title: string; responsibilities: string; notDo: string[];
  tools: string[]; permissions: string[]; maxRiskLevel: RiskLevel;
  budget: { maxSteps: number; maxModelCalls: number; maxToolCalls: number; tokenBudget: number; totalTimeoutMs: number };
  modelParams?: LLMGenerationParams;
  requiredInputs?: string[]; escalateTo: string[]; examples: string[];
}
export function getSpec(id: string): SubAgentSpec | undefined;
export function validateSpecs(
  specs: SubAgentSpec[], toolPermission: Record<string, string>, registeredTools: string[], opts?: { maxStepsHardLimit?: number },
): SpecIssue[];   // SpecIssue = { specId: string; level: 'error'|'warn'; message: string }

// src/runtime/preSplit.ts
export function pickTopLevelDirs(repoPath: string, limit?: number): string[];
export function extractTopics(goal: string, limit?: number): string[];
export function preSplitSubtasks(goal: string, opts: { dirs?: string[]; topics?: string[]; maxWidth?: number }): SubtaskRequest[];
```

### 8.2 工具接口

```ts
// 主 Agent 扇出
delegate_subtasks({ subtasks: { specId: string; objective: string; inputs?: Record<string,string>;
                                boundary?: string; expectedOutput?: string }[] })
  → ToolResult<{ requested: number; ok: number; failed: number; cancelled: number; limitReached: number;
                 subtasks: SubtaskOutcome[]; duplicateObjectives?: string[]; note: string }>

// 主 Agent 汇总（终结性）
submit_orchestration({ summary: string;
  findings?: { from: string; note: string; path?: string }[];
  conflicts?: { between: string[]; topic: string; resolution: string }[];
  unresolved?: string[]; escalateTo?: 'codebase'|'research'|'misc'|'human'; escalateReason?: string })
  → ToolResult<{ submitted: true } & 上述字段>

// 子 Agent 上报（终结性）
submit_finding({ summary: string;
  items?: { label: string; value: string|number; detail?: string }[];
  findings?: { path: string; note: string }[]; evidence?: string[];
  confidence?: 'high'|'medium'|'low';
  escalateTo?: 'codebase'|'research'|'misc'|'orchestrator'|'human'; escalateReason?: string;
  artifacts?: { label: string; content: string }[] })
  → ToolResult<{ submitted: true } & 上述字段>
```

### 8.3 钩子 / 注入接口

```ts
// src/tools/types.ts — Runtime 注入给工具的能力（子 Agent 上下文不注入前两个）
export type SpawnSubAgent = (req: SubtaskRequest) => Promise<SubtaskOutcome>;
export interface ToolContext {
  // ...既有字段
  spawnSubAgent?: SpawnSubAgent;                       // 仅主 Agent 有 → 深度 ≤ 1
  onSubtasksDelegated?: (outcomes: SubtaskOutcome[]) => void;  // 批次回调：按派发顺序记录
  depth?: number; allowedSpecs?: string[];
}

// src/runtime/SubAgentPool.ts
export class SubAgentPool {
  constructor(defaultConcurrency?: number);
  map<T, R>(items: T[], worker: (item: T, index: number) => Promise<R>, opts: {
    concurrency: number; signal?: AbortSignal;
    abortedResult: (item: unknown, index: number) => R;
    errorResult?: (item: unknown, index: number, error: Error) => R;
  }): Promise<R[]>;   // 结果顺序 = 入参顺序
}
export function effectiveConcurrency(opts: { taskCount: number; maxConcurrency: number;
  remainingTokenBudget?: number; perTaskTokenBudget: number }): { concurrency: number; reason: string };

// src/runtime/subAgentLoop.ts
export function runSubAgent(params: SubAgentRunParams): Promise<SubtaskOutcome>;  // 永不抛（除父取消）
export function buildSubAgentPrompt(spec: SubAgentSpec, req: SubtaskRequest): string;
export function toSubtaskReport(data: unknown): SubtaskReport;
```

---

## 9. 核心数据结构

### 9.1 状态结构（持久化）

```ts
// runs.resultJson（信封，src/store/resultJson.ts）
interface RunResultPayload {
  v?: 1;
  misc?: MiscReport;                     // mic 任务
  orchestration?: OrchestrationReport;   // 编排任务
  subtasks?: SubtaskOutcome[];           // 编排任务派发过的子任务（按派发顺序）
}
interface OrchestrationReport {
  summary: string;
  findings?: { from: string; note: string; path?: string }[];
  conflicts?: { between: string[]; topic: string; resolution: string }[];
  unresolved?: string[];
  subtasks?: { total: number; ok: number; failed: number; cancelled: number; ids: string[] }; // Runtime 统计覆盖
  escalateTo?: 'codebase'|'research'|'misc'|'human'; escalateReason?: string;
  structured: boolean;                   // false = 主 Agent 未调用 submit_orchestration
}
```

### 9.2 消息 / 任务结构

```ts
interface SubtaskRequest { specId: string; objective: string; boundary?: string; inputs?: Record<string,string>; expectedOutput?: string }
interface SubtaskOutcome {
  subtaskId: string; specId: string; specTitle: string; objective: string;
  status: 'ok'|'failed'|'cancelled'|'limit_reached';
  report?: SubtaskReport; failureReason?: string; errorCode?: string; triggeredLimit?: string;
  steps: number; modelCalls: number; toolCalls: number; durationMs: number; usage: TokenUsage;
  truncatedFields?: string[];            // 被裁剪的字段（提示"没看全"）
  contractViolation?: string;            // 未按契约上报（自由文本兜底）
}
interface SubtaskReport {
  summary: string; items?: {label:string;value:string|number;detail?:string}[];
  findings?: {path:string;note:string}[]; evidence?: string[];
  confidence?: 'high'|'medium'|'low';
  escalateTo?: 'codebase'|'research'|'misc'|'orchestrator'|'human'; escalateReason?: string;
  artifacts?: {label:string;content:string}[]; structured: boolean;
}
```

### 9.3 配置结构

```ts
interface RuntimeConfig {
  subagent: { maxConcurrency: number; maxWidth: number; maxDepth: number; resultChars: number };
  orchestrator: { maxSteps: number; maxModelCalls: number; maxToolCalls: number;
                  tokenBudget: number; totalTimeoutMs: number; allowSelfTools: boolean };
  // ...既有字段
}
interface RunInput { /* ...既有 */ orchestration?: {
  maxWidth?: number; allowedSpecs?: string[]; allowSelfTools?: boolean; suggestedSubtasks?: SubtaskRequest[];
} }
```

---

## 10. 配置文件格式（环境变量 + 请求示例）

```bash
# .env（进程级默认）
SUBAGENT_MAX_CONCURRENCY=4   # 子任务并发上限（有界池）
SUBAGENT_MAX_WIDTH=4         # 单次派发子任务数上限（请求只能收紧）
SUBAGENT_MAX_DEPTH=1         # MVP 固定 1：子 Agent 不能再委派
SUBAGENT_RESULT_CHARS=800    # 单个子任务结果回传主 Agent 的字符上限
ORCH_MAX_STEPS=8             # 主 Agent 步数上限
ORCH_MAX_MODEL_CALLS=12
ORCH_MAX_TOOL_CALLS=12
ORCH_TOKEN_BUDGET=200000     # 主 Agent 预算（子 Agent 预算另计）
ORCH_TOTAL_TIMEOUT_MS=300000
ORCH_ALLOW_SELF_TOOLS=false  # 主 Agent 默认只委派+汇总
```

```jsonc
// POST /api/runs
{
  "runType": "orchestrator",
  "goal": "清点并审计这个仓库：src 与 test 目录有多少文件，有没有 TODO/可疑硬编码？",
  "repoPath": "demo/codebase-sample",          // 必填：子 Agent 的只读边界
  "orchestration": {
    "maxWidth": 4,
    "allowedSpecs": ["dir-inventory", "code-audit"],  // 留空 = 全部可用
    "allowSelfTools": false
    // suggestedSubtasks 由服务端规则式预筛生成（也可只读参考，不强制采纳）
  },
  "stream": { "liveDeltas": true }
}
```

---

## 11. 层间交叉检查

| 关系 | 说明 |
|---|---|
| E ↔ T | 主 Agent 的工具池就是「委派 + 汇总」；子 Agent 的工具池来自 spec —— **执行循环的能力面由工具注册决定**，不是提示词 |
| T ↔ L | 披露（`toDefinitionsFor`）与授权（`allowedPermissions`）分离，安全边界不依赖 prompt |
| E ↔ C | 子任务结果必须裁剪后才进主 Agent 上下文（`resultChars`），否则并行越多、主 Agent 越早爆上下文 |
| S ↔ V | 子任务事件入 `events` 表（`spanId/parentId`）→ 前端可见 → 人工可核验；结构化结果存 `resultJson` 信封 |
| L ↔ V | 每次越权/超宽/超限都被记录为带错误码的工具结果，成为可复现的验收证据 |
| C ↔ 成本 | 前缀稳定（spec 模板 + 固定工具序）→ 缓存命中 → 子 Agent 成本显著下降（实测 71%） |

---

## 12. 六层决策表

| 层 | 决策 | 依据 | 状态 |
|---|---|---|---|
| E 执行循环 | 中心化扇出-扇入；子 Agent 走独立短循环；终结性工具收尾；有界并发 + 级联取消 | 决策卡步 1/2/5；知识库 Actor 模型与有界并发 | 已确认（AskUserQuestion ①③） |
| T 工具注册 | 注册/披露/授权三分离；深度靠「不注入能力」而非提示词 | 知识库 Capability Security；生产清单 T 层 | 已确认 |
| C 上下文 | 子 Agent 独立上下文；回传裁剪 800 字符/字段；artifacts 不回传；前缀稳定（稳定区=spec 模板提示+固定序工具表；可变区=objective/工具结果） | 生产清单 C 层（前缀稳定与重写失效预算的唯一定义处）；缓存收益实测见 §5 | 已确认 |
| S 状态 | 主任务复用既有表；结构化结果入 resultJson 信封；子任务事件入 events | 既有基建；MVP 决策（不建 subtasks 表） | 默认假设 |
| L 生命周期 | 四道守卫（宽度/深度/规格/预算）+ 既有 Registry 边界；只读免审批 | 生产清单 L 层；项目既有只读边界 | 已确认 |
| V 评估 | 确定性断言为主；evidence/confidence/contractViolation 作为采信门槛；统计口径以 Runtime 为准 | 验证强度阶梯第一档；生产清单 V 层 | 已确认 |

---

## 13. 生产级必答项

| # | 必答项 | 结论 |
|---|---|---|
| 1 | 执行环境：工具在哪跑、凭证是否进执行环境 | 本机进程内；只读文件 I/O；**凭证不进子 Agent 上下文**（Provider/Key 由 Runtime 持有，子 Agent 只拿 objective+inputs） |
| 2 | 错误回喂：失败如何作为观察回上下文、如何分类恢复 | 工具错误成对入 `role:tool` 观察；子任务失败转 `SubtaskOutcome.status`（`EMPTY_RESULT/WIDTH_LIMIT/UNKNOWN_SPEC/PERMISSION_DENIED/LIMIT_*`）；由主 Agent 决定重派或标注 |
| 3 | 打转检测与熔断 | 已有：步数/模型/工具/token/超时五道 + 宽度深度守卫；未做：同参指纹打转检测（见 §15） |
| 4 | 记忆治理：可信度、归属、失效条件 | 无长期记忆写入；子任务结论带 `confidence`/`evidence`，`from` 标注归属；不写入跨会话记忆 |
| 5 | 外部副作用幂等 | **N/A**：全部工具只读，无外部副作用；取消无需补偿（设计上的免费红利） |
| 6 | 证据版本绑定 | `evidence` 记录「文件:行号」，但**未绑定内容哈希**（版本变更后旧结论不会自动失效）→ 见 §15 未知区 |
| 7 | 生成者与评估者分离 | 子 Agent（生成）与主 Agent（汇总裁决）上下文分离；缺证据/低置信被强制标注；**未启用独立模型裁判** |
| 8 | 前缀稳定与缓存命中 | 稳定区 = spec 模板提示 + 固定序工具表 + 确定性渲染；可变区 = objective/inputs/工具结果；重写触发点：改 spec 模板/工具顺序；观测口径：`cachedPromptTokens/promptTokens`（实测 71%） |

---

## 14. 参考架构图

```
                          ┌──────────────────────────────────────────┐
   用户目标 + repoPath ──► │ Runtime：预算/权限/事件/trace/SSE 强制层  │
                          └───────────────────┬──────────────────────┘
                                              │
                            ┌─────────────────▼──────────────────┐
                            │ 主 Agent（orchestrator 工具池）      │
                            │ 工具：delegate_subtasks             │
                            │       submit_orchestration(终结性)  │
                            │ 提示词：拆分判据 + 委派四要素 +       │
                            │         采信规则 + 汇总纪律          │
                            └───────┬─────────────────────────────┘
                                    │ ① 预筛建议（规则式，零 token）
                                    │ ② delegate_subtasks（宽度≤4）
                    ┌───────────────┼────────────────┐  ← SubAgentPool（有界并发 + 级联取消）
                    ▼               ▼                ▼
        ┌──────────────────┐ ┌──────────────┐ ┌──────────────────┐
        │ dir-inventory    │ │ code-audit   │ │ doc-research     │  ← 各自独立：上下文/预算/权限
        │ dir_stats        │ │ search_files │ │ web_search       │     看不到彼此与主 Agent 历史
        │ +submit_finding  │ │ +submit_finding│ │ +submit_finding │     无法再委派（深=1）
        └────────┬─────────┘ └──────┬───────┘ └────────┬─────────┘
                 └──────────────────┼──────────────────┘
                                    │ ③ 结构化简报（裁剪 + evidence + confidence）
                                    ▼
                            ┌──────────────────────────────────────┐
                            │ 主 Agent 汇总核验                     │
                            │ · 统计口径以 Runtime 为准（覆盖自报）  │
                            │ · 失败/取消 → 自动补 unresolved        │
                            │ · 冲突必须写 conflicts                │
                            └──────────────┬───────────────────────┘
                                           ▼
                         OrchestrationReport（runs.resultJson 信封）
                         + subtask span 树（events 表 → 流程图/瀑布图）
```

---

## 14.5 可编码三门槛（逐条自证）

| 门槛 | 自证 |
|---|---|
| **类型完整** | 本文出现的每个自定义类型都在 §9 给出字段定义（`TokenUsage` 与既有 `MiscReport` 属项目既有类型，定义在 `src/types.ts`，不在本文重复）：`SubAgentSpec`(§8.1)、`SubtaskRequest/SubtaskOutcome/SubtaskReport/OrchestrationReport`(§9.2/9.1)、`RunResultPayload`(§9.1)、`RuntimeConfig.subagent/orchestrator`(§9.3)、`SpawnSubAgent`/`ToolContext` 扩展(§8.3)。无"只出现名字不给定义"的类型。 |
| **API 真实** | 所有被调用的 API 均为本仓库已存在或本次已实现并通过测试的：`better-sqlite3` 的 `PRAGMA table_info` / `ALTER TABLE ADD COLUMN`（`SqliteStore.migrate`）、`express` 路由、`zod` 的 `safeParse/enum/record`、Node 内置 `readdirSync/lstatSync/statSync/AbortController/performance.now`。**未虚构任何框架参数或方法**；实现已通过 `tsc --noEmit` 与 124 项测试。 |
| **标准可达** | ① "0 error 契约校验"→ `validateSpecs` 返回值为确定性断言（`npm run agents:lint` 与测试 22c 均可复现）；② "墙钟降低 ≥40%"→ 用 `Tracer` 的 span 数据按"串行基线 vs 并行实现"两条真实运行对比（当前未产出对比数字，标注为待测）；③ "越权被拒"→ 测试 22d/22e/22f 断言具体错误码。每条标准都给出了可执行的验证路径，而非口号。 |

## 15. 遗留问题与未知区

1. **两套循环并存**：主 Agent 用 `loopBody`（含状态机/检查点/恢复），子 Agent 用精简的 `subAgentLoop`（无重试、无检查点、不可恢复）。代价是重复代码；合并路径 = 抽 `runAgentLoop(config)` 共用节点逻辑（占位方案：保持现状并在文件头注明）。
2. **子任务不独立落库**：只存 `runs.resultJson` + events。若要做「跨 run 查询某个 spec 的历史成功率」，需加 `subtasks` 表（列：`subtaskId, runId, specId, status, durationMs, usageJson, resultJson`）。占位方案：先靠 events 聚合。
3. **深度固定为 1**：子 Agent 不能再委派。要支持层级编排需引入「子编排器」spec 与深度透传，并重新评估成本与守卫。
4. **无独立模型裁判**：V 层目前是确定性断言 + 提示词约束。启用条件：需要为「汇总质量」给出自动评分时；实施要求：独立上下文、不看子 Agent 推理、显式评分标准、迭代预算。
5. **证据未绑定版本**：`evidence` 是「文件:行号」字符串，文件改了不会自动失效。占位方案：在 evidence 里加 `path:line@mtime` 或内容哈希（需同步改 `submit_finding` schema 与汇总渲染）。
6. **未做打转检测与自动升级**：无「N 次同参指纹」检测；`confidence=low` 后的二次派发依赖主 Agent 自觉（提示词要求），未在 Runtime 强制。占位方案：在 `recordSubtaskBatch` 里统计同 spec 重复派发次数并在超过阈值时警告。
7. **`ORCH_ALLOW_SELF_TOOLS=true` 的边界**：给了主 Agent 只读工具后，它可能"自己动手"绕过委派，削弱并行收益。默认关闭；打开时建议同时在提示词里限制用途（当前提示词已说明"默认只委派+汇总"）。
8. **多 Agent 下的缓存命中率未实测**：§5 的 70.9% 来自单 Agent 多轮调用；多 Agent 场景下每个 spec 的前缀独立，命中率需分别观测（观测口径已给出，数据待补）。
9. **`confidence` 未做标定**：见 §5 的前置条件说明——当前是软提示。要做硬门控，需要标定与升级率监控。
10. **跨进程/远程子 Agent 未实现**：`SpawnSubAgent` 是可替换接口，但跨进程需要序列化契约、状态同步与鉴权，属下一阶段。

---

## 16. 独立评审回修记录（1 轮）

> 评审者：**独立上下文的子智能体**（未见设计过程推理，只读产物 + 知识库 + 代码）。
> 判定标准四要素：独立上下文 / 不看执行者推理 / 显式标准 / 迭代预算（存疑项最多回修 1 轮）。

| # | 评审发现 | 判定 | 处理 |
|---|---|---|---|
| 1 | "实测 71% 缓存命中"没有给出来源，且与 `presets.ts` 里"真实 Provider 未验证"的注释冲突 | 存疑（来源支撑性） | **两处都修**：① 设计文档 §5 补上可复现来源（`npm run smoke:llm` 2026-10-13，3430/2432）并注明"来自单 Agent 多轮调用"；② `presets.ts` 注释改为"DeepSeek 已端到端验证，其余未实测"（原注释已过时） |
| 2 | §12 把"缓存/前缀稳定"归因到知识库 Model Cascade —— 张冠李戴（Model Cascade 讲的是模型分档与级联升级，不是缓存） | 存疑（对照贴切性） | 改为引用 production-checklist **C 层**（前缀稳定与重写失效预算的唯一定义处） |
| 3 | §5 说多分区"必然是串行的"→ 命中"串行执行"墙 —— 论据落错：本项目 `executeTools` 本来就做工具级并发（默认 4） | 存疑（权衡成立性） | 论据**重写**：明确"工具级并发解决不了多轮语义闭环"，真正命中的是**上下文上限**墙（每分区需独立闭环 + 结果持续堆进同一上下文）；并在 §12 同步说明收益来源 |
| 4 | 宽度≤4 与成功标准②（墙钟降 ≥40%）存在张力：分区数 >4 要分批，收益递减，原文未交代 | 存疑（成本量级一致性） | 成功标准②补上适用范围「分区数 ≤ 宽度上限」，并写明"分批是 `SUBAGENT_MAX_WIDTH` 的直接代价" |
| 5 | §14.5 "类型完整"自证偏强：`TokenUsage` / `MiscReport` 未在本文定义 | 存疑（类型完整性） | 明确标注二者属项目既有类型、定义在 `src/types.ts`，本文不重复 |
| — | §5 用 `confidence` 做升级触发，但 `confidence` 是模型自报、未标定（知识库警告：未校准概率当门控 = 用噪声决策） | 评审未提，自查发现 | 补「前置条件」说明：定位为**软提示**、不做硬门控；将来要硬门控须先标定 + 监控升级率；并列入 §15 未知区 9 |

**证据不足项**：① 模型 token 占比（70%/30%）无知识库对照物 → 已标注"预估"；② 多 Agent 下的缓存命中率未实测 → 列入未知区 8。
**未采纳**：无。**复审**：全部为文档级回修，未引入新的结构变更，按迭代预算不再发起第二轮评审；未抽到的项由「可编码三门槛 + 六层自查 + 124 项测试 + `agents:lint`」兜底。
