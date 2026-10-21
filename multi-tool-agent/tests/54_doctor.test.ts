// tests/54_doctor.test.ts — 首跑自检：版本 / 路径 / 数据目录 / 端口 / Key 的判定口径
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import {
  checkDataDir,
  checkHostNode,
  checkLlmKey,
  checkNodeVersion,
  checkPort,
  formatDoctor,
} from '../scripts/doctor.js';

test('54a) Node 版本：<24 fail，24 ok，>24 warn', () => {
  assert.equal(checkNodeVersion('22.12.0').status, 'fail');
  assert.equal(checkNodeVersion('24.14.1').status, 'ok');
  assert.equal(checkNodeVersion('25.0.0').status, 'warn');
});

test('54b) 宿主 Node 路径：存在 ok，不存在 fail 且给修复建议', () => {
  assert.equal(checkHostNode(process.execPath).status, 'ok');
  const missing = checkHostNode(join(tmpdir(), 'definitely-missing-node-xyz'));
  assert.equal(missing.status, 'fail');
  assert.ok(missing.fix);
});

test('54c) 数据目录：自动创建并验证可写，探针文件不残留', () => {
  const root = mkdtempSync(join(tmpdir(), 'mta-doctor-'));
  const sqlite = join(root, 'nested', 'data', 'runtime.db');
  try {
    const r = checkDataDir(sqlite);
    assert.equal(r.status, 'ok');
    assert.ok(existsSync(join(root, 'nested', 'data')));
    assert.equal(existsSync(join(root, 'nested', 'data', `.doctor-${process.pid}-${Date.now()}.tmp`)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('54d) 端口：被占用时 warn，释放后 ok', async () => {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const busy = await checkPort(port);
    assert.equal(busy.status, 'warn');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  const free = await checkPort(port);
  assert.equal(free.status, 'ok');
});

test('54e) 模型 Key：未配置 warn（不泄露值），配置后 ok；mock 模式不报错', () => {
  const cfg = loadConfig();
  cfg.llm.presetId = 'deepseek';
  cfg.llmMode = 'openai';
  cfg.llm.apiKey = undefined;
  cfg.openai.apiKey = undefined;
  const saved = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const warn = checkLlmKey(cfg);
    assert.equal(warn.status, 'warn');
    assert.match(warn.detail, /DEEPSEEK_API_KEY/);
    assert.doesNotMatch(warn.detail, /sk-/);

    process.env.DEEPSEEK_API_KEY = 'sk-test-not-a-real-key';
    assert.equal(checkLlmKey(cfg).status, 'ok');
    delete process.env.DEEPSEEK_API_KEY;

    cfg.llmMode = 'mock';
    assert.equal(checkLlmKey(cfg).status, 'ok');
  } finally {
    if (saved === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = saved;
  }
});

test('54f) 输出格式：失败计数与修复建议都在', () => {
  const text = formatDoctor([
    { id: 'a', title: 'A', status: 'ok', detail: '正常' },
    { id: 'b', title: 'B', status: 'fail', detail: '坏了', fix: '修一下' },
  ]);
  assert.match(text, /1 个失败/);
  assert.match(text, /修一下/);
});