# 设计决策（DESIGN_DECISIONS）

记录关键的技术取舍与原因，便于后续维护者理解「为什么是这样」。

## 1. 为何一个共享 Agent Loop 驱动两种 Agent？

两类任务的本质流程完全一致：**规划 → 调 LLM → 解析 tool_calls → 执行工具 → 汇总结果 → 再规划**，直到 `end_turn`。差异只在「可用工具」与「目标」。因此把**预算 / 权限 / 超时 / 检查点 / 状态**统一在 `AgentRuntime.loopBody`，两类 Agent 仅通过 `resolveAllowedTools` / `resolvePermissions` 注入不同约束。好处：安全边界只写一次、可测试性高、新增 Agent 类型成本低。

## 2. 测试运行器：从 Vitest 切换到 `node:test` + `tsx`

- **原计划**：Vitest + esbuild。
- **受阻**：本环境的 npm 11 `allowScripts` 策略阻止原生安装脚本；Vitest 嵌套的 esbuild `postinstall` 在托管 node 二进制下 `spawn` 失败（`EBUSY`）。`better-sqlite3` 的原生构建在批准脚本后可成功，但 esbuild 仍不可用。
- **决策**：放弃 Vitest，采用 Node 22 内置 `node:test` 作为测试运行器；用 `tsx`（自带可用的 esbuild，独立于项目依赖）作为 TS 加载器，命令为 `node --import tsx --test tests/*.test.ts`。
- **代价**：失去 Vitest 的快照 / 覆盖等生态；但核心 Runtime 测试用 `node:test` 完全够用，且**零额外失败依赖**。

## 3. TypeScript 执行方式：`.js` 规范 + `tsx` 加载

- 源码与测试统一使用 ESM，import 规范写 `.js`（TS “rewrite to .js” 约定），`tsconfig` 用 `moduleResolution: Bundler`。
- Node 22 的 `--experimental-strip-types` **不会**把 `.js` 规范重写成 `.ts`，因此裸 `node --experimental-strip-types` 无法解析。故所有运行入口（server / demo / test）统一经 `tsx` 加载，`tsx` 会将 `.js` 规范解析到 `.ts` 文件。
- `package.json` 的脚本已改为 `node --import tsx ...`。

## 4. Mock 优先（无 Key 即可全量测试）

- 硬性要求：「必须用 Mock LLM 测试核心 Runtime」。因此 `MockProvider` 接受 `MockResponder(ctx)`，可按上下文（如「上一步是否搜到文件」）决定下一步动作，能覆盖「反应式多步工具调用」「达到限制」「取消」等复杂场景。
- 真实 LLM（`openai`）与真实搜索（`serper`）路径**编码完成但本环境无 Key，未端到端验证**——在文档中如实标注，不宣称「已验证」。

## 5. 安全边界下沉到 Tool Registry

- 把「未知工具 / 权限 / 参数 / 超时 / 异常」的校验集中到 `ToolRegistry.execute`，工具实现本身只关心业务。**模型无法指定绕过 Registry 的执行路径**。
- 关键：即便模型请求了不在白名单的工具（如 research 任务请求 `run_tests`），也会在 Registry 被 `PERMISSION_DENIED` / `UNKNOWN_TOOL` 拦截。

## 6. 仓库与网络工具的安全策略

- **Codebase**：`assertInsideRepo` 在读取/搜索前校验目标位于 `repoPath` 内；敏感文件名（`.env`、`*.key`、`*secret*.json` 等）直接拒绝。`run_tests` 仅 `shell:false` 的**白名单命令**子进程，20s 超时 + `SIGTERM`。
- **Research**：`checkUrl` 纯函数覆盖 localhost / 私网 / `169.254.169.254` 云元数据 / 内网域名 / 白名单；`fetch_page` 在初始目标与**每次重定向后**都重新校验；限制响应大小、总超时、内容类型。

## 7. 持久化：SQLite（`better-sqlite3`）

- 选型理由：单文件 / 内存、零外部服务、事务可靠，足够 MVP。
- 表：`runs`（任务记录）、`events`（可观测事件流）、`checkpoints`（恢复用消息快照）。
- `:memory:` 用于测试与演示，避免污染；生产可配置 `SQLITE_PATH` 文件。

## 8. 状态机：显式合法转换表

- 用 `ALLOWED` 表 + `assertTransition` 在 `setStatus` / `finalize` 强制；非法转换在开发期即抛错，避免「幽灵状态」。
- 仅 `failed` / `limit_reached` 可恢复，且必须存在检查点。`awaiting_user` 是「等人回答」的终态，不冒充可恢复状态：回答走新一轮任务 + `contextHistory`。

## 9. 用量与费用：明确标注估算

- Mock 下 token / cost 为**估算**（`isEstimate=true`）；真实 LLM 下由 Provider 返回实际值（未验证）。报告与前端均区分，避免把估算当作真实计费。

## 10. 前端：原生 JS 而非框架

- MVP 目标是「可演示」，原生 JS + SSE 即可覆盖：提交任务、查看状态/统计/事件流/答案/来源。无构建步骤，降低维护成本。生产可替换为 React/Vue。

## 11. API Key：`.env` 与「界面单次覆盖」双通道

- **需求**：用户希望「至少给个界面让我接 API」，不想每次改 `.env` + 重启。
- **设计**：`RunInput.llm` / `RunInput.search` 作为**单次任务级覆盖**，优先级高于 `.env`；Provider 工厂与 `ToolRuntimeConfig` 都遵循「`input.*` ?? `config.*`」。
- **不静默降级**：显式选 `openai`/`serper` 但无 Key 时**抛错 / 返回 400**，而不是退回 Mock——否则会把「真实调用失败」伪装成「成功」。
- **Key 不落库**：`RunRecord` 不含任何 Key 字段；EventLogger 对 `apiKey`/`token`/`sk-...` 等脱敏。前端「保存 Key」为**默认关闭的 opt-in**（localStorage，仅本机）。
- **已声明的代价**：本地 HTTP 无 TLS，Key 在浏览器→服务端之间为明文；跨进程 `resume` 会丢失单次覆盖（`rebuildInput` 只重建 `runType`/`goal`）。

## 12. 请求校验抽成纯函数 `validateRunRequest`

- 原实现把校验写在 Express 路由里，难以单测。抽成纯函数后，可在**不发任何请求、不启动服务**的前提下覆盖全部 400 分支（这也是测试套件不触达真实 LLM / 搜索 API 的关键）。

## 13. 数据库选型：按「数据形态」和「部署规模」分阶段，而不是一次选到底

这类项目（Agent Runtime / Harness）的数据**不是一种形态**，用一张表或一种库硬扛必然别扭。先按形态归类：

| 数据形态 | 本项目中的表/文件 | 特征 | 适合的存储 |
|---|---|---|---|
| **状态** | `runs`、`checkpoints` | 低频更新、要事务、要强一致、按主键点查 | 关系库（SQLite → Postgres） |
| **事件流 / span** | `events` | **只追加、不更新**、按 `runId` 顺序读、量大、用于回放与耗时分析 | 关系库够用到十万级；再大上 ClickHouse / 时序库 |
| **结构化结果（JSON 文档）** | `runs.resultJson`（`{misc, orchestration, subtasks}` 信封）、`checkpoints.messagesJson` | 半结构化、整体读写、不需要按内部字段查询（当前） | 关系库的 JSON 列（SQLite JSON1 / Postgres **JSONB**） |
| **大文本 / 产物** | 工具结果正文、`artifacts`、trace 附件 | 大、读少、不该进主库 | 对象存储（S3 兼容 / MinIO / 云 OSS） |
| **诊断日志** | `data/errors.log`（JSONL） | 追加、按行 grep、无需事务 | 文本文件即可（本项目现状），量大再进日志系统 |
| **缓存 / 幂等 / 锁** | （当前没有，未来加幂等键时要） | 键值、TTL、原子操作 | Redis / Valkey |
| **向量（记忆 / RAG）** | （当前没有） | 相似度检索 | pgvector（与 Postgres 同库，首选）→ Qdrant / Milvus |

### 分阶段建议

| 阶段 | 场景 | 选型 | 依据（含本项目实测） |
|---|---|---|---|
| **1｜现在就够** | 单人 / 本机 / 演示 | **SQLite（`better-sqlite3`，WAL）** — 即现状 | 实测单个任务产生 **30~80 条事件**、10 次以内模型调用；SQLite 单文件在 WAL + 批量单事务下可轻松处理**每秒上万次追加**。多机共享是它的**唯一**硬伤（WAL 依赖本地文件锁） |
| **2｜要多人/多机就要换** | 单机多用户、小团队、要并发写 | **Postgres**（+ Redis） | 多写者并发、JSONB 直接替代 `resultJson`/`messagesJson`、行级锁、`LISTEN/NOTIFY` 可替代 SSE 的进程内广播；加 **Redis** 做幂等键 / 分布式锁 / 速率限制 / 任务队列 |
| **3｜要做分析再拆** | 多机、事件量大、要按 span 出报表 | **Postgres（主）+ ClickHouse（事件/span）+ 对象存储（大产物）+ Redis + 消息队列（NATS/Kafka/云 MQ）** | 事件是"只追加 + 聚合查询"，列存比行存快 1~2 个数量级；但**只有当你要按天/按模型/按工具出成本与延迟报表时才有必要** |

### 如果只记一句话

> **单机 → SQLite；多机 → Postgres；要出报表 → 再把事件流拆到列存。** 其余（Redis / 对象存储 / 向量库）都是**按需挂载的插件**，不是起步必需。

### 从本项目迁移的路径（已被架构预留）

1. `SqliteStore` 的方法集（`createRun / updateRun / appendEvents / getEvents / saveCheckpoint / getLatestCheckpoint / listRuns`）已经是事实上的 **Store 接口**——抽成 `interface Store`，再加 `PostgresStore` 实现即可切换，Runtime 无需改动。
2. 迁移时要注意 3 个坑：① `seq` 现在是**单进程内存计数器**（`EventLogger.seqByRun`），多进程必须改成数据库侧原子分配（Postgres 序列 / `INSERT ... RETURNING`）；② `appendEvents` 的批量单事务语义要保留；③ `SQLite 的 TEXT 时间戳` 建议换 `timestamptz`。
3. 大字段先分流：`resultJson` / `messagesJson` 若超过几十 KB，应把**正文**移到对象存储、库里只留引用（本项目 `artifacts` 已是这个思路：正文不回传主 Agent）。

### 反模式（别过早）

- ❌ MVP 就上 Kafka / ClickHouse / Milvus：协调成本远大于收益（本项目单任务 30~80 事件，用不到）。
- ❌ 把事件表和大文本混在一张表：任何一次全表扫描都在读几十 KB 的正文。
- ❌ 无保留策略：事件表必须有清理/分区策略（例如按 `createdAt` 保留 N 天，或按 run 归档）。
- ❌ 把"日志"当"状态"：`errors.log` 只能 grep，**不要**用它恢复任务状态（状态只认 `runs`/`checkpoints`）。
