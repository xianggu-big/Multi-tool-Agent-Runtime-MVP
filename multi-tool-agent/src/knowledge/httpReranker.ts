// src/knowledge/httpReranker.ts — HTTP cross-encoder reranker 适配器
//
// 为什么单独一个文件：真正的 cross-encoder（bge-reranker 等）在 Node 侧没有轻量运行时，
// 通常由一个本地 Python / ONNX 小服务提供打分。这里只做「协议适配」，不绑定具体模型：
//   POST {url}  {"query": "...", "passages": ["...", "..."]}  →  {"scores": [0.91, 0.02]}
//
// 失败策略：**fail-open** —— 打分服务不可用时退回 priorScore（融合先验）排序，
// 不让整个检索 500。RAG 是读路径，reranker 是可选增强，不是硬依赖。

import type { RerankCandidate, RerankedCandidate, Reranker } from './hybrid.js';

export interface HttpRerankerOptions {
  /** 例：http://127.0.0.1:8930/rerank */
  url: string;
  timeoutMs?: number;
  /** 是否把 title/heading 拼进 passage（默认拼，cross-encoder 受益于标题） */
  includeTitle?: boolean;
}

export class HttpReranker implements Reranker {
  readonly name = 'http-cross-encoder';
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly includeTitle: boolean;
  /** 最近一次调用是否降级（诊断用；bench 会读它） */
  degraded = false;

  constructor(opts: HttpRerankerOptions) {
    this.url = opts.url;
    this.timeoutMs = Math.max(500, opts.timeoutMs ?? 15_000);
    this.includeTitle = opts.includeTitle !== false;
  }

  async rerank(query: string, candidates: RerankCandidate[], topN?: number): Promise<RerankedCandidate[]> {
    const limit = Math.max(1, topN ?? candidates.length);
    if (!candidates.length) return [];
    const passages = candidates.map((c) => {
      const head = this.includeTitle ? [c.title, c.heading].filter(Boolean).join(' ') : '';
      return `${head} ${c.text}`.trim();
    });

    let scores: number[] | undefined;
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, passages }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.ok) {
        const json = (await res.json()) as { scores?: unknown };
        if (Array.isArray(json.scores) && json.scores.length === candidates.length) {
          scores = json.scores.map((x) => Number(x));
        }
      }
    } catch {
      /* 网络/超时：走降级分支 */
    }

    this.degraded = !scores;
    const toReranked = (c: RerankCandidate, score: number): RerankedCandidate => ({
      ...c,
      rerankScore: score,
      // 词法明细字段对 cross-encoder 无意义，统一填 0；prior 保留可解释性
      rerankDetails: { coverage: 0, bigram: 0, phrase: 0, title: 0, prior: c.priorScore ?? 0 },
    });

    const ranked = scores
      ? candidates.map((c, i) => toReranked(c, scores![i]))
      : candidates.map((c) => toReranked(c, c.priorScore ?? 0));
    return ranked.sort((a, b) => b.rerankScore - a.rerankScore).slice(0, limit);
  }
}
