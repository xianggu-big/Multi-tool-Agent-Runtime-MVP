# Codex 直连 + 定时任务（使用手册）

> 入口：`runType='codex'` / `codex_exec` 工具 / `codex-code` 子 Agent；定时任务在 UI「定时」页签或 `POST /api/schedules`。
> 设计背景与取舍见 `reports/CODEX_SCHEDULER_PLAN.md`。

## 1. 它是什么

- **Codex 直连**：调用本机 `codex` CLI（`codex exec --json`）作为外部 code agent。它有自己的会话、工具循环和 sandbox；Runtime 只负责：记录 run、转发事件/SSE、取消、审批、落盘、复盘。
- **定时任务**：进程内调度器（30s tick），支持「仅一次」和「每天 HH:mm」。到点后用同一套 `runtime.enqueue` 创建 run，`runs.scheduleId` 记录来源。
- **无人值守安全策略**：普通 create/edit 自动放行；**删除 / 宿主命令暂缓**到 `pending_actions`，跑完在「定时」页签汇总，由你点「执行 / 忽略」。

## 2. 配置

```env
MTA_CODEX_ENABLED=true
MTA_CODEX_BIN=codex
# 留空 = 用 ~/.codex/config.toml 的 model；本机 DeepSeek 端点需 deepseek-flash
MTA_CODEX_MODEL=deepseek-flash
MTA_CODEX_TIMEOUT_MS=600000
MTA_CODEX_REASONING_TAP=true
```

`npm run doctor` 会探测 `codex --version`。Codex 必须已登录（`codex login` 或本机 API Key 配置）。

## 3. 界面用法

### 3.1 直接跑 Codex

1. 「任务类型」选 **Codex Agent（本机 CLI）**。
2. 填工作区（repoPath）与提示词。
3. 需要改文件时勾选 **允许 Codex 修改文件**（仅 codex / orchestrator 支持）。
4. 运行后：「实时」里会显示缓存/思考（若 rollout 可用）、命令卡片、最终答案；「事件流」底部有 Codex 执行摘要（会话、token、改动导入/落盘/暂缓）。
5. 想继续追问：点设置面板里的 **继续此会话**（自动带上 `threadId + workspaceId`），下一轮走 `codex exec resume`。

### 3.2 定时任务

「定时」页签 → 填名称 / Agent / 工作区 / 提示词 / 频率（每天或仅一次）/ 允许修改文件 / 自动审批 / 安全边界说明 → 创建。列表支持立即运行、启停、删除、查看上次 run。

无人值守时：
- create/edit：自动落盘（仍走沙箱阶梯 + 宿主复验）。
- 删除 / 宿主命令 / MCP destructive：**不执行**，进「待确认」。删除执行前复核 `baseHash`；文件被改过 → `STALE_ACTION`，需重跑。MCP 待确认项会显示 server/tool、参数摘要与污点警告；含 token/key/secret/password 等敏感参数的调用直接 fail-closed（`MCP_ARGS_SENSITIVE`），不写队列。
- 命中提示注入污点：整批拒绝自动落盘（`AUTO_DEFERRED_TAINT`）。

## 4. 写路径（为什么不是直接改仓库）

```text
Codex 只改副本（data/sandbox/codex_<workspaceId>/repo 或 data/codex/<workspaceId>/repo）
  → 扫描副本 vs 仓库差异（导入 create/edit/delete）
  → 逐文件 session.stage()
  → 复用 submit_changes：L0/L1 阶梯 → 审批（或自动放行）→ apply-journal → 落盘 → 宿主复验 → 失败回滚
```

副本排除 `node_modules / data / .git / .env*`：Codex 不能直接读密钥，也不能在副本里跑全量测试（验证由 Docker 阶梯与宿主复验负责）。

## 5. HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/runs` | `runType='codex'` + `codex:{allowWrite?, resumeThreadId?, workspaceId?, model?, safetyPrompt?}` |
| GET | `/api/schedules` | 列表（含 nextRunAt / lastRun / pendingCount） |
| POST | `/api/schedules` | 创建（不接受 apiKey） |
| PATCH | `/api/schedules/:id` | 启停/改时间/改开关 |
| DELETE | `/api/schedules/:id` | 删除（历史 run 保留） |
| POST | `/api/schedules/:id/run-now` | 立即触发 |
| GET | `/api/schedules/:id/runs` | 该计划的 run |
| GET | `/api/pending-actions?status=pending` | 待确认高危操作 |
| POST | `/api/pending-actions/:id/execute` | 执行（必须 `{confirm:true}`） |
| POST | `/api/pending-actions/:id/dismiss` | 忽略 |

## 6. 事件与结果

- `codex_thread`：`threadId / cwd / mode / workspaceId`（续问与复盘用）。
- `codex_message`：Codex 的过程/最终消息（落盘会按日志上限截断）。
- `model_request / llm_delta / model_completed`：复用实时卡片——思考进 reasoning 通道，回答进 content 通道。
- `change_deferred`、`pending_action_created/decided`：无人值守安全策略的审计。
- `runs.resultJson.codex`：`threadId / cwd / mode / workspaceId / answer / messages / usage / changes / deferred / reasoningCaptured`。

## 7. 已知边界（诚实清单）

1. `codex exec --json` **不输出思考正文**；`MTA_CODEX_REASONING_TAP` 是旁路读 `~/.codex/sessions/**/rollout-*.jsonl`，属于非公开契约，版本升级可能失效（失败自动降级，不影响答案）。
2. 写模式需要 Docker；Docker 不可用 → `SANDBOX_UNAVAILABLE`（fail-closed）。
3. 定时任务只在服务运行时触发；**停服期间不补跑**，一次性任务会标记 missed 并停用。
4. Codex 的 token 来自 CLI 回报，记录在 run usage 中，但**费用未计入**（标 unknown）。
5. `codex exec resume` 不接受 `-C`，工作目录由原会话决定；续接写会话必须带 `workspaceId`。
6. 无人值守的 MCP destructive 会进入待确认队列（保存 server/tool/args，用户在界面上确认后才执行）；含凭据类参数的调用不排队，避免密钥落库。
7. 只读副本没有 `node_modules/.git`，Codex 无法在副本里跑测试；这是有意的隔离，不是缺陷。
