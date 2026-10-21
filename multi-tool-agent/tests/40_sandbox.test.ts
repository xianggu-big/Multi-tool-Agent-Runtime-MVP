// tests/40_sandbox.test.ts — 沙箱分类器 / 会话常量 / Docker 条件测试（M1 Step2）
//
// ① classify() 规则表逐条（纯单测，RawCheckResult 直接构造）：
//    超时挂起 / 语法 / 类型 / 测试失败 / 环境不匹配（**不算模型改错**）/ 未归类
// ② shouldRegenerate()：环境性失败不消耗重生成轮次；通过的结果不该再重生成
// ③ REGEN_ROUNDS_PER_FILE === 3（会话内计数，重派不重置——v3-2）
// ④ dockerAvailable()：守护进程没跑也必须**正常返回 false**（不抛异常）——写能力 fail-closed 的第一道门
// ⑤ 真实 Docker 条件测试：镜像可用时真起容器跑 L0 语法阶梯；不可用则 skip（附原因）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classify, shouldRegenerate, type RawCheckResult } from '../src/sandbox/classify.js';
import { REGEN_ROUNDS_PER_FILE, SandboxSession, copyRepoSnapshot } from '../src/sandbox/session.js';
import { dockerAvailable, dockerExec } from '../src/sandbox/docker.js';

const IMAGE = process.env.SANDBOX_IMAGE ?? 'mta-sandbox:node24';

/** 默认构造：一条"命令失败"的原始检查结果，按需覆盖 */
const raw = (over: Partial<RawCheckResult> = {}): RawCheckResult => ({
  source: 'command',
  exitCode: 1,
  stdout: '',
  stderr: '',
  timedOut: false,
  ...over,
});

// ---------------------------------------------------------------- ① classify 规则表
test('40a) classify：超时挂起 → TIMEOUT_HANG（即使退出码是 0，超时也不算通过）', () => {
  const v = classify(raw({ source: 'l0-syntax', exitCode: null, timedOut: true, stderr: 'killed' }));
  assert.equal(v.ok, false);
  assert.equal(v.class, 'TIMEOUT_HANG');
  assert.ok(v.repairHint && v.repairHint.length > 0, '失败必须带修复提示（回喂模型用）');

  // 边界：exitCode=0 但被判超时 → 不能算通过（否则挂起会被当成成功）
  const edge = classify(raw({ source: 'l1-tests', exitCode: 0, timedOut: true, stdout: 'partial output' }));
  assert.equal(edge.ok, false, '安全行为：超时终止的运行即使退出码为 0 也不算通过');
  assert.equal(edge.class, 'TIMEOUT_HANG');
});

test('40b) classify：语法错误（TS1128 / SyntaxError）→ SYNTAX', () => {
  const ts = classify(raw({ source: 'command', stderr: 'src/a.ts(3,1): error TS1128: Declaration or statement expected.' }));
  assert.equal(ts.ok, false);
  assert.equal(ts.class, 'SYNTAX');

  const js = classify(raw({ source: 'command', stderr: 'SyntaxError: Unexpected token "="' }));
  assert.equal(js.class, 'SYNTAX');
  assert.match(String(js.repairHint), /语法/, 'SYNTAX 的修复提示应指向语法修正');
});

test('40c) classify：l1-tsc + TS2345 → TYPE', () => {
  const v = classify(
    raw({
      source: 'l1-tsc',
      exitCode: 2,
      stderr: "src/b.ts(7,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
    }),
  );
  assert.equal(v.ok, false);
  assert.equal(v.class, 'TYPE');
  assert.match(String(v.repairHint), /类型/, 'TYPE 的修复提示应指向类型标注/导入');
});

test('40d) classify：l1-tests 退出码 1 → TEST_FAIL', () => {
  const v = classify(
    raw({
      source: 'l1-tests',
      exitCode: 1,
      stdout: 'not ok 1 - add()',
      stderr: 'AssertionError [ERR_ASSERTION]: expected 3 to equal 4',
    }),
  );
  assert.equal(v.ok, false);
  assert.equal(v.class, 'TEST_FAIL');
  assert.match(String(v.repairHint), /测试/, 'TEST_FAIL 的修复提示应指向失败断言');
});

test('40e) classify：ERR_DLOPEN_FAILED → ENV_MISMATCH 且 environmentIssue=true（不算模型改错）', () => {
  const v = classify(
    raw({
      source: 'l1-tests',
      exitCode: 1,
      stderr: "Error: dlopen(/work/node_modules/better-sqlite3/build/Release/better_sqlite3.node): ERR_DLOPEN_FAILED",
    }),
  );
  assert.equal(v.ok, false);
  assert.equal(v.class, 'ENV_MISMATCH', '环境性失败（容器 Linux vs 宿主 Windows）必须单列，不能误导重生成');
  assert.equal(v.environmentIssue, true, 'environmentIssue 必须为 true（上层据此不扣重生成轮次、必要时升级）');
});

test('40f) classify：无法归类 → UNKNOWN；通过判定（exitCode=0 且未超时）→ ok:true', () => {
  const unknown = classify(raw({ source: 'command', exitCode: 3, stderr: 'something went wrong' }));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.class, 'UNKNOWN');
  assert.match(String(unknown.repairHint), /完整报错原文/, 'UNKNOWN 应要求把原文带回上层判定');

  const pass = classify(raw({ source: 'l1-tsc', exitCode: 0, timedOut: false }));
  assert.equal(pass.ok, true, 'exitCode=0 且未超时 → 通过');
  assert.equal(pass.class, undefined, '通过时不应带失败分类');
});

// ---------------------------------------------------------------- ② shouldRegenerate
test('40g) shouldRegenerate：环境性失败不消耗重生成轮次；通过的结果不重生成', () => {
  // 注意：套件来源（l1-tests）下关键词必须出现在"错误行"上（见 40l 的误判守卫）——
  // 这里用真实形态的报错行（Error: dlopen...) 而不是裸关键词。
  const env = classify(raw({ source: 'l1-tests', stderr: 'Error: dlopen(/work/node_modules/better-sqlite3/build/Release/better_sqlite3.node): ERR_DLOPEN_FAILED' }));
  assert.equal(shouldRegenerate(env), false, '环境性失败重试也没用：不得消耗重生成轮次');

  const syntax = classify(raw({ source: 'command', stderr: "SyntaxError: Unexpected token '}'" }));
  assert.equal(shouldRegenerate(syntax), true, '模型改错 → 应重生成');

  const testFail = classify(raw({ source: 'l1-tests', exitCode: 1, stderr: 'AssertionError' }));
  assert.equal(shouldRegenerate(testFail), true, '测试失败 → 应重生成');

  const pass = classify(raw({ exitCode: 0 }));
  assert.equal(pass.ok, true);
  assert.equal(shouldRegenerate(pass), false, '通过的结果不该再重生成');
});

// ---------------------------------------------------------------- ③ 会话常量
test('40h) REGEN_ROUNDS_PER_FILE === 3（会话内计数，重派不重置——v3-2）', () => {
  assert.equal(REGEN_ROUNDS_PER_FILE, 3, '每文件重生成轮次上限是 3（改这个数会改变成本与"无限重试"的边界）');
});

// ---------------------------------------------------------------- ④ dockerAvailable 契约
test('40i) dockerAvailable() 不抛异常、返回 boolean（守护进程没跑 → false，不 fail-open）', () => {
  let v: unknown;
  assert.doesNotThrow(() => {
    v = dockerAvailable();
  }, '守护进程未运行也必须正常返回 false，不能抛异常把上层打崩');
  assert.equal(typeof v, 'boolean');
});

// ---------------------------------------------------------------- ⑤ 真实 Docker 条件测试
//
// 历史（2026-10-15 实测暴露的两个 src 缺陷，**均已修复**，40j 现在应当通过）：
//   ① stage() 抛「写入沙箱容器失败：... Permission denied」——ensure() 的 docker cp 把快照拷成
//      root:root，而容器按 Dockerfile 以 USER node 运行 → node 用户写不进拷贝出来的目录。
//      修复：ensure() 在 cp 后 `docker exec -u root chown -R node:node /work`（src/sandbox/session.ts）。
//   ② `npx esbuild --loader=ts <file>` 对文件输入非法（loader 无扩展名只对 stdin 合法）→ 任何改动
//      都被误判 SYNTAX。修复：L0 直接给文件路径，按扩展名推断 loader（src/sandbox/session.ts runL0）。
// 另注：本用例用 tmpdir 当 dataDir，因此**不覆盖**「dataDir 在 repo 内部」的真实布局——
// 那个布局的拷贝缺陷见 ⑥40k。
test('40j) 真实 Docker：L0 语法阶梯（好文件通过 / 语法错文件被拦）', async (t) => {
  if (!dockerAvailable()) {
    t.skip('Docker 守护进程未运行');
    return;
  }
  // 快速预检镜像：直接 ensure() 的话 docker run 会对缺失镜像发起拉取（实测 ~50s 才失败）
  const probe = dockerExec(['image', 'inspect', '--format', '{{.Id}}', IMAGE], { timeoutMs: 30_000 });
  if (!probe.ok) {
    t.skip(`沙箱镜像未构建（${IMAGE}）：先跑 node scripts/sandbox/build-image.mjs`);
    return;
  }

  const dataDir = mkdtempSync(join(tmpdir(), 'mta-sb-'));
  const sb = new SandboxSession({ image: IMAGE, repoPath: resolve('demo/codebase-sample'), dataDir }, 'run_test_sb');
  const ens = await sb.ensure();
  if (!ens.ok) {
    rmSync(dataDir, { recursive: true, force: true });
    // 镜像/启动失败 → skip（本文件只在环境就绪时验证沙箱真行为）
    if (/镜像|不存在/.test(ens.reason)) t.skip(`沙箱镜像未构建：${ens.reason}`);
    else if (/Docker/i.test(ens.reason)) t.skip(`Docker 不可用：${ens.reason}`);
    else t.skip(`沙箱不可用：${ens.reason}`);
    return;
  }

  try {
    await sb.stage('src/__probe.ts', 'create', 'export const ok = 1;\n');
    const good = await sb.runLadder('L0');
    assert.equal(good.ok, true, `L0 应通过合法 TS 文件（实际：${JSON.stringify(good.steps.map((s) => s.verdict))}）`);
    assert.ok(good.steps.length >= 1);
    assert.equal(good.steps[0].source, 'l0-syntax');

    await sb.stage('src/__bad.ts', 'create', 'export const = ;\n');
    const bad = await sb.runLadder('L0');
    assert.equal(bad.ok, false, '语法错文件必须被 L0 拦住（沙箱的意义就是别让它落盘）');
    const failed = bad.steps.filter((s) => !s.verdict.ok);
    assert.ok(failed.length >= 1, '失败时必须给出失败步骤的证据');
    assert.equal(failed[0].verdict.class, 'SYNTAX', '语法错的分类应为 SYNTAX（供上层决定重生成）');
  } finally {
    await sb.disposeAsync(); // 容器是 --rm，但显式清理更稳（宿主副本/dataDir 也一并清掉）
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- ⑥ 快照拷贝（纯单测，无需 Docker）
//
// 2026-10-15 端到端实测暴露的缺陷（本用例=回归守卫）：真实运行时 dataDir = `<repo>/data`，
// 宿主副本落在 `<repo>/data/sandbox/<runId>/repo` —— **dest 在 src 之内**。此时
// fs.cpSync(repoPath, dest) 会在拷贝前的自引用校验直接抛
// `ERR_FS_CP_EINVAL: Cannot copy <repo> to a subdirectory of self`（filter 还没轮到执行），
// 写工具第一步（ensure→快照）就全线 EXECUTION_ERROR，整条"沙箱→审批→落盘"管线不可用。
// 40j 用 tmpdir 当 dataDir，所以从未覆盖到这个布局。
test('40k) copyRepoSnapshot：dataDir 在 repo 内部（真实布局）时快照必须成功，且排除 data/node_modules', () => {
  const repo = mkdtempSync(join(tmpdir(), 'mta-snap-'));
  try {
    writeFileSync(join(repo, 'package.json'), '{"name":"x"}\n', 'utf8');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'junk.js'), 'junk\n', 'utf8');
    mkdirSync(join(repo, 'data'), { recursive: true });
    writeFileSync(join(repo, 'data', 'runtime.db'), 'db', 'utf8');
    // 敏感文件不得进快照（容器内 `cat .env` 会绕过读工具层的拒读）；.env.example 是文档、必须保留
    writeFileSync(join(repo, '.env'), 'SECRET=1\n', 'utf8');
    writeFileSync(join(repo, '.env.local'), 'SECRET=2\n', 'utf8');
    writeFileSync(join(repo, '.env.example'), 'SECRET=YOUR_KEY\n', 'utf8');

    // 对照：直接 cpSync 根目录 → 必然抛 "subdirectory of self"（这就是实测撞到的异常）
    assert.throws(
      () => cpSync(repo, join(repo, 'data', 'sandbox', 'run_x', 'repo'), { recursive: true }),
      /subdirectory of self/i,
      '对照失败：cpSync 对「dest 在 src 内」应当拒绝（证明本用例确实守着一个真实约束）',
    );

    const dest = join(repo, 'data', 'sandbox', 'run_x', 'repo'); // ← 真实布局：dest 在 src 之内
    const stat = copyRepoSnapshot(repo, dest);
    assert.ok(existsSync(join(dest, 'package.json')), '仓库根文件必须进快照');
    assert.ok(existsSync(join(dest, 'src', 'a.ts')), '子目录文件必须进快照');
    assert.equal(existsSync(join(dest, 'data')), false, 'data/ 必须排除（否则就是递归自拷贝）');
    assert.equal(existsSync(join(dest, 'node_modules')), false, 'node_modules/ 必须排除（Linux 依赖走镜像，P0-1）');
    assert.equal(existsSync(join(dest, '.env')), false, '敏感文件 .env 不得进快照（容器内 cat 会绕过读工具拒读）');
    assert.equal(existsSync(join(dest, '.env.local')), false, '敏感文件 .env.* 不得进快照');
    assert.ok(existsSync(join(dest, '.env.example')), '.env.example 是文档（无密钥），必须保留');
    assert.equal(stat.files, 3, `只应拷贝 3 个普通文件（实际 ${stat.files}）`);
    assert.ok(stat.skippedExcluded >= 4, `data/node_modules/.env/.env.local 应各记一次排除（实际 ${stat.skippedExcluded}）`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// 2026-10-15 端到端实测暴露（本用例=回归守卫）：全量测试套件的输出里会打印**测试名**——
// 「敏感文件拒写…」（tests/39a）、「ERR_DLOPEN_FAILED…」（tests/40e）——于是套件因任何原因失败时，
// 关键词规则都把 l1-tests 误判为 SENSITIVE_FILE / ENV_MISMATCH：修复提示变"敏感文件拒写"（把模型带偏，真实
// run 里 code-edit 子 Agent 因此放弃），或 environmentIssue=true 导致不重生成。套件来源必须走 TEST_FAIL。
test('40l) classify：测试套件输出里的测试名不得污染失败类别（关键词误判回归守卫）', () => {
  const suite = classify(
    raw({
      source: 'l1-tests',
      exitCode: 1,
      stdout: [
        '✖ 39a) 敏感文件拒写：.ENV 与 .env 同判（大小写不敏感回归守卫）+ 正常路径控制组',
        '✖ 40e) classify：ERR_DLOPEN_FAILED → ENV_MISMATCH 且 environmentIssue=true（不算模型改错）',
        '# fail 2',
      ].join('\n'),
    }),
  );
  assert.equal(suite.class, 'TEST_FAIL', '套件失败只该判 TEST_FAIL（测试名里的关键词不算类别证据）');
  assert.equal(suite.environmentIssue, false, '不能因测试名把套件失败标成环境性问题（会导致不重生成）');

  // 对照①：单条命令（非套件来源）仍按文本判定 SENSITIVE_FILE
  const cmd = classify(raw({ source: 'command', exitCode: 1, stderr: '敏感文件拒写：.env' }));
  assert.equal(cmd.class, 'SENSITIVE_FILE');

  // 对照②：套件里真的出现"错误行"形态的环境问题（invalid ELF header）仍判 ENV_MISMATCH
  const envSuite = classify(
    raw({ source: 'l1-tests', exitCode: 1, stderr: 'Error: /work/node_modules/better-sqlite3/build/Release/better_sqlite3.node: invalid ELF header' }),
  );
  assert.equal(envSuite.class, 'ENV_MISMATCH');
  assert.equal(envSuite.environmentIssue, true);
});
