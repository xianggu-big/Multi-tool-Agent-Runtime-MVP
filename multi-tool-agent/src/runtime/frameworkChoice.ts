// src/runtime/frameworkChoice.ts — P2：什么时候该用 Agent 框架（LangGraph），什么时候不该
//
// 判断标准不是「框架是否流行」，而是控制流复杂度：
//   - 有环/条件边、需要检查点恢复、需要人工审批插入、多个 Agent 共享状态 → 图框架更省事；
//   - 单轮/线性循环、状态小、团队不熟、只有一条主路径 → 手写 Agent Loop 更透明。
// 本项目现有 AgentRuntime 就是「手写循环 + 事件/span」，足以支撑四类 Agent。

export type AgentFrameworkChoice = 'langgraph' | 'hand-rolled' | 'either';

export interface FrameworkNeeds {
  /** 是否存在循环/条件边（工具失败回退、反思重试、多阶段路由） */
  hasCycles: boolean;
  /** 是否需要持久化检查点并按 thread 恢复（长任务、人工中断后继续） */
  needsCheckpointResume: boolean;
  /** 是否需要在图中暂停等待人工审批/补充信息 */
  needsHumanInTheLoop: boolean;
  /** 是否有多个 Agent 共享/传递状态 */
  multiAgent: boolean;
  /** 是否只有一条线性主路径（单 Agent、固定工具循环） */
  simpleLinearFlow: boolean;
  /** 团队是否已熟悉该框架的调试/部署方式 */
  teamFamiliar: boolean;
}

export interface FrameworkDecision {
  choice: AgentFrameworkChoice;
  score: number;
  reasons: string[];
  warnings: string[];
}

export function chooseAgentFramework(needs: FrameworkNeeds): FrameworkDecision {
  const reasons: string[] = [];
  const warnings: string[] = [];
  let score = 0;

  if (needs.hasCycles) {
    score += 2;
    reasons.push('存在循环/条件边：图的边与状态转移比手写 if/while 更容易审阅。');
  }
  if (needs.needsCheckpointResume) {
    score += 2;
    reasons.push('需要检查点与按 thread 恢复：框架自带持久化/恢复语义。');
  }
  if (needs.needsHumanInTheLoop) {
    score += 2;
    reasons.push('需要图中暂停等待人工输入：interrupt/resume 是框架的核心能力。');
  }
  if (needs.multiAgent) {
    score += 1;
    reasons.push('多个 Agent 共享状态：统一 state schema 能减少隐式耦合。');
  }
  if (needs.teamFamiliar) {
    score += 1;
    reasons.push('团队熟悉框架的调试/部署：采用成本较低。');
  }
  if (needs.simpleLinearFlow) {
    score -= 2;
    reasons.push('只有线性主路径：手写循环更少抽象、更容易定位问题。');
  }

  if (needs.simpleLinearFlow && !needs.hasCycles && !needs.needsCheckpointResume && !needs.needsHumanInTheLoop) {
    return { choice: 'hand-rolled', score, reasons, warnings };
  }
  if (needs.needsCheckpointResume && needs.needsHumanInTheLoop) {
    return { choice: 'langgraph', score, reasons, warnings };
  }
  if (score >= 4) return { choice: 'langgraph', score, reasons, warnings };
  if (score <= 0) return { choice: 'hand-rolled', score, reasons, warnings };

  if (!needs.teamFamiliar) {
    warnings.push('团队不熟框架：先做 1 个只读 PoC，别在关键路径上一次迁完。');
  }
  warnings.push('框架不替代可观测性：节点级 span、token/成本、失败重试仍要自己埋点。');
  return { choice: 'either', score, reasons, warnings };
}