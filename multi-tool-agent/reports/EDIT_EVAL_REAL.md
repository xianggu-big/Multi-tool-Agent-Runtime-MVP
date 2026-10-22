# 真实模型编辑评测（EDIT_EVAL_REAL）

> 生成时间：2026-10-22T05:23:11.935Z ｜ 模型：`deepseek-flash` ｜ fixture：`eval/edit-fixture/real/`（4 源文件 + 4 测试文件，基线 15/15）
> 衡量的是**真实模型在编辑管线里的完成能力**，与 `EDIT_EVAL.md`（确定性管线，tokens=0）分开汇报。
> 复现：`cd multi-tool-agent && npm.cmd run eval:edit:real -- --tasks=20 --budget-usd=1 --timeout-ms=240000` ｜ 证据：`data/edit-eval-real/20261022-131513-248`

## 汇总

| 指标 | 值 |
|---|---|
| 任务数 | 20（有效 20 / 无效 0） |
| 通过（宿主全绿 + 断言全中） | **20/20（100.0%）** |
| 宿主测试通过率（L2） | **20/20（100.0%）** |
| 审批次数 | 20 |
| tokens | 611890 |
| 成本 | $0.0172 |
| 平均耗时 | 23.9s |

## 逐条结果

| ID | 任务 | 结果 | 落盘 | 审批 | L2 | 断言 | tokens | 失败原因 |
|---|---|---|---|---|---|---|---|---|
| R01 | 修复 add 的减法错误 | 通过 | src/calc.ts | 1 | ✅ | ✅ | 57618 | — |
| R02 | 修复 sub 的加法错误 | 通过 | src/calc.ts | 1 | ✅ | ✅ | 11924 | — |
| R03 | 修复 mul 的实现 | 通过 | src/calc.ts | 1 | ✅ | ✅ | 17795 | — |
| R04 | 补回除零检查 | 通过 | src/calc.ts | 1 | ✅ | ✅ | 81242 | — |
| R05 | 修复 clamp 忽略上限 | 通过 | src/calc.ts | 1 | ✅ | ✅ | 24531 | — |
| R06 | 修复 capitalize 未大写 | 通过 | src/strings.ts | 1 | ✅ | ✅ | 12823 | — |
| R07 | 修复 truncate 短串被截断 | 通过 | src/strings.ts | 1 | ✅ | ✅ | 17446 | — |
| R08 | 修复 slugify 未替换空格 | 通过 | src/strings.ts | 1 | ✅ | ✅ | 17207 | — |
| R09 | 修复 sum 空数组崩溃 | 通过 | src/arrays.ts | 1 | ✅ | ✅ | 27938 | — |
| R10 | 修复 unique 未去重 | 通过 | src/arrays.ts | 1 | ✅ | ✅ | 28544 | — |
| R11 | 补回 chunk 的 size 校验 | 通过 | src/arrays.ts | 1 | ✅ | ✅ | 43468 | — |
| R12 | 修复 name 校验条件反向 | 通过 | src/validate.ts | 1 | ✅ | ✅ | 16961 | — |
| R13 | 修复 age 上限 | 通过 | src/validate.ts | 1 | ✅ | ✅ | 13513 | — |
| R14 | 恢复 email 校验 | 通过 | src/validate.ts | 1 | ✅ | ✅ | 32133 | — |
| R15 | 新增 average 函数 | 通过 | src/calc.ts | 1 | ✅ | ✅ | 26362 | — |
| R16 | 新增 has 函数 | 通过 | src/arrays.ts | 1 | ✅ | ✅ | 23156 | — |
| R17 | 新增 reverse 函数 | 通过 | src/strings.ts | 1 | ✅ | ✅ | 34902 | — |
| R18 | 新增并导出 isEmail | 通过 | src/validate.ts | 1 | ✅ | ✅ | 58962 | — |
| R19 | 提取邮箱正则常量 | 通过 | src/validate.ts | 1 | ✅ | ✅ | 36107 | — |
| R20 | 收紧 sum 参数类型 | 通过 | src/arrays.ts | 1 | ✅ | ✅ | 29258 | — |

## 口径与边界

- 每条任务复制独立 fixture；`setup` 注入的缺陷会让基线测试先失败（R15~R20 是新增/重构任务，不注入缺陷）。
- 审批是**自动 allow_once**：评测的是模型能否改对，不是人工审批体验；审批次数仍记录。
- 判定要求同时满足：宿主 4 个测试文件全绿 + `expect` 断言命中。只看「模型说改好了」不算通过。
- `setup` 未命中的任务标记为 `invalid` 并从分母排除；R11 接受 `size <= 0` 或等价的 `!(size > 0)`，同时要求错误文案含 `size must be > 0`。
- 成本按 Provider 返回值累计；预算用尽后剩余任务记失败并标原因，不重试。
- 样本量 20 条，只覆盖小函数级修改；不代表大型重构或多文件架构调整能力。
