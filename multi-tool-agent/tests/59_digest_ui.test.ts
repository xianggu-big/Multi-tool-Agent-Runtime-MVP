// tests/59_digest_ui.test.ts — 复盘/压缩前端接线回归（静态解析，不启动浏览器）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? '';

test('59a) 前端有「复盘」页签与筛选/详情/压缩观测区域', () => {
  assert.match(html, /data-tab="digest"/);
  assert.match(html, /id="tab-digest"/);
  for (const id of ['digestScope', 'digestStatus', 'digestRunType', 'digestLimit', 'digestRefresh', 'digestCurrentBtn', 'digestList', 'digestDetail']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /压缩观测/);
  assert.match(html, /本 run 未触发/);
});

test('59b) 前端走既有 digest API，并渲染 compaction 观测字段', () => {
  assert.match(script, /\/api\/digests\?/);
  assert.match(script, /\/digest'/);
  assert.match(script, /compaction/);
  assert.match(script, /maxWatermark/);
  assert.match(script, /watermarkSources/);
  assert.match(script, /context_compacted/);
  assert.match(script, /run_digest/);
});

test('59c) public/index.html 的内联脚本仍可被 JS 解析', () => {
  assert.ok(script.length > 1000, '应找到完整内联脚本');
  assert.doesNotThrow(() => new Function(script));
});

test('59d) 实时渲染有防卡死上限：跳过 llm_delta、事件 500 条、增量追加与滚动节流', () => {
  assert.match(script, /if \(e\.type === 'llm_delta'\) return/);
  assert.match(script, /MAX_EVENT_NODES\s*=\s*500/);
  assert.match(script, /function appendChannel/);
  assert.match(script, /function scheduleScrollBottom/);
  assert.match(html, /content-visibility:\s*auto/);
});
