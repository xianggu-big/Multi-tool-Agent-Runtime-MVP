// src/llm/vram.ts — 推理显存估算（vLLM / 量化部署）
//
// 显存 ≈ 权重 + KV cache + 激活 + 框架/碎片开销。
// 关键结论：
//   - 权重：params × bytes/param（FP16=2B，INT8=1B，INT4≈0.5B+scale）；
//   - KV cache：2(K/V) × layers × kvHeads × headDim × seqLen × batch × concurrency × kvBytes；
//     GQA/MQA 的 kvHeads 远小于 heads，这是长上下文能落地的关键；
//   - 激活：与 batch×seq×hidden 成正比，通常远小于权重/KV，但长上下文不可忽略；
//   - 量化主要省权重，**不省 KV cache**（KV 可单独量化，但有精度代价）。
//
// 这些是估算，不是 vLLM 的精确 planner；上线前用 `nvidia-smi` + 压测校准。

export type Precision = 'fp32' | 'fp16' | 'bf16' | 'int8' | 'int4';

export const PRECISION_BYTES: Record<Precision, number> = {
  fp32: 4,
  fp16: 2,
  bf16: 2,
  int8: 1,
  int4: 0.5,
};

export interface ModelPreset {
  id: string;
  paramsB: number;
  layers: number;
  kvHeads: number;
  headDim: number;
  hiddenSize: number;
  notes: string;
}

/** 常见开源模型的近似结构参数（用于估算，具体以模型 config.json 为准）。 */
export const MODEL_PRESETS: Record<string, ModelPreset> = {
  'llama3-8b': {
    id: 'llama3-8b',
    paramsB: 8,
    layers: 32,
    kvHeads: 8,
    headDim: 128,
    hiddenSize: 4096,
    notes: 'Llama-3-8B 近似值（GQA 8 KV heads）',
  },
  'llama3-70b': {
    id: 'llama3-70b',
    paramsB: 70,
    layers: 80,
    kvHeads: 8,
    headDim: 128,
    hiddenSize: 8192,
    notes: 'Llama-3-70B 近似值（GQA 8 KV heads）',
  },
  'qwen2.5-7b': {
    id: 'qwen2.5-7b',
    paramsB: 7.6,
    layers: 28,
    kvHeads: 4,
    headDim: 128,
    hiddenSize: 3584,
    notes: 'Qwen2.5-7B 近似值（GQA 4 KV heads）',
  },
  'qwen2.5-32b': {
    id: 'qwen2.5-32b',
    paramsB: 32.5,
    layers: 64,
    kvHeads: 8,
    headDim: 128,
    hiddenSize: 5120,
    notes: 'Qwen2.5-32B 近似值（GQA 8 KV heads）',
  },
  'mistral-7b': {
    id: 'mistral-7b',
    paramsB: 7.2,
    layers: 32,
    kvHeads: 8,
    headDim: 128,
    hiddenSize: 4096,
    notes: 'Mistral-7B 近似值（GQA 8 KV heads）',
  },
};

export interface VramInput {
  /** 预设 id（可选）；显式字段会覆盖预设值 */
  model?: string;
  paramsB?: number;
  layers?: number;
  kvHeads?: number;
  headDim?: number;
  hiddenSize?: number;
  seqLen?: number;
  batch?: number;
  concurrency?: number;
  weightPrecision?: Precision;
  kvPrecision?: Precision;
  /** 框架/CUDA context/碎片开销比例，默认 0.15 */
  overheadRatio?: number;
  /** 张量并行卡数 */
  tensorParallel?: number;
}

export interface VramEstimate {
  model: string;
  weightsGB: number;
  kvCacheGB: number;
  activationsGB: number;
  overheadGB: number;
  totalGB: number;
  perGpuGB: number;
  tensorParallel: number;
  assumptions: {
    paramsB: number;
    layers: number;
    kvHeads: number;
    headDim: number;
    hiddenSize: number;
    seqLen: number;
    batch: number;
    concurrency: number;
    weightPrecision: Precision;
    kvPrecision: Precision;
    overheadRatio: number;
  };
  notes: string[];
}

export function estimateVram(input: VramInput): VramEstimate {
  const preset = input.model ? MODEL_PRESETS[input.model] : undefined;
  if (input.model && !preset) {
    throw new Error(`未知模型预设 ${input.model}；可选：${Object.keys(MODEL_PRESETS).join(', ')}`);
  }
  const paramsB = positive(input.paramsB ?? preset?.paramsB ?? 7);
  const layers = int(input.layers ?? preset?.layers ?? 32, 1);
  const kvHeads = int(input.kvHeads ?? preset?.kvHeads ?? 8, 1);
  const headDim = int(input.headDim ?? preset?.headDim ?? 128, 1);
  const hiddenSize = int(input.hiddenSize ?? preset?.hiddenSize ?? headDim * 32, 1);
  const seqLen = int(input.seqLen ?? 4096, 1);
  const batch = int(input.batch ?? 1, 1);
  const concurrency = int(input.concurrency ?? 1, 1);
  const weightPrecision = input.weightPrecision ?? 'fp16';
  const kvPrecision = input.kvPrecision ?? 'fp16';
  const overheadRatio = clamp(input.overheadRatio ?? 0.15, 0, 1);
  const tensorParallel = int(input.tensorParallel ?? 1, 1);

  const weightsGB = (paramsB * 1e9 * PRECISION_BYTES[weightPrecision]) / 1e9;
  const kvPerTokenBytes = 2 * layers * kvHeads * headDim * PRECISION_BYTES[kvPrecision];
  const kvCacheGB = (kvPerTokenBytes * seqLen * batch * concurrency) / 1e9;
  // 激活：batch × concurrency × seq × hidden × 2（QKV/MLP 中间量）× 2 bytes（默认 fp16 工作区）
  const activationsGB = (batch * concurrency * seqLen * hiddenSize * 2 * 2) / 1e9;
  const preOverhead = weightsGB + kvCacheGB + activationsGB;
  const overheadGB = preOverhead * overheadRatio;
  const totalGB = preOverhead + overheadGB;
  const perGpuGB = totalGB / tensorParallel;

  const notes: string[] = [];
  if (weightPrecision === 'int4') notes.push('INT4 权重还需要 scales/zero-points（约 +3~10%），且对精度更敏感。');
  if (weightPrecision === 'int8') notes.push('INT8 通常指 weight-only 或 W8A8；务必在任务评测集上验证，而不是只看 perplexity。');
  if (kvPrecision === 'int8' || kvPrecision === 'int4') notes.push('KV cache 量化会直接影响长上下文/检索一致性，建议单独做消融。');
  if (seqLen > 8192) notes.push('长上下文时 KV cache 往往超过权重：优先用 GQA/MQA、分页 KV、KV 量化。');
  notes.push('估算不含多卡通信缓冲、CUDA graph、tokenizer/预处理；上线前用真实压测校准。');

  return {
    model: input.model ?? 'custom',
    weightsGB: round2(weightsGB),
    kvCacheGB: round2(kvCacheGB),
    activationsGB: round2(activationsGB),
    overheadGB: round2(overheadGB),
    totalGB: round2(totalGB),
    perGpuGB: round2(perGpuGB),
    tensorParallel,
    assumptions: {
      paramsB,
      layers,
      kvHeads,
      headDim,
      hiddenSize,
      seqLen,
      batch,
      concurrency,
      weightPrecision,
      kvPrecision,
      overheadRatio,
    },
    notes,
  };
}

export function fitsGpu(estimate: VramEstimate, gpuMemoryGB: number): boolean {
  return estimate.perGpuGB <= gpuMemoryGB;
}

function positive(v: number): number {
  if (!Number.isFinite(v) || v <= 0) throw new Error(`参数必须为正数：${v}`);
  return v;
}

function int(v: number, min: number): number {
  return Math.max(min, Math.floor(positive(v)));
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
