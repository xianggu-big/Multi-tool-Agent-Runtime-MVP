# 编辑管线评测（真 Docker / 真审批 / 真复验）

> 生成时间：2026-10-21T04:27:00.721Z；命令：`npm run eval:edit`；生成物请重跑命令，不要手改数字。

## 1. 口径与边界

- 衡量对象：`create_file / edit_file → 沙箱检查阶梯 → 人工审批 → 落盘 → 宿主复验 → 失败回滚` 这条**管线**。
- **不是模型能力评测**：场景由脚本确定性驱动（脚本扮演模型提出改动），所以 tokens = 0、cost = $0；不要把它解读成“模型改代码成功率”。
- 每个场景使用独立临时仓库副本；不污染 `demo/codebase-sample`，也不写入用户真实仓库。
- 沙箱内是 Linux、宿主是当前平台；E6 专门验证“沙箱绿、宿主红”时是否自动回滚。
- 场景 E6 只在宿主非 Linux 时运行；其余场景跨平台。

## 2. 环境

| 项 | 值 |
|---|---|
| Node | `v24.14.1` |
| 平台 | `win32 x64` |
| 宿主复验 Node | `D:/Program Files/nodejs/node.exe` |
| 沙箱镜像 | `mta-sandbox:node24` |
| Git | `24b49d0`（工作区有未提交改动） |
| 证据目录 | `multi-tool-agent/data/edit-eval/20261021-122532-989` |

## 3. 汇总

| 指标 | 值 |
|---|---:|
| 场景（运行 / 跳过 / 总计） | 7 / 0 / 7 |
| 预期结果命中 | 7/7（100.0%） |
| 人工审批请求 | 5 次 |
| 成功落盘文件 | 4 个 |
| 失败回滚文件 | 1 个 |
| 沙箱检查通过 | 5/7（71.4%） |
| 宿主复验通过 | 2/3（66.7%） |
| 平均 / P95 墙钟 | 12511 ms / 13379 ms |
| Token / 成本 | 0 / $0.0000（确定性驱动，无模型调用） |

**读法**：`预期结果命中` 是“管线是否按设计行事”，不是“代码改得对不对”。沙箱通过率低不一定是坏事——E3/E4 就是故意提交坏改动，期望被拦下。

## 4. 场景结果

| 场景 | 期望 | 实际 | 结果 | 审批 | 落盘 | 回滚 | 宿主复验 | 墙钟 |
|---|---|---|---|---:|---|---:|---|---:|
| E1 单文件正确修复 | applied | applied | ✅ | 1 | 1 | 0 | 通过 | 12215 ms |
| E2 新增模块 + 测试（批量一次审批） | applied | applied | ✅ | 1 | 2 | 0 | 通过 | 13379 ms |
| E3 语法错误在沙箱被拦下 | sandbox_rejected | sandbox_rejected | ✅ | 0 | 0 | 0 | — | 11076 ms |
| E4 行为错误（测试失败）在沙箱被拦下 | sandbox_rejected | sandbox_rejected | ✅ | 0 | 0 | 0 | — | 12996 ms |
| E5 用户拒绝审批 | approval_denied | approval_denied | ✅ | 1 | 0 | 0 | — | 13272 ms |
| E6 沙箱绿、宿主红 → 自动回滚 | rolled_back | rolled_back | ✅ | 1 | 1 | 1 | 失败 | 12640 ms |
| E7 审批期间外部改动 → TOCTOU 拒绝落盘 | apply_refused | apply_refused | ✅ | 1 | 0 | 0 | — | 11998 ms |

## 5. 失败分类

无（所有运行场景均达到预期）。

## 6. 逐场景证据

### E1 单文件正确修复

- 期望：`applied`；结果：`passed`
- 审批 1 次；落盘 1 个；回滚 0 个；墙钟 12215 ms
- 沙箱检查：通过（l0-syntax:ok / l1-tsc:ok / l1-tests:ok）
- 宿主复验：通过（mode=full_suite, coverage=full）
- 断言：
  - ✅ 实际结果符合期望（applied）：实际 applied
  - ✅ 审批恰好 1 次：实际 1
  - ✅ 修复内容已落盘
  - ✅ 沙箱检查全部通过
  - ✅ 宿主复验通过：宿主全量测试通过

### E2 新增模块 + 测试（批量一次审批）

- 期望：`applied`；结果：`passed`
- 审批 1 次；落盘 2 个；回滚 0 个；墙钟 13379 ms
- 沙箱检查：通过（l0-syntax:ok / l0-syntax:ok / l1-tsc:ok / l1-tests:ok）
- 宿主复验：通过（mode=full_suite, coverage=full）
- 断言：
  - ✅ 实际结果符合期望（applied）：实际 applied
  - ✅ 两文件合并为 1 次审批：实际 1
  - ✅ 模块已落盘
  - ✅ 测试已落盘
  - ✅ 宿主复验通过：宿主全量测试通过

### E3 语法错误在沙箱被拦下

- 期望：`sandbox_rejected`；结果：`passed`
- 审批 0 次；落盘 0 个；回滚 0 个；墙钟 11076 ms
- 错误：`SANDBOX_CHECK_FAILED` — 沙箱校验未通过：l0-syntax 失败：SYNTAX（exit=1） 修复提示：语法错误：按报错行修正括号/引号/关键字，或整段重写该文件；不要留下半截代码。 证据（截断）： ✘ [ERROR] Unexpected ";"      src/calc.ts:2:13:       2 │   return a + ;         ╵              ^  （每文件剩余重生成轮次已扣减；修好后再次 submit_changes）
- 沙箱检查：失败（l0-syntax:fail）
- 断言：
  - ✅ 实际结果符合期望（sandbox_rejected）：实际 sandbox_rejected
  - ✅ 错误码为 SANDBOX_CHECK_FAILED：SANDBOX_CHECK_FAILED
  - ✅ 没有触发审批：实际 0
  - ✅ 沙箱检查失败
  - ✅ 真实仓库未被修改

### E4 行为错误（测试失败）在沙箱被拦下

- 期望：`sandbox_rejected`；结果：`passed`
- 审批 0 次；落盘 0 个；回滚 0 个；墙钟 12996 ms
- 错误：`SANDBOX_CHECK_FAILED` — 沙箱校验未通过：l1-tests 失败：TEST_FAIL（exit=1） 修复提示：测试失败：先读失败断言与期望值，判断是"实现改错了"还是"测试本身过时"；不要为了让测试变绿而删测试。 证据（截断）： ✖ add returns the arithmetic sum (3.579327ms) ℹ tests 1 ℹ suites 0 ℹ pass 0 ℹ fail 1 ℹ cancelled 0 ℹ skipped 0 ℹ todo 0 ℹ duration_ms 226.174887  ✖ failing tests:  test at tests/calc.test.ts:1:100 
- 沙箱检查：失败（l0-syntax:ok / l1-tsc:ok / l1-tests:fail）
- 断言：
  - ✅ 实际结果符合期望（sandbox_rejected）：实际 sandbox_rejected
  - ✅ 错误码为 SANDBOX_CHECK_FAILED：SANDBOX_CHECK_FAILED
  - ✅ 没有触发审批：实际 0
  - ✅ 沙箱测试失败
  - ✅ 真实仓库未被修改

### E5 用户拒绝审批

- 期望：`approval_denied`；结果：`passed`
- 审批 1 次；落盘 0 个；回滚 0 个；墙钟 13272 ms
- 错误：`APPROVAL_DENIED` — 审批被拒绝：评测：模拟用户拒绝 可按拒绝理由修正后重新 submit_changes。
- 沙箱检查：通过（l0-syntax:ok / l1-tsc:ok / l1-tests:ok）
- 断言：
  - ✅ 实际结果符合期望（approval_denied）：实际 approval_denied
  - ✅ 错误码为 APPROVAL_DENIED：APPROVAL_DENIED
  - ✅ 审批恰好 1 次：实际 1
  - ✅ 拒绝后未落盘
  - ✅ 未运行宿主复验

### E6 沙箱绿、宿主红 → 自动回滚

- 期望：`rolled_back`；结果：`passed`
- 审批 1 次；落盘 1 个；回滚 1 个；墙钟 12640 ms
- 沙箱检查：通过（l0-syntax:ok / l1-tsc:ok / l1-tests:ok）
- 宿主复验：失败（mode=full_suite, coverage=full）
- 断言：
  - ✅ 实际结果符合期望（rolled_back）：实际 rolled_back
  - ✅ 宿主复验运行且失败：宿主全量测试失败（exit=1）： ✔ add returns the arithmetic sum (1.1359ms) ✖ linux-only assumption (3.0377ms) ℹ tests 2 ℹ suites 0 ℹ pass 1 ℹ fail 1 ℹ cancelled 0 ℹ skipped 0 ℹ todo 0 ℹ duration_ms 318.1088  ✖ failing tests:  test at tests\platform.test.ts:1:68 ✖ linux-only assumption (3.0377ms)   AssertionError
  - ✅ 失败文件被自动回滚：tests/platform.test.ts
  - ✅ 回滚后新增文件不存在
  - ✅ 没有把失败当成成功

### E7 审批期间外部改动 → TOCTOU 拒绝落盘

- 期望：`apply_refused`；结果：`passed`
- 审批 1 次；落盘 0 个；回滚 0 个；墙钟 11998 ms
- 错误：`APPLY_FAILED` — 本批 1 个文件全部未落盘（仓库未被本次提交修改）： src/calc.ts：TOCTOU 守卫拒绝：src/calc.ts 在审批期间被外部改动（审批版本与当前不一致）。请重新读取并重新走审批。
- 沙箱检查：通过（l0-syntax:ok / l1-tsc:ok / l1-tests:ok）
- 断言：
  - ✅ 实际结果符合期望（apply_refused）：实际 apply_refused
  - ✅ 错误码为 APPLY_FAILED：APPLY_FAILED
  - ✅ 错误信息包含 TOCTOU：本批 1 个文件全部未落盘（仓库未被本次提交修改）： src/calc.ts：TOCTOU 守卫拒绝：src/calc.ts 在审批期间被外部改动（审批版本与当前不一致）。请重新读取并重新走审批。
  - ✅ 外部改动未被覆盖
  - ✅ 审批仍恰好 1 次：实际 1

## 7. 复现

```powershell
cd multi-tool-agent
npm run eval:edit
```

前置条件：Docker 可用 + `mta-sandbox:node24` 已构建。缺少任一项时脚本会明确标记 skipped，而不是伪造通过。
