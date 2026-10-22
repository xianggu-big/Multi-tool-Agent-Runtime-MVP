# 演示闭环（DEMO）

> 目标：让第一次打开项目的人，在 **10 分钟内**走完一条可验证的主路径，并知道每一步「应该看到什么」。
> 本文数字来自本机实跑：命令行/HTTP 为 **2026-10-21 ~ 10-22**（Mock，内存库）；全量测试为 **62 文件 / 416 子测试 / 416 通过 / 0 跳过**。
> 真实模型效果不在这里编造，统一看 `reports/AGENT_REPORT.md`（从 `data/runtime.db` 生成）。

---

## 0. 选一条路线

| 路线 | 需要 | 成本 | 适合 |
|---|---|---|---|
| A. Mock 演示 | Node 24 | 0 | 第一次上手、界面演示、CI 复现 |
| B. 真实模型 | DeepSeek Key（或任意 OpenAI 兼容） | 单次约 $0.001~0.01 | 看真实 Agent 决策与工具调用 |
| C. 写能力闭环 | A/B + Docker | 0（Mock）/ 少量 token | 改文件、审批、验证、回滚 |

写能力与 `run_tests` 都是「执行代码」能力，**默认关闭**，需要在界面上显式勾选。

---

## 1. 路线 A：四条命令行演示（约 30 秒）

```bash
cd multi-tool-agent
npm install
npm run demo:codebase
npm run demo:research
npm run demo:misc
npm run demo:orchestrator
```

实测输出（2026-10-21，`SQLITE_PATH=:memory:`）：

| 命令 | 结果 | 关键证据 |
|---|---|---|
| `demo:codebase` | `completed`，4 步 / 4 次模型 / 3 次工具，180ms | `run_tests` 执行 `node --test`，示例仓库 **6/6 通过** |
| `demo:research` | `completed`，4 步 / 3 次工具，13ms | 工具链 `web_search → extract_evidence → compare_sources`；首行标注「基于 MOCK 离线资料，非实时联网」 |
| `demo:misc` | `completed`，2 步 / 2 次工具，13ms | `dir_stats` 清点 + `submit_result` 结构化结论 |
| `demo:orchestrator` | `completed`，2 个子任务并行，19ms | `dir-inventory` 与 `code-audit` 均 `ok`，汇总里如实列出「未解决」项 |

> Mock 是**显式标注**的模拟：结果里带 `isMock: true`，Research 首行写明离线资料。不会拿 Mock 冒充真实模型。

---

## 2. 路线 A：工作台完整路径（推荐演示这 7 步）

### 第 1 步：启动

```bash
npm start
# 打开 http://localhost:3000 （端口用 PORT 覆盖，例如 PORT=3939）
```

预期：左侧「任务参数」+「LLM / 搜索 / 实时流 配置」，右侧五个页签：**实时 / 事件流 / 流程监控 / 错误 / 复盘**。

### 第 2 步：提交一个只读代码分析

- 任务类型：`codebase`
- 仓库路径：`demo/codebase-sample`（相对 `multi-tool-agent/`）
- 目标：`分析这个仓库的加法与字符串工具实现，并运行测试验证。`
- 「允许运行测试」：**先不勾**

点「开始任务」。

预期：3 步结束；工具调用只有 `search_files` 与 `read_file`；最终答案明确写「未启用运行测试，本次只做静态分析」；复盘页结论是「完成，过程无错误」。

> 这正是本轮修正的行为：以前不勾也会调 `run_tests`，拿到 `DISABLED`，复盘显示「完成，但过程另有 1 类问题」。现在没开启时工具根本不进工具池。

### 第 3 步：勾选「允许运行测试」再跑一次

预期：4 步结束；第三次工具调用是 `run_tests`；示例仓库测试 6/6 通过；复盘仍然「完成，过程无错误」。

实测（HTTP，2026-10-22）：

| 配置 | runId | 步数 | 工具调用 | 复盘 |
|---|---|---|---|---|
| 不勾 | `run_mvj11vsd_b69fab7c` | 3 | 2 | 完成，过程无错误 |
| 勾选 | `run_mvj11wf7_5fcb6e21` | 4 | 3 | 完成，过程无错误 |

### 第 4 步：看实时视图

预期：思考文本逐字出现；每个工具一张卡片（参数 / 状态 / 结果 / 耗时）；顶部统计随步数增长。

### 第 5 步：看「流程监控」

预期：run → step → model/tool 的节点流；点节点能看到输入输出摘要。

### 第 6 步：看「复盘」

预期：左侧列表最上面就是刚才两次 run；右侧显示结论、steps/token/成本、过程问题表；短任务会显示「本 run 未触发上下文压缩」。

如果任务很长（超过上下文门禁），这里会出现压缩卡片：次数、移除消息数、摘要深度、摘要字符数、水位来源。**压缩卡片只记录事实，不参与成败判定。**

### 第 7 步：看单 run 报告

```bash
npm run report:run -- <runId>
# 或浏览器打开 /api/runs/:id/report?format=md
```

预期：Mermaid 流程图 + 六阶段归因（intake / model / tool / subtask / approval / delivery）+ 分层用量。

---

## 3. 路线 A：HTTP API（真实响应）

服务启动后：

```bash
# 创建任务
curl -s -X POST http://localhost:3000/api/runs \
  -H 'content-type: application/json' \
  -d '{"runType":"codebase","goal":"分析 calc.js 与测试","repoPath":"demo/codebase-sample","mockScenario":"codebase-basic"}'
# → 201 {"runId":"run_...","runType":"codebase","llm":{...}}

# 查询
curl -s http://localhost:3000/api/runs/<runId>
# → {"status":"completed","steps":3,"modelCalls":3,"toolCalls":2,"isMock":true,...}

# 复盘
curl -s http://localhost:3000/api/runs/<runId>/digest
# → {"ok":true,"headline":"完成，过程无错误","issueCount":0,...}

# 列表（默认只看有问题的；onlyProblems=false 看全部）
curl -s 'http://localhost:3000/api/digests?limit=20&onlyProblems=false'
# → {"count":N,"onlyProblems":false,"digests":[...]}

# 单 run 报告
curl -s 'http://localhost:3000/api/runs/<runId>/report?format=md'
```

SSE 实时流：`GET /api/runs/:id/stream`（事件类型见 `docs/STREAMING_LIVE_VIEW.md`）。

> 本机 Git Bash 用 `curl --data-urlencode` 传中文会乱码；HTTP 实测建议用 Node `fetch`。

---

## 4. 路线 C：写能力闭环（需要 Docker）

最短路径（真 Docker + 真审批 + 真落盘 + 宿主复验）：

```bash
node scripts/sandbox/build-image.mjs
npm run eval:edit        # 7 个确定性场景，产物 reports/EDIT_EVAL.md
npm run eval:edit:real -- --tasks=20 --budget-usd=1 --timeout-ms=240000  # 20 条真实模型任务 → reports/EDIT_EVAL_REAL.md（约 $0.02）
```

界面演示：

1. 任务类型选 `orchestrator`，填写仓库路径。
2. 勾选「允许修改文件」。
3. 提交修改需求。
4. 等审批卡出现：查看 diff → 选择「完全同意此文件 / 仅同意本次 / 拒绝」。
5. 落盘后自动跑宿主复验；失败会自动回滚并保留 `change_rolled_back` 证据。

预期：`npm run eval:edit` 本轮（2026-10-22）重跑 **7/7** 命中预期（5 次审批 / 4 文件落盘 / 1 回滚；平均 12.7s / P95 14.1s）。改 Docker 相关代码后仍需重跑。

真实模型层：`eval:edit:real` 最近一次为 **20/20 通过、L2 20/20、611,890 tokens / $0.0172 / 平均 23.9s**（DeepSeek Flash）。它只覆盖单文件小函数级修改，不能说成“模型能重写项目”。

---

## 5. 路线 B：真实模型（可选）

界面方式：左侧配置面板选 `真实接口` → 服务商 `DeepSeek` → 填 Key → 「测试连接」→ 提交任务。

命令行方式：

```bash
LLM_MODE=openai LLM_PROVIDER=deepseek DEEPSEEK_API_KEY=... npm start
```

预期：`GET /api/runs/:id` 里 `isMock: false`；成本与 token 进入统计；`/api/runs/:id/diagnosis` 可按模型/工具/审批/验证拆耗时。

> 真实模型指标以 `reports/AGENT_REPORT.md` 为准（当前 403 任务 / 真实模型 67.7% 成功率）。不要用 Mock 数据声称真实能力。

---

## 6. 一键证据清单

| 命令 | 产物 |
|---|---|
| `npm test` | 416 子测试全绿（含 Docker 用例时 0 跳过） |
| `npm run agents:lint` | 契约自校验 / 文档漂移 / 工具存在性 |
| `npm run report:refresh` | `reports/{AGENT_REPORT,PARAMETERS}.md`、`agents/*.md` |
| `npm run rag:bench` | `reports/RAG_EVAL.md` |
| `npm run rag:ablation` | `reports/RAG_ABLATION.md` |
| `npm run eval:edit` | `reports/EDIT_EVAL.md`（需 Docker） |
| `npm run eval:edit:real -- --tasks=20 --budget-usd=1 --timeout-ms=240000` | `reports/EDIT_EVAL_REAL.md`（需 Docker + DEEPSEEK_API_KEY，约 $0.02） |
| `npm run eval:compaction` | `reports/COMPACTION_AB.md`（需真实 Key，约 $0.03） |
| `npm run security:redteam` | `reports/INJECTION_REDTEAM.md` |
| `npm run digest:list` | 最近 run 的复盘（默认只看有问题的） |

---

## 7. 常见失败与排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION` | 原生模块按另一个 Node 版本编译 | 删 `node_modules/better-sqlite3/build` 后 `npm rebuild better-sqlite3` |
| `run_tests` 没出现 | 默认关闭（安全默认） | 界面勾选「允许运行测试」，或设 `CODEBASE_RUN_TESTS_ENABLED=1` |
| 写能力开关置灰 | `CODEBASE_WRITE_ENABLED=false` | 改环境变量并重启 |
| 端口占用 | 3000 被占 | `PORT=3939 npm start` |
| 改了代码但行为没变 | `npm start` 无热重载 | 重启；开发用 `npm run dev` |
| 测试卡在 Docker 用例 | Docker 未启动 | 启动 Docker Desktop；`npm run doctor` 会指出 |

---

## 8. 口径与边界

- Mock 演示衡量的是**管线与界面**，不是模型智力。
- 真实模型成功率来自 `data/runtime.db`，由 `npm run report:agent` 生成，不手改。
- 压缩 A/B 结论是 `not_proven`：没有质量回退，也没有证明更省更快；不能外推到 1M 窗口。
- 本项目是**本地单用户 MVP**：无鉴权、无 HTTPS、无多租户隔离（见 `reports/CODE_REVIEW_2026-10-13.md` P2-7）。
