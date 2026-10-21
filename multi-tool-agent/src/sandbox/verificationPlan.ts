// src/sandbox/verificationPlan.ts — 落盘后验证能力探测（避免把「没有测试」误判成「测试失败」）
//
// 背景：hostVerify 早期固定执行 `node --import tsx --test tests/*.test.ts`。
// 对一个没有 tests/ 的仓库，这条命令必然失败 → 每次落盘都被自动回滚，
// 用户看到的是「改完又没了」，而不是「这个仓库没有可自动运行的验证」。
//
// 本模块只做**能力探测**，不执行命令：
//   ① 有 Node 原生测试（node:test）→ full_suite；
//   ② 没有测试但有 tsconfig + 本地 tsc → typecheck（明确降级）；
//   ③ 两者都没有 → unavailable（改动可落盘，但必须如实告知「未经行为验证」）。
// jest/vitest/mocha 等第三方 runner 不自动执行：它们的入口与环境不可可靠推断，
// 贸然跑 `npm test` 可能执行仓库里的任意脚本。此时降级类型检查或标 unavailable。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export type VerificationMode = 'full_suite' | 'typecheck' | 'unavailable';

export interface VerificationPlan {
  mode: VerificationMode;
  reason: string;
  /** 仓库内相对路径（/ 分隔） */
  testFiles: string[];
  /** 本地 tsc 的 JS 入口（绝对路径）；typecheck 模式才有 */
  typecheckBin?: string;
  tsxAvailable: boolean;
  /** 发现的测试文件是否全部可被 Node 原生 runner 执行 */
  nodeTestCompatible: boolean;
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
]);

const TEST_FILE_RE = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/i;

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** 递归收集测试文件；限制深度与跳过目录，避免在大仓库里做全盘扫描。 */
function walkTests(dir: string, root: string, depth: number, maxDepth: number, out: string[]): void {
  if (depth > maxDepth) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkTests(abs, root, depth + 1, maxDepth, out);
    } else if (st.isFile() && TEST_FILE_RE.test(name)) {
      out.push(relative(root, abs).replace(/\\/g, '/'));
    }
  }
}

/** 只扫描常见测试根 + 仓库根目录，不做无界递归。 */
export function discoverTestFiles(repoPath: string, maxDepth = 4): string[] {
  if (!existsSync(repoPath)) return [];
  const out: string[] = [];
  for (const name of ['tests', 'test', '__tests__', 'src']) {
    const abs = join(repoPath, name);
    if (existsSync(abs) && statSync(abs).isDirectory()) walkTests(abs, repoPath, 1, maxDepth, out);
  }
  // 仓库根目录的单文件测试（foo.test.js）
  try {
    for (const name of readdirSync(repoPath)) {
      if (TEST_FILE_RE.test(name)) out.push(name);
    }
  } catch {
    // ignore
  }
  return [...new Set(out)].sort();
}

function looksLikeNodeTest(repoPath: string, files: string[]): boolean {
  for (const rel of files.slice(0, 24)) {
    try {
      const head = readFileSync(join(repoPath, rel), 'utf8').slice(0, 6000);
      if (/from\s+['"]node:test['"]|require\(\s*['"]node:test['"]\s*\)|from\s+['"]test['"]/.test(head)) {
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

/**
 * 解析验证计划。纯探测，不执行任何仓库脚本。
 * 说明：package.json 的 test 脚本只在明确包含 `node --test` 时才视为 Node 原生测试；
 * 否则不猜测 runner，避免误执行。
 */
export function resolveVerificationPlan(repoPath: string): VerificationPlan {
  const files = discoverTestFiles(repoPath);
  const pkg = existsSync(join(repoPath, 'package.json')) ? readJson(join(repoPath, 'package.json')) : null;
  const testScript = typeof pkg?.scripts?.test === 'string' ? String(pkg.scripts.test) : '';
  const tsxAvailable = existsSync(join(repoPath, 'node_modules', 'tsx', 'package.json'));
  const tscBin = join(repoPath, 'node_modules', 'typescript', 'bin', 'tsc');
  const hasTsconfig = existsSync(join(repoPath, 'tsconfig.json'));
  const hasTsc = existsSync(tscBin);
  const hasTsTests = files.some((f) => /\.tsx?$/i.test(f));

  const scriptIsNodeTest = /\bnode\b[^\n]*\s--test\b/.test(testScript);
  const nodeCompatible = files.length > 0 && (scriptIsNodeTest || (!testScript && looksLikeNodeTest(repoPath, files)));

  if (nodeCompatible) {
    if (hasTsTests && !tsxAvailable) {
      return {
        mode: hasTsconfig && hasTsc ? 'typecheck' : 'unavailable',
        reason: `发现 TypeScript 测试（${files.length} 个），但仓库没有安装 tsx，无法用 Node 原生 runner 加载；${
          hasTsconfig && hasTsc ? '已降级为类型检查' : '也没有可用的本地 tsc'
        }。`,
        testFiles: files,
        typecheckBin: hasTsconfig && hasTsc ? tscBin : undefined,
        tsxAvailable,
        nodeTestCompatible: false,
      };
    }
    return {
      mode: 'full_suite',
      reason: `发现 ${files.length} 个 Node 原生测试文件`,
      testFiles: files,
      tsxAvailable,
      nodeTestCompatible: true,
    };
  }

  const whyTestsSkipped =
    files.length === 0
      ? '未发现测试文件'
      : testScript && !scriptIsNodeTest
        ? `检测到 package.json test 脚本（${testScript.slice(0, 80)}），但不是 Node 原生 runner；为避免执行任意脚本，不自动运行`
        : `发现 ${files.length} 个测试文件，但没有证据表明它们使用 node:test`;

  if (hasTsconfig && hasTsc) {
    return {
      mode: 'typecheck',
      reason: `${whyTestsSkipped}；已降级为 TypeScript 类型检查（只证明类型通过，不证明行为正确）`,
      testFiles: files,
      typecheckBin: tscBin,
      tsxAvailable,
      nodeTestCompatible: false,
    };
  }

  return {
    mode: 'unavailable',
    reason: `${whyTestsSkipped}；也没有 tsconfig.json + 本地 typescript，无法自动验证`,
    testFiles: files,
    tsxAvailable,
    nodeTestCompatible: false,
  };
}
