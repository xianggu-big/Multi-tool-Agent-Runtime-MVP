// tests/32_adversarial.test.ts — 对抗性测试套件（全面代码审查配套）
//
// 目标：从攻击者/异常输入视角验证安全边界与鲁棒性。分七部分：
//   A. SSRF：checkUrl 纯函数绕过 + fetch_page 端到端 PoC（本地起服务实测）
//   B. run_tests 白名单绕过：前缀匹配 → 任意文件读取
//   C. 路径穿越 / 符号链接（junction）逃逸 / 敏感文件大小写
//   D. HTTP 输入校验：validateRunRequest 边界与异常形态
//   E. 并发：40 个并发 enqueue / 事件序号连续性 / 批量落库
//   F. 性能：5 万事件 emit / 2 万批量落库 / 1 万消息上下文压缩
//   G. 逻辑漏洞：resume() rejection 无人捕获 / misc 上限钳制 / 知识检索死路径
//
// 约定：
//   - 「回归守卫」断言**应该**成立的安全性质（现在成立，防未来回退）；
//   - 「BUG 证据」断言**当前真实行为**（含缺陷），注释里写明期望的安全行为。
//     这样套件全绿，同时把每个洞的复现条件固化下来——修复后这些断言会失败，
//     提醒同步改回「回归守卫」。
// 运行：node --import tsx --test tests/32_adversarial.test.ts（须用 Node 24，better-sqlite3 ABI 约束）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { checkUrl } from '../src/tools/research/ssrf.js';
import { assertInsideRepo, isSensitive } from '../src/tools/codebase/security.js';
import { resolveWorkspacePath } from '../src/tools/shared/workspacePath.js';
import { validateRunRequest } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { compactMessages } from '../src/runtime/AgentRuntime.js';
import { Budget } from '../src/runtime/Budget.js';
import { EventLogger } from '../src/trace/EventLogger.js';
import { SqliteStore } from '../src/store/SqliteStore.js';
import { buildRuntime } from '../src/runtime/index.js';
import type { ChatMessage, RunInput } from '../src/types.js';
import { registryWithAll, makeCtx, baseToolConfig, mockProvider } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ===========================================================================
// A. SSRF
// ===========================================================================

test('32a1) 回归守卫：checkUrl 必须拦截已知危险目标', () => {
  const blocked = [
    'http://localhost/', // 直写 localhost
    'http://localhost:8080/x',
    'http://sub.localhost/', // .localhost 子域
    'http://127.0.0.1/', // 回环 IP
    'http://127.0.0.1:3000/',
    'http://0.0.0.0/', // 未指定地址
    'http://10.0.0.5/', // 私网 10/8
    'http://172.16.3.4/', // 私网 172.16/12
    'http://192.168.1.1/', // 私网 192.168/16
    'http://169.254.169.254/', // 云元数据
    'http://metadata.google.internal/', // 内网域名
    'http://foo.internal/', // .internal 后缀
    'http://[::1]/', // IPv6 回环
    'http://[fe80::1]/', // IPv6 链路本地
    'http://[fc00::1]/', // IPv6 唯一本地
    'file:///etc/passwd', // 非 http(s)
    'gopher://127.0.0.1/', // 危险协议
    'not a url at all', // URL 非法
    // URL 构造器规范化后的缩写/十六进制/十进制 IP（都会被拦）
    'http://127.1/', // → 127.0.0.1
    'http://0x7f000001/', // → 127.0.0.1
    'http://2130706433/', // → 127.0.0.1
    'http://169.254.169.254./', // 尾点但被 includes 兜住
    'http://127.0.0.1./', // 尾点被规范化为 127.0.0.1
  ];
  for (const u of blocked) {
    const r = checkUrl(u);
    assert.equal(r.ok, false, `应被拦截: ${u}`);
  }
  // 白名单：不在名单内的域名拒绝；在名单内（含子域）放行
  assert.equal(checkUrl('https://example.com/', ['allowed.com']).ok, false);
  assert.equal(checkUrl('https://sub.allowed.com/', ['allowed.com']).ok, true);
  assert.equal(checkUrl('https://allowed.com.evil.com/', ['allowed.com']).ok, false, '后缀混淆必须拒绝');
});

test('32a2) 回归守卫：尾点 FQDN（trailing-dot）被 SSRF 守卫拦截', async () => {
  // 修复后：'localhost.' 与 'localhost' 等价（去尾点后再校验），应被拦截。
  const bypasses = [
    'http://localhost.:8080/', // 本机 DNS 实测解析到 ::1/127.0.0.1
    'http://LOCALHOST.:8080/', // 大小写 + 尾点
    'http://metadata.google.internal./', // 去尾点后命中 endsWith('.internal')
    'http://foo.internal./', // 同上，任意 .internal. 尾点
    'http://anything.internal.:80/', // 同类
  ];
  for (const u of bypasses) {
    const r = checkUrl(u);
    assert.equal(r.ok, false, `尾点 FQDN 必须被拦截: ${u} -> ${r.reason ?? 'ok'}`);
  }
  // 佐证：这些尾点主机名在 DNS 层与无尾点等价（本机实测 localhost. → ::1/127.0.0.1）
  // 注意（2026-10-15 沙箱实测）：Docker 容器内的解析器对 `localhost.` 直接 ENOTFOUND——
  // 那是环境差异，不属于本守卫的语义；解析失败时跳过佐证（上面的拦截断言才是守卫本体）。
  let addrs: Array<{ address: string }> | null = null;
  try {
    addrs = await new Promise<Array<{ address: string }>>((res, rej) => {
      lookup('localhost.', { all: true }, (e, a) => (e ? rej(e) : res(a as any)));
    });
  } catch {
    addrs = null;
  }
  if (addrs) {
    assert.ok(
      addrs.some((a) => a.address === '::1' || a.address === '127.0.0.1'),
      'localhost. 应解析到回环地址',
    );
  }
});

test('32a3) 回归守卫：fetch_page 拦截尾点 FQDN（http://localhost.:PORT/）', async () => {
  // 修复后：尾点 FQDN 去点后与 localhost 等价 → SSRF_BLOCKED。
  const SECRET = 'LOCAL_SECRET_MARKER_32a3_' + Date.now();
  let server: Server | null = null;
  const registry = registryWithAll();
  try {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><head><title>internal</title></head><body>${SECRET}</body></html>`);
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;

    const ctx = makeCtx({
      runType: 'research',
      allowedPermissions: ['research:web'],
      research: { allowedDomains: [] },
    });

    // 正对照：直写回环 IP → 必须被拦（证明链路本身是通的）
    const ctrl = await registry.execute('fetch_page', { url: `http://127.0.0.1:${port}/` }, ctx);
    assert.equal(ctrl.result.ok, false, '正对照：127.0.0.1 必须被拦');
    assert.equal(ctrl.result.error!.code, 'SSRF_BLOCKED');

    // 修复后：尾点 FQDN 同样必须被拦（去尾点后命中 localhost 校验）
    const atk = await registry.execute('fetch_page', { url: `http://localhost.:${port}/` }, ctx);
    assert.equal(atk.result.ok, false, '回归守卫：尾点 FQDN 必须被拦截');
    assert.equal(atk.result.error!.code, 'SSRF_BLOCKED', '应返回 SSRF_BLOCKED');
  } finally {
    server?.close();
  }
});

// ===========================================================================
// B. run_tests 白名单绕过
// ===========================================================================

test('32b1) 回归守卫：非白名单命令被拒绝', async () => {
  const registry = registryWithAll();
  const ctx = makeCtx({
    runType: 'codebase',
    allowedPermissions: ['codebase:test'],
    config: baseToolConfig(true),
  });
  for (const cmd of ['cat /etc/passwd', 'node -e "process.exit(0)"', 'node --version', 'curl http://x']) {
    const r = await registry.execute('run_tests', { command: cmd }, ctx);
    assert.equal(r.result.ok, false, `应拒绝: ${cmd}`);
    assert.equal(r.result.error!.code, 'FORBIDDEN');
  }
  // 未启用时一律 DISABLED
  const ctxOff = makeCtx({ runType: 'codebase', allowedPermissions: ['codebase:test'] });
  const off = await registry.execute('run_tests', { command: 'node --test' }, ctxOff);
  assert.equal(off.result.error!.code, 'DISABLED');
});

test('32b2) 回归守卫：白名单拒绝 node --test <任意路径>（非测试文件/任意 JS）', async () => {
  // 修复后：白名单为「精确匹配，或 node --test + 仓库内相对测试路径（isSafeNodeTestArg 校验）」，
  //         绝对路径 / 盘符 / `..` / 非测试文件一律 FORBIDDEN。
  // 修复前风险：allowed.some(a => cmd.startsWith(a + ' ')) 只校验前缀，
  //       `node --test <file>` 会把目标文件当测试文件加载：
  //         · 非 JS 文件 → 语法/引用错误回显首行内容（任意文件读取）；
  //         · JS 文件 → 顶层代码直接执行（任意代码执行）。
  // 注：node:test 运行器会向环境注入 NODE_TEST_CONTEXT，被 spawn 的子 node --test 继承后会
  //     自我豁免（"called recursively"）——这是测试环境产物，真实 HTTP 服务进程没有该变量。
  //     这里临时删掉它，还原真实服务场景。
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  const registry = registryWithAll();
  const ctx = makeCtx({
    runType: 'codebase',
    allowedPermissions: ['codebase:test'],
    config: baseToolConfig(true),
  });
  const dir = mkdtempSync(join(tmpdir(), 'mta-rt-'));
  const iniMarker = 'ARBITRARY_FILE_READ_MARKER_32b2_' + Date.now();
  const rceMarker = 'RCE_MARKER_32b2_' + Date.now();
  writeFileSync(join(dir, 'stolen.ini'), `${iniMarker}\n[settings]\nkey=value\n`, 'utf8');
  writeFileSync(join(dir, 'evil.js'), `console.log('${rceMarker}');\n`, 'utf8');
  try {
    // ① 绝对路径的非测试文件（.ini）必须被拒绝，不再回显文件内容
    const r1 = await registry.execute('run_tests', { command: `node --test ${join(dir, 'stolen.ini')}` }, ctx);
    assert.equal(r1.result.ok, false, '回归守卫：任意文件路径应被拒绝');
    assert.equal(r1.result.error!.code, 'FORBIDDEN', '应返回 FORBIDDEN');
    // ② 任意 JS 文件同样必须被拒绝（禁止执行非测试 JS）
    const r2 = await registry.execute('run_tests', { command: `node --test ${join(dir, 'evil.js')}` }, ctx);
    assert.equal(r2.result.ok, false, '回归守卫：任意 JS 路径应被拒绝');
    assert.equal(r2.result.error!.code, 'FORBIDDEN', '应返回 FORBIDDEN');
  } finally {
    if (saved === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// C. 路径穿越 / 符号链接逃逸 / 敏感文件判定
// ===========================================================================

test('32c1) 回归守卫：assertInsideRepo / resolveWorkspacePath 词法越权即拒', () => {
  const root = resolve('demo/codebase-sample');
  assert.throws(() => assertInsideRepo(root, '../../etc/passwd'), /路径越权|不在仓库根目录内/);
  assert.throws(() => assertInsideRepo(root, resolve(root, '../../outside.txt')), /路径越权|不在仓库根目录内/);
  assert.doesNotThrow(() => assertInsideRepo(root, 'src/calc.js'));

  // resolveWorkspacePath：越权候选必须标记 escaped，且不得泄露外部路径是否存在
  const r1 = resolveWorkspacePath(root, '../../etc/passwd');
  assert.equal(r1.ok, false);
  assert.equal((r1 as any).escaped, true);
  const r2 = resolveWorkspacePath(root, 'C:/Windows/win.ini');
  assert.equal(r2.ok, false);
  assert.equal((r2 as any).escaped, true);
  // 工作区相对形态应被宽容解析到仓库内
  const r3 = resolveWorkspacePath(root, 'demo/codebase-sample/src');
  assert.equal(r3.ok, true);
  assert.equal((r3 as any).rel, 'src');
});

test('32c2) 回归守卫：仓库内 junction 指向外部目录 → read_file 被拒绝', async (t) => {
  // 修复后：解析 realpath 后校验仍在仓库内；junction 指向外部 → PATH_ESCAPE。
  // 2026-10-20：用独立临时仓库，避免并发跑全量时其他测试/快照争用 demo 目录导致 junction 创建偶发失败。
  const registry = registryWithAll();
  const repo = mkdtempSync(join(tmpdir(), 'mta-adv-repo-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'ok.txt'), 'ok\n', 'utf8');
  const ctx = makeCtx({ runType: 'codebase', allowedPermissions: ['codebase:read'], repoPath: repo });
  const outside = mkdtempSync(join(tmpdir(), 'mta-outside-'));
  const marker = 'JUNCTION_ESCAPE_MARKER_32c2_' + Date.now();
  writeFileSync(join(outside, 'secret.txt'), `${marker}\ntop secret\n`, 'utf8');
  const link = join(repo, '__adv_link_32c2');
  let created = false;
  try {
    symlinkSync(outside, link, 'junction'); // Windows junction 无需管理员权限
    created = true;
  } catch {
    try {
      symlinkSync(outside, link, 'dir'); // POSIX 回退
      created = true;
    } catch {
      /* 无权限创建链接则跳过 */
    }
  }
  if (!created) {
    t.skip('当前环境无法创建 junction/symlink，跳过');
    rmSync(outside, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    return;
  }
  try {
    const r = await registry.execute('read_file', { path: '__adv_link_32c2/secret.txt' }, ctx);
    assert.equal(r.result.ok, false, '回归守卫：junction 指向仓库外必须被拒绝（realpath 校验）');
    assert.equal(r.result.error!.code, 'PATH_ESCAPE', '应返回 PATH_ESCAPE');
  } finally {
    rmSync(link, { recursive: true, force: true }); // 只删链接本身，不碰目标
    rmSync(outside, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    assert.equal(existsSync(outside), false, '清理后外部临时目录应已删除');
  }
});

test('32c3) 回归守卫：isSensitive 大小写不敏感——SECRET.json / .ENV 一律判为敏感', async () => {
  // 修复后：Windows/macOS 文件名本就大小写不敏感（`.ENV` 与 `.env` 是同一个文件），判定必须一致。
  // 修复前（BUG 证据）：SENSITIVE_FILES.has(name) 与 includes('secret') 均大小写敏感 → 大写变体漏网。
  assert.equal(isSensitive('secret.json'), true);
  assert.equal(isSensitive('SECRET.json'), true, '大写变体必须判为敏感（回归守卫）');
  assert.equal(isSensitive('.env'), true);
  assert.equal(isSensitive('.ENV'), true, '大写 .ENV 必须判为敏感');
  assert.equal(isSensitive('api.Key'), true, '大写 .Key 变体必须判为敏感');
  // 端到端：read_file('.ENV') 必须被拒（仓库内放一个真实文件验证）
  const registry = registryWithAll();
  const repo = resolve('demo/codebase-sample');
  const ctx = makeCtx({ runType: 'codebase', allowedPermissions: ['codebase:read'], repoPath: repo });
  const p = join(repo, '.ENV');
  writeFileSync(p, 'SECRET=32c3\n', 'utf8');
  try {
    const r = await registry.execute('read_file', { path: '.ENV' }, ctx);
    assert.equal(r.result.ok, false, '回归守卫：.ENV 必须被拒（识别为敏感文件）');
    assert.equal(r.result.error!.code, 'SENSITIVE');
  } finally {
    rmSync(p, { force: true });
  }
});

// ===========================================================================
// D. HTTP 输入校验（validateRunRequest）
// ===========================================================================

test('32d1) 回归守卫：非法请求形态被明确拒绝', () => {
  const config = loadConfig();
  const REPO = 'demo/codebase-sample'; // 真实存在（codebase/misc/orchestrator 必填）
  const bad: Array<[Record<string, unknown>, RegExp]> = [
    [{}, /runType/], // 全空
    [{ runType: 'codebase' }, /goal/], // 缺 goal
    [{ runType: 'nope', goal: 'x' }, /runType/], // 非法 runType
    [{ runType: 'codebase', goal: '   ' }, /goal/], // 空白 goal
    [{ runType: 'codebase', goal: 'x', repoPath: REPO, llm: { provider: 'not-a-preset' } }, /未知的 LLM Provider/],
    [{ runType: 'codebase', goal: 'x', repoPath: REPO, search: { provider: 'serper' } }, /Serper|SEARCH_API_KEY/],
    [{ runType: 'codebase', goal: 'x', repoPath: REPO, llm: { params: { temperature: 99 } } }, /temperature|参数/],
    [{ runType: 'codebase', goal: 'x', repoPath: '/no/such/dir_32d1' }, /repoPath 不存在/], // 目录不存在
    [{ runType: 'misc', goal: 'x' }, /repoPath/], // misc 缺 repoPath
    [{ runType: 'orchestrator', goal: 'x' }, /repoPath/], // orchestrator 缺 repoPath
  ];
  for (const [body, re] of bad) {
    const r = validateRunRequest(body, config);
    assert.ok(r.error, `应拒绝: ${JSON.stringify(body)}`);
    assert.match(r.error!, re, `错误信息应点明原因: ${JSON.stringify(body)} -> ${r.error}`);
  }
  // openai 模式无 Key 才拒绝；本机若已配置预设 Key（如 DEEPSEEK_API_KEY）则放行是正确行为
  const noKeyInEnv = !process.env.DEEPSEEK_API_KEY && !process.env.OPENAI_API_KEY;
  const rOpenai = validateRunRequest({ runType: 'codebase', goal: 'x', repoPath: REPO, llm: { mode: 'openai' } }, config);
  if (noKeyInEnv) {
    assert.ok(rOpenai.error, '无 Key 环境下 openai 模式应被拒绝');
    assert.match(rOpenai.error!, /API Key/);
  } else {
    assert.ok(!rOpenai.error, '已配置预设 Key 时 openai 模式应放行');
  }
  // 合法最小请求
  const ok = validateRunRequest({ runType: 'codebase', goal: '分析 src', repoPath: REPO }, config);
  assert.ok(!ok.error && ok.input, '合法请求应通过');
  assert.equal(ok.input!.repoPath, resolve(REPO));
});

test('32d2) 回归守卫：limits 必须是正整数；0/负数/非数字/1ms 超时一律 400', () => {
  const config = loadConfig();
  const REPO = 'demo/codebase-sample';
  for (const body of [
    { runType: 'codebase', goal: 'x', repoPath: REPO, tokenBudget: 0 },
    { runType: 'codebase', goal: 'x', repoPath: REPO, tokenBudget: -1 },
    { runType: 'codebase', goal: 'x', repoPath: REPO, maxSteps: -5 },
    { runType: 'codebase', goal: 'x', repoPath: REPO, maxSteps: 0 },
    { runType: 'codebase', goal: 'x', repoPath: REPO, maxModelCalls: 0 },
    { runType: 'codebase', goal: 'x', repoPath: REPO, totalTimeoutMs: 1 },
    { runType: 'codebase', goal: 'x', repoPath: REPO, maxSteps: 'abc' },
    { runType: 'codebase', goal: 'x', repoPath: REPO, costBudgetUsd: 0 },
  ]) {
    const r = validateRunRequest(body, config);
    assert.match(r.error ?? '', /必须是|不能超过/, '必须拒绝: ' + JSON.stringify(body));
  }
  // 数字字符串兼容旧前端，但仍按正整数校验。
  const ok = validateRunRequest({ runType: 'codebase', goal: 'x', repoPath: REPO, maxSteps: '12' }, config);
  assert.ok(!ok.error);
  assert.equal(ok.input!.maxSteps, 12);
  // Budget 层仍保留 tokenBudget=0 -> 不触顶的内部语义；但 HTTP 入口已不允许传 0。
  const b = new Budget({
    maxSteps: 10,
    maxModelCalls: 10,
    maxToolCalls: 10,
    tokenBudget: 0,
    costBudgetUsd: 0,
    totalTimeoutMs: 60000,
  });
  b.recordModelCall({
    promptTokens: 10 ** 9,
    completionTokens: 10 ** 9,
    totalTokens: 2 * 10 ** 9,
    costUsd: 10 ** 6,
    isEstimate: false,
  });
  assert.equal(b.checkToken(), null, '内部 0 仍表示未设置上限（入口已拦截）');
  assert.equal(b.checkCost(), null, '内部 0 仍表示未设置上限（入口已拦截）');
});

test('32d3) 原型污染 / contextHistory 裁剪 / goal 长度上限', () => {
  const config = loadConfig();
  const REPO = 'demo/codebase-sample';
  const body: Record<string, unknown> = {
    runType: 'codebase',
    goal: 'x',
    repoPath: REPO,
    __proto__: { polluted: 'yes' },
    constructor: { polluted: 'yes' },
    prototype: { polluted: 'yes' },
  };
  const r = validateRunRequest(body, config);
  assert.ok(!r.error, '含原型键的请求不应崩溃');
  assert.equal(({} as any).polluted, undefined, 'Object.prototype 不得被污染');
  assert.equal((Object.prototype as any).polluted, undefined, 'Object.prototype 不得被污染');

  const long = 'x'.repeat(5000);
  const r2 = validateRunRequest(
    {
      runType: 'codebase',
      goal: 'x',
      repoPath: REPO,
      contextHistory: Array.from({ length: 50 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content: `${i}-${long}`,
      })),
    },
    config,
  );
  assert.ok(r2.input!.contextHistory);
  assert.equal(r2.input!.contextHistory!.length, 10, '只保留最后 10 条');
  assert.equal(r2.input!.contextHistory![0].content.length, 2000, '内容截到 2000 字符');
  assert.equal(r2.input!.contextHistory![9].content.startsWith('49-'), true, '保留的应是最后 10 条');

  const tooLong = validateRunRequest({ runType: 'codebase', goal: 'y'.repeat(20_001), repoPath: REPO }, config);
  assert.match(tooLong.error ?? '', /goal 过长/);
  const atLimit = validateRunRequest({ runType: 'codebase', goal: 'y'.repeat(20_000), repoPath: REPO }, config);
  assert.ok(!atLimit.error, '20000 字符应仍可接受');
});

test('32d4) 回归守卫：read_file 读前预检，超大文件不整块进内存', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'mta-big-read-'));
  try {
    const big = Buffer.alloc(8 * 1024 * 1024 + 1, 0x61);
    writeFileSync(join(repo, 'big.txt'), big);
    const registry = registryWithAll();
    const r = await registry.execute(
      'read_file',
      { path: 'big.txt' },
      makeCtx({ runType: 'codebase', allowedPermissions: ['codebase:read'], repoPath: repo }),
    );
    assert.equal(r.result.ok, false);
    assert.equal(r.result.error?.code, 'FILE_TOO_LARGE');

    // 写上下文走沙箱副本时同样要先预检；fake 的 readWorkFile 故意抛错，证明它没被调用。
    const sandbox = {
      workFileSize: () => 8 * 1024 * 1024 + 1,
      readWorkFile: () => { throw new Error('should not read sandbox file'); },
    } as any;
    const r2 = await registry.execute(
      'read_file',
      { path: 'big.txt' },
      makeCtx({ runType: 'codebase', allowedPermissions: ['codebase:read'], repoPath: repo, sandbox }),
    );
    assert.equal(r2.result.ok, false);
    assert.equal(r2.result.error?.code, 'FILE_TOO_LARGE');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('32d5) fetch_page：maxBytes 真正生效（超限截断）', async () => {
  const { fetchOne } = await import('../src/tools/research/fetchPage.js');
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('x'.repeat(5000));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    const r = await fetchOne(`http://127.0.0.1:${port}/`, 5000, 1024, new AbortController().signal);
    assert.equal(r.truncated, true);
    assert.equal(r.bytes, 1024);
    assert.equal(r.body.length, 1024);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('32d6) EventLogger：seq 计数按 run 保留（终态也不清零），靠 LRU 上限防泄漏', () => {
  // 2026-10-20 语义变更：原实现「run_completed 立即删计数」会让终态后追加的事件从 seq=1 重来
  // （实测：主 run 已 completed、僵尸子任务仍在写事件 → 同一 run 出现重复 seq）。改为保留 + LRU。
  const logger = new EventLogger({ maxContentChars: 100, onPersist: () => {}, console: false, maxTrackedRuns: 2 });
  logger.emit('r1', 'run_started', {});
  assert.equal(logger.trackedRuns(), 1);
  const last = logger.emit('r1', 'run_completed', {});
  assert.equal(logger.trackedRuns(), 1, 'completed 后仍保留计数（终态后可能还有收尾事件）');
  const after = logger.emit('r1', 'run_digest', {});
  assert.equal(after.seq, last.seq + 1, '终态后追加的事件必须接着编号，不能回到 1');

  // LRU：超过 maxTrackedRuns 淘汰最老的 run
  logger.emit('r2', 'run_started', {});
  logger.emit('r3', 'run_started', {});
  assert.equal(logger.trackedRuns(), 2, '受上限约束，不随 run 数无限增长');
});

// ===========================================================================

// E. 并发
// ===========================================================================

test('32e1) 40 个并发 enqueue：全部到达终态，且每个 run 的事件序号连续', async () => {
  const bundle = makeRuntimeForE();
  const N = 40;
  const ids: string[] = [];
  for (let i = 0; i < N; i++) {
    const input: RunInput = { runType: 'misc', goal: `并发任务 ${i}`, mockScenario: 'inventory' };
    ids.push(bundle.runtime.enqueue(input, mockProvider(() => ({ stopReason: 'end_turn', content: `done ${i}` }))));
  }
  // 等待全部终态
  const deadline = Date.now() + 15000;
  let done = 0;
  while (Date.now() < deadline) {
    done = 0;
    for (const id of ids) {
      const st = bundle.store.getRun(id)!.status;
      if (st === 'completed' || st === 'failed' || st === 'cancelled' || st === 'limit_reached' || st === 'awaiting_user') done++;
    }
    if (done === N) break;
    await sleep(10);
  }
  assert.equal(done, N, `40 个并发任务应全部终态（实际 ${done}）`);
  for (const id of ids) {
    const events = bundle.store.getEvents(id);
    const seqs = events.map((e) => e.seq);
    assert.equal(seqs.length > 0, true, `${id} 应有事件`);
    for (let i = 1; i < seqs.length; i++) {
      assert.equal(seqs[i], seqs[i - 1] + 1, `${id} 事件序号应连续（${seqs[i - 1]} -> ${seqs[i]}）`);
    }
    assert.equal(seqs[0], 1, '序号应从 1 开始');
  }
  bundle.store.close();
});

test('32e2) EventLogger：多 run 交错 emit 序号独立连续；ephemeral 事件不落库', () => {
  const persisted: Array<{ runId: string; seq: number }> = [];
  const logger = new EventLogger({
    maxContentChars: 1000,
    console: false, // 必须关掉，否则 5 万条测试会刷屏
    onPersistBatch: (events) => {
      for (const e of events) persisted.push({ runId: e.runId, seq: e.seq });
    },
  });
  // 5 个 run 交错 emit，每个 100 条
  for (let i = 0; i < 100; i++) {
    for (let r = 0; r < 5; r++) {
      logger.emit(`run_${r}`, 'llm_delta', { text: 'x' }, { persist: false }); // ephemeral
      logger.emit(`run_${r}`, 'model_request', { i });
    }
  }
  logger.flush();
  assert.equal(persisted.length, 500, 'ephemeral（llm_delta）不应落库：500 = 5×100');
  for (let r = 0; r < 5; r++) {
    const seqs = persisted.filter((p) => p.runId === `run_${r}`).map((p) => p.seq);
    assert.deepEqual(seqs, Array.from({ length: 100 }, (_, i) => i + 1));
  }
});

test('32e3) SqliteStore：多批次并发 appendEvents 无异常且条数完整', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'mta-conc-')), 'runtime.db');
  const store = new SqliteStore(dbPath);
  try {
    store.createRun({
      runId: 'run_conc',
      runType: 'misc',
      status: 'running',
      goal: 'g',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: 0,
      modelCalls: 0,
      toolCalls: 0,
      totalDurationMs: 0,
      usageJson: '{}',
      isMock: 1,
    });
    // 10 个「并发」批次 × 100 条（better-sqlite3 同步执行，这里验证批量 API 的稳健性）
    const tasks = Array.from({ length: 10 }, (_, b) =>
      (async () => {
        const events = Array.from({ length: 100 }, (_, i) => ({
          runId: 'run_conc',
          seq: b * 100 + i + 1,
          type: 'model_request' as const,
          timestamp: new Date().toISOString(),
          data: { b, i },
        }));
        store.appendEvents(events);
      })(),
    );
    await Promise.all(tasks);
    assert.equal(store.getEvents('run_conc').length, 1000);
  } finally {
    store.close();
    rmSync(dbPath, { force: true });
    rmSync(join(dbPath, '..'), { recursive: true, force: true });
  }
});

// ===========================================================================
// F. 性能（宽阈值，主要记录实测值）
// ===========================================================================

test('32f1) EventLogger：5 万事件 emit + flush（实测耗时记录）', () => {
  let count = 0;
  const logger = new EventLogger({
    maxContentChars: 2000,
    console: false,
    onPersistBatch: (events) => {
      count += events.length;
    },
  });
  const t0 = Date.now();
  for (let i = 0; i < 50000; i++) {
    logger.emit('run_perf', 'model_request', { i, note: 'x'.repeat(50) });
  }
  logger.flush();
  const ms = Date.now() - t0;
  assert.equal(count, 50000);
  assert.ok(ms < 10000, `5 万事件 emit+flush 应 <10s（实测 ${ms}ms）`);
  console.log(`[perf] EventLogger 50k emit+flush: ${ms}ms`);
});

test('32f2) SqliteStore.appendEvents：单批 2 万条（实测耗时记录）', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'mta-perf-')), 'runtime.db');
  const store = new SqliteStore(dbPath);
  try {
    store.createRun({
      runId: 'run_perf',
      runType: 'misc',
      status: 'running',
      goal: 'g',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: 0,
      modelCalls: 0,
      toolCalls: 0,
      totalDurationMs: 0,
      usageJson: '{}',
      isMock: 1,
    });
    const events = Array.from({ length: 20000 }, (_, i) => ({
      runId: 'run_perf',
      seq: i + 1,
      type: 'model_request' as const,
      timestamp: new Date().toISOString(),
      data: { i },
    }));
    const t0 = Date.now();
    store.appendEvents(events);
    const ms = Date.now() - t0;
    assert.equal(store.getEvents('run_perf').length, 20000);
    assert.ok(ms < 10000, `2 万条批量插入应 <10s（实测 ${ms}ms）`);
    console.log(`[perf] appendEvents 20k batch: ${ms}ms`);
  } finally {
    store.close();
    rmSync(dbPath, { force: true });
    rmSync(join(dbPath, '..'), { recursive: true, force: true });
  }
});

test('32f3) compactMessages：1 万条消息压缩（正确性 + 实测耗时）', () => {
  const messages: ChatMessage[] = [{ role: 'system', content: 'SYS' }];
  for (let i = 0; i < 10000; i++) {
    messages.push({ role: i % 2 ? 'assistant' : 'user', content: `msg-${i}-` + 'x'.repeat(100) });
  }
  const t0 = Date.now();
  const { removedCount } = compactMessages(messages);
  const ms = Date.now() - t0;
  assert.equal(removedCount, 10000 - 6);
  assert.equal(messages.length, 1 + 1 + 6, 'system + 摘要 + 最近 6 条');
  assert.equal(messages[0].content, 'SYS', 'system 必须保留');
  assert.ok(String(messages[1].content).includes('上下文压缩'), '摘要消息插入到 system 之后');
  assert.equal(messages[messages.length - 1].content, 'msg-9999-' + 'x'.repeat(100), '最近一条必须原样保留');
  assert.ok(ms < 2000, `1 万消息压缩应 <2s（实测 ${ms}ms）`);
  console.log(`[perf] compactMessages 10k: ${ms}ms`);
});

// ===========================================================================
// G. 逻辑漏洞
// ===========================================================================

test('32g1) 回归守卫：resume() 的 rejection 已被内部捕获 → 子进程正常退出', async () => {
  // 修复后：resume() 与 enqueue() 一样显式 .catch()，server.ts 的 /resume 路由也接住错误；
  //       rejection 不再逃逸到 unhandledRejection。
  // 修复前：resume() 返回 executeLoopFrom(...).finally(...) —— rejection 原样透出；
  //       server.ts /api/runs/:id/resume 里 `void result` 不接 catch。
  // 本测试用子进程复刻该路径：修复前 Node 默认 --unhandled-rejections=throw → 进程崩溃（退出码非 0）。
  // （不在主测试进程里跑：node:test 会把 unhandledRejection 记为测试失败，反而掩盖证据。）
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', resolve('tests/32_g1_child.ts')],
    {
      cwd: resolve('.'),
      shell: false,
      env: (() => {
        const e = { ...process.env };
        delete e.NODE_TEST_CONTEXT; // 去掉测试运行器标记，模拟真实服务进程
        return e;
      })(),
    },
  );
  let stderr = '';
  child.stderr?.on('data', (d) => (stderr += d));
  let stdout = '';
  child.stdout?.on('data', (d) => (stdout += d));
  const code = await new Promise<number | null>((r) => child.on('close', r));
  assert.equal(code, 0, '回归守卫：resume 的 rejection 已被内部捕获 → 子进程正常退出（码 0）');
  assert.match(stdout, /正常退出/, '应走到正常退出分支');
});

test('32g2) 回归守卫：misc 任务的 maxSteps 请求只能收紧不能放宽（hard cap）', async () => {
  const bundle = makeRuntimeForE();
  // 请求 maxSteps=999（远超 misc 默认 6 与 hardMaxSteps=12）
  const input: RunInput = { runType: 'misc', goal: '压测 misc 上限', maxSteps: 999 };
  const runId = bundle.runtime.enqueue(
    input,
    mockProvider(() => ({ stopReason: 'tool_use', content: '', toolCalls: [{ id: 't1', name: 'dir_stats', arguments: {} }] })),
  );
  const deadline = Date.now() + 15000;
  let st = '';
  while (Date.now() < deadline) {
    st = bundle.store.getRun(runId)!.status;
    if (st === 'completed' || st === 'failed' || st === 'cancelled' || st === 'limit_reached' || st === 'awaiting_user') break;
    await sleep(10);
  }
  const rec = bundle.store.getRun(runId)!;
  assert.equal(st, 'limit_reached', 'misc 无限循环应触顶');
  assert.ok(rec.steps <= 12, `misc steps 应被钳制在 hardMaxSteps=12 内（实际 ${rec.steps}）`);
  bundle.store.close();
});

test('32g3) 回归守卫：FTS5 原生检索生效（AND 语义）；vec0 kNN 生效', () => {
  // 修复后：FTS SQL 带 `MATCH ?` 且占位符数量对齐 → 原生检索生效，不再静默降级 LIKE。
  // 修复前：repository.ts 的 FTS SQL 缺 `MATCH ?` 且传参（ftsQuery, limit）多于占位符
  //       （collection? + LIMIT?）→ better-sqlite3 恒抛 RangeError → catch 后静默降级 LIKE。
  const dbPath = join(mkdtempSync(join(tmpdir(), 'mta-fts-')), 'runtime.db');
  const bundle = buildRuntime({ ...loadConfig(), sqlitePath: dbPath, llmMode: 'mock' });
  try {
    bundle.knowledge.putData({
      collection: 'notes',
      itemId: 'n1',
      type: 'finding',
      tags: ['x'],
      content: { title: 't', body: 'foo-bar baz 组合词' },
      createdBy: 'run',
    });
    bundle.knowledge.putData({
      collection: 'notes',
      itemId: 'n2',
      type: 'finding',
      tags: ['y'],
      content: { title: 't2', body: '无关内容' },
      createdBy: 'run',
    });
    // 行为证据：FTS 的 AND 语义（"foo"* AND "bar"*）能命中 'foo-bar baz'；
    // 降级后的 LIKE '%foo bar%' 命中不了 → 若 FTS 活着应返回 1 条，死了返回 0 条。
    const hits = bundle.knowledge.searchData('foo bar');
    assert.equal(hits.length, 1, '回归守卫：FTS5 原生 AND 语义命中 1 条（不再静默降级 LIKE）');
    // 单子串查询同样命中（foo-bar 拆词后仍在 FTS 索引内，或经 LIKE 兜底命中）
    assert.equal(bundle.knowledge.searchData('foo-bar').length, 1);
    // vec0 侧：原生 kNN 生效；语义召回命中与查询共享 token 的条目
    const sem = bundle.knowledge.searchSemantic('foo bar 组合');
    assert.ok(sem.length > 0, '回归守卫：vec0 kNN 应召回结果');
    assert.equal(sem[0].itemId, 'n1', '语义召回应把共享 token 的 n1 排在首位');
    // 原生路径钉死：仅「返回了结果」区分不了原生检索与兜底（LIKE / 内存余弦）——
    // 显式确认 FTS5 虚表在位；vec0 在位时确认向量已真实入库，并把实测值打进输出供审计。
    // （vec0 不可用时降级是设计允许的行为，见 vectorRecall 文档；这里只确保不「假装在测原生」。）
    assert.equal(bundle.knowledge.repository.stats().fts, true, 'FTS5 虚表应真实可用（fts=true）');
    const vs = bundle.knowledge.vectorRecall.stats();
    console.log(`[g3] vec0 available=${vs.available} vectors=${vs.count}`);
    if (vs.available) assert.ok(vs.count >= 2, `vec0 表应有已入库向量（实际 ${vs.count}）`);
    assert.equal(bundle.knowledge.searchData('漏洞').length, 0); // 库里没有，正对照
  } finally {
    bundle.store.close();
    rmSync(dbPath, { force: true });
    rmSync(join(dbPath, '..'), { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** E/G 部分用的独立 runtime（内存库，避免与文件库互相干扰） */
function makeRuntimeForE() {
  const config = loadConfig();
  config.llmMode = 'mock';
  config.sqlitePath = ':memory:';
  config.log.errorLogPath = join(tmpdir(), `mta-e-errors-${Date.now()}.log`);
  return buildRuntime(config, ':memory:');
}
