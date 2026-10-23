// scripts/subtask-stats.ts — 打印按 spec 聚合的子任务历史（默认排除 Mock）
//
// 用法：npm run stats:subtasks [-- --limit=2000 --include-mock]
import { loadConfig } from '../src/config.js';
import { SqliteStore } from '../src/store/SqliteStore.js';
import { aggregateSubtaskStats } from '../src/runtime/subtaskStats.js';

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf('=');
  return eq >= 0 ? hit.slice(eq + 1) : 'true';
}

const config = loadConfig();
const store = new SqliteStore(config.sqlitePath);
try {
  const limit = Math.max(1, Math.min(5000, Number(arg('limit', '500')) || 500));
  const stats = aggregateSubtaskStats(store.listRuns(limit), {
    includeMock: ['1', 'true'].includes(arg('include-mock', 'false') ?? 'false'),
  });
  console.log(
    `扫描 ${stats.runsScanned} 个 run（有子任务 ${stats.runsWithSubtasks} 个，排除 Mock ${stats.mockExcluded} 个），共 ${stats.totalSubtasks} 个子任务\n`,
  );
  if (!stats.specs.length) {
    console.log('（没有可统计的子任务）');
  } else {
    const header = ['spec', 'total', 'ok', 'fail', 'cancel', 'limited', 'success', 'avgMs', 'avgTokens'];
    const rows = stats.specs.map((s) => [
      s.specId,
      String(s.total),
      String(s.ok),
      String(s.failed),
      String(s.cancelled),
      String(s.limited),
      `${(s.successRate * 100).toFixed(1)}%`,
      String(s.avgDurationMs),
      String(s.avgTokens),
    ]);
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
    console.log(line(header));
    console.log(widths.map((w) => '-'.repeat(w)).join('  '));
    for (const r of rows) console.log(line(r));
  }
} finally {
  store.close();
}
