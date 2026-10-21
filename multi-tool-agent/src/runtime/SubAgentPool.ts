// src/runtime/SubAgentPool.ts — 有界并发池（子 Agent 并行执行）
// 三条设计约定：
//   ① **有界**：并发数封顶（默认 4），绝不无界扇出；
//   ② **级联取消**：父任务 AbortSignal 触发时，未启动的子任务直接产出 cancelled 结果（不抛异常）；
//   ③ **部分失败显式化**：单个子任务抛错不会打断其他子任务，而是转成失败结果返回——
//      合并策略由调用方（主 Agent 的汇总）决定，池子只负责"不隐瞒"。

export interface PoolOptions<R> {
  concurrency: number;
  signal?: AbortSignal;
  /** 取消时为尚未启动的任务生成结果 */
  abortedResult: (item: unknown, index: number) => R;
  /** 单个任务抛错时生成结果（默认由调用方提供，保证不丢任务） */
  errorResult?: (item: unknown, index: number, error: Error) => R;
}

export class SubAgentPool {
  constructor(private readonly defaultConcurrency = 4) {}

  /**
   * 并发执行 items，保持返回顺序与入参一致（结果顺序稳定，便于主 Agent 对齐）。
   */
  async map<T, R>(
    items: T[],
    worker: (item: T, index: number) => Promise<R>,
    opts: PoolOptions<R>,
  ): Promise<R[]> {
    const out = new Array<R>(items.length);
    const concurrency = Math.max(1, Math.min(opts.concurrency || this.defaultConcurrency, items.length || 1));
    let next = 0;

    const runOne = async (index: number): Promise<void> => {
      const item = items[index];
      if (opts.signal?.aborted) {
        out[index] = opts.abortedResult(item, index);
        return;
      }
      try {
        out[index] = await worker(item, index);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        if (opts.signal?.aborted) {
          out[index] = opts.abortedResult(item, index);
        } else if (opts.errorResult) {
          out[index] = opts.errorResult(item, index, err);
        } else {
          throw err;
        }
      }
    };

    const workers: Promise<void>[] = [];
    for (let w = 0; w < concurrency; w++) {
      workers.push(
        (async () => {
          while (true) {
            const index = next++;
            if (index >= items.length) break;
            await runOne(index);
          }
        })(),
      );
    }
    await Promise.all(workers);
    return out;
  }
}

/**
 * 计算实际并行度：受「任务数 / 配置上限 / 剩余预算」共同约束。
 * 单独抽出来便于单测与日志（"这次为什么只并行了 2 个"）。
 */
export function effectiveConcurrency(opts: {
  taskCount: number;
  maxConcurrency: number;
  remainingTokenBudget?: number;
  perTaskTokenBudget: number;
}): { concurrency: number; reason: string } {
  const byTasks = Math.max(1, opts.taskCount);
  const byConfig = Math.max(1, opts.maxConcurrency);
  let concurrency = Math.min(byTasks, byConfig);
  let reason = `任务数 ${byTasks} / 上限 ${byConfig}`;

  if (opts.remainingTokenBudget !== undefined && opts.perTaskTokenBudget > 0) {
    const byBudget = Math.max(1, Math.floor(opts.remainingTokenBudget / opts.perTaskTokenBudget));
    if (byBudget < concurrency) {
      reason += ` / 剩余预算只够并行 ${byBudget}`;
      concurrency = byBudget;
    }
  }
  return { concurrency, reason };
}
