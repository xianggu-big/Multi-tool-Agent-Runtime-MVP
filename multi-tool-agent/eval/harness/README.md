# Harness 评测任务与记分卡（v1.0）

> 状态：目录与 schema 已就位，尚未执行任何评测。本轮只交付“怎么测”的机器可读契约与模板；等用户确认项目算完善后，再按 docs/HARNESS_EVALUATION_STANDARD.md 的 Runbook 跑。

本目录只回答一个问题：同一模型、同一批任务、同一预算下，这个 harness 是否把模型能力更稳定地变成了任务成功？

## 文件

| 文件 | 作用 | 是否可手改 |
|---|---|---|
| task.schema.json | 单个任务的契约：fixture、预算、工具边界、成功检查、安全期望、故障注入 | 可以，但改字段要升标准版本 |
| result.schema.json | 单次 attempt 的结果：runId、成功判定、检查项、token/费用/耗时、失败分类、artifact | 可以，改字段要同步执行器 |
| scorecard.schema.json | 聚合记分卡：语料哈希、模型、harness、指标、P0/P1/P2 gates、就绪等级、限制 | 可以，改字段要同步模板 |
| tasks.example.jsonl | 10 条示例任务，覆盖 codebase/edit/research/misc/orchestration/rag/mcp/safety/long_context/recovery | 可以抄格式；不是正式评测集 |
| reports/HARNESS_SCORECARD_TEMPLATE.md | 人读空白记分卡 | 可以复制后填写 |

## 三条硬规则

1. 任务集是冻结数据：正式评测一旦开始，任务文件不改；改题必须新建 id/version，重新计算 SHA-256，并说明旧分数不可直接比较。
2. 结果由执行器生成：result 与 scorecard 不能手填数字；手填的记分卡只能算草稿，不能对外引用。
3. Mock 与真实模型分开：track=deterministic 只能证明机制正确；track=real 才能谈任务成功率。n=1 只能叫证据，不能叫成功率。

## 怎么新增一个任务

1. 从 tasks.example.jsonl 复制一行，换成新的 id（小写字母/数字/点/下划线/短横线，3~80 字符）和 version（语义化版本）。
2. 写清楚 track、category、difficulty、goal、runType。任务目标要能被另一个工程师复现，不能只写“优化一下”。
3. 指定 fixture：优先使用仓库内独立 fixture；reset 至少为 per-run。禁止把真实仓库或真实密钥作为 fixture。
4. 设定 limits：步数、模型调用、工具调用、token、费用、超时六项都要有。真实模型任务不要把费用上限留空。
5. 写 expected：
   - mustPass：文件存在/内容、命令退出码、JSON 路径、答案关键词、事件、状态等；
   - mustNot：越权写入、危险命令、敏感信息、禁止工具等；
   - requiredTools：只在确定性任务里要求；有歧义的任务用 rubric；
   - judge：deterministic 优先，主观任务才用 rubric/llm，并写清评分标准。
6. 写 safety：是否允许写、是否需要审批、网络范围、沙箱、是否允许 ask_user、是否含不可信内容。
7. 需要验证恢复能力时，再加 faultInjection；注入必须在隔离 fixture/容器内，不能碰真实仓库和真实密钥。
8. 在正式任务集 manifest 中更新任务数与 SHA-256；如果改了旧任务，升 version，不要覆盖历史。

## 冻结与归档

- 正式任务集建议放在独立目录（例如 eval/harness/corpora/corpus-id/version/），并生成 manifest：任务文件列表、每个文件 SHA-256、总任务数、类别分布、冻结时间。
- 任务集哈希写入 scorecard.corpus.sha256；单次结果写入 result.artifacts[].sha256。
- 结果目录建议按 reports/harness-runs/campaign-id/ 归档，至少保留：原始 result JSONL、失败清单、scorecard JSON、scorecard Markdown、环境信息、命令。
- 不把 API Key、Cookie、MCP token、真实用户数据写进任务、结果、日志或 artifact。需要凭据时只能走环境变量，并在结果中写“已使用，未记录值”。

## 与现有评测的关系

| 现有证据 | 放到本标准里怎么看 |
|---|---|
| npm test | deterministic mechanics 的实现正确性，不是 harness 效果 |
| npm run eval:edit | 编辑管线的确定性机制证据（审批/落盘/回滚/TOCTOU） |
| npm run eval:edit:real | 固定模型在编辑管线里的能力证据，但不等于完整 harness uplift |
| npm run rag:bench | RAG 子系统的检索质量，不是端到端 harness 分数 |
| npm run security:redteam | 注入检测的检出/误报，不等于彻底防御 |
| npm run mcp:e2e / npm run e2e:write | 单次真实链路证据；n=1 不能当成功率 |

## 以后执行时的最小流程

1. 固定模型、参数、预算、harness commit。
2. 冻结任务集并计算哈希。
3. 先跑 deterministic mechanics，拿到 H1 机制证据。
4. 再跑 B1 裸循环 vs H 完整 harness，每个任务重复 k≥3。
5. 生成 result JSONL，再聚合 scorecard；先看 P0 gates，再看分维度指标。
6. 把失败任务、超时、取消、重试全部列出；不允许只报成功案例。

> 本轮没有执行第 1~6 步。所有“当前项目是否算好 harness”的结论都留空，直到真实评测完成并写入记分卡。
