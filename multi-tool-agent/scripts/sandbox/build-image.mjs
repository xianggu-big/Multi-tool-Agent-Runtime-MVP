// scripts/sandbox/build-image.mjs — 构建沙箱镜像 mta-sandbox:node24（M1 Step1；可独立重跑）
//
// 用法：cd multi-tool-agent && node scripts/sandbox/build-image.mjs [--no-cache]
// 环境：SANDBOX_IMAGE（默认 mta-sandbox:node24）、SANDBOX_BUILD_TIMEOUT_MS（默认 20 分钟）
//
// 设计（对照评审）：
//   ① 前置检查 docker info —— 守护进程没跑就**明确报错并退出**（写能力 fail-closed 的第一道门）；
//   ② 长超时 + 失败给可行动提示（网络/工具链/磁盘三类常见原因）；
//   ③ 构建后**自检**：容器内 node -v + require('better-sqlite3')，证明"能真跑 tsc/测试"；
//   ④ 可独立重跑（层缓存复用已完成部分；--no-cache 强制全量）。
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const tag = process.env.SANDBOX_IMAGE ?? 'mta-sandbox:node24';
const buildTimeoutMs = Number(process.env.SANDBOX_BUILD_TIMEOUT_MS ?? 20 * 60 * 1000);
const noCache = process.argv.includes('--no-cache');

function run(bin, args, { timeoutMs = 120_000, allowFail = false } = {}) {
  console.log(`\n$ ${bin} ${args.join(' ')}`);
  const r = spawnSync(bin, args, { stdio: 'inherit', timeout: timeoutMs });
  if (r.error) {
    if (allowFail) return r;
    throw new Error(`${bin} 执行失败: ${r.error.message}`);
  }
  if (r.status !== 0 && !allowFail) throw new Error(`${bin} 退出码 ${r.status}`);
  return r;
}

// ① 守护进程前置检查（fail-closed）
const info = run('docker', ['info', '--format', '{{.ServerVersion}} | {{.OSType}}/{{.Architecture}}'], {
  allowFail: true,
  timeoutMs: 60_000,
});
if (info.status !== 0) {
  console.error('\n[sandbox] ❌ Docker 守护进程不可用。');
  console.error('[sandbox] 处置：启动 Docker Desktop，等托盘图标变绿后重跑本脚本。');
  console.error('[sandbox] 约束：沙箱不可用时，写能力保持关闭（fail-closed）——这是设计选择，不是缺陷。');
  process.exit(2);
}

// ② 构建（长超时）
try {
  const args = ['build', '-f', resolve(here, 'Dockerfile'), '-t', tag];
  if (noCache) args.push('--no-cache');
  args.push(repoRoot);
  run('docker', args, { timeoutMs: buildTimeoutMs });
} catch (e) {
  console.error(`\n[sandbox] ❌ 镜像构建失败：${e.message}`);
  console.error('[sandbox] 常见原因与处置：');
  console.error('  ① 网络慢/失败（首次 npm ci 需拉包）→ 直接重跑本脚本（层缓存会复用已完成部分）');
  console.error('  ② better-sqlite3 编译失败 → 检查 Dockerfile 的 build-essential/python3 是否被改动');
  console.error('  ③ 磁盘不足 → docker system df 查看，docker image prune 清理');
  process.exit(3);
}

// ③ 自检：容器内确认 node 版本 + 原生模块可加载（"能真跑 tsc/测试"的前提）
run('docker', ['run', '--rm', tag, 'node', '-v']);
run('docker', ['run', '--rm', tag, 'node', '-e', "require('better-sqlite3'); console.log('better-sqlite3 可加载 ✅')"]);
console.log(`\n[sandbox] ✅ 镜像 ${tag} 就绪（node + better-sqlite3 容器内自检通过）`);
