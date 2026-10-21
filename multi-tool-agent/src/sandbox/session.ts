// src/sandbox/session.ts — 沙箱会话（per parentRunId；M1 Step2）
//
// 职责：为「改前试跑」维护一个 Docker 侧工作副本 + 宿主机侧的审计副本：
//   - ensure()：起容器 + docker cp 仓库快照（排除 node_modules/data；镜像里已烧好 Linux 依赖）；
//   - stage()：把一次改动写进沙箱（宿主副本 + 容器内 /work），记录 baseHash/newHash/重试轮次；
//   - runLadder()：检查阶梯 L0 语法 → L1 tsc(incremental)+受影响测试 → L2 全量；
//   - diffPatch()：git diff --no-index 生成 unified patch（落 data/sandbox/<runId>/diffs/）；
//   - briefFor()：**重派交接 brief**（v3-2：重派的子 Agent 是全新上下文，必须知道沙箱里有什么）。
//
// 关键约定（对照评审）：
//   - 不用 bind mount（P0-1）：快照走 docker cp，node_modules 来自镜像；
//   - 重试轮次**存在本会话**（按 parentRunId+文件），不随子 Agent 上下文丢失（v3-2，防"靠重派绕开上限"）；
//   - 沙箱不可用 → ensure() 返回 fail-closed 原因，工具据此拒绝执行（不静默降级为非沙箱写入）；
//   - 清理：run 终态 dispose()；进程重启由 removeOrphanSandboxContainers() 兜底。
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { classify, type CheckSource, type Verdict } from './classify.js';
import { containerName, dockerAvailableAsync, execInAsync, rmContainerAsync, runDetachedAsync, cpInAsync, writeInContainerAsync } from './docker.js';
import { spawnAsync } from './exec.js';
import { shortSha256 } from './hash.js';
import { beginApplyJournal, updateApplyEntry } from './applyJournal.js';

/** 快照排除项（node_modules/data 走镜像与宿主副本；.git/.workbuddy/.zcode 是工具状态） */
const SNAPSHOT_EXCLUDE = new Set(['node_modules', 'data', '.git', '.workbuddy', '.zcode']);

/**
 * 敏感文件不进快照：`.env` 与 `.env.*`（保留 `*.example`——它是文档、无密钥）。
 * 2026-10-15 端到端实测：`.env` 不在排除表里 → 会被拷进宿主副本与容器 `/work`，
 * 而 `run_command` 的 bash 预演是**容器内真跑**（`cat .env` 即可打印内容并进模型上下文）——
 * 读工具层的 `isSensitive` 拒读（read_file/list_files/search_files）因此被沙箱绕过。
 */
function isSnapshotExcluded(name: string): boolean {
  if (SNAPSHOT_EXCLUDE.has(name)) return true;
  return /^\.env(\.|$)/.test(name) && !/\.example$/.test(name);
}

/**
 * 仓库快照（自实现递归拷贝，**不用 fs.cpSync 整树拷根目录**）。
 * 为什么不直接 cpSync(repoPath, dest)：dest 常位于 `<repo>/data/sandbox/<runId>/repo`，
 * 即 **dest 在 src 之内** → Node 的 fs.cpSync 前置校验直接抛
 * `ERR_FS_CP_EINVAL: Cannot copy ... to a subdirectory of self`（filter 不生效，校验在拷贝前）。
 * 2026-10-15 端到端实测暴露（tests/40 的 40j 用 tmp 目录当 dataDir 所以没覆盖到这个布局）。
 * 逐项递归拷贝同时保留原 filter 语义：任何层级名为 node_modules/data/.git/.workbuddy/.zcode 的条目都跳过；
 * 符号链接/junction 一律跳过（快照不应跟出仓库，与写工具的路径围栏同一安全取向）。
 */
export function copyRepoSnapshot(src: string, dest: string): { files: number; skippedExcluded: number; skippedLinks: number } {
  const stat = { files: 0, skippedExcluded: 0, skippedLinks: 0 };
  const walk = (from: string, to: string): void => {
    mkdirSync(to, { recursive: true });
    for (const ent of readdirSync(from, { withFileTypes: true })) {
      if (isSnapshotExcluded(ent.name)) {
        stat.skippedExcluded++;
        continue;
      }
      const s = join(from, ent.name);
      const d = join(to, ent.name);
      if (ent.isSymbolicLink()) {
        stat.skippedLinks++;
        continue;
      }
      if (ent.isDirectory()) {
        walk(s, d);
      } else if (ent.isFile()) {
        copyFileSync(s, d);
        stat.files++;
      }
    }
  };
  walk(src, dest);
  return stat;
}

/** 异步快照：大仓库递归拷贝不再阻塞事件循环（ensure() 使用；同步版本保留给离线测试）。 */
export async function copyRepoSnapshotAsync(
  src: string,
  dest: string,
): Promise<{ files: number; skippedExcluded: number; skippedLinks: number }> {
  const stat = { files: 0, skippedExcluded: 0, skippedLinks: 0 };
  const walk = async (from: string, to: string): Promise<void> => {
    await mkdir(to, { recursive: true });
    for (const ent of await readdir(from, { withFileTypes: true })) {
      if (isSnapshotExcluded(ent.name)) {
        stat.skippedExcluded++;
        continue;
      }
      const s = join(from, ent.name);
      const d = join(to, ent.name);
      if (ent.isSymbolicLink()) {
        stat.skippedLinks++;
        continue;
      }
      if (ent.isDirectory()) await walk(s, d);
      else if (ent.isFile()) {
        await copyFile(s, d);
        stat.files++;
      }
    }
  };
  await walk(src, dest);
  return stat;
}

/** 每文件重生成轮次上限（v3-2：计数器存会话，不存模型上下文） */
export const REGEN_ROUNDS_PER_FILE = 3;

export interface SandboxOptions {
  image: string;
  /** 宿主仓库根（绝对路径） */
  repoPath: string;
  /** 宿主 data/ 目录（绝对路径）——沙箱副本与 diff 的落点 */
  dataDir: string;
}

export type ChangeOp = 'create' | 'edit' | 'delete';
export type ChangeStatus = 'staged' | 'verified' | 'approved' | 'applied' | 'denied' | 'rolled_back';

export interface ChangeRecord {
  relPath: string;
  op: ChangeOp;
  status: ChangeStatus;
  /** 新内容哈希（create/edit 为内容哈希；delete 为 'deleted'） */
  newHash: string;
  /** 原文件内容哈希（TOCTOU 守卫：审批通过后落盘前复核） */
  baseHash?: string;
  /** 剩余重生成轮次（环境性失败不扣减——见 classify.shouldRegenerate） */
  retriesLeft: number;
  lastVerdict?: { class?: string; summary: string; excerpt?: string } | null;
  updatedAt: string;
}

export interface LadderStep {
  source: CheckSource;
  verdict: Verdict;
}

/** 暂存待审批的宿主命令（run_command）：sandboxOutput 只能对 bash 类命令提供（Linux 容器） */
export interface PendingCommand {
  command: string;
  shell: 'bash' | 'powershell' | 'cmd';
  cwdRel: string;
  /** 沙箱内预演的输出（bash 类才有；powershell/cmd 在 Linux 容器无法预演 → null + 风险标注） */
  sandboxOutput: string | null;
  sandboxExitCode: number | null;
  status: 'pending' | 'executed' | 'denied' | 'failed';
  hostOutput?: string;
  hostExitCode?: number | null;
}
export interface LadderResult {
  ok: boolean;
  level: 'L0' | 'L1' | 'L2';
  steps: LadderStep[];
}

/** 仓库相对路径的粗校验（细校验在写工具里用 resolveWorkspacePath 做） */
export function assertRelPath(rel: string): string {
  const p = String(rel ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..')) {
    throw new Error(`沙箱只接受仓库内相对路径：${rel}`);
  }
  return p;
}

export class SandboxSession {
  readonly name: string;
  /** run 级状态：改动集合（v3-2 交接 brief 的数据源） */
  private changes = new Map<string, ChangeRecord>();
  /** 待审批的命令（run_command 暂存：沙箱内先跑取证据，落宿主在审批后） */
  private commands: PendingCommand[] = [];
  private started = false;

  constructor(
    private readonly opts: SandboxOptions,
    /** 归属的父 run（沙箱按 parentRunId 复用——子任务失败重派不丢半成品） */
    readonly parentRunId: string,
  ) {
    this.name = containerName(parentRunId);
  }

  // ---------------------------------------------------------------- 生命周期
  dir(): string {
    return join(this.opts.dataDir, 'sandbox', this.parentRunId);
  }
  private repoCopyDir(): string {
    return join(this.dir(), 'repo');
  }
  private workDir(): string {
    return join(this.dir(), 'work');
  }
  diffsDir(): string {
    return join(this.dir(), 'diffs');
  }
  /** 公开给写工具：diff 全文落点目录 */
  diffDir(): string {
    return this.diffsDir();
  }

  /** 起会话：docker 前置检查（fail-closed）+ 快照 + 容器。幂等。 */
  async ensure(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.started) return { ok: true };
    if (!(await dockerAvailableAsync())) {
      return {
        ok: false,
        reason:
          '沙箱不可用：Docker 守护进程未运行。写能力按 fail-closed 设计保持关闭——请启动 Docker Desktop 后重试（镜像构建：node scripts/sandbox/build-image.mjs）。',
      };
    }
    // 宿主侧目录（审计副本 / 改动副本 / diff / 临时）
    for (const d of [this.repoCopyDir(), this.workDir(), this.diffsDir(), join(this.dir(), 'tmp')]) {
      mkdirSync(d, { recursive: true });
    }
    // 快照（排除 node_modules/data/.git/工具状态）——宿主副本同时充当"pre-state"（可回滚）
    // （自实现递归拷贝：dest 位于 `<repo>/data/` 内时 fs.cpSync 会抛 "subdirectory of self"，见函数注释）
    await copyRepoSnapshotAsync(this.opts.repoPath, this.repoCopyDir());
    // 容器：先清同名（上次崩溃残留）→ 起 → 快照进 /work（镜像内 node_modules 保留）
    await rmContainerAsync(this.name);
    const run = await runDetachedAsync(this.opts.image, this.name);
    if (!run.ok) {
      const hint = /Unable to find image|pull access denied|manifest unknown/i.test(run.stderr)
        ? `镜像 ${this.opts.image} 不存在：先跑 node scripts/sandbox/build-image.mjs 构建。`
        : run.stderr.slice(0, 300);
      return { ok: false, reason: `沙箱容器启动失败：${hint}` };
    }
    const cp = await cpInAsync(this.name, this.repoCopyDir(), '/work');
    if (!cp.ok) {
      await rmContainerAsync(this.name);
      return { ok: false, reason: `快照写入容器失败：${cp.stderr.slice(0, 300)}` };
    }
    // 实测修复（40j）：docker cp 落地的文件属主是 root:root，而容器以 node 用户运行（P2-d）
    // → 必须把 /work 交回 node，否则 stage() 写入拷贝出来的子目录必 Permission denied。
    const chown = await execInAsync(this.name, ['chown', '-R', 'node:node', '/work'], { timeoutMs: 180_000, asRoot: true });
    if (!chown.ok) {
      await rmContainerAsync(this.name);
      return { ok: false, reason: `沙箱目录授权失败（chown -R node:node /work）：${chown.stderr.slice(0, 200)}` };
    }
    this.started = true;
    return { ok: true };
  }

  isStarted(): boolean {
    return this.started;
  }

  dispose(): void {
    if (this.started) void rmContainerAsync(this.name).catch(() => {});
    this.started = false;
    // 宿主副本保留（审计/回滚用）；由 run 级清理策略决定何时删
  }

  /** 可等待的清理版本（测试/优雅停机用）；普通 run 终态走 fire-and-forget 的 dispose()，不阻塞收尾。 */
  async disposeAsync(): Promise<void> {
    if (this.started) await rmContainerAsync(this.name);
    this.started = false;
  }

  // ---------------------------------------------------------------- 改动登记
  private origAbs(rel: string): string {
    return resolve(this.opts.repoPath, rel);
  }
  private workAbs(rel: string): string {
    return resolve(this.workDir(), rel);
  }

  /** 读出真实仓库里某文件的当前内容（不存在返回 null） */
  readRepoFile(rel: string): string | null {
    const abs = this.origAbs(rel);
    try {
      if (!statSync(abs).isFile()) return null;
      return readFileSync(abs, 'utf8');
    } catch {
      return null;
    }
  }

  /** 登记一次改动：写宿主副本 + 容器内 /work；返回记录（含 baseHash/newHash/剩余轮次） */
  async stage(rel: string, op: ChangeOp, content?: string, opts: { signal?: AbortSignal } = {}): Promise<ChangeRecord> {
    const p = assertRelPath(rel);
    if (!this.started) throw new Error('沙箱未启动（先 ensure()）');
    const before = this.readRepoFile(p);
    if (op === 'create' && before !== null) {
      throw new Error(`create 目标已存在：${p}（改用 edit_file）`);
    }
    if (op !== 'create' && before === null) {
      throw new Error(`${op} 目标不存在：${p}`);
    }
    // 宿主副本
    const wAbs = this.workAbs(p);
    if (op === 'delete') {
      rmSync(wAbs, { force: true });
      await execInAsync(this.name, ['rm', '-f', `/work/${p}`], { timeoutMs: 30_000, signal: opts.signal });
    } else {
      await mkdir(dirname(wAbs), { recursive: true });
      await writeFile(wAbs, content ?? '', 'utf8');
      const w = await writeInContainerAsync(this.name, `/work/${p}`, content ?? '', { signal: opts.signal });
      if (!w.ok) throw new Error(`写入沙箱容器失败：${w.stderr.slice(0, 200)}`);
    }
    const prev = this.changes.get(p);
    const rec: ChangeRecord = {
      relPath: p,
      op,
      status: 'staged',
      newHash: op === 'delete' ? 'deleted' : shortSha256(content ?? ''),
      baseHash: before !== null ? shortSha256(before) : undefined,
      // v3-2：重试轮次**沿用会话里已有的计数**（重派不重置），新文件才给满额
      retriesLeft: prev?.retriesLeft ?? REGEN_ROUNDS_PER_FILE,
      lastVerdict: prev?.lastVerdict ?? null,
      updatedAt: new Date().toISOString(),
    };
    this.changes.set(p, rec);
    return rec;
  }

  getChanges(): ChangeRecord[] {
    return [...this.changes.values()];
  }
  getChange(rel: string): ChangeRecord | undefined {
    return this.changes.get(assertRelPath(rel));
  }
  /** 标记为"已被 approve 的最终态"（落盘成功后由审批门禁调用） */
  mark(rel: string, status: ChangeStatus): void {
    const c = this.changes.get(assertRelPath(rel));
    if (c) {
      c.status = status;
      c.updatedAt = new Date().toISOString();
    }
  }
  /** 失败重生成时扣减轮次；返回剩余（环境性失败由调用方判 shouldRegenerate 决定不扣） */
  consumeRound(rel: string): number {
    const c = this.changes.get(assertRelPath(rel));
    if (!c) return 0;
    c.retriesLeft = Math.max(0, c.retriesLeft - 1);
    c.updatedAt = new Date().toISOString();
    return c.retriesLeft;
  }

  // ---------------------------------------------------------------- 检查阶梯
  /** L0：语法（逐文件 esbuild transform，<1s/文件） */
  private async runL0(signal?: AbortSignal): Promise<LadderStep[]> {
    const steps: LadderStep[] = [];
    for (const c of this.changes.values()) {
      if (c.op === 'delete') continue;
      if (!/\.(ts|tsx|js|mjs|cjs)$/.test(c.relPath)) continue;
      // 实测修复（40j）：esbuild 的 --loader=ts 只对 stdin 输入合法；文件输入会报
      // "loader without extension only applies when reading from stdin" → 任何改动都被误判 SYNTAX。
      // 直接给文件路径，esbuild 会按扩展名推断 loader。
      const r = await execInAsync(
        this.name,
        ['npx', 'esbuild', `/work/${c.relPath}`, '--outfile=/tmp/esbuild-out.js', '--log-level=warning'],
        { timeoutMs: 30_000, workdir: '/work', signal },
      );
      const verdict = classify({
        source: 'l0-syntax',
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        timedOut: r.timedOut,
        target: c.relPath,
      });
      steps.push({ source: 'l0-syntax', verdict });
      c.lastVerdict = { class: verdict.class, summary: verdict.summary, excerpt: verdict.excerpt };
      if (!verdict.ok) break; // 语法错先修，不必往下跑
    }
    return steps;
  }

  /** 受影响测试映射（v3-4 三级兜底：同名 → grep 引用 → 空=由调用方降级全量） */
  affectedTests(changedRels: string[]): string[] {
    const testsDir = this.repoCopyDir() + '/tests';
    let testFiles: string[] = [];
    try {
      testFiles = readdirSync(testsDir).filter((n) => n.endsWith('.test.ts'));
    } catch {
      return [];
    }
    const picked = new Set<string>();
    for (const rel of changedRels) {
      const base = (rel.split('/').pop() ?? '').replace(/\.(ts|tsx|js|mjs|cjs)$/, '');
      if (!base) continue;
      // ① 同名/含名匹配
      for (const f of testFiles) {
        if (f.includes(base)) picked.add(f);
      }
      // ② grep 引用（模块路径片段，如 sandbox/classify）
      const frag = rel.replace(/^src\//, '').replace(/\.(ts|tsx|js)$/, '');
      if (frag.includes('/')) {
        for (const f of testFiles) {
          try {
            const t = readFileSync(join(testsDir, f), 'utf8');
            if (t.includes(frag) || t.includes(frag.replace(/\//g, '/'))) picked.add(f);
          } catch {
            /* ignore */
          }
        }
      }
    }
    return [...picked].map((f) => `tests/${f}`);
  }

  /** L1：tsc --noEmit --incremental（容器内持久 tsbuildinfo）+ 受影响测试（找不到映射 → 全量兜底） */
  private async runL1(signal?: AbortSignal, opts: { includeTests?: boolean } = {}): Promise<LadderStep[]> {
    const steps: LadderStep[] = [];
    const tsc = await execInAsync(
      this.name,
      ['npx', 'tsc', '-p', 'tsconfig.json', '--noEmit', '--incremental', '--tsBuildInfoFile', '/tmp/mta-tsc/tsbuildinfo', '--pretty', 'false'],
      { timeoutMs: 180_000, workdir: '/work', signal },
    );
    const tscVerdict = classify({ source: 'l1-tsc', exitCode: tsc.exitCode, stdout: tsc.stdout, stderr: tsc.stderr, timedOut: tsc.timedOut });
    steps.push({ source: 'l1-tsc', verdict: tscVerdict });
    if (!tscVerdict.ok) return steps;
    if (opts.includeTests === false) return steps;

    const affected = this.affectedTests([...this.changes.keys()].filter((k) => this.changes.get(k)!.op !== 'delete'));
    const target = affected.length ? affected : null; // null = 全量兜底（v3-4：绝不允许"找不到映射=不跑测试"）
    const cmd = target
      ? ['node', '--import', 'tsx', '--test', ...target]
      : ['npm', 'test', '--silent'];
    const tests = await execInAsync(this.name, cmd, { timeoutMs: 300_000, workdir: '/work', signal });
    const tv = classify({
      source: 'l1-tests',
      exitCode: tests.exitCode,
      stdout: tests.stdout,
      stderr: tests.stderr,
      timedOut: tests.timedOut,
      target: target ? target.join(' ') : '全部测试（无可映射测试 → 全量兜底）',
    });
    steps.push({ source: 'l1-tests', verdict: tv });
    return steps;
  }

  /** L2 的全量测试段（单独暴露：手动深度验证可以只跑这一段，不必重复 L0/L1）。 */
  async runFullSuite(signal?: AbortSignal): Promise<LadderStep> {
    const full = await execInAsync(this.name, ['npm', 'test', '--silent'], { timeoutMs: 600_000, workdir: '/work', signal });
    return {
      source: 'l2-tests',
      verdict: classify({ source: 'l2-tests', exitCode: full.exitCode, stdout: full.stdout, stderr: full.stderr, timedOut: full.timedOut }),
    };
  }

  /** 跑阶梯：L0 →（通过则）L1；任一步失败即停并返回 */
  async runLadder(level: 'L0' | 'L1' | 'L2' = 'L1', opts: { signal?: AbortSignal } = {}): Promise<LadderResult> {
    if (!this.started) throw new Error('沙箱未启动（先 ensure()）');
    const steps: LadderStep[] = [];
    const l0 = await this.runL0(opts.signal);
    steps.push(...l0);
    if (level !== 'L0' && l0.every((s) => s.verdict.ok)) {
      // L2 先只做类型检查，再由 runFullSuite 跑一次全量；否则 L1 的降级全量会和 L2 重复跑两遍。
      steps.push(...(await this.runL1(opts.signal, { includeTests: level !== 'L2' })));
    }
    if (level === 'L2' && steps.every((s) => s.verdict.ok)) {
      steps.push(await this.runFullSuite(opts.signal));
    }
    const ok = steps.every((s) => s.verdict.ok);
    if (ok) {
      for (const c of this.changes.values()) {
        if (c.status === 'staged') c.status = 'verified';
      }
    }
    return { ok, level, steps };
  }

  // ---------------------------------------------------------------- diff / 交接
  /** 生成 unified patch（git diff --no-index；add/delete 用空文件占位）——落 diffs/<name>.patch 并返回文本 */
  async diffPatch(rel: string, name = 'pending'): Promise<string> {
    const p = assertRelPath(rel);
    const tmp = join(this.dir(), 'tmp');
    mkdirSync(tmp, { recursive: true });
    const a = join(tmp, 'a.tmp');
    const b = join(tmp, 'b.tmp');
    writeFileSync(a, this.readRepoFile(p) ?? '', 'utf8');
    const rec = this.changes.get(p);
    writeFileSync(b, rec?.op === 'delete' ? '' : readFileSync(this.workAbs(p), 'utf8'), 'utf8');
    const r = await spawnAsync('git', ['diff', '--no-index', '--no-color', '--unified=3', '--src-prefix=a/', '--dst-prefix=b/', a, b], {
      maxBuffer: 8 * 1024 * 1024,
    });
    // 用真实仓库相对路径替换临时文件名。
    // 实测修复（2026-10-15 e2e）：直接对全文做 replace(/a\.tmp/g) 只是把 `a.tmp` 子串换掉，
    // 临时目录前缀（含宿主绝对路径 + 反斜杠 / 八进制转义）会残留在 header 里 →
    // 审批卡显示成 `diff --git "a/D:\c\345...\tmp\a/docs/x.md"`。这里改为**逐行重写 header 路径**，
    // 产出干净的统一 patch（git 自身的 core.quotepath 引号形式也随之消失）。
    const text = (r.stdout ?? '')
      .split('\n')
      .map((line) => {
        if (line.startsWith('diff --git ')) return `diff --git a/${p} b/${p}`;
        if (line.startsWith('--- ')) return `--- a/${p}`;
        if (line.startsWith('+++ ')) return `+++ b/${p}`;
        return line;
      })
      .join('\n');
    const patchPath = join(this.diffsDir(), `${name}.patch`);
    await writeFile(patchPath, text, 'utf8');
    return text;
  }

  /** 重派交接 brief（v3-2）：重派的子 Agent 用这段文字获知沙箱现状 */
  briefFor(): string | null {    const list = this.getChanges();
    if (!list.length) return null;
    const lines = [
      '【沙箱交接 brief】（上一轮子 Agent 的未完成工作在这里，别重复劳动也别覆盖）',
      `- 沙箱目录：data/sandbox/${this.parentRunId}/（宿主副本 work/ 与容器 ${this.name}:/work 同步）`,
    ];
    for (const c of list) {
      lines.push(
        `- ${c.relPath}：${c.op} / 状态=${c.status} / 剩余重生成轮次=${c.retriesLeft}` +
          (c.lastVerdict ? ` / 上次检查=${c.lastVerdict.class ?? '—'}「${c.lastVerdict.summary}」` : ''),
      );
    }
    lines.push('- 规则：改动必须先沙箱验证通过、再走人工审批才能落盘；重试轮次用尽仍未过 → 如实上报 unresolved。');
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- 命令暂存（run_command）
  /** 暂存一条待审批命令（沙箱内已预演 → sandboxOutput 带证据） */
  stageCommand(cmd: Omit<PendingCommand, 'status'>): PendingCommand {
    const rec: PendingCommand = { ...cmd, status: 'pending' };
    this.commands.push(rec);
    return rec;
  }
  getCommands(): PendingCommand[] {
    return this.commands;
  }
  markCommand(index: number, status: PendingCommand['status'], host?: { output: string; exitCode: number | null }): void {
    const c = this.commands[index];
    if (!c) return;
    c.status = status;
    if (host) {
      c.hostOutput = host.output;
      c.hostExitCode = host.exitCode;
    }
  }

  // ---------------------------------------------------------------- 沙箱当前内容 / 落盘 / 回滚
  /** 沙箱当前内容：已登记改动的文件读 work 副本，否则读真实仓库（delete 后为 null） */
  readWorkFile(rel: string): string | null {
    const p = assertRelPath(rel);
    const rec = this.changes.get(p);
    if (!rec) return this.readRepoFile(p);
    if (rec.op === 'delete') return null;
    try {
      return readFileSync(this.workAbs(p), 'utf8');
    } catch {
      return null;
    }
  }

  /** 沙箱当前文件的字节数；不存在/不可读/已删除时返回 null（供 read_file 读前预检）。 */
  workFileSize(rel: string): number | null {
    const p = assertRelPath(rel);
    const rec = this.changes.get(p);
    if (rec?.op === 'delete') return null;
    try {
      const abs = rec ? this.workAbs(p) : this.origAbs(p);
      const st = statSync(abs);
      return st.isFile() ? st.size : null;
    } catch {
      return null;
    }
  }

  /** 原文备份目录（落盘前把原文件复制到这里；宿主复验失败时据此回滚） */
  backupsDir(): string {
    return join(this.opts.dataDir, 'backups', this.parentRunId);
  }

  /** 异步短等待（Windows 文件占用重试用；不再阻塞事件循环）。 */
  private static sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * 落盘到真实仓库（审批通过后调用）：
   *   ① TOCTOU 哈希守卫（baseHash 不符 → 拒绝并要求重新审批，评审 P1-4/P1-2）；
   *   ② 原文备份（含 create 前的"不存在"事实，软删也留档）；
   *   ③ 原子写（tmp + rename；Windows 下 EPERM/EBUSY 短重试 3 次退避，评审 P2-f）。
   */
  /**
   * 在碰任何文件之前登记本批落盘意图（崩溃对账依据）。
   * 失败必须让调用方中止落盘（fail-closed）：没有意图日志的写入，崩溃后无法说清状态。
   */
  async beginApply(
    approvalId: string,
    files: Array<{ relPath: string; op: ChangeOp; baseHash?: string; workHash?: string }>,
  ): Promise<void> {
    await beginApplyJournal(this.opts.dataDir, this.parentRunId, this.opts.repoPath, approvalId, files);
  }

  async applyToRepo(
    rel: string,
    approvalId?: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const p = assertRelPath(rel);
    const rec = this.changes.get(p);
    if (!rec) return { ok: false, reason: `未登记改动（先 stage）：${p}` };
    const abs = this.origAbs(p);
    const current = this.readRepoFile(p);
    const currentHash = current !== null ? shortSha256(current) : undefined;
    if (rec.baseHash !== currentHash) {
      const reason = `TOCTOU 守卫拒绝：${p} 在审批期间被外部改动（审批版本与当前不一致）。请重新读取并重新走审批。`;
      if (approvalId) await updateApplyEntry(this.opts.dataDir, this.parentRunId, approvalId, p, { status: 'failed', note: reason });
      return {
        ok: false,
        reason,
      };
    }
    // 备份原文
    const bak = join(this.backupsDir(), p);
    await mkdir(dirname(bak), { recursive: true });
    if (current !== null) await writeFile(bak, current, 'utf8');
    // 应用
    if (rec.op === 'delete') {
      await rm(abs, { force: true });
    } else {
      const content = this.readWorkFile(p) ?? '';
      await mkdir(dirname(abs), { recursive: true });
      const tmp = `${abs}.mta-tmp-${Date.now()}`;
      await writeFile(tmp, content, 'utf8');
      let lastErr: Error | null = null;
      for (let i = 0; i < 3; i++) {
        try {
          await rm(abs, { force: true });
          await rename(tmp, abs);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e as Error;
          await SandboxSession.sleep(120 * (i + 1)); // 退避：120/240/360ms
        }
      }
      if (lastErr) {
        await rm(tmp, { force: true });
        const reason = `原子写失败（目标被占用？编辑器/杀软锁文件）：${lastErr.message}`;
        if (approvalId) await updateApplyEntry(this.opts.dataDir, this.parentRunId, approvalId, p, { status: 'failed', note: reason });
        return { ok: false, reason };
      }
    }
    rec.status = 'applied';
    rec.updatedAt = new Date().toISOString();
    if (approvalId) await updateApplyEntry(this.opts.dataDir, this.parentRunId, approvalId, p, { status: 'applied' });
    return { ok: true };
  }

  /** 回滚一个已落盘改动（宿主复验失败时用）：有备份则恢复，备份缺失（原本不存在）则删除 */
  async rollbackFromBackup(rel: string, approvalId?: string): Promise<boolean> {
    const p = assertRelPath(rel);
    const bak = join(this.backupsDir(), p);
    const abs = this.origAbs(p);
    try {
      if (existsSync(bak)) {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, await readFile(bak, 'utf8'), 'utf8');
      } else {
        await rm(abs, { force: true });
      }
      const rec = this.changes.get(p);
      if (rec) rec.status = 'rolled_back';
      if (approvalId) {
        await updateApplyEntry(this.opts.dataDir, this.parentRunId, approvalId, p, {
          status: 'rolled_back',
          note: 'hostVerify 失败自动回滚',
        });
      }
      return true;
    } catch {
      return false;
    }
  }
}
