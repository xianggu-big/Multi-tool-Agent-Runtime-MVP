// tests/60_extract_evidence.test.ts — 证据提取的输入健壮性
//
// 背景：模型经常把 web_search / fetch_page 的 JSON 结果原样塞进 extract_evidence。
// 旧实现按句子切分，会把 JSON 切成 `{"ok":true,"data":...` 这样的碎片，
// 在 Research 演示里表现为「证据是一堆 JSON 碎片」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEvidence, toReadableText } from '../src/tools/research/extractEvidence.js';
import { makeCtx } from './helpers.js';

const ctx = makeCtx({ runType: 'research', allowedPermissions: ['research:read'] });

const searchPayload = JSON.stringify({
  ok: true,
  data: {
    query: '比较 esbuild 与 Rollup',
    results: [
      {
        title: 'esbuild - An extremely fast bundler',
        url: 'https://esbuild.github.io/',
        snippet: 'esbuild 是一个用 Go 编写的极快 JavaScript 打包器，以并行化著称。',
      },
      {
        title: 'Rollup - The JavaScript module bundler',
        url: 'https://rollupjs.org/',
        snippet: 'Rollup 擅长 Tree-shaking，广泛用于库与生产构建。',
      },
    ],
  },
});

test('60a) 结构化搜索结果先转可读文本，不再把 JSON 切碎', () => {
  const readable = toReadableText(searchPayload);
  assert.ok(readable.includes('esbuild 是一个用 Go 编写的极快 JavaScript 打包器'));
  assert.ok(readable.includes('Rollup 擅长 Tree-shaking'));
  assert.ok(!readable.includes('{"ok"'), '原始 JSON 结构不应出现在可读文本里');
  assert.ok(!readable.includes('https://esbuild.github.io/'), 'URL 不是证据正文，应被过滤');

  const res = extractEvidence.execute({ text: searchPayload, question: 'esbuild 与 Rollup 的定位差异' }, ctx) as any;
  assert.equal(res.ok, true);
  const claims = res.data.evidence.map((e: any) => e.claim).join('\n');
  assert.ok(claims.includes('极快 JavaScript 打包器'));
  assert.ok(claims.includes('Tree-shaking'));
  assert.ok(!claims.includes('{"ok"'), '证据里不应出现 JSON 碎片');
});

test('60b) 普通纯文本行为不变：只保留命中关键词的句子', () => {
  const text = '无关内容。\nRollup 擅长 Tree-shaking，适合库打包。\n今天天气不错。';
  const res = extractEvidence.execute({ text, question: 'Rollup 打包' }, ctx) as any;
  assert.equal(res.ok, true);
  assert.equal(res.data.evidence.length, 1);
  assert.ok(res.data.evidence[0].claim.includes('Tree-shaking'));
});

test('60c) 畸形 JSON 回退原文，不崩也不吞输入', () => {
  const broken = '{not valid json';
  assert.equal(toReadableText(broken), broken);
  const res = extractEvidence.execute({ text: broken, question: 'not valid' }, ctx) as any;
  assert.equal(res.ok, true);
  assert.ok(Array.isArray(res.data.evidence));
});

test('60d) 顶层数组、嵌套对象与 URL-only 字符串都能安全处理', () => {
  const raw = JSON.stringify([
    'https://example.invalid/only-a-url',
    { snippet: '有效的片段内容足够长，可以被当作证据。' },
    { nested: { description: '嵌套字段里的描述也应被收集。' } },
  ]);
  const readable = toReadableText(raw);
  assert.ok(!readable.includes('http'), '纯 URL 不应进入正文');
  assert.ok(readable.includes('有效的片段内容足够长'));
  assert.ok(readable.includes('嵌套字段里的描述'));
});