// src/sandbox/hash.ts — 内容短哈希（16 hex）
//
// 落盘链路里有两处需要「内容是否一致」的判断：TOCTOU 守卫与崩溃对账。
// 两者必须用同一口径，否则恢复时会把「已落盘」误判成「冲突」。
import { createHash } from 'node:crypto';

export function shortSha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
}
