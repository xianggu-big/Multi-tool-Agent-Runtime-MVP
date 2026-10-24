<!-- 本文件由 `npm run report:params` 从代码生成（src/config.ts / src/agents/specs.ts / src/llm/presets.ts）。
     请不要手改：改参数请改代码或 .env，然后重新生成。参数的「为什么改」记在 reports/CHANGELOG.md。 -->

# 参数台账（自动生成）

> 生成时间：**2026-10-24 09:33:31**（本机时区）· 来源：代码默认值 + 当前「.env」/环境变量
> 说明：这是**当前生效值**的快照。`.env` 一改，重新生成即可看到差异；历史变化请看 `reports/CHANGELOG.md` 的「参数变更」章节。

## 1. LLM 接入

| 项 | 当前值 | 说明 |
|---|---|---|
| LLM 模式 | `mock` | mock = 不调用真实模型；openai = 走真实 Provider |
| 默认预设 | `deepseek` | 预设清单：deepseek / openai / qwen / moonshot / zhipu / ollama / custom |
| API Key 是否已配置 | ✅ 已配置（内容不显示） | 按预设自动取用对应环境变量 |
| 默认模型 | `deepseek-flash` | 预设默认；界面可覆盖 |

### 1.1 生成参数默认值（env 层，可被界面/单次任务覆盖）

| 参数 | 当前默认 | 取值范围 | 影响 |
|---|---|---|---|
| `maxTokens` | `2048` | 1~384000 | 限制**这一次模型回复**最多生成多少 token（含思考链，视厂商而定）。太小会导致答案/工具参数被截断（表现为 JS… |
| `temperature` | `0` | 0~2 | 0 = 尽可能确定（同一输入更可能得到同一输出，适合 Agent/工具调用）；越大越发散。DeepSeek 官方推荐：代… |
| `topP` | （未设置 → 用厂商默认） | 0~1 | 只从累计概率前 top_p 的词里采样。与 temperature 二选一调整即可，不建议同时大改。1.0 = 不裁剪。 |
| `frequencyPenalty` | （未设置 → 用厂商默认） | -2~2 | 正值会按「出现次数」惩罚已出现的词，减少复读；范围 -2~2，默认 0。 |
| `presencePenalty` | （未设置 → 用厂商默认） | -2~2 | 正值会惩罚「已出现过」的词（不论次数），鼓励引入新内容；范围 -2~2，默认 0。 |
| `thinking` | `enabled` | 不指定 / enabled / disabled | DeepSeek V4 支持「思考/非思考」两种模式，思考模式会先产出 reasoning_content（本项目的「实… |
| `reasoningEffort` | `low` | 不指定 / low / high / max | 仅 DeepSeek 思考模式有效：low 更快更省，high 是官方默认，max 最深。设 max 时记得把 max_… |

### 1.2 Provider 预设（模型清单 + 表价）

| 预设 | Base URL | Key 环境变量 | 默认模型 | 表价（输入/缓存/输出，每 1M） |
|---|---|---|---|---|
| `deepseek` | https://api.deepseek.com | `DEEPSEEK_API_KEY` | `deepseek-flash` | $0.14 / $0.0028 / $0.28 |
| `openai` | https://api.openai.com/v1 | `OPENAI_API_KEY` | `gpt-4o-mini` | $0.15 / $0.075 / $0.6 |
| `qwen` | https://dashscope.aliyuncs.com/compatible-mode/v1 | `DASHSCOPE_API_KEY` | `qwen-plus` | （未收录） |
| `moonshot` | https://api.moonshot.cn/v1 | `MOONSHOT_API_KEY` | `moonshot-v1-8k` | （未收录） |
| `zhipu` | https://open.bigmodel.cn/api/paas/v4 | `ZHIPU_API_KEY` | `glm-4-flash` | （未收录） |
| `ollama` | http://localhost:11434/v1 | `OLLAMA_API_KEY` | `qwen2.5:7b` | （未收录） |
| `custom` | （需手填） | `LLM_API_KEY` | — | （未收录） |

## 2. 任务预算与上限

### 2.1 全局默认（`.env` 或代码默认）

| 参数 | 当前值 | 说明 |
|---|---|---|
| `DEFAULT_MAX_STEPS` | 12 | 单任务最大 Agent Loop 步数 |
| `DEFAULT_MAX_MODEL_CALLS` | 20 | 单任务最大模型调用次数 |
| `DEFAULT_MAX_TOOL_CALLS` | 40 | 单任务最大工具调用次数 |
| `DEFAULT_TOTAL_TIMEOUT_MS` | 120000 | 单任务总超时 |
| `DEFAULT_TOKEN_BUDGET` | 200000 | 单任务累计 token 预算（输入+输出） |
| `DEFAULT_COST_BUDGET_USD` | 0 | 单任务费用预算（0 = 不限） |
| `MAX_TOOL_CONCURRENCY` | 4 | 工具级并发上限 |

### 2.2 杂项 Agent（misc）

| 参数 | 当前值 | 说明 |
|---|---|---|
| `MISC_MAX_STEPS` | 6 | 默认步数（请求只能收紧） |
| `MISC_MAX_MODEL_CALLS` | 6 | 默认模型调用上限 |
| `MISC_MAX_TOOL_CALLS` | 10 | 默认工具调用上限 |
| `MISC_TOKEN_BUDGET` | 50000 | 默认 token 预算 |
| `MISC_HARD_MAX_STEPS` | 12 | **硬上限**：请求放大也会被压回 |
| `MISC_SCAN_LIMIT` | 5000 | 目录扫描条目上限 |
| `MISC_MAX_FILE_BYTES` | 262144 | 单文件读取上限（字节） |
| misc 默认生成参数 | `{"temperature":0,"thinking":"disabled","maxTokens":1500}` | 琐事默认关思考：更省更快 |

### 2.3 多 Agent 编排（orchestrator / subagent）

| 参数 | 当前值 | 说明 |
|---|---|---|
| `SUBAGENT_MAX_CONCURRENCY` | 4 | 子任务并行度（有界池） |
| `SUBAGENT_MAX_WIDTH` | 4 | 单次派发子任务数上限 |
| `SUBAGENT_MAX_DEPTH` | 1 | 层级深度（1 = 子 Agent 不能再委派） |
| `SUBAGENT_RESULT_CHARS` | 800 | 子任务结果回传主 Agent 的字符上限 |
| `ORCH_MAX_STEPS` | 8 | 主 Agent 步数上限 |
| `ORCH_MAX_MODEL_CALLS` | 12 | 主 Agent 模型调用上限 |
| `ORCH_MAX_TOOL_CALLS` | 12 | 主 Agent 工具调用上限 |
| `ORCH_TOKEN_BUDGET` | 200000 | 主 Agent token 预算（子 Agent 预算另计） |
| `ORCH_TOTAL_TIMEOUT_MS` | 300000 | 编排任务总超时 |
| `ORCH_ALLOW_SELF_TOOLS` | false | 主 Agent 是否也能用只读工具 |

### 2.4 子 Agent 契约预算（每个子 Agent 独立计提，互不侵占）

| 契约 id | 步数 | 模型调用 | 工具调用 | token 预算 | 超时(ms) | 工具白名单 | 权限 |
|---|---|---|---|---|---|---|---|
| `dir-inventory` | 8 | 8 | 16 | 60000 | 90000 | `dir_stats` `list_files` `read_file` `submit_finding` | `misc:read` `codebase:read` `agent:report` |
| `code-audit` | 12 | 12 | 24 | 120000 | 150000 | `search_files` `list_files` `read_file` `submit_finding` | `codebase:read` `agent:report` |
| `doc-research` | 8 | 10 | 16 | 80000 | 120000 | `web_search` `fetch_page` `extract_evidence` `knowledge_search` `submit_finding` | `research:web` `research:read` `knowledge:read` `agent:report` |
| `code-edit` | 12 | 12 | 24 | 120000 | 600000 | `search_files` `read_file` `list_files` `run_tests` `create_file` `edit_file` `delete_file` `copy_path` `run_command` `submit_changes` `submit_finding` | `codebase:read` `codebase:test` `codebase:write` `agent:report` |
| `codex-code` | 6 | 6 | 8 | 60000 | 900000 | `codex_exec` `submit_finding` | `codex:exec` `agent:report` |

### 2.5 写能力 / Docker 沙箱 / 人工审批（M1/M1'：默认可用；写操作需本 run 显式授权 + 审批）

| 参数 | 当前值 | 说明 |
|---|---|---|
| `CODEBASE_WRITE_ENABLED` | true | 写能力总门禁（默认 true，可显式 false 整机禁用；关时写工具一律 DISABLED，fail-closed）。实际写操作还须：本 run 界面授权 `orchestration.allowWriteSpecs`（默认不勾）+ 沙箱阶梯 + 人工审批 |
| `APPROVAL_ENABLED` | true | 审批门禁开关（写能力开启后生效） |
| `APPROVAL_TIMEOUT_MS` | 300000 | 挂起审批超时（**超时按拒绝**；等待期暂停预算计时，不算进任务超时） |
| `APPROVAL_MAX_DENIES` | 3 | 同一文件连续拒绝上限（**按文件计数**，达上限强制收尾） |
| `APPROVAL_MAX_FILES` | 10 | 单次审批的 change set 文件上限（一个 change set 一次审批，防打断疲劳） |
| `SANDBOX_IMAGE` | `mta-sandbox:node24` | 沙箱镜像（docker cp 快照 + L0/L1/L2 阶梯；**不用 bind mount**） |
| `HOST_NODE_PATH` | `D:/Program Files/nodejs/node.exe` | 宿主复验钉死的系统 Node 绝对路径（不存在则复验跳过并如实标注） |
| `SANDBOX_EXEC_TIMEOUT_MS` | 600000 | 沙箱/宿主单条命令超时上限 |

## 3. 实时流式展示

| 参数 | 当前值 | 说明 |
|---|---|---|
| `STREAM_LIVE_DELTAS` | false | 是否推送文本增量（服务端入口默认开，测试默认关） |
| `MOCK_STREAM_CHUNK_DELAY_MS` | 0 | 仅 Mock：分片演示延迟（真实 Provider 不受影响） |
| `STREAM_CHUNK_CHARS` | 18 | 单个增量分片字符数 |
| `STREAM_HEARTBEAT_MS` | 15000 | SSE 心跳间隔 |
| `STREAM_WATCHDOG_MS` | 2000 | SSE 看门狗轮询间隔（补漏 + 终态收尾） |
| `STREAM_DEBUG` | false | SSE 帧级调试日志 |

## 4. 工具与权限矩阵（注册 → 披露 → 授权）

| 工具 | 所需权限 | 归属 Agent（按 runType 披露） |
|---|---|---|
| `search_files` | `codebase:read` | codebase |
| `read_file` | `codebase:read` | codebase |
| `list_files` | `codebase:read` | codebase |
| `run_tests` | `codebase:test` | codebase |
| `web_search` | `research:web` | research |
| `fetch_page` | `research:web` | research |
| `extract_evidence` | `research:read` | research |
| `compare_sources` | `research:read` | research |
| `knowledge_search` | `knowledge:read` | — |
| `dir_stats` | `misc:read` | misc |
| `submit_result` | `misc:report` | misc |
| `submit_finding` | `agent:report` | 子 Agent（各契约内声明） |
| `delegate_subtasks` | `orchestrator:delegate` | orchestrator（主） |
| `submit_orchestration` | `orchestrator:report` | orchestrator（主） |
| `ask_user` | `agent:ask` | — |
| `codex_exec` | `codex:exec` | — |
| `create_file` | `codebase:write` | — |
| `edit_file` | `codebase:write` | — |
| `delete_file` | `codebase:write` | — |
| `copy_path` | `codebase:write` | — |
| `run_command` | `codebase:write` | — |
| `submit_changes` | `codebase:write` | — |

> 已注册工具总数：22；上表由 `TOOL_PERMISSION`（权限唯一事实来源）生成。

## 5. 错误报告与日志

| 参数 | 当前值 | 说明 |
|---|---|---|
| `ERROR_LOG_PATH` | `./data/errors.log` | 结构化错误报告落盘（JSONL，可 grep） |
| `RUN_DIGEST_PATH` | （留空 = 跟随 SQLite 目录） | 每次 run 终态的复盘摘要（JSONL，一行一个 run） |
| `LOG_MAX_CONTENT_CHARS` | 2000 | 事件里字符串截断上限（防日志膨胀） |
| `LOG_TOOL_RESULTS` | false | 是否把工具结果正文打进日志 |

## 6. 存储与其它

| 参数 | 当前值 | 说明 |
|---|---|---|
| `SQLITE_PATH` | `./data/runtime.db` | SQLite 路径 |
| `PORT` | 3000 | HTTP 端口 |
| `CODEBASE_RUN_TESTS_ENABLED` | false | 是否允许 run_tests 真正执行命令 |
| `ALLOWED_TEST_COMMANDS` | `npm test` `node --test` `npx vitest run` | 测试命令白名单 |
| `SEARCH_PROVIDER` | offline | 搜索提供方（offline / serper） |
| 搜索 Key 是否已配置 | ❌ 未配置 | 无 Key 时走 OFFLINE_MOCK（明确标注） |

---

## 维护说明

- **改参数**：改 `src/config.ts` 默认值 或 `.env`，然后 `npm run report:params` 重新生成本文件。
- **记原因**：在 `reports/CHANGELOG.md` 的「参数变更」里加一行（日期 / 参数 / 旧值 → 新值 / 为什么）。
- **看现状**：`reports/PROJECT_REPORT.md` 是给人读的总报告（能力 / 指标 / 风险 / 下一步）。
- 本文件**不做漂移门禁**：它的值随环境变化（例如 `.env` 里配了 Key），属于"当前生效值快照"，不是契约。
