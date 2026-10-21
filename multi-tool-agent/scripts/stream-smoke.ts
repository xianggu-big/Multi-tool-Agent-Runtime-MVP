// scripts/stream-smoke.ts — 实时流式链路冒烟 + 实测（开发调试用）
// 作用：在本机启动服务 → 提交一个 Mock 任务 → 以真实 SSE 客户端消费整条流，
//       打印每一帧的类型/间隔/服务端推送延迟，并在末尾给出统计（P50/P95/max）。
// 用途：① 验证「界面看到的东西」真的来自这条链路；② 排查「不流式/延迟高/收不到」时先跑它。
//
// 运行：npm run smoke:stream
// 可选环境变量：
//   SMOKE_CHUNK_DELAY_MS=20   演示分片延迟（毫秒）
//   SMOKE_SCENARIO=research-basic | codebase-basic
//   SMOKE_LIMIT=40            最多打印多少帧明细

import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { resolve } from 'node:path';

interface Rec {
  i: number;
  type: string;
  seq: number | string;
  recvMs: number;
  gapMs: number | null;
  pushMs: number | null;
  chars: number | null;
  note: string;
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function stats(label: string, values: number[]): void {
  if (!values.length) {
    console.log(`  ${label}: 无样本`);
    return;
  }
  const s = [...values].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  console.log(
    `  ${label}: n=${s.length} min=${s[0].toFixed(1)} p50=${pct(s, 50).toFixed(1)} p95=${pct(s, 95).toFixed(1)} max=${s[s.length - 1].toFixed(1)} avg=${(sum / s.length).toFixed(1)} (ms)`,
  );
}

async function main(): Promise<number> {
  const chunkDelay = Number(process.env.SMOKE_CHUNK_DELAY_MS ?? 20);
  const scenario = process.env.SMOKE_SCENARIO ?? 'research-basic';
  const printLimit = Number(process.env.SMOKE_LIMIT ?? 40);

  const config = loadConfig();
  config.stream.liveDeltas = true;
  config.stream.mockChunkDelayMs = Number.isFinite(chunkDelay) ? chunkDelay : 20;
  config.stream.heartbeatMs = 2000;
  config.stream.watchdogMs = 500;

  const { app, store } = createApp(config);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;

  console.log(`[smoke] 服务已启动 ${base}  liveDeltas=${config.stream.liveDeltas} chunkDelay=${config.stream.mockChunkDelayMs}ms`);

  const body: Record<string, unknown> = {
    runType: scenario === 'codebase-basic' ? 'codebase' : 'research',
    goal: '实时流式冒烟测试',
    mockScenario: scenario,
    stream: { liveDeltas: true },
  };
  if (scenario === 'codebase-basic') body.repoPath = resolve('demo/codebase-sample');

  const createRes = await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!createRes.ok) {
    console.error('[smoke] 创建任务失败:', createRes.status, await createRes.text());
    server.close();
    store.close();
    return 1;
  }
  const { runId } = await createRes.json();
  console.log(`[smoke] runId=${runId}`);

  const ac = new AbortController();
  const sseRes = await fetch(`${base}/api/runs/${runId}/stream?debug=1`, {
    headers: { accept: 'text/event-stream' },
    signal: ac.signal,
  });
  console.log(`[smoke] SSE 状态=${sseRes.status} content-type=${sseRes.headers.get('content-type')}`);

  const reader = (sseRes.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const t0 = performance.now();
  const recs: Rec[] = [];
  let buf = '';
  let i = 0;
  let prevRecv: number | null = null;
  let ended = false;

  while (!ended) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue; // 心跳/注释帧
      let f: any;
      try {
        f = JSON.parse(dataLine.slice(5).trim());
      } catch {
        continue;
      }
      i += 1;
      const recvMs = performance.now() - t0;
      recs.push({
        i,
        type: f.type,
        seq: f.ephemeral ? '临时' : (f.seq ?? '-'),
        recvMs,
        gapMs: prevRecv == null ? null : recvMs - prevRecv,
        pushMs: typeof f._pushDelayMs === 'number' ? f._pushDelayMs : null,
        chars: f.data && typeof f.data.text === 'string' ? f.data.text.length : null,
        note: f.data && f.data.name ? String(f.data.name) : f.type === 'run_end' ? String(f.status) : '',
      });
      prevRecv = recvMs;
      if (f.type === 'run_end') {
        ended = true;
        break;
      }
    }
  }
  ac.abort();

  const shown = recs.slice(0, printLimit);
  console.log('\n[smoke] 帧明细（前 %d 帧 / 共 %d 帧）：', shown.length, recs.length);
  console.log('  #   recv(ms)   gap(ms)  push(ms)  seq    type                 备注');
  for (const r of shown) {
    console.log(
      `  ${String(r.i).padStart(3)} ${r.recvMs.toFixed(1).padStart(9)} ${(r.gapMs == null ? '-' : r.gapMs.toFixed(1)).padStart(8)} ${(r.pushMs == null ? '-' : r.pushMs.toFixed(0)).padStart(8)}  ${String(r.seq).padStart(5)}  ${r.type.padEnd(20)} ${r.note}`,
    );
  }
  if (recs.length > shown.length) console.log(`  …（省略 ${recs.length - shown.length} 帧）`);

  const gaps = recs.map((r) => r.gapMs).filter((v): v is number => v != null);
  const pushes = recs.map((r) => r.pushMs).filter((v): v is number => v != null);
  const deltas = recs.filter((r) => r.type === 'llm_delta');

  console.log('\n[smoke] 统计：');
  console.log(`  总帧数=${recs.length}  文本增量帧=${deltas.length}  时长=${(performance.now() - t0).toFixed(0)}ms`);
  stats('帧间隔(客户端)', gaps);
  stats('产生→推送(服务端)', pushes);

  const last = recs[recs.length - 1];
  const ok = !!last && last.type === 'run_end' && deltas.length > 0;
  console.log(`\n[smoke] 结论: ${ok ? '✅ 通过（收到文本增量 + 终态 run_end）' : '❌ 失败（未收到文本增量或 run_end）'}`);

  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  store.close();
  return ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('[smoke] 异常:', e);
    process.exit(2);
  });
