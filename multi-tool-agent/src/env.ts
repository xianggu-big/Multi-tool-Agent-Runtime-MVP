// src/env.ts — 极简 .env 加载器（不引入 dotenv 依赖）
// 仅当 process.env 中尚未存在该键时，才用 .env 文件中的值填充。

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadEnv(dotEnvPath = '.env'): void {
  const p = resolve(dotEnvPath);
  if (!existsSync(p)) return;
  try {
    const text = readFileSync(p, 'utf8');
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      // 去除成对引号
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch {
    // 忽略 .env 读取错误，环境变量缺失时由调用方校验
  }
}

export function getEnv(key: string, fallback?: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? (fallback ?? '') : v;
}

export function getBool(key: string, fallback = false): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
}

export function getInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function getList(key: string, fallback: string[]): string[] {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
