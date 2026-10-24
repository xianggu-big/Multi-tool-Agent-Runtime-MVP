// src/index.ts — 服务入口
import { loadEnv } from './env.js';
import { assertHttpSecurity, isLoopbackHost, loadConfig } from './config.js';
import { createApp } from './server.js';
import { removeOrphanSandboxContainers } from './sandbox/docker.js';

loadEnv();

const config = loadConfig();
assertHttpSecurity(config);

// 开发服务器默认开启实时流式展示（Live View）。
// 若需要与测试/CI 一致的「零增量事件」行为，显式设置 STREAM_LIVE_DELTAS=false。
if (process.env.STREAM_LIVE_DELTAS === undefined) config.stream.liveDeltas = true;
// Mock 演示节奏：让无 Key 的演示也能肉眼看到文本逐字输出（真实 Provider 不受此影响）。
if (process.env.MOCK_STREAM_CHUNK_DELAY_MS === undefined) config.stream.mockChunkDelayMs = 25;

const { app, errors, recovery, mcpRuntime, scheduler, runtime, store, logger } = createApp(config);
const port = config.port;

// 定时任务：只在服务进程里启动（buildRuntime/测试不启动，避免测试触发真实 run）。
scheduler.start();

// 优雅退出：停调度 → 停止接新请求 → 中止在飞 run → 关 MCP → flush 事件 → 关 DB。
// 5s 兜底强制退出，避免 SSE/子进程挂住进程。
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] 收到 ${signal}：停止调度与在飞任务…`);
  const force = setTimeout(() => {
    console.error('[shutdown] 超时，强制退出');
    process.exit(1);
  }, 5000);
  force.unref();
  scheduler.stop();
  const cancelled = runtime.cancelAllActive();
  server.close();
  // 给 SSE/keep-alive 连接一个结束窗口，然后强制断开。
  setTimeout(() => {
    try {
      server.closeAllConnections();
    } catch {
      /* 老版本 Node 没有该方法 */
    }
  }, 1000).unref();
  const leftover = await runtime.waitForIdle(2000);
  await mcpRuntime.close().catch(() => {});
  logger.flush();
  try {
    store.close();
  } catch {
    /* 已关闭 */
  }
  console.log(`[shutdown] 完成（中止 ${cancelled} 个 run${leftover ? `，仍有 ${leftover} 个未退出` : ''}）`);
  clearTimeout(force);
  process.exit(0);
}

// 沙箱容器孤儿回收（M1'，原在 buildRuntime 内）：沙箱会话不跨进程，本次启动时残留的
// mta-sb-* 必为上一次进程的孤儿。放在服务入口执行——buildRuntime 还被测试/演示脚本复用，
// 不应碰 Docker；部署显式禁用写能力（CODEBASE_WRITE_ENABLED=false）时跳过。
if (config.codebase.writeEnabled) {
  try {
    const n = removeOrphanSandboxContainers();
    if (n > 0) console.log(`[startup] 回收了 ${n} 个残留沙箱容器（mta-sb-*）`);
  } catch (e) {
    console.warn(`[startup] 沙箱容器孤儿回收失败（忽略，不影响启动）：${(e as Error).message}`);
  }
}

// 崩溃对账（落盘意图日志 + 启动扫描）：必须在开始接请求之前跑完。
// 只对上次进程中断的 run 生效；自动恢复「编辑 + 文件消失 + 有备份」这一种确定性坏状态，
// 已落盘的编辑/新增不自动回滚（避免覆盖用户后续修改），由 /api/runs/:id/recovery 交给人决定。
try {
  const recovered = await recovery.startupSweep();
  if (recovered.length > 0) {
    console.log(`[startup] 崩溃对账：${recovered.length} 个 run 需要关注（GET /api/recovery）`);
  }
} catch (e) {
  console.warn(`[startup] 崩溃对账失败（忽略，不影响启动）：${(e as Error).message}`);
}

// ---------------------------------------------------------------------------
// 进程级兜底：未捕获异常 / 未处理的 Promise 拒绝
// 说明：本地工具**不主动退出**（退出会让你连"发生了什么"都看不到），
//       但会打印醒目的警示 + 落盘一份报告；若状态可疑，请重启服务。
// ---------------------------------------------------------------------------
process.on('unhandledRejection', (reason) => {
  const r = errors.report({
    source: 'server',
    phase: 'process:unhandledRejection',
    error: reason,
    code: 'UNHANDLED_REJECTION',
    context: { tip: '这是未处理的 Promise 拒绝；通常是某处 async 调用缺少 catch' },
  });
  console.error(`[fatal-ish] 未处理的 Promise 拒绝（${r.id}）：见 ${config.log.errorLogPath}；服务继续运行，但状态可能不一致。`);
});

process.on('uncaughtException', (e) => {
  const r = errors.report({
    source: 'server',
    phase: 'process:uncaughtException',
    error: e,
    code: 'UNCAUGHT_EXCEPTION',
    context: { tip: '这是同步未捕获异常；请优先修复，必要时重启服务' },
  });
  console.error(`[fatal-ish] 未捕获异常（${r.id}）：见 ${config.log.errorLogPath}；服务继续运行，但状态可能不一致。`);
});

const server = app.listen(port, config.host, () => {
  const shownHost = isLoopbackHost(config.host) ? 'localhost' : config.host;
  console.log(`multi-tool-agent 已启动: http://${shownHost}:${port}`);
  if (!isLoopbackHost(config.host)) {
    console.log(`[security] 非回环监听：已启用 Bearer token（MTA_AUTH_TOKEN）`);
  }
  console.log(`LLM 模式: ${config.llmMode}${config.llmMode === 'mock' ? '（Mock，无需 API Key）' : ''}`);
  console.log(
    `实时流式: ${config.stream.liveDeltas ? `开启（Mock 分片延迟 ${config.stream.mockChunkDelayMs}ms）` : '关闭（STREAM_LIVE_DELTAS=false）'}`,
  );
  console.log(`定时任务: 已启动（进程内，每 30s 检查；服务停止期间不触发）`);
  console.log(`Codex: ${config.codex.enabled ? `可用（${config.codex.bin}${config.codex.model ? ` · ${config.codex.model}` : ''}）` : '已禁用（MTA_CODEX_ENABLED=false）'}`);
  if (config.llmMode === 'mock') {
    console.log('提示: 通过 POST /api/runs 并指定 mockScenario=codebase-basic|research-basic 可运行演示。');
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}
