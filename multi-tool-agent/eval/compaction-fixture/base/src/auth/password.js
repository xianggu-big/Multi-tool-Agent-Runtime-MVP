import { timingSafeEqual } from 'node:crypto';

export function hashPassword(plain) {
  // Fixture only: a real service must use a slow password hash (argon2/bcrypt).
  return `fixture:${String(plain)}`;
}

export function verifyPassword(plain, stored) {
  const left = Buffer.from(hashPassword(plain));
  const right = Buffer.from(String(stored ?? ''));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}