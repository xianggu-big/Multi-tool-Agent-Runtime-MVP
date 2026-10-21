// scripts/doctor.ts — 首跑自检（npm run doctor）
//
// 目标：把「新机器上跑不起来」从玄学变成清单。
// 只做只读探测 + 一次数据目录写探针；不启动服务、不跑测试、不调用模型。
// 退出码：有 fail → 1；只有 warn → 0（警告代表功能可用但能力受限，例如没 Key / 没 Docker）。
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { loadConfig } from '../src/config.js';
import { getPreset } from '../src/llm/presets.js';
import { spawnAsync } from '../src/sandbox/exec.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export function checkNodeVersion(version: string = process.versions.node): DoctorCheck {
  const major = Number(version.split('.')[0]);
  if (!Number.isFinite(major)) {
    return { id: 'node', title: 'Node.js', status: 'fail', detail: `无法解析版本：${version}` };
  }
  if (major < 24) {
    return {
      id: 'node',
      title: 'Node.js',
      status: 'fail',
      detail: `当前 v${version}；本项目 better-sqlite3 按 Node 24 ABI 编译，低版本会 ERR_DLOPEN_FAILED`,
      fix: '安装 Node 24，并确认 `node -v` 指向它（Windows 可检查 PATH 顺序）',
    };
  }
  if (major > 24) {
    return {
      id: 'node',
      title: 'Node.js',
      status: 'warn',
      detail: `当前 v${version}；本项目只在 Node 24 上实测过，新主版本可能改变原生模块 ABI`,
      fix: '若遇到 better-sqlite3 加载失败，切回 Node 24',
    };
  }
  return { id: 'node', title: 'Node.js', status: 'ok', detail: `v${version}` };
}

export function checkHostNode(path: string): DoctorCheck {
  if (!path || !existsSync(path)) {
    return {
      id: 'host-node',
      title: '宿主 Node 绝对路径',
      status: 'fail',
      detail: `找不到 ${path || '(未配置)'}；落盘后的宿主复验无法执行`,
      fix: '设置 HOST_NODE_PATH 指向 Node 24 的绝对路径',
    };
  }
  return { id: 'host-node', title: '宿主 Node 绝对路径', status: 'ok', detail: path };
}

export async function checkSqliteVec(): Promise<DoctorCheck> {
  let db: Database.Database | null = null;
  try {
    db = new Database(':memory:');
    const require = createRequire(import.meta.url);
    const sqliteVec = require('sqlite-vec') as { load: (d: Database.Database) => void };
    sqliteVec.load(db);
    const row = db.prepare('select vec_version() as v').get() as { v?: string } | undefined;
    return { id: 'sqlite-vec', title: 'SQLite + sqlite-vec', status: 'ok', detail: `可用（vec ${row?.v ?? '?'}）` };
  } catch (e) {
    return {
      id: 'sqlite-vec',
      title: 'SQLite + sqlite-vec',
      status: 'fail',
      detail: `加载失败：${(e as Error).message}`,
      fix: '确认 Node 24 ABI 与 `npm rebuild better-sqlite3`；向量检索会降级为 FTS5',
    };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

export function checkDataDir(sqlitePath: string): DoctorCheck {
  if (!sqlitePath || sqlitePath === ':memory:') {
    return { id: 'data-dir', title: '数据目录', status: 'ok', detail: ':memory:（不落盘，仅供测试）' };
  }
  const dir = dirname(resolve(sqlitePath));
  const probe = join(dir, `.doctor-${process.pid}-${Date.now()}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, 'ok', 'utf8');
    rmSync(probe, { force: true });
    return { id: 'data-dir', title: '数据目录', status: 'ok', detail: dir };
  } catch (e) {
    return {
      id: 'data-dir',
      title: '数据目录',
      status: 'fail',
      detail: `不可写：${(e as Error).message}`,
      fix: `检查目录权限或以有写权限的用户运行：${dir}`,
    };
  }
}

export async function checkPort(port: number, host = '127.0.0.1'): Promise<DoctorCheck> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once('error', (e: NodeJS.ErrnoException) => {
      const busy = e.code === 'EADDRINUSE';
      resolvePromise({
        id: 'port',
        title: `端口 ${port}`,
        status: busy ? 'warn' : 'fail',
        detail: busy ? '已被占用（服务可能已在运行）' : `不可用：${e.message}`,
        fix: busy ? '换 PORT，或先关闭占用该端口的进程' : undefined,
      });
    });
    server.listen(port, host, () => {
      server.close(() => resolvePromise({ id: 'port', title: `端口 ${port}`, status: 'ok', detail: '可用' }));
    });
  });
}

export async function checkDocker(image: string): Promise<DoctorCheck> {
  const v = await spawnAsync('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 8_000, maxBuffer: 512 * 1024 });
  if (!v.ok) {
    return {
      id: 'docker',
      title: 'Docker',
      status: 'warn',
      detail: `不可用：${(v.stderr || v.stdout || v.error || `exit=${v.exitCode}`).trim().slice(-300)}`,
      fix: '启动 Docker Desktop；写能力的沙箱阶梯会不可用（默认 fail-closed）',
    };
  }
  const img = await spawnAsync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { timeoutMs: 8_000, maxBuffer: 512 * 1024 });
  if (!img.ok) {
    return {
      id: 'docker',
      title: 'Docker',
      status: 'warn',
      detail: `Docker 可用（${v.stdout.trim()}），但镜像 ${image} 不存在`,
      fix: `构建镜像：node scripts/sandbox/build-image.mjs`,
    };
  }
  return { id: 'docker', title: 'Docker', status: 'ok', detail: `可用（${v.stdout.trim()}），镜像 ${image} 已存在` };
}

export function checkLlmKey(cfg: ReturnType<typeof loadConfig>): DoctorCheck {
  const preset = getPreset(cfg.llm.presetId);
  const envKey = preset?.apiKeyEnv ? process.env[preset.apiKeyEnv] : undefined;
  const has = !!(cfg.llm.apiKey || cfg.openai.apiKey || envKey);
  if (has) return { id: 'llm-key', title: '模型 Key', status: 'ok', detail: `已配置（${preset?.id ?? cfg.llm.presetId}）` };
  if (preset?.keyOptional || cfg.llmMode === 'mock') {
    return { id: 'llm-key', title: '模型 Key', status: 'ok', detail: `不需要/未配置（${cfg.llmMode === 'mock' ? 'Mock 模式' : preset?.id ?? 'local'}）` };
  }
  return {
    id: 'llm-key',
    title: '模型 Key',
    status: 'warn',
    detail: `未配置 ${preset?.apiKeyEnv ?? 'LLM_API_KEY'}；真实模型任务不可用，Mock/演示仍可运行`,
    fix: `设置环境变量 ${preset?.apiKeyEnv ?? 'LLM_API_KEY'}（不要写进仓库）`,
  };
}

export async function runDoctor(): Promise<DoctorCheck[]> {
  const cfg = loadConfig();
  const port = Number(process.env.PORT ?? 3000);
  const checks: DoctorCheck[] = [
    checkNodeVersion(),
    checkHostNode(cfg.sandbox.hostNodePath),
    await checkSqliteVec(),
    checkDataDir(cfg.sqlitePath),
    await checkPort(Number.isFinite(port) ? port : 3000),
    await checkDocker(cfg.sandbox.image),
    checkLlmKey(cfg),
  ];
  return checks;
}

function icon(s: CheckStatus): string {
  return s === 'ok' ? '✅' : s === 'warn' ? '⚠️' : '❌';
}

export function formatDoctor(checks: DoctorCheck[]): string {
  const lines = ['MTA Doctor — 首跑自检', ''];
  for (const c of checks) {
    lines.push(`${icon(c.status)} ${c.title}：${c.detail}`);
    if (c.fix) lines.push(`   ↳ ${c.fix}`);
  }
  const fail = checks.filter((c) => c.status === 'fail').length;
  const warn = checks.filter((c) => c.status === 'warn').length;
  lines.push('', fail ? `结论：${fail} 个失败、${warn} 个警告` : warn ? `结论：可运行，但有 ${warn} 个警告` : '结论：全部通过');
  return lines.join('\n');
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  const checks = await runDoctor();
  console.log(formatDoctor(checks));
  if (process.argv.includes('--json')) console.log(JSON.stringify(checks, null, 2));
  process.exitCode = checks.some((c) => c.status === 'fail') ? 1 : 0;
}