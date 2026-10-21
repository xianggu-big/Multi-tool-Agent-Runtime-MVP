// src/tools/research/webSearch.ts — 公开资料检索
// 真实 Provider：Serper（需要 SEARCH_API_KEY）。无 Key 时回退到明确标注的离线资料 Provider（OFFLINE_MOCK），
// 绝不把离线结果伪装成实时联网搜索。

import { z } from 'zod';
import type { Tool, ToolContext } from '../types.js';
import type { ToolResult } from '../../types.js';
import { okResult, errResult } from '../types.js';

const inputSchema = z.object({
  query: z.string().min(1).describe('检索关键词'),
  limit: z.number().int().min(1).max(20).default(8).describe('返回结果数量'),
});

interface OfflineEntry {
  title: string;
  url: string;
  snippet: string;
  tags: string[];
}

// 离线资料库（明确标注为 MOCK，非实时搜索结果，仅供演示与测试）。
const OFFLINE_DATA: OfflineEntry[] = [
  {
    title: 'esbuild - An extremely fast bundler',
    url: 'https://esbuild.github.io/',
    snippet:
      'esbuild 是一个用 Go 编写的极快 JavaScript/TypeScript 打包器与压缩器，以并行化与无缓存默认配置著称，常用于库打包与开发服务器底层。',
    tags: ['bundler', 'esbuild', 'go'],
  },
  {
    title: 'Rollup - The JavaScript module bundler',
    url: 'https://rollupjs.org/',
    snippet:
      'Rollup 是面向 ES 模块的打包器，擅长 Tree-shaking，广泛用于库与生产构建；基于插件体系，输出更精简的 ESM/CJS 包。',
    tags: ['bundler', 'rollup', 'esm'],
  },
  {
    title: 'Vite - Next Generation Frontend Tooling',
    url: 'https://vite.dev/',
    snippet:
      'Vite 是前端构建工具，开发期基于原生 ESM 与 esbuild 做依赖预构建，生产构建默认使用 Rollup，强调快速冷启动与热更新。',
    tags: ['vite', 'bundler', 'dev-server'],
  },
  {
    title: 'webpack - A static module bundler',
    url: 'https://webpack.js.org/',
    snippet:
      'webpack 是历史悠久的模块打包器，配置灵活、loader/plugin 生态庞大，支持代码分割与按需加载，学习曲线较陡。',
    tags: ['webpack', 'bundler'],
  },
  {
    title: 'TypeScript - JavaScript with syntax for types',
    url: 'https://www.typescriptlang.org/',
    snippet:
      'TypeScript 是微软推出的 JavaScript 超集，提供静态类型与编译期检查，编译器可将 .ts 编译为 .js，由 tsc 驱动。',
    tags: ['typescript', 'compiler'],
  },
  {
    title: 'Babel - A JavaScript compiler',
    url: 'https://babeljs.io/',
    snippet:
      'Babel 是 JavaScript 编译器，主要用于将新语法转译到旧环境，插件化管线支持语法转换与 polyfill。',
    tags: ['babel', 'compiler', 'transpiler'],
  },
];

function offlineSearch(query: string, limit: number) {
  const q = query.toLowerCase();
  const scored = OFFLINE_DATA.map((e) => {
    const hit = e.tags.some((t) => q.includes(t)) || q.includes(e.title.toLowerCase()) || e.snippet.toLowerCase().includes(q);
    return { e, hit };
  });
  const matched = scored.filter((s) => s.hit).map((s) => s.e);
  const pool = matched.length ? matched : OFFLINE_DATA;
  return pool.slice(0, limit);
}

async function serperSearch(query: string, limit: number, apiKey: string, baseUrl: string): Promise<OfflineEntry[]> {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-KEY': apiKey },
    body: JSON.stringify({ q: query, num: limit }),
  });
  if (!res.ok) {
    throw new Error(`Serper 返回 ${res.status}`);
  }
  const json = (await res.json()) as any;
  const organic = json.organic ?? [];
  return organic.slice(0, limit).map((o: any) => ({
    title: o.title ?? '',
    url: o.link ?? '',
    snippet: o.snippet ?? '',
    tags: [],
  }));
}

export const webSearch: Tool = {
  name: 'web_search',
  description: '调用搜索 Provider 检索公开资料，返回标题/URL/摘要。无 API Key 时回退到明确标注的离线资料（OFFLINE_MOCK）。',
  inputSchema,
  timeoutMs: 12000,
  permission: 'research:web',
  riskLevel: 'low',
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const started = Date.now();
    const args = input as z.infer<typeof inputSchema>;
    const { provider, apiKey, baseUrl } = ctx.config.search;

    if (provider === 'serper' && apiKey) {
      try {
        const results = await serperSearch(args.query, args.limit, apiKey, baseUrl);
        return okResult(
          { query: args.query, results, provider: 'serper', mock: false },
          Date.now() - started,
        );
      } catch (e) {
        // 真实 Provider 失败时明确报错（不静默伪装成离线成功）
        return errResult('SEARCH_ERROR', `真实搜索失败: ${(e as Error).message}`, Date.now() - started);
      }
    }

    // 离线资料（明确标注为 MOCK）
    const results = offlineSearch(args.query, args.limit);
    return okResult(
      {
        query: args.query,
        results: results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
        provider: 'OFFLINE_MOCK',
        mock: true,
        note: 'OFFLINE_MOCK：这是离线资料，不是实时联网搜索结果。配置 SEARCH_API_KEY 与 SEARCH_PROVIDER=serper 可启用真实搜索。',
      },
      Date.now() - started,
    );
  },
};
