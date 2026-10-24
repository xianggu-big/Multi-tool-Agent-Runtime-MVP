// tests/72_auto_policy.test.ts — 无人值守自动放行：普通改动落盘，删除/命令暂缓，污点拒绝
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { SandboxAccess } from '../src/tools/types.js';
import type { ApprovalDecision, ApprovalRequest } from '../src/types.js';
import { baseToolConfig, makeCtx, registryWithAll } from './helpers.js';

const REPO = resolve('demo/codebase-sample');

class FakeAutoSandbox implements SandboxAccess {
  readonly name = 'mta-sb-fake72';
  readonly marks: Array<{ rel: string; status: string }> = [];
  readonly applied: string[] = [];
  constructor(
    private readonly changes: Array<{ relPath: string; op: 'create' | 'edit' | 'delete'; status: string; retriesLeft: number }>,
    private readonly commands: Array<{
      command: string;
      shell: 'bash' | 'powershell' | 'cmd';
      cwdRel: string;
      sandboxOutput: string | null;
      sandboxExitCode: number | null;
      status: string;
    }> = [],
  ) {}
  async ensure() { return { ok: true as const }; }
  isStarted() { return true; }
  readRepoFile() { return 'old'; }
  readWorkFile() { return 'new'; }
  stage() {}
  mark(rel: string, status: string) { this.marks.push({ rel, status }); }
  consumeRound() { return 0; }
  getChanges() { return this.changes; }
  beginApply() {}
  async runLadder(level: 'L0' | 'L1' | 'L2' = 'L1') {
    return { ok: true, level: String(level), steps: [] as Array<{ source: string; verdict: { ok: boolean; summary: string } }> };
  }
  diffPatch() { return '--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n'; }
  diffDir() { return tmpdir(); }
  applyToRepo(rel: string) { this.applied.push(rel); return { ok: true as const }; }
  rollbackFromBackup() { return true; }
  backupsDir() { return tmpdir(); }
  stageCommand() {}
  getCommands() { return this.commands; }
  markCommand(_i: number, status: string) { this.marks.push({ rel: 'cmd:' + _i, status }); }
}

function autoCtx(sb: SandboxAccess, pending: Array<{ kind: string; payload: Record<string, unknown> }>) {
  const base = baseToolConfig();
  let approvals = 0;
  const ctx = makeCtx({
    runType: 'codebase',
    allowedPermissions: ['codebase:read', 'codebase:write'],
    repoPath: REPO,
    config: { ...base, codebase: { ...base.codebase, writeEnabled: true } },
    sandbox: sb,
    requestApproval: async (req: ApprovalRequest): Promise<ApprovalDecision> => {
      approvals++;
      return { approvalId: req.approvalId, value: 'allow_once', decidedAt: new Date().toISOString() };
    },
    autoPolicy: {
      enabled: true,
      createPending: (a) => {
        pending.push(a);
        return 'pa_' + pending.length;
      },
    },
  });
  return { ctx, approvals: () => approvals };
}

test('72a) autoPolicy：edit 自动落盘；delete/命令暂缓；不弹人工审批', async () => {
  const sb = new FakeAutoSandbox([
    { relPath: 'a.js', op: 'edit', status: 'staged', retriesLeft: 3 },
    { relPath: 'b.js', op: 'delete', status: 'staged', retriesLeft: 3 },
  ], [
    { command: 'node -v', shell: 'powershell', cwdRel: '.', sandboxOutput: 'v24', sandboxExitCode: 0, status: 'pending' },
  ]);
  const pending: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const { ctx, approvals } = autoCtx(sb, pending);
  const r = await registryWithAll().execute('submit_changes', { summary: 'auto' }, ctx);
  assert.equal(r.result.ok, true);
  assert.equal(approvals(), 0, '自动模式下不得弹人工审批');
  assert.deepEqual((r.result.data as any).applied, ['a.js']);
  assert.deepEqual(sb.applied, ['a.js']);
  assert.deepEqual(pending.map((p) => p.kind).sort(), ['command', 'delete']);
  assert.equal((r.result.data as any).autoApproved, true);
  assert.equal(sb.marks.some((m) => m.rel === 'b.js' && m.status === 'deferred'), true);
});

test('72b) autoPolicy：污点 run 拒绝自动落盘（AUTO_DEFERRED_TAINT）', async () => {
  const sb = new FakeAutoSandbox([{ relPath: 'a.js', op: 'edit', status: 'staged', retriesLeft: 3 }]);
  const pending: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const { ctx } = autoCtx(sb, pending);
  ctx.untrustedTainted = true;
  const r = await registryWithAll().execute('submit_changes', { summary: 'auto' }, ctx);
  assert.equal(r.result.ok, false);
  assert.equal(r.result.error?.code, 'AUTO_DEFERRED_TAINT');
  assert.equal(sb.applied.length, 0);
  assert.equal(pending.length, 0);
});
