// tests/14_codebase_security.test.ts — 场景 14：仓库工具无法访问允许目录之外的文件
// 验证：read_file 等仓库工具在路径穿越 / 读取敏感文件时被拒绝。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { assertInsideRepo } from '../src/tools/codebase/security.js';
import { registryWithAll, makeCtx } from './helpers.js';

test('14a) assertInsideRepo 拒绝路径穿越', () => {
  const root = resolve('demo/codebase-sample');
  // 相对越权
  assert.throws(() => assertInsideRepo(root, '../../etc/passwd'), /不在仓库根目录内|路径越权/);
  assert.throws(() => assertInsideRepo(root, '../escape'), /不在仓库根目录内|路径越权/);
  // 绝对路径越权（按平台语义取绝对路径：Windows 认 C:/…，POSIX 认 /etc/…。
  // 2026-10-15 沙箱实测：Linux 容器里 `C:/Windows/system32` 是**相对路径**（会被解析为仓库内路径），
  // 原断言在容器内必然失败 → 改成平台分支，两个平台各自验证"绝对路径越权被拒"。）
  if (process.platform === 'win32') {
    assert.throws(() => assertInsideRepo(root, 'C:/Windows/system32'), /不在仓库根目录内|路径越权/);
  } else {
    assert.throws(() => assertInsideRepo(root, '/etc/passwd'), /不在仓库根目录内|路径越权/);
  }
  // 仓库根自身允许
  assert.doesNotThrow(() => assertInsideRepo(root, root));
  // 仓库内相对路径允许
  assert.doesNotThrow(() => assertInsideRepo(root, 'src/calc.js'));
});

test('14b) read_file 经 Registry 拒绝跳出仓库目录', async () => {
  const registry = registryWithAll();
  const ctx = makeCtx({ runType: 'codebase', allowedPermissions: ['codebase:read'] });
  // 相对路径穿越
  const r1 = await registry.execute('read_file', { path: '../../package.json' }, ctx);
  assert.equal(r1.result.ok, false, '应拒绝相对路径穿越');
  assert.match(r1.result.error!.message, /路径越权|不在仓库根目录内/);
  // 绝对路径越权
  const r2 = await registry.execute('read_file', { path: resolve(ctx.repoPath!, '../../outside.txt') }, ctx);
  assert.equal(r2.result.ok, false, '应拒绝绝对路径越权');
  assert.match(r2.result.error!.message, /路径越权|不在仓库根目录内/);
});

test('14c) read_file 拒绝读取敏感文件', async () => {
  const registry = registryWithAll();
  const ctx = makeCtx({ runType: 'codebase', allowedPermissions: ['codebase:read'] });
  // 仓库内放置一个敏感文件名（即便不存在也会被 isSensitive 拒绝，早于读取）
  const r = await registry.execute('read_file', { path: '.env' }, ctx);
  assert.equal(r.result.ok, false, '应拒绝读取敏感文件');
  assert.match(r.result.error!.message, /敏感/);
});
