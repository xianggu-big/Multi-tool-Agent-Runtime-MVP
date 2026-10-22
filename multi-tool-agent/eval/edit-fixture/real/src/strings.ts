export function capitalize(s: string): string {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1);
}

export function truncate(s: string, max: number): string {
  if (max < 0) throw new Error('max must be >= 0');
  return s.length <= max ? s : s.slice(0, max) + '…';
}

export function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '-');
}