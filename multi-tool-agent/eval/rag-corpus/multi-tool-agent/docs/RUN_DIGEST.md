# 复盘摘要（RUN_DIGEST）

> **一句话**：**每一次** run 结束（成功、失败、触顶、取消、等待用户、进程被杀）都会自动落一份结构化摘要，  
> 记下「结论 + 过程中出过哪些错 + 第一个错在哪」。不再需要事后手工翻 events。
>
> 入口：`npm run digest:list` ｜ `GET /api/digests` ｜ `GET /api/runs/:id/digest` ｜ `data/run-digest.jsonl` ｜ 前端「复盘」页签

---

## 1. 为什么要有它

| 场景                | 之前                                                    | 现在                                                      |
| ----------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| 任务失败              | `runs` 行只有一行 `failureReason`，看不出前后还出过什么问题             | 摘要带 `errorCode / failureReason / issues[] / firstIssue` |
| **任务成功**          | 几乎无痕迹（completed 就完了），中间失败过 3 次工具、被限流 1 次全部沉在 events 里 | 摘要照样写，`headline` 会写「完成，但过程另有 N 类问题」                     |
| 一个流程都跑不完（进程被杀/重启） | 只有启动回收把行改成 failed，没有复盘材料                              | 启动扫描时补一条 `RUN_INTERRUPTED` 摘要                           |
| 每月回看              | 手工 `SELECT ... FROM events` / 翻 322 份 run 报告          | `npm run digest:list -- --all` 一行一个 run                 |

---

## 2. 什么时候写

| 触发点          | 状态                                                                       | 说明                                     |
| ------------ | ------------------------------------------------------------------------ | -------------------------------------- |
| `finalize()` | `completed` / `failed` / `cancelled` / `limit_reached` / `awaiting_user` | 所有终态统一出口，**全部**写                       |
| 启动时的孤儿回收     | `failed` + `RUN_INTERRUPTED`                                             | 上次进程退出后无人推进的 run                       |
| 不写的情况        | —                                                                        | run 还在跑（没有终态就不该有结论）；本功能上线前的历史 run（不回填） |

写之前会先 `EventLogger.flush()`：事件是异步批量落盘的，不 flush 会漏掉最后一步的工具/审批事件。

---

## 3. 三个落点

| 落点                          | 内容                                                                                      | 怎么用                         |
| --------------------------- | --------------------------------------------------------------------------------------- | --------------------------- |
| **DB 表 `run_digests`**      | 完整摘要（`digestJson`）+ 可过滤列（`status / runType / ok / issueCount / failureCode / headline`） | 列表/过滤/接口的数据源                |
| **`data/run-digest.jsonl`** | 一行一个 run（完整 JSON）                                                                       | `grep` / `jq` / 归档；DB 被删也能查 |
| **`run_digest` 事件**         | 轻量版（ok / headline / issueCount / counts / firstIssue）                                   | 事件流可回放，前端可做实时提示             |

> JSONL 路径默认**跟随 SQLite 目录**（生产 `./data/run-digest.jsonl`）；`:memory:`（测试）不落盘，  
> 避免跑测试往仓库 `data/` 追加几十行 mock 记录。可用 `RUN_DIGEST_PATH` 显式覆盖。

---

## 4. 字段

```jsonc
{
  "version": 1,
  "runId": "run_mvge1343_49a18777",
  "runType": "orchestrator",
  "status": "failed",              // 终态原样
  "ok": false,                     // 只认 completed
  "goal": "…",
  "createdAt": "…", "finishedAt": "…", "durationMs": 487000,
  "errorCode": "MODEL_ERROR",
  "failureReason": "模型调用失败: …400…",
  "counters": { "steps": 15, "modelCalls": 15, "toolCalls": 27, "promptTokens": 130380, "completionTokens": 6355, "totalTokens": 136735, "costUsd": 0.005 },
  "eventStats": { "total": 320, "byType": { "tool_failed": 21, "model_request": 53, … } },
  "counts": { "toolFails": 21, "runtimeErrors": 1, "subtaskFailed": 1, "approvalDenied": 0, "verifyFailed": 0, "changeRolledBack": 0, "untrustedFlagged": 0 },
  "compaction": { "count": 2, "removedMessages": 14, "maxDepth": 2, "lastSummaryChars": 3150, "capReached": false,
                  "maxWatermark": 0.671, "watermarkSources": ["provider"], "lastPromptTokens": 22000, "contextWindow": 32768 }, // 仅发生过压缩时出现
  "issues": [                       // 按 code + 位置聚合，按出现顺序
    { "code": "MODEL_ERROR", "source": "runtime", "count": 1, "firstSeq": 320, "lastSeq": 320, "message": "…" },
    { "code": "NOT_FOUND", "source": "tool", "where": "read_file", "count": 4, "firstSeq": 41, "lastSeq": 88, "message": "…" }
  ],
  "firstIssue": { "seq": 41, "code": "NOT_FOUND", "source": "tool", "where": "read_file", "message": "…" },
  "headline": "失败（MODEL_ERROR）：模型调用失败: …400…｜过程另有 3 类问题（共 8 次：…）"
}
```

`issues` 收录的来源：

| `source`       | 触发事件                                                    | 举例                                                |
| -------------- | ------------------------------------------------------- | ------------------------------------------------- |
| `tool`         | `tool_failed`                                           | `NOT_FOUND` / `INVALID_ARGS` / `TIMEOUT`          |
| `runtime`      | `runtime_error`、`subtask_failed`                        | `MODEL_ERROR` / `INTERNAL_ERROR` / `EMPTY_RESULT` |
| `approval`     | `approval_decided` 且 `value=deny`                       | 用户拒绝、超时按拒绝                                        |
| `verification` | `verification_completed(ok=false)`、`change_rolled_back` | L2 宿主复验失败、落盘后回滚                                   |
| `security`     | `untrusted_content_flagged`                             | 工具输出命中提示注入特征                                      |

`compaction` 来自落盘的 `context_compacted` 事件（R23 建立，R25 补充窗口水位观测）：

| 字段 | 含义 |
|---|---|
| `count` | 本 run 发生滚动压缩的次数 |
| `removedMessages` | 累计从活跃上下文移除的消息条数（不含旧摘要替换） |
| `maxDepth` | 摘要最大深度：1 = 首次压缩，2+ = 在旧摘要上滚动追加 |
| `lastSummaryChars` | 最后一次压缩后的摘要字符数 |
| `capReached` | 是否触及摘要上限（24000 字符）后停止压缩 |
| `maxWatermark` | 观察到的最大上下文水位（0~1）。`provider` = 真实 promptTokens/窗口；`unknown` = 累计预算代理 |
| `watermarkSources` | 水位来源去重：`provider` / `estimated` / `unknown` |
| `lastPromptTokens` | 最近一次用于计算水位的 prompt token 数（真实或估算） |
| `contextWindow` | 最近一次已知的模型上下文窗口；未知时不输出，绝不伪造 |

它只用于**观测**，不参与 `ok` 判定；没有压缩的 run 不输出该字段。

---

## 5. 怎么看

```bash
npm run digest:list                      # 最近 20 条「有问题」的（非 completed 或过程出过错）
npm run digest:list -- --all             # 全部（含成功且无过程错误）
npm run digest:list -- --status=failed --limit=50
npm run digest:list -- --runType=orchestrator
npm run digest:list -- --show=<runId>    # 单条完整 JSON（含逐类问题与 seq）
npm run digest:list -- --json            # 给脚本用

# 接口
curl -s "localhost:3939/api/digests?onlyProblems=1&limit=20" | jq '.digests[] | {runId, status, issueCount, headline}'
curl -s "localhost:3939/api/runs/<runId>/digest" | jq '.issues'
```

**前端「复盘」页签（R24）**：打开工作台 → 复盘，可按「只看有问题的 / 全部」、状态、任务类型、最近条数筛选；左侧选 run，右侧看结论、首个问题、步骤/模型/工具/tokens/成本、过程问题表、原始 JSON。若 `compaction` 存在，会单独显示压缩次数、移除消息、最大深度、摘要字符数、最大水位、水位来源、prompt tokens / 窗口、是否触顶；没有压缩则明确显示「本 run 未触发」，不能解释成“压缩不可用”。实时流也会为 `context_compacted` 生成一张卡片。



---

## 6. 边界（诚实清单）

1. **摘要只统计"发生了什么"，不判断"该不该失败"**：`ok` 只按 `status==='completed'`，不替你做业务判断。
2. **过程问题按事件聚合，重试会重复计数**：同一工具失败重试 2 次就是 `toolFails=2`；`issues[].count` 表示出现次数，不代表 2 个不同问题。
3. **历史 run 不回填**：上线前的 run 查不到摘要（返回 404 并说明原因）。
4. **不是替代 run 报告**：要流程图 / Mermaid / 六阶段归因，走 `npm run report:run -- <runId>` 或 `GET /api/runs/:id/report`。
5. **摘要写失败不影响终态**：只额外报一条 `DIGEST_FAILED`（source=store），run 的终态与结果照常落库。
6. **进程被 `SIGKILL` 时来不及写**：靠**下次启动**的孤儿扫描补 `RUN_INTERRUPTED`；若服务再也不启动，就没有这条记录。
