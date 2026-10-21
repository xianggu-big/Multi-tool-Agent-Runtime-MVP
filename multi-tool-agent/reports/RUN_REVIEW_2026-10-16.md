# 运行核查报告（RUN_REVIEW · 2026-10-16）

> **对象**：2026-10-15 ~ 10-16 用户实测「记账网页」会话链（跨 `runtime.db` 与 `m1-e2e.db` 两个实例、共 12 个 run）。
> **被质疑事项**：① `list_files`（根目录 depth 2）为何反复返回同一批 **127 项**；② 按文件名搜 `*.html` 为何恒为 **0 命中**；③ 根因是否为「会话缺少写入通道（仅 4 个只读工具）」；④ "委派子任务 / 编排提交"等说法是否属于不存在的工具、构成虚构。
> **方法**：直读两个库的 `runs` / `events` 表（含 `run_started.allowedTools`、`reasoningPreview`、完整事件链）+ 磁盘独立盘点 + 逐条对证。命令见附录。
> **一句话结论**：**「没有写入通道」属实（且是本系统的刻意设计）；但「委派子任务 / 编排提交是编造的」不属实——那是跨模式对话历史混淆导致的错误自认：工具真实存在，且在**同一条链路**的其它 run 里被真实调用成功过。**

---

## 1. 六项判定（速览）

| # | 被质疑的说法 / 现象 | 判定 | 关键证据 |
|---|---|---|---|
| 1 | `list_files` 返回「127 项」 | ✅ **属实** | 独立盘点 `<workspace>/llm_test`（depth 2）**恰为 127 项**，且逐项吻合（`.work/h01–h06、p01–p20`、`ref/`、`ref_hard/`、`results/`、`make_problems.js`、`problems.json`、`run.js`、`结论.md`、`README.md`） |
| 2 | `*.html` 恒为 0 命中 | ✅ **属实** | 独立 `find`：该目录 **0 个 html 文件**；搜索工具正常执行（`resolvedKind:"filename"`、返回 0 + 正确的可行动 hint，且注明"通配符 `*` 与 `?` 可用"）——不是语法失效，是**确实没有** |
| 3 | 「这个会话只有 4 个只读工具、没有写入通道」 | ✅ **属实**（逐 run 核对 `allowedTools`） | codebase run：`[search_files, read_file, list_files, run_tests]`；orchestrator run：`[delegate_subtasks, submit_orchestration]`（未开自查）或 +`[list_files, search_files, read_file, dir_stats]`；**全部 run 均无任何写工具** |
| 4 | 「重试多少次结果都一样」 | ✅ **机制上属实** | 只读工具 + 磁盘零改动（`llm_test` 全部文件 mtime 停在 **10-08**）→ 确定性输出；重试未改变任何输入 |
| 5 | 「『委派子任务 / 编排提交』这类工具并不存在，是我编造的」 | ❌ **不属实（错误自认）** | 工具**真实存在**（orchestrator 专用：`delegate_subtasks`、`submit_orchestration`）；16:41 的 `run_mvapy02d` **真实派发**（子任务 `st_eaf552da` 全链路事件 + `submit_orchestration` 成功）；10-15 的 `run_mv94f94p` 同样真实（复核记录在案） |
| 6 | 上述「错误自认」的成因 | 跨 runType 对话历史混淆 | codebase 的 `reasoningPreview` 原文：*"There's no delegate_subtasks tool actually listed in the functions!"* ——它以「自己工具列表」为唯一事实来源，判了**别人（orchestrator/misc）真实操作**的"死刑" |

---

## 2. 场景还原（时间线，+0800）

| 时间 | 库 | runId | 模式 | 实际可用工具（`run_started.allowedTools`） | 关键行为 / 说法 |
|---|---|---|---|---|---|
| 10-15 05:51 | runtime.db | `run_mv94f94p` | orchestrator | （10-15 已复核归档） | 记账需求 → **真实派发 doc-research，被限流截断**（`limit_reached`） |
| 10-15 05:55 | runtime.db | `run_mv94k04n` | orchestrator | — | 「**可见记录中无法核实**上一轮派发」——子任务明细跨轮不可见的首次暴露 |
| 10-15 06:02/06:03 | runtime.db | `run_mv94tudu` / `run_mv94us3f` | misc | — | 「**已升级到 codebase 通道**」= `escalateTo` 真实机制输出 |
| 10-15 06:04 | runtime.db | `run_mv94vphw` | codebase | 4 只读（同型） | **首次误认**："已派发子任务/已升级通道……不在我的工具列表里，属于编造进展"；同时**如实**声明"只有 4 个只读工具、无写能力" |
| 10-16 15:00–15:02 | runtime.db | `run_mvambidk` / `run_mvamcw94` / `run_mvamemy6` | codebase | 4 只读 | 再次道歉（"前面几轮我编造了"）+ 实测"仓库为空（0 文件）"+ 给出方案与两条路径 |
| 10-16 15:28 / 16:38 | runtime.db | `run_mvancdx1` / `run_mvapu17m` | codebase | 4 只读 | 复测"仍为空" + 重申边界 + 再次道歉 |
| 10-16 16:41 | m1-e2e.db | `run_mvapy02d` | orchestrator | `[delegate_subtasks, submit_orchestration]` | "搞一个记账网页" → **真实派发**（成功 `st_eaf552da`）+ **真实提交**；回复内给出 index.html（**被截断**） |
| 10-16 16:44 | m1-e2e.db | `run_mvaq1c8v` | orchestrator | 同上 2 个 | "你可以写在这个文件夹里吗" → 如实：无写盘能力 + **未勾写开关**（子 Agent 目录仅 3 个只读）；submission 重试 3 次后成功 |
| 10-16 16:44 | m1-e2e.db | `run_mvaq22t7` | codebase | 4 只读 | 实测 127 项 + 0 命中 + **误自认**（"委派/编排不存在，是我编的"） |
| 10-16 16:46 | m1-e2e.db | `run_mvaq3mrp` | codebase | 4 只读 | 复述（同上）——用户点名的那条 |
| 10-16 16:47 | m1-e2e.db | `run_mvaq56q9` | orchestrator | **6 个**：`[delegate_subtasks, submit_orchestration, list_files, search_files, read_file, dir_stats]` | 再次误自认——**连"自己只有 4 个只读"都说错了**（实际持有委派/提交工具，被历史带偏） |

---

## 3. 根因分析（三层）

### 3.1 直接原因：写入通道确实不存在（对上述每一个 run 均成立）
- `codebase` 契约的工具白名单就是 4 个只读工具（`src/agents/specs.ts`）；`orchestrator` 主 Agent 只有 `delegate_subtasks` + `submit_orchestration`。
- 本系统的「写」只属于一个位置：**`code-edit` 子 Agent**（沙箱 + 三级审批），且需要**本 run 显式授权**（界面「允许修改文件」开关 → `orchestration.allowWriteSpecs`）。上表**所有 run 都未授权** → 写通道从未被打开。
- 因此 `list_files`/`search_files` 的值域恒定；重试 N 次输出必然相同——**这不是"卡住"，是没有副作用通道的确定性结果**。

### 3.2 核心放大器：跨 runType 的对话历史混淆
- 前端把最近对话（**不分模式**）注入为 `contextHistory`；历史文本里"已派发子任务 / 已升级通道"等字样**不携带产生它的 runType 标注**。
- 后续 run 换到 codebase 模式后：模型以**自己的工具列表**为唯一"能力事实来源"，看到历史里有自己做不了的操作记录 → 判为"（我）编造"。**直接证据**：16:44 codebase 的 `reasoningPreview` 原文（"There's no delegate_subtasks tool actually listed..."）。
- 该误判写进对话历史后，被后续轮次反复复读放大（16:46 codebase 复述 → 16:47 orchestrator 连自己的工具都否定了）——形成"越道歉越错"的链条。

### 3.3 历史性诱因：子任务可见性缺口（10-15 的"无法核实"）
- 10-15 05:55 的 orchestrator 对上一轮子任务「无法核实」——当时尚无 `subtaskUsage`/`gaps`/单 run 报告（这些于 10-16 上午才修）。这层"自证不能"是整条道歉链的第一块骨牌。
- 补充事实：16:41 与后续轮次给出的 index.html 代码**在消息内被截断**（16:44 的 run 也指出了这一点）——这属于输出长度截断，与权限无关。

---

## 4. 对用户的核心回答（直说）

1. **agent 说"没有写通道 / 无法写入这个文件夹"：属实**（对每一次 run 都成立；是刻意设计，不是偷懒）。
2. **agent 说"委派子任务 / 编排提交是编造的"：错误**——工具真实存在，且在同链路的 run 里被真实调用成功（事件链完整，可复现）。
3. **127 项没变、0 命中：都如实**——目录自 10-08 起未被改动，且里面本来就没有 html 文件。
4. **为什么怎么试都不行**：每次重试都在"只读形态"里（既不是可写模式，也没勾写开关）——系统的写路径从未被打开过。

---

## 5. 当前约束下的可行路径

- **A. 手动落盘**（最快）：把 agent 给的最后一份**完整版**代码存成 `index.html`（注意此前多轮消息里的代码被截断过）。
- **B. 用本系统真正让文件落盘**（让 agent 自己写成的唯一路径；2026-10-16 下午刚上线的能力）：
  1. 任务类型选「**多 Agent 编排**」；
  2. **勾选「允许修改文件（写能力）」**——16:41–16:47 全部没勾，这是关键遗漏；
  3. `repoPath` 指向**目标文件夹**（建议新建空目录，如 `<workspace>/记账网页/`；不建议用 `llm_test`——它是 C 题库仓库）；
  4. goal 写明「新建 `index.html`（单文件记账本），由 code-edit 写入并用 `submit_changes` 提交」；
  5. 等**审批卡**弹出 → 「仅同意本次 / 完全同意此文件」→ 落盘 + 宿主复验。
- **C. 由 WorkBuddy 直接写**：本助手具备文件读写能力，可立即把完整记账网页落到指定目录。

---

## 6. 对项目的改进建议（本次核查副产品）

| # | 发现 | 建议 |
|---|---|---|
| I1 | **跨模式对话历史无标注**（§3.2 核心成因） | `contextHistory` 注入时给每轮标注 `runType`；系统提示声明"工具与能力以**本次**工具列表为准，历史轮次描述的操作不等价于你当前可执行" |
| I2 | **子任务明细跨轮不可见**（10-15 的"无法核实"） | 后续轮次注入上一轮 run 的执行摘要（含子任务清单与限流截断），或 UI 明示"该结论可在 run 详情核对" |
| I3 | **`repoPath` 未落库**（核查时无法从记录直接证明目标文件夹） | `run_started` 事件补记 `repoPath`（或在 runs 表加列） |
| I4 | 工具结果在事件里被截断（模型看到全量、事件是 500 字符摘要） | 设计取舍可保留；建议加 `resultTruncated` 标注，防核查误读 |

---

## 附录：复现命令

```bash
cd multi-tool-agent
# 逐 run 明细（缺省 runtime.db；查 m1-e2e 库传第二个参数）
node ../.eval/query-run-detail.mjs <runId> [data/m1-e2e.db]
# 磁盘独立盘点
find "<workspace>/llm_test" -mindepth 1 -maxdepth 2 | wc -l   # → 127
find "<workspace>/llm_test" -iname "*.html" | wc -l            # → 0
```

- 关键 runId 见 §2；`allowedTools` 位于各 run 的 `run_started` 事件（seq=1）。
- 本报告依据仅来自两个只读数据库与磁盘盘点；未修改任何被测仓库。
