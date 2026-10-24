// src/codex/reasoningTap.ts — 旁路读取 Codex 会话 rollout 拿思考文本（best-effort）
//
// 非公开契约：`codex exec --json` 只给 reasoning_output_tokens，不给思考正文。
// 以 CODEX_HOME（默认 ~/.codex）下 sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl 为数据源，
// 增量轮询 response_item(type=reasoning) 的 content[].text。
import { closeSync, openSync, readSync, readdirSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CHUNK_BYTES = 512 * 1024;

export function resolveCodexHome(explicit?: string): string {
  const v = explicit?.trim() || process.env.CODEX_HOME?.trim();
  return v || join(homedir(), '.codex');
}

/** 找 sessions/YYYY/MM/DD 下匹配该 threadId 的 rollout 文件；失败返回 null。 */
export function findRollout(threadId: string, codexHome?: string): string | null {
  const root = join(resolveCodexHome(codexHome), 'sessions');
  const now = new Date();
  const days: string[] = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(now.getTime() - i * 86400_000);
    days.push(
      join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')),
    );
  }
  for (const day of days) {
    if (!existsSync(day)) continue;
    for (const f of readdirSync(day)) {
      if (f.includes(threadId) && f.endsWith('.jsonl')) return join(day, f);
    }
  }
  return null;
}

function extractReasoningText(line: string, sink: { text: string }): void {
  if (!line.includes('"type":"reasoning"')) return;
  try {
    const obj = JSON.parse(line);
    const payload = obj?.payload ?? obj;
    const content = Array.isArray(payload?.content) ? payload.content : [];
    for (const c of content) {
      if (c?.type === 'reasoning_text' && typeof c.text === 'string' && c.text.trim()) {
        sink.text += c.text;
      }
    }
  } catch {
    /* 单行容错：坏行跳过 */
  }
}

/**
 * 从指定偏移增量读取思考文本；只消费完整行，避免把半行算作已读。
 * 文件缺失/格式变化返回空文本（调用方据此降级，不影响任务）。
 */
export function readReasoning(
  threadId: string,
  opts: { codexHome?: string; fromBytes?: number; maxChars?: number } = {},
): { text: string; position: number } {
  const file = findRollout(threadId, opts.codexHome);
  if (!file) return { text: '', position: opts.fromBytes ?? 0 };
  try {
    const size = statSync(file).size;
    const from = Math.max(0, Math.min(opts.fromBytes ?? 0, size));
    if (size <= from) return { text: '', position: from };
    const len = Math.min(size - from, CHUNK_BYTES);
    const buf = Buffer.alloc(len);
    const fd = openSync(file, 'r');
    let read = 0;
    try {
      read = readSync(fd, buf, 0, len, from);
    } finally {
      closeSync(fd);
    }
    const chunk = buf.subarray(0, read).toString('utf8');
    const sink = { text: '' };
    let pos = from;
    let start = 0;
    let idx = chunk.indexOf('\n');
    while (idx >= 0) {
      extractReasoningText(chunk.slice(start, idx), sink);
      pos = from + idx + 1;
      start = idx + 1;
      idx = chunk.indexOf('\n', start);
    }
    const max = opts.maxChars ?? 60_000;
    return { text: sink.text.slice(0, max), position: pos };
  } catch {
    return { text: '', position: opts.fromBytes ?? 0 };
  }
}

/**
 * 轮询思考增量。`skipHistory=true`（续问）时从文件当前末尾开始，不重放历史思考。
 * 返回 stop()；调用方在 Codex 结束后停止，并补一次最终读取。
 */
export function startReasoningTap(opts: {
  threadId: string;
  codexHome?: string;
  skipHistory?: boolean;
  intervalMs?: number;
  maxChars?: number;
  onText: (text: string) => void;
}): { stop: () => void } {
  let position: number | null = null;
  let emitted = 0;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    if (position === null) {
      const file = findRollout(opts.threadId, opts.codexHome);
      if (!file) return;
      try {
        position = opts.skipHistory ? statSync(file).size : 0;
      } catch {
        return;
      }
    }
    const r = readReasoning(opts.threadId, {
      codexHome: opts.codexHome,
      fromBytes: position,
      maxChars: (opts.maxChars ?? 60_000) - emitted,
    });
    position = r.position;
    if (r.text) {
      emitted += r.text.length;
      opts.onText(r.text);
    }
  };
  const timer = setInterval(tick, Math.max(150, opts.intervalMs ?? 500));
  timer.unref?.();
  tick();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      tick();
    },
  };
}