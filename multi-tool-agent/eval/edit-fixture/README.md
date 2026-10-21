# 编辑管线评测夹具

`base/` 是一个最小 Node + TypeScript 仓库，供 `npm run eval:edit`（`scripts/edit-eval.ts`）复制临时副本使用。

- `src/calc.ts` 故意把 `add` 写成 `a - b`，E1 用来验证“正确修复后落盘”。
- 其余场景在开始前会写入绿色基线（`GREEN_CALC`），避免基线本身的失败污染结论。
- 不要把这个目录当作 `demo/codebase-sample` 使用；评测不污染演示仓库。
- 夹具测试只依赖 Node 内置 `node:test` + `tsx`；沙箱镜像 `mta-sandbox:node24` 内已装依赖。