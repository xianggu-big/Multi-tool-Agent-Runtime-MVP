# 可视化监控系统设计（TRACE_VISUALIZATION）

> 本文档描述 Agent Loop 与 Tool 调用可视化监控系统的**设计与实现**，对应两项交付：可视化界面 + 检测模块。

## 1. 目标

1. **可视化界面**：清晰展示 Agent 从输入到输出的完整循环——推理、决策、工具调用、结果返回等节点及其流转关系。
2. **检测程序**：实时采集每个步骤的执行时间、持续时长、调用状态、关键输入输出，以时间线 / 瀑布图展示耗时分布。
3. **工程约束**：采集准确、界面响应及时、对主流程性能影响最小化。

## 2. 总体架构

```
                ┌────────────────────── Agent Loop（主流程）──────────────────────┐
                │   executeLoop / loopBody / executeTools                        │
                │        │  只做 O(1) 埋点：tracer.start / tracer.finish / emit  │
                │        ▼                                                       │
                │   ┌───────────────┐   ┌──────────────────────────┐             │
                │   │   Tracer      │──▶│  EventLogger（异步缓冲）  │             │
                │   │ 精确计时/span │   │  内存队列 + setImmediate   │             │
                │   └───────────────┘   └───────────┬──────────────┘             │
                └────────────────────────────────────┼────────────────────────────┘
                                                     │ 批量事务 flush
                                                     ▼
                                          ┌────────────────────┐
                                          │  SqliteStore.events │  ← 唯一真相源
                                          └─────────┬──────────┘
                          ┌─────────────────────────┼───────────────────────┐
                          ▼                         ▼                       ▼
                  GET /api/runs/:id/trace   GET /api/runs/:id/stream   public/index.html
                  (buildTraceSnapshot 聚合)  (SSE 实时推送)            (流程图 + 瀑布图)
```

**关键设计**：`events` 表是唯一真相源。`Tracer` 只负责计时 + 生成携带 span 字段的事件；`buildTraceSnapshot` 是纯函数，从事件流**离线重建** span 树与时间线（可跨进程/重启）。

## 3. 数据模型

### 3.1 Span（节点）

```ts
type TraceSpanKind = 'run' | 'step' | 'llm' | 'tool' | 'answer';
type TraceSpanStatus = 'running' | 'ok' | 'error' | 'cancelled' | 'skipped';

interface TraceSpan {
  spanId: string;
  parentId: string | null;   // null = run 根
  runId: string;
  kind: TraceSpanKind;
  name: string;              // 工具名 / 模型名 / 'run' / '最终答案'
  status: TraceSpanStatus;
  startTs: number;           // epoch ms（含小数，供瀑布图对齐）
  endTs?: number;
  durationMs?: number;
  step?: number;             // 所属循环轮次
  inputs?: Record<string, unknown>;   // 关键输入（脱敏+截断）
  outputs?: Record<string, unknown>;  // 关键输出（脱敏+截断）
  error?: { code?: string; message?: string };
}
```

### 3.2 节点语义（对应用户要求的「循环过程」）

| kind | 对应过程 | 事件（start → end） | 关键数据 |
| --- | --- | --- | --- |
| `run` | 输入 → 运行 → 输出 | `run_started` → `run_completed/failed/cancelled/limit_reached` | inputs: goal/runType；outputs: finalAnswer |
| `llm` | **推理** + **决策** | `model_request` → `model_completed` | outputs: stopReason / toolNames（决策结果）、usage |
| `tool` | **工具调用** + **结果返回** | `tool_started` → `tool_completed`/`tool_failed` | inputs: arguments；outputs: resultSnippet / error.code |
| `answer` | **最终答案** | （由 run_completed 合成） | outputs: finalAnswer |

### 3.3 TraceSnapshot（聚合结果，供前端直接消费）

```ts
interface TraceSnapshot {
  runId: string; status: string; rootId: string;
  spans: TraceSpan[];       // 按 startTs 排序的扁平列表
  summary: {
    totalDurationMs: number; llmCalls: number; toolCalls: number;
    llmTotalMs: number; toolTotalMs: number;
    perKind: Record<string, { count: number; totalMs: number }>;
  };
}
```

## 4. 检测模块（Instrumentation）设计

### 4.1 Tracer（`src/trace/Tracer.ts`）

- **精确计时**：用 `performance.now()`（单调时钟，不受系统时钟调整影响），构造时记录 `epochBase = Date.now() - performance.now()`，把相对时间映射回 epoch ms。精度亚毫秒。
- **span 生命周期**：`start(kind, name, opts)` 生成 spanId、记 startTs、emit start 事件；`finish(spanId, kind, opts)` 取 startTs 算 `durationMs`、emit end 事件（ok→completed，否则→failed）。
- **spanId 关联**：start/end 事件共享 spanId，使 `buildTraceSnapshot` 能成对重建 span。
- **透传**：`emit()` 用于非 span 事件（`tool_call_requested`、`checkpoint_saved`），保持事件流完整。

### 4.2 埋点位置（`AgentRuntime`）

| 位置 | 埋点 |
| --- | --- |
| `executeLoop` | `run` span start（spanId=runId） |
| `loopBody` 每轮 | `llm` span start（model_request）→ chat 完成后 `llm` finish（model_completed，记录 stopReason/toolNames/usage） |
| `loopBody` 决策 | `tool_call_requested`（parentId 指向 llm span） |
| `executeTools` | `tool` span start（记录 arguments）→ 执行后 finish（记录 resultSnippet / error.code） |
| `finalize` | run span 结束（run_completed/…，附 durationMs + finalAnswer） |

### 4.3 关键输入输出采集（脱敏 + 截断）

- 输入：`tool` 的 `arguments`、`llm` 的 `model`/`step`/`messageCount`、`run` 的 `goal`。
- 输出：`tool` 的 `resultSnippet`（截断 500 字符）、`llm` 的 `stopReason`/`toolNames`、`run` 的 `finalAnswer`。
- 全部经 `EventLogger.sanitize`：`apiKey`/`token`/`sk-…`/`AKIA…`/`Bearer …` 替换为 `***REDACTED***`；超长字段截断。

## 5. 性能策略（对主流程影响最小化）

1. **埋点 O(1)**：`tracer.start/finish` 只做 `performance.now()` + 一次 Map 写入 + 一次对象构造，无 I/O、无序列化重计算。
2. **异步批量落盘**：`EventLogger.emit` 把事件 push 进内存队列，用 `setImmediate` 合并同轮事件、一次性 `flush` 到 `SqliteStore.appendEvents`（单事务批量 INSERT）。**LLM / 工具调用的主循环不再同步写 SQLite**。
3. **批量事务**：`appendEvents` 用 `better-sqlite3` 的 `transaction` 包裹，一次 fsync 提交一批，而非逐条 fsync。
4. **flush 时点**：`run()`/`enqueue()` 的 `finally` 强制 `tracer.flush()`，保证任务结束后事件已落盘（测试/查询可靠）。
5. **内存上界**：缓冲队列在每次 `setImmediate` 被清空，不会无界增长。

> 同步写改异步的代价：事件可见性延迟一个 `setImmediate`（毫秒级），对「界面响应及时」无感；换来主循环零阻塞。

## 6. 采集准确性

- **单调时钟**：`performance.now()` 不受 NTP/手动改系统时间影响，瀑布图的相对耗时分布准确。
- **顺序保证**：`seq` 单调递增（`EventLogger` 内存维护 per-run 序号），SQLite 按 `seq ASC` 读回，事件顺序稳定。
- **状态一致性**：span 状态由事件类型映射（`tool_failed`→error、`run_cancelled`→cancelled…）；未显式关闭的 span（如模型调用异常导致 run 直接 failed）在快照阶段补为 `error`/`cancelled`。
- **持续时长**：`durationMs` 统一由 Tracer 的 start→finish 墙钟计时（而非各 Provider 自报），保证瀑布图可横向对比；Provider 报告的 latency 另存 `providerLatencyMs` 作参考。

## 7. 可视化界面设计（`public/index.html`）

右侧面板分两个 tab：

### 7.1 事件流
实时 SSE 推送的事件列表（保留原能力）+ 最终答案/来源。

### 7.2 流程监控
1. **摘要**：总耗时、推理次数、工具次数、推理耗时、工具耗时。
2. **执行流程图**（HTML + CSS 箭头）：按 `startTs` 排序的节点纵列，每个节点显示 kind 图标色 + 名称 + 状态徽章 + 耗时，节点下方小字标注关键流转——
   - `llm` 节点 → 「决策 → 调用：search_files, read_file」
   - `tool` 节点 → 「结果返回 · 成功/失败码」
   - `run`/`answer` 节点 → 输入目标 / 最终答案。
3. **瀑布图**（SVG 横向时间线）：X 轴为相对时间（0 → 总耗时），每行一个 span，条长 = 实际耗时，颜色按 kind（run 绿 / llm 蓝 / tool 紫 / answer 橙 / 失败红），顶部时间刻度，`<title>` 悬停显示 name + 耗时 + 状态。
4. **实时更新**：SSE 事件到达时 700ms 节流重拉 `GET /api/runs/:id/trace`；任务结束时拉最终快照。

## 8. API

| 端点 | 说明 |
| --- | --- |
| `GET /api/runs/:id/trace` | 聚合 trace 快照（spans + summary） |
| `GET /api/runs/:id/stream` | SSE 实时事件流（span 事件含 spanId/startTs/durationMs） |
| `GET /api/runs/:id/events` | 原始事件列表（向后兼容） |

## 9. 实现清单

| 文件 | 变更 |
| --- | --- |
| `src/types.ts` | 新增 `TraceSpanKind`/`TraceSpanStatus`/`TraceSpan`/`TraceSummary`/`TraceSnapshot`；`TraceEventType` 增 `model_completed`/`step_started` |
| `src/trace/Tracer.ts`（新） | Tracer 计时类 + `buildTraceSnapshot` 纯函数聚合 |
| `src/trace/EventLogger.ts` | 异步批量缓冲 + `flush()` + `onPersistBatch` |
| `src/store/SqliteStore.ts` | 新增 `appendEvents`（批量事务） |
| `src/runtime/AgentRuntime.ts` | 埋点 span 化（run/llm/tool）、`model_completed`、工具输入输出采集 |
| `src/runtime/index.ts` | 组装 Tracer + 注入 `onPersistBatch` |
| `src/server.ts` | 新增 `GET /api/runs/:id/trace` |
| `public/index.html` | 「流程监控」tab：流程图 + 瀑布图 + 摘要 |
| `tests/18_tracer.test.ts`（新） | 计时/聚合/事件/缓冲 6 个用例 |

## 10. 已知限制（诚实标注）

1. **事件粒度**：`decision`（决策）与 `result`（结果返回）未做独立 span，而是编码在 `llm.outputs` / `tool.outputs` 里——流程图通过节点副文案展示，瀑布图不单独成条。若需精确到「决策耗时/结果序列化耗时」，需进一步拆分。
2. **并发工具**：多个 tool span 并发执行时，瀑布图按 `startTs` 平铺在同一时间轴，能看出重叠；但不做泳道隔离（同一行可能被并发条覆盖）。当前单 run 工具数少，影响可忽略。
3. **跨进程恢复**：`buildTraceSnapshot` 从事件重建 span，天然支持跨进程；但「正在运行中」的快照在 flush 前可能缺少最近一个 `setImmediate` 窗口的事件（<1ms）。
4. **瀑布图横轴**：以事件采集到的最小 startTs 到最大 endTs 为区间，`answer` 节点耗时恒为 0（瞬间完成）。
