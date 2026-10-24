// tests/75_http_ops.test.ts — 错误上报限流 / errors.log 轮转 / 健康检查聚合
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { FixedWindowLimiter } from '../src/runtime/rateLimit.js';
import { ErrorReporter } from '../src/runtime/errorReporter.js';
import { SqliteStore } from '../src/store/SqliteStore.js';
import { SchedulerService } from '../src/scheduler/service.js';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';

async function tmpConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'mta-http-ops-'));
  const config = loadConfig();
  config.sqlitePath = join(dir, 'runtime.db');
  config.log.errorLogPath = join(dir, 'errors.log');
  config.mcp = { servers: [], toolNames: [] };
  config.host = '127.0.0.1';
  config.authToken = '';
  config.clientErrorsPerMinute = 2;
  return config;
}

async function listen(app: { listen: (port: number, host: string) => import('node:http').Server }) {
  const http = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => http.once('listening', resolve));
  const port = (http.address() as net.AddressInfo).port;
  return { http, base: `http://127.0.0.1:${port}` };
}

test('75a) FixedWindowLimiter：窗口内限流、窗口后恢复、0 表示关闭', () => {
  const limiter = new FixedWindowLimiter(2, 1000);
  assert.equal(limiter.take('ip', 0).allowed, true);
  assert.equal(limiter.take('ip', 10).allowed, true);
  const blocked = limiter.take('ip', 20);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec >= 1);
  assert.equal(limiter.take('other', 20).allowed, true);
  assert.equal(limiter.take('ip', 1001).allowed, true);
  const off = new FixedWindowLimiter(0);
  assert.equal(off.take('ip', 0).allowed, true);
});

test('75b) errors.log 超过上限轮转为 .1，新文件从一条开始', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mta-err-rotate-'));
  const logPath = join(dir, 'errors.log');
  const reporter = new ErrorReporter({ logPath, maxLogBytes: 200, console: false });
  reporter.report({ source: 'client', phase: 't', message: 'x'.repeat(800) });
  reporter.report({ source: 'client', phase: 't', message: 'second' });
  assert.equal(existsSync(`${logPath}.1`), true);
  const lines = readFileSync(logPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /second/);
});

test('75c) /api/health 聚合 DB/MCP/RAG/调度器；client-errors 超限 429', async () => {
  const config = await tmpConfig();
  const { app } = createApp(config);
  const { http, base } = await listen(app);
  try {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(health.headers.get('x-frame-options'), 'DENY');
    assert.equal(health.headers.get('cache-control'), 'no-store');
    const h = (await health.json()) as any;
    assert.equal(h.ok, true);
    assert.equal(h.components.db.ok, true);
    assert.equal(h.components.mcp.configured, 0);
    assert.equal(h.components.rag.built, false);
    assert.equal(h.components.scheduler.running, false);

    const post = () =>
      fetch(`${base}/api/client-errors`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'boom' }),
      });
    assert.equal((await post()).status, 200);
    assert.equal((await post()).status, 200);
    const limited = await post();
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  } finally {
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

test('75d) SchedulerService.status：未 start 为 false，tick 后记录时间', () => {
  const store = new SqliteStore(':memory:');
  const svc = new SchedulerService({ store, enqueue: () => 'run_x' });
  assert.equal(svc.status().running, false);
  svc.tick(new Date('2026-01-01T00:00:00Z'));
  const st = svc.status();
  assert.equal(st.tickCount, 1);
  assert.equal(st.lastTickAt, '2026-01-01T00:00:00.000Z');
  svc.start();
  assert.equal(svc.status().running, true);
  svc.stop();
  assert.equal(svc.status().running, false);
  store.close();
});
