# Codex 接入 + 定时任务 — 实施方案（2026-10-23）

> 状态：**已实施（2026-10-23 第六轮）**；实现与验收见 `docs/CODEX_AND_SCHEDULES.md`、`reports/CHANGELOG.md` 同日条目。
> 目标：① 在 Runtime 里新增「定时任务」；② 把本机 `codex` CLI 接成可用的 code agent，支持界面里看思考过程/回答、任务结束后继续追问。

## 0. 需求原文与补充

用户需求：
1. 前端新增「定时任务」界面：选择使用哪个 Agent、选择日期与时间（一次性），或每天在选定时间运行。
2. 首先接入 Codex：输入提示词、选择工作区域、在指定时间运行。
3. 界面显示 Codex 的思考过程与回答答案。
4. 定时任务结束后仍然可以继续提问。
5. 方案通过后再开始实现。

已确认的 4 个决策：
- 定时任务形态：**进程内调度 + API/UI 管理**（服务停着不触发）。
- 定时任务范围：**允许写 + 无人值守安全策略**：普通改动自动放行；删除/宿主命令等危险操作**暂缓执行**，跑完汇总给用户，事后由用户决定是否执行。
- Codex 接入形态：**工具 + 子 Agent 双入口**（另有直连 `runType='codex'` 作为主入口）。
- Codex 写路径：**Codex 改副本，再由现有管线落盘**。

## 1. 结论先行（架构选择）

Codex 不是「我们 LLM 调一个 shell 工具」，而是一个**外部 Agent 适配器**：

- 它有自己的会话（thread）、自己的 sandbox、自己的工具循环；
- 我们不把它塞进 `AgentRuntime` 的 LLM Loop，而是新增一个**直接执行型 runType = `codex`**；
- 运行仍复用现有 run 记录、事件流/SSE、取消、审批、落盘、复盘（`finalize` / `run_digest`）。

三条入口（共用同一个 `src/codex/` 适配层）：

| 入口 | 使用方 | 能力 |
|---|---|---|
| `runType: 'codex'` | 工作台直跑 / 定时任务 | 完整：只读问答、写副本、审批落盘、会话续问 |
| 工具 `codex_exec` | codebase 主 Agent、`codex-code` 子 Agent | 单次委派：只读分析；写模式受 run 级授权 + 审批约束 |
| 子 Agent `codex-code` | orchestrator `delegate_subtasks` | 把子任务翻译成 Codex prompt 并回传结构化 finding |

## 2. 现状锚点（实现时直接改这些位置）

- HTTP 建任务：[server.ts](file:///d:/c%E5%AD%A6%E4%B9%A0%E6%95%B0%E6%8D%AE%E7%BB%93%E6%9E%84/Multi-tool%20Agent%20Runtime%20MVP/multi-tool-agent/src/server.ts#L50-L60) `validateRunRequest()`、`POST /api/runs` L553-L600。
- 建 run：[AgentRuntime.ts](file:///d:/c%E5%AD%A6%E4%B9%A0%E6%95%B0%E6%8D%AE%E7%BB%93%E6%9E%84/Multi-tool%20Agent%20Runtime%20MVP/multi-tool-agent/src/runtime/AgentRuntime.ts#L451-L473) `createRun()` 目前**无条件** `createProvider()`；codex run 需要跳过。
- 执行入口：`executeLoop()` L900，`finalize()` L1631-L1692。
- 审批：`requestApproval()` L611-L700；写工具调用方是 `ToolContext.requestApproval`。
- 工具池：[toolPool.ts](file:///d:/c%E5%AD%A6%E4%B9%A0%E6%95%B0%E6%8D%AE%E7%BB%93%E6%9E%84/Multi-tool%20Agent%20Runtime%20MVP/multi-tool-agent/src/runtime/toolPool.ts) `toolPoolFor()`。
- 写链路：[writeTools.ts](file:///d:/c%E5%AD%A6%E4%B9%A0%E6%95%B0%E6%8D%AE%E7%BB%93%E6%9E%84/Multi-tool%20Agent%20Runtime%20MVP/multi-tool-agent/src/tools/codebase/writeTools.ts#L327-L327) `submit_changes` 已包含「阶梯 → 审批 → journal → 落盘 → 宿主复验 → 回滚」全流程。
- 沙箱副本：[session.ts](file:///d:/c%E5%AD%A6%E4%B9%A0%E6%95%B0%E6%8D%AE%E7%BB%93%E6%9E%84/Multi-tool%20Agent%20Runtime%20MVP/multi-tool-agent/src/sandbox/session.ts#L164-L238) `SandboxSession.ensure()`；`stage()` L276-L311；`applyToRepo()` L586-L639。
- 表结构：[SqliteStore.ts](file:///d:/c%E5%AD%A6%E4%B9%A0%E6%95%B0%E6%8D%AE%E7%BB%93%E6%9E%84/Multi-tool%20Agent%20Runtime%20MVP/multi-tool-agent/src/store/SqliteStore.ts#L43-L110) `init()` + `migrate()`。
- 服务启动：[index.ts](file:///d:/c%E5%AD%A6%E4%B9%A0%E6%95%B0%E6%8D%AE%E7%BB%93%E6%9E%84/Multi-tool%20Agent%20Runtime%20MVP/multi-tool-agent/src/index.ts)（scheduler 只在这里 `start()`，测试不启动）。
- 前端：[public/index.html](file:///d:/c%E5%AD%A6%E4%B9%A0%E6%95%B0%E6%8D%AE%E7%BB%93%E6%9E%84/Multi-tool%20Agent%20Runtime%20MVP/multi-tool-agent/public/index.html) 页签 L472-L477、实时卡片 L1346-L1396、事件分发 L1770-L1805、提交请求 L2866-L2950。

## 3. Codex 适配层（新增 `src/codex/`）

### 3.1 配置（`src/config.ts` + env）

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `MTA_CODEX_ENABLED` | `true` | 总开关；关闭后不注册工具、不接受 `runType=codex` |
| `MTA_CODEX_BIN` | `codex` | 可执行文件（Windows 下为 `codex.cmd`/`codex.ps1`，用 `spawn` shell 解析） |
| `MTA_CODEX_MODEL` | 空 | 可选覆盖 `-m`。本机 `~/.codex/config.toml` 已改为 `deepseek-flash`，默认留空即可 |
| `MTA_CODEX_TIMEOUT_MS` | `600000` | 单次 Codex 执行上限 |
| `MTA_CODEX_MAX_OUTPUT_BYTES` | `4MiB` | stdout/事件缓冲上限 |
| `MTA_CODEX_REASONING_TAP` | `true` | 是否旁路读取会话 rollout 拿思考文本（§3.3） |
| `MTA_CODEX_SUMMARY_CHARS` | `20000` | 回传给模型/界面的最终答案截断上限 |

### 3.2 进程与事件（`src/codex/runner.ts`）

调用形式：

```text
codex exec --json -m <model> --sandbox read-only|workspace-write \
  --skip-git-repo-check -C <cwd> <prompt>
```

续问：

```text
codex exec resume <threadId> --json -m <model> --skip-git-repo-check <prompt>
```

注意：`exec resume` **不接受 `-C`**，工作目录沿用首次会话的 cwd → 写模式的副本目录必须**跨 run 稳定**（§5.1）。

已在本机实测的事件（codex-cli 0.163.0，deepseek 端点）：

```json
{"type":"thread.started","thread_id":"01a1..."}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"...","status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_2","type":"command_execution","aggregated_output":"...","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"最终回答"}}
{"type":"turn.completed","usage":{"input_tokens":19864,"output_tokens":324,"reasoning_output_tokens":142}}
```

映射到现有事件（前端零改动即可复用实时卡片）：
- `item.completed/agent_message` → `llm_delta`（channel=`content`）+ 持久化 `codex_message`
- `item.started/completed/command_execution` → `tool_started` / `tool_completed`（`name='codex_shell'`，输出截断）
- `thread.started` → 持久化 `codex_thread`（带 `threadId`、cwd、model、sandboxMode）
- `turn.completed.usage` → `model_completed.outputs.codexUsage`（token 只记录，成本标 `unknown`）
- 进程非零退出 / `type=error` → `runtime_error`（`source='codex'`）+ run `failed`

stdout 只解析 JSONL；**stderr 丢弃**（本机实测 stderr 有大量 INFO/插件告警，混进 stdout 会污染解析）。

### 3.3 思考过程（答案优先，过程 best-effort）

实测 `codex exec --json` **只给 `reasoning_output_tokens`，不给思考正文**。用户确认：**最终答案必须完整可见，思考过程有就展示、没有不影响**。因此：
- 必备：`agent_message`（最终回答）与 `command_execution`（命令+输出）实时展示，并在 `resultJson` 里保留完整答案。
- 可选（`MTA_CODEX_REASONING_TAP=true`）：以 `CODEX_HOME`（默认 `~/.codex`）下
  `sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl` 为数据源，轮询增量读取
  `response_item` 里 `type=reasoning` 的 `content[].text`，以 `llm_delta(channel=reasoning)` 推给界面。
- 旁路失败（文件没出现/格式变化）→ 静默降级为「只显示命令+回答」，界面标注「思考不可用」，**绝不阻断任务、绝不影响最终答案**。

### 3.4 会话续问

- 首次运行从 `thread.started` 拿 `threadId`，写入 `run_started` 之后的事件与 `resultJson.codex.threadId`。
- `POST /api/runs` 支持 `codex.resumeThreadId`；命中则走 `exec resume`。
- 只读续问：cwd 是真实仓库，天然可用。
- 写模式续问：cwd 是稳定副本目录（§5.1），目录必须仍存在；缺失时明确报
  `CODEX_WORKSPACE_MISSING`，不静默新建（否则 Codex 会话里的历史路径全失效）。

## 4. `runType: 'codex'` 的执行流程

```text
POST /api/runs { runType:'codex', goal, repoPath, codex:{...} }
  └─ validateRunRequest：codex 专属校验（不要求 API Key）
  └─ createRun：跳过 createProvider（codex run 不需要内置 LLM）
  └─ executeLoop 分流 → executeCodexRun(runId, input, signal)
       ├─ tracer.start(run_started)
       ├─ 只读模式：cwd = repoPath，--sandbox read-only
       ├─ 写模式：session.ensure() → cwd = session.repoCopyDir()，--sandbox workspace-write
       ├─ spawn codex，逐行解析 JSONL → 事件/SSE
       ├─ 写模式：scanChanges(copy, repo) → session.stage() → registry.execute('submit_changes')
       ├─ finalize(completed|failed|cancelled)，resultJson.codex = {threadId, cwd, applied, ...}
       └─ 每次终态照常写 run_digest
```

约束：
- 超时/取消走现有 `AbortController`：`cancel()` 杀子进程（Windows 用 `taskkill /T /F`），事件记 `run_cancelled`。
- 预算：Codex 的 token 不进入 Runtime 的 `tokenBudget`（不可控），单独记录并标注；run 级仍有 `totalTimeoutMs`。
- `runType='codex'` 不进 `toolPoolFor()`（Codex 用自己的工具），但写落盘复用 `submit_changes`。

## 5. 写路径：Codex 改副本 → 现有管线落盘

### 5.1 稳定副本（关键）

`SandboxSession` 的副本目录是 `data/sandbox/<parentRunId>/repo`。为了支持 `exec resume`（cwd 不可改）：
- 写模式把 `parentRunId` 设为 **`codex_<workspaceId>`**，`workspaceId` 首次生成后写入 `resultJson`，续问沿用；
- 只读模式不建副本，直接在 `repoPath` 上跑；
- 同一 `workspaceId` 加**单飞锁**：同一会话的两次运行不允许并发；
- 续问前如需刷新，先把原仓库重新快照到副本（排除 `node_modules/.git/data/.env*`，现有 `copyRepoSnapshot` 已实现）。

### 5.2 变更导入（`src/codex/importChanges.ts`）

Codex 结束后，逐文件比较 `copy` 与 `repo`：
- 只在 copy 中 → `create`
- 内容不同 → `edit`
- 只在 repo 中（copy 里被删） → `delete`
- 跳过：快照排除项（`node_modules`/`data`/`.git`/`.env*`/符号链接）、非 UTF-8 二进制；
  跳过的文件在结果里列明「未纳入审批」，不静默吞掉。
- 逐个 `session.stage(rel, op, content)`（`stage` 内已做 baseHash、容器 `/work` 写入）。

### 5.3 落盘复用

导入完成后直接调用现有工具（不复制逻辑）：

```ts
registry.execute('submit_changes', { summary }, toolCtx)
```

`toolCtx` 复用主循环的注入物：`repoPath`、`sandbox`、`requestApproval`、`emitEvent`、`config`、`signal`。
因此阶梯校验（L0/L1）、批量审批、`apply-journal`、宿主复验、失败回滚**全部原样生效**。

分批：`submit_changes` 每批最多 `approval.maxFilesPerRequest` 个文件；循环提交直到无 staged，最多 5 轮，剩余未提交的如实写进结果。

### 5.4 无人值守安全策略：普通改动放行，高危操作暂缓

用户目标：不在场时跑定时任务；危险命令不要直接执行，跑完汇总，事后再决定。

- 每条 schedule 带一份 `safetyPolicy`：
  - `safetyPrompt`：自由文本，注入 Codex prompt / 子 Agent 系统提示（**只作引导，不当作强制**）；
  - `dangerPatterns`：结构化危险模式（默认内置删除/重置/发布/外传密钥等；可增删）。
- 运行期由**代码**判定，不信任模型：
  1. `change` 类：create/edit → 自动 `allow_once`；**delete** → 标记 `deferred`，不落盘；
  2. `command` 类（run_command / MCP destructive）→ 不执行，登记待确认；
  3. 命中提示注入污点 → 不自动放行，登记待确认。
- 待确认项落 `pending_actions` 表（runId/scheduleId/kind/payload/status），并写入 `resultJson` 与 `run_digest` headline（例如「3 个高危操作待确认」）。
- UI 新增「待确认」面板：展示命令/删除目标/diff 摘要，按钮「执行」「忽略」。
  - `execute` 必须带显式 `confirm:true`；删除执行前复核 `baseHash`（文件已变 → `STALE_ACTION`，要求重跑）；命令执行需要当前批次二次确认。
  - 执行结果追加到原 run 的事件与审计记录。
- 自动放行也必须如实记录 `autoApproved:true`，复盘可归因。

## 6. 定时任务

### 6.1 数据表 `schedules`（新增；`runs` 加 `scheduleId` 迁移列）

```sql
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  agent TEXT NOT NULL,            -- codebase|research|misc|orchestrator|codex
  goal TEXT NOT NULL,
  repoPath TEXT,
  frequency TEXT NOT NULL,        -- once|daily
  runAt TEXT,                     -- once: ISO 本地时间；daily: HH:mm
  enabled INTEGER NOT NULL DEFAULT 1,
  allowWrite INTEGER NOT NULL DEFAULT 0,
  autoApprove INTEGER NOT NULL DEFAULT 0,
  safetyPrompt TEXT,              -- 注入 Codex/子 Agent 的安全边界说明（只作引导）
  dangerPatternsJson TEXT NOT NULL DEFAULT '[]',  -- 结构化危险模式（代码判定用）
  allowRunTests INTEGER NOT NULL DEFAULT 0,
  skipIfRunning INTEGER NOT NULL DEFAULT 1,
  optionsJson TEXT NOT NULL DEFAULT '{}',  -- limits / llm(provider,model,params) / orchestration；绝不含 apiKey
  nextRunAt TEXT,
  lastRunAt TEXT,
  lastRunId TEXT,
  lastStatus TEXT,
  lastError TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL,
  scheduleId TEXT,
  kind TEXT NOT NULL,             -- delete|command
  payloadJson TEXT NOT NULL,
  status TEXT NOT NULL,           -- pending|executed|dismissed|failed
  createdAt TEXT NOT NULL,
  decidedAt TEXT,
  resultJson TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_actions(status, createdAt);
```

### 6.2 调度语义（`src/scheduler/service.ts`）

- 服务内 `setInterval(30s).unref()`；`tick(now)` 纯函数可单测。
- 到点条件：`enabled && nextRunAt <= now`。
- 到点后：`runtime.enqueue(input, provider?)`，`runs.scheduleId` 落库；每日任务推进到下一次；一次性任务置 `enabled=0`。
- 重叠：`skipIfRunning=1` 且上一 run 仍处 `queued/running/waiting_tool/awaiting_user` → 跳过并记 `lastError='overlap_skipped'`。
- 停服错过：默认**不补跑**；每日任务直接推进到下一个时间点，一次性任务标记 `missed` 并在 UI 显示。
- 时区：跟随服务所在本地时区（本机 Asia/Shanghai）。
- 不在 `buildRuntime()` 里启动（测试/演示不触发真实 run）；只在 `src/index.ts` 调 `scheduler.start()`。

### 6.3 HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/schedules` | 列表 + `nextRunAt` + 最近 run 状态 |
| POST | `/api/schedules` | 创建（含 §6.1 字段校验） |
| PATCH | `/api/schedules/:id` | 局部更新（启停/改时间/改开关） |
| DELETE | `/api/schedules/:id` | 删除（不删历史 run） |
| POST | `/api/schedules/:id/run-now` | 立即触发（沿用 schedule 的 flags） |
| GET | `/api/schedules/:id/runs` | 该计划的 run 列表 |
| GET | `/api/pending-actions?status=pending` | 待确认的高危操作 |
| POST | `/api/pending-actions/:id/execute` | 执行（必须 `{confirm:true}`） |
| POST | `/api/pending-actions/:id/dismiss` | 忽略 |

校验要点：agent 白名单；`once` 必须给未来时间；`daily` 必须是 `HH:mm`；`codex` 必须给 `repoPath`；
`autoApprove=1` 必须同时 `allowWrite=1`；`safetyPrompt` ≤ 4000 字符；`dangerPatterns` 必须是字符串数组。

### 6.4 前端「定时」页签

- 页签栏新增 `定时`（`#tab-schedule`）。
- 表单：名称、Agent 下拉（含 `Codex (本机 CLI)`）、工作区（codex/codebase/misc/orchestrator 必填）、提示词、频率（仅一次 `datetime-local` / 每天 `time`）、允许修改文件、自动审批、安全边界说明（`safetyPrompt`，可选）、允许运行测试、启用。
- 列表：名称 / Agent / 下次运行 / 上次状态 / 待确认数 / 操作（立即运行、启停、查看 run、删除）。
- 「待确认」面板：列出 `pending_actions`（删除目标/命令/来源 run/时间），按钮「执行」「忽略」；执行前二次确认。
- 点「查看 run」切到实时/复盘视图，直接复用现有 run 详情。

## 7. 已知问题与边界（实现前必须知道）

1. **Codex 默认模型**：本机 `~/.codex/config.toml` 已改为 `deepseek-flash`，默认无需设置 `MTA_CODEX_MODEL`；
   若换机器/换账号，用 `MTA_CODEX_MODEL` 覆盖并在 `doctor` 里给出当前生效值。
2. **思考文本不是公开契约**：`--json` 不输出 reasoning；旁路读 rollout 属于 best-effort，版本升级可能失效。
3. **写模式依赖 Docker**：副本沙箱不可用 → 写模式 fail-closed（`SANDBOX_UNAVAILABLE`），只读模式不受影响。
4. **自动审批不是「无条件放行」**：普通 create/edit 放行；删除/宿主命令/destructive MCP 一律暂缓进 `pending_actions`，跑完汇报，由用户事后决定。
5. **定时任务只在服务运行期间触发**：不装系统计划任务，不补跑停服期间错过的执行。
6. **Codex 的 token 不进 Runtime 预算**：只记录 `codexUsage`，成本标 unknown。
7. **副本里没有 `node_modules`/`.git`**：Codex 不能跑测试；验证由落盘前的 Docker 阶梯与落盘后的宿主复验负责。
8. **API Key 不落库**：schedule 只存 provider/model/params，Key 一律来自服务端环境变量。
9. **待确认项有保鲜期**：删除操作执行前复核 `baseHash`；文件已变则拒绝执行并要求重跑。

## 8. 实施步骤（每步可独立验收）

| Step | 内容 | 验收 |
|---|---|---|
| 1 | config/env/types/run 表 `scheduleId` 迁移 + `doctor` 增加 codex 检查 | typecheck；doctor 输出 codex 状态 |
| 2 | `src/codex/runner.ts` + 只读 `runType='codex'` + 事件/SSE + 续问 | 真实 `codex exec` 跑通「提问→回答→续问」；单测用假 CLI |
| 3 | 写路径：稳定副本 + `importChanges` + 复用 `submit_changes`（新增 defer 选项）+ `pending_actions` 延后执行 | 临时 fixture 上 Codex 改文件 → 安全改动落盘 → 删除项进待确认 → 手动执行/忽略 |
| 4 | `codex_exec` 工具 + `codex-code` spec + toolPool/permission/agents:lint | `npm run agents:lint` 通过；工具池按开关生效 |
| 5 | 定时任务：表 + service + API + 启动接线 | 单测 tick/nextRunAt/重叠跳过；API CRUD |
| 6 | 前端：定时页签 + Codex 选项 + 续问按钮 + 实时卡片 | 浏览器实测：建计划 → 到点触发 → 看过程 → 续问 |
| 7 | 测试 + 门禁 + 文档/报告 | `typecheck` / `npm test` / `agents:lint` 全绿；CHANGELOG + PROJECT_REPORT + README |

## 9. 测试计划

- `tests/69_scheduler.test.ts`：`nextRunAt`（once/daily/跨天/非法输入）、tick 到点触发、`skipIfRunning`、一次性任务置停、停服错过不补跑。
- `tests/70_codex.test.ts`：假 CLI（Node 脚本）输出 NDJSON；解析 threadId/agent_message/command_execution/usage；stderr 噪声不影响；非零退出 → failed；超时/取消杀进程。
- `tests/71_codex_import.test.ts`：临时 repo + copy，检测 create/edit/delete；跳过二进制/排除项；baseHash 正确。
- `tests/72_codex_api.test.ts`：`runType=codex` 校验（不要求 Key）；`autoApprove` 直传被拒；schedule CRUD/run-now 校验。
- `tests/73_pending_actions.test.ts`：删除/命令进入 pending；`execute` 需 `confirm:true`；`baseHash` 变化 → `STALE_ACTION`；`dismiss` 不改仓库。
- `agents:lint`：新增 `codex-code` spec 的权限并集/风险等级校验。
- 手工 E2E：真实 Codex 只读问答 → 写模式（临时 fixture + Docker）→ 定时触发（缩短 tick 的测试模式）。

## 10. 明确不做（本轮）

- 不做 cron 表达式（只支持「一次性」和「每天固定时间」）。
- 不做系统级计划任务、开机自启、分布式调度。
- 不做 Codex 会话管理页（列出/删除历史 thread）；只保留 run 级 threadId 与续问。
- 不做 Codex 的 `app-server` JSON-RPC 集成（重；本轮用 `exec --json`）。
- 不把 Codex 的 token 计入 Runtime 成本预算，不伪造费用。

## 11. 已确认 / 实现时默认

1. 思考过程：答案优先；rollout 旁路 best-effort，失败降级。——**已确认**。
2. 无人值守：普通改动放行，删除/命令暂缓并事后确认。——**已确认**（§5.4）。
3. 系统级定时（停服也触发）本轮不做。——**已确认**。
4. 本轮待确认执行只覆盖「文件删除」和「宿主命令」；MCP destructive 仍硬拒绝（要延后执行需先保存工具参数与可重放的上下文，留待下一轮）。——默认按此执行。
5. `raw` 思考文本可能包含模型内部推理，只在本机界面展示、不写入对外报告。——默认按此执行。
