// src/llm/adaptation.ts — RAG vs LoRA 的决策辅助
//
// 一句话：知识会变、需要引用 → RAG；行为/风格/格式要稳定改变、且有标注数据 → LoRA；
// 两者都要 → RAG + LoRA。不要用微调去背频繁变化的文档，也不要用 RAG 去学新能力。

export type AdaptationStrategy = 'prompt' | 'rag' | 'lora' | 'rag+lora';

export interface AdaptationInput {
  /** 知识是否频繁变化（文档/价格/政策/代码库） */
  knowledgeVolatile: boolean;
  /** 是否必须给出来源/引用 */
  needsCitations: boolean;
  /** 是否需要改变模型行为、风格、输出格式或领域推理方式 */
  behaviorChange: boolean;
  /** 可用的高质量标注样本数（instruction/response 对） */
  labeledExamples: number;
  /** 端到端延迟预算（毫秒）；RAG 会增加检索延迟 */
  latencyBudgetMs?: number;
  /** 数据能否离开本地 */
  privacy: 'public' | 'private';
  /** 是否有权限/能力调用基座模型 API（没有则只能本地部署/微调） */
  canCallBaseModel: boolean;
}

export interface AdaptationDecision {
  strategy: AdaptationStrategy;
  reasons: string[];
  warnings: string[];
}

export function chooseAdaptation(input: AdaptationInput): AdaptationDecision {
  const reasons: string[] = [];
  const warnings: string[] = [];
  let rag = false;
  let lora = false;

  if (input.knowledgeVolatile || input.needsCitations) {
    rag = true;
    reasons.push(input.needsCitations ? '需要引用来源 → 检索结果可追溯。' : '知识频繁变化 → 更新索引比重新训练便宜。');
  }
  if (input.behaviorChange) {
    if (input.labeledExamples >= 500) {
      lora = true;
      reasons.push('需要改变行为/风格/格式，且有 ≥500 条标注 → LoRA 更稳（≥100 是门槛，500+ 更抗过拟合）。');
    } else if (input.labeledExamples >= 100) {
      lora = true;
      reasons.push('需要改变行为/风格/格式，且有 ≥100 条标注 → LoRA 可学稳定模式。');
    } else {
      warnings.push('需要行为改变但标注 <100 条：先用 prompt/few-shot，别急着 LoRA。');
    }
  }
  if (input.privacy === 'private' && input.behaviorChange && input.labeledExamples >= 100) {
    lora = true;
    reasons.push('数据不能出本地：私有化 LoRA 比把私有数据发给外部 API 更可控。');
  }
  if (!input.canCallBaseModel && !rag && !lora) {
    warnings.push('不能调用基座模型：需要本地部署（vLLM/Ollama）或微调，不能只靠 prompt。');
  }
  if (input.latencyBudgetMs !== undefined && input.latencyBudgetMs < 300 && rag) {
    warnings.push('延迟预算 <300ms：检索+rerank 可能放不下；考虑缓存、预计算或降 top-k。');
  }

  let strategy: AdaptationStrategy;
  if (rag && lora) strategy = 'rag+lora';
  else if (rag) strategy = 'rag';
  else if (lora) strategy = 'lora';
  else strategy = 'prompt';

  if (strategy === 'prompt') reasons.push('没有明确的新知识/新行为需求：先用 prompt + 工具调用验证。');
  if (strategy === 'rag+lora') reasons.push('知识检索与行为固化分开做：RAG 管“知道什么”，LoRA 管“怎么说/怎么做”。');

  return { strategy, reasons, warnings };
}
