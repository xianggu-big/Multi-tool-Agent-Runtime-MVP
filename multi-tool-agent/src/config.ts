// src/config.ts — 从环境变量构建运行时配置
// 关键原则：任何密钥（API Key）只能从环境变量读取，禁止硬编码。

import { getEnv, getBool, getInt, getList } from './env.js';
import type { LLMGenerationParams } from './types.js';
import { DEFAULT_PRESET_ID } from './llm/presets.js';
import { parseMcpServers, type McpServerConfig } from './mcp/config.js';

export interface RuntimeConfig {
  llmMode: 'mock' | 'openai';
  openai: {
    apiKey?: string;
    baseUrl: string;
    model: string;
    /** OPENAI_BASE_URL / OPENAI_MODEL 是否由用户显式配置（显式配置优先于预设默认值） */
    baseUrlExplicit?: boolean;
    modelExplicit?: boolean;
  };
  /** LLM 预设与默认生成参数（env 层默认值；单次任务可覆盖） */
  llm: {
    /** Provider 预设 id（deepseek / openai / qwen / ... / custom） */
    presetId: string;
    /** LLM_PROVIDER 是否被显式设置（显式设置时预设优先于 OPENAI_* 兼容变量） */
    presetExplicit: boolean;
    /** 通用 Key（LLM_API_KEY / DEEPSEEK_API_KEY 等，按预设环境变量名解析） */
    apiKey?: string;
    /** 默认生成参数（LLM_TEMPERATURE / LLM_MAX_TOKENS / ...） */
    params: LLMGenerationParams;
  };
  search: { provider: 'offline' | 'serper'; apiKey?: string; baseUrl: string };
  limits: {
    maxSteps: number;
    maxModelCalls: number;
    maxToolCalls: number;
    totalTimeoutMs: number;
    tokenBudget: number;
    costBudgetUsd: number;
  };
  maxToolConcurrency: number;
  sqlitePath: string;
  codebase: {
    runTestsEnabled: boolean;
    allowedTestCommands: string[];
    /** 写能力总开关（M1；默认 false = fail-closed：沙箱/审批任一不可用即不写） */
    writeEnabled: boolean;
  };
  /** 三级人工审批（M1）：完全同意此文件 / 同意本次 / 拒绝 */
  approval: {
    enabled: boolean;
    /** 等待人工审批的超时（毫秒；超时按拒绝处理） */
    timeoutMs: number;
    /** 同一文件连续拒绝达到该次数 → 强制收尾上报（v3-3：按文件计数） */
    maxConsecutiveDenies: number;
    /** 单个审批请求最多打包的文件数（change set 批量审批，防"10 文件 10 次打断"） */
    maxFilesPerRequest: number;
  };
  /** Docker 沙箱（M1）：改前试跑环境 */
  sandbox: {
    image: string;
    /** 宿主复验用的系统 Node 24 绝对路径（评审 P1-8：PATH 里的 Node 可能 ABI 不匹配） */
    hostNodePath: string;
    /** 沙箱单条命令超时（毫秒） */
    execTimeoutMs: number;
    /** 提交前是否跑 L2 全量（默认 false：落盘后还会做宿主全量复验，避免默认双跑） */
    l2BeforeApproval: boolean;
  };
  /** 崩溃对账（落盘意图日志 + 启动扫描） */
  recovery: {
    /**
     * 启动时自动恢复「编辑操作 + 文件在崩溃窗口内消失 + 有原文备份」。
     * 只处理这一种确定性的坏状态；已落盘的编辑/新增永不自动回滚（避免覆盖用户后续修改）。
     */
    autoRestoreMissing: boolean;
  };
  /** 多 Agent 编排：子任务默认预算 + 并发/宽度/深度上限 */
  subagent: {
    maxConcurrency: number;
    maxWidth: number;
    maxDepth: number;
    resultChars: number;
  };
  /** MCP 客户端（Streamable HTTP）：默认不连接任何外部 server。 */
  mcp: {
    servers: McpServerConfig[];
    /** 启动桥接成功后由 McpClientRuntime 回填；供工具池按 runType 暴露。 */
    toolNames: string[];
  };
  /** 编排主 Agent 的默认预算 */
  orchestrator: {
    maxSteps: number;
    maxModelCalls: number;
    maxToolCalls: number;
    tokenBudget: number;
    totalTimeoutMs: number;
    /** 默认是否把只读工具也给主 Agent（false = 主 Agent 只委派+汇总，边界更干净） */
    allowSelfTools: boolean;
  };
  /** 杂项 Agent（只读、低优先级琐事）的默认预算与边界 */
  misc: {
    maxSteps: number;
    maxModelCalls: number;
    maxToolCalls: number;
    tokenBudget: number;
    /** 目录扫描条目上限（防止在大目录上长时间空转） */
    scanLimit: number;
    /** 单文件读取上限（字节） */
    maxFileBytes: number;
    /** 硬上限：即使请求方指定更大的 maxSteps 也不会超过它 */
    hardMaxSteps: number;
    /** 默认生成参数（琐事不需要思考链：更省更快） */
    defaultParams: LLMGenerationParams;
  };
  port: number;
  log: {
    maxContentChars: number;
    toolResults: boolean;
    /** 统一错误报告（JSONL）落盘路径；便于事后 grep 取证 */
    errorLogPath: string;
    /** 每次 run 终态的复盘摘要（JSONL，一行一个 run：成功也写、失败优先）。
     *  留空 = 自动跟随 SQLite 目录（`<dataDir>/run-digest.jsonl`）；`:memory:`（测试）不落盘。 */
    runDigestPath: string;
  };
  /** 实时流式展示（Live View）配置 */
  stream: {
    /** 是否把模型增量（llm_delta）通过实时通道推送（不落盘）。 */
    liveDeltas: boolean;
    /** 仅 Mock：分片之间的演示延迟（毫秒）；0 = 全速（测试/CI 应为 0）。 */
    mockChunkDelayMs: number;
    /** 单个 delta 的最大字符数（Mock 分片粒度）。 */
    chunkChars: number;
    /** SSE 心跳间隔（毫秒）。 */
    heartbeatMs: number;
    /** SSE 看门狗轮询间隔（毫秒）：补漏 + 终态收尾。 */
    watchdogMs: number;
    /** 是否输出 SSE 连接与帧级调试日志。 */
    debug: boolean;
  };
}

export function loadConfig(): RuntimeConfig {
  const llmModeRaw = getEnv('LLM_MODE', 'mock').toLowerCase();
  const llmMode = llmModeRaw === 'openai' ? 'openai' : 'mock';

  const searchRaw = getEnv('SEARCH_PROVIDER', 'offline').toLowerCase();
  const searchProvider = searchRaw === 'serper' ? 'serper' : 'offline';

  // 是否显式配置过（空串视为未配置）——用于决定「预设默认值」与「旧 OPENAI_* 变量」谁优先
  const openaiBaseUrlEnv = getEnv('OPENAI_BASE_URL');
  const openaiModelEnv = getEnv('OPENAI_MODEL');
  const presetEnv = getEnv('LLM_PROVIDER');

  return {
    llmMode,
    openai: {
      apiKey: getEnv('OPENAI_API_KEY') || undefined,
      baseUrl: openaiBaseUrlEnv || 'https://api.openai.com/v1',
      model: openaiModelEnv || 'gpt-4o-mini',
      baseUrlExplicit: !!openaiBaseUrlEnv,
      modelExplicit: !!openaiModelEnv,
    },
    llm: {
      presetId: presetEnv ? presetEnv.toLowerCase() : DEFAULT_PRESET_ID,
      presetExplicit: !!presetEnv,
      // 通用 Key：优先 LLM_API_KEY，其次各家标准变量名（由 createProvider 按预设再兜底）
      apiKey: getEnv('LLM_API_KEY') || getEnv('DEEPSEEK_API_KEY') || undefined,
      params: readLLMParams(),
    },
    search: {
      provider: searchProvider,
      apiKey: getEnv('SEARCH_API_KEY') || undefined,
      baseUrl: getEnv('SEARCH_BASE_URL', 'https://google.serper.io/search'),
    },
    limits: {
      maxSteps: getInt('DEFAULT_MAX_STEPS', 12),
      maxModelCalls: getInt('DEFAULT_MAX_MODEL_CALLS', 20),
      maxToolCalls: getInt('DEFAULT_MAX_TOOL_CALLS', 40),
      totalTimeoutMs: getInt('DEFAULT_TOTAL_TIMEOUT_MS', 120000),
      tokenBudget: getInt('DEFAULT_TOKEN_BUDGET', 200000),
      costBudgetUsd: Number(getEnv('DEFAULT_COST_BUDGET_USD', '0')) || 0,
    },
    maxToolConcurrency: getInt('MAX_TOOL_CONCURRENCY', 4),
    sqlitePath: getEnv('SQLITE_PATH', './data/runtime.db'),
    subagent: {
      maxConcurrency: clamp(getInt('SUBAGENT_MAX_CONCURRENCY', 4), 1, 8),
      maxWidth: clamp(getInt('SUBAGENT_MAX_WIDTH', 4), 1, 8),
      // MVP 固定为 1：子 Agent 结构上无法再派子 Agent（ctx 不注入 spawnSubAgent）
      maxDepth: clamp(getInt('SUBAGENT_MAX_DEPTH', 1), 1, 2),
      resultChars: clamp(getInt('SUBAGENT_RESULT_CHARS', 800), 200, 4000),
    },
    mcp: {
      servers: parseMcpServers(getEnv('MTA_MCP_SERVERS')),
      toolNames: [],
    },
    orchestrator: {
      maxSteps: clamp(getInt('ORCH_MAX_STEPS', 8), 1, 20),
      maxModelCalls: clamp(getInt('ORCH_MAX_MODEL_CALLS', 12), 1, 30),
      maxToolCalls: clamp(getInt('ORCH_MAX_TOOL_CALLS', 12), 1, 60),
      tokenBudget: clamp(getInt('ORCH_TOKEN_BUDGET', 200000), 1000, 2000000),
      totalTimeoutMs: clamp(getInt('ORCH_TOTAL_TIMEOUT_MS', 300000), 5000, 900000),
      allowSelfTools: getBool('ORCH_ALLOW_SELF_TOOLS', false),
    },
    misc: {
      maxSteps: clamp(getInt('MISC_MAX_STEPS', 6), 1, 20),
      maxModelCalls: clamp(getInt('MISC_MAX_MODEL_CALLS', 6), 1, 20),
      maxToolCalls: clamp(getInt('MISC_MAX_TOOL_CALLS', 10), 1, 40),
      tokenBudget: clamp(getInt('MISC_TOKEN_BUDGET', 50000), 1000, 1000000),
      scanLimit: clamp(getInt('MISC_SCAN_LIMIT', 5000), 100, 50000),
      maxFileBytes: clamp(getInt('MISC_MAX_FILE_BYTES', 262144), 1024, 4 * 1024 * 1024),
      hardMaxSteps: clamp(getInt('MISC_HARD_MAX_STEPS', 12), 1, 40),
      // 默认关闭思考、温度 0：杂项任务要的是确定性 + 便宜 + 快
      defaultParams: { temperature: 0, thinking: 'disabled', maxTokens: 1500 },
    },
    codebase: {
      runTestsEnabled: getBool('CODEBASE_RUN_TESTS_ENABLED', false),
      allowedTestCommands: getList('ALLOWED_TEST_COMMANDS', [
        'npm test',
        'node --test',
        'npx vitest run',
      ]),
      // M1'（2026-10-16）：默认「可用」——写工具不再被隐藏，但写操作需三层把关：
      //   ① 本 run 显式授权（界面「允许修改文件」开关 → orchestration.allowWriteSpecs）
      //   ② Docker 沙箱暂存 + 检查阶梯（语法/类型/测试）
      //   ③ 落盘前人工审批卡（三级决定）
      // 如需整机禁用（例如共享部署），显式设置 CODEBASE_WRITE_ENABLED=false（UI 会显示为被禁用）。
      writeEnabled: getBool('CODEBASE_WRITE_ENABLED', true),
    },
    approval: {
      enabled: getBool('APPROVAL_ENABLED', true),
      timeoutMs: clamp(getInt('APPROVAL_TIMEOUT_MS', 300000), 10000, 3600000),
      maxConsecutiveDenies: clamp(getInt('APPROVAL_MAX_DENIES', 3), 1, 20),
      maxFilesPerRequest: clamp(getInt('APPROVAL_MAX_FILES', 10), 1, 50),
    },
    sandbox: {
      image: getEnv('SANDBOX_IMAGE', 'mta-sandbox:node24'),
      hostNodePath: getEnv('HOST_NODE_PATH', 'D:/Program Files/nodejs/node.exe'),
      execTimeoutMs: clamp(getInt('SANDBOX_EXEC_TIMEOUT_MS', 600000), 30000, 1800000),
      l2BeforeApproval: getBool('SANDBOX_L2_BEFORE_APPROVAL', false),
    },
    recovery: {
      autoRestoreMissing: getBool('RECOVERY_AUTO_RESTORE_MISSING', true),
    },
    port: getInt('PORT', 3000),
    log: {
      maxContentChars: getInt('LOG_MAX_CONTENT_CHARS', 2000),
      toolResults: getBool('LOG_TOOL_RESULTS', false),
      errorLogPath: getEnv('ERROR_LOG_PATH', './data/errors.log'),
      runDigestPath: getEnv('RUN_DIGEST_PATH', ''),
    },
    stream: {
      // 默认关闭：测试/脚本零开销、行为与引入前一致；服务端入口（src/index.ts）会默认开启。
      liveDeltas: getBool('STREAM_LIVE_DELTAS', false),
      mockChunkDelayMs: clamp(getInt('MOCK_STREAM_CHUNK_DELAY_MS', 0), 0, 2000),
      chunkChars: clamp(getInt('STREAM_CHUNK_CHARS', 18), 1, 500),
      // 心跳不小于 1s、看门狗不小于 250ms，避免误配置导致定时器空转（热循环）
      heartbeatMs: clamp(getInt('STREAM_HEARTBEAT_MS', 15000), 1000, 600000),
      watchdogMs: clamp(getInt('STREAM_WATCHDOG_MS', 2000), 250, 60000),
      debug: getBool('STREAM_DEBUG', false),
    },
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}

/**
 * 从环境变量读取默认生成参数。
 * 约定：**未配置 = undefined = 不发送该字段**（交给厂商默认值），而不是塞一个「我们的默认值」。
 * 只有显式配置了才会出现在请求体里，便于对照排查「这个参数到底有没有生效」。
 */
function readLLMParams(): LLMGenerationParams {
  const params: LLMGenerationParams = {};
  const num = (key: string): number | undefined => {
    const raw = getEnv(key);
    if (raw === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };

  const maxTokens = num('LLM_MAX_TOKENS');
  if (maxTokens !== undefined) params.maxTokens = Math.max(1, Math.floor(maxTokens));
  const temperature = num('LLM_TEMPERATURE');
  if (temperature !== undefined) params.temperature = clamp(temperature, 0, 2);
  const topP = num('LLM_TOP_P');
  if (topP !== undefined) params.topP = clamp(topP, 0, 1);
  const frequencyPenalty = num('LLM_FREQUENCY_PENALTY');
  if (frequencyPenalty !== undefined) params.frequencyPenalty = clamp(frequencyPenalty, -2, 2);
  const presencePenalty = num('LLM_PRESENCE_PENALTY');
  if (presencePenalty !== undefined) params.presencePenalty = clamp(presencePenalty, -2, 2);

  const thinking = getEnv('LLM_THINKING').toLowerCase();
  if (thinking === 'enabled' || thinking === 'disabled') params.thinking = thinking;
  const effort = getEnv('LLM_REASONING_EFFORT').toLowerCase();
  if (effort === 'low' || effort === 'high' || effort === 'max') params.reasoningEffort = effort;

  return params;
}
