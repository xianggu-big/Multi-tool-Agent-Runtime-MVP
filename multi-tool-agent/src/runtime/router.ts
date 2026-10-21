// src/runtime/router.ts — 任务分流器（规则式，纯函数，不调用 LLM）
// 目的：在「用户不知道该选哪个 Agent」时给出建议，把杂项琐事路由到最省的 misc Agent，
//       把真正需要读代码/联网的任务交给 codebase / research。
// 设计取舍：
//   - **规则 + 可解释**：返回命中的信号词与理由，界面上能显示「为什么这么建议」，也便于单测；
//   - **不调用 LLM**：分流本身不应该产生费用与延迟（否则「省钱的杂项 Agent」反而先花一次钱）；
//   - **保守**：不确定时给 medium/low 置信度并倾向更“重”的 agent，避免把重活丢给只读的 misc。

import type { RunType, TaskRouting } from '../types.js';

interface Rule {
  runType: RunType;
  /** 命中任意一个即计一票 */
  keywords: string[];
  /** 权重：越“重”的任务越应该被识别出来（避免误判成 misc） */
  weight: number;
  reason: string;
}

/** 需要「读代码 + 迭代验证」的信号（最优先） */
const CODEBASE_RULES: Rule = {
  runType: 'codebase',
  weight: 3,
  reason: '涉及代码理解、修改或测试验证，需要 Codebase Agent',
  // 只放「动作词」，不放「名词」：像「有多少个 ts 文件」「列出所有函数」属于清点类琐事，
  // 若把「函数/模块/ts 文件」当信号会把它们误判成需要改代码的重任务。
  keywords: [
    '重构', '实现', '改成', '修改代码', '改一下代码', '写一个', '写出', '修复', '报错', '为什么报错',
    '编译失败', '编译不过', '类型检查', '跑测试', '运行测试', '单元测试', 'npm test', '测试失败', '覆盖率',
    'refactor', 'implement', 'fix the', 'broken', 'compile', 'unit test', 'coverage',
  ],
};

/** 需要「外部信息」的信号 */
const RESEARCH_RULES: Rule = {
  runType: 'research',
  weight: 3,
  reason: '需要外部/最新信息或来源引用，需要 Research Agent',
  keywords: [
    '搜索', '检索', '查一下最新', '最新版本', '调研', '对比', '对比一下', '资料', '来源', '引用',
    '官方文档怎么说', '社区评价', '论文', '网络', '官网', '新闻',
    'search', 'research', 'compare', 'latest', 'benchmark', 'survey',
  ],
};

/** 杂项/琐事信号（低权重：只有在没有更重信号时才生效） */
const MISC_RULES: Rule = {
  runType: 'misc',
  weight: 1,
  reason: '属于本地、只读、单步可完成的小事，交给 Misc Agent 最省',
  keywords: [
    '多少', '几个', '统计', '清点', '有哪些', '列一下', '列出来', '目录', '看看目录', '目录结构',
    '整理成清单', '概览', '列出', '找一下', '在哪个文件', '哪个文件里', '有没有',
    'todo', 'fixme', '重复文件', '大文件', '空文件', '备份文件', '临时文件',
    '格式化', '格式化成', '提取字段',
    'count', 'how many', 'list', 'inventory', 'overview', 'todo', 'fixme',
  ],
};

const RULES: Rule[] = [CODEBASE_RULES, RESEARCH_RULES, MISC_RULES];

/** 命中「危险/越界」词时强制给 human 改派提示（这些事 misc 绝不做） */
const DANGEROUS = ['删除', '删掉', '清空', '移动文件', '重命名', '批量改', '覆盖', 'rm ', 'del ', 'format '];

/** 「多分区」信号：出现这些词说明任务可以按目录/来源拆成并行子任务 */
const ORCH_KEYWORDS = ['分别', '逐个', '每个目录', '所有目录', '各目录', '按目录', '各自', '多处', '挨个', '并行处理'];

/**
 * 判断目标是否「天然可扇出」：出现并列连接词（、和 与 以及），
 * 且上下文里确实有可分区的东西（目录/文件/主题/来源/仓库）。
 * 说明：这是**启发式**，误判代价可控（编排任务的预筛若产不出子任务，主 Agent 会自行退化）。
 */
export function looksMultiPartition(goal: string): boolean {
  const text = goal ?? '';
  // ① 明确的编排词
  if (ORCH_KEYWORDS.some((k) => text.includes(k))) return true;
  // ② 两个「像路径/标识符」的并列目标（src 和 test、docs 与 src、a.txt、b.txt）
  //    注意：**只有并列连接词不够**——「多少文件、总大小多少」也是并列，但它是一个目标，
  //    误判成编排会造成"过度分解"（本项目明确列为反模式），所以要求两端都像标识符。
  return /[A-Za-z0-9_.\-]{2,30}\s*(?:、|和|与|以及|,|，)\s*[A-Za-z0-9_.\-]{2,30}/.test(text);
}

export interface ClassifyOptions {
  /** 是否允许把结果定位为 misc（默认 true）；若调用方只想在 codebase/research 之间选，可设为 false */
  allowMisc?: boolean;
}

/**
 * 规则式分流。返回的 runType 只是**建议**，最终由调用方决定。
 * 冲突时按 weight 累加取最高分；平分时优先更“重”的 agent（research > codebase > misc 顺序由 RULES 顺序保证）。
 */
export function classifyTask(goal: string, opts: ClassifyOptions = {}): TaskRouting {
  const text = (goal ?? '').toLowerCase();
  const allowMisc = opts.allowMisc !== false;
  const signals: string[] = [];
  const scores = new Map<RunType, number>();
  const reasons = new Map<RunType, string>();

  for (const rule of RULES) {
    if (rule.runType === 'misc' && !allowMisc) continue;
    const hits = rule.keywords.filter((k) => text.includes(k.toLowerCase()));
    if (hits.length) {
      scores.set(rule.runType, (scores.get(rule.runType) ?? 0) + hits.length * rule.weight);
      reasons.set(rule.runType, rule.reason);
      signals.push(...hits.slice(0, 5));
    }
  }

  const dangerousHits = DANGEROUS.filter((k) => text.includes(k));

  const dangerousNote = dangerousHits.length
    ? `；⚠️ 目标包含破坏性动作（${dangerousHits.join('、')}）：本项目没有任何写/删工具，任何 Agent 都不会执行，需人工确认`
    : '';

  if (!scores.size) {
    // 无信号：默认交给 misc 试探（最便宜），但置信度低，并说明理由
    return {
      runType: allowMisc ? 'misc' : 'codebase',
      confidence: 'low',
      reason:
        (allowMisc
          ? '未识别到明确信号，默认先用最省的 Misc Agent 试探（只读、预算小）；若它上报超范围再改派'
          : '未识别到明确信号，默认交给 Codebase Agent') + dangerousNote,
      signals: [],
      ...(dangerousHits.length ? { requiresHuman: true } : {}),
    };
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || weightOf(b[0]) - weightOf(a[0]));
  let [winner, topScore] = ranked[0];
  const runnerUp = ranked[1];

  // 升级判定：可扇出（多分区）+ 只读类信号（misc / research）+ 没有改代码类信号 → 建议走编排
  // 理由：多目录清点/审计/多来源调研在单 Agent 上必然串行，正是「扇出-扇入」的适用场景；
  //       而一旦出现改代码类信号（codebase 命中），仍应交给 Codebase Agent（它才有力气改）。
  const codebaseHits = scores.get('codebase') ?? 0;
  const readOnlyHits = (scores.get('misc') ?? 0) + (scores.get('research') ?? 0);
  if (codebaseHits === 0 && readOnlyHits > 0 && looksMultiPartition(goal)) {
    return {
      runType: 'orchestrator',
      confidence: topScore >= 3 ? 'high' : 'medium',
      reason: `目标可拆成多个相互独立的子任务（多分区信号：${ORCH_KEYWORDS.filter((k) => goal.includes(k)).join('、') || '并列条目'}），建议交给多 Agent 编排并行处理`,
      signals: [...new Set(signals)].slice(0, 8),
      ...(dangerousHits.length ? { requiresHuman: true } : {}),
    };
  }

  // 置信度：命中少、或与第二名差距小 → 降低置信度
  const gap = runnerUp ? topScore - runnerUp[1] : topScore;
  let confidence: TaskRouting['confidence'] = 'high';
  if (topScore <= 2 || gap <= 1) confidence = 'medium';
  if (runnerUp && gap === 0) confidence = 'low';

  const reason = reasons.get(winner) ?? '按信号词匹配';

  return {
    runType: winner,
    confidence,
    reason: reason + dangerousNote,
    signals: [...new Set(signals)].slice(0, 8),
    ...(dangerousHits.length ? { requiresHuman: true } : {}),
  };
}

function weightOf(t: RunType): number {
  return RULES.find((r) => r.runType === t)?.weight ?? 0;
}
