// scripts/write-e2e.ts — 写能力的真实 HTTP 端到端（T6）
//
// 覆盖的不是「工具函数能跑」，而是用户真实路径：
//   POST /api/runs → 模型派发 code-edit → Docker 沙箱暂存 → 审批卡挂起
//   → POST /api/runs/:id/approvals/:approvalId(allow_once) → 落盘 → 宿主复验 → 终态
//
// 前置：Docker 已启动 + 镜像 mta-sandbox:node24 + DEEPSEEK_API_KEY。
// 用法：npm run e2e:write
// 退出码：0 通过；1 断言失败；2 前置条件缺失。

import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'limit_reached', 'awaiting_user']);

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolvePort(port));
    });
  });
}

function preflight(): string | null {
  if (!process.env.DEEPSEEK_API_KEY) return '缺少 DEEPSEEK_API_KEY';
  const info = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 20_000 });
  if (info.status !== 0) return 'Docker 未就绪（docker info 失败）';
  const image = spawnSync('docker', ['image', 'inspect', 'mta-sandbox:node24'], { encoding: 'utf8', timeout: 20_000 });
  if (image.status !== 0) return '缺少镜像 mta-sandbox:node24（先跑 node scripts/sandbox/build-image.mjs）';
  return null;
}

/**
 * 手写递归复制：本机 Node 24.14 的 `cpSync` 在复制这个 fixture 时会让进程 fail-fast
 * （0xC0000409，无 JS 异常）；fixture 很小，逐文件复制更稳，也方便跳过 node_modules。
 */
function copyTree(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) writeFileSync(to, readFileSync(from));
  }
}

async function main(): Promise<number> {
  const blocked = preflight();
  if (blocked) {
    console.error(`[write-e2e] 前置条件缺失：${blocked}`);
    return 2;
  }

  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'mta-write-e2e-'));
  const repo = join(dir, 'repo');
  // 独立 fixture：绝不改真实仓库；junction 让宿主复验能解析 tsx。
  copyTree(resolve('eval/edit-fixture/base'), repo);
  symlinkSync(resolve('node_modules'), join(repo, 'node_modules'), 'junction');

  const config = loadConfig();
  config.sqlitePath = join(dir, 'runtime.db');
  config.log.errorLogPath = join(dir, 'errors.log');
  config.stream.liveDeltas = false;
  config.mcp = { servers: [], toolNames: [] };
  config.codebase.writeEnabled = true;

  const { app, store } = createApp(config);
  const http = app.listen(port);
  await new Promise<void>((r) => http.once('listening', () => r()));
  const base = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runType: 'orchestrator',
        goal:
          '派发一个 code-edit 子任务：把 src/calc.ts 里 add 的返回值从 `a - b` 改成 `a + b`，' +
          '只改这一行，然后调用 submit_changes 提交改动。不要改测试。',
        repoPath: repo,
        llm: { mode: 'openai', provider: 'deepseek' },
        orchestration: { allowedSpecs: ['code-edit'], allowWriteSpecs: true, maxWidth: 1 },
        maxSteps: 8,
        maxModelCalls: 10,
        maxToolCalls: 10,
        tokenBudget: 80_000,
        totalTimeoutMs: 180_000,
      }),
    });
    if (res.status !== 201) {
      console.error(`[write-e2e] 创建 run 失败：HTTP ${res.status} ${await res.text()}`);
      return 2;
    }
    const { runId } = (await res.json()) as { runId: string };
    console.log(`[write-e2e] runId=${runId} repo=${repo}`);

    let approved = 0;
    let status = '';
    const failedApprovals = new Set<string>();
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      // 审批卡挂起时 run 会一直等：主动批准（模拟用户点「仅同意本次」）。
      const list = await fetch(`${base}/api/runs/${runId}/approvals`).then((r) => r.json()) as {
        pending: Array<{ approvalId: string; files: Array<{ relPath: string }> }>;
      };
      for (const p of list.pending ?? []) {
        if (failedApprovals.has(p.approvalId)) continue;
        const decide = (extra: Record<string, unknown> = {}) =>
          fetch(`${base}/api/runs/${runId}/approvals/${p.approvalId}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ decision: 'allow_once', actor: 'write-e2e', ...extra }),
          });
        let decision = await decide();
        let detail = '';
        // 批次里若同时含 run_command，会要求当前批次二次确认（HTTP 400 + code）。
        // 脚本扮演用户：看到的确认条件后再带 confirmHighRisk=true 重试一次。
        if (decision.status === 400) {
          const body = (await decision.json().catch(() => ({}))) as { code?: string; error?: string; reasons?: string[] };
          detail = ` ${body.code ?? ''} ${body.reasons?.join(',') ?? ''} ${body.error ?? ''}`.trim();
          if (body.code === 'HIGH_RISK_CONFIRMATION_REQUIRED') {
            decision = await decide({ confirmHighRisk: true });
            detail += ' → 已带二次确认重试';
          }
        }
        console.log(
          `[write-e2e] 审批 ${p.approvalId} files=${p.files.map((f) => f.relPath).join(',')} → HTTP ${decision.status}${detail ? `（${detail}）` : ''}`,
        );
        if (decision.ok) approved += 1;
        else if (decision.status === 400) failedApprovals.add(p.approvalId);
      }
      const rec = store.getRun(runId);
      status = rec?.status ?? '';
      if (TERMINAL.has(status)) break;
      await new Promise((r) => setTimeout(r, 700));
    }

    const rec = store.getRun(runId);
    const events = store.getEvents(runId);
    const byType = (t: string) => events.filter((e) => e.type === t);
    const applied = byType('change_applied').flatMap((e) => ((e.data as { applied?: string[] }).applied ?? []));
    const hostVerify = byType('verification_completed').map((e) => e.data as { phase?: string; ok?: boolean });
    const content = (() => {
      try {
        return readFileSync(join(repo, 'src/calc.ts'), 'utf8');
      } catch {
        return '';
      }
    })();
    const checks = {
      completed: status === 'completed',
      approvedOnce: approved === 1,
      appliedCalc: applied.some((p) => p.replace(/\\/g, '/').endsWith('src/calc.ts')),
      contentFixed: content.includes('return a + b;'),
      hostVerified: hostVerify.some((v) => v.phase === 'host' && v.ok === true),
      noRollback: byType('change_rolled_back').length === 0,
    };
    console.log(`[write-e2e] status=${status} tokens=${rec?.usageJson ? JSON.parse(rec.usageJson).totalTokens : '?'}`);
    console.log(`[write-e2e] checks=${JSON.stringify(checks)}`);

    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
    if (failed.length) {
      console.error(`[write-e2e] FAIL：${failed.join(', ')}`);
      console.error(`[write-e2e] answer=${(rec?.finalAnswer ?? '').slice(0, 300)}`);
      return 1;
    }
    console.log('[write-e2e] PASS：HTTP 审批 → 落盘 → 宿主复验 全链路通过');
    return 0;
  } finally {
    await new Promise<void>((r) => http.close(() => r()));
    store.close();
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`[write-e2e] 异常：${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    process.exit(1);
  },
);
