import { AUTH_TIMEOUT_MS, TOKEN_ISSUER, TOKEN_TTL_SECONDS } from '../config.js';

export function signToken(userId, now = Date.now()) {
  return {
    issuer: TOKEN_ISSUER,
    subject: userId,
    issuedAt: now,
    expiresAt: now + TOKEN_TTL_SECONDS * 1000,
    timeoutMs: AUTH_TIMEOUT_MS,
  };
}

export function verifyToken(token, now = Date.now()) {
  if (!token || token.issuer !== TOKEN_ISSUER) return false;
  if (now >= token.expiresAt) return false;
  return true;
}

export function rotateToken(token, now = Date.now()) {
  if (!verifyToken(token, now)) return null;
  return signToken(token.subject, now);
}