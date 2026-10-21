// tests/56_run_digest.test.ts — 每次 run 结束都留一份「复盘摘要」（成功也写、失败优先）
//
// 背景（2026-10-20 用户要求）：失败时 runs 行只有一行 failureReason，看不到过程中还出过什么错；
// 成功时几乎没有痕迹——中间失败了 3 次工具、被限流 1 次都散在 events 里，不复盘等于没发生。
// 本套件钉死：终态必写摘要、过程错误被保留、成功也有记录、被中断的 run 也补一条。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import type { RuntimeConfig } from '../src/config.js';
import { buildRuntime } from '../src/runtime/index.js';
import { createApp } from '../src/server.js';
import { SqliteStore } from '../src/store/SqliteStore.js';
import { mockProvider } from './helpers.js';
import type { RunInput } from '../src/types.js';
import type { MockResponder } from '../src/llm/MockProvider.js';
import type { LLMProvider, LLMResponse } from '../src/types.js';

const WORKSPACE = resolve('demo/codebase-sample');

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'mta-digest-'));
}

/** 临时库（不用 :memory:，因为要验证 JSONL 落盘；buildRuntime 会把 JSONL 放到 DB 同目录） */
function cfgFor(dir: string): RuntimeConfig {
  const config = loadConfig();
  config.stream.liveDeltas = false;
  config.sqlitePath = join(dir, 'test.db');
  config.log.errorLogPath = join(dir, 'errors.log');
  return config;
}

function readDigestLines(path: string): any[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test('56a) 成功的 run 也要写摘要，且过程中的工具失败被保留（不被"完成"掩盖）', async () => {
  const dir = tmpDir();
  const config = cfgFor(dir);
  const { runtime, store, logger } = buildRuntime(config, config.sqlitePath);

  const responder: MockResponder = ({ callIndex }) => {
    if (callIndex === 0) {
      return {
        stopReason: 'tool_use',
        content: '先读一个不存在的文件',
        toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'nope.ts' } }],
      };
    }
    if (callIndex === 1) {
      return {
        stopReason: 'tool_use',
        content: '换个正确路径',
        toolCalls: [{ id: 'c2', name: 'read_file', arguments: { path: 'src/calc.js' } }],
      };
    }
    return { stopReason: 'end_turn', content: '完成' };
  };

  const input: RunInput = { runType: 'codebase', goal: '读文件', repoPath: WORKSPACE };
  const runId = runtime.createRun(input, mockProvider(responder));
  const result = await runtime.run(input, runId);
  logger.flush();

  assert.equal(result.status, 'completed', '本用例前提：任务最终成功');

  const digest = store.getRunDigest(runId);
  assert.ok(digest, '成功的 run 也必须有摘要');
  assert.equal(digest!.ok, true);
  assert.equal(digest!.status, 'completed');
  assert.equal(digest!.counters.modelCalls >= 3, true);
  // 过程错误必须留下来（这是"复盘"的核心：成功不等于没出过错）
  assert.equal(digest!.counts.toolFails, 1, '应记录 1 次工具失败');
  assert.equal(digest!.issues.length, 1, '应聚合出 1 类问题');
  assert.equal(digest!.issues[0].code, 'NOT_FOUND');
  assert.equal(digest!.issues[0].where, 'read_file');
  assert.match(digest!.headline, /^完成，但/, '成功但有过程错误时，headline 要显式说明');
  assert.ok(digest!.firstIssue, '应给出首个问题（可直接跳 seq 回放）');

  // 事件落点：run_digest 进事件流（UI/报告可读）
  assert.ok(store.getEvents(runId).some((e) => e.type === 'run_digest'), '应有 run_digest 事件');

  // JSONL 落点：一行一个 run，便于 grep
  const lines = readDigestLines(join(dir, 'run-digest.jsonl'));
  const line = lines.find((l) => l.runId === runId);
  assert.ok(line, 'JSONL 里应有本次 run');
  assert.equal(line.headline, digest!.headline);
  assert.equal(line.version, 1);

  store.close();
});

test('56b) 失败的 run：摘要带 errorCode / failureReason / 首个问题（400 协议错也算过程问题）', async () => {
  const dir = tmpDir();
  const config = cfgFor(dir);
  const { runtime, store, logger } = buildRuntime(config, config.sqlitePath);

  class BoomProvider implements LLMProvider {
    readonly name = 'boom';
    async chat(): Promise<LLMResponse> {
      const e = new Error(
        '返回 400: {"error":{"message":"Messages with role \'tool\' must be a response to a preceding message with \'tool_calls\'"}}',
      ) as Error & { status: number };
      e.status = 400;
      throw e;
    }
  }

  const input: RunInput = { runType: 'codebase', goal: 'g', repoPath: WORKSPACE };
  const runId = runtime.createRun(input, new BoomProvider());
  const result = await runtime.run(input, runId);
  logger.flush();
  assert.equal(result.status, 'failed');

  const d = store.getRunDigest(runId);
  assert.ok(d, '失败的 run 必须有摘要');
  assert.equal(d!.ok, false);
  assert.equal(d!.errorCode, 'MODEL_ERROR');
  assert.match(d!.failureReason ?? '', /400/);
  assert.match(d!.headline, /^失败（MODEL_ERROR）/);
  assert.ok(d!.issues.length >= 1, '模型失败要作为过程问题出现');
  assert.equal(d!.issues[0].code, 'MODEL_ERROR');
  assert.ok(d!.firstIssue, '首个问题必须可定位');

  store.close();
});

test('56c) awaiting_user 也记录（不算成功，也不丢）', async () => {
  const dir = tmpDir();
  const config = cfgFor(dir);
  const { runtime, store, logger } = buildRuntime(config, config.sqlitePath);

  class AskProvider implements LLMProvider {
    readonly name = 'ask';
    async chat(): Promise<LLMResponse> {
      return {
        stopReason: 'tool_use',
        content: '',
        toolCalls: [
          { id: 't1', name: 'ask_user', arguments: { questions: ['要分析哪个目录？'], reason: '范围不明确' } },
        ],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0, isEstimate: true },
        latencyMs: 1,
        model: 'ask',
      };
    }
  }

  const input: RunInput = { runType: 'misc', goal: '分析仓库' };
  const runId = runtime.createRun(input, new AskProvider());
  const result = await runtime.run(input, runId);
  logger.flush();
  assert.equal(result.status, 'awaiting_user');

  const d = store.getRunDigest(runId);
  assert.ok(d, 'awaiting_user 也是终态，必须留摘要');
  assert.equal(d!.ok, false, 'awaiting_user 不应被算作成功');
  assert.match(d!.headline, /等待用户回答/);
  store.close();
});

test('56d) 「一个流程都跑不完」：进程中断的孤儿 run 启动时补一条摘要', () => {
  const dir = tmpDir();
  const config = cfgFor(dir);
  // 造一个上次进程留下的 running 行
  const seed = new SqliteStore(config.sqlitePath);
  seed.createRun({
    runId: 'run_orphan_digest',
    runType: 'codebase',
    status: 'running',
    goal: '半路被杀的任务',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: 2,
    modelCalls: 2,
    toolCalls: 1,
    totalDurationMs: 1234,
    usageJson: '{"promptTokens":100,"completionTokens":20,"totalTokens":120,"costUsd":0}',
    isMock: 0,
  });
  seed.close();

  const { store, logger } = buildRuntime(config, config.sqlitePath); // 启动回收
  const rec = store.getRun('run_orphan_digest')!;
  assert.equal(rec.status, 'failed');
  assert.equal(rec.errorCode, 'RUN_INTERRUPTED');

  const d = store.getRunDigest('run_orphan_digest');
  assert.ok(d, '被中断的 run 也必须有摘要（否则只剩一行 failureReason）');
  assert.equal(d!.ok, false);
  assert.equal(d!.errorCode, 'RUN_INTERRUPTED');
  assert.match(d!.headline, /^失败（RUN_INTERRUPTED）/);
  logger.flush();
  store.close();
});

test('56e) 接口：GET /api/digests 过滤 + GET /api/runs/:id/digest 详情', async () => {
  const dir = tmpDir();
  const config = cfgFor(dir);
  const bundle = buildRuntime(config, config.sqlitePath);

  const responder: MockResponder = ({ callIndex }) =>
    callIndex === 0
      ? {
          stopReason: 'tool_use',
          content: '',
          toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'nope.ts' } }],
        }
      : { stopReason: 'end_turn', content: '完成' };
  const input: RunInput = { runType: 'codebase', goal: 'g', repoPath: WORKSPACE };
  const runId = bundle.runtime.createRun(input, mockProvider(responder));
  await bundle.runtime.run(input, runId);
  bundle.logger.flush();
  bundle.store.close();

  const { app, store } = createApp(config);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const list = (await (await fetch(`${base}/api/digests?onlyProblems=1`)).json()) as any;
    assert.ok(list.digests.some((d: any) => d.runId === runId), '有问题视图里应包含本次 run');
    assert.equal(typeof list.digests[0].headline, 'string');

    const onlyFailed = (await (await fetch(`${base}/api/digests?status=failed`)).json()) as any;
    assert.ok(!onlyFailed.digests.some((d: any) => d.runId === runId), '本次是 completed，不应出现在 failed 里');

    const one = (await (await fetch(`${base}/api/runs/${runId}/digest`)).json()) as any;
    assert.equal(one.runId, runId);
    assert.equal(one.ok, true);
    assert.ok(Array.isArray(one.issues) && one.issues.length >= 1);

    const missing = await fetch(`${base}/api/runs/run_not_exist/digest`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections?.();
    });
    store.close();
  }
});

test('56f) 复盘摘要带上下文压缩观测（R23）：次数 / 深度 / 移除条数 / 摘要大小', async () => {
  const dir = tmpDir();
  const config = cfgFor(dir);
  const { runtime, store, logger } = buildRuntime(config, config.sqlitePath);

  // 不能用 callIndex：压缩会移除 assistant 消息，MockProvider 的 callIndex 会回退。
  let call = 0;
  const responder: MockResponder = () => {
    const i = call++;
    if (i < 5) {
      return {
        stopReason: 'tool_use',
        content: '',
        toolCalls: [
          { id: `c${i}`, name: 'read_file', arguments: { path: 'src/calc.js' } },
        ],
        // 第 5 次调用时消息数已够压缩；22000/32768≈67% 越过窗口水位（不是累计预算）
        promptTokens: i === 4 ? 22_000 : 10,
        completionTokens: 5,
      };
    }
    return { stopReason: 'end_turn', content: '完成', promptTokens: 10, completionTokens: 5 };
  };

  const goal = `压缩观测 ${'g'.repeat(3000)}`;
  const input: RunInput = {
    runType: 'codebase',
    goal,
    repoPath: WORKSPACE,
    tokenBudget: 200_000,
    maxSteps: 12,
    maxModelCalls: 12,
    maxToolCalls: 12,
  };
  const runId = runtime.createRun(input, mockProvider(responder));
  const result = await runtime.run(input, runId);
  logger.flush();

  assert.equal(result.status, 'completed');
  const digest = store.getRunDigest(runId);
  assert.ok(digest, '应有复盘摘要');
  assert.ok(digest!.compaction, '发生过压缩时必须带 compaction 观测');
  assert.ok(digest!.compaction!.count >= 1, '至少记录一次压缩');
  assert.ok(digest!.compaction!.removedMessages >= 1, '应记录移除消息数');
  assert.ok(digest!.compaction!.maxDepth >= 1, '应记录摘要深度');
  assert.ok(digest!.compaction!.lastSummaryChars > 0, '应记录摘要字符数');
  assert.ok((digest!.compaction!.maxWatermark ?? 0) >= 0.6, '应记录窗口水位');
  assert.deepEqual(digest!.compaction!.watermarkSources, ['provider'], '应记录水位来源');
  assert.equal(digest!.compaction!.lastPromptTokens, 22_000);
  assert.equal(digest!.compaction!.contextWindow, 32_768);

  const events = store.getEvents(runId);
  const compactEvents = events.filter((e) => e.type === 'context_compacted');
  assert.ok(compactEvents.length >= 1, 'context_compacted 事件必须落盘（不能只走实时通道）');
  const compactData = compactEvents[0].data as Record<string, unknown>;
  assert.equal(compactData.watermarkSource, 'provider');
  assert.equal(compactData.contextWindow, 32_768);
  assert.equal(compactData.promptTokens, 22_000);
  assert.ok(
    compactEvents.every((e) => typeof (e.data as any)?.summaryChars === 'number'),
    '每条压缩事件都应带 summaryChars，便于复盘定位',
  );
  const line = readDigestLines(join(dir, 'run-digest.jsonl')).find((l) => l.runId === runId);
  assert.ok(line?.compaction, 'JSONL 落点也应带 compaction 观测');

  store.close();
});
