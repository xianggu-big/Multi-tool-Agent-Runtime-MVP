# 写能力 + Docker 沙箱 + 三级人工审批（设计与实施记录）

> **状态**：**实施完成 + 终验完成**（2026-10-15；实施提交 `243ee31`，终验见 §3）；**2026-10-19 异步沙箱 + L1/L2 验证闭环已收口**（见 §3.8）；**2026-10-20 崩溃对账/恢复已收口**（见 §3.9），**宿主复验能力探测已收口**（见 §3.10），**高危批次当前批次二次确认已收口**（见 §1.3 / §3.5）。
> **用途**：① 设计决策与实施记录；② 第 0 节「终验复核清单」= 两轮评审全部硬性要求；③ **§3 = 逐条终验结果（状态 + 证据）**。
> **关联**：`reports/CHANGELOG.md`（变更明细）、`reports/PROJECT_REPORT.md`（能力/风险 R14/R15）、`.eval/`（实测脚本）。

---

## 0. 终验复核清单（两轮评审的硬性要求，逐条验收）

> **终验执行记录**：2026-10-15，**逐条结论与证据见 §3**（状态 + `文件:行号` + 命令输出；凡未达成/部分达成的都在 §3 单列）。

### 第一轮评审（P0/P1/P2）
- [x] **P0-1 不用 bind mount**：Linux ABI `node_modules` 烧进镜像；每次 `docker cp` 仓库快照（排除 node_modules/data）进容器内部 FS；`.dockerignore` 排除 node_modules/data/.git/.workbuddy；宿主 `data/sandbox/<runId>/` 只留改动副本
- [x] **P0-2 镜像工具链**：Dockerfile 含 `build-essential python3`（better-sqlite3 回退源码编译可用）；`npm ci` 带超时/重试/日志；构建脚本可独立重跑
- [x] **P0-3 search_files 三重陷阱**（前置）：① `kind` 默认改 `content` **且** 0 命中返回修正 hint ② 多关键词 `a|b` 语义修正 ③ `path`/`dir` 作用域参数进 schema —— **两项都做，不是二选一**
- [x] **P1-4 循环归属**：`code-edit` 走 `subAgentLoop`；`requestApproval` 在 `loopBody` 与 `subAgentLoop` **两处** ToolContext 构造点都注入；沙箱按 **parentRunId 复用**；run 终态 + 启动孤儿回收时清理
- [x] **P1-5 阶梯分级 + 批量审批**：L0 语法（每次改动）→ L1 `tsc --incremental` + 受影响测试（每个审批请求=一个 change set 跑一次）→ L2 全量（`strictVerify` 审批前触发；终态 run 可手动 `POST /api/runs/:id/verify`）；审批按 change set 批量（防"10 文件 10 次打断"）（2026-10-19 收口，详见 §3.8）
- [x] **P1-6 diff 不进事件流**：diff 落 `data/sandbox/<runId>/diffs/<approvalId>.patch`；事件只带 approvalId + 摘要；前端经 `GET /api/runs/:id/approvals` 拉全文
- [x] **P1-7 CRLF 策略**：匹配双端归一化 LF（忽略行尾差异）；写回按原文件**主导行尾**；BOM 保持；必须有 CRLF 专用测试用例（实测仓库为 CRLF：`src/server.ts` 975 行 CRLF）
- [x] **P1-8 宿主复验执行者**：钉死系统 Node 24 绝对路径（`D:/Program Files/nodejs/node.exe`，配置项 + 存在性前置检查），走 `run_tests` 同款白名单机制（不用自由 shell）
- [x] **P1-9 git init 前置**：作为 Step 0 第一件事（替代方案里的"可选"）
- [x] **P2-a `pausedMs` 持久化**：进 Budget + checkpoints **加列**（走 migrate 模式）；resume 不重计审批等待
- [ ] ⚠️ **P2-b 墙钟口径**：事件/报告区分 active / waiting（审批等待不污染对比口径）（部分达成，详见 §3.5）
- [x] **P2-c 敏感清单统一**：直接改 `security.ts` 的 `isSensitive` 为大小写不敏感（不做两套）；对抗套件 c3「BUG 证据」→「回归守卫」
- [x] **P2-d 容器安全**：非 root（node 用户）+ 无网络隔离写进诚实清单
- [x] **P2-e 预算标注**：code-edit 预算 12/12/24/120k 标注"待实测修正"
- [x] **P2-f 原子写**：Windows 下 rename 遇 EPERM/EBUSY 短重试（3 次退避）
- [x] **P2-g 批次合并审批**：纳入 M1（不是后续演进）

### 第二轮评审（v3）
- [x] **v3-1 git init 在根层**：`<workspace>\` 根层 init（`.eval/` 与根 `AGENTS.md` 在根层，只在子目录 init 会漏）；新建根级 `.gitignore`（合并 `multi-tool-agent/.gitignore` 规则 + `.workbuddy/` 两层忽略）；**`.eval/` 保留跟踪**（实测脚本是证据）
- [ ] ⚠️ **v3-2 重派交接 brief**：`SandboxSession` 维护 `changeSets[{files,status,lastClassifierVerdict,retriesLeft}]`；`buildSpawnSubAgent` 在派发（含重派）时注入 `SubtaskRequest.inputs`，`subAgentLoop` 渲染进初始消息；**重试轮次计数器存在沙箱会话**（按 parentRunId+文件），防止靠重派绕开重试上限（部分达成，详见 §3.5）
- [ ] ⚠️ **v3-3 批量审批语义消歧**：① `deny` 理由**按文件**回喂 ② "连续拒绝 3 次"**按文件计数**（整批全拒 → 每文件各计 1 次）③ 同批内 allow_file 自动落盘与待批文件哈希守卫互不影响（注释写明）（部分达成，详见 §3.5）
- [x] **v3-4 L1 测试映射三级兜底**：① 同名 `tests/*.test.ts` ② `tests/**` 中 grep 到被改模块路径/名字 ③ 都找不到 → **L1 降级为全量 `npm test`**（绝不允许"找不到映射=不跑测试"）
- [x] **v3-5 search_files 措辞**：默认 content + 0 命中 hint **两个都做**

### 诚实清单（须如实披露，不得含糊）
- [x] 容器内**无网络隔离**（run_command 可联网）
- [x] Linux 沙箱 ≠ Windows 宿主：L2 宿主复验 + git/备份自动回滚兜底；环境性失败标 `ENV_MISMATCH`（不算模型改错）
- [x] `run_command` **落宿主后的副作用靠 git 兜底**（无法从沙箱同步副作用），审批卡明确标注
- [x] 沙箱快照走 docker cp（src+tests ≈1MB；node_modules 走镜像不进快照）
- [x] 重派次数 × 3 轮重试的最坏成本存在（交接 brief 只保证不重复劳动，不承诺不烧 token）
- [x] 本里程碑**不做**：主 Agent 写权限、人工改派/暂停等完整调度接口、`SubAgentLifecycle` 接线（只如实标注为"已实现、运行期未接线"）

---

## 1. 设计要点（定稿摘要）

### 1.1 能力层：5 个新工具（riskLevel=high，同一条"沙箱→审批→落盘"管线）
| 工具 | 作用 | 关键约束 |
|---|---|---|
| `create_file` | 新建文件 | 路径围栏（resolveWorkspacePath + realpath 复核）、敏感文件拒写、大小上限 |
| `edit_file` | 精确替换（oldString 唯一命中） | CRLF 归一化匹配、写回保原行尾、记录 base 哈希（TOCTOU） |
| `delete_file` | 删除文件（软删到 `data/backups/<runId>/`） | 只删文件，不删目录 |
| `copy_path` | 复制文件/目录（含备份用途） | 目标必须在仓库内 |
| `run_command` | PowerShell/cmd（构建/测试/安装类） | 沙箱内先跑；落宿主需审批；超时 + 输出上限 |

新增权限 `codebase:write`。**M1'（2026-10-16）起默认可用**：`CODEBASE_WRITE_ENABLED` 默认 `true`（写工具不再隐藏；部署可显式 `false` 整机禁用 → UI 显示"被禁用"）。写操作由三层把关：**本 run 界面显式授权**（`orchestration.allowWriteSpecs`，默认不勾，fail-closed）→ 沙箱阶梯 → 人工审批。

### 1.2 Docker 沙箱
- 镜像 `mta-sandbox:node24`：`node:24-bookworm-slim` + `build-essential python3` + `npm ci`（Linux ABI 的 better-sqlite3 / sqlite-vec）→ 容器内能真跑 `tsc` 与 `node --test`。
- 每次运行：`SandboxSession`（per parentRunId）→ `docker cp` 快照进容器 `/work` → 应用改动 → 检查阶梯 → 收集诊断。容器非 root、`--rm`。
- 分类器 `src/sandbox/classify.ts`：`SYNTAX / TYPE / TEST_FAIL / TIMEOUT_HANG / CRASH / PATH_ESCAPE / SENSITIVE_FILE / OUTPUT_LIMIT / ENV_MISMATCH / UNKNOWN`，每条带修复提示；规则拿不准 → LLM 判定 → 仍不可处理 → 升级 human（沿用 `escalateTo` 契约）。
- 重生成闭环：分类 + 容器报错原文回喂；每文件 3 轮；不过则停下如实上报。

### 1.3 审批门禁
- `ToolContext.requestApproval?()`（Runtime 注入）→ `pendingApprovals`（仿 `cancellers`）+ `decideApproval`；等待期 `pausedMs` 累计且持久化。
- 三态：`allow_file`（本 run 内该文件后续沙箱全绿即自动落盘；**敏感文件永久逐次**；哈希不符自动失效重弹）/ `allow_once` / `deny`（理由按文件回喂 + 该文件连续 3 次 → 强制收尾）。
- **高危批次不复用粘性 + 当前批次二次确认**：批次含 `delete` 或宿主命令时，`canAutoApprove()` 一律 false；即使人工选 `allow_file`，也不把文件加入粘性集合（`approval_decided.stickySkipped=true`）。批准类决定还必须额外携带 `confirmHighRisk=true`：Runtime 在缺少确认时返回 `null` 且保留挂起项，HTTP 返回 `400 {code:"HIGH_RISK_CONFIRMATION_REQUIRED", reasons:[...]}`；拒绝不需要确认。前端审批卡显示红色高危区，未勾选“我已核对”时只锁定批准按钮，拒绝始终可用。回归 `tests/53g/h/i/k/l/m`。
- 落盘：原子写（短重试）+ TOCTOU 哈希守卫 + 备份 + `audit_log`（before/after）。
- 事件：`approval_requested`（摘要 + `highRisk/riskReasons/requiresExplicitConfirmation`）/ `approval_decided`（持久化 → SSE + 断线重放；高危批准记 `highRiskConfirmed:true`）。接口：`POST /api/runs/:id/approvals/:approvalId`（高危批准需 `confirmHighRisk:true`）、`GET /api/runs/:id/approvals`（含 diff 全文与风险元数据）。

### 1.4 前端
live 卡片（沿用 `mkCard`）：标题 + diff（+/- 着色，经 GET 拉全文）+ 沙箱检查逐项 ✅/❌ + 三按钮 + 拒绝理由；"待审批 N"徽标；决定后可回放。
**M1'（2026-10-16）增强**：审批卡出现时**自动滚入视野 + 短暂高亮**；编排面板新增「允许修改文件」开关（默认不勾；部署禁用 / 白名单不含 `code-edit` 时显示可见警示）；goal 命中「修改文件」意图但当前不会改文件时（非编排 / 未勾选 / 部署禁用），弹**修改意图确认对话框**（仍以只读提交 / 去开启写能力——自动切编排+勾选+高亮）。

### 1.5 code-edit 契约与编排开关
新 spec `code-edit`：5 写工具 + `read_file/list_files/search_files/run_tests` + `submit_finding`；权限恰等于工具并集；预算 12/12/24/120k（**待实测修正**）；`maxRiskLevel:'high'`；**走 subAgentLoop**。编排**未授权不可派发写 spec**（`allowWriteSpecs` fail-closed——**M1' 已四处完整接线**：契约目录过滤 / `ToolContext.writeSpecsAllowed` 注入 / `delegate_subtasks` 守卫（`WRITE_NOT_ALLOWED`）/ `spawnSubAgent` 结构层兜底）+ **本 run 界面开关（已实现，M1'）**；主 Agent 保持只读。

---

## 2. 实施进度记录（随实施更新）

| 日期 | 步骤 | 状态 | 备注 |
|---|---|---|---|
| 2026-10-15 | 方案定稿 v3（两轮评审） | ✅ | 用户批准并要求终验按第 0 节清单逐条复核 |
| 2026-10-15 | Step 0a 根层 git init | ✅ | 提交 `0ea9828`（156 文件）+ `f2c21b6`（取消跟踪 .zcode/）；.gitignore 补 `.workbuddy/`、`.zcode/`；`.eval/` 保留跟踪（`git ls-files .eval/` 5 条） |
| 2026-10-15 | Step 0b search_files 修复 | ✅ | 三项齐做（默认 content + 0 命中 hint / `A\|B` OR / `path`+别名）；新增 `tests/37_search_files_semantics.test.ts`（7 用例）；`.eval/probe-search3.mjs` 改造成 PASS/FAIL 回归探针（**6 项全 PASS**）；全量 **243/243** 绿 |
| 2026-10-15 | Step 1 镜像构建 | ✅ | `scripts/sandbox/{Dockerfile,build-image.mjs}`；实测 `docker images` → `mta-sandbox:node24 fe73d180cbe6`；容器内 tsc 退出 0、套件 269 pass/1 skip/0 fail |
| 2026-10-15 | Step 2 沙箱模块 | ✅ | `src/sandbox/{docker,session,classify}.ts`；实测快照+容器就绪 9.2s、L1 阶梯 17.1s 全绿（`.eval/m1-ladder-probe.mjs`）；`tests/40` 12 用例 |
| 2026-10-15 | Step 3 写工具 | ✅ | `src/tools/codebase/writeTools.ts`（5 写工具 + submit_changes）；`tests/39` 9 用例（含 CRLF、敏感文件、越界、超限） |
| 2026-10-15 | Step 4 审批门禁 | ✅ | 三态 + 粘性 + 按文件计数 + 超时 + pausedMs；`tests/38` 8 用例；接口 `GET\|POST /api/runs/:id/approvals`（server.ts:519/538） |
| 2026-10-15 | Step 5 前端审批卡 | ✅ | live 卡片（diff 着色/检查逐项/三按钮/拒绝理由/待批徽标）；另一 agent 用合成事件验过 UI，本文件 §3 提供真实事件链证据（未重复截图） |
| 2026-10-15 | Step 6 spec + 编排开关 | ✅ | `code-edit` 契约（specs.ts:184-222）+ `allowWriteSpecs` fail-closed（server.ts:200）；`agents/code-edit.agent.md` 已生成；`agents:lint` 3 项过 |
| 2026-10-15 | Step 7 端到端 | ✅ | 真 Docker + 真模型三态实测（deny / allow_once / allow_file 粘性）全部通过；**期间修掉 4 处阻断性缺陷**；证据见 §3 |
| 2026-10-15 | Step 8 文档报告 + 终验 | ✅ | 本文件 §3 终验结果 + `reports/{CHANGELOG,PROJECT_REPORT,PARAMETERS}.md` + 根 `AGENTS.md`；提交见 §3 末尾 |
| 2026-10-20 | Step 9 编辑管线评测 | ✅ | `npm run eval:edit` 7 场景真 Docker 跑通（7/7）；产物 `reports/EDIT_EVAL.md`；汇总回归 `tests/55`；详见 §3.11 |

---

## 3. 终验结果（2026-10-15；逐条对照第 0 节清单）

> **方法**：真机 Docker（镜像 `mta-sandbox:node24`）+ 真实模型（deepseek-flash，`LLM_MODE=openai`）+ 独立库/端口（`PORT=3033 SQLITE_PATH=./data/m1-e2e.db CODEBASE_WRITE_ENABLED=true`）。
> **三态端到端实跑**（`.eval/m1-e2e-drive.mjs` / `.eval/m1-e2e-attach.mjs`）：
> - **deny 路径**（`run_mv93o3l6_9ef890e8`，7,310 tok / $0.00050）：编排 → code-edit → `create_file` → `submit_changes` → `approval_requested` → **拒绝** → `approval_decided{value:deny,actor:human}` → **仓库无该文件**（`git status` 干净）→ 工具结果带拒绝理由（`APPROVAL_DENIED` 事件）→ 模型如实收尾（run completed，escalateTo=human，未虚报成功）。
> - **allow_once 路径**（`run_mv93w68k_f3c4fe2b`，7,064 tok / $0.00044）：`approval_requested` → **放行** → `applied:["docs/_m1_smoke.md"]` + **`hostVerify:{ran:true, ok:true, note:"宿主全量测试通过"}`** → 文件真落盘（19 B，内容 `M1 端到端验证`）→ run completed。
> - **allow_file 粘性**（`run_mv93zcfc_863d8c2e`，11,534 tok / $0.00071）：第一次提交人工 `allow_file`；模型改内容后**第二次提交** → **无新 `approval_requested`**，直接 `approval_decided{value:allow_file, actor:sticky-policy, autoByPolicy:true}`；文件最终内容 `第二次`（两次都落盘）；`approval_requested` 总数=1、`submit_changes` 调用=2。
> - 三态合计 **$0.00165**；含诊断期失败 run 的总实测花销 < $0.01（预算 $0.05）。

### 3.1 第一轮评审（P0/P1/P2）

| 条目 | 状态 | 证据 |
|---|---|---|
| **P0-1 不用 bind mount** | ✅ | `docker.ts:57` 的 `docker run` 参数无 `-v/--mount`（全仓 grep `'-v'`/`"--mount"` **0 命中**，仅注释）；快照走 `copyRepoSnapshot`（`session.ts:45`）+ `docker cp`（`docker.ts:60`）；`.dockerignore` 排除 node_modules/data/.git/.workbuddy/.zcode；实测宿主副本 `data/sandbox/run_mv93zcfc_863d8c2e/repo/` 内**无** node_modules/data（Linux 依赖在镜像里）。**终验加固**：`.env`/`.env.*` 也排除出快照（`session.ts:31` `isSnapshotExcluded`，防容器内 `cat .env` 绕过读工具拒读；`tests/40k` 断言 `.env`/`.env.local` 不在快照、`.env.example` 保留） |
| **P0-2 镜像工具链** | ✅ | `scripts/sandbox/Dockerfile`：`build-essential python3 ca-certificates`；`npm ci` 3 次重试 + 装后自检 `require('better-sqlite3')`；`chown -R node:node /work` + `USER node`。`build-image.mjs` 可独立重跑（`--no-cache`）。实测：`docker images` → `mta-sandbox:node24 fe73d180cbe6`（1.17GB）；容器内 `npx tsc -p tsconfig.json --noEmit` 退出码 0；容器内全量套件 269 pass / 1 skip / 0 fail（约 13s） |
| **P0-3 search_files 三重陷阱** | ✅ | 提交 `403b337`；`.eval/probe-search3.mjs` **6 项全 PASS**：①不传 kind 默认 content 且命中（10 条）；①b 隐式/显式一致；②`A\|B` 为 OR；③`path` 限定生效（src/tools/codebase 内 3 条）；③b 越界 → `PATH_ESCAPE`（不静默退化）；④0 命中返回可行动 hint。`tests/37` 7 用例 |
| **P1-4 循环归属** | ✅ | 子循环 ToolContext 注入点 `subAgentLoop.ts:310-324`（`sandbox`/`requestApproval` 由 `AgentRuntime.ts:1197-1198` 传入，仅写 spec）；主循环注入点 `AgentRuntime.ts:982-983`；沙箱按 **parentRunId** 复用（`AgentRuntime.ts:244-254` `getSandboxSession(runId,…)`）；run 终态清理 `disposeWriteState`（`:279`）在 `finalize`（`:1051`）调用；启动孤儿回收 `runtime/index.ts:57`（仅 `writeEnabled` 时探 Docker）。实测：三个 run 到达终态后 `docker ps -a --filter name=mta-sb-` **为空** |
| **P1-5 阶梯分级 + 批量审批** | ✅（2026-10-19） | L0/L1 真实执行；L2 有两条触发路径：`strictVerify` 在审批前跑宿主全量、终态 run 可手动 `POST /api/runs/:id/verify`（异步状态机 + 取消 + 事件）；一个 change set 一次审批（`tests/38e` 断言 `approvalCalls.length===1`）、上限 10 文件。回归 `tests/49`/`50`；真机 Docker 阶梯 `40j` |
| **P1-6 diff 不进事件流** | ✅ | 事件载荷白名单（`AgentRuntime.ts:315` 仅 relPath/op/addedLines/removedLines）；patch 落盘 `data/sandbox/<runId>/diffs/<approvalId>-<file>.patch`（`writeTools.ts:405` + `session.ts:455` `diffPatch`）；全文仅经 `GET /api/runs/:id/approvals`（`server.ts:538-556`）。实测：`approval_requested` 原始载荷 **308 字节**、`hasDiffKey=false`、`hasPatchBody=false`；GET 返回 **153 字节完整 patch**（含 `@@ -0,0 +1 @@`） |
| **P1-7 CRLF 策略** | ✅ | `textEdit.ts:8-35`（匹配双端归一化 LF/BOM；写回按原文件主导行尾 + 恢复 BOM）；`tests/39g`（CRLF 原文件 + LF oldString → 暂存内容保持 CRLF）。实测仓库确为 CRLF：`src/server.ts` 1020 行**全部 CRLF**（CRLF=1020 / LF-only=0） |
| **P1-8 宿主复验执行者** | ✅ | `writeTools.ts:339-356`：`HOST_NODE_PATH`（配置 + `existsSync` 前置检查）→ `spawnSync(nodePath, ['--import','tsx','--test','tests/*.test.ts'])`，**argv 直调不经过 shell**（对齐 `run_tests` 的白名单取向）。实测 allow 路径事件载荷：`hostVerify:{ran:true, ok:true, note:"宿主全量测试通过"}`。**终验修复**：复验改走**净环境**（`writeTools.ts:330` `sanitizeHostVerifyEnv`；`tests/39i`）——见 §3.4-② |
| **P1-9 git init 前置** | ✅ | `git log --oneline`：`0ea9828`（根层 init，156 文件）+ `f2c21b6`（取消跟踪 .zcode/）；根 `.gitignore` 合并 multi-tool-agent 规则 + `.workbuddy/`/`.zcode/`；`.eval/` **保留跟踪**（`git ls-files .eval/` 5 条） |
| **P2-a `pausedMs` 持久化** | ✅ | 建表列 `SqliteStore.ts:81`；migrate 走 ALTER TABLE（`:92-96`）；写入 `:194-210`；读出 `:224`；resume 恢复 `AgentRuntime.ts:450`（`budget.pausedMs = cp.pausedMs ?? 0`）；checkpoint 保存 `:1257`；`tests/38a` 断言暂停语义（对照组证明不暂停会超时）。**说明**：没有"resume 后 pausedMs 被恢复"的端到端单测（代码级验证） |
| **P2-b 墙钟口径** | ⚠️ | 机制 ✅：`Budget.pause()/resume()` + `activePausedMs/activeElapsedMs`（`Budget.ts:44-60`），暂停期不计 `totalTimeoutMs`（`tests/38a` 实验组/对照组）。**报告口径 ❌**：全仓 grep `waitingMs`/`activeMs` **0 命中**——RunResult / 事件 / 报告都**不区分 active vs waiting**，"审批等待不污染对比口径"只做到超时判定层，没做到展示与统计层 |
| **P2-c 敏感清单统一** | ✅ | `security.ts:49-55` 统一 `toLowerCase()` 判定（单一清单）；读/列/搜共用（`readFile.ts:60`、`listFiles.ts:65`、`searchFiles.ts:95`）+ 写工具（`writeTools.ts:64`）；`tests/39a`（`.ENV` 与 `.env` 同判 + 正常路径控制组）；对抗套件 c3 已是回归守卫（`tests/32`） |
| **P2-d 容器安全 + 诚实清单** | ✅ | Dockerfile `USER node` + `chown -R node:node /work`；无网络隔离**如实披露**（本轮写入 `CHANGELOG` 2026-10-15 参数表 + `PROJECT_REPORT` R14）；终验补 `.env` 不进快照（同 P0-1） |
| **P2-e 预算标注** | ✅ | `specs.ts:210` 注释「预算为初始值，**待实测修正**」；`reports/PARAMETERS.md` §2.4 由 `SUB_AGENT_SPECS` 生成，含 `code-edit 12/12/24/120k` 行 |
| **P2-f 原子写** | ✅ | `session.ts applyToRepo`（`:521-566`）：`tmp + rename`，EPERM/EBUSY 短重试 **3 次退避 120/240/360ms**（`:544-558`），失败如实返回原因并清理临时文件 |
| **P2-g 批次合并审批纳入 M1** | ✅ | 同 P1-5：`submit_changes` 一次审批覆盖整个 change set（含 `run_command` 暂存队列），非"每文件一次"（`tests/38e` 断言 `approvalCalls.length===1`） |

### 3.2 第二轮评审（v3）

| 条目 | 状态 | 证据 |
|---|---|---|
| **v3-1 根层 git init** | ✅ | 根层 `.git/`（提交 `0ea9828`）；`.gitignore` 合并两层规则（`node_modules/`、`data/`、`.env`、`.workbuddy/`、`.zcode/`）；`.eval/` 保留跟踪 |
| **v3-2 重派交接 brief** | ✅（实现）/ ⚠️（注入无运行时证据） | 沙箱会话维护改动集合含 `status/lastVerdict/retriesLeft`（`session.ts:39-51` `ChangeRecord`）；`briefFor()` 渲染半成品/失败分类/剩余轮次（`session.ts:455-471`）；`buildSpawnSubAgent` 派发时注入 `sandboxBrief`（`AgentRuntime.ts:1199`）；`subAgentLoop.ts:151-152` 把 brief 作为**首条 user 消息**注入全新上下文；重试轮次**存会话**（`stage()` 沿用 `prev.retriesLeft`，`session.ts:271`）→ 重派不重置。**与"重派"的相互作用（如实说明）**：派发守卫按 `specId::objective` 去重（`AgentRuntime.ts:1126-1160`），**同 objective 的重派会被拒绝**（`DUPLICATE_OBJECTIVE`）→ brief 实际只在"主 Agent **改写 objective** 后再派"时生效。终验的 3 个真实 run 未出现这种重派（模型一次成功 / 一次放弃），故**注入路径只有代码级证据**（另 `tests/40h` 钉死 `REGEN_ROUNDS_PER_FILE===3`） |
| **v3-3 ①（deny 理由回喂）** | ⚠️ | `deny` 理由是**整批**回喂（工具结果单条 message 带 reason，`writeTools.ts:441-446`）；文件级只有 `mark(rel,'denied')`（`:439`）——**没有"按文件各自理由"的结构**（一条决策一个 reason，实现与清单措辞不一致） |
| **v3-3 ②（连续拒绝按文件计数）** | ✅（实现）/ ⚠️（无单测） | `decideApproval` 对**每个文件**计数（`AgentRuntime.ts:362-370`），整批全拒 → 每文件各 +1；达上限置 `denyLimitReached`（回喂模型"停止重试"）。**`tests/38` 未覆盖**（38 只测三态与门禁；`denyLimitReached` 无断言） |
| **v3-3 ③（allow_file 自动落盘与哈希守卫）** | ⚠️ | 语义成立：落盘**逐文件**走 `applyToRepo`（TOCTOU 哈希守卫），失败进 `refused` 不影响其它文件（`writeTools.ts:452-462`）。**但清单要求的"注释写明"缺失**——全仓 grep「互不影响」0 命中 |
| **v3-4 L1 测试映射三级兜底** | ✅ | `affectedTests()` ①同名/含名 ②tests 内 grep 被改模块路径片段（`session.ts:333-365`）；**空 → 全量 `npm test`**（`session.ts:372-378`，注释明确"绝不允许找不到映射=不跑测试"）。实测：本次改动无同名测试 → 走全量兜底，容器内跑通（探针 17.1s 全绿） |
| **v3-5 search_files 措辞** | ✅ | 同 P0-3（默认 content + 0 命中 hint **两项都做**，探针①②④全 PASS） |

### 3.3 诚实清单（6 条）

**状态：✅（本轮补齐后才达成）**。复核发现：这 6 条**原先只写在本文档 §0/§1**，`CHANGELOG.md` / `PROJECT_REPORT.md` 中 grep「无网络隔离 / ENV_MISMATCH / 副作用 / docker cp / 重派次数 / Lifecycle 未接线」**全部 0 命中**（清单要求"写进 CHANGELOG/PROJECT_REPORT 才算达成"）。本轮已补写：

| 诚实条目 | 落在哪 |
|---|---|
| ① 容器内无网络隔离 | `PROJECT_REPORT.md` §4 **R14①**；`CHANGELOG` 2026-10-15「M1 端到端实测收口」取舍段 |
| ② Linux 沙箱 ≠ Windows 宿主：宿主复验 + git/备份回滚；环境性失败标 `ENV_MISMATCH` | `PROJECT_REPORT.md` §4 **R14③**；`CHANGELOG` 同上（`classify.ts` ENV_MISMATCH 规则） |
| ③ `run_command` 落宿主副作用靠 git 兜底（审批卡标注） | `PROJECT_REPORT.md` §4 **R14②**；`writeTools.ts:397-400` 的 `riskNote`（powershell/cmd 无沙箱预演时标注） |
| ④ 沙箱快照走 `docker cp`（src+tests ≈1MB；node_modules 不进快照） | `PROJECT_REPORT.md` §4 **R14④** |
| ⑤ 重派次数 × 3 轮重试的最坏成本存在 | `PROJECT_REPORT.md` §4 **R14⑤**；`CHANGELOG` 同段 |
| ⑥ 不做：主 Agent 写权限 / 完整调度接口 / `SubAgentLifecycle` 未接线 | `PROJECT_REPORT.md` §4 **R14⑥** + §1「明确不可用」段；`CHANGELOG` 同段 |

### 3.4 终验期间新发现（清单外；5 修 + 1 加固）

| # | 发现 | 状态 | 证据 |
|---|---|---|---|
| ① | **快照自引用崩溃**：宿主副本在 `<repo>/data/…` 内 → `fs.cpSync` 抛 `ERR_FS_CP_EINVAL: Cannot copy … to a subdirectory of self`，写工具第一步即全灭（40j 用 tmpdir 当 dataDir，结构上覆盖不到） | ✅ 已修 | `session.ts:45` `copyRepoSnapshot()`；`tests/40k`（含 cpSync 对照断言）。修复前证据：`run_mv93f16z` 事件 `tool_failed create_file ×2 EXECUTION_ERROR` |
| ② | **hostVerify 继承运行期 env → 恒失败自动回滚**：`LLM_MODE=openai PORT=3033 SQLITE_PATH=… CODEBASE_WRITE_ENABLED=true` 下宿主套件 **8 条失败**（17e/17j/17k/17l/17o/17p/20o/22q）→ 每次放行都被"落盘→回滚"，文件永远落不了盘 | ✅ 已修 | `writeTools.ts:330` `sanitizeHostVerifyEnv()` + `:350` 传 env；`tests/39i`。修复前证据：`run_mv93ox3h` 的 `hostVerify.ok=false` + 文件回滚（本轮复现：同一 env 下跑宿主套件 → 262 pass/8 fail） |
| ③ | **分类器被测试名污染**：套件输出含测试名（tests/39a「敏感文件拒写…」、40e「ERR_DLOPEN_FAILED…」）→ 套件任何失败都被误判 `SENSITIVE_FILE`/`ENV_MISMATCH`（模型收到错提示后放弃） | ✅ 已修 | `classify.ts` RULES（套件来源不走文本类判定；ENV_MISMATCH 需命中"错误行"）；`tests/40l`。修复前证据：`run_mv93i478` 的 `SANDBOX_CHECK_FAILED … SENSITIVE_FILE` |
| ④ | **容器内套件 2 条平台假设失败**（`C:/Windows/...` 在 Linux 是相对路径；容器内 DNS 对 `localhost.` ENOTFOUND）→ 与 v3-4 全量兜底叠加 → **永久阻断一切未映射文件的改动** | ✅ 已修 | `tests/14a` 平台分支断言；`tests/32a2` 佐证容错（守卫断言不变）。修后容器内套件 269 pass/1 skip/0 fail |
| ⑤ | **diff header 残留宿主绝对路径**：`replace(/a\.tmp/g)` 只换子串 → 审批卡显示 `diff --git "a/D:\c\345…\tmp\a/docs/x.md"` | ✅ 已修 | `session.ts:455-490` 逐行重写 header；实测 `diff --git a/docs/_m1_smoke.md b/docs/_m1_smoke.md` |
| ⑥ | **快照曾把 `.env` 拷进容器**（读工具层拒读 `isSensitive`，但 `run_command` 的 bash 预演在容器内真跑，`cat .env` 可绕过） | ✅ 已加固 | `session.ts:31` + `tests/40k` 断言 |

### 3.5 终验仍未达成 / 需后续处理的项（单列）

| 项 | 缺什么 | 建议 |
|---|---|---|
| **P1-5（L2）** | ~~L2 全量阶梯无触发点~~ → **已修（2026-10-19）**：`strictVerify` 审批前 L2；终态 run 手动 `POST /api/runs/:id/verify`（异步任务，可取消） | 见 §3.8；回归 `tests/50` |
| **P2-b（报告口径）** | 事件/报告不区分 active/waiting（无 `waitingMs/activeMs`） | 在 run 终态事件与 `RunResult` 补 `activeMs/waitingMs`（`Budget` 已有数据） |
| **v3-2（注入路径）** | "改写 objective 后重派"未在真实 run 中出现 → brief 注入无运行时证据 | 构造一次真实重派场景（或为 `buildSpawnSubAgent` 加单测断言 brief 传入） |
| **v3-3①（理由粒度）** | deny 理由为整批一条，未按文件分别回喂 | 要么把清单改成"整批理由"（如实承认），要么支持 per-file 理由结构 |
| **v3-3③（注释）** | 清单要求的"互不影响"注释缺失（语义本身成立） | 在 `submit_changes` 落盘段补注释说明逐文件 apply 与哈希守卫互不影响 |
| **审批语义单测** | ~~连续拒绝按文件计数 / 粘性自动放行 / 超时按拒绝 / `denyLimitReached` 均无单测~~ → **已补（2026-10-16）**：`tests/38j`（连续拒绝按文件计数 + `denyLimitReached` + 不同文件独立）/ `38k`（粘性自动放行 `autoByPolicy:true`）/ `38l`（敏感文件不进粘性 + 超时按拒绝） | — |
| **高危二次确认** | ~~只禁用粘性，人工点 `allow_once/allow_file` 仍可直接批准删除/宿主命令~~ → **已收口（2026-10-20）**：`src/security/approvalRisk.ts` 统一风险判定；Runtime fail-closed 校验 `confirmHighRisk`；HTTP 缺确认 400 且挂起项保留；前端未勾选时锁定批准按钮。回归 `tests/53k/l/m` | 仅覆盖删除 / 宿主命令；外传密钥、发布、修改审批配置等能力仍未接入独立确认 |
| **`read_file` 与沙箱不一致** | ~~子 Agent 读不到自己刚 staged 的文件（`read_file` 读真实仓库；实测 `PATH_NOT_FOUND`，模型自行绕开）~~ → **已修（2026-10-16）**：写上下文（注入沙箱时）`read_file` 优先 `readWorkFile`（副本 / 回落真实仓库 / 已删三态），返回体带 `source` 标注；回归 `tests/38i` | — |
| **阶梯阻塞事件循环** | ~~阶梯用同步 `spawnSync` → 阶梯期间服务端事件循环冻结（实测 HTTP 轮询 ECONNRESET）~~ → **已修（2026-10-19）**：`spawnAsync` + 异步 Docker/快照/阶梯全链路；回归 `tests/49a` | 见 §3.8 |

### 3.6 工程健康度（终验当日）

- `npm test` **272/272 全绿**（269 + 新增 `40k`/`40l`/`39i`）；`npm run typecheck` **0 错误**；`npm run agents:lint` **3 项通过**。
- 容器内全量套件：**269 pass / 1 skip / 0 fail**（skip 的是 40j：容器内无 Docker 守护进程）。
- 真机 Docker：镜像 `mta-sandbox:node24` 可用；快照+容器就绪 9.2s；L1 阶梯 17.1s。
- 真实模型端到端三态见本节开头（合计 $0.00165）。
- 残留物处理：演练落盘的 `docs/_m1_smoke.md`、`docs/_m1_sticky.md` 已删除；沙箱容器无残留（`docker ps -a --filter name=mta-sb-` 为空）；`data/m1-e2e.db*`（含全部实测 run 记录）**保留为证据**（`data/` 已在 .gitignore 内，不入库）。
- 服务已停（端口 3033 已释放）。

### 3.7 M1'（2026-10-16）：写能力接入 UI + `allowWriteSpecs` 完整接线

- **背景**：M1 的 `orchestration.allowWriteSpecs` 此前**只解析、未接线**（全仓无消费点），前端无入口 → 从界面发出的任务永远不可写（用户实测反馈「写功能被隐藏」）。
- **接线**：`resolveWriteSpecsAllowed`（请求授权 && 部署门禁）驱动四处——契约目录过滤（软引导）/ `ToolContext.writeSpecsAllowed` 注入 / `delegate_subtasks` 守卫（未授权 → `WRITE_NOT_ALLOWED`，文案指向界面开关）/ `spawnSubAgent` 兜底；`GET /api/config` 暴露 `writeEnabled`；默认值 `CODEBASE_WRITE_ENABLED` 改为 `true`（部署可显式关）；沙箱容器孤儿回收挪到服务入口（`src/index.ts`，避免 buildRuntime 在测试/演示中误碰 Docker）。
- **UI**：编排面板「允许修改文件」开关 + 修改意图确认对话框 + 审批卡滚入高亮（详见 §1.4）。
- **实测**（真机，`run_mvanz941_6f0f72ff`）：UI 语义请求（`allowWriteSpecs=true`、不带白名单）→ 派发 code-edit → 沙箱建文件 → 审批卡 → `allow_once` → **落盘 + `hostVerify{ran:true,ok:true}`** → completed；过程再次命中 §3.5 的「阶梯阻塞」与「read_file 与沙箱不一致」两项已知缺口。
- **回归**：`tests/42_write_gate.test.ts`（6 用例）；全量 **285/285**、typecheck 0、`agents:lint` 3 项过。

### 3.8 2026-10-19：异步沙箱 + L1/L2 验证闭环

**问题**：沙箱阶梯用同步 `spawnSync`，跑阶梯时服务端事件循环冻结（实测 HTTP 轮询 ECONNRESET）；L2 只有实现、没有触发点；验证失败缺少结构化证据。

**改动**：

- **全链路异步**：新增 `src/sandbox/exec.ts` 的 `spawnAsync()`（超时 / 输出上限 / AbortSignal）；Docker、快照、阶梯、diff、落盘、回滚均改 Promise 版本；同步版本仅保留给离线测试。回归 `tests/49`（4 例）。
- **阶梯不重复跑全量**：`runLadder('L2')` = L0 → L1 仅类型检查 → L2 全量一次；`runFullSuite()` 单独暴露。
- **两个 L2 触发点**：① 编排请求 `orchestration.strictVerify=true` → `submit_changes` 审批前额外跑 L2；② 终态 run `POST /api/runs/:id/verify` → 异步排队/运行/通过/失败/取消，`GET /api/runs/:id/verification` 查询，`POST /api/runs/:id/verification/cancel` 取消（全局并发 1）。
- **证据事件**：`verification_started` / `verification_completed` / `change_applied` / `change_rolled_back`；终态 run 追加事件前先 `flush()` 并恢复到 `maxSeq + 1`，避免主键冲突。回归 `tests/50d`。
- **宿主复验统一**：`src/sandbox/hostVerify.ts` 的 `sanitizeHostVerifyEnv()` 剔除 `NODE_TEST_CONTEXT` / `NODE_TEST_KNOWN_GLOBALS`，避免嵌套 `node --test` 把失败吞掉（本轮发现的真实 bug）。回归 `tests/39i`/`50b`。
- **UI**：深度验证面板（重新验证 / 状态 / 失败证据 / 取消）；编排「严格验证」开关；0 文件落盘时显示“改动未落盘”而不是“已落盘”。
- **报告归因**：单 run 报告的 `⑤ 审批 / 落盘 / 验证` 阶段统计验证次数、失败/取消、落盘/回滚文件数；回归 `tests/41h`。

**实测**：`npm run typecheck` 0 错误；`npm test` **334/334 通过 / 0 跳过 / 0 失败（50 个测试文件，约 15~40s（Docker 冷/热缓存差异）；Docker 已启动，40j 真机阶梯通过）**。定向套件 `38+39+40+46+49+50` = 48/48。

**边界**：手动验证状态保存在内存（服务重启丢失，MVP 可接受）；手动 L2 依赖 `run_started.inputs.repoPath`；报告已能统计验证/落盘/回滚，但还没有单独的「验证详情」章节。

### 3.9 2026-10-20：崩溃对账与恢复（落盘意图日志）

**问题**：`applyToRepo` 逐文件 `rm → rename`，`change_applied` 在整批结束后才发。进程在中间被杀时，仓库可能「部分文件已改、零事件」；在 `rm` 与 `rename` 之间被杀时，文件会消失，只剩 `.mta-tmp-*` 与原文备份。原来的启动回收只把孤儿 run 标成 `failed`，无法回答「仓库现在是什么状态」。

**改动**：

- **落盘意图日志**：新增 `src/sandbox/applyJournal.ts`。审批通过后、碰任何文件之前写 `data/backups/<runId>/apply-journal.json`（`repoPath` + 每文件 `op/baseHash/workHash/status`），逐文件落盘后更新状态。日志写失败 → `submit_changes` 返回 `APPLY_JOURNAL_FAILED` 并中止落盘（fail-closed：没有日志就无法对账）。
- **对账服务**：新增 `src/runtime/RecoveryService.ts`。启动时扫描 `data/backups/*`，按仓库现状判定五态：`applied` / `not_applied` / `missing` / `conflict` / `unknown`。
  - 只对 `RUN_INTERRUPTED`（或启动时仍非终态）的 run 生效；正常完成/正常失败的 run 一律 `not_needed`。
  - **自动恢复**只处理「编辑 + 文件消失 + 有原文备份」这一种确定性的坏状态；已落盘的编辑/新增**永不自动回滚**（避免覆盖用户后续修改）。
  - 旧版本没有日志 / 日志损坏 → `legacy`，只列备份并标记人工比对，绝不自动改文件。
  - `conflict`（当前内容既不是原文也不是本次写入）一律跳过，不覆盖。
- **单文件异常隔离**：`applyToRepo` 抛异常不再中断整批；全部文件未落盘时返回 `APPLY_FAILED`，不再出现 `ok:true + applied:[]`。
- **HTTP**：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/recovery` | 列出已生成的恢复报告（`data/recovery/*.json`） |
| GET | `/api/runs/:id/recovery` | 实时对账并返回报告（五态、计数、逐文件说明） |
| POST | `/api/runs/:id/recovery/rollback` | 回滚已落盘/消失文件；冲突文件跳过 |
| POST | `/api/runs/:id/recovery/accept` | 保留当前仓库状态，结束恢复提示 |

- **事件**：`recovery_detected` / `recovery_auto_restored` / `recovery_rolled_back` / `recovery_accepted`；终态 run 追加事件前复用 `flush()` + `maxSeq + 1` 校准。
- **UI**：终态 run 显示「崩溃恢复」卡（已落盘/消失/冲突/自动恢复计数、回滚/保留按钮、逐文件明细）。
- **配置**：`RECOVERY_AUTO_RESTORE_MISSING`（默认 `true`）。

**实测**：`npm run typecheck` 0 错误；`npm test` **55 文件 / 370 子测试 / 370 通过 / 0 跳过 / 0 失败 / 约 18s**；`tests/51` 覆盖五态、启动自动恢复、手动回滚、冲突保护、旧日志人工比对、HTTP 入口；`51g` 用**独立 Node 进程**在 `rm` 后、`rename` 前真实 `SIGKILL`（Windows 上报 `exit=1`），再由启动扫描从备份恢复；`38g2/38g3` 覆盖日志 fail-closed 与单文件异常。

**边界**：只覆盖落盘窗口，不覆盖模型执行中断后的对话恢复；单写者前提（没有跨进程文件锁）；`data/recovery/` 是报告缓存，`data/backups/` 是原文证据；启动扫描只在服务入口 `src/index.ts` 执行（测试/演示复用 `buildRuntime` 时不会碰真实仓库）。

### 3.10 2026-10-20：宿主复验的能力探测（不再假定仓库有 `tests/*.test.ts`）

**问题**：`hostVerify` 早期固定执行 `node --import tsx --test tests/*.test.ts`。对一个没有 `tests/` 的仓库，这条命令必然失败 → 每次落盘都被自动回滚，用户看到的是「改完又没了」，而不是「这个仓库没有可自动运行的验证」。

**改动**：新增 `src/sandbox/verificationPlan.ts`，落盘后按仓库实际能力选择：

| 模式 | 触发条件 | 行为 |
|---|---|---|
| `full_suite` | 发现 Node 原生测试（`node:test`，或 `package.json` 的 test 脚本明确含 `node --test`） | 跑测试文件；TS 测试需要本地 `tsx` |
| `typecheck` | 没有可跑的 Node 测试，但有 `tsconfig.json` + 本地 `typescript/bin/tsc` | `tsc --noEmit`，明确标注「只证明类型通过，不证明行为正确」 |
| `unavailable` | 两者都没有 | **不执行任何命令、不阻断落盘**，`hostVerify` 返回 `ran:false / blocking:false`，文案明确「未经任何行为验证，请人工验收」 |

**刻意不做**：不自动执行任意 `npm test`。如果 `package.json` 的 test 脚本是 jest/vitest/mocha 等第三方 runner，不猜测其入口与环境，降级类型检查或标 `unavailable`，避免执行仓库里的任意脚本。

**回归**：`tests/52`（6 例）覆盖全量 / 类型检查 / 类型检查失败 / 空仓库 unavailable / vitest 不自动执行 / 测试文件发现。`tests/50f` 的取消用例改用真实慢测试，避免「验证太快结束导致取消测不到」。
### 3.11 2026-10-20：编辑管线评测（7 个确定性场景）

**问题**：写能力的证据此前主要来自单次真实 run 和单测；缺少一条可重复执行的命令来回答「坏改动会不会被拦、审批拒绝是否真的不落盘、宿主复验失败会不会回滚、审批期间外部改动会不会被覆盖」。

**做法**：`npm run eval:edit`（`scripts/edit-eval.ts`）使用独立 fixture（`eval/edit-fixture/base`），每个场景复制临时仓库，走真实 `create_file/edit_file → 沙箱阶梯 → 审批回调 → submit_changes → 宿主复验/回滚`。临时仓库用 junction 指向本项目 `node_modules`，宿主复验才能解析 `tsx`；评测结束删除 junction，证据保留在 `data/edit-eval/<stamp>/`。

| 场景 | 验证点 | 当前结果 |
|---|---|---|
| E1 单文件正确修复 | 审批 1 次 → 落盘 → 宿主全量通过 | ✅ |
| E2 新增模块 + 测试 | 两文件合并 1 次审批 → 落盘 | ✅ |
| E3 语法错误 | L0 拦截，审批 0 次，真实仓库不变 | ✅ |
| E4 测试失败 | L1 拦截，审批 0 次，真实仓库不变 | ✅ |
| E5 用户拒绝 | `APPROVAL_DENIED`，不落盘，不跑宿主复验 | ✅ |
| E6 沙箱绿、宿主红 | 宿主复验失败 → `change_rolled_back`，新增文件消失 | ✅ |
| E7 审批期间外部改动 | TOCTOU 哈希守卫 → `APPLY_FAILED`，外部改动不被覆盖 | ✅ |

**实测**（2026-10-20）：7/7 命中预期；5 次审批 / 4 文件落盘 / 1 回滚；沙箱 5/7 通过（E3/E4 故意失败）、宿主 2/3；平均 11.5s、P95 12.5s；tokens=0（确定性驱动，无模型调用）。报告：`reports/EDIT_EVAL.md`；汇总口径回归：`tests/55`（5 例）。

**边界**：这些场景由脚本扮演模型提出改动，证明的是**管线行为**，不是 LLM 改代码成功率；尚未覆盖 20~30 条真实模型任务、粘性放行、取消/超时、L1 失败后的重生成成功率。另：本机 Node 24 的 `fs.cpSync` 会直接崩进程（最小用例可复现），评测改用仓库已有的 `copyRepoSnapshot`，这不是产品代码路径的改动。
