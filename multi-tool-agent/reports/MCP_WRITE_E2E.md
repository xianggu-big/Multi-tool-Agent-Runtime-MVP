# 真实端到端证据：MCP 自主调用 + 写能力审批（2026-10-23）

> 这两条不是单元测试，也不是 Mock：**真实 DeepSeek + 真实 HTTP + 真实 Docker 沙箱**。
> 目的只有一个：证明能力在**产品路径**上成立，而不是只在函数级别成立。
> 复现命令都写在本文；数字来自本机一次运行，**不是基准测试**（样本=1，不外推成功率）。

## 1. 环境与口径

| 项 | 值 |
|---|---|
| 日期 | 2026-10-23（Asia/Shanghai） |
| 模型 | `deepseek-flash`（OpenAI 兼容接口，`DEEPSEEK_API_KEY`） |
| 运行方式 | `createApp()` 起真实 HTTP 服务；Node `fetch` 调用；临时 SQLite（不污染 `data/runtime.db`） |
| Docker | 已启动，镜像 `mta-sandbox:node24` |
| 费用口径 | 供应商表价估算（`usage.costUsd`），不是账单 |

## 2. MCP：模型自己选择外部工具（T5）

脚本：`npm run mcp:e2e`（`scripts/mcp-e2e.ts`）

流程：本进程起 `/mcp`（只读 `knowledge_stats`）→ `POST /api/mcp/reconnect` 接上 → `POST /api/runs`
（misc，真实模型）→ 轮询终态 → 从**落盘事件**核对是否出现 `tool_call_requested.name = mcp_hub_knowledge_stats`。

### 2.1 结果

| 指标 | 修复前（第 1 次） | 修复后（第 2 次） |
|---|---|---|
| run 状态 | completed | completed |
| 模型是否主动调用 MCP | ✅ | ✅ |
| 工具调用序列 | `mcp_hub_knowledge_stats → submit_result ×3` | `mcp_hub_knowledge_stats → submit_result` |
| tokens | 9,487 | **3,756（-60.4%）** |
| 费用（估算） | $0.000613 | **$0.000127** |
| 耗时 | 7,057ms | **2,838ms** |

两次差异的根因不是模型变聪明，而是边界变友好了：第一次 `submit_result.items` 只接受对象数组，
模型先写了字符串数组，连续 2 次 `INVALID_ARGS` 后自己纠正。修复后接受字符串简写
（`"文档数：0"` → `{label:'文档数', value:'0'}`），一次通过。

**边界**：一次运行只能说明「链路通 + 模型在该提示下会选择 MCP 工具」，不能说明选择准确率。

## 3. 写能力：HTTP 审批 → 落盘 → 宿主复验（T6）

脚本：`npm run e2e:write`（`scripts/write-e2e.ts`）

流程：复制 `eval/edit-fixture/base` 到临时目录（junction 到本项目 `node_modules`）→ 起 HTTP →
`POST /api/runs`（orchestrator + `allowedSpecs:['code-edit']` + `allowWriteSpecs:true`）→
轮询 `GET /api/runs/:id/approvals` → `POST .../approvals/:approvalId`（`allow_once`）→ 等终态 →
同时核对**事件**与**磁盘文件**。

### 3.1 结果

| 检查项 | 结果 | 证据 |
|---|---|---|
| run 终态 | `completed` | `run_completed` |
| 审批 | 1 次，`allow_once` | `ap_f818627f` / `approval_decided` |
| 落盘 | `src/calc.ts` | `change_applied.applied` |
| 内容 | `return a - b;` → `return a + b;` | 磁盘读取 |
| 宿主复验 | `phase=host, ok=true`（full_suite） | `verification_completed` |
| 回滚 | 0 | 无 `change_rolled_back` |
| 子任务 | 2 个（主 Agent 因首份报告自相矛盾追加 1 次只读交叉验证） | `subtask_completed ×2` |
| tokens | 38,542 | `run.usageJson` |
| 耗时 | 95.7s | `totalDurationMs` |

### 3.2 这次实测暴露并修掉的三个摩擦

1. `delegate_subtasks.subtasks` 传成 JSON 字符串 → `INVALID_ARGS`（历史 run 也出现过）。
   现接受字符串并用同一份 schema 校验；回归 `tests/66a`。
2. `submit_orchestration.conflicts` 传字符串数组 → `INVALID_ARGS`。
   现保留原文并标为「未结构化、需人工复核」，不伪造 `between`；回归 `tests/66b`。
3. code-edit 子 Agent 能看到 `run_tests`，但部署默认关闭，调用只得到 `DISABLED`。
   现关闭时不再出现在子 Agent 工具列表（`subAgentToolNames`）；回归 `tests/66c`。

### 3.3 边界（必须一起读）

- 这是**一次**运行，且是「单文件单行修改」；不外推到大型重构/多模块改动。
- 模型追加了 1 次交叉验证，说明它会把「报告自相矛盾」当成需要复核的信号——这是好现象，但也意味着成本不由脚本完全决定。
- 验证跑在 Windows 宿主；沙箱内 Linux 结果一致，但平台差异仍以宿主复验为准。
- 临时目录与临时 DB 会在退出后留在系统 temp 目录（不是仓库），用于排障。

## 4. 复现

```bash
# MCP 自主调用（约 $0.0001/次）
npm run mcp:e2e

# 写能力全链路（约 4 万 tokens；需 Docker）
npm run e2e:write
```

两条命令都以退出码表达结论：`0` 通过 / `1` 断言失败 / `2` 前置条件缺失（缺 Key、Docker、镜像）。
