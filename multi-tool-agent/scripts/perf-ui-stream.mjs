#!/usr/bin/env node
// scripts/perf-ui-stream.mjs — 长流式输出的浏览器主线程开销量化（需本机 Edge/Chrome）
//
// 为什么需要它：P0-3 之前只有“结构性回归”（测试断言页面里有上限/节流），没有真实浏览器数字。
// 本脚本用真实 public/index.html + 真实 SSE/EventSource 路径，灌入一段长增量事件，
// 通过 CDP 读取 Performance 指标与 longtask/rAF 数据，回答“画面会不会被渲染打满”。
//
// 用法：
//   npm run perf:stream-ui
//   npm run perf:stream-ui -- --events=20000
//   npm run perf:stream-ui -- --html=%TEMP%\old-index.html --label=before
//   npm run perf:stream-ui -- --max-blocking-ms=3000   # 可选门禁（默认只报告）
//
// 边界：这是“事件一次性到达”的追赶（catch-up）最坏情况，不是稳态吞吐；
//       headless 与真实桌面浏览器仍有差异，数字用于同机对照，不跨设备外推。

import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function arg(name, fallback) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf('=');
  return eq >= 0 ? hit.slice(eq + 1) : true;
}

const EVENTS = Math.max(1, Number(arg('events', 6000)) || 6000);
const GAP_MS = Math.max(0, Number(arg('gap-ms', 0)) || 0);
const CHUNK_CHARS = Math.max(1, Number(arg('chunk-chars', 24)) || 24);
const LABEL = String(arg('label', 'current'));
const HTML_PATH = resolve(String(arg('html', join(import.meta.dirname, '..', 'public', 'index.html'))));
const TIMEOUT_MS = Math.max(5000, Number(arg('timeout-ms', 120000)) || 120000);
const MAX_BLOCKING_MS = Number(arg('max-blocking-ms', 0)) || 0;
const HEADLESS = String(arg('headless', 'true')) !== 'false';

const BROWSER_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].filter(Boolean);

function findBrowser() {
  for (const p of BROWSER_CANDIDATES) if (existsSync(p)) return p;
  throw new Error('未找到 Edge/Chrome。可用 EDGE_PATH 指定浏览器路径。');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeEvents() {
  const runId = 'perf-run';
  const now = () => new Date().toISOString();
  const frames = [];
  frames.push({ runId, seq: 1, type: 'run_started', timestamp: now(), data: { inputs: { goal: 'perf-ui-stream', runType: 'misc' } } });
  frames.push({
    runId, seq: 0, ephemeral: true, type: 'model_request', timestamp: now(),
    data: { spanId: 'perf-span', step: 1, name: 'mock' },
  });
  for (let i = 0; i < EVENTS; i += 1) {
    const text = `chunk-${i.toString().padStart(6, '0')}-` + 'x'.repeat(Math.max(0, CHUNK_CHARS - 14));
    frames.push({
      runId, seq: 0, ephemeral: true, type: 'llm_delta', timestamp: now(),
      data: { spanId: 'perf-span', channel: 'content', text },
    });
  }
  frames.push({
    runId, seq: 0, ephemeral: true, type: 'model_completed', timestamp: now(),
    data: { spanId: 'perf-span', durationMs: 1, outputs: { stopReason: 'end_turn', toolNames: [], contentPreview: 'done' } },
  });
  frames.push({
    runId, seq: 2, type: 'run_completed', timestamp: now(),
    data: { status: 'completed', outputs: { finalAnswer: 'done' } },
  });
  return frames;
}

function startHarness(html) {
  const events = makeEvents();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const json = (body) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }
    if (url.pathname === '/api/runs/perf-run/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 1000\n\n');
      res.write(`data: ${JSON.stringify({ type: '_stream_meta', runId: 'perf-run', liveDeltas: true })}\n\n`);
      // 等客户端把 onmessage 装好，再按 burst / gap 发送。
      setTimeout(() => {
        let i = 0;
        const pump = () => {
          if (res.writableEnded) return;
          if (GAP_MS === 0) {
            // burst：一次写入全部帧，模拟“切回标签页后一次性补发”的最坏追赶。
            while (i < events.length) res.write(`data: ${JSON.stringify(events[i++])}\n\n`);
            res.end();
            return;
          }
          const start = Date.now();
          res.write(`data: ${JSON.stringify(events[i++])}\n\n`);
          if (i >= events.length) {
            res.end();
            return;
          }
          setTimeout(pump, Math.max(0, GAP_MS - (Date.now() - start)));
        };
        pump();
      }, 80);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/runs') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(201, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          runId: 'perf-run',
          llm: { presetId: 'mock', presetLabel: 'Mock', model: 'perf-model', params: {} },
        }));
      });
      return;
    }
    if (req.method === 'POST') {
      req.resume();
      json({ ok: true });
      return;
    }
    json({});
  });
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => resolveServer({ server, port: server.address().port }));
  });
}

async function waitForDevtools(userDataDir, timeoutMs = 20000) {
  const file = join(userDataDir, 'DevToolsActivePort');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const text = await readFile(file, 'utf8');
      const [port, path] = text.trim().split('\n');
      if (port && path) return { port: Number(port), browserWsPath: path };
    } catch { /* not ready */ }
    await sleep(100);
  }
  throw new Error('浏览器未在超时内开启 DevTools 端口');
}

async function getJson(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!res.ok) throw new Error(`CDP ${path} -> ${res.status}`);
  return res.json();
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.ws = null;
  }
  async open() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((ok, fail) => {
      this.ws.addEventListener('open', ok, { once: true });
      this.ws.addEventListener('error', (e) => fail(new Error(`WebSocket 失败: ${e.message ?? 'error'}`)), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { ok, fail, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) fail(new Error(msg.error.message ?? 'CDP error'));
        else ok(msg.result);
      }
    });
  }
  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new Error(`CDP ${method} 超时 ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { ok, fail, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression, timeoutMs = 30000) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text ?? '页面脚本异常');
    return res.result?.value;
  }
  close() {
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}

function diffMetrics(before, after) {
  const map = (arr) => Object.fromEntries((arr ?? []).map((m) => [m.name, m.value]));
  const a = map(before.metrics);
  const b = map(after.metrics);
  const d = (k) => Math.max(0, (b[k] ?? 0) - (a[k] ?? 0));
  return {
    taskDurationMs: d('TaskDuration') * 1000,
    scriptDurationMs: d('ScriptDuration') * 1000,
    layoutDurationMs: d('LayoutDuration') * 1000,
    styleDurationMs: d('RecalcStyleDuration') * 1000,
    heapUsedBytes: Math.max(0, (b.JSHeapUsedSize ?? 0) - (a.JSHeapUsedSize ?? 0)),
    nodes: Math.max(0, (b.Nodes ?? 0) - (a.Nodes ?? 0)),
  };
}

const html = await readFile(HTML_PATH, 'utf8');
const browserPath = findBrowser();
const userDataDir = await mkdtemp(join(tmpdir(), 'mta-perf-'));
const { server, port } = await startHarness(html);
const base = `http://127.0.0.1:${port}/`;
const browser = spawn(browserPath, [
  HEADLESS ? '--headless=new' : '--new-window',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--window-size=1400,900',
  '--remote-debugging-port=0',
  `--user-data-dir=${userDataDir}`,
  base,
], { stdio: 'ignore' });

let cdp;
let result;
let failure;
try {
  const { port: debugPort } = await waitForDevtools(userDataDir);
  let targets = [];
  for (let i = 0; i < 100; i += 1) {
    targets = await getJson(debugPort, '/json/list');
    if (targets.some((t) => t.type === 'page' && String(t.url).startsWith(base))) break;
    await sleep(100);
  }
  const page = targets.find((t) => t.type === 'page' && String(t.url).startsWith(base)) ?? targets.find((t) => t.type === 'page');
  if (!page?.webSocketDebuggerUrl) throw new Error('找不到页面 target');
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Performance.enable');

  for (let i = 0; i < 100; i += 1) {
    const ready = await cdp.eval("document.readyState === 'complete' && !!document.querySelector('#startBtn')");
    if (ready) break;
    await sleep(100);
  }

  await cdp.eval(`(() => {
    window.__perf = { longTasks: 0, blockingMs: 0, maxLongTaskMs: 0, frames: 0, maxFrameGapMs: 0, gaps: [] };
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__perf.longTasks += 1;
          window.__perf.blockingMs += Math.max(0, e.duration - 50);
          window.__perf.maxLongTaskMs = Math.max(window.__perf.maxLongTaskMs, e.duration);
        }
      }).observe({ type: 'longtask', buffered: true });
    } catch { /* 浏览器不支持 longtask：仍可看 rAF 与 Performance 指标 */ }
    let last = 0;
    const tick = (t) => {
      if (last) {
        const gap = t - last;
        window.__perf.frames += 1;
        window.__perf.maxFrameGapMs = Math.max(window.__perf.maxFrameGapMs, gap);
        window.__perf.gaps.push(gap);
      }
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`);

  const before = await cdp.send('Performance.getMetrics');
  const clickedAt = Date.now();
  await cdp.eval(`(() => {
    const goal = document.querySelector('#goal');
    if (goal) { goal.value = 'perf-ui-stream'; goal.dispatchEvent(new Event('input', { bubbles: true })); }
    const btn = document.querySelector('#startBtn');
    if (!btn) throw new Error('缺少 #startBtn');
    btn.click();
  })()`);

  let phase = '';
  while (Date.now() - clickedAt < TIMEOUT_MS) {
    try {
      phase = await cdp.eval("document.querySelector('#livePhase')?.textContent || ''", 5000);
      if (phase === '已完成' || phase === '已结束') break;
    } catch { /* 主线程被占满时会超时，继续等 */ }
    await sleep(100);
  }
  const elapsedMs = Date.now() - clickedAt;
  const after = await cdp.send('Performance.getMetrics');
  const perf = await cdp.eval(`(() => {
    const p = window.__perf;
    const sorted = [...p.gaps].sort((a, b) => a - b);
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
    return {
      longTasks: p.longTasks, blockingMs: p.blockingMs, maxLongTaskMs: p.maxLongTaskMs,
      frames: p.frames, maxFrameGapMs: p.maxFrameGapMs, p95FrameGapMs: p95,
      domTextChars: document.body.innerText.length,
      cardCount: document.querySelectorAll('.lcard').length,
    };
  })()`);

  result = {
    label: LABEL,
    events: EVENTS,
    gapMs: GAP_MS,
    chunkChars: CHUNK_CHARS,
    status: phase || 'timeout',
    clickToDoneMs: elapsedMs,
    ...diffMetrics(before, after),
    ...perf,
  };
} catch (e) {
  failure = e;
} finally {
  cdp?.close();
  try { browser.kill(); } catch { /* ignore */ }
  server.close();
  await sleep(100);
  try { await rm(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (failure) {
  console.error(`[perf] 失败：${failure.message}`);
  process.exit(1);
}

console.log(`[perf] ${result.label}: ${result.events} 个增量 / 间隔 ${result.gapMs}ms / 每片 ${result.chunkChars} 字符`);
console.log(`  ${result.status} 用时 ${result.clickToDoneMs.toFixed(0)}ms · 主线程 Task ${result.taskDurationMs.toFixed(0)}ms · JS ${result.scriptDurationMs.toFixed(0)}ms · Layout ${result.layoutDurationMs.toFixed(0)}ms · Style ${result.styleDurationMs.toFixed(0)}ms`);
console.log(`  longtask ${result.longTasks} 次 / 阻塞 ${result.blockingMs.toFixed(0)}ms / 最长 ${result.maxLongTaskMs.toFixed(0)}ms`);
console.log(`  帧 ${result.frames} · 最大帧间隔 ${result.maxFrameGapMs.toFixed(0)}ms · P95 ${result.p95FrameGapMs.toFixed(1)}ms · 卡片 ${result.cardCount} · 文本 ${result.domTextChars} 字符 · 堆 +${(result.heapUsedBytes / 1024 / 1024).toFixed(1)}MB`);
console.log(`  JSON ${JSON.stringify(result)}`);

if (result.status === 'timeout') {
  console.error(`[perf] 页面在 ${TIMEOUT_MS}ms 内未完成渲染（视为卡死/极慢）。`);
  process.exit(2);
}
if (MAX_BLOCKING_MS > 0 && result.blockingMs > MAX_BLOCKING_MS) {
  console.error(`[perf] 阻塞 ${result.blockingMs.toFixed(0)}ms 超过阈值 ${MAX_BLOCKING_MS}ms`);
  process.exit(3);
}
