# 错误报告与故障排查（ERROR_REPORTING）

> 本文分两部分：**一、真实事故复盘（2 例，含逐条根因与修复验证）**；**二、错误检测与报告机制**（怎么用、去哪查、每个错误码怎么处理）。

---

## 一、事故复盘（2 例）

> 案例 1（2026-10-13，§1.1–1.3）：多 Agent「无法正常运行」——参数/路径/预算/状态口径一类。
> 案例 2（2026-10-20，§1.4）：上下文压缩切坏消息序列 → 400「孤儿 tool」，并暴露「模型失败没有进错误报告」的覆盖缺口。
> 案例 3（2026-10-20，§1.5）：run 已 `completed`、僵尸子任务还在跑——表现为「卡死几分钟」+ 事件序号重号。

### 1.1 现象

用真实模型（DeepSeek）跑多 Agent 编排任务，界面显示 `completed`，但**结论不可用**：一次运行里 6 个子任务只有 1 个成功，其余 `limit_reached` / `EMPTY_RESULT`；另一次是**单独跑 codebase 任务时被 `超过 Token 预算 50000` 打断**。

原始证据（`data/errors.log` 与事件流）：

```
subtasks: 6
  · [limit_reached] dir-inventory   err=maxToolCalls  子任务达到最大工具调用数 6
  · [limit_reached] dir-inventory   err=maxToolCalls
  · [ok]            code-audit
  · [limit_reached] dir-inventory   err=maxSteps      子任务达到最大步骤数 4
  · [limit_reached] dir-inventory   err=maxSteps
  · [failed]        code-audit      err=EMPTY_RESULT
失败事件: tool_failed:INVALID_ARGS ×11 | tool_failed:NOT_FOUND ×4 | subtask_failed ×5
```

### 1.2 根因（逐条，全部有可复现证据）

| # | 根因 | 证据 | 影响 |
|---|---|---|---|
| **R1** | **工具只认一种参数名**：`search_files` 只认 `pattern`，模型写 `query`/`keyword` → `INVALID_ARGS`；`read_file` 只认 `path`，模型写 `file` → `INVALID_ARGS` | 离线诊断：`search_files {query:'TODO'}` → `pattern: Required` | 一次运行 **11 次**无效调用，吃光子 Agent 步数预算 |
| **R2** | **参数名不符被静默忽略**：`list_files`/`dir_stats` 只认 `dir`，模型写 `path` 时 Zod 直接丢弃（`dir` 有默认值 `.`）→ **悄悄地统计了整个仓库** | `dir_stats {path:'src'}` → 返回 `files=5`（应为 `2`） | **静默错误结果**——比报错更危险（结论是错的却看不出来） |
| **R3** | **路径只认"相对仓库根"**：模型给的 `demo/codebase-sample/src`（工作区相对）→ `NOT_FOUND`；绝对路径 → 拼接后 `PATH_ESCAPE` | `dir_stats {dir:'demo/codebase-sample/src'}` → `NOT_FOUND` | 4 次 `NOT_FOUND`，模型反复换写法重试 |
| **R4** | **输出结构过严**：模型习惯把数组元素写成**字符串**（`findings: ["src/a.ts:1 无异常"]`），而 schema 要对象 → 提交结论时被反复打回 | `submit_finding: findings.0: Expected object, received string` | 9 次无效调用，甚至可能提交不上结论 |
| **R5** | **子 Agent 预算按 Mock 剧本设定**：`dir-inventory` 只有 4 步 / 6 次工具调用，真实模型的实际路径是"list_files → dir_stats → 抽查文件 → 再确认" | 实测 4 步必然触顶 | 子任务大面积 `limit_reached` |
| **R6** | **主 Agent 盲目重派**：同一 `objective` 换个批次又派一次，又全部失败 | 事件流两批同 objective 子任务 | 成本翻倍（70s / 5 万 tokens）仍拿不到数据 |
| **R7** | **前端预算被 misc 默认值污染**：选过一次「杂项 Agent」后，`maxSteps/maxModelCalls/maxToolCalls/tokenBudget` 被收紧为 6/6/10/**50000** 且**不再恢复** | 真实 codebase run 报 `超过 Token 预算 50000`（默认应是 200000） | 任何任务（含多 Agent）都会在 5 万 token 处被腰斩 |
| **R8** | **任务级状态掩盖局部失败**：6 个子任务只成 1 个，但状态是 `completed` | 界面只有"completed" | 用户误判为成功 |

### 1.3 修复与验证

| 根因 | 修复 | 位置 |
|---|---|---|
| R1 | 参数**别名**：`pattern\|query\|keyword`、`path\|file\|filename\|filepath`、`dir\|path`；全缺时给 `MISSING_ARGS` + 示例 | `searchFiles.ts` / `readFile.ts` / `listFiles.ts` / `dirStats.ts` |
| R2 | 别名**显式接受**（不再静默丢弃），消除"统计错目录"的静默错误 | 同上 |
| R3 | 统一路径解析 `resolveWorkspacePath()`：相对仓库根 / `./` / **工作区相对** / 绝对（须在仓库内），失败时**列出仓库内可用条目** | `src/tools/shared/workspacePath.ts` |
| R4 | 输出结构宽容化：数组元素接受字符串并归一化（`"文件数: 3"`→`{label,value}`；`"src/a.js:1 说明"`→`{path,note}`）；来源缺失**如实计入 unresolved** | `src/tools/shared/reportNormalize.ts` |
| R5 | 按实测放宽：dir-inventory 8 步/16 次工具，code-audit 12/24，doc-research 8/16 | `src/agents/specs.ts` |
| R6 | **重复派发守卫**：同 `specId::objective` 二次派发直接拒绝（`DUPLICATE_OBJECTIVE` + 改写建议） | `AgentRuntime.buildSpawnSubAgent` |
| R7 | 预算收紧**可恢复**：离开 misc 自动还原默认值（用户手改过的不动） | `public/index.html` |
| R8 | `OrchestrationReport.partial` + 界面红色"⚠️ 部分成功"横幅 + 状态徽标追加提示 | `types.ts` / `index.html` |
| 通用 | 参数错误信息**附正确示例**（`Tool.inputExample`） | `Registry.ts` |

**同一个真实任务的前后对比**（`deepseek-flash`，同一 goal / 同一工作区）：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 子任务 | 6（1 ok / 1 failed / 4 limit_reached） | **4（4 ok）** |
| 主 Agent 步数 | 8 | **3** |
| tokens | 50,577 | **13,784（↓73%）** |
| 墙钟 | 70.4s | **27.0s（↓62%）** |
| 失败工具调用 | 22 | **4**（且 3 条是模型猜错文件名、1 条是首次形状写错，均已自愈） |
| 汇总中的来源标注 | — | 未标注来源的 findings 被自动计入 `unresolved` |

> 剩余 4 次失败**不再影响结果**：模型在提示与示例的引导下第二次就改对了。这属于"可自愈噪音"，与修复前的"预算耗尽、任务失败"是本质区别。

### 1.4 事故复盘二：上下文压缩切坏消息序列 → 400「孤儿 tool」（2026-10-20）

**现象**：真实模型 orchestrator run（`run_mvge1343_49a18777`）跑到第 16 步直接 `failed`，界面错误卡片：

```
模型调用失败: OpenAIProvider(流式) 返回 400:
{"error":{"message":"Messages with role 'tool' must be a response to a preceding message
with 'tool_calls'","type":"invalid_request_error"}}
```

已消耗 15 步 / 27 次工具调用 / 13 万 prompt tokens，全部作废。

**证据**（全部可从 `data/runtime.db` 复算，不是推测）：

| 观察 | 数据 |
|---|---|
| 消息数突降 = 压缩触发 | `model_request.inputs.messageCount`：step13 **54** → step14 **12** → step15 12 → step16 12（失败）；`promptTokens 130,380 / 预算 200,000` ≥ `COMPACT_TRIGGER_RATIO 0.6` |
| 坏请求体原文 | step15 的 `checkpoints.messagesJson`（12 条）角色序列 = `s, u(摘要), t, u, a[2], t, t, u, a[2], t, t, u` |
| 孤儿在哪 | 第 2 条 `role:"tool"`（`toolCallId=call_01_ET_cotPRZNhP58ocosYYrqN4397`）前面没有对应的 `assistant.tool_calls` |

**为什么第 15 步没炸、第 16 步才炸**：压缩发生在「本轮模型返回之后、assistant/tool 入队之前」，所以坏的序列由**上一步**产出、**下一步**才发出去。

**根因**：`compactMessages()` 按固定条数硬切（`keepFrom = messages.length - COMPACT_KEEP_TAIL`，即保留最近 6 条）。真实 run 每轮是「assistant(tool_calls×2) + tool + tool + 边界提示」，这 6 条尾巴正好切在一组工具的**中间**：assistant 被压进摘要，第二条 tool 结果留在尾部 —— 尾部首条业务消息就是孤儿 tool。

OpenAI 兼容协议要求每条 `tool` 必须应答某个 `tool_calls`，DeepSeek 对此 fail-fast 400；`isRetryableProviderError()` 判定 4xx 不可重试（这个判断是对的：请求本身有问题，重发只会再错）。

**为什么之前没抓到**：`tests/33` 只构造纯 `user/assistant` 的假消息，从未覆盖「一轮多工具调用」这种形状。

**修复与验证**：

| 项 | 内容 |
|---|---|
| 切点对齐 | 新增 `alignCompactCut()`：切点必须落在**轮次边界**——遇 `role:"tool"` 向后推（丢掉的是被摘要那一轮的残余结果）；尾部全是 tool（一轮工具数 ≥ 保留条数）时回退到最近一条 assistant，找不到则 no-op |
| 回归守卫 | `tests/33e`（复刻故障形态：切点落在第 2 个 tool）/`33f`（一轮 8 工具）/`33g`（10 种轮次形状 × 有无 goal 的完整协议校验） |
| **错误报告补齐** | 此前模型调用失败**只**写一条 `run_failed` 事件，`/api/errors` 与 `data/errors.log` 都查不到（这次只能手工翻 events）。现已补 `source:"provider"` 报告，context 带 `step / messageCount / toolCount / contextUseRatio / status`，并把「孤儿 tool」识别成 `suspect:"invalid_message_sequence"`；回归 `tests/24d` / `24d2` |
| 参数 | **未改**（`COMPACT_TRIGGER_RATIO=0.6` / `COMPACT_KEEP_TAIL=6` 保持原值） |

**教训**：

1. 任何「裁剪历史」的代码都要以**轮次**为单位（assistant + 它的全部 tool 结果），不能按固定条数切。
2. 协议类 400 的第一落点是 `messageCount` 有没有突降（= 压缩刚跑过），不是 Key/网络——`MODEL_ERROR` 的 hint 已按这个顺序重写。
3. 报告覆盖不全 = 排查成本翻倍：这次是「事件流里有、错误报告里没有」，只能手工 `SELECT ... FROM events` 才还原。
4. 残余质量风险 **R23**（未改行为）：水位用的是**累计** token，一旦 ≥60% 就每步都压缩，且摘要里每条消息按 200 字截断 → 3000 字旧摘要再压只剩 200 字，出现「较早 5 条」套「较早 47 条」的衰减；建议后续改滚动摘要或给压缩加迟滞。


### 1.5 事故复盘三：run 已结束，子任务还在跑（卡死几分钟 + 事件重号）（2026-10-20）

**现象**：用户反馈「最近三次运行都跑了很多轮次，然后突然失败 / 莫名其妙卡死几分钟」。其中一次（`run_mvgejh0e_3e6c9b74`）状态是 **completed**，但总耗时 **662 秒**，中途界面长时间无更新，结束后还弹出了新的审批卡。

**证据**（`data/runtime.db`，按时间线）：

| 时刻(UTC) | 事件 | 说明 |
|---|---|---|
| 08:09:24 | `subtask_started` ×2 | 派发 dir-inventory + code-edit |
| 08:11:12 | `approval_requested` | 子任务 submit_changes → 第一张审批卡 |
| 08:13:24 | `delegate_subtasks` **tool_failed** | 工具超时（`withTimeout` 只是 race 一个 reject，**底层子任务没停**） |
| 08:16:36 | `approval_requested` | 重派 → 第二张卡 |
| 08:19:53 | `delegate_subtasks` 再次超时 | 主 Agent 放弃 |
| **08:20:06** | **`run_completed`** | 主 run 已终态（seq 201） |
| 08:21:36 | `approval_decided` | 僵尸子任务的审批才因 **300s 超时**被拒 |
| 08:21:51 | `approval_requested` | 它**又提交一次、又弹一张卡** |
| 08:26:51 | `approval_decided` | 第二张卡再等 300s |
| 08:27:04 | `subtask_completed` | 子任务终于结束，但事件**从 seq=1 重写** |

该 run 的 `events` 表：**225 行 / 只有 201 个不同 seq** —— 同一 run 内出现重复序号。

**两个根因**：

1. **`finalize()` 从不 abort run 级 signal**。主循环收尾后，在飞子任务与审批等待继续活着；工具超时只结束「等待」，不结束「执行」。
2. **`EventLogger` 在 `run_completed/run_cancelled` 时清零 seq 计数**（`FORGET_SEQ_ON`）。终态后追加的事件于是从 1 重新编号，与历史事件撞号——回放、前端排序、增量拉取的 `X-Next-Cursor` 全部失真。

**修复**：

| 改动 | 位置 |
|---|---|
| 终态即取消：`finalize()` 开头 abort 该 run 的 `AbortController` | `AgentRuntime.finalize` |
| 审批响应 abort：`requestApproval` 监听 run signal，结束/取消时立即 `deny / actor:"run-finished"`，不再等 300s | `AgentRuntime.requestApproval` |
| 批次级取消：`SpawnSubAgent` 支持 `opts.signal`，`delegate_subtasks` 自管 240s 批次超时并 `abort()` 该批 | `tools/types.ts`、`delegateSubtasks.ts`、`buildSpawnSubAgent` |
| seq 不再清零：按 run 保留计数 + LRU 上限（默认 2000） | `EventLogger.rememberSeq` |

回归：`tests/57`（4 例：终态 abort / 审批立即拒绝 / seq 不重号 / 取消即拒绝）；`tests/32d6` 改为 LRU 语义。

**教训**：

1. **「终态」不只是 DB 里的一个字段**：它必须真的把工作停掉，否则会出现「任务已结束、还在花钱」。
2. 工具的 `timeout` 只负责「不再等」，不负责「让它停」——凡是有后台执行体的工具，都要显式接 `AbortSignal`。
3. 事件流的 `seq` 是回放/增量/排序的主键，**任何情况下都不能回退**；需要防泄漏就用 LRU，不要清零。
4. **改完代码要重启服务**：`npm start` 无热重载。事故当天 16:25 的 400 复现，就是进程仍跑着 15:44 加载的旧代码。

---

## 二、错误检测与报告机制

### 2.1 一条错误报告的形态（四要素齐全）

```json
{
  "id": "err_3f9a1c2d",
  "at": "2026-10-13T04:31:22.114Z",
  "source": "tool",
  "phase": "dir_stats",
  "errorType": "Error",
  "code": "NOT_FOUND",
  "message": "路径不存在：demo/codebase-sample/src。仓库根下的可用条目（前 4 个）: README.md, package.json, src, test。请传「相对仓库根的路径」，例如 src/ 或 ./",
  "location": "D:/proj/src/tools/misc/dirStats.ts:57",
  "runId": "run_mv66ewtp_b8874da6",
  "subtaskId": "st_7ab313bf",
  "specId": "dir-inventory",
  "toolName": "dir_stats",
  "context": { "objective": "清点 src", "inputs": { "dir": "demo/codebase-sample/src" } },
  "hint": "路径不存在或不可解析：message 里会列出仓库内实际可用的条目。",
  "stack": "Error: 路径不存在…\n    at dirStats.execute (…/dirStats.ts:57:13)"
}
```

- **位置**：`location` = 栈里第一处**项目内**帧（`file:line`），自动过滤 `node_modules` 与 `node:` 内部帧。
- **类型**：`errorType`（Error 子类名 / `string` / `undefined`）+ 稳定错误码 `code`。
- **原因**：`message`（可行动：带上可用选项与示例）。
- **上下文**：`context`（runId / subtaskId / specId / 工具参数 / 阶段），**密钥字段自动脱敏**。

### 2.2 三个落点（互为补充）

| 落点 | 内容 | 怎么用 |
|---|---|---|
| **`runtime_error` 事件** | 进入事件流（持久化 + SSE 实时推送） | 界面「实时」视图直接出现红色**错误报告卡片**；事件流可按 seq 回放 |
| **`data/errors.log`（JSONL）** | 每条一行完整报告 | `grep '"code":"DUPLICATE_OBJECTIVE"' data/errors.log`；`jq` 也友好 |
| **`GET /api/errors`** | 最近 200 条（内存环形缓冲） | `curl -s "localhost:3939/api/errors?runId=xxx"`；支持 `?code=` / `?source=` / `?limit=` |

### 2.3 覆盖点（这些地方出错都不会再"静默"）

| 来源 `source` | 触发场景 | 行为 |
|---|---|---|
| `agent-loop` | 主执行循环抛**未预期**异常 | 报告 + `finalize(failed, INTERNAL_ERROR)`。**这是最重要的修复**：此前 `void executeLoop().finally()` 会吞掉 rejection，任务**永远停在 running**、界面毫无反应 |
| `subagent` | 子 Agent 抛出未预期异常（兜底） | 报告 + 转成 `status=failed` 的 `SubtaskOutcome`，主 Agent 仍能继续汇总 |
| `delegation` | 重复派发、未知规格、超宽 | 报告 + 可读错误码（`DUPLICATE_OBJECTIVE` / `UNKNOWN_SPEC` / `WIDTH_LIMIT`） |
| `tool` | 工具内部调用 `ctx.reportError()` 留痕 | 与服务端错误同源，便于统一过滤 |
| `provider` | **模型**调用失败（4xx / 5xx / 超时 / 网络；2026-10-20 补齐，此前只在事件流留一条 `run_failed`） | 报告 `MODEL_ERROR` + `context.{status, step, messageCount, toolCount, contextUseRatio, suspect}`；协议类 400（孤儿 tool）标 `suspect:"invalid_message_sequence"` |
| `store` / `server` | 持久化 / 路由异常 | 路由异常由 Express 错误中间件兜住 → **结构化 500**（含 `errorId`），不再返回 HTML |
| `client` | **浏览器** `window.onerror` / `unhandledrejection` | 自动 POST `/api/client-errors` → 写入同一份报告；界面底部弹出红色告警条（含"查看错误报告"链接） |

进程级兜底：`unhandledRejection` / `uncaughtException` 也会落一份报告并打印醒目警示（本地工具**不主动退出**，避免"看不到发生了什么"；若状态可疑请重启）。

### 2.4 排查入口（按顺序）

```bash
# 1) 先看服务端控制台：未预期错误会打印 [error] … / [fatal-ish] …
# 2) 查接口（最近 200 条）
curl -s "http://localhost:3939/api/errors?limit=20" | jq '.errors[] | {code, location, message}'
# 3) 按 run 过滤
curl -s "http://localhost:3939/api/errors?runId=<runId>" | jq
# 3.5) 模型调用失败（source=provider）：先看 messageCount 有没有突降、suspect 有没有值
#      突降 ≈ 上下文压缩刚跑过 → 大概率是消息序列被切坏，而不是 Key/网络
curl -s "http://localhost:3939/api/errors?runId=<runId>&source=provider" | jq '.errors[] | {code, message, context}'
# 4) 落盘日志（可 grep / 可归档）
grep '"code":"INTERNAL_ERROR"' data/errors.log
# 5) 前端报错（界面"点了没反应"时先看这里）
curl -s "http://localhost:3939/api/errors?source=client" | jq
# 6) 事件与耗时（已有能力）
curl -s "http://localhost:3939/api/runs/<runId>/events" | jq '.[] | {type, code: .data.code}'
curl -s "http://localhost:3939/api/runs/<runId>/trace"  | jq '.summary'
```

### 2.5 错误码速查

| 错误码 | 含义 | 怎么处理 |
|---|---|---|
| `INTERNAL_ERROR` | 未预期异常（代码缺陷） | 看 `location` 定位源文件行号；把 `context` 里的阶段/参数一起带上 |
| `MODEL_ERROR` | 模型调用失败 | **先分诊**：`context.status=400` 且 `context.suspect="invalid_message_sequence"`（或 message 含 `tool_calls`）→ 消息序列非法，常见于上下文压缩，对比相邻 step 的 `messageCount` 是否突降（见 §1.4）；其余情况再查 Key / Base URL / 模型名 / 网络，看同一 step 的 `model_request` |
| `UNHANDLED_REJECTION` / `UNCAUGHT_EXCEPTION` | 进程级未捕获 | 优先修复；必要时重启服务 |
| `HTTP_HANDLER_ERROR` | 路由层异常 | 响应里带 `errorId`，用它去 `/api/errors` 查详情 |
| `CLIENT_ERROR` | 浏览器脚本错误 | 看 `location`（浏览器栈解析出的行号）与 `context.url` |
| `INVALID_ARGS` / `MISSING_ARGS` | 工具参数不符 / 缺必填 | 消息里已附**逐字段原因 + 正确示例** |
| `NOT_FOUND` / `PATH_ESCAPE` / `SENSITIVE` | 路径不存在 / 越权 / 敏感文件 | 消息里会给出仓库内可用条目；越界一律拒绝 |
| `PERMISSION_DENIED` | 该 Agent 无此工具权限 | 检查 `spec.permissions` 与工具所需权限是否**恰好相等** |
| `WIDTH_LIMIT` / `DUPLICATE_OBJECTIVE` / `UNKNOWN_SPEC` / `SPEC_NOT_ALLOWED` | 编排约束 | 见 message 里的改写建议（分批 / 换 objective / 查 `/api/agents/specs`） |
| `tokenBudget` / `maxSteps` / `maxToolCalls` / `totalTimeout` | 触达预算 | 调大对应预算，或收窄任务范围 |
| `EMPTY_RESULT` / `CONTRACT_VIOLATION` | 子 Agent 未按契约上报 | 数据仍在（`structured=false`），但不应直接采信；看该子任务的事件流 |
| `TIMEOUT` / `EXECUTION_ERROR` | 工具超时 / 执行异常 | 缩小目标范围；`retryable` 字段表示是否适合重试 |

### 2.6 相关开关

```bash
ERROR_LOG_PATH=./data/errors.log   # 报告落盘位置（默认）
STREAM_DEBUG=false                 # 需要看 SSE 帧级日志时打开
LOG_MAX_CONTENT_CHARS=2000         # 报告里字符串的截断上限（防日志膨胀）
```

### 2.7 已知限制（诚实清单）

1. **报告不落库**：`/api/errors` 是内存环形缓冲（最近 200 条），重启即清空；**落盘副本**在 `data/errors.log`（JSONL），跨重启可查但需自行 grep。
2. **`location` 指向"错误被创建处"**：来自栈帧语义，不等于"被捕获处"；对第三方库抛出的错误可能指向 `node_modules`（此时取不到项目内帧就留空）。
3. **浏览器错误的位置**依赖浏览器提供的栈格式；部分压缩/内联场景可能解析不出行号（此时 `context.stack` 仍然完整保存）。
4. **未做错误聚合与告警**：同一错误重复出现会各记一条（不合并计数），也没有外部通知；如需按频次排序需自行聚合 `data/errors.log`。
5. **前台错误上报依赖网络**：用 `keepalive` 但若服务已崩溃，浏览器侧错误自然无法落库。
6. **子 Agent 的模型调用失败不单独出 `provider` 报告**（`subAgentLoop` 没有注入 `ErrorReporter`）：只体现在 `subtask_failed` 事件与 `SubtaskOutcome.failureReason`（`errorCode=MODEL_ERROR`）。要按 run 定位仍需看事件流——这是已知缺口，不是「已经报了」。
7. **`suspect` 是子串匹配**：`invalid_message_sequence` 只匹配 `tool_calls` 这类协议文案，属于分诊提示而不是分类真值；换 Provider 的措辞可能命中不到（此时仍会如实记录 `status` 与 `messageCount`）。
