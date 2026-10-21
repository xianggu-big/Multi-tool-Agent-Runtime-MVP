# 全面代码审查报告（CODE REVIEW）

> **对象**：`multi-tool-agent`（Multi-tool Agent Runtime MVP）
> **日期**：2026-10-13（晚）
> **方法**：静态通读 `src/` 全部 12 个模块 ≈ 12k 行 + 探针实证 + **20 个对抗性子测试**（`tests/32_adversarial.test.ts`，七大类：SSRF / 命令白名单 / 路径穿越 / HTTP 输入 / 并发 / 性能 / 逻辑漏洞）
> **基线**：审查前 203/203 通过；审查后 **223/223 通过**、typecheck 0 错误、`agents:lint` 通过
> **复现**：`node --import tsx --test tests/32_adversarial.test.ts`（须用 Node 24，better-sqlite3 ABI 约束）

---

## 1. 整体架构与模块划分

一套**共享 Agent Loop**（`AgentRuntime.loopBody`）驱动四种 Agent，所有安全策略在结构层强制，不依赖模型自觉。

| 模块 | 职责 | 关键文件 |
|---|---|---|
| `runtime/` | 共享 Loop、预算/步骤/超时/权限/取消/检查点、resume、上下文压缩、子 Agent 池 | `AgentRuntime.ts`（1283 行）、`Budget.ts`、`StateMachine.ts`、`SubAgentPool.ts` |
| `tools/` | 11 个工具 + Registry 安全边界（未知工具→权限→Zod→超时→异常规范化） | `Registry.ts`、`codebase/`、`research/`、`misc/`、`shared/` |
| `llm/` | 多 Provider（7 预设）、Mock、流式、连接测试、生成参数 | `OpenAIProvider.ts`、`MockProvider.ts`、`params.ts` |
| `knowledge/` | Repository（FTS5）+ VectorRecall（sqlite-vec）+ HistoryStore + ContextStore | `repository.ts`、`vectorRecall.ts` |
| `store/` | SQLite 持久化（runs/events/checkpoints，参数化 SQL） | `SqliteStore.ts` |
| `trace/` | 双通道事件流：EventLogger 批量落盘 + LiveHub 实时快车道（SSE） | `EventLogger.ts`、`LiveHub.ts`、`Tracer.ts` |
| `server.ts` | HTTP API + SSE 三段式（订阅→回放→看门狗） + 输入校验纯函数 | `validateRunRequest` |
| `agents/` | 子 Agent 契约（specs.ts 为事实来源，文档生成 + lint 门禁） | `specs.ts` |

**状态机**：`queued → running → (waiting_tool ↔ running) → 终态`；`failed/limit_reached` 可 resume。

---

## 2. 核心功能实现状态

| 功能 | 状态 | 说明 |
|---|---|---|
| 共享 Agent Loop + 四 Agent | ✅ 实测可用 | 预算/权限/超时/取消/检查点统一强制 |
| Tool Registry 安全边界 | ✅ 可用 | 未知工具/越权/坏参数均明确拒绝（本次回归守卫验证） |
| 路径穿越防护 | 🟡 词法层完整 | `../`、绝对路径、工作区相对形态都正确处理；**符号链接层未防**（见 P1-2） |
| SSRF 防护 | 🟡 主体完整 | 私网/元数据/白名单/后缀混淆均拦截；**尾点 FQDN 被绕过**（见 P0-2） |
| 命令执行白名单 | 🔴 设计缺陷 | 前缀匹配 → 任意文件读/任意代码执行（见 P0-1） |
| 多 Agent 编排 | ✅ 可用 | 宽度≤4、深度≤1、契约驱动、批次回调保序 |
| 知识库检索 | 🟡 降级可用 | 关键词走 LIKE（能用）；**FTS5/vec0 原生路径是死代码**（见 P1-3/P1-4） |
| 实时流式 + 监控 | ✅ 可用 | 推送延迟 P50=P95=0ms |
| 错误报告 | ✅ 可用 | 四要素 + 三落点；`enqueue` 的 rejection 已接 catch |
| HTTP 服务 | 🟡 本地定位 | 全部端点无鉴权（README 已声明）；`/resume` 有崩溃路径（见 P1-1） |

---

## 3. 测试方案与执行结果

### 3.1 对抗性测试矩阵（`tests/32_adversarial.test.ts`，20/20 通过）

| # | 类别 | 测试 | 结论 |
|---|---|---|---|
| A1 | SSRF | checkUrl 24 个危险目标（含缩写 IP `127.1`/`0x7f000001`/`2130706433`——URL 构造器会规范化故被正确拦） | ✅ 回归守卫 |
| A2 | SSRF | 尾点 FQDN（`localhost.`、`metadata.google.internal.`、`*.internal.`） | 🔴 **绕过（BUG 证据）** |
| A3 | SSRF | 端到端 PoC：本地起 127.0.0.1 服务，`fetch_page` 请求 `http://localhost.:PORT/` | 🔴 **读出本地内容（SSRF 成立）** |
| B1 | 命令 | 非白名单命令（`cat`、`node -e`、`curl`）被拒；未启用时 DISABLED | ✅ 回归守卫 |
| B2 | 命令 | `node --test <任意路径>`：`.ini` 文件内容回显 + `.js` 顶层代码执行 | 🔴 **任意文件读 + RCE（BUG 证据）** |
| C1 | 路径 | `assertInsideRepo`/`resolveWorkspacePath` 越权即拒（不泄露外部路径存在性） | ✅ 回归守卫 |
| C2 | 路径 | repo 内 junction → 外部目录，`read_file` 跟随链接读出 | 🔴 **逃逸（BUG 证据）** |
| C3 | 路径 | `SECRET.json`/`.ENV`/`api.Key` 未被判敏感（大小写敏感） | 🟡 BUG 证据 |
| D1 | HTTP | 11 种非法请求形态均被明确拒绝（错误信息点明原因） | ✅ 回归守卫 |
| D2 | HTTP | `tokenBudget:0`/负 maxSteps 等被接受；Budget 层 `tokenBudget=0` = 20 亿 token 不触顶 | 🟡 BUG 证据 |
| D3 | HTTP | `__proto__` 等键不污染原型；contextHistory 裁剪到 10 条×2000 字符；1MB goal 被接受 | 🟡 部分 BUG 证据 |
| E1 | 并发 | 40 个并发 enqueue 全部终态，每 run 事件序号 1..N 连续无缺口 | ✅ 通过（~42ms） |
| E2 | 并发 | 5 run 交错 emit 序号独立连续；ephemeral（llm_delta）不落库 | ✅ 通过 |
| E3 | 并发 | 10 批次 × 100 条并发 appendEvents，条数完整无异常 | ✅ 通过 |
| F1 | 性能 | EventLogger 5 万事件 emit+flush | ✅ **85ms** |
| F2 | 性能 | SqliteStore 单批 2 万条插入 | ✅ **46ms**（全量套件中 122ms） |
| F3 | 性能 | compactMessages 1 万条消息 | ✅ **6ms**，语义正确（system 保留/摘要插入/尾 6 条原样） |
| G1 | 逻辑 | `resume()` rejection 无人捕获 → 子进程复刻 server.ts `void result` 路径 | 🔴 **进程崩溃（退出码非 0）** |
| G2 | 逻辑 | misc 请求 maxSteps=999 被钳制在 hardMaxSteps=12 | ✅ 回归守卫 |
| G3 | 逻辑 | FTS5 多词 AND 查询应命中却返回 0（死路径行为证据）；语义召回对中文短查询空结果 | 🔴 BUG 证据 |

### 3.2 性能实测汇总（本机，Node 24）

| 指标 | 实测值 |
|---|---|
| 5 万事件 emit + flush | 85ms |
| 2 万条单批 SQLite 插入 | 46ms |
| 1 万条消息上下文压缩 | 6ms |
| 40 并发 run 全部终态 | ~42ms |
| 全量测试套件 | 5.6s（223 个子测试） |

---

## 4. 发现的问题（按严重程度分级）

### P0 — 严重（可直接利用）

#### P0-1 `run_tests` 白名单是前缀匹配 → 任意文件读取 + 任意代码执行
- **位置**：`src/tools/codebase/runTests.ts:49` — `allowed.some((a) => args.command.startsWith(a + ' '))`
- **根因**：只校验命令前缀，后缀参数完全自由。`node --test <路径>` 会把目标当测试文件加载。
- **实证**（32b2）：`.ini` 文件 → 语法错误回显首行内容（任意文件读）；`.js` 文件 → 顶层代码直接执行（RCE，实测标记输出）。
- **影响**：默认 `CODEBASE_RUN_TESTS_ENABLED=false` 缓解；一旦启用（其设计用途），任何能影响工具参数的路径（含被注入的模型输出）都可读服务器可读的任意文件、以服务进程权限执行任意 JS。
- **修复**：白名单改为**精确匹配或参数模板**（如仅允许 `node --test` + 仓库内固定测试目录），拒绝一切路径参数；或对后缀参数做仓库内断言。

#### P0-2 SSRF 尾点 FQDN 绕过（含 DNS rebinding 未防）
- **位置**：`src/tools/research/ssrf.ts:56-68`
- **根因**：① WHATWG URL 不规范化尾点，`localhost.` ≠ `localhost`、`metadata.google.internal.` 不命中 `endsWith('.internal')`，而 DNS 解析时尾点被忽略（本机实测 `localhost.` → `::1/127.0.0.1`）；② 只做词法校验，**解析后无 IP 复核**（公网域名解析到私网 IP 可直接穿过；配了白名单可缓解）。
- **实证**（32a2/32a3）：本地起 127.0.0.1 服务，`fetch_page` 经 Registry 请求 `http://localhost.:PORT/` 返回 200 并读出服务内容。
- **修复**：host 先去尾点再校验；`fetch` 前 `dns.lookup` 复核 IP（私网/元数据即拒）；白名单场景同时校验解析 IP。

### P1 — 高（可用性/核心能力受损）

#### P1-1 `resume()` 的 rejection 无人捕获 → 服务进程可被崩溃
- **位置**：`src/runtime/AgentRuntime.ts:254`（`return this.executeLoopFrom(...).finally(...)`，无 `.catch`）+ `src/server.ts` `/api/runs/:id/resume`（`void result`）
- **根因**：`enqueue()` 有显式 `.catch()`（代码注释自称"关键修复"），`resume()` 没有——同一洞修了一半。Node 默认 `--unhandled-rejections=throw` → 恢复执行循环内任何未预期异常都会**崩溃整个服务进程**。
- **实证**（32g1）：子进程复刻该路径，退出码非 0，stderr 为逃逸的 rejection。
- **修复**：`resume()` 内 `.catch((e) => this.handleInternalError(...))`（与 enqueue 对齐），或 server 层 `result.catch(...)` 并落错误报告。

#### P1-2 符号链接 / junction 逃逸（词法检查 + 跟随链接）
- **位置**：`src/tools/codebase/security.ts:5`（`assertInsideRepo` 仅词法）；`readFile/searchFiles/listFiles` 用 `statSync`（跟随链接）
- **实证**（32c2）：repo 内建 junction（Windows 无需管理员权限）指向外部目录，`read_file` 读出外部文件内容。
- **修复**：解析后 `realpathSync` 再过一次 `assertInsideRepo`；或显式拒绝符号链接（`lstatSync` 检测，dir_stats 已是这个做法）。

#### P1-3 FTS5 原生检索是死代码（恒抛错，静默降级 LIKE）
- **位置**：`src/knowledge/repository.ts:239-244`
- **根因**：FTS SQL 缺 `MATCH ?` 子句，且传参（`ftsQuery, limit`）多于占位符（`collection?` + `LIMIT ?`）→ better-sqlite3 恒抛 `RangeError` → catch 后静默降级 LIKE。
- **影响**：宣称的"高效全文检索 / 相关度排序"从未生效；多词 AND 语义丢失（32g3：`foo bar` 命中不了 `foo-bar baz`，LIKE 是整串子串匹配）。数据量上来后检索质量与性能双输。
- **修复**：SQL 改为 `... FROM data_items_fts f JOIN data_items d ON d.rowid = f.rowid WHERE data_items_fts MATCH ? [AND d.collection=?] ORDER BY rank LIMIT ?`，参数对齐；补一条"FTS 路径真实命中"的测试。

#### P1-4 vec0 kNN 是死代码 + 语义召回对中文基本不可用
- **位置**：`src/knowledge/vectorRecall.ts:227-234`
- **根因**：vec0 查询缺 `WHERE v MATCH ? AND k = ?`（KNN 约束），参数同样不匹配 → 恒抛错降级全表扫描；`data_vec` 虚表**只写不读**。叠加 HashEmbedder 按词 + 3-gram 分词，中文短查询（如"漏洞"）与内容词元不重叠 → 余弦为 0 → 召回为空（32g3）。
- **影响**：混合检索的"语义"一侧实际不可用；sqlite-vec 依赖等于白装。
- **修复**：改用 vec0 标准 KNN 语法；中文召回要么换真嵌入器（可注入，接口已在），要么在 HashEmbedder 里加 CJK bigram。

### P2 — 中（输入校验/资源面/信息暴露）

> **2026-10-19 状态**：P2-1~P2-6 已全部修复并转为回归守卫（32c3、32d2~32d6）；本表只剩 **P2-7**。

| # | 问题 | 位置 | 状态 / 证据 |
|---|---|---|---|
| P2-1 | `isSensitive` 大小写敏感 | `security.ts` | ✅ 已修：`toLowerCase()` + 统一清单；32c3 回归守卫 |
| P2-2 | limits 零值/负值不拒 | `server.ts` | ✅ 已修：`parseRunLimits` 正整数/范围校验，0/负/1ms 一律 400；32d2 |
| P2-3 | `goal` 无长度上限 | `server.ts` | ✅ 已修：≤20,000 字符；32d3 |
| P2-4 | `read_file` 整文件读入内存 | `readFile.ts` | ✅ 已修：读前 `statSync.size` >8MiB 直接 `FILE_TOO_LARGE`；32d4 |
| P2-5 | `fetch_page` 忽略 `maxBytes` / 每跳独立超时 | `fetchPage.ts` | ✅ 已修：按 `args.maxBytes` 截断 + 重定向链共享总超时；32d5 |
| P2-6 | `EventLogger.seqByRun` Map 只增不减 | `EventLogger.ts` | ✅ 已修：completed/cancelled 清理；failed/limit_reached 保留以支持 resume；32d6 |
| P2-7 | 全部 HTTP 端点无鉴权 | `server.ts` | ❌ 未修：README 已声明"仅本机"；部署时不要暴露公网，需要时加 token |

### P3 — 低（观察项）

- **P3-1** 工具结果带绝对路径（`read_file` 等）——轻微信息暴露，记录型。
- **P3-2** 仅 DeepSeek 做过真实端到端；`web_search` 默认离线样本——与 PROJECT_REPORT R1/R3 重合。
- **P3-3** 测试基建：`node:test` 父进程会注入 `NODE_TEST_CONTEXT` 被 spawn 的子 `node --test` 继承后自我豁免——仅影响测试环境（32b2 已显式剥离），非产品缺陷。

---

## 5. 做得好的地方（本次回归守卫验证，防回退）

- **Tool Registry 边界**：未知工具、越权、坏参数（附正确示例）全部明确拒绝；超时/异常规范化。
- **词法路径防护**：`../`、绝对路径越权即拒，且不泄露外部路径是否存在；工作区相对形态宽容解析。
- **输入校验**：非法 runType/goal/provider/参数越界/目录不存在均点明原因；`__proto__` 等键不污染原型；contextHistory 裁剪（10 条 × 2000 字符）有效。
- **预算与状态机**：misc 的 `maxSteps` 请求只能收紧不能放宽（hard cap 12 实测生效）；`failed→running` 等转换受状态机约束。
- **并发正确性**：40 并发全部终态、事件序号连续无缺口；ephemeral 事件不落库；批量落库条数完整。
- **性能**：5 万事件 85ms、2 万批量插入 46ms、1 万消息压缩 6ms——量级内无热点。
- **URL 规范化红利**：缩写/十六进制/十进制 IP（`127.1`、`0x7f000001`、`2130706433`）被 URL 构造器规范化后正确拦截；白名单后缀混淆（`allowed.com.evil.com`）正确拒绝。

---

## 6. 修复优先级路线图

| 优先级 | 动作 | 预计收益 |
|---|---|---|
| 1 | P0-1 白名单改精确/模板匹配 | 关掉任意文件读 + RCE 面 |
| 2 | P0-2 尾点剥离 + DNS 解析后 IP 复核 | SSRF 防护真正闭环 |
| 3 | P1-1 resume 补 `.catch`（与 enqueue 对齐） | 消除服务崩溃路径 |
| 4 | P1-2 realpath 复核（或拒链接） | 堵住 junction/symlink 逃逸 |
| 5 | P1-3/P1-4 FTS5/vec0 SQL 修正 + 补"原生路径命中"测试 | 宣称的检索能力真正生效 |
| 6 | P2 组一次性收紧（大小写/正整数/goal 上限/读前预检/maxBytes/seqByRun 清理） | 输入面与资源面收口 |

> 修复后 `tests/32_adversarial.test.ts` 中标「BUG 证据」的断言会失败——那是预期信号：把对应断言改回「回归守卫」形态（断言被拦/被拒/命中），再跑全量。

---

## 7. 复现与验证命令

```bash
# 对抗性套件（20 个子测试，含全部 BUG 证据）
node --import tsx --test tests/32_adversarial.test.ts

# 全量（223 个子测试）
node --import tsx --test "tests/*.test.ts"

# 门禁
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node --import tsx scripts/agents-lint.ts
```

> 注：better-sqlite3 按 Node 24 编译，必须用系统 Node 24（`/d/Program Files/nodejs/node.exe`）；默认 node v22 会 `ERR_DLOPEN_FAILED`。
