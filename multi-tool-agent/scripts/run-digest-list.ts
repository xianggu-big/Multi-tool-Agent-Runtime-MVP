// scripts/run-digest-list.ts — 看「每次任务结束」的复盘摘要
//
// 用法（默认只看有问题的：非 completed 或过程中出过错误）：
//   npm run digest:list                 # 最近 20 条「有问题」的 run
//   npm run digest:list -- --all        # 全部（含成功且无过程错误）
//   npm run digest:list -- --status=failed --limit=50
//   npm run digest:list -- --runType=orchestrator
//   npm run digest:list -- --json       # 输出 JSON（喂给别的脚本）
//   npm run digest:list -- --show=<runId>   # 看单个 run 的完整摘要（含逐类过程问题）
//
// 摘要本身在每次 run 终态时自动写入（DB 表 run_digests + data/run-digest.jsonl），
// 这里只做**只读**展示，不改任何东西。

import { loadConfig } from '../src/config.js';
import { SqliteStore } from '../src/store/SqliteStore.js';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1);
  return '';
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function pad(s: string, n: number): string {
  // 简易宽度：中文按 2 计
  const w = [...s].reduce((acc, ch) => acc + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, n - w));
}

function clip(s: string, n: number): string {
  const arr = [...s];
  return arr.length > n ? `${arr.slice(0, n).join('')}…` : s;
}

const cfg = loadConfig();
const store = new SqliteStore(cfg.sqlitePath);

const showId = arg('show');
if (showId) {
  const d = store.getRunDigest(showId);
  if (!d) {
    console.error(`没有该 run 的复盘摘要：${showId}（可能早于本功能上线，或 runId 写错）`);
    store.close();
    process.exit(1);
  }
  console.log(JSON.stringify(d, null, 2));
  store.close();
  process.exit(0);
}

const limit = Number(arg('limit') ?? 20) || 20;
const onlyProblems = !flag('all');
const rows = store.listRunDigests({
  status: arg('status') || undefined,
  runType: arg('runType') || undefined,
  onlyProblems,
  limit,
});

if (flag('json')) {
  console.log(JSON.stringify({ count: rows.length, onlyProblems, digests: rows }, null, 2));
  store.close();
  process.exit(0);
}

const total = store.listRunDigests({ limit: 500 }).length;
const failed = store.listRunDigests({ onlyProblems: true, limit: 500 }).filter((r) => r.status !== 'completed').length;
console.log(
  `\n复盘摘要：共 ${total} 条记录 ｜ 非成功 ${failed} 条 ｜ 当前视图 ${onlyProblems ? '只看有问题的' : '全部'}（最近 ${rows.length} 条）\n`,
);

if (!rows.length) {
  console.log('（没有匹配的记录。用 --all 看全部，或换 --status / --runType 过滤）\n');
  store.close();
  process.exit(0);
}

console.log(
  `${pad('结束时间', 21)}${pad('状态', 14)}${pad('问题', 6)}${pad('runId', 26)}结论`,
);
console.log('─'.repeat(120));
for (const r of rows) {
  console.log(
    `${pad(r.finishedAt.slice(0, 19).replace('T', ' '), 21)}${pad(r.status, 14)}${pad(String(r.issueCount), 6)}${pad(
      r.runId,
      26,
    )}${clip(r.headline, 90)}`,
  );
}
console.log(
  `\n看单条详情：npm run digest:list -- --show=<runId>\n` +
    `接口版：GET /api/digests?onlyProblems=1 ｜ GET /api/runs/<runId>/digest\n`,
);

store.close();
