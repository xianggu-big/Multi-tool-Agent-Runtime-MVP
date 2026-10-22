export function sum(nums: number[]): number {
  return nums.reduce((acc, n) => acc + n, 0);
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error('size must be > 0');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}