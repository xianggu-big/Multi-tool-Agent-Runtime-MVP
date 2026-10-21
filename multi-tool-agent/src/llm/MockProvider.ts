// src/llm/MockProvider.ts — 可控的 Mock LLM Provider
// 用于无 API Key 情况下的核心 Runtime 自动化测试与演示。
// 重要：Mock 结果明确标注为模拟，绝不伪装成真实模型效果。
//
// 流式能力：当调用方提供 onDelta 时，把「思考」与「正文」按固定粒度分片回调，
// 用于在无 Key 的演示/开发环境中展示实时流式 UI。
// 分片延迟由 MockProviderOptions.chunkDelayMs 控制：测试/CI 必须为 0（全速），
// 仅演示场景可设置 >0 的延迟以便肉眼观察逐字输出。

import type {
  ChatMessage,
  LLMChatRequest,
  LLMDeltaHandler,
  LLMProvider,
  LLMResponse,
  StopReason,
  ToolCall,
  TokenUsage,
} from '../types.js';

export interface MockStep {
  stopReason: StopReason;
  content: string;
  toolCalls?: ToolCall[];
  promptTokens?: number;
  completionTokens?: number;
  /** 可选：自定义思考文本（不提供时按决策自动合成） */
  reasoning?: string;
}

export interface MockContext {
  messages: ChatMessage[];
  tools: { name: string }[];
  scenario?: string;
  goal: string;
  /** 第几次模型调用（assistant 消息数） */
  callIndex: number;
}

export type MockResponder = (ctx: MockContext) => MockStep;

export interface MockProviderOptions {
  /** 分片之间的延迟（毫秒）。0 = 全速（默认）。仅用于演示节奏。 */
  chunkDelayMs?: number;
  /** 单个分片的最大字符数（默认 18） */
  chunkChars?: number;
  /** Mock 的模拟上下文窗口（token）。默认 32768；测试可覆盖。 */
  contextWindow?: number;
}

/** Mock 没有真实模型窗口，用固定值模拟，便于压缩门禁做确定性回归。 */
export const DEFAULT_MOCK_CONTEXT_WINDOW = 32_768;

function countTokens(text: string): number {
  // 粗略估算：按空白分词，仅用于预算演示。
  if (!text) return 0;
  return Math.max(1, text.split(/\s+/).length);
}

function estimateMessages(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) {
    n += countTokens(m.content);
    for (const tc of m.toolCalls ?? []) {
      n += countTokens(JSON.stringify(tc.arguments));
    }
  }
  return n;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 按 Unicode 码点安全切分（避免截断代理对） */
function chunk(text: string, size: number): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) {
    out.push(chars.slice(i, i + size).join(''));
  }
  return out.length ? out : [''];
}

/** 根据本步决策合成一段「思考」文本（Mock 专用，明确标注为模拟） */
function synthesizeReasoning(step: MockStep, callIndex: number): string {
  if (step.reasoning) return step.reasoning;
  const names = (step.toolCalls ?? []).map((t) => t.name);
  if (names.length) {
    return `第 ${callIndex + 1} 轮推理：当前信息不足，需要调用 ${names.join('、')} 获取事实，再决定下一步。`;
  }
  return `第 ${callIndex + 1} 轮推理：已有信息足够，组织最终结论并输出。`;
}

export class MockProvider implements LLMProvider {
  readonly name = 'mock';
  readonly contextWindow: number;
  private readonly chunkDelayMs: number;
  private readonly chunkChars: number;

  constructor(
    private readonly responder: MockResponder,
    opts: MockProviderOptions = {},
  ) {
    this.chunkDelayMs = Math.max(0, opts.chunkDelayMs ?? 0);
    this.chunkChars = Math.max(1, opts.chunkChars ?? 18);
    this.contextWindow = Math.max(1, opts.contextWindow ?? DEFAULT_MOCK_CONTEXT_WINDOW);
  }

  async chat(
    req: LLMChatRequest,
    onDelta?: LLMDeltaHandler,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    const callIndex = req.messages.filter((m) => m.role === 'assistant').length;
    const step = this.responder({
      messages: req.messages,
      tools: req.tools.map((t) => ({ name: t.name })),
      scenario: undefined,
      goal: '',
      callIndex,
    });

    const promptTokens = step.promptTokens ?? estimateMessages(req.messages);
    const completionTokens =
      step.completionTokens ?? countTokens(step.content) + (step.toolCalls?.length ?? 0) * 4;

    const usage: TokenUsage = {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      costUsd: 0,
      isEstimate: true,
      // Mock 没有真实 usage，token 数是按字数/消息数启发式估算的 → token 数带"估"
      tokensEstimated: true,
    };

    const reasoning = synthesizeReasoning(step, callIndex);

    if (onDelta) {
      await this.streamText(reasoning, 'reasoning', onDelta, signal);
      await this.streamText(step.content, 'content', onDelta, signal);
      // 流式 tool_call 首帧反馈：模拟 SSE 中检测到新工具调用分片
      if (step.toolCalls?.length) {
        for (const tc of step.toolCalls) {
          onDelta({ channel: 'tool_call', text: JSON.stringify({ index: 0, id: tc.id, name: tc.name }) });
        }
      }
    }

    return {
      stopReason: step.stopReason,
      content: step.content,
      toolCalls: step.toolCalls ?? [],
      usage,
      latencyMs: 1,
      model: 'mock-model',
      // 即使不流式也返回思考文本，便于「关闭流式」时仍能记录思考过程
      reasoning,
    };
  }

  private async streamText(
    text: string,
    channel: 'reasoning' | 'content',
    onDelta: LLMDeltaHandler,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!text) return;
    for (const piece of chunk(text, this.chunkChars)) {
      if (signal?.aborted) return;
      onDelta({ channel, text: piece });
      if (this.chunkDelayMs > 0) await sleep(this.chunkDelayMs);
    }
  }
}
