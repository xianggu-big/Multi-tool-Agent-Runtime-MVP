// tests/fixtures/crash-apply-child.ts — 真实崩溃夹具：在「目标已删除、tmp 已就绪、rename 未发生」窗口内自杀
//
// 由 tests/51_recovery.test.ts 用独立 Node 进程启动。不要把它命名为 *.test.ts，
// 否则会被测试发现器当成测试文件直接执行。
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beginApplyJournal } from '../../src/sandbox/applyJournal.js';
import { shortSha256 } from '../../src/sandbox/hash.js';

const [repo, data, runId] = process.argv.slice(2);
if (!repo || !data || !runId) {
  console.error('usage: crash-apply-child.ts <repo> <data> <runId>');
  process.exit(2);
}

const rel = 'src/crash.txt';
const base = 'export const value = 1;\n';
const next = 'export const value = 2;\n';

await mkdir(join(repo, 'src'), { recursive: true });
await writeFile(join(repo, rel), base, 'utf8');

// 与 SandboxSession.applyToRepo 同构：先备份原文，再写意图日志，最后 rm→rename。
await mkdir(join(data, 'backups', runId, 'src'), { recursive: true });
await writeFile(join(data, 'backups', runId, rel), base, 'utf8');
await beginApplyJournal(data, runId, repo, 'ap_kill', [
  { relPath: rel, op: 'edit', baseHash: shortSha256(base), workHash: shortSha256(next) },
]);

const tmp = join(repo, `${rel}.mta-tmp-kill`);
await writeFile(tmp, next, 'utf8');
await rm(join(repo, rel), { force: true });

// 此刻仓库处于最危险的半完成状态：文件消失、tmp 存在、日志为 pending。
// Windows 会以 exit=1 上报（signal 为 null）；Unix 为 SIGKILL。父进程两者都接受。
process.kill(process.pid, 'SIGKILL');

// 若平台忽略 SIGKILL（理论上不该发生），保持挂起，父进程会超时并强杀。
await new Promise(() => {});