// scripts/doctor.ts — 首跑自检（npm run doctor）
//
// 目标：把「新机器上跑不起来」从玄学变成清单。
// 只做只读探测 + 一次数据目录写探针 + 一次 embedding 探针；不启动服务、不跑测试、不调用对话模型。
// 退出码：有 fail → 1；只有 warn → 0（警告代表功能可用但能力受限，例如没 Key / 没 Docker）。
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { loadConfig } from '../src/config.js';
import { loadEnv } from '../src/env.js';
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
    return {
      id: 'sqlite-vec',
      title: 'SQLite + sqlite-vec（旧轨，可选）',
      status: 'ok',
      detail: `可用（vec ${row?.v ?? '?'}）；仅用于读取历史 data_vec，检索主路径已统一到内置 RAG`,
    };
  } catch (e) {
    return {
      id: 'sqlite-vec',
      title: 'SQLite + sqlite-vec（旧轨，可选）',
      status: 'warn',
      detail: `未加载：${(e as Error).message}；不影响检索（RAG 索引不依赖它）`,
      fix: '无需处理；只有需要清理旧 data_vec 表时才装 sqlite-vec',
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

/**
 * Embedding 服务探针：配置了 MTA_EMBEDDING_MODEL 就真发一条最短请求。
 * 为什么要单独查：RAG 建索引/检索都依赖它，服务没起时错误只在首次检索才暴露（fetch failed），很难定位。
 */
export async function checkEmbedding(env: NodeJS.ProcessEnv = process.env): Promise<DoctorCheck> {
  const model = env.MTA_EMBEDDING_MODEL?.trim();
  if (!model) {
    return {
      id: 'embedding',
      title: 'Embedding 服务',
      status: 'ok',
      detail: '未配置（使用离线 hash 向量；语义召回能力受限）',
      fix: '需要真实语义检索时设置 MTA_EMBEDDING_MODEL（如 qwen3-embedding-0.6b）',
    };
  }
  const baseUrl = (env.MTA_EMBEDDING_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const apiKey = env.MTA_EMBEDDING_API_KEY?.trim() || env.OPENAI_API_KEY?.trim();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey ?? ''}` },
      body: JSON.stringify({ model, input: 'ping', encoding_format: 'float' }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return {
        id: 'embedding',
        title: 'Embedding 服务',
        status: 'fail',
        detail: `HTTP ${res.status}：${detail.slice(0, 200)}`,
        fix: `确认服务端已拉取模型 ${model}（本机 Ollama：\`ollama list\`；模型名需与 MTA_EMBEDDING_MODEL 完全一致）`,
      };
    }
    const json = (await res.json().catch(() => ({}))) as { data?: { embedding?: number[] }[] };
    const dim = json?.data?.[0]?.embedding?.length;
    return {
      id: 'embedding',
      title: 'Embedding 服务',
      status: 'ok',
      detail: `${model} 可用（维度 ${dim ?? '?'}，${baseUrl}）`,
    };
  } catch (e) {
    return {
      id: 'embedding',
      title: 'Embedding 服务',
      status: 'fail',
      detail: `连不上 ${baseUrl}：${(e as Error).message}`,
      fix: '启动服务（本机 Ollama：`ollama serve`），或核对 MTA_EMBEDDING_BASE_URL',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Codex CLI 探针：只跑 `--version`，不消耗 token。 */
export async function checkCodex(cfg: ReturnType<typeof loadConfig>['codex']): Promise<DoctorCheck> {
  if (!cfg.enabled) {
    return { id: 'codex', title: 'Codex CLI', status: 'ok', detail: '未启用（MTA_CODEX_ENABLED=false）' };
  }
  const isWin = process.platform === 'win32';
  const r = isWin
    ? await spawnAsync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'codex --version'], { timeoutMs: 15_000, maxBuffer: 512 * 1024 })
    : await spawnAsync(cfg.bin, ['--version'], { timeoutMs: 15_000, maxBuffer: 512 * 1024 });
  if (!r.ok) {
    return {
      id: 'codex',
      title: 'Codex CLI',
      status: 'warn',
      detail: `不可用：${(r.stderr || r.stdout || r.error || `exit=${r.exitCode}`).trim().slice(-300)}`,
      fix: '安装 Codex CLI 并登录（codex login）；或用 MTA_CODEX_BIN 指定路径',
    };
  }
  const raw = `${r.stdout}\n${r.stderr}`;
  const version = /codex-cli\s+[\d.]+/i.exec(raw)?.[0] ?? raw.trim().slice(0, 80);
  return {
    id: 'codex',
    title: 'Codex CLI',
    status: 'ok',
    detail: `可用（${version}${cfg.model ? ` · 模型 ${cfg.model}` : ''}）`,
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
    await checkEmbedding(),
    await checkCodex(cfg.codex),
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
  // 只在直接运行时读 .env（测试 import 本模块时不污染全局 env）
  loadEnv();
  const checks = await runDoctor();
  console.log(formatDoctor(checks));
  if (process.argv.includes('--json')) console.log(JSON.stringify(checks, null, 2));
  process.exitCode = checks.some((c) => c.status === 'fail') ? 1 : 0;
}
