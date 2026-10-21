// tests/36_context_files.test.ts — @文件级上下文引用（P1-5）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRunRequest } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { makeRuntime, mockProvider } from './helpers.js';

test('36a) validateRunRequest 解析 contextFiles（去重、上限、过滤空值）', () => {
  const config = loadConfig();
  const { input, error } = validateRunRequest(
    {
      runType: 'codebase',
      goal: '分析 @src/index.ts 和 @src/utils.ts',
      repoPath: 'demo/codebase-sample',
      contextFiles: ['src/index.ts', 'src/utils.ts', '', 'src/index.ts'],
    },
    config,
  );
  assert.ok(!error, error);
  assert.deepEqual(input!.contextFiles, ['src/index.ts', 'src/utils.ts']);
});

test('36b) AgentRuntime 将 contextFiles 注入 messages（system 之后、goal 之前）', async () => {
  const { runtime } = makeRuntime();
  let capturedMsgs: any[] = [];
  const provider = mockProvider((ctx) => {
    capturedMsgs = ctx.messages;
    return { content: 'done', stopReason: 'end_turn' as const };
  });
  const runId = runtime.createRun(
    {
      runType: 'codebase',
      goal: '分析 @src/index.ts',
      repoPath: 'demo/codebase-sample',
      contextFiles: ['src/index.ts', 'src/utils.ts'],
    },
    provider,
  );
  await runtime.run(
    {
      runType: 'codebase',
      goal: '分析 @src/index.ts',
      repoPath: 'demo/codebase-sample',
      contextFiles: ['src/index.ts', 'src/utils.ts'],
    },
    runId,
  );

  const rec = runtime.getRecord(runId)!;
  assert.equal(rec.status, 'completed');
  // 检查 messages 中是否包含 contextFiles 提示
  const cfMsg = capturedMsgs.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('用户指定起点文件'));
  assert.ok(cfMsg, '应注入用户指定起点文件提示');
  assert.ok(cfMsg.content.includes('src/index.ts'));
  assert.ok(cfMsg.content.includes('src/utils.ts'));
  // 位置检查：应在 system 之后、goal 之前
  const sysIdx = capturedMsgs.findIndex((m) => m.role === 'system');
  const goalIdx = capturedMsgs.findIndex((m) => m.role === 'user' && m.content === '分析 @src/index.ts');
  const cfIdx = capturedMsgs.indexOf(cfMsg);
  assert.ok(sysIdx < cfIdx && cfIdx < goalIdx, 'contextFiles 提示应在 system 之后、goal 之前');
});
