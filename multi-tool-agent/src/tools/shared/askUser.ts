// src/tools/shared/askUser.ts — 显式「向用户提问」终结性工具
// 设计：模型缺少必须由用户确认的信息时，调用本工具暂停任务；
// Runtime 把 run 置为 awaiting_user（不再伪装 completed），前端展示问题并等待用户回答。
import { z } from 'zod';
import type { Tool } from '../types.js';
import { okResult } from '../types.js';

const inputSchema = z.object({
  questions: z
    .array(z.string().min(1).max(500))
    .min(1)
    .max(10)
    .describe('必须由用户回答的问题（逐条、具体、可回答；最多 10 条）'),
  reason: z
    .string()
    .max(1000)
    .optional()
    .describe('为什么必须暂停：缺少哪些关键信息，或需要用户确认什么'),
  context: z
    .string()
    .max(2000)
    .optional()
    .describe('给用户的简短背景（已确认的事实/已尝试的路径），帮助用户快速回答'),
});

export const askUser: Tool = {
  name: 'ask_user',
  description:
    '暂停当前任务，向用户提出必须回答的问题。调用成功后本次 run 以 awaiting_user 结束；用户回答后可用新一轮任务继续。' +
    '只在缺少关键信息、继续执行会做错或涉及不可逆选择时使用；不要用它代替正常结论。',
  inputSchema,
  inputExample: {
    questions: ['请确认要分析的范围是 src/ 还是整个仓库？'],
    reason: '目标范围不明确，直接扫描整个仓库会浪费预算',
    context: '已确认仓库根目录，但未找到范围说明。',
  },
  timeoutMs: 1000,
  permission: 'agent:ask',
  riskLevel: 'safe',
  terminal: true,
  execute(input: unknown) {
    const args = input as z.infer<typeof inputSchema>;
    return okResult(
      {
        questions: args.questions,
        reason: args.reason,
        context: args.context,
        askedAt: new Date().toISOString(),
      },
      0,
    );
  },
};