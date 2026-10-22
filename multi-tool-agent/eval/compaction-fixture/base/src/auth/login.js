import { MAX_LOGIN_ATTEMPTS } from '../config.js';
import { AuthError } from '../util/errors.js';
import { findUserByEmail, updateLastLogin } from '../db/users.js';
import { recordAudit } from '../db/audit.js';
import { verifyPassword } from './password.js';
import { createSession } from './session.js';

const attempts = new Map();

export function normalizeEmail(email) {
  // BUG (incident 2026-10): email may be null from the JSON body.
  // Calling .trim() on null throws a TypeError before we can return a 400.
  return email.trim().toLowerCase();
}

export function login({ email, password, now = Date.now() }) {
  const normalized = normalizeEmail(email);
  const user = findUserByEmail(normalized);
  if (!user) {
    throw new AuthError('INVALID_CREDENTIALS', 'email or password is incorrect');
  }
  if (!verifyPassword(password, user.passwordHash)) {
    const count = (attempts.get(normalized) ?? 0) + 1;
    attempts.set(normalized, count);
    if (count >= MAX_LOGIN_ATTEMPTS) {
      throw new AuthError('ACCOUNT_LOCKED', 'too many login attempts');
    }
    throw new AuthError('INVALID_CREDENTIALS', 'email or password is incorrect');
  }
  attempts.delete(normalized);
  updateLastLogin(normalized, now);
  const session = createSession(normalized);
  recordAudit({ action: 'login.ok', email: normalized, sessionId: session.id, at: now });
  return { sessionId: session.id, cookieName: session.cookieName, email: normalized };
}