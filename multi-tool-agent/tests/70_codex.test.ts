// tests/70_codex.test.ts — Codex 适配层：事件解析 / argv / 变更导入 / 思考旁路 / 假 CLI 端到端
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCodexArgs, parseCodexLine, runCodex } from '../src/codex/runner.js';
import { scanCodexChanges } from '../src/codex/importChanges.js';
import { readReasoning } from '../src/codex/reasoningTap.js';

test('70a) parseCodexLine：thread / message / command / usage / warning / fatal error', () => {
  assert.deepEqual(parseCodexLine('{"type":"thread.started","thread_id":"t1"}'), { type: 'thread', threadId: 't1' });
  assert.deepEqual(parseCodexLine('{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"ok"}}'), {
    type: 'message',
    text: 'ok',
  });
  const started = parseCodexLine(
    '{"type":"item.started","item":{"id":"i2","type":"command_execution","command":"dir"}}',
  );
  assert.equal(started?.type, 'command_started');
  const done = parseCodexLine(
    '{"type":"item.completed","item":{"id":"i2","type":"command_execution","command":"dir","aggregated_output":"x","exit_code":0}}',
  );
  assert.equal(done?.type, 'command_completed');
  const usage = parseCodexLine(
    '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":3,"output_tokens":2,"reasoning_output_tokens":1}}',
  );
  assert.deepEqual(usage, {
    type: 'usage',
    usage: { inputTokens: 10, cachedInputTokens: 3, outputTokens: 2, reasoningOutputTokens: 1 },
  });
  // item 级 error 是非致命提示，不能把成功的 turn 判失败
  assert.equal(
    parseCodexLine('{"type":"item.completed","item":{"id":"i0","type":"error","message":"metadata missing"}}')?.type,
    'warning',
  );
  assert.equal(parseCodexLine('{"type":"turn.failed","error":{"message":"boom"}}')?.type, 'error');
  assert.equal(parseCodexLine('not json'), null);
});

test('70b) buildCodexArgs：只读/write/resume 的参数形态', () => {
  const ro = buildCodexArgs({ mode: 'read_only', cwd: 'C:/repo', model: 'm' });
  assert.deepEqual(ro.slice(0, 2), ['exec', '--json']);
  assert.ok(ro.includes('read-only'));
  assert.ok(ro.includes('-C') && ro.includes('C:/repo'));
  assert.equal(ro[ro.length - 1], '-');
  const rw = buildCodexArgs({ mode: 'write', cwd: 'C:/repo' });
  assert.ok(rw.includes('workspace-write'));
  const resume = buildCodexArgs({ mode: 'read_only', cwd: 'C:/repo', resumeThreadId: 't1' });
  assert.deepEqual(resume.slice(0, 3), ['exec', 'resume', 't1']);
  assert.equal(resume.includes('-C'), false);
  assert.equal(resume[resume.length - 1], '-');
});

test('70c) scanCodexChanges：create / edit / delete，跳过二进制与排除项', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mta-codex-import-'));
  const repo = join(root, 'repo');
  const copy = join(root, 'copy');
  try {
    mkdirSync(repo, { recursive: true });
    mkdirSync(copy, { recursive: true });
    writeFileSync(join(repo, 'a.js'), 'export const a = 1;\n');
    writeFileSync(join(copy, 'a.js'), 'export const a = 2;\n');
    writeFileSync(join(repo, 'b.js'), 'export const b = 1;\n');
    writeFileSync(join(copy, 'c.js'), 'export const c = 3;\n');
    writeFileSync(join(copy, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
    const r = await scanCodexChanges({ repoPath: repo, copyDir: copy });
    const byPath = Object.fromEntries(r.changes.map((c) => [c.relPath, c.op]));
    assert.equal(byPath['a.js'], 'edit');
    assert.equal(byPath['c.js'], 'create');
    assert.equal(byPath['b.js'], 'delete');
    assert.equal(r.skipped.find((s) => s.relPath === 'bin.dat')?.reason, 'binary');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('70d) readReasoning：从 rollout 旁路读取 reasoning_text', () => {
  const home = mkdtempSync(join(tmpdir(), 'mta-codex-home-'));
  try {
    const d = new Date();
    const day = join(
      home,
      'sessions',
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    );
    mkdirSync(day, { recursive: true });
    const file = join(day, 'rollout-x-thread_abc.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', content: [{ type: 'reasoning_text', text: '先读文件；' }] } }),
        JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', content: [{ type: 'reasoning_text', text: '再下结论。' }] } }),
      ].join('\n') + '\n',
    );
    const r = readReasoning('thread_abc', { codexHome: home });
    assert.match(r.text, /先读文件/);
    assert.match(r.text, /再下结论/);
    assert.ok(r.position > 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

async function makeFakeCodex(root: string): Promise<string> {
  const js = join(root, 'fake-codex.js');
  writeFileSync(
    js,
    [
      '#!/usr/bin/env node',
      "process.stdin.resume();",
      "if (process.env.MTA_FAKE_FAIL === '1') process.exit(1);",
      "const lines = [",
      '  { type: "thread.started", thread_id: "thread_test" },',
      '  { type: "item.completed", item: { id: "i0", type: "error", message: "metadata warning" } },',
      '  { type: "item.completed", item: { id: "i1", type: "agent_message", text: "ok" } },',
      '  { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 } },',
      '];',
      'for (const l of lines) console.log(JSON.stringify(l));',
    ].join('\n'),
  );
  if (process.platform === 'win32') {
    const cmd = join(root, 'fake-codex.cmd');
    writeFileSync(cmd, `@ECHO off\r\nSET dp0=%~dp0\r\n@node "%dp0%\\fake-codex.js" %*\r\n`);
    return cmd;
  }
  chmodSync(js, 0o755);
  return js;
}

test('70e) runCodex：假 CLI 解析成功；非零退出 → 失败', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mta-codex-run-'));
  try {
    const bin = await makeFakeCodex(root);
    const ok = await runCodex({
      bin,
      cwd: root,
      prompt: 'hi',
      mode: 'read_only',
      timeoutMs: 20_000,
      maxOutputBytes: 1024 * 1024,
    });
    assert.equal(ok.ok, true, JSON.stringify({ error: ok.error, stderr: ok.stderrTail, exit: ok.exitCode }));
    assert.equal(ok.threadId, 'thread_test');
    assert.equal(ok.finalAnswer, 'ok');
    assert.equal(ok.warnings.length, 1);
    assert.deepEqual(ok.usage, { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1 });

    process.env.MTA_FAKE_FAIL = '1';
    const bad = await runCodex({
      bin,
      cwd: root,
      prompt: 'hi',
      mode: 'read_only',
      timeoutMs: 20_000,
      maxOutputBytes: 1024 * 1024,
    });
    delete process.env.MTA_FAKE_FAIL;
    assert.equal(bad.ok, false);
    assert.equal(bad.exitCode, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
