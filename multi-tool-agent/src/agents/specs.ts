// src/agents/specs.ts — 子 Agent 契约注册表（单一事实来源）
// 设计要点：
//  1) **契约用代码定义**：职责、工具白名单、权限、预算、输入/输出 schema 全部写在 spec 里，
//     `agents/*.agent.md` 由 `npm run agents:docs` 从本文件生成——文档不会与实现漂移。
//  2) **权限不超集**：spec 声明的 permissions 必须等于「它声明的 tools 所要求的权限集合」，
//     既不能少（会跑不起来）也不能多（等于偷偷提权）。`validateSpecs()` 在装配时强制校验。
//  3) **能力即边界**：不给的工具就是"没有那条通路"，边界靠结构而不是靠提示词。
//
// ⚠️ 新增子 Agent 的唯一入口就是这里加一条 spec，然后跑 `npm run agents:docs && npm run agents:lint`。

import { z } from 'zod';
import type { LLMGenerationParams, RiskLevel } from '../types.js';

export interface SubAgentBudget {
  maxSteps: number;
  maxModelCalls: number;
  maxToolCalls: number;
  tokenBudget: number;
  totalTimeoutMs: number;
}

/**
 * 子 Agent 重要性分级 —— 决定「结果拿到后是否自动释放资源」。
 * - `ephemeral`：一次性任务（如单次搜索/清点），结果被主 Agent 采纳后立即销毁上下文。
 * - `session`：会话级，保留以支持后续追问，闲置超时后自动释放。
 * - `durable`：长生命周期，除非显式退役或硬性 maxAge 到期，否则常驻。
 *
 * 生命周期判定由 `src/runtime/SubAgentLifecycle.ts` 的 `shouldRelease()` 统一裁决，
 * 规则可解释、可单测、不靠提示词。
 */
export type SubAgentImportance = 'ephemeral' | 'session' | 'durable';

/**
 * 资源保留策略（与 importance 配合）。
 * 不填 = 按 importance 取默认值（见 SubAgentLifecycle.DEFAULT_RETENTION）。
 */
export interface RetentionPolicy {
  importance: SubAgentImportance;
  /** session/durable：闲置多久无活动后释放（默认 5min / 30min） */
  idleTimeoutMs?: number;
  /** 任何 tier 的硬性存活上限（默认 30min / 4h / 24h） */
  maxAgeMs?: number;
  /** 该 spec 同时可存活的实例数上限（默认 = 全局并发上限） */
  maxInstances?: number;
}

export interface SubAgentSpec {
  /** 契约 id（主 Agent 通过它来委派） */
  id: string;
  /** 人类可读标题 */
  title: string;
  /** 一句话职责（做什么） */
  responsibilities: string;
  /** 明确不做什么（边界清单，会写进系统提示词，也会出现在文档里） */
  notDo: string[];
  /** 工具白名单（必须是已注册工具的子集；顺序 = 披露顺序，保持稳定以利缓存） */
  tools: string[];
  /** 显式声明的权限集合：必须恰好等于 tools 所要求权限的并集 */
  permissions: string[];
  budget: SubAgentBudget;
  /**
   * 资源保留策略（重要性分级 + 闲置/年龄上限）。
   * 缺省 = `{ importance: 'ephemeral' }`（一次性任务，结果被采纳后立即释放）。
   * 显式声明 `session`/`durable` 的子 Agent 会进入「常驻池」，由生命周期管理器按闲置超时自动回收。
   */
  retention?: RetentionPolicy;
  /** 最大风险等级：spec 内所有工具的 riskLevel 不得超过它（用于审计） */
  maxRiskLevel: RiskLevel;
  /** 默认生成参数（可按 spec 分档：清点类关思考、分析类开低思考） */
  modelParams?: LLMGenerationParams;
  /** 输入约束（主 Agent 委派时必须满足；这里只做「必填字段」级别的校验） */
  requiredInputs?: string[];
  /** 越界时建议改派给谁（写进文档与提示词） */
  escalateTo: string[];
  /** 典型用途示例（文档与提示词都用） */
  examples: string[];
}

/**
 * 子任务上报 schema（终结性工具 submit_finding 使用）。
 * 放在 spec 模块里是因为它同时是「契约的一部分」——被 gen-agent-docs 与 lint 复用。
 */
export const subtaskReportSchema = z.object({
  summary: z.string().min(1).max(2000).describe('一句话结论（必填）'),
  // 数组元素允许「对象」或「字符串」两种写法（模型极常写字符串），
  // 字符串形式由 normalizeItems / normalizeFindings 归一化，不因形状问题丢掉有效结论。
  items: z
    .array(
      z.union([
        z.object({
          label: z.string().max(200),
          value: z.union([z.string().max(500), z.number()]),
          detail: z.string().max(1000).optional(),
        }),
        z.string().max(500),
      ]),
    )
    .max(50)
    .optional()
    .describe('结构化清单；元素可写对象 {label,value} 或字符串 "标签: 值"'),
  findings: z
    .array(
      z.union([
        z.object({ path: z.string().max(500), note: z.string().max(1000) }),
        z.string().max(1000),
      ]),
    )
    .max(80)
    .optional()
    .describe('逐条发现；元素可写对象 {path,note} 或字符串 "路径: 说明"'),
  evidence: z
    .array(z.string().max(500))
    .max(30)
    .optional()
    .describe('证据指针（文件路径/行号/URL），用于主 Agent 核验，不许凭空'),
  confidence: z.enum(['high', 'medium', 'low']).optional().describe('自评置信度；low 会提示主 Agent 复核'),
  escalateTo: z.enum(['codebase', 'research', 'misc', 'orchestrator', 'human']).optional(),
  escalateReason: z.string().max(500).optional(),
  artifacts: z.array(z.object({ label: z.string().max(200), content: z.string().max(20000) })).max(5).optional(),
});

export type SubtaskReportInput = z.infer<typeof subtaskReportSchema>;

// ---------------------------------------------------------------------------
// 三个内置子 Agent 契约
// ---------------------------------------------------------------------------

export const SUB_AGENT_SPECS: SubAgentSpec[] = [
  {
    id: 'dir-inventory',
    title: '目录清点子 Agent',
    responsibilities: '对一个目录做只读清点：文件数、大小、扩展名分布、最大/最新文件，并给出简短结论。',
    notDo: ['修改/删除/重命名任何文件', '执行命令', '访问网络', '读取敏感文件（.env / *.key）', '跨越给定目录边界'],
    tools: ['dir_stats', 'list_files', 'read_file', 'submit_finding'],
    // 注意：list_files / read_file 属于 codebase:read，dir_stats 属于 misc:read——
    // 权限必须**恰好**等于工具所需权限的并集（validateSpecs 会强制校验，多一个少一个都报错）
    permissions: ['misc:read', 'codebase:read', 'agent:report'],
    // 真实模型的实际步数远高于 Mock 剧本（会先 list_files、再 dir_stats、再抽查文件确认）：
    // 4 步/6 次工具调用实测会被打爆（见 docs/ERROR_REPORTING.md 事故复盘），故按实测放宽。
    budget: { maxSteps: 8, maxModelCalls: 8, maxToolCalls: 16, tokenBudget: 60000, totalTimeoutMs: 90000 },
    maxRiskLevel: 'safe',
    // 清点类是一次性任务：结果被主 Agent 采纳后立即释放上下文，不常驻。
    retention: { importance: 'ephemeral' },
    modelParams: { temperature: 0, thinking: 'disabled', maxTokens: 1200 },
    requiredInputs: ['dir'],
    escalateTo: ['codebase', 'human'],
    examples: ['清点 demo/codebase-sample 有多少文件、多大、扩展名分布如何'],
  },
  {
    id: 'code-audit',
    title: '代码审计子 Agent（只读）',
    responsibilities: '在指定目录内做只读代码审计：定位关键实现、检查可疑模式（TODO/FIXME、硬编码、缺少校验）、给出带文件路径的发现。',
    notDo: ['修改代码', '运行测试或任意命令', '联网', '读取仓库外的文件', '对未读过的文件下结论'],
    tools: ['search_files', 'list_files', 'read_file', 'submit_finding'],
    permissions: ['codebase:read', 'agent:report'],
    budget: { maxSteps: 12, maxModelCalls: 12, maxToolCalls: 24, tokenBudget: 120000, totalTimeoutMs: 150000 },
    maxRiskLevel: 'safe',
    // 代码审计常需「先报一批 TODO，主 Agent 追问某条细节」→ 保留会话供追问，闲置 5min 后释放。
    retention: { importance: 'session', idleTimeoutMs: 5 * 60_000 },
    // 思考 token 计入 max_tokens：2000 会被思考独占导致正文为空（事故 run_mv6afboo）→ 抬到 8192。
    modelParams: { temperature: 0, thinking: 'enabled', reasoningEffort: 'low', maxTokens: 8192 },
    requiredInputs: ['dir'],
    escalateTo: ['codebase', 'orchestrator', 'human'],
    examples: ['审计 src/ 下所有文件里的 TODO 与可疑硬编码，给出文件:行号'],
  },
  {
    id: 'doc-research',
    title: '资料调研子 Agent',
    responsibilities: '围绕一个具体问题检索公开资料或离线资料，提取证据并给出带来源的结论。',
    notDo: ['访问未授权域名', '把离线资料当成实时结果', '给出没有来源的断言', '访问内网/元数据地址'],
    tools: ['web_search', 'fetch_page', 'extract_evidence', 'knowledge_search', 'submit_finding'],
    permissions: ['research:web', 'research:read', 'knowledge:read', 'agent:report'],
    budget: { maxSteps: 8, maxModelCalls: 10, maxToolCalls: 16, tokenBudget: 80000, totalTimeoutMs: 120000 },
    maxRiskLevel: 'low',
    // 资料调研是典型一次性搜索：拿到带来源的结论即可丢弃上下文（避免搜索历史污染后续任务）。
    retention: { importance: 'ephemeral' },
    // 思考 token 计入 max_tokens：1600 会被思考独占导致正文为空（事故 run_mv6afboo）→ 抬到 8192。
    modelParams: { temperature: 0, thinking: 'enabled', reasoningEffort: 'low', maxTokens: 8192 },
    requiredInputs: ['topic'],
    escalateTo: ['research', 'human'],
    examples: ['调研 esbuild 与 rollup 在增量构建上的差异，附来源'],
  },
  {
    id: 'code-edit',
    title: '可写代码子 Agent（沙箱 + 人工审批）',
    responsibilities:
      '在仓库内做**受控修改**：新建/编辑/删除/复制文件、执行命令。所有改动先落到 Docker 沙箱并按检查阶梯（语法→类型→测试）验证，' +
      '再进入**一次批量人工审批**（完全同意此文件 / 仅同意本次 / 拒绝），通过后才会落盘并跑宿主复验（失败自动回滚）。',
    notDo: [
      '绕过沙箱直接改宿主文件（结构上做不到：写工具只落沙箱）',
      '修改敏感文件（.env/密钥/凭据；判定大小写不敏感，一律拒写）',
      '在未调用 submit_changes 的情况下宣称"改好了"（改动仍在沙箱里）',
      '为了让测试变绿而删测试或降低断言',
      '重试轮次用尽后换措辞反复提交（应如实上报 unresolved）',
    ],
    tools: [
      'search_files',
      'read_file',
      'list_files',
      'run_tests',
      'create_file',
      'edit_file',
      'delete_file',
      'copy_path',
      'run_command',
      'submit_changes',
      'submit_finding',
    ],
    permissions: ['codebase:read', 'codebase:test', 'codebase:write', 'agent:report'],
    // 预算为初始值，**待实测修正**（M1 定稿约定）：24 次工具调用在"读 + 改 + 重试"下可能偏紧。
    budget: { maxSteps: 12, maxModelCalls: 12, maxToolCalls: 24, tokenBudget: 120000, totalTimeoutMs: 600000 },
    maxRiskLevel: 'high',
    // 写类任务的结果需要可追问（改了哪些文件、为何被拒）→ session 级 + 5 分钟闲置回收
    retention: { importance: 'session' },
    modelParams: { temperature: 0, thinking: 'enabled', reasoningEffort: 'low', maxTokens: 8192 },
    requiredInputs: ['objective'],
    escalateTo: ['codebase', 'orchestrator', 'human'],
    examples: [
      '修复 src/utils/calc.ts 里 add() 的边界问题并补一条 tests 用例，改完走审批落盘',
      '给 src/tools/codebase/searchFiles.ts 增加 path 作用域参数并跑类型检查',
    ],
  },
];

export function getSpec(id: string): SubAgentSpec | undefined {
  return SUB_AGENT_SPECS.find((s) => s.id === id);
}

export function listSpecIds(): string[] {
  return SUB_AGENT_SPECS.map((s) => s.id);
}

// ---------------------------------------------------------------------------
// 写 spec 判定与派发可见性（M1'：界面写开关的运行时接线）
// ---------------------------------------------------------------------------

/**
 * 该 spec 是否携带写权限（`codebase:write`）。
 * 依据：`validateSpecs()` 强制「permissions 恰等于 tools 的权限并集」——含写工具 ⇔ 含写权限。
 * 写 spec 的派发需要**本 run 显式授权**（`orchestration.allowWriteSpecs`），见 `dispatchableSpecs`。
 */
export function isWriteSpec(spec: Pick<SubAgentSpec, 'permissions'>): boolean {
  return spec.permissions.includes('codebase:write');
}

/** id 版：未知 id 一律 false（存在性由调用方另行把关） */
export function isWriteSpecId(id: string): boolean {
  const s = getSpec(id);
  return !!s && isWriteSpec(s);
}

/**
 * 本次 run「可派发」的 spec 列表（用于编排主 Agent 的契约目录——软引导）。
 * 硬边界在另两处：delegate_subtasks 的守卫（未授权直接拒绝）与 spawnSubAgent 的兜底（结构层）。
 * @param opts.allowedSpecs 请求级白名单（空/缺省 = 全部）
 * @param opts.allowWriteSpecs 是否放行写 spec（调用方应传入最终判定：请求授权 && 部署门禁）
 */
export function dispatchableSpecs(opts: { allowedSpecs?: string[]; allowWriteSpecs?: boolean }): SubAgentSpec[] {
  return SUB_AGENT_SPECS.filter((sp) => {
    if (opts.allowedSpecs?.length && !opts.allowedSpecs.includes(sp.id)) return false;
    if (isWriteSpec(sp) && opts.allowWriteSpecs !== true) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// 契约自校验（装配时强制；lint 脚本复用）
// ---------------------------------------------------------------------------

export interface SpecIssue {
  specId: string;
  level: 'error' | 'warn';
  message: string;
}

/**
 * 校验 specs 与工具注册表一致。
 * @param toolPermission 工具名 → 所需权限（来自运行时的 TOOL_PERMISSION 表）
 * @param registeredTools 已注册的工具名
 */
export function validateSpecs(
  specs: SubAgentSpec[],
  toolPermission: Record<string, string>,
  registeredTools: string[],
  opts: {
    maxStepsHardLimit?: number;
    /** 注册表中的真实权限；优先于静态工具表，覆盖运行时注册的 MCP 等动态工具。 */
    toolPermissionByName?: Record<string, string>;
    /** 注册表中的真实风险等级，用于校验 spec.maxRiskLevel。 */
    toolRiskLevel?: Record<string, RiskLevel>;
  } = {},
): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const hardLimit = opts.maxStepsHardLimit ?? 20;
  const riskOrder: Record<RiskLevel, number> = { safe: 0, low: 1, medium: 2, high: 3 };

  for (const spec of specs) {
    // ① 工具必须已注册
    for (const t of spec.tools) {
      if (!registeredTools.includes(t)) {
        issues.push({ specId: spec.id, level: 'error', message: `工具未注册: ${t}` });
      }
    }
    // ② 权限必须恰好等于工具所需权限的并集（不能多 = 偷偷提权；不能少 = 跑不起来）
    const required = new Set<string>();
    for (const t of spec.tools) {
      const permission = opts.toolPermissionByName?.[t] ?? toolPermission[t];
      if (!permission) {
        issues.push({ specId: spec.id, level: 'error', message: `工具未声明权限映射: ${t}` });
      } else {
        required.add(permission);
      }
      const risk = opts.toolRiskLevel?.[t];
      if (risk && riskOrder[risk] > riskOrder[spec.maxRiskLevel]) {
        issues.push({
          specId: spec.id,
          level: 'error',
          message: `工具风险等级越界: ${t} 为 ${risk}，超过 spec.maxRiskLevel=${spec.maxRiskLevel}`,
        });
      }
    }
    const declared = new Set(spec.permissions);
    for (const p of required) {
      if (!declared.has(p)) {
        issues.push({ specId: spec.id, level: 'error', message: `缺少权限声明: ${p}（工具需要它）` });
      }
    }
    for (const p of declared) {
      if (!required.has(p)) {
        issues.push({ specId: spec.id, level: 'error', message: `权限超集: ${p}（没有任何声明的工具需要它）——等于偷偷提权` });
      }
    }
    // ③ 必须有终结性上报工具（否则结果无法结构化回传）
    const hasReportTool = spec.tools.some((t) => t === 'submit_finding');
    if (!hasReportTool) {
      issues.push({ specId: spec.id, level: 'error', message: '缺少终结性上报工具 submit_finding' });
    }
    // ④ 预算合理性
    if (spec.budget.maxSteps <= 0 || spec.budget.maxSteps > hardLimit) {
      issues.push({ specId: spec.id, level: 'error', message: `maxSteps 非法: ${spec.budget.maxSteps}（应在 1..${hardLimit}）` });
    }
    if (spec.budget.tokenBudget <= 0) {
      issues.push({ specId: spec.id, level: 'error', message: 'tokenBudget 必须为正数' });
    }
    if (spec.notDo.length === 0) {
      issues.push({ specId: spec.id, level: 'warn', message: 'notDo 为空：边界清单缺失（建议至少列出「不能改文件/不能跑命令」）' });
    }
    if (spec.examples.length === 0) {
      issues.push({ specId: spec.id, level: 'warn', message: 'examples 为空：主 Agent 缺少委派示例' });
    }
  }

  // ⑤ id 唯一
  const ids = new Set<string>();
  for (const spec of specs) {
    if (ids.has(spec.id)) issues.push({ specId: spec.id, level: 'error', message: 'spec id 重复' });
    ids.add(spec.id);
  }
  return issues;
}
