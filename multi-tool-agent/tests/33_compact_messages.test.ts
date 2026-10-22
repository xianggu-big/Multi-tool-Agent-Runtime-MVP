// tests/33_compact_messages.test.ts — Token 水位感知 + 上下文自动压缩
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compactMessages,
  COMPACT_KEEP_TAIL,
  COMPACT_SUMMARY_MAX_CHARS,
  COMPACT_TRIGGER_RATIO,
  LEGACY_SUMMARY_MAX_CHARS,
  resolveCompactWatermark,
  shouldCompactContext,
} from '../src/runtime/AgentRuntime.js';
import type { ChatMessage, LLMProvider } from '../src/types.js';
import { OpenAIProvider } from '../src/llm/OpenAIProvider.js';
import { getModelPreset, getPreset } from '../src/llm/presets.js';
import { makeRuntime, mockProvider } from './helpers.js';

function makeMessages(n: number): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: 'system', content: 'system-prompt' }];
  for (let i = 1; i < n; i++) {
    msgs.push({ role: i % 2 === 1 ? 'user' : 'assistant', content: `msg-${i}` });
  }
  return msgs;
}

test('33a) 消息数不足 → 不压缩', () => {
  const msgs = makeMessages(COMPACT_KEEP_TAIL + 2); // system + 7 条 = 8 条
  const { removedCount } = compactMessages(msgs);
  assert.equal(removedCount, 0);
  assert.equal(msgs.length, COMPACT_KEEP_TAIL + 2);
});

test('33b) 消息数超过阈值 → 保留 system + 最近 6 条，中间变摘要', () => {
  const msgs = makeMessages(COMPACT_KEEP_TAIL + 4); // system + 9 条 = 10 条
  const origLen = msgs.length;
  const { removedCount } = compactMessages(msgs);
  assert.equal(removedCount, origLen - (COMPACT_KEEP_TAIL + 1)); // 移除了中间 3 条
  assert.equal(msgs.length, COMPACT_KEEP_TAIL + 2); // system + 摘要 + 最近 6 条
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[0].content, 'system-prompt');
  assert.equal(msgs[1].role, 'user');
  assert.ok((msgs[1].content as string).includes('上下文压缩'));
  assert.ok((msgs[1].content as string).includes('msg-1'));
  // 最近 6 条应从 msg-4 开始（10 - 6 = 4）
  assert.equal(msgs[2].content, 'msg-4');
  assert.equal(msgs[msgs.length - 1].content, 'msg-9');
});

test('33c) 压缩后摘要包含角色信息且长度受限', () => {
  const msgs: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'a'.repeat(5000) },
    { role: 'assistant', content: 'b'.repeat(5000) },
    { role: 'user', content: 'c'.repeat(5000) },
    { role: 'user', content: 'tail-1' },
    { role: 'assistant', content: 'tail-2' },
    { role: 'user', content: 'tail-3' },
    { role: 'assistant', content: 'tail-4' },
    { role: 'user', content: 'tail-5' },
    { role: 'assistant', content: 'tail-6' },
  ];
  const { removedCount } = compactMessages(msgs);
  assert.equal(removedCount, 3);
  const digest = msgs[1].content as string;
  assert.ok(digest.includes('user:'));
  assert.ok(digest.includes('assistant:'));
  assert.ok(digest.length <= 3500); // 摘要消息本体 + digest 上限
});

test('33d) 集成：当前上下文占模型窗口 ≥60% 触发压缩', async () => {
  const { runtime } = makeRuntime();
  const tokenBudget = 100_000;
  // R23：压缩增加“活动区至少 2000 字符”的门槛；把 goal 加长，确保本用例仍测的是集成触发链路。
  const goal = `test compaction ${'g'.repeat(3000)}`;
  // 不能用 MockProvider 的 callIndex：压缩会移除 assistant 消息，callIndex 会回退。
  let call = 0;
  const provider = mockProvider(() => {
    const i = call++;
    if (i < 5) {
      return {
        content: '',
        stopReason: 'tool_use' as const,
        toolCalls: [{ id: `tc${i}`, name: 'read_file', arguments: { path: 'src/calc.js' } }],
        // 第 5 次调用时消息数已够压缩；20000 / 32768 ≈ 61% 越过窗口水位。
        promptTokens: i === 4 ? 20_000 : 10,
        completionTokens: 5,
      };
    }
    return { content: 'done', stopReason: 'end_turn' as const, promptTokens: 10, completionTokens: 5 };
  });

  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: any[]) => logs.push(args.join(' '));

  const runId = runtime.createRun(
    { runType: 'codebase', goal, repoPath: 'demo/codebase-sample', tokenBudget, maxSteps: 10, maxModelCalls: 10, maxToolCalls: 10 },
    provider,
  );
  try {
    await runtime.run({ runType: 'codebase', goal, repoPath: 'demo/codebase-sample', tokenBudget, maxSteps: 10, maxModelCalls: 10, maxToolCalls: 10 }, runId);
  } finally {
    console.log = origLog;
  }

  const rec = runtime.getRecord(runId)!;
  assert.equal(rec.status, 'completed');
  const compactLog = logs.find((l) => l.includes('上下文压缩'));
  assert.ok(compactLog, '应有上下文压缩日志');
  assert.ok(compactLog.includes('上下文水位'), '日志应说明这是上下文窗口水位');
  assert.ok(compactLog.includes('来源 provider'), '日志应标注水位来源');
});

// ---------------------------------------------------------------------------
// 2026-10-20 线上故障回归（run_mvge1343_49a18777）：按固定条数切一刀会切在
// 「一轮多工具调用」中间 → 尾部以 role:'tool' 开头、其 assistant.tool_calls 已被压进摘要
// → OpenAI 兼容接口直接 400 "Messages with role 'tool' must be a response to a
// preceding message with 'tool_calls'"，整个 run 报废（第 16 步失败）。
// 以下守卫钉死：压缩后**绝不产生孤儿 tool 消息**。

/** 协议校验：每条 tool 必须有前置 assistant.tool_calls 覆盖它的 id，且轮次结束时不留未应答项 */
function assertNoOrphanTool(msgs: ChatMessage[]): void {
  let pending = new Set<string>();
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
      assert.equal(pending.size, 0, `assistant@${i} 之前仍有未被应答的 tool_calls`);
      pending = new Set(m.toolCalls.map((t) => t.id));
      continue;
    }
    if (m.role === 'tool') {
      assert.ok(
        pending.has(m.toolCallId!),
        `孤儿 tool 消息 @${i}（toolCallId=${m.toolCallId}）—— 服务端会返回 400`,
      );
      pending.delete(m.toolCallId!);
      continue;
    }
    assert.equal(pending.size, 0, `@${i} 处 assistant.tool_calls 未被 tool 全部应答`);
    pending = new Set();
  }
  assert.equal(pending.size, 0, '尾部仍有未被应答的 tool_calls');
}

/** 构造「一轮 N 个工具」的稳定对话：system + (assistant + N tool + user 边界提示) × 轮数 */
function makeToolHeavyMessages(toolsPerStep: number[], withGoal = true): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: 'system', content: 'system-prompt' }];
  if (withGoal) msgs.push({ role: 'user', content: 'goal' });
  toolsPerStep.forEach((n, step) => {
    const calls = Array.from({ length: n }, (_, j) => ({
      id: `c_${step}_${j}`,
      name: 'read_file',
      arguments: { file: `f${step}-${j}.ts` },
    }));
    msgs.push({ role: 'assistant', content: '', toolCalls: calls });
    for (const c of calls) {
      msgs.push({ role: 'tool', content: '{"ok":true}', toolCallId: c.id, toolName: c.name, isError: false });
    }
    msgs.push({ role: 'user', content: '【不可信内容边界】…' });
  });
  return msgs;
}

test('33e) 切点落在多工具轮次中间 → 不得产生孤儿 tool（线上 400 回归）', () => {
  // 复刻故障形态：system + goal + 3 轮「assistant + 2 tool + user」= 14 条，
  // 切点 14-6=8 正好落在第 2 轮的第二个 tool 上（其 assistant 会被压进摘要）
  const msgs = makeToolHeavyMessages([2, 2, 2]);
  assert.equal(msgs.length, 14);
  assert.equal(msgs[msgs.length - COMPACT_KEEP_TAIL].role, 'tool', '前置条件：切点确实落在 tool 上');

  const { removedCount } = compactMessages(msgs);
  assert.ok(removedCount > 0, '应执行压缩');
  assert.notEqual(msgs[2].role, 'tool', '摘要后的首条业务消息不能是 tool');
  assertNoOrphanTool(msgs);
});

test('33f) 极端：尾部全是一轮工具结果 → 回退到 assistant 或 no-op，仍无孤儿', () => {
  // 一轮 8 个工具：只有 assistant + tool，没有任何 user 分隔
  const msgs: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'goal' },
    {
      role: 'assistant',
      content: '',
      toolCalls: Array.from({ length: 8 }, (_, i) => ({ id: `big_${i}`, name: 'read_file', arguments: {} })),
    },
    ...Array.from({ length: 8 }, (_, i) => ({ role: 'tool' as const, content: '{}', toolCallId: `big_${i}` })),
  ];
  const { removedCount } = compactMessages(msgs);
  assert.ok(removedCount >= 0);
  assertNoOrphanTool(msgs);
});

test('33g) 不变量：任意多工具轮次形状压缩后都无孤儿 tool', () => {
  const shapes = [[1], [2], [3], [4], [1, 2], [2, 3], [4, 4], [1, 4, 1], [3, 1, 3, 2], [2, 2, 2, 2, 2]];
  for (const shape of shapes) {
    for (const withGoal of [true, false]) {
      const msgs = makeToolHeavyMessages(shape, withGoal);
      compactMessages(msgs);
      assertNoOrphanTool(msgs);
      assert.equal(msgs[0].role, 'system', `shape=${shape} 必须保留 system`);
    }
  }
});

// ---------------------------------------------------------------------------
// R23（2026-10-21）：滚动摘要 + 压缩迟滞。
// 旧实现把上一版摘要当成普通消息再压，且每条按 200 字符截断 → 3000 字摘要反复几轮只剩 200 字。
// 以下守卫钉死：旧摘要原文保留、只压新增消息、没有新增时不重复压缩、长任务仍保留目标、摘要触顶不截断。

test('33h) 滚动摘要：旧摘要原文保留，只压缩新增消息', () => {
  const goal = '目标：修复登录 500；验收标准 ACCEPT-42 必须始终保留。';
  const msgs: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: goal },
  ];
  for (let i = 0; i < 7; i++) {
    msgs.push({ role: i % 2 ? 'assistant' : 'user', content: `old-${i} ${'x'.repeat(400)}` });
  }

  const first = compactMessages(msgs, { goal });
  assert.ok(first.removedCount > 0, '第一次应压缩');
  assert.equal(first.keptSummary, false);
  const firstSummary = msgs[1].content as string;
  assert.ok(firstSummary.includes(goal), '首次压缩必须原文保留任务目标');

  for (let i = 7; i < 14; i++) {
    msgs.push({ role: i % 2 ? 'assistant' : 'user', content: `new-${i} ${'y'.repeat(400)}` });
  }
  const second = compactMessages(msgs, { goal });
  assert.ok(second.removedCount > 0, '新增消息后应再次压缩');
  assert.equal(second.keptSummary, true);
  assert.equal(second.compactDepth, 2);
  const secondSummary = msgs[1].content as string;
  assert.ok(secondSummary.includes(goal), '旧摘要里的关键事实必须完整保留');
  assert.ok(secondSummary.includes('new-'), '新增消息应进入摘要');
  assert.ok(secondSummary.length > firstSummary.length, '滚动摘要应追加，而不是覆盖旧摘要');
});

test('33i) 没有新增可压消息时再次调用是 no-op（不重复压旧摘要）', () => {
  const msgs = makeMessages(COMPACT_KEEP_TAIL + 4);
  const first = compactMessages(msgs);
  assert.ok(first.removedCount > 0);
  const before = JSON.stringify(msgs);

  const second = compactMessages(msgs);
  assert.equal(second.removedCount, 0);
  assert.equal(JSON.stringify(msgs), before, '无新增消息时不得改写摘要');
});

test('33j) 30 步长任务反复压缩后仍保留最初目标与验收标准', () => {
  const goal = '目标：修复登录 500；验收标准 ACCEPT-42 不能被压缩丢失。';
  const msgs: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: goal },
  ];
  let compacted = 0;
  let lastDepth = 0;
  for (let step = 0; step < 30; step++) {
    msgs.push({ role: 'assistant', content: `step-${step} ${'a'.repeat(300)}` });
    msgs.push({ role: 'user', content: `result-${step} ${'b'.repeat(300)}` });
    if (step % 2 === 0) {
      const r = compactMessages(msgs, { goal });
      compacted += r.removedCount > 0 ? 1 : 0;
      if (r.removedCount > 0) lastDepth = r.compactDepth;
    }
  }
  assert.ok(compacted >= 2, '长任务应至少发生两次滚动压缩');
  assert.ok(lastDepth >= 2, '滚动摘要深度应递增，不能每次重置为 1');
  const joined = msgs.map((m) => m.content).join('\n');
  assert.ok(joined.includes('ACCEPT-42'), '最初目标不能被多轮压缩丢掉');
  assert.ok(joined.includes('depth='), '应出现滚动摘要头');
});

test('33k) 摘要达到上限时停止压缩，旧摘要原文不被截断', () => {
  const oldContent =
    '【上下文压缩 depth=3 total=10（旧摘要）】\n' + 'z'.repeat(COMPACT_SUMMARY_MAX_CHARS - 50);
  const msgs: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: oldContent },
  ];
  for (let i = 0; i < 7; i++) {
    msgs.push({ role: i % 2 ? 'assistant' : 'user', content: `tail-${i} ${'q'.repeat(300)}` });
  }

  const result = compactMessages(msgs);
  assert.equal(result.summaryCapReached, true);
  assert.equal(result.removedCount, 0);
  assert.equal(msgs[1].content, oldContent, '触顶时旧摘要必须逐字不变');
  assert.equal(result.summaryChars, oldContent.length);
});

test('33l) 压缩迟滞：水位过线但活动区没有足够新增时不压缩', () => {
  const base = {
    watermarkRatio: 0.61,
    activeChars: 3000,
    messageCount: 10,
    lastCompact: null,
    disabled: false,
  };
  assert.equal(shouldCompactContext(base), true, '首次达到水位应允许压缩');

  const last = { activeChars: 3000, messageCount: 10 };
  assert.equal(
    shouldCompactContext({ ...base, lastCompact: last, activeChars: 3500, messageCount: 12 }),
    false,
    '只新增 500 字符 / 2 条消息 → 不应每步压',
  );
  assert.equal(
    shouldCompactContext({ ...base, lastCompact: last, activeChars: 7000, messageCount: 12 }),
    true,
    '新增 4000 字符 → 允许再次压缩',
  );
  assert.equal(
    shouldCompactContext({ ...base, lastCompact: last, activeChars: 3500, messageCount: 14 }),
    true,
    '新增 4 条消息 → 允许再次压缩',
  );
  assert.equal(
    shouldCompactContext({ ...base, lastCompact: last, watermarkRatio: 0.59, activeChars: 7000 }),
    false,
    '水位未过线不压缩',
  );
  assert.equal(shouldCompactContext({ ...base, disabled: true }), false, '触顶后禁用压缩');
});
// ---------------------------------------------------------------------------
// R24（2026-10-21）：压缩水位从“任务累计预算”改成“模型上下文窗口 + 真实 promptTokens”。
// 下面三条把方向钉死：累计预算高但当前 prompt 小 → 不压；窗口已知 → 按真实水位压；
// 窗口未知 → 明确回退并标注 source=unknown。
// ---------------------------------------------------------------------------

test('33m) 累计预算 90%+ 但当前 prompt 只占窗口 9% → 不压缩', async () => {
  const { runtime, store } = makeRuntime();
  let call = 0;
  const provider = mockProvider(() => {
    const i = call++;
    if (i < 5) {
      return {
        content: '',
        stopReason: 'tool_use' as const,
        toolCalls: [{ id: `m${i}`, name: 'read_file', arguments: { path: 'src/calc.js' } }],
        promptTokens: 3_000,
        completionTokens: 5,
      };
    }
    return { content: 'done', stopReason: 'end_turn' as const, promptTokens: 10, completionTokens: 5 };
  });

  const tokenBudget = 16_000;
  const goal = `压缩水位方向 ${'g'.repeat(3000)}`;
  const input = { runType: 'codebase' as const, goal, repoPath: 'demo/codebase-sample', tokenBudget, maxSteps: 12, maxModelCalls: 12, maxToolCalls: 12 };
  const runId = runtime.createRun(input, provider);
  const result = await runtime.run(input, runId);

  assert.equal(result.status, 'completed');
  const usage = JSON.parse(runtime.getRecord(runId)!.usageJson) as { promptTokens: number };
  assert.ok(usage.promptTokens / tokenBudget >= 0.9, `累计预算应 ≥90%，实际 ${usage.promptTokens}/${tokenBudget}`);
  const compactEvents = store.getEvents(runId).filter((e) => e.type === 'context_compacted');
  assert.equal(compactEvents.length, 0, '当前 prompt 仅 3000/32768≈9%，不得因累计预算高而压缩');
});

test('33n) 窗口未知 → 回退累计预算代理，并标记 watermarkSource=unknown', async () => {
  const { runtime, store } = makeRuntime();
  let call = 0;
  const inner = mockProvider(() => {
    const i = call++;
    if (i < 5) {
      return {
        content: '',
        stopReason: 'tool_use' as const,
        toolCalls: [{ id: `n${i}`, name: 'read_file', arguments: { path: 'src/calc.js' } }],
        promptTokens: 3_000,
        completionTokens: 5,
      };
    }
    return { content: 'done', stopReason: 'end_turn' as const, promptTokens: 10, completionTokens: 5 };
  });
  // 显式去掉 contextWindow，模拟“预设没写窗口”的真实 Provider。
  const provider: LLMProvider = { name: inner.name, chat: inner.chat.bind(inner) };

  const tokenBudget = 24_000;
  const goal = `未知窗口回退 ${'g'.repeat(3000)}`;
  const input = { runType: 'codebase' as const, goal, repoPath: 'demo/codebase-sample', tokenBudget, maxSteps: 12, maxModelCalls: 12, maxToolCalls: 12 };
  const runId = runtime.createRun(input, provider);
  const result = await runtime.run(input, runId);

  assert.equal(result.status, 'completed');
  const compactEvents = store.getEvents(runId).filter((e) => e.type === 'context_compacted');
  assert.ok(compactEvents.length >= 1, '窗口未知时应回退到旧的累计预算门禁');
  const data = compactEvents[0].data as Record<string, unknown>;
  assert.equal(data.watermarkSource, 'unknown');
  assert.equal(data.contextWindow, undefined, '未知窗口不得伪造 contextWindow');
});

test('33o) 窗口已知 + 真实 promptTokens 越线 → 按窗口水位压缩（累计预算仅 50%）', async () => {
  const { runtime, store } = makeRuntime();
  let call = 0;
  const provider = mockProvider(() => {
    const i = call++;
    if (i < 5) {
      return {
        content: '',
        stopReason: 'tool_use' as const,
        toolCalls: [{ id: `o${i}`, name: 'read_file', arguments: { path: 'src/calc.js' } }],
        promptTokens: 20_000,
        completionTokens: 5,
      };
    }
    return { content: 'done', stopReason: 'end_turn' as const, promptTokens: 10, completionTokens: 5 };
  });

  const tokenBudget = 200_000;
  const goal = `窗口水位压缩 ${'g'.repeat(3000)}`;
  const input = { runType: 'codebase' as const, goal, repoPath: 'demo/codebase-sample', tokenBudget, maxSteps: 12, maxModelCalls: 12, maxToolCalls: 12 };
  const runId = runtime.createRun(input, provider);
  const result = await runtime.run(input, runId);

  assert.equal(result.status, 'completed');
  const usage = JSON.parse(runtime.getRecord(runId)!.usageJson) as { promptTokens: number };
  assert.ok(usage.promptTokens / tokenBudget < 0.6, '前置条件：累计预算仍低于 60%');
  const compactEvents = store.getEvents(runId).filter((e) => e.type === 'context_compacted');
  assert.ok(compactEvents.length >= 1, '20000/32768≈61% 应触发压缩');
  const data = compactEvents[0].data as Record<string, unknown>;
  assert.equal(data.watermarkSource, 'provider');
  assert.equal(data.contextWindow, 32_768);
  assert.equal(data.promptTokens, 20_000);
  assert.ok(Number(data.watermark) >= 0.6, `窗口水位应 ≥0.6，实际 ${data.watermark}`);
});

test('33p) usage 缺失但窗口已知 → 字符数估算 token，并标记 estimated', () => {
  const w = resolveCompactWatermark({
    contextWindow: 10_000,
    promptTokens: 0,
    charCount: 40_000,
    budgetUseRatio: 0.1,
  });
  assert.equal(w.source, 'estimated');
  assert.equal(w.promptTokens, 10_000);
  assert.equal(w.ratio, 1);
  assert.equal(w.contextWindow, 10_000);

  const unknown = resolveCompactWatermark({ charCount: 40_000, budgetUseRatio: 0.61 });
  assert.equal(unknown.source, 'unknown');
  assert.equal(unknown.ratio, 0.61, '未知窗口才使用累计预算代理');

  // 真实 Provider 接线：窗口来自模型预设，不在运行时硬编码。
  const dsPreset = getPreset('deepseek')!;
  const dsModel = getModelPreset(dsPreset, 'deepseek-flash')!;
  const deepseek = new OpenAIProvider({
    apiKey: 'test-key',
    baseUrl: 'https://example.invalid',
    model: 'deepseek-flash',
    modelPreset: dsModel,
  });
  assert.equal(deepseek.contextWindow, 1_048_576, 'DeepSeek 预设的窗口应传到 Provider');
  const unknownWindow = new OpenAIProvider({
    apiKey: 'test-key',
    baseUrl: 'https://example.invalid',
    model: 'custom-model',
  });
  assert.equal(unknownWindow.contextWindow, undefined, '没有预设窗口时必须保持未知，不能编造');
});
test('33q) legacy 对照策略：不保留旧摘要/目标，但仍不得产生孤儿 tool', () => {
  const oldSummary =
    '【上下文压缩 depth=2 total=9（旧摘要）】\n' + 'x'.repeat(300) + ' OLD-KEEP-ME';
  const msgs = makeToolHeavyMessages([2, 2, 2]);
  msgs.splice(1, 0, { role: 'user', content: oldSummary });
  const result = compactMessages(msgs, { strategy: 'legacy', goal: 'ACCEPT-42 必须保留' });

  assert.ok(result.removedCount > 0, 'legacy 应执行压缩');
  assert.equal(result.compactDepth, 1, 'legacy 不滚动，深度固定为 1');
  assert.equal(result.keptSummary, false, 'legacy 不保留旧摘要');
  assert.ok(result.summaryChars <= LEGACY_SUMMARY_MAX_CHARS + 200, 'legacy 摘要应受 3000 字上限约束');
  assert.ok(!(msgs[1].content as string).includes('OLD-KEEP-ME'), 'legacy 应丢掉旧摘要尾部');
  assert.ok(!(msgs[1].content as string).includes('ACCEPT-42'), 'legacy 不保留任务目标');
  assertNoOrphanTool(msgs);
});