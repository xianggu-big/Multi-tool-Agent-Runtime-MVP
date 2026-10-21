// scripts/llm-smoke.ts — 真实 LLM 端到端冒烟（默认 DeepSeek）
// 目的：用**你自己的 Key** 真正跑一次完整链路，回答三个问题：
//   1) 我的 Key / Base URL / 模型配好了吗？（配置解析 + 真实请求）
//   2) 模型能正确调用工具并跑完 Agent Loop 吗？
//   3) 「实时」视图里的思考/正文流式增量真的来自模型吗？
//
// 运行：
//   LLM_MODE=openai npm run smoke:llm                       # 用 .env 或环境变量里的配置
//   LLM_MODE=openai LLM_PROVIDER=deepseek DEEPSEEK_API_KEY=sk-xxx npm run smoke:llm
//   LLM_PROVIDER=openai OPENAI_API_KEY=sk-xxx npm run smoke:llm
//
// ⚠️ 会消耗真实 token（脚本里把步数/输出上限压到很小，单次通常只需几厘钱）。
// ⚠️ 脚本绝不打印 API Key。

import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';

interface Frame {
  type: string;
  seq?: number;
  ephemeral?: boolean;
  data?: Record<string, unknown>;
}

async function main(): Promise<number> {
  const config = loadConfig();
  if (config.llmMode !== 'openai') {
    console.error('[llm-smoke] 需要真实 LLM 模式：请设置 LLM_MODE=openai（可选 LLM_PROVIDER=deepseek）。');
    console.error('           当前 LLM_MODE=' + config.llmMode + '（mock 模式不会调用真实模型）');
    return 2;
  }
  config.stream.liveDeltas = true;

  const { app, store } = createApp(config);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;

  // 小型任务：让模型读取一个文件并给出结论（步数/输出上限都很小，控制花费）
  const body = {
    runType: 'codebase',
    goal: '读取 demo/codebase-sample/src/calc.js，用一句话说明 add 函数做了什么。',
    repoPath: resolve('demo/codebase-sample'),
    allowedTools: ['read_file', 'list_files'],
    maxSteps: 6,
    maxModelCalls: 6,
    maxToolCalls: 6,
    stream: { liveDeltas: true },
    llm: { params: { maxTokens: 1200, thinking: 'enabled', reasoningEffort: 'low' } },
  };

  const createRes = await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const created = (await createRes.json()) as any;
  if (!createRes.ok) {
    console.error('[llm-smoke] 创建任务失败:', created.error ?? createRes.status);
    await new Promise((r) => server.close(r));
    store.close();
    return 1;
  }

  console.log('[llm-smoke] 生效配置:', JSON.stringify(created.llm, null, 0));
  console.log('[llm-smoke] runId =', created.runId);

  const ac = new AbortController();
  const sse = await fetch(`${base}/api/runs/${created.runId}/stream`, {
    headers: { accept: 'text/event-stream' },
    signal: ac.signal,
  });
  const reader = (sse.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const frames: Frame[] = [];
  const reasoningBySpan = new Map<string, string>();
  const contentBySpan = new Map<string, string>();
  const t0 = Date.now();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const line = block.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let f: Frame;
      try {
        f = JSON.parse(line.slice(5).trim()) as Frame;
      } catch {
        continue;
      }
      frames.push(f);

      if (f.type === 'llm_delta') {
        const d = f.data as { spanId: string; channel: string; text: string };
        const target = d.channel === 'reasoning' ? reasoningBySpan : contentBySpan;
        target.set(d.spanId, (target.get(d.spanId) ?? '') + d.text);
      }
      if (f.type === 'tool_call_requested') {
        const d = f.data as { name: string; arguments: unknown };
        console.log(`  ↳ 调用工具: ${d.name} ${JSON.stringify(d.arguments).slice(0, 120)}`);
      }
      if (f.type === 'tool_completed' || f.type === 'tool_failed') {
        const d = f.data as any;
        console.log(
          `  ↳ 工具结束: ${d.name} [${f.type === 'tool_completed' ? 'ok' : d.code}] ${Math.round(d.durationMs ?? 0)}ms`,
        );
      }
      if (f.type === 'run_end') break;
    }
    if (frames.some((f) => f.type === 'run_end')) break;
  }
  ac.abort();
  const elapsed = Date.now() - t0;

  const result = (await (await fetch(`${base}/api/runs/${created.runId}`)).json()) as any;
  const deltas = frames.filter((f) => f.type === 'llm_delta');
  const reasoningChars = [...reasoningBySpan.values()].reduce((a, s) => a + s.length, 0);
  const contentChars = [...contentBySpan.values()].reduce((a, s) => a + s.length, 0);
  const ephemeral = frames.filter((f) => f.ephemeral).length;

  console.log('\n[llm-smoke] 结果');
  console.log('  status        :', result.status);
  console.log('  步骤/模型/工具:', `${result.steps} / ${result.modelCalls} / ${result.toolCalls}`);
  console.log('  tokens        :', JSON.stringify(result.usage));
  console.log('  总耗时        :', `${result.totalDurationMs}ms（SSE 观测 ${elapsed}ms）`);
  console.log('  流式增量      :', `${deltas.length} 帧（思考 ${reasoningChars} 字 / 正文 ${contentChars} 字，其中临时帧 ${ephemeral}）`);
  console.log('  最终答案      :', (result.finalAnswer ?? result.failureReason ?? '(空)').slice(0, 400));

  if (reasoningChars > 0) {
    const first = [...reasoningBySpan.values()][0] ?? '';
    console.log('  思考片段      :', first.slice(0, 160).replace(/\n/g, ' '));
  }

  const ok = result.status === 'completed' && deltas.length > 0;
  console.log(`\n[llm-smoke] 结论: ${ok ? '✅ 通过（真实模型跑通 Agent Loop，且产生流式增量）' : '❌ 失败（请检查 Key / Base URL / 模型名 / 参数）'}`);

  await new Promise((r) => {
    server.close(() => r(null));
    server.closeAllConnections?.();
  });
  store.close();
  return ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('[llm-smoke] 异常:', e);
    process.exit(2);
  });
