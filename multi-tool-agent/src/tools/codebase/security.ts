// src/tools/codebase/security.ts — 仓库路径安全（防止路径穿越）
import { resolve, relative, isAbsolute } from 'node:path';

/** 解析并断言目标路径位于仓库根目录内；越权则抛错。 */
export function assertInsideRepo(root: string, target: string): string {
  const absRoot = resolve(root);
  const absTarget = isAbsolute(target) ? resolve(target) : resolve(absRoot, target);
  const rel = relative(absRoot, absTarget);
  if (rel === '' ) return absTarget; // 同目录
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`路径越权：目标 "${target}" 不在仓库根目录内`);
  }
  return absTarget;
}

/** 应排除的目录（依赖/构建产物/元数据/敏感） */
export const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'coverage',
  '.cache',
  'vendor',
  'target',
  '__pycache__',
]);

/** 敏感文件（不读取/不搜索内容） */
export const SENSITIVE_FILES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  'id_rsa',
  'id_dsa',
  'credentials.json',
  '.npmrc',
  '.netrc',
]);

/**
 * 敏感文件判定（大小写不敏感）。
 * 修复（P2-c）：Windows/macOS 文件名本就大小写不敏感（`.ENV` 与 `.env` 是同一个文件），
 * 此前大小写敏感的判定会让大写变体漏网。写工具与只读工具**共用这一份清单**（不做两套，防漂移）。
 */
export function isSensitive(name: string): boolean {
  const n = name.toLowerCase();
  if (SENSITIVE_FILES.has(n)) return true;
  if (n.endsWith('.key') || n.endsWith('.pem') || n.endsWith('.p12')) return true;
  if (n.includes('secret') && (n.endsWith('.json') || n.endsWith('.yml'))) return true;
  return false;
}
