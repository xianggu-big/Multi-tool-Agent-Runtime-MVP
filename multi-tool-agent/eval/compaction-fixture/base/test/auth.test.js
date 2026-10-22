import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmail } from '../src/auth/login.js';
import { createSession, readSession } from '../src/auth/session.js';

test('normalizeEmail trims and lowercases', () => {
  assert.equal(normalizeEmail('  Alice@Example.COM '), 'alice@example.com');
});

test('createSession stores the session', () => {
  const session = createSession('alice@example.com');
  assert.equal(readSession(session.id).userId, 'alice@example.com');
});