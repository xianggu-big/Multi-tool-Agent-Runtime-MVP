import { toHttpStatus } from '../util/errors.js';
import { login } from '../auth/login.js';
import { readSession, revokeSession } from '../auth/session.js';
import { recordAudit } from '../db/audit.js';

export function handleLogin(payload) {
  try {
    return { status: 200, body: login(payload) };
  } catch (error) {
    // GAP: generic 500 path returns without recordAudit. The incident report calls this out.
    return { status: toHttpStatus(error), body: { error: error.message } };
  }
}

export function handleLogout(sessionId) {
  const revoked = revokeSession(sessionId);
  recordAudit({ action: 'logout', sessionId, revoked });
  return { status: 200, body: { revoked } };
}

export function handleSession(sessionId) {
  const session = readSession(sessionId);
  if (!session) return { status: 401, body: { error: 'no session' } };
  return { status: 200, body: session };
}