// src/runtime/rateLimit.ts — 固定窗口限流（单进程、够用即可）
//
// 用途：浏览器错误上报是公网可达的写入口，前端一旦进入错误循环会瞬间刷满日志。
// 不引入 Redis 之类的依赖；单实例进程内计数即可，重启清零可接受。

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

export class FixedWindowLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly maxKeys = 2000,
  ) {
    if (!Number.isInteger(limit) || limit < 0) throw new Error('limit 必须是非负整数');
  }

  take(key: string, now = Date.now()): RateLimitDecision {
    if (this.limit === 0) return { allowed: true, remaining: Infinity, retryAfterSec: 0 };
    const bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      this.prune(now);
      return { allowed: true, remaining: this.limit - 1, retryAfterSec: 0 };
    }
    if (bucket.count >= this.limit) {
      return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
    }
    bucket.count += 1;
    return { allowed: true, remaining: this.limit - bucket.count, retryAfterSec: 0 };
  }

  reset(): void {
    this.buckets.clear();
  }

  private prune(now: number): void {
    if (this.buckets.size <= this.maxKeys) return;
    for (const [key, b] of this.buckets) {
      if (now >= b.resetAt) this.buckets.delete(key);
    }
    // 仍然超限：删最早插入的键（Map 保持插入顺序），防止恶意 IP 撑爆内存
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }
}
