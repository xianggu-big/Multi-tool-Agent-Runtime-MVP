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

**遗留 / 未验证**：真实模型 20~30 步长任务 A/B 未做；摘要达 24000 字符后停止压缩；前端暂无 compaction 面板（R24）。

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
