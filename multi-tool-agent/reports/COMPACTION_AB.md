# 上下文压缩 A/B（真实模型）

> 生成时间：2026-10-21T06:04:38.266Z；命令：`npm run eval:compaction`；生成物请重跑命令，不要手改数字。

**判定：⚪ 未证明**

- 质量没有回退，但没有任何效率指标达到预设的 >=15% 改善门槛
- 质量门槛：完成率、目标全中率、关键词平均保持率均不得低于 legacy
- 未发现新增失败模式

## 1. 口径与边界

- 真实模型：`deepseek/deepseek-flash`；每个 run 使用独立临时仓库副本，只读任务。
- **窗口模拟**：运行时按 `4096` tokens 计算压缩水位；模型真实窗口为 `1048576`。本实验只验证“在同样的小窗口假设下，两种摘要策略谁更好”，不宣称 1M 窗口也会得到同样结果。
- 任务：5 个 × 2 策略 × 3 次 = 计划 30 run；实际 30 run。
- 通过标准：run 状态为 completed，且最终答案包含该任务预先声明的全部验收关键词。关键词命中不等于人工质量评估。
- 判定是预注册的：rolling 的完成率/目标全中率/关键词保持率不得低于 legacy，且至少一项效率指标改善 >=15%，且不得新增失败模式。
- 样本很小（每格 3 次），不声称统计显著性；结论只适用于本 fixture、本模型、本窗口假设。
- 模型真实窗口 1048576；4096 只是压缩决策的模拟窗口，不改变模型请求上限。
- 关键词全中是结构化验收，不衡量解释是否优雅、是否给出更好的架构建议。
- 本批计划 run 已全部尝试。
- 任务契约要求每个文件只读一次，因此“重复读取率”被固定为 0；该指标在本实验中不能区分两种策略。

## 2. 环境与预算

| 项 | 值 |
|---|---|
| Node | `v24.14.1` |
| 平台 | `win32 x64` |
| Provider / 模型 | `deepseek` / `deepseek-flash` |
| 模拟上下文窗口 | `4096` tokens |
| Fixture | `multi-tool-agent/eval/compaction-fixture/base` |
| Git | `a698c71`（工作区有未提交改动） |
| 预算 / 实际估算 | $1.0000 / $0.0253 |
| 证据目录 | `D:/c学习数据结构/Multi-tool Agent Runtime MVP/multi-tool-agent/data/compaction-ab/20261021-135918-973` |

## 3. 汇总

| 指标 | rolling（生产） | legacy（对照） |
|---|---:|---:|
| run 数 | 15 | 15 |
| 完成数 / 完成率 | 15 / 100.0% | 15 / 100.0% |
| 目标全中 / 全中率 | 15 / 100.0% | 15 / 100.0% |
| 关键词平均保持率 | 100.0% | 100.0% |
| 平均 steps / model calls / tool calls | 3.0 / 3.0 / 6.0 | 3.0 / 3.0 / 6.0 |
| tokens（总 / 平均） | 133435 / 8896 | 131030 / 8735 |
| 成本（总 / 平均） | $0.0127 / $0.0008 | $0.0125 / $0.0008 |
| 耗时（平均 / P95） | 10115ms / 17283ms | 10125ms / 14527ms |
| read calls / unique / repeated | 90 / 90 / 0 | 90 / 90 / 0 |
| 重复读取率 | 0.0% | 0.0% |
| 发生压缩的 run / 总压缩次数 | 15 / 24 | 15 / 24 |
| 平均压缩次数 / 最大深度 | 1.60 / 2 | 1.60 / 1 |
| Provider 错误 run / tool 错误 run / 孤儿风险 run | 0 / 0 / 0 | 0 / 0 / 0 |

## 4. 效率对比

> `改善` 已按指标方向归一化：正数代表 rolling 更好。只有达到 >=15% 才标记为 material。

| 指标 | legacy → rolling | 改善 | 达到 15% 门槛 |
|---|---:|---:|---|
| 完成率（越高越好） | 100.0% → 100.0% | 0.0% | 否 |
| 目标全中率（越高越好） | 100.0% → 100.0% | 0.0% | 否 |
| 目标关键词平均保持率（越高越好） | 100.0% → 100.0% | 0.0% | 否 |
| 平均 tokens/run（越低越好） | 8735 → 8896 | -1.8% | 否 |
| 平均成本/run（越低越好） | $0.0008 → $0.0008 | -1.4% | 否 |
| 平均耗时/run（越低越好） | 10125ms → 10115ms | 0.1% | 否 |
| 重复读取率（越低越好） | 0.0% → 0.0% | 0.0% | 否 |
| 平均重复读取次数/run（越低越好） | 0.00 → 0.00 | 0.0% | 否 |

## 5. 逐任务

| 任务 | 策略 | run | 全中 | 关键词保持率 | 平均 tokens | 平均成本 | 平均压缩次数 | 平均重复读取 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| audit-gap 500 为什么没有审计记录 | legacy（对照） | 3 | 3 | 100.0% | 8149 | $0.0007 | 1.00 | 0.00 |
| audit-gap 500 为什么没有审计记录 | rolling（生产） | 3 | 3 | 100.0% | 8193 | $0.0007 | 1.00 | 0.00 |
| constant-audit 认证相关常量核对 | legacy（对照） | 3 | 3 | 100.0% | 8062 | $0.0007 | 1.00 | 0.00 |
| constant-audit 认证相关常量核对 | rolling（生产） | 3 | 3 | 100.0% | 7877 | $0.0006 | 1.00 | 0.00 |
| incident-chain 登录 500 的完整根因链 | legacy（对照） | 3 | 3 | 100.0% | 9431 | $0.0009 | 2.00 | 0.00 |
| incident-chain 登录 500 的完整根因链 | rolling（生产） | 3 | 3 | 100.0% | 10066 | $0.0010 | 2.00 | 0.00 |
| legacy-diff legacy 与主登录路径的输入差异 | legacy（对照） | 3 | 3 | 100.0% | 9323 | $0.0010 | 2.00 | 0.00 |
| legacy-diff legacy 与主登录路径的输入差异 | rolling（生产） | 3 | 3 | 100.0% | 9217 | $0.0009 | 2.00 | 0.00 |
| minimal-fix 最小修复方案 | legacy（对照） | 3 | 3 | 100.0% | 8712 | $0.0009 | 2.00 | 0.00 |
| minimal-fix 最小修复方案 | rolling（生产） | 3 | 3 | 100.0% | 9126 | $0.0009 | 2.00 | 0.00 |

## 6. 逐 run 证据

| 任务 | 策略 | # | runId | 状态 | 全中 | 关键词 | tokens | 成本 | 耗时 | 压缩 | 重复读取 | 错误 |
|---|---|---:|---|---|---|---:|---:|---:|---:|---:|---:|---|
| audit-gap | legacy（对照） | 1 | `run_mvhpexqc_b594438f` | completed | 是 | 5/5 | 8083 | $0.0007 | 9862ms | 1次/深度1/1230字 | 0/6 | 无 |
| audit-gap | legacy（对照） | 2 | `run_mvhpf5qu_a46c702f` | completed | 是 | 5/5 | 8061 | $0.0006 | 8255ms | 1次/深度1/1230字 | 0/6 | 无 |
| audit-gap | legacy（对照） | 3 | `run_mvhpfcih_73b52a5e` | completed | 是 | 5/5 | 8304 | $0.0008 | 9581ms | 1次/深度1/1230字 | 0/6 | 无 |
| audit-gap | rolling（生产） | 1 | `run_mvhpe98f_355e10f6` | completed | 是 | 5/5 | 8189 | $0.0007 | 9725ms | 1次/深度1/1753字 | 0/6 | 无 |
| audit-gap | rolling（生产） | 2 | `run_mvhpeh4y_755bfa87` | completed | 是 | 5/5 | 8115 | $0.0007 | 9560ms | 1次/深度1/1753字 | 0/6 | 无 |
| audit-gap | rolling（生产） | 3 | `run_mvhpeox1_92028665` | completed | 是 | 5/5 | 8275 | $0.0008 | 10907ms | 1次/深度1/1753字 | 0/6 | 无 |
| constant-audit | legacy（对照） | 1 | `run_mvhphiui_120fa1df` | completed | 是 | 5/5 | 8284 | $0.0008 | 10015ms | 1次/深度1/1235字 | 0/6 | 无 |
| constant-audit | legacy（对照） | 2 | `run_mvhphqza_a2d5f210` | completed | 是 | 5/5 | 7744 | $0.0006 | 6699ms | 1次/深度1/1235字 | 0/6 | 无 |
| constant-audit | legacy（对照） | 3 | `run_mvhphwjq_3260091c` | completed | 是 | 5/5 | 8157 | $0.0007 | 8605ms | 1次/深度1/1235字 | 0/6 | 无 |
| constant-audit | rolling（生产） | 1 | `run_mvhpgzn5_fcbdcc38` | completed | 是 | 5/5 | 8132 | $0.0008 | 8533ms | 1次/深度1/1755字 | 0/6 | 无 |
| constant-audit | rolling（生产） | 2 | `run_mvhph6mo_2fa54854` | completed | 是 | 5/5 | 7803 | $0.0005 | 7795ms | 1次/深度1/1755字 | 0/6 | 无 |
| constant-audit | rolling（生产） | 3 | `run_mvhphd1r_737eb3a9` | completed | 是 | 5/5 | 7695 | $0.0006 | 6991ms | 1次/深度1/1755字 | 0/6 | 无 |
| incident-chain | legacy（对照） | 1 | `run_mvhpdens_027baf76` | completed | 是 | 5/5 | 9513 | $0.0009 | 12337ms | 2次/深度1/1075字 | 0/6 | 无 |
| incident-chain | legacy（对照） | 2 | `run_mvhpdokv_24f9fd25` | completed | 是 | 5/5 | 9676 | $0.0010 | 14527ms | 2次/深度1/1075字 | 0/6 | 无 |
| incident-chain | legacy（对照） | 3 | `run_mvhpe06z_46e3ab81` | completed | 是 | 5/5 | 9103 | $0.0007 | 11201ms | 2次/深度1/1075字 | 0/6 | 无 |
| incident-chain | rolling（生产） | 1 | `run_mvhpcgdi_79e6c6a1` | completed | 是 | 5/5 | 9788 | $0.0008 | 11950ms | 2次/深度2/1814字 | 0/6 | 无 |
| incident-chain | rolling（生产） | 2 | `run_mvhpcpzy_d7ea9f6c` | completed | 是 | 5/5 | 10143 | $0.0010 | 13638ms | 2次/深度2/1814字 | 0/6 | 无 |
| incident-chain | rolling（生产） | 3 | `run_mvhpd0x4_1c49e75c` | completed | 是 | 5/5 | 10266 | $0.0012 | 17283ms | 2次/深度2/1814字 | 0/6 | 无 |
| legacy-diff | legacy（对照） | 1 | `run_mvhpg7sn_9ee9954e` | completed | 是 | 5/5 | 9644 | $0.0013 | 12961ms | 2次/深度1/1075字 | 0/6 | 无 |
| legacy-diff | legacy（对照） | 2 | `run_mvhpgi79_801a130d` | completed | 是 | 5/5 | 9091 | $0.0010 | 10655ms | 2次/深度1/1075字 | 0/6 | 无 |
| legacy-diff | legacy（对照） | 3 | `run_mvhpgqtk_523d8c75` | completed | 是 | 5/5 | 9234 | $0.0009 | 10914ms | 2次/深度1/1075字 | 0/6 | 无 |
| legacy-diff | rolling（生产） | 1 | `run_mvhpfkb6_1a255059` | completed | 是 | 5/5 | 9229 | $0.0011 | 10010ms | 2次/深度2/1792字 | 0/6 | 无 |
| legacy-diff | rolling（生产） | 2 | `run_mvhpfsfs_eb88f7ad` | completed | 是 | 5/5 | 9052 | $0.0009 | 8460ms | 2次/深度2/1792字 | 0/6 | 无 |
| legacy-diff | rolling（生产） | 3 | `run_mvhpfzdc_d9210ed2` | completed | 是 | 5/5 | 9371 | $0.0008 | 10393ms | 2次/深度2/1792字 | 0/6 | 无 |
| minimal-fix | legacy（对照） | 1 | `run_mvhpip8p_7ac5ac1e` | completed | 是 | 5/5 | 8846 | $0.0010 | 9474ms | 2次/深度1/1072字 | 0/6 | 无 |
| minimal-fix | legacy（对照） | 2 | `run_mvhpiwyd_94982ded` | completed | 是 | 5/5 | 8683 | $0.0008 | 9285ms | 2次/深度1/1072字 | 0/6 | 无 |
| minimal-fix | legacy（对照） | 3 | `run_mvhpj4iw_0d9ed2aa` | completed | 是 | 5/5 | 8607 | $0.0008 | 7510ms | 2次/深度1/1072字 | 0/6 | 无 |
| minimal-fix | rolling（生产） | 1 | `run_mvhpi3ln_55c6b9f4` | completed | 是 | 5/5 | 9339 | $0.0012 | 9713ms | 2次/深度2/1792字 | 0/6 | 无 |
| minimal-fix | rolling（生产） | 2 | `run_mvhpibhy_7977f2c9` | completed | 是 | 5/5 | 9031 | $0.0010 | 8397ms | 2次/深度2/1792字 | 0/6 | 无 |
| minimal-fix | rolling（生产） | 3 | `run_mvhpiidr_a7e00d86` | completed | 是 | 5/5 | 9007 | $0.0006 | 8374ms | 2次/深度2/1796字 | 0/6 | 无 |

## 7. 失败模式

- 无（本实验里所有 run 均完成且命中全部验收关键词，且未记录 Provider/孤儿 tool 错误）

## 8. 判定规则（预注册）

1. rolling 的完成率、目标全中率、关键词平均保持率不得低于 legacy。
2. 至少一项效率指标（平均 tokens、平均成本、平均耗时、重复读取率、平均重复读取次数）改善 >=15%。
3. rolling 不得新增孤儿 tool / tool_calls 协议错误、Provider 错误或更多失败 run。
4. 计划 run 未跑完 → 只能判为“实验不完整”。
5. 不满足以上条件 → 只能写“未证明”，不能把单测通过或个别 run 的优势外推成普适结论。
