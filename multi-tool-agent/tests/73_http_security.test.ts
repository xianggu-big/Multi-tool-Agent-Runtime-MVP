// tests/73_http_security.test.ts — 默认回环绑定 + 可选 Bearer token
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { assertHttpSecurity, isLoopbackHost, loadConfig } from '../src/config.js';
import { createApp, tokenMatches } from '../src/server.js';

function tmpConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'mta-http-sec-'));
  const config = loadConfig();
  config.sqlitePath = join(dir, 'runtime.db');
  config.log.errorLogPath = join(dir, 'errors.log');
  config.mcp = { servers: [], toolNames: [] };
  config.host = '127.0.0.1';
  config.authToken = 'a'.repeat(32);
  return config;
}

async function listen(app: { listen: (port: number, host: string) => import('node:http').Server }) {
  const http = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => http.once('listening', resolve));
  const port = (http.address() as net.AddressInfo).port;
  return { http, base: `http://127.0.0.1:${port}` };
}

test('73a) 回环判断与启动期安全校验', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('127.0.0.5'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('192.168.1.2'), false);

  assert.doesNotThrow(() => assertHttpSecurity({ host: '127.0.0.1' }));
  assert.throws(() => assertHttpSecurity({ host: '0.0.0.0' }), /MTA_AUTH_TOKEN/);
  assert.throws(() => assertHttpSecurity({ host: '192.168.1.2', authToken: 'short' }), /32/);
  assert.doesNotThrow(() => assertHttpSecurity({ host: '0.0.0.0', authToken: 'x'.repeat(32) }));
  assert.equal(tokenMatches('abc', 'abc'), true);
  assert.equal(tokenMatches('abc', 'abd'), false);
  assert.equal(tokenMatches('abc', 'abcd'), false);
});

test('73b) Bearer / header / Cookie 三种认证方式；health 公开；错误 token 401', async () => {
  const config = tmpConfig();
  const token = config.authToken!;
  const { app } = createApp(config);
  const { http, base } = await listen(app);
  try {
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/config`)).status, 401);

    const bearer = await fetch(`${base}/api/config`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(bearer.status, 200);

    const header = await fetch(`${base}/api/config`, { headers: { 'x-mta-token': token } });
    assert.equal(header.status, 200);

    const wrong = await fetch(`${base}/api/config`, { headers: { authorization: `Bearer ${'b'.repeat(32)}` } });
    assert.equal(wrong.status, 401);

    const bootstrap = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
    assert.equal(bootstrap.status, 302);
    const cookie = (bootstrap.headers.get('set-cookie') ?? '').split(';')[0];
    assert.match(cookie, /^mta_token=/);
    const withCookie = await fetch(`${base}/api/config`, { headers: { cookie } });
    assert.equal(withCookie.status, 200);

    assert.equal((await fetch(`${base}/mcp`)).status, 401);
    assert.equal((await fetch(`${base}/?token=wrong`, { redirect: 'manual' })).status, 401);
    // query token 只用于首页引导，不能拿来直接调 API（避免 token 进入访问日志）。
    assert.equal((await fetch(`${base}/api/config?token=${encodeURIComponent(token)}`)).status, 401);
  } finally {
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

