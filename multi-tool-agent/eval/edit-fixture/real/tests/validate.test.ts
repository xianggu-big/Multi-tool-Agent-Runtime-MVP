import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateUser } from '../src/validate.js';

test('validateUser accepts a complete user', () => {
  assert.deepEqual(validateUser({ name: 'Ada', age: 36, email: 'ada@example.com' }), []);
});

test('validateUser reports missing name', () => {
  assert.deepEqual(validateUser({ name: '  ', age: 20, email: 'a@b.co' }), ['name is required']);
});

test('validateUser reports out-of-range age', () => {
  assert.deepEqual(validateUser({ name: 'Ada', age: 151, email: 'a@b.co' }), ['age must be 0..150']);
});

test('validateUser reports invalid email', () => {
  assert.deepEqual(validateUser({ name: 'Ada', age: 20, email: 'nope' }), ['email is invalid']);
});