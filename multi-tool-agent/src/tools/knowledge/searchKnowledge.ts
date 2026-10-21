// src/tools/knowledge/searchKnowledge.ts — 切块级 RAG 检索工具
//
// 这是「RAG 管线」和「Agent Loop」之间的唯一桥：模型通过 function calling 选择
// knowledge_search，工具内部走 BM25 + 向量 + RRF/rerank，返回带来源的 chunk。
import { z } from 'zod';
import type { KnowledgeHub } from '../../knowledge/index.js';
import { errResult, okResult, type Tool } from '../types.js';

const MODES = ['keyword', 'vector', 'hybrid', 'hybrid_weighted', 'hybrid_rerank'] as const;

const inputSchema = z.object({
  query: z.string().min(1).max(2000).describe('要检索的问题或关键词'),
  mode: z.enum(MODES).optional().describe('检索模式，默认 hybrid_rerank'),
  k: z.number().int().min(1).max(20).optional().describe('返回条数，默认 5'),
  collection: z.string().min(1).max(200).optional().describe('可选：限定知识库 collection'),
});

export interface KnowledgeSearchToolOptions {
  timeoutMs?: number;
}

export function createKnowledgeSearchTool(
  knowledge: KnowledgeHub | undefined,
  opts: KnowledgeSearchToolOptions = {},
): Tool {
  return {
    name: 'knowledge_search',
    description:
      '在知识库中做切块级混合检索（BM25 关键词 + 向量召回 + RRF/rerank），返回带 docId/chunkIndex 的来源片段。' +
      '适合回答“资料里怎么说/文档中如何规定”这类需要引用的问题。',
    inputSchema,
    inputExample: { query: '审批超时怎么处理', mode: 'hybrid_rerank', k: 5 },
    timeoutMs: opts.timeoutMs ?? 30_000,
    permission: 'knowledge:read',
    riskLevel: 'safe',
    execute: async (raw) => {
      const started = Date.now();
      const input = raw as { query: string; mode?: (typeof MODES)[number]; k?: number; collection?: string };
      if (!knowledge) {
        return errResult('KNOWLEDGE_UNAVAILABLE', '知识库未装配（当前 Registry 没有 KnowledgeHub）', 0);
      }
      try {
        const result = await knowledge.searchRag(input.query, {
          mode: input.mode,
          k: input.k,
          filter: input.collection ? (m) => m.collection === input.collection : undefined,
        });
        return okResult(
          {
            query: result.query,
            mode: result.mode,
            count: result.results.length,
            hits: result.results.map((h) => ({
              chunkId: h.chunkId,
              docId: h.docId,
              title: h.title,
              heading: h.heading,
              chunkIndex: h.chunkIndex,
              score: h.normalizedScore,
              sources: h.sources,
              text: h.text.slice(0, 4000),
            })),
            latencyMs: result.latencyMs,
            timings: result.timings,
          },
          Date.now() - started,
        );
      } catch (e) {
        return errResult(
          'KNOWLEDGE_SEARCH_FAILED',
          `知识库检索失败：${e instanceof Error ? e.message : String(e)}`,
          Date.now() - started,
          { retryable: true },
        );
      }
    },
  };
}