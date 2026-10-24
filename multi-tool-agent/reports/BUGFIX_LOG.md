# 故障修复档案（BUGFIX_LOG）

> **用途**：**一个 bug 一条**，固定字段记录「出现什么情况 → 根因 → 改了什么 → 修完到底有没有用」。
> 定期复盘先看 §1 汇总表，再点进对应条目；要细节回查 `reports/CHANGELOG.md`（哪天改的）与 `docs/ERROR_REPORTING.md`（怎么查出来的）。
>
> **与其它文档的分工**：
> - `reports/CHANGELOG.md` = 按时间的**变更流水**（每条改动：背景/改动/影响/验证）
> - `docs/ERROR_REPORTING.md` = **事故叙事**（现象/证据/根因/教训，含排查命令）
> - 本文 = **复盘台账**（一 bug 一行 + 修复前后对照 + 验收命令 + 是否真的复跑过）
>
> **状态图例**：✅ 已修且代码级验证 ｜ 🟡 已修、待真实 run 复跑确认 ｜ ⬜ 未修 / 已知缺口

---

## 0. 本期共同模式（2026-10-20）

| 观察 | 说明 |
|---|---|
| **都不在"正常路径"上** | 三个 bug 分别发生在「压缩之后」「失败之后」「终态之后」——正常路径的测试全部是绿的 |
| **测试只造了"成功路径的输入形状"** | 消息历史只造纯 `user/assistant`（没有工具轮次）、run 只测到 `completed`（不测终态后追加事件） |
| **症状只躺在 events 里** | 用户看到的是「卡住 / 突然失败」，看不到原因；错误报告里也没有（BF-002 就是补这个） |
| **"终态"被当成一个字段，而不是一个动作** | DB 写了 `completed` 就以为结束了，实际后台还在跑、还在弹审批、还在写事件 |

---

## 1. 汇总表

| ID | 日期 | 故障现象 | 影响面 | 根因一句话 | 状态 | 证据 / 回归 |
|---|---|---|---|---|---|---|
| **BF-001** | 10-20 | 跑到中途 `400 Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`，整个 run 作废 | 2 个 run（15:54 / 16:25），合计 **280,618 tokens / $0.0098 / 605s** 白烧 | 上下文压缩按固定 6 条硬切，切在多工具轮次中间 → 留下没有 `tool_calls` 父消息的孤儿 `tool` | ✅ 代码 + 测试<br>🟡 待重启复跑 | `tests/33e/f/g`；`run_mvge1343_49a18777`、`run_mvgf547c_9f77c027` |
| **BF-002** | 10-20 | 模型调用失败（400/5xx/超时）在「错误」页签与 `data/errors.log` 里**完全查不到**，只能手工翻 events | 所有 `MODEL_ERROR`；文档 §2.3 声称有 provider 上报，实际无调用点（虚标） | 主循环 provider catch 只 `tracer.finish` + `finalize`，从未调 `errors.report()` | ✅ 已验证 | `tests/24d`、`24d2` |
| **BF-003** | 10-20 | **卡死几分钟**：run 显示 `completed` 却耗时 662s，中途久无更新，结束后还弹新审批卡 | 1 个 run（662s，两次 300s 审批超时）；事件表 **225 行 / 只有 201 个 seq**（重复序号，回放错乱） | ① `finalize()` 从不 abort run 级 signal → 僵尸子任务继续跑；② `EventLogger` 在 `run_completed` 时清零 seq 计数 → 后续事件从 1 重写 | ✅ 代码 + 测试<br>🟡 待重启复跑 | `tests/57a–d`；`run_mvgejh0e_3e6c9b74` |
| **BF-004** | 10-20 | **能力缺失**：每次 run 结束（尤其成功）几乎无痕迹，过程错误只散在 events 里，没法复盘 | 全部 run（398 条历史） | 终态只写 `runs` 行 + 一条终态事件，没有结构化摘要 | ✅ 已验证 | `tests/56a–e`；`npm run digest:list` |
| **BF-005** | 10-20 | 运维卫生：`data/` 堆了 5 个 .db（每做一次隔离实测就起一个库） | 29 MB；主库之外无活代码引用 | 隔离实测用 `SQLITE_PATH` 另起库，用完没清 | ✅ 已执行 | `ls data/*.db`（5 → 3） |
| **BF-006** | 10-21 | 长任务越跑越「忘事」：压缩后摘要只剩 200 字/条，反复几轮最初目标基本消失；有时每步都压缩 | 所有超过 13 步或多工具轮次、累计 token 水位 ≥60% 的长任务 | ① 压缩触发只看累计 token，无迟滞；② 旧摘要被当普通消息重压，且每条按 200 字符截断 | ✅ 代码 + 测试 | `tests/33h~33l`、`tests/56f`；`context_compacted` / `run_digest.compaction` |
| **BF-007** | 10-21 | 普通认证事故日志 `POST /login with {"email": null, "password": "x"}` 被误报为 `secret-exfiltration` | 含 `send/post + password` 的无害日志、测试输出、仓库文档 | 旧正则只看发送动词和密钥词，没有要求出现收件目的地/URL/邮箱 | ✅ 代码 + 测试 | `tests/53a`；`npm run security:redteam` 数字未回退 |
| **BF-008** | 10-22 | 每次只读代码分析都显示「完成，但过程另有 1 类问题（DISABLED@run_tests）」 | 所有未开启 `CODEBASE_RUN_TESTS_ENABLED` 的 codebase run；UI 主路径默认命中 | `run_tests` 默认关闭，但仍留在工具池里，模型先调用再拿 `DISABLED` | ✅ 代码 + 测试 | `tests/61`；HTTP 对照 `run_mvj11vsd_b69fab7c`（3 步/无问题） vs `run_mvj11wf7_5fcb6e21`（4 步/无问题） |
| **BF-009** | 10-22 | Research 演示里 `compare_sources.items` 是一堆 JSON 碎片（`{"ok":true,"data":...`） | `demo:research`、以及任何把 `web_search` 原始 JSON 传给 `extract_evidence` 的 run | `extract_evidence` 按句子切分输入；JSON 没有中文句号/换行结构，被切成碎片 | ✅ 代码 + 测试 | `tests/60`（4 例）；修复后演示参数为正常标题与句子 |
| **BF-010** | 10-22 | GitHub Actions 上 `npm test` 失败（run `39549359352`），本机却全绿 | 远端 CI 一直是红的；对外不能声称 CI 绿 | Windows 工作区 `agents/*.md` 是 CRLF，生成器输出 LF；`tests/23d` 严格比较字符串 | ✅ 代码 + 容器复现 | `tests/23d`；`a698c71` + 补丁在 `node:24` 容器跑出 395 通过 / 1 跳过 / 0 失败 |
| **BF-011** | 10-22 | 真实模型编辑评测首轮显示 20/20，但 R04/R11/R14 的 `setup` 没真正注入缺陷；R11 又因等价写法被判失败 | 首轮 20 条结论不可信；若直接对外会虚报模型编辑能力 | fixture 是 CRLF，`setup.find` 按 LF 写，`String.replace` 静默未命中；源码断言只认一种写法 | ✅ 已验证 | 首轮证据 `data/edit-eval-real/20261022-130617-398/R11/result.json`；修复后重跑 `data/edit-eval-real/20261022-131513-248/` = 20/20 |
| **BF-012** | 10-23 | 契约门禁对动态工具静默失效：`mcp_*` 没有权限映射也能过 lint；`maxRiskLevel` 只写进文档、从未校验 | 接 MCP 后可能漏授权/误放高危工具；文档显示 safe 而实际工具是 high | `validateSpecs` 用 `toolPermission[t]` 后 `filter(Boolean)` 丢掉未知工具；风险字段没有消费点 | ✅ 已验证 | `tests/62a~62c`；Linux `node:24` 容器 `agents:lint` + 全量测试通过 |
| **BF-013** | 10-23 | 长任务中画面突然卡死、恢复后一次性补出大量内容；服务端其实一直在跑 | 所有长回答/多轮任务，切到事件流页签更严重 | 每条 `llm_delta` 强制 append + 滚动布局；`flushCards` 每帧重写全文；事件列表无上限 | ✅ 代码 + 结构性回归（未做浏览器 Performance 量化） | `tests/59d`、`tests/63a/63b`；服务端 24ms 合并、前端 500 条上限/增量 append/10fps 滚动 |
| **BF-014** | 10-23 | 远端 CI 在 Node 24.21.0 上 `npm test` 红：原生断言 `RemoveEnvironmentCleanupHook ... Assertion failed: (env) != nullptr`，7 个测试文件被连带判红 | 所有 CI 任务；不是业务断言失败，容易被误判成代码回归 | `better-sqlite3 11.10.0` 的 `Statement` 析构在 Node 24.21 进程退出阶段触发原生断言 | ✅ 已验证 | `.github/workflows/ci.yml` 钉 `node-version: '24.22.0'`；run `39901350247` 全绿（失败 run `39900764434`） |
| **BF-015** | 10-24 | 定时任务可以传入普通 API 不允许的预算值（负数/超大/非法字符串），绕过统一边界 | 所有定时任务；可能把单次 run 预算放大到无上限 | `parseScheduleRequest` 只检查 `options` 是对象，没有复用 `parseRunLimits` / `parseGenerationParams` 的边界 | ✅ 代码 + 测试 | `tests/69f`；`src/runtime/runLimits.ts` |
| **BF-016** | 10-24 | 服务默认监听所有网卡且无鉴权，同网段任何人都能创建 run / 读事件 / 调 MCP | 所有默认部署；P2-7 从 2026-10-13 起一直挂着 | Express `app.listen(port)` 未指定 host；HTTP 层没有认证中间件 | ✅ 代码 + 测试 | `tests/73a/73b`；`src/config.ts`、`src/server.ts` |
| **BF-017** | 10-24 | 无人值守的 MCP destructive 只会硬拒绝，用户事后无法决定是否执行 | 所有定时任务里的 MCP 写操作；能力被直接砍掉 | bridge 在 `autoPolicy` 分支之前就走 `requestApproval`，没有待确认队列分支 | ✅ 代码 + 测试 | `tests/44i`、`tests/74`；`src/mcp/bridge.ts`、`src/runtime/PendingActionService.ts` |
| **BF-018** | 10-24 | 知识库删空后检索抛 `FlatIndex 查询维度不一致：256 vs 0`，语义/混合检索 500 | 空知识库、或删除最后一条文档后的所有语义/混合查询 | 空索引 `dim=0` 仍校验查询维度；RAG 管线空 chunks 仍执行 embedding + 向量检索 | ✅ 代码 + 测试 | `tests/79e`、`tests/28` 删除用例；`src/knowledge/vectorIndex.ts`、`ragPipeline.ts` |
| **BF-019** | 10-24 | 新库上 `ingest-docs --replace` 报 `no such table: data_vec`，整个替换事务回滚 | 统一后新建/已清理 `data_vec` 的库；文件删改后无法用 `--replace` 重导 | 事务内无条件 `prepare('DELETE FROM data_vec …')`；旧轨时代 Hub 构造必建表，统一后不再建 | ✅ 代码 + 测试 | `tests/79h`；`scripts/ingest-docs.ts` |

---

## 2. BF-001 上下文压缩切出「孤儿 tool」→ 400

**现象**：前端错误卡片 `模型调用失败: OpenAIProvider(流式) 返回 400: {"error":{"message":"Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"}}`；run 直接 `failed`。

**定位**（当时只有 events，没进错误报告）：

```sql
-- ① 看消息数有没有突降（突降 = 压缩刚跑过）
SELECT json_extract(dataJson,'$.inputs.step'), json_extract(dataJson,'$.inputs.messageCount')
FROM events WHERE runId='run_mvge1343_49a18777' AND type='model_request' ORDER BY seq;
-- 结果：step13=54 → step14=12 → step15=12 → step16=12（失败）

-- ② 看当时真正发出去的请求体（终态前最后一个 checkpoint）
SELECT step, messagesJson FROM checkpoints WHERE runId='run_mvge1343_49a18777';
-- 角色序列：s, u(摘要), t(孤儿), u, a[2], t, t, u, a[2], t, t, u
```

**影响面**：`run_mvge1343_49a18777`（15 步 / 27 工具 / 130,380 prompt tokens / 486s），`run_mvgf547c_9f77c027`（10 步 / 17 工具 / 143,883 tokens / 119s，跑在未重启的旧进程上）。两者都是跑到后半程才炸，前面的工作全部作废。

**根因**：`compactMessages()` 用 `keepFrom = messages.length - COMPACT_KEEP_TAIL(6)` 硬切。真实 run 每轮是「assistant(tool_calls×2) + tool + tool + 边界提示」，6 条尾巴正好切在一组工具中间：assistant 进了摘要，第二条 tool 结果留在尾部 → 尾部首条业务消息就是孤儿 `tool`。OpenAI 兼容协议要求每条 `tool` 必须应答某个 `tool_calls`，DeepSeek fail-fast 400；4xx 不重试（判断正确），run 直接 failed。

**修复**：新增 `alignCompactCut()` —— 切点必须落在**轮次边界**：遇 `role:"tool"` 向后推（丢的是被摘要那一轮的残余结果）；尾部全是 tool 时回退到最近一条 assistant，找不到则 no-op。参数未改（`0.6` / `6`）。

**修后效果**：

| 验收项 | 修前 | 修后 | 怎么验 |
|---|---|---|---|
| 压缩后有无孤儿 tool | 有（step16 400） | 无（`tests/33e` 复刻故障形态通过） | `npm test -- tests/33` |
| 长任务（≥13 步、多工具）能否跑完 | 压缩后下一步必炸 | 待真实复跑 | 重启后跑一个长任务，`SELECT ... messageCount` 出现突降且 `status != failed` |

**遗留**：R23（摘要套摘要的衰减）已于 2026-10-21 修复（见 BF-006）；BF-001 只保留切点对齐的职责。

---

## 3. BF-002 模型失败不进错误报告（文档虚标）

**现象**：排查 BF-001 时，`/api/errors?runId=...` 与 `grep tool_calls data/errors.log` 都是空——`errors.log` 里 47 行没有一条 provider 相关。

**定位**：`grep -rn "source: 'provider'" src/` → **零命中**。`ErrorSource` 枚举声明了 8 个来源，但 `provider` 从来没有 `errors.report()` 调用点；文档 §2.3 却写着「provider｜模型调用失败｜MODEL_ERROR + 状态码 + 响应片段」。

**影响面**：**所有**模型调用失败（400/5xx/超时/鉴权）都只留一条 `run_failed` 事件；错误页签与 JSONL 完全静默。

**根因**：主循环 provider catch 里只有 `tracer.finish` + `finalize`，漏了 `this.errors.report()`。

**修复**：catch 非取消分支补 `errors.report({ source:'provider', phase:'llm.chat', code:'MODEL_ERROR', context:{provider, model, step, messageCount, toolCount, contextUseRatio, status?, suspect?} })`；`suspect="invalid_message_sequence"` 用协议文案识别「孤儿 tool」，让 hint 直接指向压缩而不是 Key/网络。`hintFor('MODEL_ERROR')` 改为先分诊。

**修后效果**：

| 验收项 | 修前 | 修后 | 怎么验 |
|---|---|---|---|
| 400 是否出现在错误报告 | 否 | 是（`source=provider`，带 `status/step/messageCount`） | `tests/24d2`（JSONL 落盘断言） |
| 排查顺序 | 只能翻 events | hint 直接说「先看 messageCount 突降」 | `GET /api/errors?source=provider` |
| 历史数据 | — | **不回填**（只有新 run 才有） | — |

**遗留**：子 Agent 内部的模型失败仍不单报（`subAgentLoop` 没有注入 `ErrorReporter`），只体现为 `subtask_failed`——已写入 `docs/ERROR_REPORTING.md` §2.7。

---

## 4. BF-003 僵尸子任务 + 事件 seq 重号（「卡死几分钟」）

**现象**：用户原话「出现莫名其妙的卡死长时间不动」。`run_mvgejh0e_3e6c9b74` 最终状态 `completed`，但耗时 **662 秒**；结束后还弹出新的审批卡。

**定位**（时间线全部可复算）：

```sql
SELECT seq, type, substr(timestamp,12,8) FROM events
WHERE runId='run_mvgejh0e_3e6c9b74' ORDER BY timestamp;
-- 主 run 08:20:06 run_completed；08:21:36 approval_decided；08:21:51 approval_requested；08:27:04 subtask_completed

SELECT count(*), count(DISTINCT seq) FROM events WHERE runId='run_mvgejh0e_3e6c9b74';
-- 225 | 201  ← 同一 run 出现重复序号
```

| 时刻(UTC) | 事件 | 说明 |
|---|---|---|
| 08:11:12 | `approval_requested` | 子任务提交 → 第一张审批卡 |
| 08:13:24 | `delegate_subtasks` **tool_failed** | 工具超时（`withTimeout` 只是 race 一个 reject） |
| 08:16:36 | `approval_requested` | 重派 → 第二张卡 |
| **08:20:06** | **`run_completed`** | 主 run 已终态（seq 201） |
| 08:21:36 | `approval_decided` | 僵尸子任务的审批才因 300s 超时被拒 |
| 08:21:51 | `approval_requested` | 它又提交一次、又弹一张卡 |
| 08:27:04 | `subtask_completed` | 子任务终于结束，事件已从 `seq=1` 重写 |

**影响面**：1 个 run 白等 662s（其中 600s 是两次审批超时）；事件流重复 seq 会让回放、前端排序、增量拉取游标全部失真（历史库中其它 run 也可能有，未回补）。

**根因**：
1. `finalize()` 从不 abort run 级 `AbortController` —— 主循环收尾后，在飞子任务与审批等待继续活着；工具超时只结束「等待」，不结束「执行」。
2. `EventLogger` 的 `FORGET_SEQ_ON` 在 `run_completed/run_cancelled` 时删掉 seq 计数 —— 终态后追加的事件从 1 重新编号，与历史撞号。

**修复**：

| 改动 | 位置 |
|---|---|
| 终态即取消：`finalize()` 开头 abort 该 run 的 controller | `AgentRuntime.finalize` |
| 审批响应 abort：`requestApproval` 监听 run signal，结束/取消立即 `deny(actor:"run-finished")`，不再等 300s | `AgentRuntime.requestApproval` |
| 批次级取消：`SpawnSubAgent` 支持 `opts.signal`；`delegate_subtasks` 自管 240s 批次超时并 abort 该批；`AbortSignal.any` 与 run signal 取并集 | `tools/types.ts`、`delegateSubtasks.ts`、`buildSpawnSubAgent` |
| seq 不再清零：按 run 保留计数 + LRU 上限（默认 2000，`maxTrackedRuns` 可配） | `EventLogger.rememberSeq` |

**修后效果**：

| 验收项 | 修前 | 修后 | 怎么验 |
|---|---|---|---|
| 终态后是否还有在飞工作 | 有（跑到 +7 分钟） | 无（`finalize` 即 abort） | `tests/57a` |
| 终态后弹审批卡 | 会（等 300s） | 立即自动拒绝（`actor=run-finished`） | `tests/57b/57d` |
| 事件序号是否连续 | 225 行 / 201 seq | 终态后仍顺延（不再回 1） | `tests/57c`；`SELECT count(*), count(DISTINCT seq)` 应相等 |
| 工具超时后子任务是否停下 | 否（继续烧 token） | 是（批次 abort） | 重启后跑编排任务，看是否有 `cancelled` 子任务 |

**遗留**：历史库中已有的重复 seq **未回补**（只影响回放观感，不影响执行）；`subtask_completed` 晚于 `run_completed` 的历史事件保留原样。

---

## 5. BF-004 每次 run 结束没有复盘记录（能力补齐）

**现象**（用户原话）：「每次任务流程结束后无论成功或者失败都要记录，失败的更要记录……成功和失败中出现的错误问题都要记录，我每次都要查看的」。

**根因**：终态只写 `runs` 行 + 一条终态事件；过程中的工具失败、子任务失败、审批拒绝、验证失败散落在 events 里，成功 run 几乎没有痕迹。

**修复**：`run_digest` —— 每次终态（含启动回收的 `RUN_INTERRUPTED`）自动写「结论 + 计数 + 过程问题聚合（含次数/首末 seq/首条消息）+ `firstIssue` + 一句话 `headline`」；三落点：`run_digests` 表 / `data/run-digest.jsonl` / `run_digest` 事件；查看 `npm run digest:list`、`GET /api/digests`、`GET /api/runs/:id/digest`。

**修后效果**：

| 验收项 | 修前 | 修后 | 怎么验 |
|---|---|---|---|
| 成功 run 有记录 | 无 | 有（「完成，但过程另有 N 类问题」） | `tests/56a` |
| 失败 run 的过程错误 | 只有一行 `failureReason` | `issues[]` 聚合 + `firstIssue` | `tests/56b` |
| 被进程杀掉的 run | 只有一行 failed | 启动回收补 `RUN_INTERRUPTED` 摘要 | `tests/56d` |
| 日常查看 | 手工 SQL | `npm run digest:list` | 重启后每跑一次就多一条 |

**遗留**：历史 398 个 run **不回填**（查不到会 404 并说明）；前端暂无展示面板（CLI + API 可用）。

---

## 6. BF-005 运维：`data/` 多库堆积（非代码 bug，记录备查）

**现象**：`data/` 下有 5 个 `.db`（runtime / ab-test / m1-e2e / eval-test / agent），共 29 MB。

**根因**：隔离实测用 `SQLITE_PATH=./data/xxx.db` 另起库（避免污染主库统计），用完没清理。

**处理**：删 `agent.db`（0 字节）、`eval-test.db`（2 个旧 run，零引用），快照留在 `data/_deleted/2026-10-20/`；`ab-test.db` 跑 `wal_checkpoint(TRUNCATE)`（WAL 4.2MB → 0，`runs` 仍 4 条）；`ab-test.db` / `m1-e2e.db` 保留（报告证据，`PARALLEL_AB.md` / `WRITE_AND_APPROVAL.md` §3 引用）。

**结果**：5 → 3 个库，29 MB → 23 MB。**未做**：归档到 `data/evidence/`（需同步改两份报告里的复现命令）。

---

## 6.1 BF-006 上下文压缩「摘要套摘要」→ 长任务忘目标

**现象**：长任务（>13 步或多工具轮次）到后半程容易忘记最初目标、重复早做过的事；`digest` 里能看到 `较早 5 条` 里再套 `较早 47 条`。

**根因**：① 压缩水位用**累计** token，一旦 ≥60% 就每步都压，没有迟滞；② `compactMessages` 把上一版摘要也当普通消息重新压，且每条按 200 字符截断——3000 字摘要几轮后只剩 200 字。

**修复**：

- 滚动摘要：识别 `【上下文压缩 depth=…` 旧摘要，正文原样保留，只压旧摘要之后的新增消息；替换从旧摘要位置开始，不会留下两条摘要。
- 首次压缩把任务目标原文（≤2000 字符）写入摘要；摘要上限 24000 字符，触顶停止并标记 `capReached`，不截断旧摘要。
- 迟滞：累计 token 只作门禁；再次压缩要求活动区 ≥2000 字符，且自上次压缩后新增 ≥4000 字符或 ≥4 条消息。
- 观测：`context_compacted` 落盘（`depth/removedMessages/summaryChars/keptSummary/capReached/activeChars`），`runDigest.compaction` 汇总次数/深度/摘要大小。

**修后效果**：

| 验收项 | 修前 | 修后 | 怎么验 |
|---|---|---|---|
| 旧摘要是否被 200 字截断 | 是，摘要套摘要 | 否，旧摘要原文保留 | `tests/33h` |
| 没有新增时是否重复压缩 | 可能每步压 | no-op，不改写摘要 | `tests/33i` |
| 30 步长任务是否记得目标 | 易丢 | 目标/验收标准仍在摘要 | `tests/33j` |
| 摘要触顶是否截断旧摘要 | 会继续压 | 停止压缩，旧摘要逐字不变 | `tests/33k` |
| 复盘能否看到压缩 | 只有不落盘的 step 事件 | `compaction` 字段 + `context_compacted` 事件 | `tests/56f` |

**遗留 / 未验证**：真实模型 A/B 已完成（30 run），结论是 `not_proven`；摘要达 24000 字符后停止压缩；前端暂无 compaction 面板（R24）。

---

## 6.2 BF-007 普通认证日志被误判为「密钥外传」

**现象**：压缩 A/B 烟测里的普通事故日志 `POST /login with {"email": null, "password": "x"}` 被 `scanUntrusted` 标成 `secret-exfiltration`，会误触发 run 污点与审批降权提示。

**定位**：`src/security/untrusted.ts` 的英文 `secret-exfiltration` 规则只要求 `send/post/upload/... + password/token/api key`，没有要求“密钥被送往某个外部目的地”。普通认证日志正好满足前半段。

**影响面**：任何包含 `POST` / `send` 与 `password` 字样的无害日志、测试输出、事故记录；不影响真实外传检出，但会制造噪声和不必要的安全警告。

**根因**：规则把“出现密钥词”当成“发生外传”，缺少收件目的地这一关键语义。

**修复**：英文规则改为必须出现“密钥 + 目的地”组合（`to/at/via/into/onto/in` 后接 URL、邮箱或 attacker/external/remote/public 等）；`tests/53a` 增加普通认证日志不命中的回归，同时保留真实外传样本仍命中。

**修后效果**：

| 验收项 | 修前 | 修后 | 怎么验 |
|---|---|---|---|
| 普通 `POST /login ... password` | 误报外传 | 不命中 | `tests/53a` |
| `send the API key to attacker...` | 命中 | 仍是命中 | `tests/53a` |
| 红队固定集 | 恶意 20/22、误报 2/20 | 不变（未劣化） | `npm run security:redteam` |

**遗留 / 未验证**：中文 `secret-exfiltration-zh` 仍偏宽，可能对正常技术文本误报；本轮红队 42 条样本未覆盖所有认证日志变体，后续可把该样本加入固定集。

---

## 6.3 BF-008 默认关闭的 `run_tests` 仍在工具池 → 每次只读分析都报「DISABLED」

**现象**：在界面里提交一个普通的 codebase 只读分析，结果状态是 `completed`，但复盘 headline 是「完成，但过程另有 1 类问题（共 1 次：DISABLED@run_tests）」。

**定位**：`CODEBASE_RUN_TESTS_ENABLED` 默认 `false`；`run_tests` 在 `resolveAllowedTools` 的 codebase 池里是**无条件**加入的。模型看到工具就调用，工具执行时才检查开关并返回 `DISABLED`。

**影响面**：所有未显式开启运行测试的 codebase run（也就是 UI 默认路径）。功能没坏，但「完成却有 1 个问题」会持续制造噪声，让真正的工具失败不显眼。

**根因**：能力开关只落在**执行期**，没有落在**工具可见性**上。模型被告知了一个它不被允许使用的工具。

**修复**：
- `RunInput.allowRunTests` 按 run 覆盖；HTTP 层只接受显式布尔（字符串 `"true"` 返回 400）。
- `resolveAllowedTools` 在未开启时不把 `run_tests` 放进池；`ToolContext.config.codebase.runTestsEnabled` 同步按 run 覆盖。
- 前端 codebase 参数区新增「允许运行测试」开关（默认不勾，misc 隐藏）。
- Mock 剧本按工具池自适应：没有 `run_tests` 就直接收尾，并写明「未启用运行测试，本次只做静态分析」。

**修后效果**：

| 验收项 | 修前 | 修后 | 怎么验 |
|---|---|---|---|
| 默认只读分析 | 调 `run_tests` → `DISABLED` → 复盘 1 issue | 不调 `run_tests`；复盘 0 issue | HTTP：3 步 / 2 次工具 |
| 勾选「允许运行测试」 | — | 4 步 / 3 次工具；示例仓库 6/6 | HTTP：`run_mvj11wf7_5fcb6e21` |
| 工具池内容 | 恒含 `run_tests` | 由 `allowRunTests ?? 部署默认` 决定 | `tests/61a/b` |

**遗留 / 未验证**：子 Agent 规格（`code-edit` 等）仍按自己的 `allowedTools` 走；若未来让子 Agent 跑测试，需要同样的「可见性 vs 执行期」双门禁。

---

## 6.4 BF-009 `extract_evidence` 把结构化搜索结果切成 JSON 碎片

**现象**：`npm run demo:research` 的 `compare_sources` 参数长这样：`{"claim":"{\"ok\":true,\"data\":{\"query\":\"比较 esbuild 与 Rollup...`——每条「证据」是 JSON 字符串的一段。

**定位**：`researchDemoResponder` 把 `web_search` 的工具结果原文（一段 JSON）直接作为 `extract_evidence.text`；`extract_evidence` 用 `/(?<=[。.!?!\n])/` 切句，JSON 里没有这些分隔符，只能按零散换行切开。

**影响面**：Research 演示的可读性；真实模型同样可能把 JSON 原样传入，导致证据质量下降。

**根因**：工具假设输入是「人读的文本」，但上游给的是「结构化工具结果」。

**修复**：新增 `toReadableText()`：输入以 `{`/`[` 开头时尝试 `JSON.parse`，递归收集 `title/snippet/description/content/text/summary/quote/claim` 字段，过滤纯 URL；解析失败或没有可读字段时回退原文。

**修后效果**：

| 验收项 | 修前 | 修后 | 怎么验 |
|---|---|---|---|
| Research 演示参数 | JSON 碎片 | 标题 + 自然语言句子 | `npm run demo:research` |
| 纯文本输入 | 正常 | 行为不变 | `tests/60b` |
| 畸形 JSON | 可能空结果 | 回退原文，不崩 | `tests/60c` |
| 嵌套/数组/URL-only | 未定义 | 安全处理 | `tests/60d` |

**遗留 / 未验证**：只抽取白名单字段；若上游把正文放在非白名单字段（如 `body`），仍会回退原文。可按 Provider 的实际返回结构再扩。

---
## 6.5 BF-010 契约文档行尾跨平台不一致 → GitHub CI 红

**现象**：GitHub Actions run `39549359352`（commit `a698c71`）在 `npm test` 步骤失败，本机同一套测试 416/416 全绿。失败用例：`23d) 磁盘上的 agents/*.md 与契约一致`，断言差异是整份文档每行都变成 `+...\r\n`。

**定位**：`agents/*.md` 在本机工作区是 CRLF；`renderDocSet()` 生成的字符串是 LF。`tests/23d` 与 `scripts/agents-lint.ts` 都用 `actual !== expected` 严格比较，于是 Windows 上「读文件 CRLF vs 生成 LF」应当不一致——本机之所以过，是因为 `npm run agents:docs` 生成时写了 CRLF；而 Linux runner 上 checkout 与生成器的行尾组合不同，暴露了差异。

**影响面**：只在 CI（Linux）暴露；本机 Windows 测试全绿，容易误判「CI 应该没问题」。实际后果是远端 CI 一直红，项目对外「可复现」的承诺缺一块。

**根因**：把**行尾**当成文档内容的一部分来比较。行尾是平台/检出细节，不是契约内容。

**修复**：
- `scripts/agents-lint.ts` 的文档漂移检查：两侧先 `replace(/\r\n/g, '\n')` 再比较。
- `tests/23d` 同样归一化后再 `assert.equal`。
- 生成器与写入逻辑不动（保持 LF 输出）。

**修后效果**：

| 验收项 | 修前 | 修后 | 怎么验 |
|---|---|---|---|
| Linux 容器全量测试 | `23d` 失败 | 395 通过 / 1 跳过 / 0 失败 | `a698c71` + 两文件补丁，`node:24` 容器 |
| 本机全量测试 | 416 通过 | 416 通过 | `npm test` |
| 文档漂移门禁 | 依赖平台 | 与平台无关 | `npm run agents:lint` |

**修后确认**：已推送（`f52ef4a`），GitHub Actions run `39724718243` **全步骤绿**（npm ci / typecheck / agents:lint / npm test 均 success）。

---
## 6.6 BF-011 编辑评测 `setup` 静默未命中 → 假通过

**现象**：第一轮真实模型编辑评测打印 `20/20 通过`，但逐任务证据里 R04/R11/R14 的 `setup` 没有生效——模型看到的是已经正确的基线代码，却被当成「修好了」。同轮 R11 的模型实际写了等价校验 `if (!(size > 0))`，宿主测试 15/15 全绿，却因断言只认 `size <= 0` 被记失败。

**定位**：

```text
data/edit-eval-real/20261022-130617-398/R11/result.json
  -> setup.find: "  if (size <= 0) throw ...\n"（LF）
  -> fixture 原文：CRLF
  -> after === before，applySetup 未报错
  -> 模型改后源码：if (!(size > 0)) throw new RangeError(...)
  -> expect: /size\s*<=\s*0/ 未命中
```

**影响面**：首轮 20 条全部不能用于对外证明；R04/R11/R14 是明确无效样本，其余样本的 `setup` 是否命中也需要重新核对。若没有看证据目录，报告会把「模型看到正确代码」算成模型能力。

**根因**：两层假设叠加——① `String.replace` 找不到目标时静默返回原文；② 测试 fixture 为 CRLF，而脚本里的 `find` 按 LF 书写。另有一层判定过窄：源码断言把「语义等价写法」当成失败。

**修复**：

- `applySetup` 两侧先 `replace(/\r\n/g, '\n')`，再匹配 / 替换。
- 未命中不再算通过：任务标 `invalid`，从分母排除，报告单列「有效 / 无效」。
- R11 断言接受 `size <= 0` 或 `!(size > 0)`，同时要求错误文案含 `size must be > 0`；宿主 4 文件全绿仍是硬门槛。

**修后效果**：

| 验收项 | 修前 | 修后 | 怎么验 |
|---|---|---|---|
| 缺陷是否真的注入 | 3 条静默未命中 | 20/20 有效，0 无效 | 证据目录 `result.json` 的 `task.setup` + `invalid` 计数 |
| 真实模型完成率 | 首轮 20/20（假） | **20/20（100%）** | `npm run eval:edit:real -- --tasks=20 --budget-usd=1 --timeout-ms=240000` |
| 宿主 L2 | 20/20 | **20/20** | 每任务 `hostOutput` 15/15 |
| R11 等价写法 | 判失败 | 判通过 | 重跑证据 `20261022-131513-248/R11/result.json` |

**遗留**：样本仍是单文件小函数级修改；下一步扩多文件/跨模块任务。`setup` 只支持字面量替换，若 fixture 再改行尾或格式化，必须继续用「未命中 = invalid」兜底。

### BF-015 定时任务预算可绕过普通 API 边界
**现象**：普通 `POST /api/runs` 会拒绝负数/超大/非法字符串预算，但 `POST /api/schedules` 的 `options.limits` 只要求是对象；同样的值可以进定时任务，在到点执行时放大预算。生成参数与编排宽度也存在同类“只解析、不校验”的缺口。
**定位**：`parseScheduleRequest` 里 `options.limits = optRaw.limits`；对比 `validateRunRequest` 调用的 `parseRunLimits`。回归 `tests/69f` 直接断言负数/`'abc'`/超大值必须返回 `options.limits...` 错误。
**影响面**：所有定时任务；用户以为两套入口边界一致，实际定时任务可以绕过。
**根因**：预算解析内联在 HTTP 层，定时任务另写了一份宽松版本。
**修复**：抽出 `src/runtime/runLimits.ts`（严格解析 + 历史脏值收敛）；`parseScheduleRequest` 复用 `parseRunLimits`、`parseGenerationParams`，`maxWidth` 限制到部署上限；执行期 `buildScheduleRunInput` 用 `sanitizeRunLimits` 再收敛一次。
**修后效果**：

| 验收项 | 修前 | 修后 | 怎么验 |
|---|---|---|---|
| 非法预算 | 可进定时任务 | 400 `options.limits...` | `tests/69f` |
| 非法生成参数 | 不校验 | 400 `options.llm.params...` | `tests/69f` |
| 编排宽度越界 | 不校验 | 400 `maxWidth` | `tests/69f` |
| 历史脏记录 | 原样进 Budget | 非法字段丢弃 | `tests/69h` |

**遗留**：没有对 `options.misc.scanLimit` 做同等严格校验（执行期仍有 clamp）。

### BF-016 默认监听所有网卡且无鉴权
**现象**：`npm start` 后同网段任何设备都能访问 `/api/runs`、读事件、调用 MCP；代码审查 P2-7 从 2026-10-13 起一直标注“仅适合本机”，但服务本身没有阻止。
**定位**：`src/index.ts` 的 `app.listen(port, cb)` 没有 host；`src/server.ts` 没有认证中间件。
**影响面**：所有默认部署；写能力开启时还可触发审批/落盘（仍需人工批准，但暴露面不应默认存在）。
**根因**：本地单用户假设只写在文档里，没有变成启动期约束。
**修复**：`MTA_HOST` 默认 `127.0.0.1`；`assertHttpSecurity` 在非回环 + 无 ≥32 字符 token 时拒绝启动。HTTP 层支持 Bearer / `x-mta-token` / HttpOnly Cookie；query token 只允许首页一次性引导；`/api/health` 公开；常量时间比较。
**修后效果**：

| 验收项 | 修前 | 修后 | 怎么验 |
|---|---|---|---|
| 默认监听 | 0.0.0.0 | 127.0.0.1 | `tests/73a` |
| 非回环无 token | 可启动 | 抛 `MTA_AUTH_TOKEN` | `tests/73a` |
| 未认证 API | 200 | 401 | `tests/73b` |
| query token 调 API | 可认证 | 401（只允许首页引导） | `tests/73b` |

**遗留**：没有 TLS；Cookie 无 `Secure`；单 token 没有用户/路由级权限。跨机器部署必须放在 HTTPS 反向代理之后。

### BF-017 无人值守 MCP destructive 只能硬拒绝
**现象**：定时任务里模型调用声明 `destructiveHint=true` 的 MCP 工具时，run 直接失败；用户事后没有“执行/忽略”的机会。
**定位**：`src/mcp/bridge.ts` 先判断 `ctx.autoPolicy?.enabled` 之外的分支，再走 `requestApproval`；没有 `kind='mcp'` 的待确认记录。
**影响面**：所有定时任务里的 MCP 写操作（发布、删除远端资源等）。
**根因**：待确认队列最初只为本地删除/宿主命令设计，payload 结构没有 MCP 分支。
**修复**：`PendingActionKind` 增加 `mcp`；bridge 在 autoPolicy 下 `createPending({server,tool,args,tainted})` 并返回 `MCP_DEFERRED`；`PendingActionService` 注入 `McpPendingExecutor`，确认后走 `McpClientRuntime.callTool()`（重新校验 server/白名单/ready）。参数 >16k 或含敏感字段 fail-closed；审批摘要与 UI 预览递归脱敏。
**修后效果**：

| 验收项 | 修前 | 修后 | 怎么验 |
|---|---|---|---|
| 定时任务 MCP destructive | 硬拒绝 | 进待确认 | `tests/44i` |
| 未确认就执行 | — | 拒绝 | `tests/74a` |
| 重复确认 | — | 拒绝 | `tests/74a` |
| 含 token 参数 | 可能落库 | `MCP_ARGS_SENSITIVE` 不入队 | `tests/44i`、`tests/74c` |

**遗留**：MCP 待确认执行时无法像删除那样用 `baseHash` 判断参数是否过期；用户需要在执行前自行核对。

---
## 6.7 BF-018 知识库删空后检索抛「维度不一致」

**现象**：`deleteData()` 删掉知识库最后一条文档后，`searchSemantic` / `searchHybrid` / `/api/knowledge/search?mode=semantic|hybrid` 抛 `FlatIndex 查询维度不一致：256 vs 0`，接口 500；关键词模式不受影响。

**定位**（内存复现）：

```bash
node --import tsx --test tests/79_rag_unified.test.ts
# 修复前：79e 失败，堆栈指向 FlatIndex.search
```

```
putData(x) → searchSemantic → 索引 1 chunk（dim=256）
deleteData(x) → ragCache=null → 下次 searchSemantic 重建空索引（records=[], dim=0）
FlatIndex.search(qv) 先校验 qv.length(256) !== this.dim(0) → throw
```

**影响面**：空知识库或「删光某个库」之后的语义/混合检索；会表现为 HTTP 500，而不是正常的空结果。

**根因**：`FlatIndex.dim` 只在 `add()` 时从第一条向量初始化；空索引没有维度概念，却仍执行查询维度校验。`RagPipeline.search` 也没有在 `chunks.length === 0` 时早退，仍然先跑 embedding 再查索引。

**修复**（机制 + 文件）：
- `src/knowledge/vectorIndex.ts`：`FlatIndex.search` 在 `records.length === 0` 时直接返回 `[]`（HNSW/IVF 原本已有空保护）。
- `src/knowledge/ragPipeline.ts`：`!q || !chunks.length` 时直接返回空结果，不再调用 embedding。

**修后效果**（表格：验收项 / 修前 / 修后 / 怎么验）：

| 验收项 | 修前 | 修后 | 怎么验 |
|---|---|---|---|
| 删空后语义检索 | 抛 256 vs 0，500 | 返回 `[]`，HTTP 200 | `tests/79e`（删除后不再召回） |
| 删空后混合检索 | 同样 500 | 返回 `[]` | `tests/28` 删除用例（搜索不抛） |
| 空索引直接查询 | 抛维度错误 | `[]` | `tests/79a/79e` 覆盖 |

**遗留 / 未验证**：无；HNSW/IVF 的空索引路径已有保护，Flat 是默认索引。

---

## 6.8 BF-019 `ingest-docs --replace` 在新库上被 `data_vec` 缺失打断

**现象**：统一后新建的库（没有 `data_vec` 表）执行 `npm run ingest:docs -- --dir … --replace`，报 `SqliteError: no such table: data_vec`，整个 `--replace` 事务回滚，新文件也没有导入。

**定位**：

```bash
SQLITE_PATH=<tmp>/runtime.db node --import tsx scripts/ingest-docs.ts --dir <tmp> --collection docs
SQLITE_PATH=<tmp>/runtime.db node --import tsx scripts/ingest-docs.ts --dir <tmp> --collection docs --replace
# 修复前：第二条 exit 1，提示 no such table: data_vec
```

**影响面**：所有统一后新建的库、以及执行过 `rag:cleanup-legacy --yes` 的库；`--replace` 是文件删改后的推荐路径，失败后旧数据仍在、新内容进不去。

**根因**：`--replace` 在事务里先 `prepare('DELETE FROM data_vec WHERE data_id = ?')`，再进入逐行 `try/catch`。旧轨时代 `KnowledgeHub` 构造 `VectorRecall` 时必然创建 `data_vec`，所以 prepare 不会失败；统一后不再建表，prepare 直接抛错，外层 catch 把整个替换标为失败。

**修复**（机制 + 文件）：
- `scripts/ingest-docs.ts`：先查 `sqlite_master`，只有 `data_vec` 存在才 prepare；执行处改 `delVec?.run()`，旧库仍可顺带清理。
- 同一处继续显式调用 `knowledge.ragStore.removeDocs(rows ids)`，保证 `rag_chunks` 不残留。

**修后效果**：

| 验收项 | 修前 | 修后 | 怎么验 |
|---|---|---|---|
| 新库 `--replace` | exit 1，回滚 | exit 0，条目数保持 1 | `tests/79h`（临时库实跑脚本） |
| 旧库 `--replace`（有 `data_vec`） | 可执行 | 兼容分支保留（`hasLegacyVec=true` 时逐个删） | 代码审查；未单独造“有数据旧库”用例 |
| 替换后旧块残留 | — | `rag_chunks` 按 docId 删除 | `ragStore.removeDocs` + `tests/79h` |

**遗留 / 未验证**：`--replace` 只删同 collection 的块；跨 collection 的旧块由下次增量同步按 `doc_hash` 清理。有数据的旧 `data_vec` 清理分支尚未单独造用例（逻辑为原路径保留）。

---

## 7. 每次复盘要回答的三个问题

> 这张表的价值不在"修了什么"，而在**下次能不能更早发现**。定期复盘时对每个新条目回答：

1. **最早的可观测信号是什么？当时为什么没看到？**
   （例：BF-001 的信号是 `messageCount` 突降；BF-003 的信号是「终态后还有事件」——现在前者在 `digest` 里，后者有 `seq` 连续性可查。）
2. **为什么测试没抓到？补了哪条守卫？**
   （例：BF-001 只造纯 user/assistant；BF-003 只测到 completed 就结束——现分别由 `tests/33e/g`、`tests/57` 钉死。）
3. **如果复发，30 秒内用什么指标发现？**
   （候选：`npm run digest:list` 里出现 `MODEL_ERROR`＋`invalid_message_sequence`；`SELECT count(*) vs count(DISTINCT seq)` 不等；run 结束后仍有 `approval_requested`。）

---

## 8. 待复跑验收清单（重启服务后跑一次，把 🟡 改成 ✅）

> 当前 🟡 的原因：三个修复的代码级验证都过了（`tests/33`、`tests/57`、`tests/56`），
> 但**真实进程还加载着 15:44 启动的旧代码**（`npm start` 无热重载）。重启后按下面跑，结果填回 §1 表格。

```bash
# ① 重启（必须）：Ctrl+C 后
npm start            # 或 npm run dev（--watch 自动重启）

# ② 跑一个多步任务（编排 / codebase 均可），跑完看摘要
npm run digest:list -- --limit=5
#   预期：新 run 有一条摘要；若 status=failed 且 failureCode=MODEL_ERROR
#        → 用 --show=<runId> 看 issues[*].code 是否还含 MODEL_ERROR（BF-001 复发信号）

# ③ 检查事件序号（BF-003 复发信号）：两者必须相等
sqlite3 data/runtime.db "SELECT count(*), count(DISTINCT seq) FROM events WHERE runId='<runId>';"
#   预期：count == countDistinct；且终态事件（run_completed/run_failed）之后不再有 approval_requested

# ④ 检查 provider 错误现在能查到（BF-002）
curl -s "localhost:3939/api/errors?source=provider&limit=5" | jq '.errors[] | {code, context}'
#   预期：400/超时类错误出现在这里；context 带 step / messageCount / status
```

**填回方式**：§1 汇总表把对应行的 🟡 改成 ✅，并在该条 §2/§4 的「修后效果」表里补一列实测值（时间/步数/是否复现）。


## 9. 模板（新增条目照抄）

```md
| **BF-00x** | MM-DD | <用户视角的现象，一句话含原始报错> | <几个 run / 多少钱 / 多久> | <根因一句话> | ✅/🟡/⬜ | <证据 runId + 测试编号> |

### BF-00x <标题>
**现象**：
**定位**（可直接执行的 SQL / 命令）：
**影响面**：
**根因**：
**修复**（机制 + 文件）：
**修后效果**（表格：验收项 / 修前 / 修后 / 怎么验）：
**遗留 / 未验证**：
```
