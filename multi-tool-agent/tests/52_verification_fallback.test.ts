// tests/52_verification_fallback.test.ts — 验证能力探测：有测试跑全量，无测试降级类型检查，什么都没有就如实标「未验证」
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { discoverTestFiles, resolveVerificationPlan } from '../src/sandbox/verificationPlan.js';
import { runHostFullSuite } from '../src/sandbox/hostVerify.js';

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mta-plan-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

function fakeTsc(exitCode: number): string {
  return `console.log('fake tsc'); process.exit(${exitCode});\n`;
}

test('52a) Node 原生测试：探测为 full_suite，真实跑通且 coverage=full', async () => {
  const dir = repo({
    'tests/ok.test.js': `const test=require('node:test');const assert=require('node:assert');test('ok',()=>assert.equal(1,1));\n`,
  });
  try {
    const plan = resolveVerificationPlan(dir);
    assert.equal(plan.mode, 'full_suite');
    assert.deepEqual(plan.testFiles, ['tests/ok.test.js']);

    const r = await runHostFullSuite({ repoPath: dir, nodePath: process.execPath, timeoutMs: 20_000, label: '测试夹具' });
    assert.equal(r.ran, true);
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'full_suite');
    assert.equal(r.coverage, 'full');
    assert.equal(r.blocking, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('52b) 无测试但有 tsconfig + 本地 tsc：降级类型检查（不冒充行为验证）', async () => {
  const dir = repo({
    'tsconfig.json': '{}\n',
    'node_modules/typescript/bin/tsc': fakeTsc(0),
  });
  try {
    const plan = resolveVerificationPlan(dir);
    assert.equal(plan.mode, 'typecheck');
    assert.ok(plan.reason.includes('降级'));

    const r = await runHostFullSuite({ repoPath: dir, nodePath: process.execPath, timeoutMs: 20_000, label: '测试夹具' });
    assert.equal(r.ran, true);
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'typecheck');
    assert.equal(r.coverage, 'typecheck');
    assert.match(r.note, /类型检查/);
    assert.match(r.note, /未跑行为测试/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('52c) 类型检查失败：blocking=true，调用方必须回滚', async () => {
  const dir = repo({
    'tsconfig.json': '{}\n',
    'node_modules/typescript/bin/tsc': fakeTsc(1),
  });
  try {
    const r = await runHostFullSuite({ repoPath: dir, nodePath: process.execPath, timeoutMs: 20_000 });
    assert.equal(r.ran, true);
    assert.equal(r.ok, false);
    assert.equal(r.mode, 'typecheck');
    assert.equal(r.blocking, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('52d) 空仓库：unavailable，不执行命令、不阻断落盘、文案明确「未经行为验证」', async () => {
  const dir = repo({ 'README.md': '# empty\n' });
  try {
    const plan = resolveVerificationPlan(dir);
    assert.equal(plan.mode, 'unavailable');
    const r = await runHostFullSuite({ repoPath: dir, nodePath: process.execPath, timeoutMs: 20_000, label: '测试夹具' });
    assert.equal(r.ran, false);
    assert.equal(r.ok, false);
    assert.equal(r.mode, 'unavailable');
    assert.equal(r.coverage, 'none');
    assert.equal(r.blocking, false);
    assert.match(r.note, /未运行/);
    assert.match(r.note, /未经任何行为验证/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('52e) vitest 等第三方 runner：不自动执行 npm 脚本，降级类型检查并说明原因', () => {
  const dir = repo({
    'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
    'tsconfig.json': '{}\n',
    'node_modules/typescript/bin/tsc': fakeTsc(0),
    'tests/a.test.ts': `import { test } from 'vitest';\n`,
  });
  try {
    const plan = resolveVerificationPlan(dir);
    assert.equal(plan.mode, 'typecheck');
    assert.equal(plan.nodeTestCompatible, false);
    assert.match(plan.reason, /不自动运行/);
    assert.match(plan.reason, /类型检查/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('52f) 测试文件发现：跳过 node_modules，支持 tests/test/__tests__ 与根目录', () => {
  const dir = repo({
    'a.test.ts': 'export {};\n',
    'tests/b.spec.js': 'export {};\n',
    'test/c.test.mjs': 'export {};\n',
    '__tests__/d.test.tsx': 'export {};\n',
    'node_modules/pkg/e.test.js': 'export {};\n',
    'src/deep/f.test.ts': 'export {};\n',
  });
  try {
    const files = discoverTestFiles(dir);
    assert.ok(files.includes('a.test.ts'));
    assert.ok(files.includes('tests/b.spec.js'));
    assert.ok(files.includes('test/c.test.mjs'));
    assert.ok(files.includes('__tests__/d.test.tsx'));
    assert.ok(files.includes('src/deep/f.test.ts'));
    assert.ok(!files.some((f) => f.includes('node_modules')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});