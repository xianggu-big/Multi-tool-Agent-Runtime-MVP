//
// 为什么需要它（真实事故驱动）：
//   真实模型给路径的形态五花八门，而工具原先只认「相对仓库根」一种：
//     - `demo/codebase-sample/src`（工作区相对）→ NOT_FOUND
//     - `D:\...\demo\codebase-sample\src`（绝对路径）→ 被拼接后 PATH_ESCAPE
//     - `{ path: 'src' }`（参数名不符）→ **被 Zod 静默丢弃**，退化成统计整个仓库（静默错误结果，最危险）
//   结果：子 Agent 反复重试 → 预算耗尽 → 多 Agent 编排整体失败。
//
// 设计原则：
//   1) **宽容解析**：接受相对仓库根 / `./` / 工作区相对 / 绝对（须在仓库内）四种形态；
//   2) **安全不变**：解析结果一律再过一次 assertInsideRepo，越界直接拒绝；
//   3) **可行动报错**：失败时给出实际存在的顶层条目，让模型能自我纠正（而不是瞎猜）。

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertInsideRepo, EXCLUDED_DIRS } from '../codebase/security.js';

export interface PathResolveOk {
  ok: true;
  /** 绝对路径（已确保在仓库内） */
  abs: string;
  /** 相对仓库根的 POSIX 风格路径（模型/日志里展示用） */
  rel: string;
}
export interface PathResolveErr {
  ok: false;
  reason: string;
  /** 可行动提示：列出仓库里真实可用的顶层条目 */
  hint: string;
  /** 该路径**越出了仓库边界**（调用方应据此回 PATH_ESCAPE，保持安全语义可断言） */
  escaped?: boolean;
}
export type PathResolveResult = PathResolveOk | PathResolveErr;

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/** 列出仓库根下真实存在的顶层条目（供报错提示用；排序保证确定性） */
export function listRootEntries(repoPath: string, limit = 8): string[] {
  try {
    return readdirSync(repoPath)
      .filter((n) => !n.startsWith('.') && !EXCLUDED_DIRS.has(n))
      .sort()
      .slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * 解析一个「用户/模型给出的路径」。
 * @param opts.allowRoot 允许空路径 → 仓库根（默认 true）
 */
export function resolveWorkspacePath(
  repoPath: string,
  raw: string | undefined | null,
  opts: { allowRoot?: boolean; requireExists?: boolean } = {},
): PathResolveResult {
  const allowRoot = opts.allowRoot !== false;
  // requireExists=false 用于「先做词法校验（越权/敏感文件），再自己判存在」的场景：
  // 例如 read_file('.env') 必须先报"敏感文件"，而不是先报"文件不存在"。
  const requireExists = opts.requireExists !== false;
  const rootAbs = resolve(repoPath);
  // 真实根路径：realpath 解析根自身的潜在符号链接成分；失败回退词法路径
  let realRoot: string;
  try {
    realRoot = realpathSync(rootAbs);
  } catch {
    realRoot = rootAbs;
  }
  const hint = () => {
    const entries = listRootEntries(rootAbs);
    return entries.length
      ? `仓库根下的可用条目（前 ${entries.length} 个）: ${entries.join(', ')}。请传「相对仓库根的路径」，例如 ${entries[0]}/ 或 ./`
      : '请传「相对仓库根的路径」，例如 src/ 或 ./';
  };

  const cleaned = String(raw ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');

  if (!cleaned || cleaned === '.' || cleaned === '/') {
    if (!allowRoot) return { ok: false, reason: '未提供路径', hint: hint() };
    return { ok: true, abs: rootAbs, rel: '.' };
  }

  // 候选顺序：绝对 → 相对仓库根 → 工作区相对（剥离仓库名前缀）
  const candidates: string[] = [];

  if (isAbsolute(cleaned) || /^[A-Za-z]:\//.test(cleaned)) {
    candidates.push(cleaned);
  }
  candidates.push(join(rootAbs, cleaned));

  // 工作区相对：`demo/codebase-sample/src` —— 用仓库目录名在路径中定位并取其后的部分
  const rootName = rootAbs.split(/[\\/]/).filter(Boolean).pop();
  if (rootName) {
    const idx = cleaned.toLowerCase().indexOf(rootName.toLowerCase());
    if (idx >= 0) {
      const rest = cleaned.slice(idx + rootName.length).replace(/^\//, '');
      candidates.push(rest ? join(rootAbs, rest) : rootAbs);
    }
  }
  // 仓库名重复出现时（`.../codebase-sample/src`）：取最后一段仓库名之后的部分
  if (rootName && cleaned.includes('/')) {
    const parts = cleaned.split('/');
    const lastIdx = parts.lastIndexOf(rootName);
    if (lastIdx >= 0) {
      const rest = parts.slice(lastIdx + 1).join('/');
      candidates.push(rest ? join(rootAbs, rest) : rootAbs);
    }
  }

  let sawEscape = false;
  for (const cand of candidates) {
    let abs: string;
    try {
      abs = assertInsideRepo(rootAbs, resolve(cand)); // 越界会抛错
    } catch {
      sawEscape = true; // 越界候选：不泄露外部路径是否存在，但记下来供调用方区分「越权」与「不存在」
      continue;
    }
    const exists = existsSync(abs);
    if (requireExists && !exists) continue;
    let realAbs = abs;
    if (exists) {
      // 符号链接/junction 逃逸防护：词法检查会被 symlink 绕过，须解析真实路径后再校验仍在仓库内
      try {
        realAbs = realpathSync(abs);
      } catch {
        continue; // 竞态：存在但解析失败（如刚被删除）→ 视为不存在
      }
      const relReal = relative(realRoot, realAbs);
      if (relReal.startsWith('..') || isAbsolute(relReal)) {
        sawEscape = true; // 链接指向仓库外
        continue;
      }
    }
    const rel = toPosix(relative(rootAbs, realAbs)) || '.';
    return { ok: true, abs: realAbs, rel };
  }

  if (sawEscape) {
    return {
      ok: false,
      escaped: true,
      reason: `路径越权：目标 "${cleaned}" 不在仓库根目录内（仓库根: ${toPosix(rootAbs)}）`,
      hint: hint(),
    };
  }
  return {
    ok: false,
    reason: `路径不存在：${cleaned}（已尝试：相对仓库根、工作区相对、绝对路径；且必须位于仓库内）`,
    hint: hint(),
  };
}