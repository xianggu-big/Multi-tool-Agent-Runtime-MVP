// tests/49_async_exec.test.ts — 异步子进程回归守卫
//
// 目的不是测 Docker，而是钉死一个产品级约束：长任务在 await 期间不能冻住事件循环。
// 2026-10-19 之前沙箱阶梯/宿主复验用 spawnSync，L1 17s 期间 HTTP 轮询会 ECONNRESET。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnAsync } from '../src/sandbox/exec.js';

test('49a) spawnAsync 不阻塞事件循环：长任务期间 timer 仍能触发', async () => {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
  }, 10);
  try {
    const pending = spawnAsync(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { timeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(ticks >= 2, `长任务等待期间应至少触发 2 次 timer（实际 ${ticks}）`);
    const r = await pending;
    assert.equal(r.ok, true);
    assert.equal(r.exitCode, 0);
  } finally {
    clearInterval(timer);
  }
});

test('49b) spawnAsync 超时会 kill 并返回 timedOut（不永久挂起）', async () => {
  const started = Date.now();
  const r = await spawnAsync(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 100 });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 3000, '超时后必须在合理时间内返回');
});

test('49c) spawnAsync 输出超限会 kill 并标记 overflowed', async () => {
  const r = await spawnAsync(process.execPath, ['-e', "process.stdout.write('x'.repeat(4096))"], {
    timeoutMs: 5_000,
    maxBuffer: 256,
  });
  assert.equal(r.ok, false);
  assert.equal(r.overflowed, true);
});
test('49d) spawnAsync 监听 AbortSignal：取消后尽快返回 aborted', async () => {
  const ac = new AbortController();
  const started = Date.now();
  const pending = spawnAsync(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
    timeoutMs: 10_000,
    signal: ac.signal,
  });
  setTimeout(() => ac.abort(), 50);
  const r = await pending;
  assert.equal(r.ok, false);
  assert.equal(r.aborted, true);
  assert.ok(Date.now() - started < 3000, '取消后必须在合理时间内返回');
});