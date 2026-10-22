import { LEGACY_AUTH_MODE } from '../config.js';
import { AuthError } from '../util/errors.js';
import { findUserByEmail } from '../db/users.js';
import { recordAudit } from '../db/audit.js';
import { verifyPassword } from '../auth/password.js';

const legacyAttempts = new Map();

export function normalizeEmailLegacy(email) {
  // Legacy cookie-v1 path: null becomes an empty string, and surrounding spaces are kept.
  return String(email ?? '').toLowerCase();
}

export function loginLegacy({ email, password }) {
  const normalized = normalizeEmailLegacy(email);
  const user = findUserByEmail(normalized);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    const count = (legacyAttempts.get(normalized) ?? 0) + 1;
    legacyAttempts.set(normalized, count);
    throw new AuthError('INVALID_CREDENTIALS', `${LEGACY_AUTH_MODE}: invalid credentials`);
  }
  recordAudit({ action: 'login.legacy', email: normalized });
  return { email: normalized, mode: LEGACY_AUTH_MODE };
}