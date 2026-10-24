// src/scheduler/time.ts — 定时任务的「下一次运行时间」计算（纯函数，可单测）
//
// 只支持两种形态：once（一次性 ISO 时间）/ daily（HH:mm，本地时区）。
// 不引入 cron 依赖：用户需求就是「选日期时间」或「每天固定时间」。

export type ScheduleFrequency = 'once' | 'daily';

export function parseDailyTime(value: string): { hh: number; mm: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return { hh, mm };
}

export function formatDaily(hh: number, mm: number): string {
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * 计算下一次运行时间（ISO 字符串）。
 * - once：runAt 在未来 → 原样返回；已过去 → null（视为错过）
 * - daily：以本地时区计算下一个 HH:mm（严格大于 from）
 */
export function computeNextRunAt(
  schedule: { frequency: ScheduleFrequency; runAt?: string },
  from: Date = new Date(),
): string | null {
  if (schedule.frequency === 'once') {
    if (!schedule.runAt) return null;
    const t = new Date(schedule.runAt);
    if (Number.isNaN(t.getTime()) || t.getTime() <= from.getTime()) return null;
    return t.toISOString();
  }
  const parsed = parseDailyTime(schedule.runAt ?? '');
  if (!parsed) return null;
  const next = new Date(from.getTime());
  next.setHours(parsed.hh, parsed.mm, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

/** 判断某个 nextRunAt 是否已经明显过期（超过一个 tick 宽限），用于停服错过判定 */
export function isMissed(nextRunAt: string | undefined, now: Date, graceMs = 60_000): boolean {
  if (!nextRunAt) return false;
  const t = new Date(nextRunAt).getTime();
  if (Number.isNaN(t)) return true;
  return now.getTime() - t > graceMs;
}
