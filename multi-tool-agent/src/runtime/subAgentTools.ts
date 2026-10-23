// src/runtime/subAgentTools.ts — 子 Agent 实际可见的工具名（唯一真值）
//
// 为什么不直接 `spec.tools.filter(registry.has)`：
//   2026-10-23 真实写能力 E2E 里，code-edit 子 Agent 看到 run_tests 并调用，
//   结果拿到 `DISABLED`（部署默认 CODEBASE_RUN_TESTS_ENABLED=false）——白烧一轮调用。
//   工具不可用时就不该出现在模型的工具列表里（与主路径 toolPoolFor 的口径一致）。

export function subAgentToolNames(
  specTools: readonly string[],
  opts: { registryHas: (name: string) => boolean; runTestsEnabled: boolean },
): string[] {
  return specTools.filter((name) => {
    if (!opts.registryHas(name)) return false;
    if (name === 'run_tests' && !opts.runTestsEnabled) return false;
    return true;
  });
}
