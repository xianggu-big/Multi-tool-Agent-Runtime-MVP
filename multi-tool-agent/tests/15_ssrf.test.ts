// tests/15_ssrf.test.ts — 场景 15：网页工具拒绝不允许的目标地址和危险重定向
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkUrl } from '../src/tools/research/ssrf.js';
import { registryWithAll, makeCtx } from './helpers.js';

// 保存/恢复全局 fetch（仅危险重定向用例会替换）
const realFetch = globalThis.fetch;

function mockFetch(status: number, headers: Record<string, string>, body = ''): void {
  globalThis.fetch = (async () => new Response(body, { status, headers })) as unknown as typeof fetch;
}

test('15a) checkUrl 拒绝私网/危险目标（纯函数）', () => {
  // 被拒绝
  for (const bad of [
    'http://localhost:8080/admin',
    'http://127.0.0.1/',
    'http://10.0.0.5/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://[::1]/',
    'file:///etc/passwd',
    'ftp://example.com/',
    'http://metadata.google.internal/',
    'http://secret.internal/',
  ]) {
    const r = checkUrl(bad);
    assert.equal(r.ok, false, `应拒绝: ${bad} -> ${r.reason}`);
  }
  // localhost 子域
  assert.equal(checkUrl('http://app.localhost/').ok, false);
  // 白名单：非白名单域名被拒
  assert.equal(checkUrl('https://evil.com/', ['example.com']).ok, false);
  // 白名单：放行匹配域及其子域
  assert.equal(checkUrl('https://example.com/', ['example.com']).ok, true);
  assert.equal(checkUrl('https://api.example.com/', ['example.com']).ok, true);
  // 普通公网域名放行
  assert.equal(checkUrl('https://example.com/page').ok, true);
});

test('15b) fetch_page 经 Registry 拒绝 SSRF 目标（不发请求）', async () => {
  const registry = registryWithAll();
  const ctx = makeCtx({ runType: 'research', allowedPermissions: ['research:web'], research: {} });
  const before = (globalThis.fetch as unknown) ? 0 : 0;
  void before;
  const r = await registry.execute('fetch_page', { url: 'http://127.0.0.1:8080/secret' }, ctx);
  assert.equal(r.result.ok, false, '应拒绝私网目标');
  assert.equal(r.result.error!.code, 'SSRF_BLOCKED');
});

test('15c) fetch_page 拒绝不在白名单的域名', async () => {
  const registry = registryWithAll();
  const ctx = makeCtx({ runType: 'research', allowedPermissions: ['research:web'], research: { allowedDomains: ['example.com'] } });
  const r = await registry.execute('fetch_page', { url: 'https://evil.com/' }, ctx);
  assert.equal(r.result.ok, false, '应拒绝非白名单域名');
  assert.equal(r.result.error!.code, 'SSRF_BLOCKED');
});

test('15d) fetch_page 拒绝危险重定向（重定向到云元数据）', async () => {
  // 初始目标合法，但服务端 302 跳转到云元数据地址 -> 重定向后重新校验应失败
  mockFetch(302, { location: 'http://169.254.169.254/latest/meta-data/' });
  try {
    const registry = registryWithAll();
    const ctx = makeCtx({ runType: 'research', allowedPermissions: ['research:web'], research: {} });
    const r = await registry.execute('fetch_page', { url: 'https://example.com/start' }, ctx);
    assert.equal(r.result.ok, false, '危险重定向应被拦截');
    assert.equal(r.result.error!.code, 'SSRF_BLOCKED');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('15e) fetch_page 拒绝重定向到 localhost', async () => {
  mockFetch(302, { location: 'http://localhost:9000/admin' });
  try {
    const registry = registryWithAll();
    const ctx = makeCtx({ runType: 'research', allowedPermissions: ['research:web'], research: {} });
    const r = await registry.execute('fetch_page', { url: 'https://example.com/go' }, ctx);
    assert.equal(r.result.ok, false, '重定向到 localhost 应被拦截');
    assert.equal(r.result.error!.code, 'SSRF_BLOCKED');
  } finally {
    globalThis.fetch = realFetch;
  }
});
