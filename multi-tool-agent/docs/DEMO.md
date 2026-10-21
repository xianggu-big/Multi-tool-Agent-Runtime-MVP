# 演示与真实运行结果（DEMO）

> 以下结果均来自本环境**实际运行**（`tsx` 加载，内存 SQLite，Mock LLM）。未做任何结果编造。

## 1. 运行方式

```bash
# 方式 A：命令行演示脚本（推荐先看这个）
npm run demo:codebase     # Codebase Agent
npm run demo:research     # Research Agent

# 方式 B：HTTP 服务 + 前端
npm start                 # 打开 http://localhost:3000
# 通过 POST /api/runs 并指定 mockScenario=codebase-basic|research-basic

# 方式 C：直接对 API 发请求（见 §3）
```

环境变量：`SQLITE_PATH=:memory:`（演示用），`LLM_MODE=mock`（默认）。

## 2. 演示结果（真实）

### 2.1 Codebase Agent 演示

命令：`npm run demo:codebase`

- 目标：分析示例仓库（`demo/codebase-sample`）的加法与字符串工具，并运行受限测试。
- 工具链：`search_files` → `read_file(src/calc.js)` → `run_tests(node --test)`。
- 真实结果：

| 字段 | 值 |
| --- | --- |
| runId | `run_mv531hn9_a26a20b2` |
| status | `completed` |
| steps | 4 |
| modelCalls | 4 |
| toolCalls | 3 |
| totalMs | ~457 |
| isMock | `true` |
| run_tests | `node --test` 命中白名单，`shell:false` 子进程，示例仓库 **6/6 测试通过** |

示例仓库自身测试：`node --test` → `tests 6 / pass 6 / fail 0`。

### 2.2 Research Agent 演示

命令：`npm run demo:research`

- 目标：比较 esbuild 与 Rollup 的定位与特性。
- 工具链：`web_search`(OFFLINE_MOCK) → `extract_evidence` → `compare_sources`。
- 真实结果：

| 字段 | 值 |
| --- | --- |
| runId | `run_mv531ilw_c7e2e904` |
| status | `completed` |
| steps | 4 |
| modelCalls | 4 |
| toolCalls | 3 |
| totalMs | ~11 |
| isMock | `true` |
| 搜索来源 | **OFFLINE_MOCK**（离线资料集，明确标注 `非实时联网`） |

> 重要：`web_search` 在默认配置下返回的是**离线资料（OFFLINE_MOCK）**，报告首行即注明「基于 MOCK 离线资料，非实时联网」。这不是伪造的实时搜索结果，而是显式标注的占位数据。启用真实搜索需 `SEARCH_PROVIDER=serper` + `SEARCH_API_KEY`（未在本环境验证）。

## 3. 通过 HTTP API 的运行结果（真实）

启动 `npm start`（默认端口 3000），发请求：

- `POST /api/runs` + `mockScenario=codebase-basic` → 返回 `runId`，随后 `GET` 得到 `status=completed, steps=4, modelCalls=4, toolCalls=3, isMock=true`。
- `POST /api/runs` + `mockScenario=research-basic` → `status=completed, steps=4, modelCalls=4, toolCalls=3, isMock=true`。
- `GET /api/runs/:id/stream` → SSE 实时推送 `run_started / model_request / tool_call_requested / tool_started / tool_completed / run_completed` 等事件。
- `POST /api/runs/:id/cancel` → 已完成的任务返回 `{"cancelled":false}`（符合预期：终态不可取消）。

## 4. 前端界面：直接在页面上配 API

启动 `npm start` 后打开 http://localhost:3000 ，左侧面板展开 **「API 配置（LLM / 搜索）」**：

- **LLM 模式**选 `OpenAI 兼容接口`，填入 API Key / Base URL / 模型 → 点「开始任务」即发起**真实调用**。
- **搜索提供方**选 `Serper（真实联网搜索）`，填入 Serper API Key → Research Agent 走真实搜索。
- 面板会显示 `.env` 是否已配置对应 Key（只显示「已配置/未配置」，不回传 Key）；界面留空则沿用 `.env`。
- 可选勾选「在本浏览器保存 Key」（写入本机 `localStorage`，默认不勾选）。

实测（本环境，无 Key）：

| 请求 | 结果 |
| --- | --- |
| `GET /api/config` | `{"llmMode":"mock","hasOpenAIKey":false,"openaiModel":"gpt-4o-mini",...}`（无任何 Key 字段） |
| `POST /api/runs` + `llm:{mode:"openai"}`（无 Key） | **HTTP 400** `已选择 OpenAI 模式但未提供 API Key：请在界面填写，或设置 OPENAI_API_KEY 环境变量。` |
| `POST /api/runs` + `search:{provider:"serper"}`（无 Key） | **HTTP 400** `已选择 Serper 真实搜索但未提供 API Key：...` |
| `POST /api/runs` + 合法 `repoPath` + mock 剧本 | **HTTP 201**，随后 `status=completed, steps=4, toolCalls=3, isMock=true` |

> **不静默降级**：选了真实 Provider 却没给 Key 时，服务端明确报错，不会偷偷用 Mock 结果冒充真实调用。
> **Key 不落盘**：仅用于该次运行，不写 SQLite、不写事件日志（已脱敏）。但本地 HTTP 无 TLS，传输层为明文，请勿暴露到公网。

## 5. 如何自行复现

```bash
SQLITE_PATH=:memory: npm run demo:codebase
SQLITE_PATH=:memory: npm run demo:research
# 或
npm test          # 18 个场景、49 个子测试全部通过（见 TEST_REPORT.md）
```
