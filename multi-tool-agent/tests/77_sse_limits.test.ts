// tests/77_sse_limits.test.ts — SSE 连接上限：超限 429，断开后可重新连接
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';

test('77a) SSE 连接数达到上限返回 429；断开后名额释放', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mta-sse-limit-'));
  const config = loadConfig();
  config.sqlitePath = join(dir, 'runtime.db');
  config.log.errorLogPath = join(dir, 'errors.log');
  config.mcp = { servers: [], toolNames: [] };
  config.authToken = '';
  config.stream.maxConnections = 1;
  config.stream.heartbeatMs = 60_000;
  config.stream.watchdogMs = 60_000;
  const { app, store } = createApp(config);
  store.createRun({
    runId: 'run_live',
    runType: 'codebase',
    status: 'running',
    goal: 'g',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: 0,
    modelCalls: 0,
    toolCalls: 0,
    totalDurationMs: 0,
    usageJson: '{}',
    isMock: 0,
  });
  const http = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => http.once('listening', resolve));
  const base = `http://127.0.0.1:${(http.address() as net.AddressInfo).port}`;
  const ac = new AbortController();
  try {
    const first = await fetch(`${base}/api/runs/run_live/stream`, { signal: ac.signal });
    assert.equal(first.status, 200);
    const reader = first.body!.getReader();
    const head = await reader.read();
    assert.equal(head.done, false);

    const second = await fetch(`${base}/api/runs/run_live/stream`);
    assert.equal(second.status, 429);
    assert.ok(second.headers.get('retry-after'));

    ac.abort();
    await new Promise((r) => setTimeout(r, 150));
    const third = await fetch(`${base}/api/runs/run_live/stream`);
    assert.equal(third.status, 200);
    await third.body?.cancel();
  } finally {
    ac.abort();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});
