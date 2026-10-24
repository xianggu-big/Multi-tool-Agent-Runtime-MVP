// tests/74_pending_mcp.test.ts — MCP 待确认执行器 + 递归脱敏
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../src/store/SqliteStore.js';
import { PendingActionService } from '../src/runtime/PendingActionService.js';
import { loadConfig } from '../src/config.js';
import type { PendingActionRecord } from '../src/scheduler/types.js';
import { hasSensitiveData, redactSecretsDeep } from '../src/security/redact.js';

function mcpRecord(id: string, payload: Record<string, unknown> = {}): PendingActionRecord {
  return {
    id,
    runId: 'run_mcp_pending',
    kind: 'mcp',
    payload: { server: 'hub', tool: 'danger', args: { a: 1 }, ...payload },
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
}

test('74a) MCP 待确认：confirm 缺失不执行；确认后只执行一次', async () => {
  const store = new SqliteStore(':memory:');
  const events: Array<{ runId: string; type: string; data: Record<string, unknown> }> = [];
  const svc = new PendingActionService(store, loadConfig(), (runId, type, data) => events.push({ runId, type, data }));
  let calls = 0;
  svc.setMcpExecutor(async (call) => {
    calls += 1;
    assert.deepEqual(call, { server: 'hub', tool: 'danger', args: { a: 1 } });
    return { ok: true, message: '远端已执行', detail: { remoteId: 'r1' } };
  });
  store.createPendingAction(mcpRecord('pa_1'));

  const refused = await svc.execute('pa_1', { confirm: false });
  assert.equal(refused.ok, false);
  assert.equal(calls, 0);
  assert.equal(store.getPendingAction('pa_1')!.status, 'pending', '未确认时状态不能变');

  const done = await svc.execute('pa_1', { confirm: true });
  assert.equal(done.ok, true);
  assert.equal(done.status, 'executed');
  assert.equal(calls, 1);
  assert.equal(store.getPendingAction('pa_1')!.status, 'executed');
  assert.equal(store.getPendingAction('pa_1')!.result?.remoteId, 'r1');

  const again = await svc.execute('pa_1', { confirm: true });
  assert.equal(again.ok, false);
  assert.equal(calls, 1, '同一操作不能重复执行');
  const decided = events.find((e) => e.type === 'pending_action_decided');
  assert.equal(decided?.data.server, 'hub');
  assert.equal(decided?.data.tool, 'danger');
});

test('74b) MCP 待确认：未注入 executor / 缺 server / 缺 tool / 抛错 → failed', async () => {
  const store = new SqliteStore(':memory:');
  const svc = new PendingActionService(store, loadConfig(), () => {});
  store.createPendingAction(mcpRecord('pa_no_exec'));
  const noExec = await svc.execute('pa_no_exec', { confirm: true });
  assert.equal(noExec.ok, false);
  assert.match(noExec.message, /executor/);
  assert.equal(store.getPendingAction('pa_no_exec')!.status, 'failed');

  let calls = 0;
  svc.setMcpExecutor(async () => {
    calls += 1;
    throw new Error('network down');
  });
  store.createPendingAction(mcpRecord('pa_no_server', { server: '' }));
  const noServer = await svc.execute('pa_no_server', { confirm: true });
  assert.equal(noServer.ok, false);
  assert.match(noServer.message, /server\/tool/);

  store.createPendingAction(mcpRecord('pa_bad_args', { args: [1, 2] }));
  const badArgs = await svc.execute('pa_bad_args', { confirm: true });
  assert.equal(badArgs.ok, false);
  assert.match(badArgs.message, /args/);

  store.createPendingAction(mcpRecord('pa_throws'));
  const thrown = await svc.execute('pa_throws', { confirm: true });
  assert.equal(thrown.ok, false);
  assert.match(thrown.message, /network down/);
  assert.equal(store.getPendingAction('pa_throws')!.status, 'failed');
  assert.equal(calls, 1, '缺参数时不应调用远端');
});

test('74c) 递归脱敏：键名与常见密钥形态都命中', () => {
  const source = {
    harmless: 'ok',
    Authorization: 'Bearer abcdefgh12345678',
    nested: { apiKey: 'sk-abcdefgh12345678', list: ['fine', 'ghp_abcdefgh12345678'] },
    tokenizer: 'not-a-secret',
  };
  const r = redactSecretsDeep(source);
  assert.equal(r.redacted, true);
  const out = r.value as any;
  assert.equal(out.harmless, 'ok');
  assert.equal(out.Authorization, '[redacted]');
  assert.equal(out.nested.apiKey, '[redacted]');
  assert.equal(out.nested.list[0], 'fine');
  assert.equal(out.nested.list[1], '[redacted]');
  assert.equal(out.tokenizer, 'not-a-secret');
  assert.equal(hasSensitiveData({ database: { password: 'p@ss' } }), true);
  assert.equal(hasSensitiveData({ q: 'hello' }), false);
});
