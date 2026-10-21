// src/sandbox/hostVerify.ts — 宿主侧全量验证（沙箱是 Linux，宿主是 Windows，必须复验）
//
// 写工具（落盘后复验）与手动 L2 验证共用同一套执行语义：
//   - 钉死系统 Node 绝对路径（PATH 里的 Node 可能 ABI 不匹配）；
//   - 剔除本应用运行期配置键（避免「服务用独立端口/库启动」污染测试结论）；
//   - 异步 + 超时 + 取消 + 输出上限（不冻结 HTTP/SSE 事件循环）。
import { existsSync } from 'node:fs';
import { spawnAsync } from './exec.js';
import { resolveVerificationPlan, type VerificationMode } from './verificationPlan.js';

/**
 * 宿主复验的「净环境」：剔除**本应用自己的配置键**后再 spawn 测试套件。
 *
 * 为什么需要它（2026-10-15 端到端实测）：hostVerify 默认继承 server 进程的环境。
 * 只要 server 用非默认 env 启动，复验套件就会继承这些键而失败——实测
 * `LLM_MODE=openai PORT=3033 SQLITE_PATH=./data/m1-e2e.db CODEBASE_WRITE_ENABLED=true`
 * 下套件 8 条用例失败（都在读 env / loadConfig()）。后果是复验恒失败 → 改动被自动回滚。
 */
export const HOST_VERIFY_ENV_DENY =
  /^(LLM_|OPENAI_|DEEPSEEK_|CODEBASE_|APPROVAL_|SANDBOX_|MISC_|ORCH_|SUBAGENT_|SEARCH_|STREAM_|COMPACT_|RETRY_|LOG_|DEFAULT_|MOCK_|NODE_TEST_CONTEXT$|NODE_TEST_KNOWN_GLOBALS$|HOST_NODE_PATH$|SQLITE_PATH$|PORT$|ERROR_LOG_PATH$|MAX_TOOL_CONCURRENCY$|REPO_PATH$)/;

export function sanitizeHostVerifyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (!HOST_VERIFY_ENV_DENY.test(k)) out[k] = v;
  }
  return out;
}

export interface HostVerifyResult {
  ran: boolean;
  ok: boolean;
  note: string;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  /** 实际采用的验证方式：行为测试 / 仅类型检查 / 未验证 */
  mode: VerificationMode;
  coverage: 'full' | 'typecheck' | 'none';
  /** 失败时是否应阻断并触发自动回滚；unavailable（仓库无可跑验证）不阻断 */
  blocking: boolean;
  /** 能力探测结论（为什么选这个 mode） */
  planReason: string;
}

export interface HostVerifyOptions {
  repoPath: string;
  /** 系统 Node 24 绝对路径（config.sandbox.hostNodePath） */
  nodePath: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 覆盖默认 `--import tsx --test tests/*.test.ts`（评测夹具可用纯 Node 测试） */
  nodeArgs?: string[];
  /** 失败文案里的标签，例如 "宿主全量测试" / "深度验证" */
  label?: string;
}

export async function runHostFullSuite(opts: HostVerifyOptions): Promise<HostVerifyResult> {
  const label = opts.label ?? '宿主全量测试';
  if (!existsSync(opts.nodePath)) {
    return {
      ran: false,
      ok: false,
      note: `${label}跳过：找不到配置的系统 Node（${opts.nodePath}）。请在 config 里修正 HOST_NODE_PATH。`,
      durationMs: 0,
      exitCode: null,
      timedOut: false,
      aborted: false,
      mode: 'unavailable',
      coverage: 'none',
      blocking: false,
      planReason: '系统 Node 不存在，无法执行任何验证',
    };
  }

  let args: string[];
  let mode: VerificationMode;
  let coverage: HostVerifyResult['coverage'];
  let planReason: string;
  let timeoutMs = opts.timeoutMs ?? 600_000;

  if (opts.nodeArgs) {
    // 测试夹具 / 评测入口：调用方显式给定命令，按原语义执行。
    args = opts.nodeArgs;
    mode = 'full_suite';
    coverage = 'full';
    planReason = '调用方显式指定 node 参数';
  } else {
    const plan = resolveVerificationPlan(opts.repoPath);
    planReason = plan.reason;
    if (plan.mode === 'unavailable') {
      return {
        ran: false,
        ok: false,
        note: `${label}未运行：${plan.reason}。改动已落盘，但**未经任何行为验证**，请人工验收。`,
        durationMs: 0,
        exitCode: null,
        timedOut: false,
        aborted: false,
        mode: 'unavailable',
        coverage: 'none',
        blocking: false,
        planReason,
      };
    }
    if (plan.mode === 'typecheck') {
      args = [plan.typecheckBin!, '--noEmit', '-p', 'tsconfig.json'];
      mode = 'typecheck';
      coverage = 'typecheck';
      timeoutMs = opts.timeoutMs ?? 180_000;
    } else {
      args = [...(plan.tsxAvailable ? ['--import', 'tsx'] : []), '--test', ...plan.testFiles];
      mode = 'full_suite';
      coverage = 'full';
    }
  }

  const r = await spawnAsync(opts.nodePath, args, {
    cwd: opts.repoPath,
    timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: sanitizeHostVerifyEnv(process.env),
    signal: opts.signal,
  });
  const tail = `${r.stdout}\n${r.stderr}`.trim().slice(-1200);
  const timeout = r.timedOut ? '（超时）' : '';
  const what = mode === 'typecheck' ? `${label}（类型检查；未跑行为测试）` : label;
  return {
    ran: true,
    ok: r.ok,
    note: r.ok ? `${what}通过` : `${what}失败${timeout}（exit=${r.exitCode}）：\n${tail}`,
    durationMs: r.durationMs,
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    aborted: !!r.aborted,
    mode,
    coverage,
    blocking: !r.ok,
    planReason,
  };
}
