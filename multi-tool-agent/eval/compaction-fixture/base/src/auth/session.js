import { randomUUID } from 'node:crypto';
import { SESSION_COOKIE } from '../config.js';

const sessions = new Map();

export function createSession(userId) {
  const id = randomUUID();
  sessions.set(id, { id, userId, createdAt: Date.now() });
  return { id, cookieName: SESSION_COOKIE };
}

export function readSession(id) {
  return sessions.get(id) ?? null;
}

export function revokeSession(id) {
  return sessions.delete(id);
}