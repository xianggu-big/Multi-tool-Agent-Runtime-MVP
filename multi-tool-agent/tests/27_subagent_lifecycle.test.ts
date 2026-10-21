// tests/27_subagent_lifecycle.test.ts — 子 Agent 生命周期与自动回收判定
// 覆盖：importance 分级、释放判定七条规则、LRU 驱逐、有状态管理器 sweep/cancel/stats。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SubAgentLifecycle,
  shouldRelease,
  pickEvictionVictim,
  resolveRetention,
  DEFAULT_RETENTION,
  type SubAgentHandle,
} from '../src/runtime/SubAgentLifecycle.js';
import { SUB_AGENT_SPECS } from '../src/agents/specs.js';

// 构造一个最小句柄用于纯函数测试
function mk(over: Partial<SubAgentHandle> = {}): SubAgentHandle {
  return {
    id: 'st_test',
    specId: 'doc-research',
    specTitle: '资料调研子 Agent',
    parentRunId: 'run_1',
    importance: 'ephemeral',
    bornAt: 1000,
    lastActiveAt: 1000,
    status: 'running',
    resultConsumed: false,
    terminalReported: false,
    idleTimeoutMs: DEFAULT_RETENTION.ephemeral.idleTimeoutMs,
    maxAgeMs: DEFAULT_RETENTION.ephemeral.maxAgeMs,
    ...over,
  };
}

describe('resolveRetention + DEFAULT_RETENTION', () => {
  it('ephemeral 默认 30s 闲置 / 30min maxAge', () => {
    const r = resolveRetention({ importance: 'ephemeral' });
    assert.equal(r.idleTimeoutMs, 30_000);
    assert.equal(r.maxAgeMs, 30 * 60_000);
  });
  it('session 默认 5min 闲置 / 4h maxAge', () => {
    const r = resolveRetention({ importance: 'session' });
    assert.equal(r.idleTimeoutMs, 5 * 60_000);
    assert.equal(r.maxAgeMs, 4 * 60 * 60_000);
  });
  it('spec 可覆盖 idleTimeoutMs', () => {
    const r = resolveRetention({ importance: 'session', idleTimeoutMs: 120_000 });
    assert.equal(r.idleTimeoutMs, 120_000);
    assert.equal(r.maxAgeMs, 4 * 60 * 60_000); // 仍取默认
  });
  it('缺省 = ephemeral', () => {
    assert.equal(resolveRetention(undefined).importance, 'ephemeral');
  });
});

describe('shouldRelease — 七条判定规则', () => {
  it('1. 父任务取消 → 立即释放', () => {
    const dec = shouldRelease(mk(), { now: 1010, parentAborted: true });
    assert.equal(dec.release, true);
    assert.equal(dec.rule, 'parent_cancelled');
  });

  it('2. maxAge 硬性到期 → 释放（即使 session 也兜底）', () => {
    const h = mk({ importance: 'session', maxAgeMs: 60_000, bornAt: 1000, lastActiveAt: 1061_000 });
    const dec = shouldRelease(h, { now: 1061_000 });
    assert.equal(dec.release, true);
    assert.equal(dec.rule, 'max_age_exceeded');
  });

  it('3. failed → 释放（结果保留供核验）', () => {
    const h = mk({ status: 'failed' });
    const dec = shouldRelease(h, { now: 1001 });
    assert.equal(dec.release, true);
    assert.equal(dec.rule, 'failed_unrecoverable');
  });

  it('4. ephemeral + 终结上报完成 → 立即释放', () => {
    const h = mk({ importance: 'ephemeral', status: 'completed', terminalReported: true });
    const dec = shouldRelease(h, { now: 1001 });
    assert.equal(dec.release, true);
    assert.equal(dec.rule, 'ephemeral_terminal');
  });

  it('5. ephemeral + 结果已被消费 → 释放', () => {
    const h = mk({ importance: 'ephemeral', resultConsumed: true });
    const dec = shouldRelease(h, { now: 1001 });
    assert.equal(dec.release, true);
    assert.equal(dec.rule, 'ephemeral_consumed');
  });

  it('6. ephemeral + 预算耗尽(limit_reached) → 释放', () => {
    const h = mk({ importance: 'ephemeral', status: 'limit_reached', triggeredLimit: 'maxSteps' });
    const dec = shouldRelease(h, { now: 1001 });
    assert.equal(dec.release, true);
    assert.equal(dec.rule, 'ephemeral_budget');
  });

  it('7. 闲置超时 → 释放（session 主力规则）', () => {
    const h = mk({ importance: 'session', idleTimeoutMs: 60_000, bornAt: 1000, lastActiveAt: 1000 });
    const dec = shouldRelease(h, { now: 1000 + 61_000 });
    assert.equal(dec.release, true);
    assert.equal(dec.rule, 'idle_timeout');
  });

  it('session + 终结上报完成但未闲置 → 不释放（保留供追问）', () => {
    const h = mk({
      importance: 'session',
      status: 'completed',
      terminalReported: true,
      idleTimeoutMs: 5 * 60_000,
      bornAt: 1000,
      lastActiveAt: 1000,
    });
    const dec = shouldRelease(h, { now: 2000 }); // 才过 1s
    assert.equal(dec.release, false);
  });

  it('存活中（未触发任何规则）→ 不释放', () => {
    const h = mk({ importance: 'session', idleTimeoutMs: 60_000, lastActiveAt: 1000 });
    assert.equal(shouldRelease(h, { now: 1500 }).release, false);
  });

  it('已 released 的不再判定', () => {
    const h = mk({ status: 'released' });
    assert.equal(shouldRelease(h, { now: 9999 }).release, false);
  });
});

describe('pickEvictionVictim — LRU 池驱逐', () => {
  it('池未满 → null', () => {
    const handles = [mk({ id: 'a' })];
    assert.equal(pickEvictionVictim(handles, { maxPoolSize: 4, now: 1 }), null);
  });

  it('优先驱逐已结束的 ephemeral', () => {
    const handles = [
      mk({ id: 'a', importance: 'session', lastActiveAt: 100 }),
      mk({ id: 'b', importance: 'ephemeral', status: 'completed', terminalReported: true, lastActiveAt: 200 }),
      mk({ id: 'c', importance: 'ephemeral', status: 'running', lastActiveAt: 50 }),
    ];
    // 池上限 1，但 3 个存活 → 驱逐已结束的 ephemeral (b)
    assert.equal(pickEvictionVictim(handles, { maxPoolSize: 1, now: 300 }), 'b');
  });

  it('无已结束时，驱逐闲置最久的 ephemeral', () => {
    const handles = [
      mk({ id: 'a', importance: 'ephemeral', lastActiveAt: 100 }),
      mk({ id: 'b', importance: 'ephemeral', lastActiveAt: 200 }),
    ];
    assert.equal(pickEvictionVictim(handles, { maxPoolSize: 1, now: 300 }), 'a');
  });

  it('durable 最后才被驱逐', () => {
    const handles = [
      mk({ id: 'a', importance: 'durable', lastActiveAt: 100 }),
      mk({ id: 'b', importance: 'session', lastActiveAt: 200 }),
    ];
    assert.equal(pickEvictionVictim(handles, { maxPoolSize: 1, now: 300 }), 'b');
  });
});

describe('SubAgentLifecycle — 有状态管理器', () => {
  it('register → running，sweep 无事', () => {
    let now = 1000;
    const events: string[] = [];
    const lc = new SubAgentLifecycle({
      maxPoolSize: 4,
      onRelease: (e) => events.push(`${e.id}:${e.rule}`),
      now: () => now,
    });
    lc.register({ id: 'st_1', specId: 'doc-research', specTitle: '调研', parentRunId: 'r1', retention: { importance: 'ephemeral' } });
    assert.equal(lc.liveCount(), 1);
    assert.deepEqual(lc.sweep(), []);
    assert.equal(lc.get('st_1')?.status, 'running');
  });

  it('ephemeral: 终结上报完成 → sweep 立即释放', () => {
    let now = 1000;
    const events: string[] = [];
    const lc = new SubAgentLifecycle({
      onRelease: (e) => events.push(`${e.id}:${e.rule}:${e.unconsumedResult ? 'unconsumed' : 'consumed'}`),
      now: () => now,
    });
    lc.register({ id: 'st_1', specId: 'doc-research', specTitle: '调研', parentRunId: 'r1', retention: { importance: 'ephemeral' } });
    lc.markTerminalReported('st_1');
    now = 1001;
    const ev = lc.sweep();
    assert.equal(ev.length, 1);
    assert.equal(ev[0].rule, 'ephemeral_terminal');
    // 终结上报完成但未 markConsumed → unconsumedResult=true（不静默丢弃）
    assert.equal(ev[0].unconsumedResult, true);
    assert.equal(lc.liveCount(), 0);
  });

  it('ephemeral: 先 markConsumed 再 sweep → consumed 释放，无 unconsumed', () => {
    let now = 1000;
    const lc = new SubAgentLifecycle({ now: () => now });
    lc.register({ id: 'st_1', specId: 'doc-research', specTitle: '调研', parentRunId: 'r1', retention: { importance: 'ephemeral' } });
    lc.markTerminalReported('st_1');
    lc.markConsumed('st_1');
    now = 1001;
    const ev = lc.sweep();
    assert.equal(ev[0].rule, 'ephemeral_terminal');
    assert.equal(ev[0].unconsumedResult, false);
  });

  it('session: 终结上报完成但未闲置 → 不释放；闲置超时后释放', () => {
    let now = 1000;
    const lc = new SubAgentLifecycle({ now: () => now });
    lc.register({
      id: 'st_1', specId: 'code-audit', specTitle: '审计', parentRunId: 'r1',
      retention: { importance: 'session', idleTimeoutMs: 60_000 },
    });
    lc.markTerminalReported('st_1');
    now = 1500;
    assert.deepEqual(lc.sweep(), []); // 才过 0.5s，保留
    now = 1000 + 61_000;
    const ev = lc.sweep();
    assert.equal(ev.length, 1);
    assert.equal(ev[0].rule, 'idle_timeout');
  });

  it('cancelByParent: 级联释放某父任务的所有子 Agent', () => {
    let now = 1000;
    const lc = new SubAgentLifecycle({ now: () => now });
    lc.register({ id: 'st_1', specId: 'doc-research', specTitle: '调研', parentRunId: 'r1', retention: { importance: 'session' } });
    lc.register({ id: 'st_2', specId: 'code-audit', specTitle: '审计', parentRunId: 'r1', retention: { importance: 'session' } });
    lc.register({ id: 'st_3', specId: 'doc-research', specTitle: '调研', parentRunId: 'r2', retention: { importance: 'session' } });
    now = 1001;
    const ev = lc.cancelByParent('r1');
    assert.equal(ev.length, 2);
    assert.equal(lc.get('st_3')?.status, 'running'); // r2 的不受影响
  });

  it('markEnded(failed) → sweep 释放', () => {
    let now = 1000;
    const lc = new SubAgentLifecycle({ now: () => now });
    lc.register({ id: 'st_1', specId: 'doc-research', specTitle: '调研', parentRunId: 'r1', retention: { importance: 'session' } });
    lc.markEnded('st_1', 'failed');
    now = 1001;
    const ev = lc.sweep();
    assert.equal(ev[0].rule, 'failed_unrecoverable');
  });

  it('retire: 显式退役 durable', () => {
    let now = 1000;
    const lc = new SubAgentLifecycle({ now: () => now });
    lc.register({ id: 'st_1', specId: 'code-audit', specTitle: '审计', parentRunId: 'r1', retention: { importance: 'durable' } });
    lc.retire('st_1');
    assert.equal(lc.get('st_1')?.status, 'released');
    assert.equal(lc.liveCount(), 0);
  });

  it('池满 LRU 驱逐：注册第 5 个时驱逐最旧 ephemeral', () => {
    let now = 1000;
    const lc = new SubAgentLifecycle({ maxPoolSize: 2, now: () => now });
    lc.register({ id: 'st_1', specId: 'doc-research', specTitle: '调研', parentRunId: 'r1', retention: { importance: 'ephemeral' } });
    now = 1100;
    lc.register({ id: 'st_2', specId: 'doc-research', specTitle: '调研', parentRunId: 'r1', retention: { importance: 'ephemeral' } });
    now = 1200;
    // 第 3 个触发驱逐（池上限 2）：st_1 最旧 → 被驱逐
    lc.register({ id: 'st_3', specId: 'doc-research', specTitle: '调研', parentRunId: 'r1', retention: { importance: 'ephemeral' } });
    assert.equal(lc.get('st_1')?.status, 'released');
    assert.equal(lc.get('st_3')?.status, 'running');
  });

  it('touch 刷新活动时间，避免闲置误判', () => {
    let now = 1000;
    const lc = new SubAgentLifecycle({ now: () => now });
    lc.register({ id: 'st_1', specId: 'doc-research', specTitle: '调研', parentRunId: 'r1', retention: { importance: 'session', idleTimeoutMs: 60_000 } });
    now = 30_000;
    lc.touch('st_1'); // 刷新
    now = 31_000;
    assert.deepEqual(lc.sweep(), []); // 距 touch 才 1s，不释放
  });

  it('stats 汇总', () => {
    let now = 1000;
    const lc = new SubAgentLifecycle({ now: () => now });
    lc.register({ id: 'st_1', specId: 'doc-research', specTitle: '调研', parentRunId: 'r1', retention: { importance: 'ephemeral' } });
    lc.register({ id: 'st_2', specId: 'code-audit', specTitle: '审计', parentRunId: 'r1', retention: { importance: 'session' } });
    const s = lc.stats();
    assert.equal(s.total, 2);
    assert.equal(s.live, 2);
    assert.equal(s.byImportance.ephemeral, 1);
    assert.equal(s.byImportance.session, 1);
  });
});

describe('SUB_AGENT_SPECS — retention 已正确声明', () => {
  it('doc-research = ephemeral', () => {
    const s = SUB_AGENT_SPECS.find((x) => x.id === 'doc-research')!;
    assert.equal(s.retention?.importance, 'ephemeral');
  });
  it('dir-inventory = ephemeral', () => {
    const s = SUB_AGENT_SPECS.find((x) => x.id === 'dir-inventory')!;
    assert.equal(s.retention?.importance, 'ephemeral');
  });
  it('code-audit = session + 5min idle', () => {
    const s = SUB_AGENT_SPECS.find((x) => x.id === 'code-audit')!;
    assert.equal(s.retention?.importance, 'session');
    assert.equal(s.retention?.idleTimeoutMs, 5 * 60_000);
  });
});
