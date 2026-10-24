// src/knowledge/embeddings.ts — embedding 模型注册表 + 归一化 + 远程批量嵌入
//
// 本项目默认用 HashEmbedder（离线、确定性、零依赖），它捕获的是词法/字符 n-gram 重叠，
// **不是真正的语义向量**。生产环境应换成下面注册表中的真实模型：
//   - 中文/中英混合、私有化：BAAI/bge-small-zh-v1.5（512 维）或 BAAI/bge-m3（1024 维）；
//   - 走 API、通用多语言：text-embedding-3-small（1536 维）/ -large（3072 维）；
//   - 本地长上下文：Qwen3-Embedding-0.6B（1024 维）或 nomic-embed-text-v1.5（768 维）。
//
// 维度不是越大越好：维度↑ → 表达力↑、存储/带宽/延迟↑。先用 512~1024 维做基线，
// 只有在评测集上召回确实不够时才升维。归一化后余弦相似度 = 点积，索引实现也更简单。

import { HashEmbedder, type Embedder } from './vectorRecall.js';

export interface AsyncEmbedder {
  readonly name: string;
  readonly dim: number;
  /** 批量嵌入；顺序必须与输入一致。 */
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

export interface EmbeddingModelSpec {
  id: string;
  provider: string;
  /** 默认输出维度 */
  dim: number;
  /** 单条输入上限（token） */
  maxInputTokens: number;
  /** 输出是否天然单位长度（仍建议显式归一化，避免厂商实现差异） */
  normalized: boolean;
  multilingual: boolean;
  /** 支持的 Matryoshka 截断维度（如有） */
  matryoshka?: number[];
  notes: string;
}

export const EMBEDDING_MODELS: Record<string, EmbeddingModelSpec> = {
  'hash-ngram-256': {
    id: 'hash-ngram-256',
    provider: 'built-in',
    dim: 256,
    maxInputTokens: 8192,
    normalized: true,
    multilingual: false,
    notes: '离线确定性哈希向量（词 + 3-gram），只适合测试/降级，不是语义模型。',
  },
  'bge-small-zh-v1.5': {
    id: 'bge-small-zh-v1.5',
    provider: 'BAAI',
    dim: 512,
    maxInputTokens: 512,
    normalized: true,
    multilingual: true,
    notes: '中文优先的小模型，CPU 可跑，适合作为私有化基线；长文需先切块。',
  },
  'bge-m3': {
    id: 'bge-m3',
    provider: 'BAAI',
    dim: 1024,
    maxInputTokens: 8192,
    normalized: true,
    multilingual: true,
    notes: '多语言、长上下文，支持 dense/sparse/colbert 多向量；资源占用高于 small。',
  },
  'text-embedding-3-small': {
    id: 'text-embedding-3-small',
    provider: 'OpenAI-compatible',
    dim: 1536,
    maxInputTokens: 8191,
    normalized: true,
    multilingual: true,
    matryoshka: [256, 512, 1024, 1536],
    notes: 'API 通用基线，性价比高；可用 dimensions 降到 512/1024 省存储。',
  },
  'text-embedding-3-large': {
    id: 'text-embedding-3-large',
    provider: 'OpenAI-compatible',
    dim: 3072,
    maxInputTokens: 8191,
    normalized: true,
    multilingual: true,
    matryoshka: [256, 1024, 3072],
    notes: '更高精度、更高成本；通常先试 small，评测不够再升。',
  },
  'qwen3-embedding-0.6b': {
    id: 'qwen3-embedding-0.6b',
    provider: 'Alibaba/Qwen',
    dim: 1024,
    maxInputTokens: 32768,
    normalized: true,
    multilingual: true,
    matryoshka: [32, 64, 128, 256, 512, 768, 1024],
    notes: '本地可部署的多语言长上下文模型，适合代码/文档混合库。',
  },
  'nomic-embed-text-v1.5': {
    id: 'nomic-embed-text-v1.5',
    provider: 'Nomic',
    dim: 768,
    maxInputTokens: 8192,
    normalized: true,
    multilingual: false,
    matryoshka: [64, 128, 256, 512, 768],
    notes: '英文长文、本地部署友好；中文场景优先 BGE/Qwen。',
  },
};

export function getEmbeddingModel(id: string): EmbeddingModelSpec {
  const spec = EMBEDDING_MODELS[id];
  if (!spec) {
    const known = Object.keys(EMBEDDING_MODELS).join(', ');
    throw new Error(`未知 embedding 模型 ${id}；可选：${known}`);
  }
  return spec;
}

/** L2 归一化（原地修改并返回同一数组）。零向量保持为零。 */
export function l2Normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < v.length; i++) v[i] /= norm;
  }
  return v;
}

export function isL2Normalized(v: Float32Array, eps = 1e-4): boolean {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  return Math.abs(Math.sqrt(norm) - 1) <= eps;
}

export function dot(a: Float32Array, b: Float32Array): number {
  assertSameDim(a, b, 'dot');
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  assertSameDim(a, b, 'cosineSimilarity');
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  if (aa === 0 || bb === 0) return 0;
  return ab / Math.sqrt(aa * bb);
}

export function assertDim(v: Float32Array, dim: number, label = 'embedding'): void {
  if (v.length !== dim) {
    throw new Error(`${label} 维度不匹配：期望 ${dim}，实际 ${v.length}`);
  }
}

function assertSameDim(a: Float32Array, b: Float32Array, label: string): void {
  if (a.length !== b.length) throw new Error(`${label} 维度不一致：${a.length} vs ${b.length}`);
}

/** 把同步 Embedder（如 HashEmbedder）包成批量接口，供 RagPipeline 使用。 */
export class SyncEmbedderAdapter implements AsyncEmbedder {
  readonly name: string;
  readonly dim: number;
  constructor(private readonly inner: Embedder) {
    this.name = inner.name;
    this.dim = inner.dim;
  }
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => l2Normalize(this.inner.embed(t)));
  }
}

export function createHashAsyncEmbedder(dim = 256): AsyncEmbedder {
  return new SyncEmbedderAdapter(new HashEmbedder(dim));
}

/**
 * 从环境变量创建真实 embedding（显式 opt-in）：
 *   MTA_EMBEDDING_MODEL     必填，例如 text-embedding-3-small / bge-m3
 *   MTA_EMBEDDING_BASE_URL  默认 https://api.openai.com/v1
 *   MTA_EMBEDDING_API_KEY   未设置时回退 OPENAI_API_KEY
 *   MTA_EMBEDDING_DIM       可选，Matryoshka / 自定义输出维度
 * 未配置 MODEL 时返回 undefined，保持离线 HashEmbedder（测试/演示零依赖）。
 */
export function createConfiguredEmbedder(env: NodeJS.ProcessEnv = process.env): AsyncEmbedder | undefined {
  const model = env.MTA_EMBEDDING_MODEL?.trim();
  if (!model) return undefined;
  const apiKey = env.MTA_EMBEDDING_API_KEY?.trim() || env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('已设置 MTA_EMBEDDING_MODEL 但缺少 MTA_EMBEDDING_API_KEY / OPENAI_API_KEY');
  }
  const baseUrl = env.MTA_EMBEDDING_BASE_URL?.trim() || 'https://api.openai.com/v1';
  const dimRaw = Number(env.MTA_EMBEDDING_DIM);
  const dimensions = Number.isFinite(dimRaw) && dimRaw > 0 ? Math.floor(dimRaw) : undefined;
  return new OpenAICompatibleEmbedder({ baseUrl, apiKey, model, dimensions });
}

export interface OpenAIEmbedderOptions {
  /** 例如 https://api.openai.com/v1（不要带结尾斜杠） */
  baseUrl: string;
  apiKey: string;
  model?: string;
  /** 覆盖输出维度（Matryoshka / dimensions 参数） */
  dimensions?: number;
  batchSize?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /** 默认 true：拿到结果后显式 L2 归一化 */
  normalize?: boolean;
  fetchImpl?: typeof fetch;
}

/**
 * OpenAI-compatible /embeddings 批量客户端。
 * 负责：分批、超时、429/5xx 指数退避、维度校验、可选的 L2 归一化。
 */
export class OpenAICompatibleEmbedder implements AsyncEmbedder {
  readonly name: string;
  readonly dim: number;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly normalize: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenAIEmbedderOptions) {
    const spec = getEmbeddingModel(opts.model ?? 'text-embedding-3-small');
    this.model = spec.id;
    this.dim = opts.dimensions ?? spec.dim;
    this.name = `${spec.id}@${this.dim}`;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.batchSize = Math.max(1, Math.min(128, opts.batchSize ?? 64));
    this.timeoutMs = Math.max(1000, opts.timeoutMs ?? 30_000);
    this.maxRetries = Math.max(0, opts.maxRetries ?? 3);
    this.normalize = opts.normalize !== false;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    if (!texts.length) return [];
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      out.push(...(await this.embedBatch(batch, signal)));
    }
    return out;
  }

  private async embedBatch(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (signal?.aborted) throw signal.reason ?? new Error('embedding 已取消');
      if (attempt > 0) await abortableSleep(Math.min(8000, 250 * 2 ** (attempt - 1)), signal);
      try {
        return await this.once(texts, signal);
      } catch (e) {
        lastErr = e;
        if (!isRetryable(e) || attempt === this.maxRetries) throw e;
      }
    }
    throw lastErr;
  }

  private async once(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`embedding 超时 ${this.timeoutMs}ms`)), this.timeoutMs);
    const onAbort = () => ctrl.abort(signal?.reason ?? new Error('embedding 已取消'));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const body: Record<string, unknown> = {
        model: this.model,
        input: texts,
        encoding_format: 'float',
      };
      if (this.opts.dimensions) body.dimensions = this.opts.dimensions;
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.opts.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (e) {
        // 把「连不上」与「服务返回错误」分开：前者几乎总是服务没起/地址写错
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(
          `embedding 连接失败（${this.baseUrl}/embeddings）：${msg}；` +
            `检查 embedding 服务是否在运行（本机 Ollama：\`ollama serve\`），或核对 MTA_EMBEDDING_BASE_URL`,
        );
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        const err = new Error(`embedding HTTP ${res.status}: ${detail.slice(0, 300)}`);
        (err as Error & { status?: number }).status = res.status;
        throw err;
      }
      const json = (await res.json()) as {
        data?: { embedding?: number[]; index?: number }[];
      };
      const rows = json.data ?? [];
      if (rows.length !== texts.length) {
        throw new Error(`embedding 返回条数不符：期望 ${texts.length}，实际 ${rows.length}`);
      }
      const sorted = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      return sorted.map((row, i) => {
        const v = Float32Array.from(row.embedding ?? []);
        assertDim(v, this.dim, `embedding[${i}]`);
        return this.normalize ? l2Normalize(v) : v;
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

function isRetryable(e: unknown): boolean {
  const status = (e as { status?: number } | null)?.status;
  if (status === 429 || (status ?? 0) >= 500) return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|timeout|超时|terminated/i.test(msg);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
