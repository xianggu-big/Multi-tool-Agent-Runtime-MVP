// scripts/gen-params-report.ts — 参数台账生成器（reports/PARAMETERS.md）
//
// 为什么要有它：参数（预算/上限/默认值/模型档位）是"改一处、影响一片"的东西，
// 手写文档必然漂移。这里直接**从代码读取当前生效值**并生成台账——
// 与 agents/*.md 同一套思路：文档从事实来源生成，人只维护"为什么这么改"（在 CHANGELOG 里）。
//
// 用法：npm run report:params
// 注意：读到的是**当前环境**（含 .env）下的生效值；密钥只输出"是否已配置"，绝不输出内容。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadEnv } from '../src/env.js';
import { loadConfig } from '../src/config.js';
import { SUB_AGENT_SPECS } from '../src/agents/specs.js';
import { LLM_PRESETS, PARAM_META, getPreset } from '../src/llm/presets.js';
import { TOOL_PERMISSION } from '../src/runtime/AgentRuntime.js';
import { buildRegistry } from '../src/tools/index.js';

loadEnv();
const config = loadConfig();
const registry = buildRegistry();

const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

function table(headers: string[], rows: (string | number)[][]): string {
  return [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

const lines: string[] = [
  '<!-- 本文件由 `npm run report:params` 从代码生成（src/config.ts / src/agents/specs.ts / src/llm/presets.ts）。',
  '     请不要手改：改参数请改代码或 .env，然后重新生成。参数的「为什么改」记在 reports/CHANGELOG.md。 -->',
  '',
  '# 参数台账（自动生成）',
  '',
  `> 生成时间：**${now}**（本机时区）· 来源：代码默认值 + 当前「.env」/环境变量`,
  '> 说明：这是**当前生效值**的快照。`.env` 一改，重新生成即可看到差异；历史变化请看 `reports/CHANGELOG.md` 的「参数变更」章节。',
  '',
  '## 1. LLM 接入',
  '',
  table(
    ['项', '当前值', '说明'],
    [
      ['LLM 模式', `\`${config.llmMode}\``, 'mock = 不调用真实模型；openai = 走真实 Provider'],
      ['默认预设', `\`${config.llm.presetId}\``, `预设清单：${LLM_PRESETS.map((p) => p.id).join(' / ')}`],
      ['API Key 是否已配置', config.llm.apiKey || config.openai.apiKey ? '✅ 已配置（内容不显示）' : '❌ 未配置', '按预设自动取用对应环境变量'],
      ['默认模型', `\`${getPreset(config.llm.presetId)?.defaultModel ?? config.openai.model}\``, '预设默认；界面可覆盖'],
    ],
  ),
  '',
  '### 1.1 生成参数默认值（env 层，可被界面/单次任务覆盖）',
  '',
  table(
    ['参数', '当前默认', '取值范围', '影响'],
    PARAM_META.map((m) => [
      `\`${m.key}\``,
      (config.llm.params as Record<string, unknown>)[m.key] === undefined
        ? '（未设置 → 用厂商默认）'
        : `\`${String((config.llm.params as Record<string, unknown>)[m.key])}\``,
      m.type === 'number' ? `${m.min}~${m.max}` : (m.enumValues ?? []).map((v) => v.value || '不指定').join(' / '),
      m.help.slice(0, 60) + (m.help.length > 60 ? '…' : ''),
    ]),
  ),
  '',
  '### 1.2 Provider 预设（模型清单 + 表价）',
  '',
  table(
    ['预设', 'Base URL', 'Key 环境变量', '默认模型', '表价（输入/缓存/输出，每 1M）'],
    LLM_PRESETS.map((p) => {
      const m = p.defaultModel ? p.models.find((x) => x.id === p.defaultModel) : p.models[0];
      return [
        `\`${p.id}\``,
        p.baseUrl || '（需手填）',
        `\`${p.apiKeyEnv}\``,
        m ? `\`${m.id}\`` : '—',
        m?.pricing ? `$${m.pricing.inputPerM} / $${m.pricing.cachedInputPerM ?? '-'} / $${m.pricing.outputPerM}` : '（未收录）',
      ];
    }),
  ),
  '',
  '## 2. 任务预算与上限',
  '',
  '### 2.1 全局默认（`.env` 或代码默认）',
  '',
  table(
    ['参数', '当前值', '说明'],
    [
      ['`DEFAULT_MAX_STEPS`', config.limits.maxSteps, '单任务最大 Agent Loop 步数'],
      ['`DEFAULT_MAX_MODEL_CALLS`', config.limits.maxModelCalls, '单任务最大模型调用次数'],
      ['`DEFAULT_MAX_TOOL_CALLS`', config.limits.maxToolCalls, '单任务最大工具调用次数'],
      ['`DEFAULT_TOTAL_TIMEOUT_MS`', config.limits.totalTimeoutMs, '单任务总超时'],
      ['`DEFAULT_TOKEN_BUDGET`', config.limits.tokenBudget, '单任务累计 token 预算（输入+输出）'],
      ['`DEFAULT_COST_BUDGET_USD`', config.limits.costBudgetUsd, '单任务费用预算（0 = 不限）'],
      ['`MAX_TOOL_CONCURRENCY`', config.maxToolConcurrency, '工具级并发上限'],
    ],
  ),
  '',
  '### 2.2 杂项 Agent（misc）',
  '',
  table(
    ['参数', '当前值', '说明'],
    [
      ['`MISC_MAX_STEPS`', config.misc.maxSteps, '默认步数（请求只能收紧）'],
      ['`MISC_MAX_MODEL_CALLS`', config.misc.maxModelCalls, '默认模型调用上限'],
      ['`MISC_MAX_TOOL_CALLS`', config.misc.maxToolCalls, '默认工具调用上限'],
      ['`MISC_TOKEN_BUDGET`', config.misc.tokenBudget, '默认 token 预算'],
      ['`MISC_HARD_MAX_STEPS`', config.misc.hardMaxSteps, '**硬上限**：请求放大也会被压回'],
      ['`MISC_SCAN_LIMIT`', config.misc.scanLimit, '目录扫描条目上限'],
      ['`MISC_MAX_FILE_BYTES`', config.misc.maxFileBytes, '单文件读取上限（字节）'],
      ['misc 默认生成参数', `\`${JSON.stringify(config.misc.defaultParams)}\``, '琐事默认关思考：更省更快'],
    ],
  ),
  '',
  '### 2.3 多 Agent 编排（orchestrator / subagent）',
  '',
  table(
    ['参数', '当前值', '说明'],
    [
      ['`SUBAGENT_MAX_CONCURRENCY`', config.subagent.maxConcurrency, '子任务并行度（有界池）'],
      ['`SUBAGENT_MAX_WIDTH`', config.subagent.maxWidth, '单次派发子任务数上限'],
      ['`SUBAGENT_MAX_DEPTH`', config.subagent.maxDepth, '层级深度（1 = 子 Agent 不能再委派）'],
      ['`SUBAGENT_RESULT_CHARS`', config.subagent.resultChars, '子任务结果回传主 Agent 的字符上限'],
      ['`ORCH_MAX_STEPS`', config.orchestrator.maxSteps, '主 Agent 步数上限'],
      ['`ORCH_MAX_MODEL_CALLS`', config.orchestrator.maxModelCalls, '主 Agent 模型调用上限'],
      ['`ORCH_MAX_TOOL_CALLS`', config.orchestrator.maxToolCalls, '主 Agent 工具调用上限'],
      ['`ORCH_TOKEN_BUDGET`', config.orchestrator.tokenBudget, '主 Agent token 预算（子 Agent 预算另计）'],
      ['`ORCH_TOTAL_TIMEOUT_MS`', config.orchestrator.totalTimeoutMs, '编排任务总超时'],
      ['`ORCH_ALLOW_SELF_TOOLS`', String(config.orchestrator.allowSelfTools), '主 Agent 是否也能用只读工具'],
    ],
  ),
  '',
  '### 2.4 子 Agent 契约预算（每个子 Agent 独立计提，互不侵占）',
  '',
  table(
    ['契约 id', '步数', '模型调用', '工具调用', 'token 预算', '超时(ms)', '工具白名单', '权限'],
    SUB_AGENT_SPECS.map((s) => [
      `\`${s.id}\``,
      s.budget.maxSteps,
      s.budget.maxModelCalls,
      s.budget.maxToolCalls,
      s.budget.tokenBudget,
      s.budget.totalTimeoutMs,
      s.tools.map((t) => `\`${t}\``).join(' '),
      s.permissions.map((p) => `\`${p}\``).join(' '),
    ]),
  ),
  '',
  '### 2.5 写能力 / Docker 沙箱 / 人工审批（M1/M1\'：默认可用；写操作需本 run 显式授权 + 审批）',
  '',
  table(
    ['参数', '当前值', '说明'],
    [
      ['`CODEBASE_WRITE_ENABLED`', String(config.codebase.writeEnabled), '写能力总门禁（默认 true，可显式 false 整机禁用；关时写工具一律 DISABLED，fail-closed）。实际写操作还须：本 run 界面授权 `orchestration.allowWriteSpecs`（默认不勾）+ 沙箱阶梯 + 人工审批'],
      ['`APPROVAL_ENABLED`', String(config.approval.enabled), '审批门禁开关（写能力开启后生效）'],
      ['`APPROVAL_TIMEOUT_MS`', config.approval.timeoutMs, '挂起审批超时（**超时按拒绝**；等待期暂停预算计时，不算进任务超时）'],
      ['`APPROVAL_MAX_DENIES`', config.approval.maxConsecutiveDenies, '同一文件连续拒绝上限（**按文件计数**，达上限强制收尾）'],
      ['`APPROVAL_MAX_FILES`', config.approval.maxFilesPerRequest, '单次审批的 change set 文件上限（一个 change set 一次审批，防打断疲劳）'],
      ['`SANDBOX_IMAGE`', `\`${config.sandbox.image}\``, '沙箱镜像（docker cp 快照 + L0/L1/L2 阶梯；**不用 bind mount**）'],
      ['`HOST_NODE_PATH`', `\`${config.sandbox.hostNodePath}\``, '宿主复验钉死的系统 Node 绝对路径（不存在则复验跳过并如实标注）'],
      ['`SANDBOX_EXEC_TIMEOUT_MS`', config.sandbox.execTimeoutMs, '沙箱/宿主单条命令超时上限'],
    ],
  ),
  '',
  '## 3. 实时流式展示',
  '',
  table(
    ['参数', '当前值', '说明'],
    [
      ['`STREAM_LIVE_DELTAS`', String(config.stream.liveDeltas), '是否推送文本增量（服务端入口默认开，测试默认关）'],
      ['`MOCK_STREAM_CHUNK_DELAY_MS`', config.stream.mockChunkDelayMs, '仅 Mock：分片演示延迟（真实 Provider 不受影响）'],
      ['`STREAM_CHUNK_CHARS`', config.stream.chunkChars, '单个增量分片字符数'],
      ['`STREAM_HEARTBEAT_MS`', config.stream.heartbeatMs, 'SSE 心跳间隔'],
      ['`STREAM_WATCHDOG_MS`', config.stream.watchdogMs, 'SSE 看门狗轮询间隔（补漏 + 终态收尾）'],
      ['`STREAM_DEBUG`', String(config.stream.debug), 'SSE 帧级调试日志'],
    ],
  ),
  '',
  '## 4. 工具与权限矩阵（注册 → 披露 → 授权）',
  '',
  table(
    ['工具', '所需权限', '归属 Agent（按 runType 披露）'],
    Object.keys(TOOL_PERMISSION).map((name) => {
      const perm = TOOL_PERMISSION[name];
      const owners: string[] = [];
      if (['search_files', 'read_file', 'list_files', 'run_tests'].includes(name)) owners.push('codebase');
      if (['web_search', 'fetch_page', 'extract_evidence', 'compare_sources'].includes(name)) owners.push('research');
      if (['dir_stats', 'submit_result'].includes(name)) owners.push('misc');
      if (['delegate_subtasks', 'submit_orchestration'].includes(name)) owners.push('orchestrator（主）');
      if (name === 'submit_finding') owners.push('子 Agent（各契约内声明）');
      return [`\`${name}\``, `\`${perm}\``, owners.join(' / ') || '—'];
    }),
  ),
  `\n> 已注册工具总数：${registry.names().length}；上表由 \`TOOL_PERMISSION\`（权限唯一事实来源）生成。`,
  '',
  '## 5. 错误报告与日志',
  '',
  table(
    ['参数', '当前值', '说明'],
    [
      ['`ERROR_LOG_PATH`', `\`${config.log.errorLogPath}\``, '结构化错误报告落盘（JSONL，可 grep）'],
      ['`RUN_DIGEST_PATH`', config.log.runDigestPath ? `\`${config.log.runDigestPath}\`` : '（留空 = 跟随 SQLite 目录）', '每次 run 终态的复盘摘要（JSONL，一行一个 run）'],
      ['`LOG_MAX_CONTENT_CHARS`', config.log.maxContentChars, '事件里字符串截断上限（防日志膨胀）'],
      ['`LOG_TOOL_RESULTS`', String(config.log.toolResults), '是否把工具结果正文打进日志'],
    ],
  ),
  '',
  '## 6. 存储与其它',
  '',
  table(
    ['参数', '当前值', '说明'],
    [
      ['`SQLITE_PATH`', `\`${config.sqlitePath}\``, 'SQLite 路径'],
      ['`PORT`', config.port, 'HTTP 端口'],
      ['`CODEBASE_RUN_TESTS_ENABLED`', String(config.codebase.runTestsEnabled), '是否允许 run_tests 真正执行命令'],
      ['`ALLOWED_TEST_COMMANDS`', config.codebase.allowedTestCommands.map((c) => `\`${c}\``).join(' '), '测试命令白名单'],
      ['`SEARCH_PROVIDER`', config.search.provider, '搜索提供方（offline / serper）'],
      ['搜索 Key 是否已配置', config.search.apiKey ? '✅ 已配置（内容不显示）' : '❌ 未配置', '无 Key 时走 OFFLINE_MOCK（明确标注）'],
    ],
  ),
  '',
  '---',
  '',
  '## 维护说明',
  '',
  '- **改参数**：改 `src/config.ts` 默认值 或 `.env`，然后 `npm run report:params` 重新生成本文件。',
  '- **记原因**：在 `reports/CHANGELOG.md` 的「参数变更」里加一行（日期 / 参数 / 旧值 → 新值 / 为什么）。',
  '- **看现状**：`reports/PROJECT_REPORT.md` 是给人读的总报告（能力 / 指标 / 风险 / 下一步）。',
  '- 本文件**不做漂移门禁**：它的值随环境变化（例如 `.env` 里配了 Key），属于"当前生效值快照"，不是契约。',
  '',
];

const outPath = resolve('reports/PARAMETERS.md');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, lines.join('\n'), 'utf8');
console.log(`[report:params] 已生成 ${outPath}（${lines.join('\n').length} 字节）`);
console.log(`  当前：LLM=${config.llmMode}/${config.llm.presetId} · misc=${config.misc.maxSteps}步/${config.misc.tokenBudget}tok · 编排=${config.subagent.maxWidth}宽×${config.subagent.maxConcurrency}并发`);
