// tests/39_write_tools.test.ts — 写工具「第一层安全边界」回归守卫（M1 Step3；**不连 Docker**）
//
// 覆盖（全部经 registry.execute：权限 → Schema → 门禁 → 工具逻辑的真实调用路径）：
//   ① 敏感文件拒写（大小写不敏感，.ENV 与 .env 同判）；控制组证明门禁不是"一刀切拒绝"
//   ② 路径越界（PATH_ESCAPE）与"不存在"（PATH_NOT_FOUND）必须区分
//   ③ create_file 目标已存在 → INVALID_ARGS（提示改用 edit_file）
//   ④ 内容超限 → OUTPUT_LIMIT（512KB 上限）
//   ⑤ edit_file 命中 0 处 / 命中多处 → EDIT_MISMATCH（报错文案可区分，模型能自我纠正）
//   ⑥ **CRLF 专项（评审 P1-7）**：CRLF 原文件 + LF oldString → 暂存内容保持 CRLF
//      （否则整文件行尾翻转会产生"沙箱绿、宿主红"的伪 diff）
//   ⑦ run_command 暂存：powershell 无法在 Linux 沙箱预演 → sandboxExitCode=null 且如实标注
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { applyEdit } from '../src/tools/shared/textEdit.js';
import type { SandboxAccess } from '../src/tools/types.js';
import type { ApprovalDecision, ApprovalRequest } from '../src/types.js';
import { baseToolConfig, makeCtx, registryWithAll } from './helpers.js';

const REPO = resolve('demo/codebase-sample');

// ---------------------------------------------------------------- 假沙箱（离线，记录 stage 内容）
class FakeWriteSandbox implements SandboxAccess {
  readonly name = 'mta-sb-fake39';
  readonly staged: Array<{ rel: string; op: 'create' | 'edit' | 'delete'; content?: string }> = [];
  readonly stagedCommands: Array<{
    command: string;
    shell: 'bash' | 'powershell' | 'cmd';
    cwdRel: string;
    sandboxOutput: string | null;
    sandboxExitCode: number | null;
    status: string;
  }> = [];
  readonly marks: Array<{ rel: string; status: string }> = [];

  /** workFiles：沙箱副本的内容覆盖（模拟"文件真实内容"，如 CRLF 文件）；未给则读真实仓库 */
  constructor(private readonly workFiles: Record<string, string> = {}) {}

  async ensure(): Promise<{ ok: true }> {
    return { ok: true };
  }
  isStarted(): boolean {
    return true;
  }
  readRepoFile(rel: string): string | null {
    try {
      return readFileSync(resolve(REPO, rel), 'utf8');
    } catch {
      return null;
    }
  }
  readWorkFile(rel: string): string | null {
    if (Object.prototype.hasOwnProperty.call(this.workFiles, rel)) return this.workFiles[rel];
    return this.readRepoFile(rel);
  }
  stage(rel: string, op: 'create' | 'edit' | 'delete', content?: string): void {
    this.staged.push({ rel, op, content });
  }
  mark(rel: string, status: string): void {
    this.marks.push({ rel, status });
  }
  consumeRound(_rel: string): number {
    return 0;
  }
  getChanges(): Array<{ relPath: string; op: 'create' | 'edit' | 'delete'; status: string; retriesLeft: number }> {
    return [];
  }
  /** 崩溃对账日志：本测试不关心磁盘，留空实现即可（真实实现见 SandboxSession.beginApply）。 */
  beginApply(): void {}
  async runLadder(level: 'L0' | 'L1' | 'L2' = 'L1') {
    return { ok: true, level: String(level), steps: [] as Array<{ source: string; verdict: { ok: boolean; summary: string } }> };
  }
  diffPatch(_rel: string, _name?: string): string {
    return '';
  }
  diffDir(): string {
    return tmpdir();
  }
  applyToRepo(_rel: string): { ok: true } {
    return { ok: true };
  }
  rollbackFromBackup(_rel: string): boolean {
    return true;
  }
  backupsDir(): string {
    return tmpdir();
  }
  stageCommand(cmd: {
    command: string;
    shell: 'bash' | 'powershell' | 'cmd';
    cwdRel: string;
    sandboxOutput: string | null;
    sandboxExitCode: number | null;
  }): void {
    this.stagedCommands.push({ ...cmd, status: 'pending' });
  }
  getCommands(): Array<{
    command: string;
    shell: 'bash' | 'powershell' | 'cmd';
    cwdRel: string;
    sandboxOutput: string | null;
    sandboxExitCode: number | null;
    status: string;
  }> {
    return this.stagedCommands;
  }
  markCommand(_index: number, _status: string, _host?: { output: string; exitCode: number | null }): void {
    /* 本文件不覆盖命令落盘态 */
  }
}

/** 写能力全开 + 假沙箱 + 假审批的 ctx（三层门禁全过，测的是门禁**之后**的第一层边界） */
function writeCtx(sb: SandboxAccess) {
  const base = baseToolConfig();
  return makeCtx({
    runType: 'codebase',
    allowedPermissions: ['codebase:read', 'codebase:test', 'codebase:write'],
    repoPath: REPO,
    config: { ...base, codebase: { ...base.codebase, writeEnabled: true } },
    sandbox: sb,
    requestApproval: async (req: ApprovalRequest): Promise<ApprovalDecision> => ({
      approvalId: req.approvalId,
      value: 'allow_once',
      decidedAt: new Date().toISOString(),
    }),
  });
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  sb: SandboxAccess = new FakeWriteSandbox(),
): Promise<{ ok: boolean; code?: string; message?: string; data: Record<string, any>; sb: SandboxAccess }> {
  const r = await registryWithAll().execute(name, args, writeCtx(sb));
  return {
    ok: r.result.ok,
    code: r.result.error?.code,
    message: r.result.error?.message,
    data: (r.result.data ?? {}) as Record<string, any>,
    sb,
  };
}

// ---------------------------------------------------------------- ① 敏感文件拒写
test('39a) 敏感文件拒写：.ENV 与 .env 同判（大小写不敏感回归守卫）+ 正常路径控制组', async () => {
  const upper = await runTool('create_file', { path: '.ENV', content: 'A=1\n' });
  assert.equal(upper.ok, false, '安全行为：大写 .ENV 也必须拒写（Windows/macOS 上它与 .env 是同一个文件）');
  assert.equal(upper.code, 'SENSITIVE');

  const lower = await runTool('create_file', { path: '.env', content: 'A=1\n' });
  assert.equal(lower.ok, false);
  assert.equal(lower.code, 'SENSITIVE');

  // 控制组：普通新文件不应被"一刀切"拒绝（门禁判的是文件名，不是路径里有敏感字样就拒）
  const ctl = await runTool('create_file', { path: 'src/ok_39a.ts', content: 'export const ok = 1;\n' });
  assert.equal(ctl.ok, true, `普通新文件应可暂存（实际错误：${JSON.stringify(ctl.message)}）`);
  assert.equal(ctl.data.staged, 'src/ok_39a.ts');
});

// ---------------------------------------------------------------- ② 路径越界 / 不存在
test('39b) 路径越界 → PATH_ESCAPE（写工具绝不能写到仓库外）', async () => {
  const r = await runTool('create_file', { path: '../../evil.ts', content: 'export const evil = 1;\n' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PATH_ESCAPE', '越界必须明确拒绝（且与"不存在"可区分）');
  assert.equal((r.sb as FakeWriteSandbox).staged.length, 0, '越界时不得有任何暂存动作');
});

test('39c) edit_file 目标不存在 → PATH_NOT_FOUND（不静默创建）', async () => {
  const r = await runTool('edit_file', { path: 'no/such.ts', oldString: 'a', newString: 'b' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PATH_NOT_FOUND', 'edit_file 只能改已存在的文件（新建请用 create_file）');
});

// ---------------------------------------------------------------- ③ 已存在 / 内容超限
test('39d) create_file 目标已存在 → INVALID_ARGS（提示改用 edit_file）', async () => {
  const r = await runTool('create_file', { path: 'src/calc.js', content: 'export const x = 1;\n' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_ARGS');
  assert.match(String(r.message), /edit_file/, '报错应提示替代工具（模型能一次改对，不反复试错）');
});

test('39e) 内容超限 → OUTPUT_LIMIT（512KB 上限，防一次写入撑爆上下文/磁盘）', async () => {
  const r = await runTool('create_file', { path: 'src/big_39e.ts', content: 'x'.repeat(600 * 1024) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'OUTPUT_LIMIT');
  assert.equal((r.sb as FakeWriteSandbox).staged.length, 0, '超限时不得暂存');
});

// ---------------------------------------------------------------- ④ edit_file 命中语义
test('39f) edit_file oldString 命中 0 处 / 多处 → EDIT_MISMATCH（报错文案可区分）', async () => {
  const zero = await runTool('edit_file', {
    path: 'src/calc.js',
    oldString: 'THIS_STRING_DOES_NOT_EXIST_39F',
    newString: 'x',
  });
  assert.equal(zero.ok, false);
  assert.equal(zero.code, 'EDIT_MISMATCH');
  assert.match(String(zero.message), /找不到/, '0 命中应明说"找不到"（并提示先 read_file 确认原文）');

  // calc.js 里 'export function ' 出现 4 次 → 不唯一必须拒绝（防改错位置）
  const multi = await runTool('edit_file', { path: 'src/calc.js', oldString: 'export function ', newString: 'function ' });
  assert.equal(multi.ok, false);
  assert.equal(multi.code, 'EDIT_MISMATCH');
  assert.match(String(multi.message), /不唯一/, '多处命中应明说"不唯一"（要求扩展上下文）');
});

// ---------------------------------------------------------------- ⑤ CRLF 专项（评审 P1-7）
test('39g) CRLF 原文件 + LF oldString → 暂存内容必须保持 CRLF（不制造整文件行尾翻转伪 diff）', async () => {
  const CRLF = 'line1\r\nline2\r\nline3\r\n';
  const sb = new FakeWriteSandbox({ 'src/calc.js': CRLF });
  const r = await runTool('edit_file', { path: 'src/calc.js', oldString: 'line2', newString: 'LINE2' }, sb);
  assert.equal(r.ok, true, `LF 形态的 oldString 应能命中 CRLF 文件（实际错误：${JSON.stringify(r.message)}）`);
  assert.equal(r.data.eol, 'CRLF', '结果应如实报告原文件行尾');

  const sbx = sb as FakeWriteSandbox;
  assert.equal(sbx.staged.length, 1);
  const content = String(sbx.staged[0].content ?? '');
  assert.equal(content, 'line1\r\nLINE2\r\nline3\r\n', '安全行为：写回必须保持原文件行尾（CRLF）');
  assert.ok(!/(?<!\r)\n/.test(content), '不得残留裸 LF（整文件行尾翻转 = 沙箱绿/宿主红的隐形来源）');

  // textEdit.applyEdit 直接单测（同一不变量的最小复现）
  const out = applyEdit('x\r\ny\r\nz\r\n', 'y', 'Y');
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.eol, '\r\n');
    assert.ok(out.content.includes('\r\n'), 'CRLF 原文件写回后应仍含 CRLF');
    assert.ok(!/(?<!\r)\n/.test(out.content), 'CRLF 原文件写回后不得出现裸 \\n');
    assert.equal(out.content, 'x\r\nY\r\nz\r\n');
  }
});

// ---------------------------------------------------------------- ⑥ run_command 暂存
test('39h) run_command（powershell）→ 只暂存不预演，如实标注"未预演"（沙箱是 Linux，跑不了 powershell）', async () => {
  const r = await runTool('run_command', { command: 'Get-ChildItem', shell: 'powershell', note: '列目录' });
  assert.equal(r.ok, true, `暂存应成功（实际错误：${JSON.stringify(r.message)}）`);
  assert.equal(r.data.staged, true);
  assert.equal(r.data.sandboxExitCode, null, 'powershell 无法在 Linux 沙箱预演 → exitCode 必须如实为 null（不能假装跑过）');
  assert.match(String(r.data.sandboxOutput), /未预演/, '结果必须提示"未预演"，供审批卡标注风险');

  const sb = r.sb as FakeWriteSandbox;
  assert.equal(sb.stagedCommands.length, 1, '命令应进暂存队列（审批通过后才在宿主执行）');
  assert.equal(sb.stagedCommands[0].shell, 'powershell');
  assert.equal(sb.stagedCommands[0].sandboxOutput, null);
  assert.equal(sb.stagedCommands[0].sandboxExitCode, null);
  assert.equal(sb.stagedCommands[0].status, 'pending');
});

// ---------------------------------------------------------------- ⑧ 宿主复验的净环境（2026-10-15 端到端实测暴露）
//
// hostVerify 是 spawnSync(node, ...)，默认继承 server 进程环境。server 一旦用非默认 env 启动
// （README 推荐的独立库/端口实测姿势：LLM_MODE=openai PORT=3033 SQLITE_PATH=./data/xxx.db CODEBASE_WRITE_ENABLED=true），
// 复验套件就继承这些键 → 实测 8 条用例失败（17e/17j/17k/17l/17o/17p/20o/22q，全在读 env/loadConfig()）
// → hostVerify 恒失败 → 每次审批通过的改动都被自动回滚（文件永远落不了盘）。
test('39i) sanitizeHostVerifyEnv：复验环境剔除应用配置键、保留系统键（防止运行期配置污染复验结论）', async () => {
  const { sanitizeHostVerifyEnv } = await import('../src/tools/codebase/writeTools.js');
  const dirty = {
    LLM_MODE: 'openai',
    LLM_PROVIDER: 'deepseek',
    DEEPSEEK_API_KEY: 'sk-x',
    OPENAI_API_KEY: 'sk-y',
    PORT: '3033',
    SQLITE_PATH: './data/m1-e2e.db',
    CODEBASE_WRITE_ENABLED: 'true',
    CODEBASE_RUN_TESTS_ENABLED: 'true',
    APPROVAL_MAX_FILES: '10',
    SANDBOX_IMAGE: 'mta-sandbox:node24',
    HOST_NODE_PATH: 'D:/Program Files/nodejs/node.exe',
    SEARCH_PROVIDER: 'serper',
    MISC_MAX_STEPS: '6',
    ORCH_MAX_STEPS: '8',
    SUBAGENT_MAX_WIDTH: '4',
    STREAM_DEBUG: '1',
    ERROR_LOG_PATH: './data/errors.log',
    MAX_TOOL_CONCURRENCY: '4',
    REPO_PATH: 'D:/repo',
    DEFAULT_MAX_STEPS: '10',
    MOCK_STREAM_CHUNK_DELAY_MS: '25',
    LOG_TOOL_RESULTS: '1',
    // Node 测试运行器的内部上下文：绝不能带进子测试进程（否则子进程失败可能被吞掉）
    NODE_TEST_CONTEXT: 'child-v8',
    NODE_TEST_KNOWN_GLOBALS: '0',
    // 应保留的系统键
    PATH: 'C:/Windows/System32',
    SystemRoot: 'C:\Windows',
    TEMP: 'C:\Temp',
    NODE_OPTIONS: '--max-old-space-size=4096',
    MTA_APPROVAL_DEBUG: '1',
  } as NodeJS.ProcessEnv;
  const clean = sanitizeHostVerifyEnv(dirty);
  const dropped = Object.keys(dirty).filter((k) => !/^(PATH|SystemRoot|TEMP|NODE_OPTIONS|MTA_APPROVAL_DEBUG)$/.test(k));
  for (const k of dropped) {
    assert.equal(clean[k], undefined, `配置键 ${k} 必须从复验环境剔除（否则套件会继承 server 的运行期配置）`);
  }
  for (const k of ['PATH', 'SystemRoot', 'TEMP', 'NODE_OPTIONS', 'MTA_APPROVAL_DEBUG']) {
    assert.equal(clean[k], (dirty as Record<string, string>)[k], `系统键 ${k} 必须保留（否则 spawn 出来的 node 起不来）`);
  }
});
