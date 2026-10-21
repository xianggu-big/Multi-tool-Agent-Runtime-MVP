// tests/47_p2_helpers.test.ts — P2：LangGraph 取舍 / LoRA vs RAG / vLLM 显存估算
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseAgentFramework } from '../src/runtime/frameworkChoice.js';
import { chooseAdaptation } from '../src/llm/adaptation.js';
import { estimateVram, fitsGpu } from '../src/llm/vram.js';

test('47a) Agent 框架：线性单 Agent 手写，图中断/恢复/多 Agent 用 LangGraph', () => {
  const simple = chooseAgentFramework({
    hasCycles: false,
    needsCheckpointResume: false,
    needsHumanInTheLoop: false,
    multiAgent: false,
    simpleLinearFlow: true,
    teamFamiliar: false,
  });
  assert.equal(simple.choice, 'hand-rolled');

  const graph = chooseAgentFramework({
    hasCycles: true,
    needsCheckpointResume: true,
    needsHumanInTheLoop: true,
    multiAgent: true,
    simpleLinearFlow: false,
    teamFamiliar: false,
  });
  assert.equal(graph.choice, 'langgraph');
  assert.ok(graph.reasons.some((r) => /检查点/.test(r)));

  const middle = chooseAgentFramework({
    hasCycles: true,
    needsCheckpointResume: false,
    needsHumanInTheLoop: false,
    multiAgent: false,
    simpleLinearFlow: false,
    teamFamiliar: false,
  });
  assert.equal(middle.choice, 'either');
  assert.ok(middle.warnings.some((w) => /PoC/.test(w)));
});

test('47b) LoRA vs RAG：知识易变/要引用选 RAG；稳定行为且有标注才 LoRA', () => {
  const rag = chooseAdaptation({
    knowledgeVolatile: true,
    needsCitations: true,
    behaviorChange: false,
    labeledExamples: 0,
    privacy: 'public',
    canCallBaseModel: true,
  });
  assert.equal(rag.strategy, 'rag');

  const style = chooseAdaptation({
    knowledgeVolatile: false,
    needsCitations: false,
    behaviorChange: true,
    labeledExamples: 200,
    privacy: 'private',
    canCallBaseModel: true,
  });
  assert.equal(style.strategy, 'lora');

  const both = chooseAdaptation({
    knowledgeVolatile: true,
    needsCitations: true,
    behaviorChange: true,
    labeledExamples: 500,
    privacy: 'private',
    canCallBaseModel: true,
  });
  assert.equal(both.strategy, 'rag+lora');

  const fewShots = chooseAdaptation({
    knowledgeVolatile: false,
    needsCitations: false,
    behaviorChange: true,
    labeledExamples: 20,
    privacy: 'public',
    canCallBaseModel: true,
  });
  assert.equal(fewShots.strategy, 'prompt');
  assert.ok(fewShots.warnings.some((w) => /100/.test(w)));

  const tight = chooseAdaptation({
    knowledgeVolatile: true,
    needsCitations: false,
    behaviorChange: false,
    labeledExamples: 0,
    latencyBudgetMs: 100,
    privacy: 'public',
    canCallBaseModel: true,
  });
  assert.ok(tight.warnings.some((w) => /300ms/.test(w)));
});

test('47c) vLLM 显存：权重 + KV + 激活 + 开销；量化省权重，不省 KV', () => {
  const fp16 = estimateVram({ model: 'llama3-8b', seqLen: 4096, batch: 1, concurrency: 1 });
  assert.ok(Math.abs(fp16.weightsGB - 16) < 0.01);
  assert.ok(fp16.kvCacheGB > 0.4 && fp16.kvCacheGB < 0.8);
  assert.ok(fp16.totalGB > fp16.weightsGB);
  assert.ok(fitsGpu(fp16, 24));
  assert.equal(fitsGpu(fp16, 16), false);

  const int4 = estimateVram({ model: 'llama3-8b', seqLen: 4096, weightPrecision: 'int4' });
  assert.ok(Math.abs(int4.weightsGB - 4) < 0.01);
  assert.ok(int4.totalGB < fp16.totalGB);
  assert.ok(Math.abs(int4.kvCacheGB - fp16.kvCacheGB) < 0.01, '默认 fp16 KV 不随权重量化变化');

  const long = estimateVram({ model: 'llama3-8b', seqLen: 32768 });
  assert.ok(long.kvCacheGB > fp16.kvCacheGB * 7);
  assert.ok(long.notes.some((n) => /长上下文/.test(n)));

  const tp = estimateVram({ model: 'llama3-70b', tensorParallel: 4 });
  assert.ok(Math.abs(tp.perGpuGB - tp.totalGB / 4) < 0.02);
  assert.throws(() => estimateVram({ model: 'no-such-model' }), /未知模型预设/);
});