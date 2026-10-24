// src/runtime/index.ts — 组装 Runtime（store + logger + hub + tracer + registry + runtime + knowledge）
import type { RuntimeConfig } from '../config.js';
import { getBool } from '../env.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { EventLogger } from '../trace/EventLogger.js';
import { LiveHub } from '../trace/LiveHub.js';
import { Tracer } from '../trace/Tracer.js';
import { ErrorReporter } from './errorReporter.js';
import { buildRegistry } from '../tools/index.js';
import { AgentRuntime } from './AgentRuntime.js';
import { KnowledgeHub } from '../knowledge/index.js';
import { VerificationService } from './VerificationService.js';
import { RecoveryService } from './RecoveryService.js';
import { PendingActionService } from './PendingActionService.js';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

export interface RuntimeBundle {
  store: SqliteStore;
  logger: EventLogger;
  hub: LiveHub;
  tracer: Tracer;
  errors: ErrorReporter;
  registry: ReturnType<typeof buildRegistry>;
  runtime: AgentRuntime;
  /** 终态 run 的手动 L2 深度验证（宿主全量测试，异步任务） */
  verification: VerificationService;
  /** 崩溃对账：启动扫描 + 手动回滚/保留（落盘意图日志见 src/sandbox/applyJournal.ts） */
  recovery: RecoveryService;
  /** 无人值守高危操作的事后确认队列（定时任务删除/命令） */
  pendingActions: PendingActionService;
  /** 知识系统：上下文管理 + 历史与变更追踪 + 数据仓库（三模块互通） */
  knowledge: KnowledgeHub;
}

export function buildRuntime(config: RuntimeConfig, sqlitePath?: string): RuntimeBundle {
  const dbPath = sqlitePath ?? config.sqlitePath;
  const store = new SqliteStore(dbPath);
  // 与 AgentRuntime.getSandboxSession 保持同一口径：SQLite 所在目录即 data/ 根。
  const dataDir = dbPath === ':memory:' ? resolve('./data') : dirname(resolve(dbPath));
  // 复盘摘要 JSONL：默认与 SQLite 同目录（生产 = ./data/run-digest.jsonl；测试的临时库 = 临时目录）。
  // `:memory:` 不落盘——避免每次跑测试都往仓库 data/ 里追加几十行 mock 记录（R17 教训）。
  // 注：这里就地补默认值是组装根的职责（loadConfig 不关心"DB 在哪"，拿不到 dataDir）。
  config.log.runDigestPath =
    dbPath === ':memory:' ? '' : config.log.runDigestPath || resolve(dataDir, 'run-digest.jsonl');
  const hub = new LiveHub();
  // 事件经异步批量缓冲落盘（onPersistBatch），避免在 Agent Loop 主路径上同步写库；
  // 同时通过 onLive 走实时快车道，供 SSE 立即推送（不等落盘）。
  const logger = new EventLogger({
    maxContentChars: config.log.maxContentChars,
    onPersistBatch: (events) => store.appendEvents(events),
    onLive: (e) => hub.publish(e),
  });
  const tracer = new Tracer(logger);
  // 统一错误报告器：① 产生 runtime_error 事件（前端实时可见、可回放） ② 追加 JSONL 日志（可 grep）
  const errors = new ErrorReporter({
    logPath: config.log.errorLogPath,
    maxLogBytes: config.log.errorLogMaxBytes,
    emit: (runId, type, data) => tracer.emit(runId, type, data),
  });
  const knowledge = new KnowledgeHub(store.database, tracer, errors, {
    // 写入后后台补索引：默认关（测试/导入脚本不需要后台任务），服务端可通过 env 开启
    backgroundIndex: getBool('MTA_RAG_BACKGROUND_INDEX', false),
  });
  // RAG 主链路：模型通过 function calling 调 knowledge_search，而不是只暴露 HTTP 检索。
  const registry = buildRegistry(knowledge);
  const runtime = new AgentRuntime(config, registry, store, tracer, errors);
  // 终态 run 追加事件前的序号校准：先 flush，避免读到落后的 maxSeq 后与新事件撞主键。
  const prepareTerminalEvent = (runId: string) => {
    logger.flush();
    const maxSeq = store.getEvents(runId).reduce((m, e) => Math.max(m, e.seq), 0);
    logger.ensureSeqAtLeast(runId, maxSeq);
  };
  const verification = new VerificationService({
    nodePath: config.sandbox.hostNodePath,
    timeoutMs: config.sandbox.execTimeoutMs,
    emit: (runId, type, data) => tracer.emit(runId, type, data),
    prepareEvent: prepareTerminalEvent,
    maxConcurrent: 1,
  });
  const recovery = new RecoveryService({
    dataDir,
    store,
    autoRestoreMissing: config.recovery.autoRestoreMissing,
    emit: (runId, type, data) => tracer.emit(runId, type, data),
    prepareEvent: prepareTerminalEvent,
  });
  const pendingActions = new PendingActionService(
    store,
    config,
    (runId, type, data) => tracer.emit(runId, type, data),
    prepareTerminalEvent,
  );

  // -------------------------------------------------------------------------
  // 启动回收：孤儿运行（上次进程被杀/重启时状态仍是 running 的行）
  // 背景：内存里的执行循环随进程消失，但这些行永远不会再被推进——会永久污染
  //       列表/统计，UI 上看起来"还在跑"。这里统一收口成 failed + 一条 runtime_error 事件 +
  //       一条 audit 记录（知识系统「变更追踪」的首个真实用例），三者共用 correlationId 可追溯。
  // 注意：只应在单实例服务的启动阶段调用——本进程刚启动时，DB 里仍在 running 的行必为孤儿。
  // -------------------------------------------------------------------------
  // M1'（2026-10-16）：沙箱容器孤儿回收已挪到**服务入口**（src/index.ts）执行——
  // buildRuntime 同时被测试/演示脚本复用，而容器回收会真实操作 Docker（并发误杀风险）；
  // 只在 `npm start` 的服务进程里做，且部署显式禁用写能力（CODEBASE_WRITE_ENABLED=false）时跳过。

  const orphans = store.listOrphanRuns();
  for (const o of orphans) {
    const correlationId = `corr_orphan_${randomUUID().slice(0, 8)}`;
    const rep = errors.report({
      source: 'server',
      phase: 'startup:interrupt-orphan-run',
      code: 'RUN_INTERRUPTED',
      runId: o.runId,
      skipEvent: true, // 事件落点由 finalizeInterruptedRun 接续历史序号写入
      message: `运行在服务重启时被中断（进程退出后无人推进），已标记为 failed（非执行失败）：${o.runType}「${o.goal.slice(0, 60)}」`,
      context: { runType: o.runType, goal: o.goal, lastEventSeq: o.maxSeq, lastUpdateAt: o.updatedAt },
    });
    store.finalizeInterruptedRun(o.runId, {
      at: rep.at,
      errorCode: rep.code,
      failureReason: rep.message,
      eventData: {
        errorId: rep.id,
        correlationId,
        source: rep.source,
        phase: rep.phase,
        errorType: rep.errorType,
        code: rep.code,
        message: rep.message,
        hint: rep.hint,
        context: rep.context,
      },
    });
    knowledge.history.record({
      correlationId,
      actor: 'system',
      action: 'run_interrupted',
      resourceType: 'run',
      resourceId: o.runId,
      before: { status: 'running', lastEventSeq: o.maxSeq },
      after: { status: 'failed', errorCode: 'RUN_INTERRUPTED' },
      meta: { errorId: rep.id, runType: o.runType, goal: o.goal },
      at: rep.at,
    });
    // 「一个流程都跑不完」的被中断 run 同样要留复盘摘要（否则它只在 runs 表里留一行 failed）
    runtime.recordRunDigest(o.runId, { forgetSeq: true });
  }
  if (orphans.length) {
    console.log(`[startup] 回收了 ${orphans.length} 个上次进程中断的孤儿运行（已记入审计，correlationId 见 GET /api/history?action=run_interrupted）`);
  }

  return { store, logger, hub, tracer, errors, registry, runtime, knowledge, verification, recovery, pendingActions };
}
