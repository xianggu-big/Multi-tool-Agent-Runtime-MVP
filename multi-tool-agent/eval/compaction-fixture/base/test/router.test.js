import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleLogout, handleSession } from '../src/http/handlers.js';

test('unknown session returns 401', () => {
  assert.equal(handleSession('missing').status, 401);
});

test('logout is idempotent', () => {
  assert.equal(handleLogout('missing').status, 200);
});